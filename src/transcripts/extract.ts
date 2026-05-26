import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * YouTube transcript extraction (S20 / C1).
 *
 * Pivot from the originally-specced fabric-ai wrapper: fabric-ai `-y URL`
 * requires a configured chat model even for transcript-only mode (probed
 * 2026-05-15: errors "please run 'fabric --setup' and select default model
 * and vendor" without a configured vendor). yt-dlp — which fabric-ai itself
 * wraps — works zero-config and is the cleaner runtime path.
 *
 * What this module does:
 *   - Shells out to `yt-dlp` to fetch auto-generated English subtitles
 *     as VTT, without downloading the video. No API key, no LLM.
 *   - Converts VTT to plain text (drops cue timing, inline tags, and the
 *     yt-dlp animation-mode duplicate lines).
 *   - Captures the raw VTT to `data/raw/transcripts/{captured_at}__{video_id}.vtt`
 *     via the same capture-boundary discipline every harvester uses.
 *   - Never throws to callers — timeout/missing-binary/no-captions all
 *     return null (the YouTube post-pass treats null as "no transcript
 *     this run", per ISC-211 anti-criterion).
 *
 * ISC-208 (revised, see ISA Decisions 2026-05-15 / S20): the binary
 * dependency is yt-dlp on PATH, not fabric-ai. fabric-ai stays installed
 * for future LLM-pattern work; this module does not depend on it.
 *
 * ISC-209/210/211/212/219.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = resolve(__dirname, '..', '..', 'data', 'raw', 'transcripts');

const DEFAULT_TIMEOUT_MS = 60_000;

export function extractVideoId(url: string): string | null {
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? (m[1] ?? null) : null;
}

/**
 * Pure VTT-to-text converter — split out for unit testing without spawning
 * yt-dlp. Handles:
 *   - WEBVTT header lines
 *   - Cue-timing lines (00:00:00.000 --> 00:00:00.000)
 *   - Inline timestamp tags (<00:00:00.000>)
 *   - <c> highlight tags
 *   - yt-dlp's per-cue duplicate lines (auto-sub animation mode)
 */
export function vttToText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let last = '';
  for (const line of lines) {
    if (/^WEBVTT/i.test(line)) continue;
    if (/^(Kind|Language|NOTE)\b/i.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)) continue;
    const cleaned = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && cleaned !== last) {
      out.push(cleaned);
      last = cleaned;
    }
  }
  return out.join(' ');
}

async function captureTranscriptRaw(videoId: string, vtt: string): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(RAW_ROOT, { recursive: true });
    await writeFile(resolve(RAW_ROOT, `${ts}__${videoId}.vtt`), vtt);
  } catch (e) {
    console.error(`  WARN capture: transcripts/${videoId} snapshot failed — ${e instanceof Error ? e.message : e}`);
  }
}

export async function extractTranscript(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let workdir: string | null = null;
  try {
    workdir = await mkdtemp(join(tmpdir(), 'tai-transcript-'));
    const proc = spawn(
      'yt-dlp',
      [
        '--write-auto-sub',
        '--skip-download',
        '--sub-format', 'vtt',
        '--sub-lang', 'en',
        '--no-warnings',
        '-o', '%(id)s',
        url,
      ],
      { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('exit', (c) => resolve(c ?? 1));
      proc.on('error', () => resolve(1));
    });
    clearTimeout(killer);

    if (killed || exitCode !== 0) return null;

    const files = (await readdir(workdir)).filter((f) => f.endsWith('.vtt'));
    if (files.length === 0) return null;
    const first = files[0];
    if (!first) return null;
    const vttRaw = await readFile(join(workdir, first), 'utf8');
    await captureTranscriptRaw(videoId, vttRaw);
    const text = vttToText(vttRaw);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    if (workdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: bun src/transcripts/extract.ts <youtube-url>');
    process.exit(1);
  }
  const text = await extractTranscript(url);
  if (text === null) {
    console.error('extract: returned null (timeout / no captions / yt-dlp error)');
    process.exit(2);
  }
  console.log(`extract: ${text.length} chars`);
  console.log(text.slice(0, 600) + (text.length > 600 ? '...' : ''));
}
