// src/validate-transcript.ts — YouTube transcript alignment validator (v0.9).
//
// For each (ship × YT video ID) pair, pull the auto-sub transcript via yt-dlp
// (existing S20 install at /opt/homebrew/bin/yt-dlp), send first 2000 chars to
// Haiku with the feature spec, and emit one verdict per video:
//   VALIDATED — transcript substantively discusses the feature.
//   ADJACENT  — transcript mentions the broader product area but not the feature.
//   UNRELATED — transcript is about something else entirely (or transcript missing).
//
// Render drops ADJACENT/UNRELATED YT videos from the feature card. VALIDATED
// videos stay with a transcript-grounded one-line confidence reason.
//
// OUTPUT: data/transcript-validation.json

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;

type Verdict = "VALIDATED" | "ADJACENT" | "UNRELATED";

interface VideoCandidate {
  ship_id: string;
  ship_name: string;
  video_id: string;
  channel?: string;
}

interface Result {
  ship: string;
  ship_name: string;
  video_id: string;
  url: string;
  channel?: string;
  transcript_chars: number;
  verdict: Verdict;
  reason: string;
  raw: string;
}

// v0.8 carried these two YT thumb-cards; future expansion = add more here OR
// derive from a youtube.json once that harvester ships per-card YT seeding.
const VIDEO_CANDIDATES: VideoCandidate[] = [
  { ship_id: "codex-mobile", ship_name: "Codex in ChatGPT mobile app", video_id: "UrG_nF_RuqM", channel: "Theo - t3.gg" },
  { ship_id: "opus-4-7", ship_name: "Claude Opus 4.7", video_id: "gILMoijqeGA", channel: "Cognitive Revolution" },
];

const SHIP_DESCS: Record<string, string> = {
  goal: "Anthropic Claude Code slash command that lets the user declare what 'done' looks like so the agent keeps working until it gets there.",
  "codex-mobile": "OpenAI's Codex coding agent surfaced inside the ChatGPT mobile app — start work, review output, approve next steps from a phone.",
  "opus-4-7": "Anthropic's Claude Opus 4.7 model release with tighter multi-step reasoning.",
  mcp: "Anthropic's open standard for how models reach into external tools and data sources.",
  smb: "Anthropic's first SMB-targeted product tier with admin controls for 1-100 person companies.",
  "creative-work": "Anthropic's pitch at the design and writing audience — workflow-shaped features for creative production.",
};

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function vttToText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("WEBVTT")) continue;
    if (line.startsWith("NOTE")) continue;
    if (line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (/^\d\d:\d\d:\d\d\.\d{3}\s*-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    const clean = line
      .replace(/<\d\d:\d\d:\d\d\.\d{3}>/g, "")
      .replace(/<\/?c[^>]*>/g, "");
    if (clean) out.push(clean);
  }
  // dedupe consecutive duplicates (yt-dlp emits per-cue duplicates)
  const dedup: string[] = [];
  for (const l of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== l) dedup.push(l);
  }
  return dedup.join(" ");
}

async function pullTranscript(videoId: string): Promise<string | null> {
  const tmp = mkdtempSync(join(tmpdir(), `tt-${videoId}-`));
  try {
    const { code, stderr } = await exec(
      "yt-dlp",
      [
        "--write-auto-sub",
        "--skip-download",
        "--sub-format",
        "vtt",
        "--sub-lang",
        "en",
        "--output",
        join(tmp, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      60_000,
    );
    if (code !== 0) {
      console.error(`  yt-dlp exit ${code} on ${videoId}: ${stderr.slice(0, 160)}`);
      return null;
    }
    const files = readdirSync(tmp).filter((f) => f.endsWith(".vtt"));
    if (!files.length || !files[0]) return null;
    const vtt = readFileSync(join(tmp, files[0]), "utf-8");
    return vttToText(vtt);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  }
}

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
        "--level",
        "fast",
        "--timeout",
        "60000",
        systemPrompt,
        userPrompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

const SYS = `You are a video-content validator. Read the FEATURE spec and the TRANSCRIPT excerpt (first ~2000 chars of an auto-generated subtitle file). Decide if the video substantively discusses the named feature.
Reply with ONE line in this EXACT format:
VERDICT: <VALIDATED|ADJACENT|UNRELATED> | REASON: <one short sentence quoting or paraphrasing what the transcript actually says>

Definitions:
- VALIDATED: transcript clearly discusses, demos, or critiques the named feature.
- ADJACENT: transcript discusses the broader product area or related capability but not THIS specific feature.
- UNRELATED: transcript is about something else.

Be strict. ADJACENT and UNRELATED videos are DROPPED from the feature card.`;

function parseVerdict(raw: string): { verdict: Verdict; reason: string; line: string } {
  const lines = raw.split("\n");
  const line = lines.find((l) => l.startsWith("VERDICT:")) ?? lines[0] ?? "";
  const m = line.match(/VERDICT:\s*(VALIDATED|ADJACENT|UNRELATED)\s*\|\s*REASON:\s*(.+)/i);
  if (!m) return { verdict: "UNRELATED", reason: `unparseable: ${line.slice(0, 140)}`, line };
  return { verdict: (m[1] ?? "UNRELATED").toUpperCase() as Verdict, reason: (m[2] ?? "").trim(), line };
}

async function main() {
  console.log(`validating ${VIDEO_CANDIDATES.length} YT video(s)...`);
  const results: Result[] = [];
  for (const cand of VIDEO_CANDIDATES) {
    const url = `https://www.youtube.com/watch?v=${cand.video_id}`;
    console.log(`\n[${cand.ship_id} / ${cand.video_id}] pulling transcript...`);
    const transcript = await pullTranscript(cand.video_id);
    if (!transcript) {
      console.log(`  → no transcript available — verdict UNRELATED`);
      results.push({
        ship: cand.ship_id,
        ship_name: cand.ship_name,
        video_id: cand.video_id,
        url,
        channel: cand.channel,
        transcript_chars: 0,
        verdict: "UNRELATED",
        reason: "no auto-subtitle track available (yt-dlp failed or video has no captions)",
        raw: "no-transcript",
      });
      continue;
    }
    const excerpt = transcript.slice(0, 2000);
    console.log(`  → got ${transcript.length} chars, sending ${excerpt.length}-char excerpt to Haiku`);
    const userPrompt = `FEATURE: ${cand.ship_name}
FEATURE DESCRIPTION: ${SHIP_DESCS[cand.ship_id] || cand.ship_name}

VIDEO CHANNEL: ${cand.channel || "unknown"}
TRANSCRIPT EXCERPT (first ${excerpt.length} chars):
"""
${excerpt}
"""`;
    try {
      const raw = await ask(SYS, userPrompt);
      const { verdict, reason, line } = parseVerdict(raw);
      console.log(`  → ${verdict}: ${reason.slice(0, 100)}`);
      results.push({
        ship: cand.ship_id,
        ship_name: cand.ship_name,
        video_id: cand.video_id,
        url,
        channel: cand.channel,
        transcript_chars: transcript.length,
        verdict,
        reason,
        raw: line,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  → ERROR: ${msg.slice(0, 120)}`);
      results.push({
        ship: cand.ship_id,
        ship_name: cand.ship_name,
        video_id: cand.video_id,
        url,
        channel: cand.channel,
        transcript_chars: transcript.length,
        verdict: "UNRELATED",
        reason: `validator-error: ${msg.slice(0, 100)}`,
        raw: msg,
      });
    }
  }
  writeFileSync(`${DATA}/transcript-validation.json`, JSON.stringify(results, null, 2));
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nwrote ${results.length} verdicts → data/transcript-validation.json`);
  console.log(`  VALIDATED:${counts.VALIDATED || 0} ADJACENT:${counts.ADJACENT || 0} UNRELATED:${counts.UNRELATED || 0}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
