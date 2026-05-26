import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Bluesky harvester — Class-1, zero-auth.
 *
 * NOTE on endpoint choice: app.bsky.feed.searchPosts on the public AppView
 * returns 403 — it requires an auth session. app.bsky.feed.getAuthorFeed,
 * however, IS unauthenticated on public.api.bsky.app (verified live). So this
 * harvester follows the same curated-frontier-accounts pattern as x.ts: pull
 * each handle's recent feed, no token required. Engagement = likes + 2·reposts
 * + replies, with a noise floor so a bare mention never reads as a trend.
 */
const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

// Verified-live AI-researcher handles (getProfile -> 200). Wrong/renamed
// handles 404 and are dropped gracefully by Promise.allSettled.
const HANDLES = [
  'karpathy.bsky.social',
  'simonw.bsky.social',
  'rasbt.bsky.social',
  'emilymbender.bsky.social',
  'drfeifei.bsky.social',
  'huggingface.bsky.social',
];

const PER_HANDLE_CAP = 12;
const MIN_ENGAGEMENT = 5;
const MAX_AGE_DAYS = 21;
const AI_KEYWORDS =
  /\b(AI|LLM|GPT|Claude|Gemini|Llama|Mistral|model|agent|reasoning|RAG|fine-tun|transformer|diffusion|prompt|inference|training|alignment|neural|machine learning|deep learning|multimodal|embedding|benchmark|open[- ]?source|dataset|GPU)\b/i;

type BskyPost = {
  uri: string;
  cid: string;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  indexedAt?: string;
};

type FeedEntry = { post?: BskyPost; reason?: unknown };

function permalink(uri: string, handle: string): string {
  // at://did:plc:xxx/app.bsky.feed.post/RKEY -> https://bsky.app/profile/handle/post/RKEY
  const rkey = uri.split('/').pop() ?? '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function fetchHandle(handle: string): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const url = `${API}?actor=${encodeURIComponent(handle)}&limit=30&filter=posts_no_replies`;
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`@${handle}: HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('bluesky', handle, text);
    const data = JSON.parse(text) as { feed?: FeedEntry[] };
    const feed = data.feed ?? [];

    const items: NormalizedItem[] = [];
    const now = Date.now();
    for (const entry of feed) {
      if (entry.reason) continue; // skip reposts — keep the author's own posts
      const p = entry.post;
      if (!p) continue;
      const postHandle = p.author?.handle ?? handle;
      const txt = p.record?.text;
      if (!txt || !p.uri) continue;
      if (!AI_KEYWORDS.test(txt)) continue;

      const likes = p.likeCount ?? 0;
      const reposts = p.repostCount ?? 0;
      const replies = p.replyCount ?? 0;
      const engagement = likes + reposts * 2 + replies;
      if (engagement < MIN_ENGAGEMENT) continue;

      const tsRaw = p.record?.createdAt ?? p.indexedAt ?? new Date().toISOString();
      const tsParsed = Date.parse(tsRaw);
      const ts = Number.isNaN(tsParsed) ? new Date().toISOString() : new Date(tsParsed).toISOString();
      const ageDays = Number.isNaN(tsParsed) ? 0 : (now - tsParsed) / 86_400_000;
      if (ageDays > MAX_AGE_DAYS) continue;

      const cleaned = txt.replace(/\s+/g, ' ').trim();
      items.push({
        title: `@${postHandle}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? '…' : ''}`,
        url: permalink(p.uri, postHandle),
        source: 'bluesky',
        ts,
        engagement,
        raw_text: cleaned,
        meta: { handle: postHandle, likes, reposts, replies },
      });
    }
    items.sort((a, b) => b.engagement - a.engagement);
    return items.slice(0, PER_HANDLE_CAP);
  } finally {
    clearTimeout(timer);
  }
}

export async function harvestBluesky(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(HANDLES.map(fetchHandle));
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const handle = HANDLES[i];
    if (!r || !handle) continue;
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    } else {
      console.error(`  bluesky @${handle} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestBluesky();
  if (items.length === 0) {
    console.error('Bluesky harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'bluesky.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`Bluesky: ${items.length} items → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Bluesky harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
