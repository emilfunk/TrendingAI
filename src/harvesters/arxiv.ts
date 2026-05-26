import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const ENDPOINT =
  'http://export.arxiv.org/api/query?' +
  'search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG' +
  '&sortBy=submittedDate&sortOrder=descending&max_results=50';

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function extractFirst(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(block);
  return m && m[1] !== undefined ? m[1] : null;
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`);
  const m = re.exec(block);
  return m ? (m[1] ?? null) : null;
}

async function fetchArxiv(retries = 2): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const res = await fetch(ENDPOINT, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon; contact: dev@local)' },
      });
      if (res.status === 429 || res.status === 503) {
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
          continue;
        }
      }
      if (!res.ok) throw new Error(`arXiv: HTTP ${res.status}`);
      const text = await res.text();
      await captureRaw('arxiv', 'cs-AI-CL-LG', text);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('arXiv: exhausted retries');
}

export async function harvestArxiv(): Promise<NormalizedItem[]> {
  {
    const xml = await fetchArxiv();
    const entries = extractAll(xml, 'entry');
    const items: NormalizedItem[] = [];
    for (const e of entries) {
      const rawTitle = extractFirst(e, 'title');
      const id = extractFirst(e, 'id');
      const published = extractFirst(e, 'published');
      const summary = extractFirst(e, 'summary');
      const url = extractAttr(e, 'link', 'href') ?? id;
      if (!rawTitle || !url || !published) continue;
      const title = decodeXmlEntities(rawTitle.replace(/\s+/g, ' ').trim());
      const abstractText = summary ? decodeXmlEntities(summary.replace(/\s+/g, ' ').trim()) : title;
      items.push({
        title,
        url: url.trim(),
        source: 'arxiv',
        ts: published.trim(),
        engagement: 0,
        raw_text: title + ' ' + abstractText.slice(0, 400),
        meta: { id: id?.trim() },
      });
    }
    return items;
  }
}

async function main(): Promise<void> {
  const items = await harvestArxiv();
  if (items.length === 0) {
    console.error('arXiv harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'arxiv.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`arXiv: ${items.length} items → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('arXiv harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
