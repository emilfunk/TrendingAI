import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

type HNHit = {
  objectID: string;
  title?: string | null;
  url?: string | null;
  story_url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at: string;
  author?: string;
};

type HNItemChild = {
  author?: string | null;
  text?: string | null;
  points?: number | null;
  created_at?: string | null;
  type?: string | null;
  children?: HNItemChild[] | null;
};

type HNItemResponse = {
  children?: HNItemChild[] | null;
};

export type HNComment = {
  author: string;
  text: string;
  points: number | null;
  ts: string;
};

const QUERIES = ['AI', 'LLM', 'agents'];
const SEVEN_DAYS_AGO = Math.floor(Date.now() / 1000) - 7 * 86400;
const COMMENT_TOP_N = 10;
const COMMENT_FETCH_CONCURRENCY = 5;
const COMMENT_FETCH_TIMEOUT_MS = 10_000;

// Anti-criterion (ISC-155): per-item comment-fetch failures land here and the
// orchestrator drains them into the top-level harvest result `errors[]` after
// the dispatch. The harvest payload is never partial/lying — failed items
// emit `meta.comments: []` AND a string in this buffer naming the item.
const commentFetchErrors: string[] = [];

export function drainHNCommentErrors(): string[] {
  return commentFetchErrors.splice(0);
}

function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, '\n\n')
    .replace(/<\/p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchOneQuery(q: string): Promise<HNHit[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}` +
      `&tags=story&hitsPerPage=30&numericFilters=created_at_i>${SEVEN_DAYS_AGO}`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HN Algolia: HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('hn', q, text);
    const data = JSON.parse(text) as { hits: HNHit[] };
    return data.hits ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchComments(objectID: string): Promise<HNComment[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), COMMENT_FETCH_TIMEOUT_MS);
  try {
    const url = `https://hn.algolia.com/api/v1/items/${encodeURIComponent(objectID)}`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HN Algolia items: HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('hn', `item-${objectID}`, text);
    const data = JSON.parse(text) as HNItemResponse;
    const children = Array.isArray(data.children) ? data.children : [];
    const out: HNComment[] = [];
    for (const c of children) {
      if (out.length >= COMMENT_TOP_N) break;
      if (c.type && c.type !== 'comment') continue;
      const rawText = typeof c.text === 'string' ? c.text : '';
      const clean = stripHtml(rawText);
      if (!clean) continue;
      out.push({
        author: typeof c.author === 'string' ? c.author : 'unknown',
        text: clean,
        points: typeof c.points === 'number' ? c.points : null,
        ts: typeof c.created_at === 'string' ? c.created_at : '',
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  worker: (input: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= inputs.length) return;
      const input = inputs[i];
      if (input === undefined) return;
      results[i] = await worker(input);
    }
  }
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, () => pump());
  await Promise.all(workers);
  return results;
}

export async function harvestHN(): Promise<NormalizedItem[]> {
  // Reset the per-call error buffer. Module-scoped state is intentional: the
  // orchestrator drains via drainHNCommentErrors() after Promise.all so the
  // top-level harvest-result `errors[]` carries one entry per failed item.
  commentFetchErrors.length = 0;

  const results = await Promise.all(QUERIES.map(fetchOneQuery));
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const arr of results) {
    for (const h of arr) {
      const url = h.url ?? h.story_url;
      if (!url || !h.title) continue;
      if (seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      items.push({
        title: h.title,
        url,
        source: 'hn',
        ts: h.created_at,
        engagement: (h.points ?? 0) + (h.num_comments ?? 0),
        raw_text: h.title,
        meta: {
          objectID: h.objectID,
          author: h.author,
          num_comments: h.num_comments ?? 0,
        },
      });
    }
  }

  // ISC-155: top-N HN comments per item with num_comments > 0. Anti-criterion:
  // a fetch failure emits meta.comments: [] AND pushes a named error so the
  // orchestrator surfaces it on the harvest result, never a lying payload.
  const toFetch = items.filter((it) => {
    const n = (it.meta as { num_comments?: number } | undefined)?.num_comments ?? 0;
    return n > 0;
  });

  await mapWithConcurrency(toFetch, COMMENT_FETCH_CONCURRENCY, async (it) => {
    const objectID = (it.meta as { objectID?: string } | undefined)?.objectID ?? '';
    try {
      const comments = await fetchComments(objectID);
      (it.meta as Record<string, unknown>).comments = comments;
    } catch (e) {
      (it.meta as Record<string, unknown>).comments = [] as HNComment[];
      const msg = e instanceof Error ? e.message : String(e);
      commentFetchErrors.push(`hn comments ${objectID}: ${msg}`);
    }
  });

  // Items with num_comments === 0 still get an explicit empty array so the
  // shape is uniform — downstream sentiment passes don't have to discriminate
  // between "missing" and "no comments to fetch".
  for (const it of items) {
    const meta = it.meta as Record<string, unknown>;
    if (meta.comments === undefined) meta.comments = [] as HNComment[];
  }

  return items;
}

async function main(): Promise<void> {
  const items = await harvestHN();
  const errors = drainHNCommentErrors();
  if (items.length === 0) {
    console.error('HN harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'hn.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ items, errors }, null, 2));
  console.log(`HN: ${items.length} items → ${outPath}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  WARN ${e}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('HN harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
