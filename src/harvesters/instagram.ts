import { writeFile, mkdir, readFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Actor name is env-overridable (ISC-168 note). Default targets the hashtag
// scraper — TikTok and Instagram both move on hashtags for AI content.
const DEFAULT_ACTOR = 'apify/instagram-hashtag-scraper';
function actorPath(): string {
  const a = (process.env.INSTAGRAM_APIFY_ACTOR ?? DEFAULT_ACTOR).trim();
  return a.replace('/', '~');
}

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

// Curated creator whitelist (NEW iteration 22, 2026-05-16 EVENING ratified).
// Slate refined from research: Cleo Abram moved to YT-primary (7.8M YT vs
// smaller IG presence). Whitelist below is IG-primary creators only.
//
// CURRENT WIRING STATUS: the hashtag scraper does NOT yet consume this list.
// D2 (2026-05-16 EVENING ratified) replaces it with `instaloader
// --cookies-from-browser` + ffmpeg + Groq Whisper Large v3 Turbo ($0.04/hr,
// ~$0.50/wk for 1000 videos — 9× cheaper than OpenAI for the same model).
// That wiring is the next-session D1-D9 build slice; this list is the input.
export const WHITELIST_CREATORS: readonly string[] = [
  '@danmartell',         // Dan Martell (3M IG)
  '@yourchatgptguide',   // Your ChatGPT Guide (2.0M)
  '@handlytech',         // Handly Tech (982K)
  '@rpn',                // Roberto Nickson (853K)
  '@harpercarrollai',    // Harper Carroll (558K Stanford+Meta)
  '@therundownai',       // The Rundown AI (448K outlet-class)
];

type RawIG = {
  id?: string;
  shortCode?: string;
  url?: string;
  videoUrl?: string;
  displayUrl?: string;
  caption?: string;
  text?: string;
  timestamp?: string;
  takenAtTimestamp?: number;
  ownerUsername?: string;
  ownerFullName?: string;
  likesCount?: number;
  commentsCount?: number;
  videoPlayCount?: number;
  videoViewCount?: number;
  type?: string;
};

function envToken(): string {
  const t = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!t || !t.trim()) {
    throw new Error('APIFY_TOKEN missing — the /trendingai skill prompts for it on first run and writes .env in the bundle directory. Alternatively: export APIFY_TOKEN=... before re-running.');
  }
  return t.trim();
}

async function runActor(input: Record<string, unknown>, label: string): Promise<RawIG[]> {
  const token = envToken();
  // ISC-170: Apify token travels in the Authorization header, never in the URL.
  const url = `https://api.apify.com/v2/acts/${actorPath()}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
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
      throw new Error(`Apify Instagram actor ${actorPath()}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    await captureRaw('instagram', label, text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? (data as RawIG[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

export function normalize(p: RawIG): NormalizedItem | null {
  const url =
    p.url ??
    (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : undefined);
  const text = (p.caption ?? p.text ?? '').toString();
  if (!url || !text) return null;
  const author = p.ownerUsername ?? p.ownerFullName ?? 'unknown';
  const likes = p.likesCount ?? 0;
  const comments = p.commentsCount ?? 0;
  const plays = p.videoPlayCount ?? p.videoViewCount ?? 0;
  const ts =
    p.timestamp ??
    (p.takenAtTimestamp ? new Date(p.takenAtTimestamp * 1000).toISOString() : new Date().toISOString());
  // engagement weights comments slightly above likes — IG comments are higher
  // signal than passive likes; plays only contribute fractionally for reels.
  const engagement = likes + comments * 2 + Math.floor(plays / 100);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const title = `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? '…' : ''}`;
  // Reels surface a video URL; static posts only have a display URL. Prefer
  // the video URL when present (richer media for the lens), else the canonical
  // post URL (still a clickable reel/post link).
  const mediaUrl = p.videoUrl ?? url;
  return {
    title,
    url,
    source: 'instagram',
    ts,
    engagement,
    raw_text: cleaned,
    // ISC-172: media URL on meta.media so the lens renders it as a linked reel
    // even before the embedded-media boundary (ISC-80..83) fully lands.
    meta: { author, likes, comments, plays, kind: p.type ?? 'post', media: mediaUrl },
  };
}

export async function harvestInstagram(): Promise<NormalizedItem[]> {
  const raw = await runActor(
    {
      hashtags: AI_HASHTAGS,
      resultsLimit: 30,
    },
    'hashtags',
  );

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const p of raw) {
    const n = normalize(p);
    if (!n) continue;
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    items.push(n);
  }
  return items;
}

// ============================================================================
// ISC-302 — Instagram transcript extraction via instaloader + ffmpeg + Groq
// Whisper Large v3 Turbo ($0.04/hr, ~9× cheaper than OpenAI for the same
// model). instaloader uses `--cookies-from-browser=chrome` so Kem's existing
// IG session works without storing credentials.
// ============================================================================

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const INSTALOADER_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 90_000;
const GROQ_TIMEOUT_MS = 120_000;

function groqApiKey(): string {
  const k = process.env.GROQ_API_KEY;
  if (!k || !k.trim()) {
    throw new Error('GROQ_API_KEY missing — the /trendingai skill prompts for it on first run and writes .env in the bundle directory. Free signup: https://console.groq.com/keys');
  }
  return k.trim();
}

// Extract IG reel shortcode from a canonical URL like
// https://www.instagram.com/reel/Cabc123xyz/ or .../p/Cabc123xyz/
export function extractShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]{5,})/);
  return m?.[1] ?? null;
}

async function ytdlpDownload(reelUrl: string, targetDir: string, shortcode: string): Promise<string | null> {
  // Pivot from instaloader (no --cookies-from-browser support in 4.15.1) to
  // yt-dlp, which natively supports IG, browser cookies, and is already on
  // PATH from S20 YT transcripts. Format selector picks the best audio-bearing
  // stream; output template writes <shortcode>.<ext> inside targetDir.
  const args = [
    '--cookies-from-browser', 'chrome',
    '--no-warnings', '--quiet',
    '--no-write-info-json', '--no-write-subs',
    '-f', 'best',
    '-o', `${targetDir}/${shortcode}.%(ext)s`,
    reelUrl,
  ];
  try {
    await execFileP('yt-dlp', args, { timeout: INSTALOADER_TIMEOUT_MS });
    const files = await readdir(targetDir);
    const media = files.find((f) => f.startsWith(shortcode) && /\.(mp4|mkv|webm|mov)$/i.test(f));
    return media ? join(targetDir, media) : null;
  } catch {
    return null;
  }
}

async function ffmpegExtractAudio(videoPath: string, audioPath: string): Promise<boolean> {
  const args = ['-loglevel', 'error', '-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath];
  try {
    await execFileP('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS });
    return existsSync(audioPath);
  } catch {
    return false;
  }
}

async function groqTranscribe(audioPath: string): Promise<string | null> {
  const apiKey = groqApiKey();
  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'text');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Groq Whisper HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();
    return text.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractInstagramReelTranscript(reelUrl: string): Promise<string | null> {
  const shortcode = extractShortcode(reelUrl);
  if (!shortcode) return null;
  const workDir = join(tmpdir(), `ig-${shortcode}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const videoPath = await ytdlpDownload(reelUrl, workDir, shortcode);
  if (!videoPath) return null;
  const audioPath = videoPath.replace(/\.[a-zA-Z0-9]+$/, '.mp3');
  const ok = await ffmpegExtractAudio(videoPath, audioPath);
  if (!ok) return null;
  const transcript = await groqTranscribe(audioPath);
  for (const p of [videoPath, audioPath]) {
    try { await unlink(p); } catch { /* best-effort */ }
  }
  return transcript;
}

export async function extractInstagramTranscripts(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  if (process.env.HARVEST_PAID !== '1') {
    throw new Error('extractInstagramTranscripts requires HARVEST_PAID=1 (paid Groq spend ~$0.04/hr)');
  }
  // Sequential — IG rate-limits and Groq has its own limits; instaloader
  // throttles aggressive parallelism. Add a 500ms inter-reel sleep.
  for (const u of urls) {
    try {
      const t = await extractInstagramReelTranscript(u);
      if (t) out.set(u, t);
    } catch (e) {
      console.error(`IG transcript skip ${u}: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

export function attachTranscript(item: NormalizedItem, transcript: string | undefined): NormalizedItem {
  const meta = { ...(item.meta as Record<string, unknown> | undefined ?? {}) };
  if (transcript && transcript.length > 0) {
    meta.transcript = transcript;
    meta.transcript_status = 'present';
    const head = transcript.slice(0, 800);
    return { ...item, meta, raw_text: `${item.raw_text}\n\n${head}` };
  }
  meta.transcript_status = 'unavailable';
  return { ...item, meta };
}

export async function harvestWhitelistInstagram(handles: string[] = [...WHITELIST_CREATORS], perCreator = 10): Promise<NormalizedItem[]> {
  if (handles.length === 0) return [];
  // iter-46 F4 close: switched from apify/instagram-profile-scraper (returned 0
  // items in iter-46 UAT) to apify/instagram-reel-scraper which iter-24.5
  // memory confirmed works at $0.0023/reel. Input key is `username` (singular,
  // array of handles), NOT `usernames` — the reel-scraper actor's contract.
  // Env override INSTAGRAM_PROFILE_APIFY_ACTOR remains for advanced users.
  const profileActor = process.env.INSTAGRAM_PROFILE_APIFY_ACTOR ?? 'apify/instagram-reel-scraper';
  const actor = profileActor.replace('/', '~');
  const token = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN missing');
  const apiUrl = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?format=json`;
  const usernames = handles.map((h) => h.replace(/^@/, ''));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.trim()}` },
      // reel-scraper contract: `username` (array singular) + `resultsLimit` per
      // profile. Body key must match exactly or the actor returns 0 items.
      body: JSON.stringify({ username: usernames, resultsLimit: perCreator }),
    });
    if (!res.ok) throw new Error(`IG reel actor HTTP ${res.status}`);
    const text = await res.text();
    await captureRaw('instagram', 'whitelist', text);
    const data = JSON.parse(text) as RawIG[];
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    const items: NormalizedItem[] = [];
    for (const p of data) {
      const n = normalize(p);
      if (!n) continue;
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      items.push(n);
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// iter-46 F4 — exported full-pipeline function. Mirror of harvestTikTokFull.
// orchestrator's HARVESTERS map calls THIS so EXTRACT_IG_TRANSCRIPTS=1 fires
// under `bun run harvest:all`; previously the orchestrator only invoked
// `harvestInstagram` (the hashtag pass) and the whitelist + transcript logic
// in standalone main() never ran.
export async function harvestInstagramFull(): Promise<NormalizedItem[]> {
  const hashtagItems = await harvestInstagram();
  let whitelistItems: NormalizedItem[] = [];
  if (process.env.HARVEST_PAID === '1' && process.env.SKIP_IG_WHITELIST !== '1') {
    try {
      whitelistItems = await harvestWhitelistInstagram();
      console.log(`Instagram whitelist: ${whitelistItems.length} posts across ${WHITELIST_CREATORS.length} creators`);
    } catch (e) {
      console.error(`Instagram whitelist harvest failed (continuing with hashtag only): ${e instanceof Error ? e.message : e}`);
    }
  }

  const byUrl = new Map<string, NormalizedItem>();
  for (const it of hashtagItems) byUrl.set(it.url, it);
  for (const it of whitelistItems) byUrl.set(it.url, it);
  let items = Array.from(byUrl.values());

  // Transcript pass on whitelist reels only — Groq Whisper bills per audio second,
  // so unbounded extraction on hashtag content would balloon cost.
  if (process.env.HARVEST_PAID === '1' && process.env.EXTRACT_IG_TRANSCRIPTS === '1' && whitelistItems.length > 0) {
    // Only attempt reels (the hashtag scraper includes static posts too — those
    // have no audio).
    const reelUrls = whitelistItems
      .filter((i) => (i.meta as { kind?: string } | undefined)?.kind === 'Video' || /\/reel\//.test(i.url))
      .map((i) => i.url);
    try {
      const transcripts = await extractInstagramTranscripts(reelUrls);
      console.log(`Instagram transcripts: ${transcripts.size}/${reelUrls.length} extracted`);
      items = items.map((it) => reelUrls.includes(it.url) ? attachTranscript(it, transcripts.get(it.url)) : it);
    } catch (e) {
      console.error(`Instagram transcript extraction failed (items shipped without transcripts): ${e instanceof Error ? e.message : e}`);
    }
  }

  return items;
}

async function main(): Promise<void> {
  const items = await harvestInstagramFull();
  if (items.length === 0) {
    console.error('Instagram harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'instagram.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  const withT = items.filter((i) => (i.meta as { transcript_status?: string } | undefined)?.transcript_status === 'present').length;
  console.log(`Instagram: ${items.length} posts → ${outPath} (${withT} with transcript)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Instagram harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
