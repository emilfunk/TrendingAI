#!/usr/bin/env bun
/**
 * iter-46 — Caption-fetch + quote-match pipeline step.
 *
 * Reads podcast-themes.json + security-events.json, extracts all referenced
 * YouTube video_ids, fetches their auto-captions via yt-dlp (cached on disk),
 * then matches each quote against the timestamped transcript to recover
 * the second-mark where the quote was actually spoken.
 *
 * Writes timestamp_seconds back into:
 *   - data/podcast-themes.json   (episodes[].timestamp_seconds)
 *   - data/security-events.json  (excerpts[].timestamp_seconds + is_mock_timestamp=false)
 *
 * The Hot in Podcasts ▶ LISTEN chip (renderPodcastThemesPanel) and the
 * Security attr-listen chip (renderSecurityEventBlock) both deep-link via
 * YouTube's &t=Xs URL parameter when timestamp_seconds is present.
 *
 * Determinism contract: yt-dlp captions are cached at data/captions/<vid>.en.vtt
 * so re-runs are idempotent against unchanged YouTube data. Matcher output is
 * deterministic for fixed transcripts (picks the first occurrence of the
 * longest distinctive non-stopword token in the quote).
 *
 * Cost: $0 hard (yt-dlp auto-captions are free; YouTube serves them as
 * their own first-party data). ~3 min wall-clock for ~30 video first-time
 * pulls; near-instant on cached re-runs.
 *
 * Pipeline position (package.json features:pipeline):
 *   classify-one-to-watch → THIS STEP → render-features-first
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DATA = path.join(ROOT, "data");
const CAPS = path.join(DATA, "captions");

const STOP = new Set(
  "the of and to a in is it for on with by that this from as at are was were be have has had not but or an its their our your you i we they all also can if into one out over so some such them then there these those will would just very most more much only than what when where which who how about while many upon why he she his her him hers itself within without other another after before through during because between against under above below"
    .split(" "),
);

interface Episode {
  show?: string;
  video_id?: string;
  url?: string;
  angle?: string;
  timestamp_seconds?: number;
  timestamp_match_word?: string;
  timestamp_manual_override?: string;
}
interface PodcastTheme {
  theme: string;
  summary?: string;
  episodes?: Episode[];
}
interface PodcastThemesDoc {
  themes: PodcastTheme[];
  [k: string]: unknown;
}
interface SecurityExcerpt {
  show?: string;
  url?: string;
  quote?: string;
  timestamp_seconds?: number;
  is_mock_timestamp?: boolean;
  timestamp_match_word?: string;
}
interface SecurityEvent {
  headline?: string;
  excerpts?: SecurityExcerpt[];
}
interface SecurityDoc {
  events: SecurityEvent[];
  [k: string]: unknown;
}

function vidFromUrl(u: string | undefined): string | null {
  if (!u) return null;
  const m = u.match(/(?:v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1]! : null;
}

function collectVideoIds(podcasts: PodcastThemesDoc, sec: SecurityDoc): string[] {
  const ids = new Set<string>();
  for (const t of podcasts.themes ?? []) {
    for (const ep of t.episodes ?? []) {
      const v = ep.video_id || vidFromUrl(ep.url);
      if (v) ids.add(v);
    }
  }
  for (const ev of sec.events ?? []) {
    for (const ex of ev.excerpts ?? []) {
      const v = vidFromUrl(ex.url);
      if (v) ids.add(v);
    }
  }
  return [...ids].sort();
}

function fetchCaptions(vids: string[]): void {
  if (!existsSync(CAPS)) mkdirSync(CAPS, { recursive: true });
  const missing = vids.filter((v) => !existsSync(path.join(CAPS, `${v}.en.vtt`)));
  if (missing.length === 0) {
    console.log(`captions: all ${vids.length} videos already cached`);
    return;
  }
  console.log(`captions: fetching ${missing.length} new of ${vids.length} total via yt-dlp...`);
  const urls = missing.map((v) => `https://www.youtube.com/watch?v=${v}`).join(" ");
  try {
    execSync(
      `yt-dlp --write-auto-sub --skip-download --sub-langs en --sub-format vtt --convert-subs vtt --no-warnings --quiet --ignore-errors -o "${CAPS}/%(id)s.%(ext)s" ${urls}`,
      { stdio: "inherit" },
    );
  } catch {
    // yt-dlp prints to stderr but exits 0 with --ignore-errors; failures are individual videos
  }
  const after = readdirSync(CAPS).filter((f) => f.endsWith(".en.vtt")).length;
  console.log(`captions: ${after} VTT files on disk after fetch`);
}

interface VttSeg {
  ts: number;
  text: string;
}

function parseVtt(file: string): VttSeg[] {
  const text = readFileSync(file, "utf-8");
  const segs: VttSeg[] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+):(\d+):(\d+)\./);
    if (m) {
      cur = parseInt(m[1]!) * 3600 + parseInt(m[2]!) * 60 + parseInt(m[3]!);
    } else if (!line.includes("-->") && !/^(WEBVTT|Kind:|Language:)/.test(line)) {
      const clean = line.replace(/<[^>]+>/g, "").trim();
      if (clean) segs.push({ ts: cur, text: clean });
    }
  }
  // dedupe consecutive identical text (YouTube auto-VTT emits each line twice)
  const out: VttSeg[] = [];
  let prev = "";
  for (const s of segs) {
    if (s.text !== prev) {
      out.push(s);
      prev = s.text;
    }
  }
  return out;
}

function distinctiveTokens(quote: string, minLen = 6, maxN = 6): string[] {
  const q = (quote || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  const seen = new Set<string>();
  return q
    .split(/\s+/)
    .filter((w) => w.length >= minLen && !STOP.has(w))
    .filter((w) => (seen.has(w) ? false : (seen.add(w), true)))
    .sort((a, b) => b.length - a.length)
    .slice(0, maxN);
}

/** Find first VTT segment containing the word; return its start_ts minus 5s lead-in. */
function firstHitTimestamp(segs: VttSeg[], word: string): number | null {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (const s of segs) {
    if (re.test(s.text)) return Math.max(0, s.ts - 5);
  }
  return null;
}

function matchQuote(file: string, quote: string): { ts: number; word: string } | null {
  if (!existsSync(file)) return null;
  const segs = parseVtt(file);
  if (segs.length === 0) return null;
  const tokens = distinctiveTokens(quote);
  for (const w of tokens) {
    const ts = firstHitTimestamp(segs, w);
    if (ts !== null && ts > 5) return { ts, word: w };
  }
  return null;
}

function run() {
  const podcasts = JSON.parse(readFileSync(path.join(DATA, "podcast-themes.json"), "utf-8")) as PodcastThemesDoc;
  const sec = JSON.parse(readFileSync(path.join(DATA, "security-events.json"), "utf-8")) as SecurityDoc;

  const vids = collectVideoIds(podcasts, sec);
  console.log(`unique video_ids found: ${vids.length}`);
  fetchCaptions(vids);

  let podMatched = 0;
  let podTotal = 0;
  for (const t of podcasts.themes ?? []) {
    for (const ep of t.episodes ?? []) {
      podTotal++;
      // Preserve manual overrides — Kem-walk fixes for weak matches.
      if (ep.timestamp_manual_override) {
        podMatched++;
        continue;
      }
      const vid = ep.video_id || vidFromUrl(ep.url);
      if (!vid) continue;
      const cap = path.join(CAPS, `${vid}.en.vtt`);
      const m = matchQuote(cap, ep.angle ?? "");
      if (m) {
        ep.timestamp_seconds = m.ts;
        ep.timestamp_match_word = m.word;
        podMatched++;
      }
    }
  }

  let secMatched = 0;
  let secTotal = 0;
  for (const ev of sec.events ?? []) {
    for (const ex of ev.excerpts ?? []) {
      secTotal++;
      const vid = vidFromUrl(ex.url);
      if (!vid) continue;
      const cap = path.join(CAPS, `${vid}.en.vtt`);
      const m = matchQuote(cap, ex.quote ?? "");
      if (m) {
        ex.timestamp_seconds = m.ts;
        ex.timestamp_match_word = m.word;
        ex.is_mock_timestamp = false;
        secMatched++;
      }
    }
  }

  writeFileSync(path.join(DATA, "podcast-themes.json"), `${JSON.stringify(podcasts, null, 2)}\n`);
  writeFileSync(path.join(DATA, "security-events.json"), `${JSON.stringify(sec, null, 2)}\n`);

  console.log(`podcast episodes timestamped: ${podMatched}/${podTotal}`);
  console.log(`security excerpts timestamped: ${secMatched}/${secTotal}`);
}

if (import.meta.main) run();
