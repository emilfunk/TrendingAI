import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Actor name is env-overridable (ISC-167 note) — Session 19.5 ships a sensible
// default, but a non-working actor can be swapped without a code edit so a live
// run never has to wait for a deploy. Apify run-sync URL uses `~` in place of
// `/`, so we accept the human-readable `owner/name` form and translate.
const DEFAULT_ACTOR = 'clockworks/tiktok-scraper';
function actorPath(): string {
  const a = (process.env.TIKTOK_APIFY_ACTOR ?? DEFAULT_ACTOR).trim();
  return a.replace('/', '~');
}

// AI-content hashtags. Kept narrow on purpose — TikTok's hashtag space is huge,
// the goal is high-signal AI content (tools, releases, agentic coding demos),
// not generic tech.
const AI_HASHTAGS = [
  'ai',
  'artificialintelligence',
  'llm',
  'chatgpt',
  'claude',
  'gemini',
  'aitools',
  'aiapps',
  'agenticai',
  'aicoding',
];

// Curated creator whitelist. These are handles that should always-include in
// the report regardless of hashtag-scrape recall.
//
// CURRENT WIRING STATUS: the Apify hashtag-scraper does NOT yet consume this
// list. D1 (2026-05-16 EVENING ratified) replaces it with the Apify actor
// `lofomachines/tiktok-transcription-ai` ($1.50/1000 videos) — reliability
// over cost. That wiring is the next-session D1-D9 build slice; this list is
// the input to that wiring.
//
// Slate ratified by Kem-walk 2026-05-16 EVENING. Riley Brown's TT handle uses
// a DOT not an underscore (handle correction logged in PROJECTS.md).
export const WHITELIST_CREATORS: readonly string[] = [
  '@agentic.james',     // Intergenic James — Kem-named anchor
  '@bio_makers1',       // Jonathan Bazán (6.1M) — largest AI/robotics TT globally
  '@sabrina_ramonov',   // Sabrina Ramonov (766K) — AI Builders community
  '@rileybrown.ai',     // Riley Brown (DOT not underscore) — vibecoding king
  '@tommythings',       // Tommy Tang (1.3M)
  '@gazi.ai',           // Gazi (658K)
  '@adam.digital',      // Adam Digital (534K)
  '@brandnat',          // Brandon Nat (411-430K)
  '@kanekallaway',      // Kane Kallaway (395K)
  '@justinfineberg',    // Justin Fineberg (292K)
  // FLAG for manual review: @aicenturyclips — clip-farm risk per iter-1 audit.
];

type RawTikTok = {
  id?: string;
  webVideoUrl?: string;
  url?: string;
  videoUrl?: string;
  text?: string;
  desc?: string;
  createTimeISO?: string;
  createTime?: string;
  authorMeta?: { name?: string; nickName?: string };
  diggCount?: number;
  playCount?: number;
  shareCount?: number;
  commentCount?: number;
};

function envToken(): string {
  const t = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!t || !t.trim()) {
    throw new Error('APIFY_TOKEN missing — the /trendingai skill prompts for it on first run and writes .env in the bundle directory. Alternatively: export APIFY_TOKEN=... before re-running.');
  }
  return t.trim();
}

async function runActor(input: Record<string, unknown>, label: string): Promise<RawTikTok[]> {
  const token = envToken();
  // ISC-169: Apify token travels in the Authorization header, never in the URL.
  const url = `https://api.apify.com/v2/acts/${actorPath()}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  // iter-46 close — TT whitelist often hit 90s abort on the clockworks actor;
  // bumped to 180s so the actor has room to complete on large profile pulls.
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Apify TikTok actor ${actorPath()}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    await captureRaw('tiktok', label, text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? (data as RawTikTok[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// ISC-301 — TikTok transcript extraction via Apify lofomachines/tiktok-
// transcription-ai. $1.50/1000 videos, reliability over cost (PROJECTS.md
// ITER-22 EVENING ratified, ITER-24 OBSERVE confirmed broad-harvest intent).
// ============================================================================
const TRANSCRIPTION_ACTOR_DEFAULT = 'lofomachines/tiktok-transcription-ai';
function transcriptionActorPath(): string {
  return (process.env.TIKTOK_TRANSCRIPT_APIFY_ACTOR ?? TRANSCRIPTION_ACTOR_DEFAULT).trim().replace('/', '~');
}

// lofomachines/tiktok-transcription-ai response shape (verified via live probe
// 2026-05-16T11:15Z): `video_url` for URL, `plain_text` for transcript text,
// `status: "ok"` on success. Extra fields (verbose.segments, song, channel)
// ignored — we only need text + URL.
type TranscriptResult = {
  status?: string;
  video_url?: string;
  plain_text?: string;
  // Defensive fallbacks for actor-shape drift:
  videoUrl?: string;
  url?: string;
  transcript?: string;
  transcriptText?: string;
  text?: string;
  error?: string;
};

// extractTikTokTranscripts hits the lofomachines actor with a list of video
// URLs and returns a Map<canonicalUrl, transcriptText>. Failed extractions are
// silently dropped from the Map — the caller should mark missing entries as
// transcript_status='unavailable' rather than crashing the harvest.
// Token-presence + HARVEST_PAID=1 gated (mirrors iter-7 spend authorization).
//
// Chunked at TRANSCRIPT_CHUNK_SIZE (default 25) — first live probe (99 vids in
// one call) timed out at the 10-min ceiling. Per-chunk wait stays bounded.
const TRANSCRIPT_CHUNK_SIZE = 25;
const TRANSCRIPT_CHUNK_TIMEOUT_MS = 600_000; // 10 min per chunk

async function transcriptChunk(urls: string[]): Promise<TranscriptResult[]> {
  const token = envToken();
  const actor = transcriptionActorPath();
  const apiUrl = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TRANSCRIPT_CHUNK_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ videoUrls: urls.map((u) => ({ url: u })) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`lofomachines HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    await captureRaw('tiktok', `transcripts-${urls.length}`, text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? (data as TranscriptResult[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function extractTikTokTranscripts(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  if (process.env.HARVEST_PAID !== '1') {
    throw new Error('extractTikTokTranscripts requires HARVEST_PAID=1 (paid Apify spend ~$1.50/1000)');
  }
  for (let i = 0; i < urls.length; i += TRANSCRIPT_CHUNK_SIZE) {
    const chunk = urls.slice(i, i + TRANSCRIPT_CHUNK_SIZE);
    try {
      const data = await transcriptChunk(chunk);
      for (const r of data) {
        if (r.status && r.status !== 'ok') continue;
        const url = r.video_url ?? r.videoUrl ?? r.url;
        const t = r.plain_text ?? r.transcript ?? r.transcriptText ?? r.text;
        if (url && typeof t === 'string' && t.trim().length > 0) {
          out.set(url, t.trim());
        }
      }
      console.error(`TT transcripts chunk ${i / TRANSCRIPT_CHUNK_SIZE + 1}: extracted ${data.length} (running total ${out.size})`);
    } catch (e) {
      console.error(`TT transcripts chunk ${i / TRANSCRIPT_CHUNK_SIZE + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

// Pull recent videos for whitelist creator handles. The DEFAULT_ACTOR
// (clockworks) accepts `profiles` as input alongside `hashtags`.
export async function harvestWhitelistTikTok(handles: string[] = [...WHITELIST_CREATORS], perCreator = 10): Promise<NormalizedItem[]> {
  if (handles.length === 0) return [];
  // Strip leading @ — actor wants bare handles or full profile URLs.
  const profiles = handles.map((h) => h.replace(/^@/, ''));
  const raw = await runActor(
    { profiles, resultsPerPage: perCreator, shouldDownloadVideos: false, shouldDownloadCovers: false },
    'whitelist',
  );
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const t of raw) {
    const n = normalize(t);
    if (!n) continue;
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    items.push(n);
  }
  return items;
}

// Merge transcript text into a NormalizedItem's meta. Returns a NEW item so
// callers can keep the original. Sets transcript_status='unavailable' when no
// transcript was returned (honest gap badge per ISC-211 doctrine).
export function attachTranscript(item: NormalizedItem, transcript: string | undefined): NormalizedItem {
  const meta = { ...(item.meta as Record<string, unknown> | undefined ?? {}) };
  if (transcript && transcript.length > 0) {
    meta.transcript = transcript;
    meta.transcript_status = 'present';
    // Append first 800 chars to raw_text so downstream classify-type.ts +
    // dedupe.ts (ISC-238 tokenization-with-transcripts) see the substance.
    const head = transcript.slice(0, 800);
    return { ...item, meta, raw_text: `${item.raw_text}\n\n${head}` };
  }
  meta.transcript_status = 'unavailable';
  return { ...item, meta };
}

export function normalize(t: RawTikTok): NormalizedItem | null {
  const url = t.webVideoUrl ?? t.url ?? t.videoUrl;
  const text = (t.text ?? t.desc ?? '').toString();
  if (!url || !text) return null;
  const author = t.authorMeta?.name ?? t.authorMeta?.nickName ?? 'unknown';
  const likes = t.diggCount ?? 0;
  const plays = t.playCount ?? 0;
  const shares = t.shareCount ?? 0;
  const comments = t.commentCount ?? 0;
  const ts = t.createTimeISO ?? t.createTime ?? new Date().toISOString();
  // engagement weights shares/comments above passive views — same shape as x.ts
  const engagement = likes + shares * 2 + comments + Math.floor(plays / 100);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const title = `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? '…' : ''}`;
  return {
    title,
    url,
    source: 'tiktok',
    ts,
    engagement,
    raw_text: cleaned,
    // ISC-171: media URL on meta.media so the lens can render it as a linked
    // reel even before the embedded-media boundary (ISC-80..83) fully lands.
    meta: { author, likes, plays, shares, comments, media: url },
  };
}

export async function harvestTikTok(): Promise<NormalizedItem[]> {
  const raw = await runActor(
    {
      hashtags: AI_HASHTAGS,
      resultsPerPage: 30,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
    },
    'hashtags',
  );

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const t of raw) {
    const n = normalize(t);
    if (!n) continue;
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    items.push(n);
  }
  return items;
}

// iter-46 F4 — exported full-pipeline function. Wraps hashtag + whitelist +
// transcript-extraction so the orchestrator's HARVESTERS map can call ONE
// function and get the full TikTok dataset (was only getting hashtagItems via
// `harvestTikTok` alone, which is why EXTRACT_TT_TRANSCRIPTS=1 silently
// didn't fire under `bun run harvest:all`). The standalone main() now wraps
// this same function so direct invocation (`bun src/harvesters/tiktok.ts`)
// behaves identically.
export async function harvestTikTokFull(): Promise<NormalizedItem[]> {
  const hashtagItems = await harvestTikTok();
  let whitelistItems: NormalizedItem[] = [];
  if (process.env.HARVEST_PAID === '1' && process.env.SKIP_TT_WHITELIST !== '1') {
    try {
      whitelistItems = await harvestWhitelistTikTok();
      console.log(`TikTok whitelist: ${whitelistItems.length} videos across ${WHITELIST_CREATORS.length} creators`);
    } catch (e) {
      console.error(`TikTok whitelist harvest failed (continuing with hashtag only): ${e instanceof Error ? e.message : e}`);
    }
  }

  // Merge, dedupe by URL — whitelist items win (richer creator context).
  const byUrl = new Map<string, NormalizedItem>();
  for (const it of hashtagItems) byUrl.set(it.url, it);
  for (const it of whitelistItems) byUrl.set(it.url, it);
  let items = Array.from(byUrl.values());

  // Transcript pass on whitelist items only (cost-aware — hashtag-discovered
  // content can join after we validate the actor's economics).
  if (process.env.HARVEST_PAID === '1' && process.env.EXTRACT_TT_TRANSCRIPTS === '1' && whitelistItems.length > 0) {
    const whitelistUrls = whitelistItems.map((i) => i.url);
    try {
      const transcripts = await extractTikTokTranscripts(whitelistUrls);
      console.log(`TikTok transcripts: ${transcripts.size}/${whitelistUrls.length} extracted`);
      items = items.map((it) => transcripts.has(it.url) || whitelistUrls.includes(it.url)
        ? attachTranscript(it, transcripts.get(it.url))
        : it);
    } catch (e) {
      console.error(`TikTok transcript extraction failed (items shipped without transcripts): ${e instanceof Error ? e.message : e}`);
    }
  }

  return items;
}

async function main(): Promise<void> {
  const items = await harvestTikTokFull();
  if (items.length === 0) {
    console.error('TikTok harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'tiktok.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  const withT = items.filter((i) => (i.meta as { transcript_status?: string } | undefined)?.transcript_status === 'present').length;
  console.log(`TikTok: ${items.length} videos → ${outPath} (${withT} with transcript)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('TikTok harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
