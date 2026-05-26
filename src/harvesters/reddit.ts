import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Reddit harvester — Class-1, zero-auth. old.reddit.com exposes a public .json
 * view of any listing. A descriptive User-Agent matters: Reddit aggressively
 * 429s blank/default agents. The permalink (not the external link) is used as
 * the canonical url so every rendered claim points at a hand-checkable thread.
 */
const SUBREDDITS = ['MachineLearning', 'LocalLLaMA', 'artificial', 'OpenAI', 'singularity'];
const PER_SUB_CAP = 12;
const AI_KEYWORDS =
  /\b(AI|LLM|GPT|Claude|Gemini|Llama|Mistral|model|agent|reasoning|RAG|fine-tun|transformer|diffusion|prompt|inference|training|alignment|neural|machine learning|deep learning|multimodal|embedding|open[- ]?source|benchmark)\b/i;

type RedditChild = {
  kind: string;
  data: {
    id: string;
    title: string;
    permalink: string;
    url: string;
    score: number;
    num_comments: number;
    created_utc: number;
    subreddit: string;
    selftext?: string;
    over_18?: boolean;
    stickied?: boolean;
  };
};

async function fetchSub(sub: string): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const url = `https://old.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon trend aggregator)' },
    });
    if (!res.ok) throw new Error(`r/${sub}: HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('reddit', sub, text);
    const data = JSON.parse(text) as { data?: { children?: RedditChild[] } };
    const children = data.data?.children ?? [];

    const items: NormalizedItem[] = [];
    for (const ch of children) {
      const d = ch.data;
      if (!d || !d.title || !d.permalink) continue;
      if (d.stickied || d.over_18) continue;
      if (!AI_KEYWORDS.test(d.title + ' ' + (d.selftext ?? ''))) continue;

      const permalink = `https://www.reddit.com${d.permalink}`;
      const tsParsed = d.created_utc * 1000;
      const ts = Number.isNaN(tsParsed) ? new Date().toISOString() : new Date(tsParsed).toISOString();
      items.push({
        title: `[r/${d.subreddit}] ${d.title}`,
        url: permalink,
        source: 'reddit',
        ts,
        engagement: (d.score ?? 0) + (d.num_comments ?? 0),
        raw_text: d.title + (d.selftext ? ' — ' + d.selftext.slice(0, 280) : ''),
        meta: {
          subreddit: d.subreddit,
          score: d.score ?? 0,
          comments: d.num_comments ?? 0,
          external_url: d.url,
        },
      });
    }
    items.sort((a, b) => b.engagement - a.engagement);
    return items.slice(0, PER_SUB_CAP);
  } finally {
    clearTimeout(timer);
  }
}

export async function harvestReddit(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(SUBREDDITS.map(fetchSub));
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sub = SUBREDDITS[i];
    if (!r || !sub) continue;
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    } else {
      console.error(`  reddit r/${sub} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestReddit();
  if (items.length === 0) {
    console.error('Reddit harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'reddit.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`Reddit: ${items.length} items → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Reddit harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
