import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';
import { extractTranscript } from '../transcripts/extract.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * YouTube harvester — Class-1, zero-auth. YouTube exposes a public Atom feed
 * per channel at /feeds/videos.xml?channel_id=ID — no API key, no quota.
 * Engagement = view count from <media:statistics views="...">.
 */
type YTChannel = { name: string; channelId: string };

// Tutorial / research-explainer / lessons / SKOL-community AI channels.
// Short-form, often dense text in description, transcripts rarely add
// classifier signal beyond title+description — so transcript extraction stays
// opt-in for these (set EXTRACT_TRANSCRIPTS=1 to force-on for tutorials too).
const TUTORIAL_CHANNELS: YTChannel[] = [
  { name: 'Two Minute Papers', channelId: 'UCbfYPyITQ-7l4upoX8nvctg' },
  { name: 'Yannic Kilcher', channelId: 'UCZHmQk67mSJgfCCTn7xBfew' },
  { name: 'AI Explained', channelId: 'UCNJ1Ymd5yFuUPtn21xtRbbw' },
  { name: 'Andrej Karpathy', channelId: 'UCXUPKJO5MZQN11PqgIvyuvQ' },
  // Chase Hannegan, chaseai.io — Kem-reframe 2026-05-16 (iter-22 post-validation):
  // not a talking-head per Kem; SKOL/community lessons creator (Claude Code
  // Masterclass, "how I use this system" content). Lessons-style suits TUTORIAL
  // classification — title+description usually carries the lesson topic. Real YT
  // channel is @Chase-H-AI (NOT @chaseai18 which is Vishesh Zorin per audit).
  { name: 'Chase Hannegan', channelId: 'UCoy6cTJ7Tg0dqS-DI-_REsA' },
];

// Long-form podcast / interview channels. Title+description rarely captures
// the actual substance ("Episode 47 with Guest X" doesn't tell the classifier
// what was said). For podcasts, transcript text is the load-bearing classifier
// signal — so EXTRACT_TRANSCRIPTS defaults to ON for this group per D3
// (2026-05-16 EVENING ratified). Override: set EXTRACT_TRANSCRIPTS=0 to
// disable for free runs that skip the 30s/item yt-dlp shell-out.
const PODCAST_CHANNELS: YTChannel[] = [
  // Path A podcast additions (Kem-confirmed 2026-05-16 morning) — YouTube-
  // published AI podcasts. channelIds resolved via parallel `yt-dlp --print
  // %(channel_id)s` against the @-handle.
  { name: 'AI Daily Brief', channelId: 'UCKelCK4ZaO6HeEI1KQjqzWA' },
  { name: 'Latent Space', channelId: 'UCxBcwypKK-W3GHd_RZ9FZrQ' },
  { name: 'Cognitive Revolution', channelId: 'UCjNRVMBVI30Sak_p6HRWhIA' },
  { name: "Lenny's Podcast", channelId: 'UC6t1O76G0jYXOAoYCm153dA' },
  { name: 'No Priors', channelId: 'UCSI7h9hydQ40K5MJHnCrQvw' },
  { name: 'BG2 Pod', channelId: 'UC-yRDvpR99LUc5l7i7jLzew' },
  { name: 'All-In Podcast', channelId: 'UCESLZhusAkFfsNsApnjF_Cg' },
  { name: 'Acquired', channelId: 'UCyFqFYfTW2VoIQKylJ04Rtw' },
  { name: 'Hard Fork', channelId: 'UCZcR2SVWaGWNlMqPxvQS3vw' },
  { name: 'The PrimeTime', channelId: 'UCUyeluBRhGPCW4rPe_UvBZQ' },
  { name: 'Theo - t3.gg', channelId: 'UCbRP3c757lWg9M-U7TyEkXA' },
  { name: 'Practical AI', channelId: 'UCIRYeDQviNEmpYrJpMaHBiw' },
  // iter-22 post-validation reclassifications (Kem-call 2026-05-16 evening):
  // Lex Fridman is a podcaster ("not always AI — very random"); AI_KEYWORDS
  // filter at fetchChannel still gates which items pass, so non-AI episodes
  // don't reach transcript extraction.
  { name: 'Lex Fridman', channelId: 'UCSHZKyawb77ixDdsGog4iWA' },
  // Machine Learning Street Talk is an interview podcast; transcripts are the
  // primary classifier signal for long-form interview substance.
  { name: 'Machine Learning Street Talk', channelId: 'UCMLtBahI5DMrt0NPvDSoIRQ' },
];

// PODCAST_CHANNEL_IDS feeds the per-item podcast detection inside
// extractTranscriptsFor — used to default-on transcript extraction for
// podcast items even when the global EXTRACT_TRANSCRIPTS env is unset.
const PODCAST_CHANNEL_IDS = new Set(PODCAST_CHANNELS.map((c) => c.channelId));

// Single CHANNELS array preserved for harvestYouTube iteration order and any
// downstream consumer that imported it before the split — additive change.
const CHANNELS: YTChannel[] = [...TUTORIAL_CHANNELS, ...PODCAST_CHANNELS];

const AI_KEYWORDS =
  /\b(AI|LLM|GPT|Claude|Gemini|Llama|Mistral|model|agent|reasoning|RAG|fine-tun|transformer|diffusion|prompt|inference|training|alignment|neural|machine learning|deep learning|multimodal|embedding|robot)\b/i;
const MAX_AGE_DAYS = 21;
const PER_CHANNEL_CAP = 8;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function extractFirst(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m && m[1] !== undefined ? m[1] : null;
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]+)"`, 'i');
  const m = re.exec(block);
  return m ? (m[1] ?? null) : null;
}

/**
 * fetchChannel — yt-dlp replacement for YouTube's deprecated RSS feed.
 *
 * Google killed `/feeds/videos.xml?channel_id=...` (universal HTTP 404 from
 * 2026-05 onward — confirmed across all channels, all User-Agents, all
 * variant URLs including `/feeds/api/videos`, mobile m.youtube, and
 * playlist_id form). yt-dlp is the working substitute: it talks to YouTube's
 * internal player API directly, gets per-video metadata in one HTTP round-
 * trip per video, and is already a project dependency (used by
 * src/transcripts/extract.ts for captions).
 *
 * Trade-off: yt-dlp is ~3-6s per channel for PER_CHANNEL_CAP=8 videos
 * (a few HTTP fetches batched by yt-dlp). The RSS feed was ~150ms. For
 * 19 channels parallelized via Promise.all in harvestYouTube, total
 * wall-clock is ~10-15s — acceptable for the weekly cadence.
 *
 * Failure modes:
 *   - yt-dlp not in PATH → throws `yt-dlp missing` for the channel; the
 *     orchestrator catches per-channel errors and continues other sources.
 *   - Channel gone / renamed → yt-dlp prints to stderr, exits non-zero;
 *     captureRaw still records the stderr trace for post-mortem.
 *   - Single video metadata fetch hangs → 30s per-channel timeout kills
 *     the whole channel fetch (rather than per-video timeout, which yt-dlp
 *     doesn't expose cleanly).
 */
async function fetchChannel(ch: YTChannel): Promise<NormalizedItem[]> {
  const channelUrl = `https://www.youtube.com/channel/${ch.channelId}/videos`;
  // Pipe-delimited per-video output. description.500s caps to 500 chars so
  // raw_text (we slice further to 280) doesn't bloat. Empty fields render
  // as 'NA' from yt-dlp; we treat 'NA' as missing.
  const fmt =
    '%(id)s|%(title)s|%(view_count)s|%(upload_date)s|%(description).500s';

  const stdout = await new Promise<string>((resolveP, rejectP) => {
    const child = spawn(
      'yt-dlp',
      [
        '--no-warnings',
        '--ignore-errors',
        '--print',
        fmt,
        '--playlist-end',
        String(PER_CHANNEL_CAP),
        channelUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    // 90s per-channel ceiling. Under 19-way Promise.all parallelism in
    // harvestYouTube, each yt-dlp subprocess shares bandwidth + may hit
    // YouTube's per-IP soft-throttle. Empirically 30s was too tight (10/19
    // channels timed out); 90s lets the slow tail finish without serializing.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectP(new Error(`${ch.name}: yt-dlp timeout (90s)`));
    }, 90_000);
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf-8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(new Error(`${ch.name}: yt-dlp spawn failed — ${(e as Error).message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // yt-dlp can exit non-zero for partial failure but still emit usable
      // lines on stdout (e.g. one video gone, others fine). Surface stdout
      // if we have any lines; only reject when stdout is empty AND we have
      // an error signal.
      if (!out.trim() && code !== 0) {
        rejectP(new Error(`${ch.name}: yt-dlp exit ${code} — ${err.slice(0, 200)}`));
        return;
      }
      resolveP(out);
    });
  });

  await captureRaw('youtube', ch.name, stdout);

  const items: NormalizedItem[] = [];
  const now = Date.now();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 5) continue;
    const [videoId, rawTitle, viewsRaw, uploadDate, ...descParts] = parts;
    if (!videoId || !rawTitle) continue;

    const title = rawTitle.replace(/\s+/g, ' ').trim();
    // descParts re-join in case description itself contained a literal `|`
    const desc = descParts.join('|').replace(/\s+/g, ' ').trim();
    if (!AI_KEYWORDS.test(title + ' ' + desc)) continue;

    // upload_date is YYYYMMDD; convert to ISO. yt-dlp uses 'NA' for missing.
    let ts: string;
    let tsMs: number;
    if (uploadDate && uploadDate !== 'NA' && uploadDate.length === 8) {
      const y = uploadDate.slice(0, 4);
      const m = uploadDate.slice(4, 6);
      const d = uploadDate.slice(6, 8);
      const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
      tsMs = dt.getTime();
      ts = Number.isNaN(tsMs) ? new Date().toISOString() : dt.toISOString();
    } else {
      ts = new Date().toISOString();
      tsMs = now;
    }
    const ageDays = (now - tsMs) / 86_400_000;
    if (ageDays > MAX_AGE_DAYS) continue;

    const views = viewsRaw && viewsRaw !== 'NA' ? parseInt(viewsRaw, 10) : 0;
    const engagement = Number.isNaN(views) ? 0 : views;
    const link = `https://www.youtube.com/watch?v=${videoId}`;

    items.push({
      title: `[${ch.name}] ${title}`,
      url: link,
      source: 'youtube',
      ts,
      engagement,
      raw_text: title + ' — ' + desc.slice(0, 280),
      meta: { channel: ch.name, views: engagement, summary: desc.slice(0, 280) },
    });
  }
  items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return items.slice(0, PER_CHANNEL_CAP);
}

/**
 * Iteration 20 (S20 / C1) — transcript post-pass.
 *
 * When transcript extraction is active for an item, pulls auto-generated
 * YouTube captions via yt-dlp (see src/transcripts/extract.ts) and:
 *   - Populates `meta.transcript` with the cleaned plain-text transcript.
 *   - Extends `raw_text` to include the first ~800 chars of transcript so
 *     downstream classifiers (classify-type.ts truncates raw_text to 480
 *     chars) see real spoken content beyond title+description (ISC-212).
 *
 * Anti (ISC-211): a failed extraction NEVER drops the parent item — the
 * item ships with `meta.transcript_status: 'unavailable'` instead.
 *
 * Iteration 22 / D3 (2026-05-16 EVENING) — per-channel default split:
 *   - PODCAST_CHANNELS default-on. Long-form podcasts need transcript text
 *     for any real classifier signal; title+description alone is too thin.
 *   - TUTORIAL_CHANNELS default-off. Short-form explainer titles+descriptions
 *     usually carry enough signal; transcripts add 30s/item with little gain.
 *
 * Env overrides (global, override per-channel default):
 *   - EXTRACT_TRANSCRIPTS=1 (or true/yes) — force-on for ALL items
 *   - EXTRACT_TRANSCRIPTS=0 (or false/no) — force-off for ALL items
 *   - unset — per-channel default applies (podcast=on, tutorial=off)
 */
type TranscriptModeOverride = 'on' | 'off' | 'default';
function transcriptOverride(): TranscriptModeOverride {
  const v = (process.env.EXTRACT_TRANSCRIPTS ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return 'on';
  if (v === '0' || v === 'false' || v === 'no') return 'off';
  return 'default';
}
function shouldExtractFor(item: NormalizedItem): boolean {
  const mode = transcriptOverride();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // Per-channel default: podcasts on, tutorials off. Identify the channel by
  // matching the item's channel name back to PODCAST_CHANNELS — done via the
  // meta.channel field that fetchChannel writes per item.
  const ch = (item.meta as { channel?: string } | undefined)?.channel;
  if (!ch) return false;
  return PODCAST_CHANNELS.some((c) => c.name === ch);
}

const TRANSCRIPT_CHARS_IN_RAW_TEXT = 800;
const TRANSCRIPT_CONCURRENCY = 2;

export async function extractTranscriptsFor(items: NormalizedItem[]): Promise<void> {
  // Per-item filter: respect the per-channel default + env override.
  const targets = items.filter(shouldExtractFor);
  if (targets.length === 0) return;
  // Bounded concurrency: yt-dlp shells out per item, so unbounded parallelism
  // would fan out 50+ subprocess on a full run.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const idx = cursor++;
      const it = targets[idx];
      if (!it) continue;
      try {
        const text = await extractTranscript(it.url);
        if (text === null) {
          it.meta = { ...(it.meta ?? {}), transcript_status: 'unavailable' };
          continue;
        }
        it.meta = { ...(it.meta ?? {}), transcript: text, transcript_status: 'present' };
        // Enrich raw_text so classify-type's 480-char input window picks up
        // real spoken content past the title+description prefix.
        it.raw_text = it.raw_text + ' — ' + text.slice(0, TRANSCRIPT_CHARS_IN_RAW_TEXT);
      } catch (e) {
        // extractTranscript never throws, but defense-in-depth: a thrown
        // anything here must not drop the item.
        it.meta = { ...(it.meta ?? {}), transcript_status: 'unavailable' };
        console.error(`  WARN youtube transcript ${it.url}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: TRANSCRIPT_CONCURRENCY }, worker));
}

export async function harvestYouTube(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(CHANNELS.map(fetchChannel));
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ch = CHANNELS[i];
    if (!r || !ch) continue;
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    } else {
      console.error(`  youtube ${ch.name} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  if (items.length > 0) {
    const targets = items.filter(shouldExtractFor);
    if (targets.length > 0) {
      const mode = transcriptOverride();
      const label = mode === 'on' ? 'EXTRACT_TRANSCRIPTS=on (all)'
        : mode === 'off' ? 'EXTRACT_TRANSCRIPTS=off (skipped)'
        : 'per-channel default (podcasts on)';
      console.error(`  youtube: ${label} — pulling captions for ${targets.length}/${items.length} items via yt-dlp`);
      await extractTranscriptsFor(items);
      const withTranscript = items.filter((it) => (it.meta as { transcript_status?: string } | undefined)?.transcript_status === 'present').length;
      console.error(`  youtube: transcripts extracted for ${withTranscript}/${targets.length} targeted items`);
    }
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestYouTube();
  if (items.length === 0) {
    console.error('YouTube harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'youtube.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`YouTube: ${items.length} items → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('YouTube harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
