import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

type GHRepo = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  topics?: string[];
  created_at: string;
  pushed_at: string;
};

function isoDaysAgo(d: number): string {
  const t = new Date(Date.now() - d * 86400_000);
  return t.toISOString().slice(0, 10);
}

const SINCE = isoDaysAgo(60);
const TOPICS = ['llm', 'agents', 'rag'];

async function fetchTopic(topic: string): Promise<GHRepo[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const q = `topic:${topic} created:>=${SINCE}`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`;
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'TrendingAI/1.0',
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error(`GitHub Search topic=${topic}: HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('github', topic, text);
    const data = JSON.parse(text) as { items?: GHRepo[] };
    return data.items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export async function harvestGitHub(): Promise<NormalizedItem[]> {
  const results = await Promise.all(TOPICS.map(fetchTopic));
  const seen = new Set<number>();
  const items: NormalizedItem[] = [];
  for (const arr of results) {
    for (const r of arr) {
      if (!r.html_url || !r.full_name) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const desc = (r.description ?? '').trim();
      // ISC-120 — the topic line is the repo's description, not the bare
      // `owner/repo` slug. The slug is still carried (meta.repo + raw_text) so
      // every claim stays hand-checkable, but the reader sees what the repo
      // *does*, not just who owns it.
      items.push({
        title: desc || r.full_name,
        url: r.html_url,
        source: 'github',
        ts: r.pushed_at,
        engagement: r.stargazers_count,
        raw_text: r.full_name + (desc ? ' — ' + desc : ''),
        meta: { repo: r.full_name, topics: r.topics ?? [], created_at: r.created_at },
      });
    }
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestGitHub();
  if (items.length === 0) {
    console.error('GitHub harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'github.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`GitHub: ${items.length} items → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('GitHub harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
