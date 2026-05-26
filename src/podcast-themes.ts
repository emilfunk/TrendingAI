// src/podcast-themes.ts — "Hot in podcasts this month" theme extraction.
//
// Iter-32 deliverable from PROJECTS.md BUILD list. The features-confirmed view
// is event-driven (a lab shipped X, creators reacted). Podcasts discuss things
// that aren't single-launch events — model-quality vibes, governance shifts,
// ecosystem moves, infrastructure stories, founder takes. This script reads
// every YT podcast transcript on disk, asks Sonnet to surface the top themes
// being discussed across multiple podcasts that AREN'T already a confirmed
// feature, and writes data/podcast-themes.json. Rendered as a separate panel
// ABOVE the feature cards.
//
// Cost: ~$0.05-0.15 Sonnet via subscription ($0 marginal under Max plan).

import * as fs from "node:fs";
import { spawn } from "node:child_process";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const TIMEOUT_MS = 540_000;
const MAX_CHARS_PER_TRANSCRIPT = 700;
const CHUNK_SIZE = 25;
// iter-32 — final theme cap. Sonnet returns up to ~6 themes per chunk; merge
// can produce 15-18 distinct themes. Cap at MAX_THEMES (sorted by
// episode_count desc) so the rendered panel has a fixed visual shape.
// Iter-33+ display work can tune this without re-running Sonnet.
const MAX_THEMES = 12;

interface YTItem {
  url: string;
  title?: string;
  meta?: {
    author?: string;
    transcript?: string;
    transcript_status?: string;
    video_id?: string;
  };
  engagement?: number;
}

interface ConfirmedFeature {
  feature_id: string;
  title: string;
  entities: string[];
}

interface PodcastTheme {
  theme: string;
  summary: string;
  episode_count: number;
  episodes: { show: string; video_id: string; url: string; angle: string }[];
  why_not_already_feature: string;
}

interface ThemesOutput {
  generated_at: string;
  source_transcript_count: number;
  themes: PodcastTheme[];
}

function loadYouTubeWithTranscripts(): YTItem[] {
  const raw = JSON.parse(fs.readFileSync(`${DATA}/youtube.json`, "utf-8"));
  const arr: YTItem[] = Array.isArray(raw) ? raw : (raw.items ?? []);
  return arr.filter((it) => (it.meta?.transcript ?? "").length > 200);
}

function loadConfirmedFeatures(): ConfirmedFeature[] {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  } catch {
    return [];
  }
}

function extractShowName(it: YTItem): string {
  const m = (it.title ?? "").match(/^\[([^\]]+)\]/);
  if (m && m[1]) return m[1].trim();
  return it.meta?.author?.trim() ?? "unknown";
}

function extractVideoId(it: YTItem): string {
  if (it.meta?.video_id) return it.meta.video_id;
  const m = (it.url ?? "").match(/[?&]v=([A-Za-z0-9_-]{6,})/) || (it.url ?? "").match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? "";
}

function cleanTitle(it: YTItem): string {
  return (it.title ?? "").replace(/^\[[^\]]+\]\s*/, "").trim();
}

const SYS = `You are an editorial analyst surveying AI-industry podcast content. Your job is to identify themes that podcasts are actively discussing this cycle that ARE NOT already a single named lab feature launch — the broader narratives, the vibes, the governance moves, the contested takes, the ecosystem shifts.

Output strict JSON only, no prose preamble. Schema:

{
  "themes": [
    {
      "theme": "short title (3-8 words)",
      "summary": "2-3 sentence editorial summary of what the theme is — name the substance, name what's being argued, name who is taking what position. NOT 'AI is changing'. Specific.",
      "episodes": [
        { "show": "<show name>", "video_id": "<video_id from header>", "url": "<URL from header>", "angle": "one-line (max 25 words) what THIS show argued about THIS theme" }
      ],
      "why_not_already_feature": "one-line (max 25 words) explaining why this is a podcast-discourse theme rather than a feature launch — e.g. 'governance debate, not a product ship' or 'model-quality vibes accumulating across labs, not one launch'"
    }
  ]
}

Rules:

[selection]
- Surface 5-8 themes that are discussed by 2+ DIFFERENT podcasts in the supplied set. Cross-podcast convergence IS the signal.
- A theme can be a contested take, a governance/policy debate, a vibe ("Claude has gotten worse for coding"), an ecosystem trend ("enterprises are consolidating on one provider"), or a founder/industry move ("Anthropic-AWS deepening"). Anything BUT a single feature launch.
- EXCLUDE themes that are essentially one named feature launch (those belong in the features view, not the podcast panel). If a theme is really "Opus 4.7 was discussed on X podcasts," that's NOT a podcast-discourse theme; that's a feature with podcast coverage.

[grounding]
- Each theme MUST cite ≥2 podcasts that actually discussed it (episodes array length ≥2).
- The "angle" per episode names the SPECIFIC argument that show made — not generic "they discussed AI safety". If show A and show B disagree, capture that.
- video_id and url come exactly from the [V] header on each transcript snippet — use them verbatim.

[voice]
- Editorial, blunt, not consultant-speak. Use the actual mechanism words ("released", "moved to", "started", "stopped") not "shifted toward" or "is exploring".
- Name names. Name positions. Name disagreements. "Lenny argued X, Latent Space pushed back Y" beats "podcasts debated X".

[output discipline]
- 5-8 themes maximum. Fewer is fine if the pool genuinely doesn't support more.
- Empty themes array is acceptable if NONE of the supplied transcripts show cross-podcast convergence above the noise floor.
- Never invent shows, video_ids, or angles. Use only what's in the supplied transcripts.

[ANTI-AI-TROPE — every string field above is bound by these. Reader is a builder, not a magazine subscriber.]
- Direct, clinical, necessary. Sentence-or-paragraph as content demands; nothing more, nothing less.
- Forbidden openers: "Let's dive in", "Let's explore", "Here's the thing", "It's worth noting that", "I'd be happy to".
- Forbidden hedges: "notably", "particularly", "remarkably", "essentially", "fundamentally", "ultimately", "arguably", "crucially", "indeed", "importantly", "in essence", "at its core".
- Forbidden hype: "fascinating", "exciting", "game-changer", "revolutionary", "paradigm shift".
- Forbidden closers: "In conclusion", "To summarize", "Overall this is", "I hope this helps".
- Forbidden rhetorical reflexes: "Not just X — Y", "Not X. Y.", "The cool part?".
- Forbidden abstractions: "represents a shift", "represents a fundamental", "marks a significant".
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, added, removed, adopted by.
- Em-dash as a soft pause is forbidden. Use a period instead.`;

function buildPrompt(items: YTItem[], confirmedFeatures: ConfirmedFeature[]): string {
  const featureList = confirmedFeatures
    .map((f) => `  - ${f.title} (entities: ${f.entities.join(", ")})`)
    .join("\n");
  const transcriptsBlock = items
    .map((it, i) => {
      const show = extractShowName(it);
      const videoId = extractVideoId(it);
      const title = cleanTitle(it);
      const transcript = (it.meta?.transcript ?? "").slice(0, MAX_CHARS_PER_TRANSCRIPT);
      return `[V] show="${show}" video_id=${videoId} url=${it.url}\nTitle: ${title}\nTranscript (first ${MAX_CHARS_PER_TRANSCRIPT} chars):\n${transcript}`;
    })
    .join("\n\n---\n\n");
  return `${items.length} podcast transcripts below. Each is a [V]-headed block with show name, video_id, url, episode title, and the first ${MAX_CHARS_PER_TRANSCRIPT} chars of transcript content.

Already-confirmed features (do NOT propose these as podcast-themes — they're already covered in the features view):
${featureList}

${transcriptsBlock}

Identify 5-8 themes discussed across 2+ podcasts that are NOT just one of the confirmed features. Apply all rules above. Return JSON only.`;
}

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
        "--level",
        "standard",
        "--timeout",
        String(TIMEOUT_MS),
        systemPrompt,
        userPrompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS + 5_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
      resolve(out.trim());
    });
  });
}

function parseJson(raw: string): { themes?: PodcastTheme[] } | null {
  let trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/);
  if (fence) trimmed = fence[1]!;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

// Theme normalization key — collapse near-duplicates from different chunks.
function themeKey(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").split(/\s+/).filter((w) => w.length > 3).sort().join(" ");
}

function mergeThemes(allChunks: PodcastTheme[][]): PodcastTheme[] {
  const byKey = new Map<string, PodcastTheme>();
  for (const chunk of allChunks) {
    for (const t of chunk) {
      const key = themeKey(t.theme);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...t, episode_count: (t.episodes ?? []).length });
      } else {
        // Merge episodes; keep first-seen summary + why_not_already_feature
        const seenUrls = new Set(existing.episodes.map((e) => e.url));
        for (const ep of t.episodes ?? []) {
          if (!seenUrls.has(ep.url)) existing.episodes.push(ep);
        }
        existing.episode_count = existing.episodes.length;
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.episode_count - a.episode_count)
    .slice(0, MAX_THEMES);
}

async function main(): Promise<void> {
  const items = loadYouTubeWithTranscripts();
  const features = loadConfirmedFeatures();
  console.log(`podcast-themes: ${items.length} YT items with transcripts, ${features.length} confirmed features`);

  if (items.length === 0) {
    console.warn("no podcast transcripts found — writing empty themes file");
    fs.writeFileSync(
      `${DATA}/podcast-themes.json`,
      JSON.stringify({ generated_at: new Date().toISOString(), source_transcript_count: 0, themes: [] }, null, 2),
    );
    return;
  }

  // Chunk items into batches of CHUNK_SIZE — single 81k-prompt timed out at
  // 300s on iter-32 first attempt. Chunked calls stay under the timeout
  // ceiling AND can run concurrently. Themes are merged across chunks by
  // normalized key so a theme discussed in 2+ chunks aggregates correctly.
  const chunks: YTItem[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }
  console.log(`chunked into ${chunks.length} batches of ≤${CHUNK_SIZE}`);

  const chunkResults: PodcastTheme[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const prompt = buildPrompt(chunk, features);
    console.log(`  chunk ${i + 1}/${chunks.length} — ${chunk.length} items, ${Math.round(prompt.length / 1000)}k chars`);
    try {
      const raw = await ask(SYS, prompt);
      const parsed = parseJson(raw);
      if (!parsed) {
        console.error(`  chunk ${i + 1}: unparseable Sonnet output. Raw head:\n`, raw.slice(0, 300));
        continue;
      }
      const themes = (parsed.themes ?? []) as PodcastTheme[];
      chunkResults.push(themes);
      console.log(`  chunk ${i + 1}: ${themes.length} themes`);
    } catch (e) {
      console.error(`  chunk ${i + 1}: Sonnet call failed:`, (e as Error).message);
      // Continue — one chunk failure doesn't kill the run
    }
  }

  const merged = mergeThemes(chunkResults);
  const output: ThemesOutput = {
    generated_at: new Date().toISOString(),
    source_transcript_count: items.length,
    themes: merged,
  };
  fs.writeFileSync(`${DATA}/podcast-themes.json`, JSON.stringify(output, null, 2));
  console.log(`wrote data/podcast-themes.json — ${merged.length} merged themes from ${chunkResults.length} chunks`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
