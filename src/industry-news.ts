// src/industry-news.ts — iter-41 podcast → industry-news event extraction.
//
// Closes the iter-40 structural gap: renderIndustryNewsLens used to filter the
// features-confirmed.json pool via substrate-regex on title (pricing / policy /
// access-change keywords). That pool is product-shaped — slash-commands,
// versioned model names, distinctive proper nouns extracted from lab blog
// posts + lab X. News events (legal docket, exec changes, compute deals,
// regulatory moves, security incidents, AI-doom narrative shifts) are NOT
// products — they never become candidates in features-first.ts. Result:
// Industry News was ~80 percent feature-card-double-counts plus a substrate
// PR-cover tweet.
//
// This script reads every YT podcast transcript on disk, asks Sonnet to
// surface news events covered across the corpus, de-dups hard against
// features-confirmed.json (a logged drop per skip, Kem-ratified "aggressive
// as long as we don't lose anything by accident"), aggregates multi-show
// coverage as signal-strength, and writes data/industry-news.json. The
// renderer reads from that file. Pipeline-architecture pattern mirrors
// src/podcast-themes.ts exactly so doctrine carries forward.
//
// Cost: ~$0.05-0.15 Sonnet via subscription ($0 marginal under Max plan).
//
// Per Kem walk 2026-05-17: trimmed snippets (1100c each in youtube.json) are
// sufficient — proof-of-concept manual sweep on exactly that data surfaced
// Elon-OpenAI lawsuit, SpaceX-Anthropic compute, Trump-Xi summit, AI doom
// narrative, security armageddon, Bun acquisition, AI-runs-a-store — every
// big story he expected. No need to escalate to full VTT.

import * as fs from "node:fs";
import { spawn } from "node:child_process";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const TIMEOUT_MS = 540_000;
const MAX_CHARS_PER_TRANSCRIPT = 900;
const CHUNK_SIZE = 15;
const MAX_EVENTS = 14;
// iter-41b: chunked extraction + Sonnet semantic merger.
// Iter-41a single-prompt mode TIMED OUT at 540s on 64KB prompt (too slow at
// this corpus size). Reverted. Architecture now: 3 chunks of 25 transcripts
// → 3 Sonnet extraction calls → 4th Sonnet call MERGES same-event-different-
// framings across chunks (Elon-OpenAI lawsuit case where chunk 1 said "Musk
// lawsuit" and chunk 2 said "OpenAI vs Musk trial" but word-sort eventKey
// failed to merge them). Cheap, structural, fixes the cross-chunk blindness.

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

interface EventExcerpt {
  show: string;
  video_id: string;
  url: string;
  quote: string;
}

interface IndustryNewsEvent {
  key: string;
  headline: string;
  category: "legal" | "executive" | "compute" | "regulatory" | "product-policy" | "funding" | "security" | "narrative" | "geopolitics";
  context: string;
  labs_involved: string[];
  shows: string[];
  episode_count: number;
  coverage_sentiment: "consensus" | "contested" | "skeptical" | "celebratory" | "neutral";
  excerpts: EventExcerpt[];
}

interface DropRecord {
  candidate_headline: string;
  matched_feature_title: string;
  matched_feature_id: string;
  reason: "headline-substring" | "entity-substring";
}

interface IndustryNewsOutput {
  generated_at: string;
  source_transcript_count: number;
  events: IndustryNewsEvent[];
  dropped: DropRecord[];
  pipeline_stats: {
    chunks_run: number;
    chunks_failed: number;
    raw_events_extracted: number;
    events_after_dedup: number;
    events_after_aggregation: number;
  };
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

const SYS = `You are an editorial analyst surveying AI-industry podcast content for NEWS EVENTS the corpus is actively discussing this cycle.

A news event is a specific WHAT-HAPPENED in the AI industry — a legal filing, an executive change, a compute partnership, a regulatory move, a product-policy decision affecting access/pricing/terms, a funding round, a security incident, a geopolitical move involving AI, OR a clear narrative-state change ("the AI doom narrative is cracking" backed by multi-show convergence). It is NOT a single product feature launch. It is NOT generic philosophical discussion.

Output strict JSON only, no prose preamble. Schema:

{
  "events": [
    {
      "headline": "8-16 words naming the specific WHAT-HAPPENED (verb-led when possible). 'OpenAI sues former employee Elon Musk' not 'OpenAI legal news'.",
      "category": "legal | executive | compute | regulatory | product-policy | funding | security | narrative | geopolitics",
      "context": "2-3 sentence editorial explanation of what the event IS — the substance, the labs/people involved, why it matters. NOT vague. Specific actors, specific stakes.",
      "labs_involved": ["Anthropic", "OpenAI", "xAI", "Google", "Meta", "etc — empty array if no specific lab"],
      "excerpts": [
        { "show": "<show name from V header>", "video_id": "<video_id from V header>", "url": "<URL from V header>", "quote": "1-2 sentences verbatim from the transcript window naming this event. Must be a real substring of the supplied transcript content." }
      ],
      "coverage_sentiment": "consensus | contested | skeptical | celebratory | neutral — what's the overall tone across the shows that covered it"
    }
  ]
}

Rules:

[selection]
- Surface 5-10 substantive news events from THIS chunk of transcripts. Even single-show coverage is acceptable here — a downstream merger pass combines events from other chunks.
- Strong yes: Elon-OpenAI lawsuit, SpaceX-Anthropic compute deal, Trump-Xi summit on AI, OpenAI strategic reset, Anthropic Agent SDK monetization change, AI Doom narrative cracking, TanStack supply chain attack, Bun acquired by Anthropic, prediction-market scandals.
- Strong no: "the future of work" generic riff, "AI is changing things" without a named event, an interview where someone just describes their company.
- EXCLUDE events that are essentially one named lab product launch already in the features set. The features view covers those; this view is for news around the products.

[grounding]
- Each event MUST cite ≥1 verbatim excerpt from the transcript window (excerpts array length ≥1). Single-show is fine — merger downstream will aggregate.
- Each excerpt quote MUST be a verbatim or near-verbatim substring of the supplied transcript content. Fabricated quotes are a catastrophic failure.
- video_id, url, and show come exactly from the [V] header on each transcript snippet — use them verbatim.
- labs_involved names actual organizations the event implicates — Anthropic / OpenAI / xAI / Google / Meta / Microsoft / NVIDIA / etc. Empty array OK for events that aren't lab-specific (Trump-Xi, prediction-market regulation, supply-chain attack).

[voice]
- Editorial, blunt, not consultant-speak.
- Name names. Name positions. Name disagreements.

[output discipline]
- 5-10 events maximum. Fewer is fine if the pool genuinely doesn't support more.
- Empty events array is acceptable if NONE of the supplied transcripts show cross-show convergence above the noise floor.
- Never invent shows, video_ids, urls, quotes, or labs. Use only what's in the supplied transcripts.

[ANTI-AI-TROPE — every string field above is bound by these. Reader is a builder, not a magazine subscriber.]
- Direct, clinical, necessary.
- Forbidden openers: "Let's dive in", "Let's explore", "Here's the thing", "It's worth noting that", "I'd be happy to".
- Forbidden hedges: "notably", "particularly", "remarkably", "essentially", "fundamentally", "ultimately", "arguably", "crucially", "indeed", "importantly", "in essence", "at its core".
- Forbidden hype: "fascinating", "exciting", "game-changer", "revolutionary", "paradigm shift".
- Forbidden closers: "In conclusion", "To summarize", "Overall this is".
- Forbidden rhetorical reflexes: "Not just X — Y", "Not X. Y.", "The cool part?".
- Forbidden abstractions: "represents a shift", "represents a fundamental", "marks a significant".
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, added, removed, adopted by, sued, acquired, partnered, restricted, opened, regulated.
- Em-dash as a soft pause is forbidden. Use a period instead.`;

function buildPrompt(items: YTItem[]): string {
  const transcriptsBlock = items
    .map((it) => {
      const show = extractShowName(it);
      const videoId = extractVideoId(it);
      const title = cleanTitle(it);
      const transcript = (it.meta?.transcript ?? "").slice(0, MAX_CHARS_PER_TRANSCRIPT);
      return `[V] show="${show}" video_id=${videoId} url=${it.url}\nTitle: ${title}\nTranscript (first ${MAX_CHARS_PER_TRANSCRIPT} chars):\n${transcript}`;
    })
    .join("\n\n---\n\n");
  return `${items.length} podcast transcripts below. Each is a [V]-headed block with show name, video_id, url, episode title, and the first ${MAX_CHARS_PER_TRANSCRIPT} chars of transcript content.

${transcriptsBlock}

Identify 5-10 news events covered across 2+ shows. Apply all rules above. Return JSON only.`;
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

interface RawEvent {
  headline: string;
  category: IndustryNewsEvent["category"];
  context: string;
  labs_involved?: string[];
  excerpts?: EventExcerpt[];
  coverage_sentiment?: IndustryNewsEvent["coverage_sentiment"];
}

function parseJson(raw: string): { events?: RawEvent[] } | null {
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

// Canonical event key — collapse near-duplicates from different chunks.
// Same logic as podcast-themes themeKey. Single-source primitive would be
// ideal but cross-file extraction is out of iter-41 scope; if iter-42 wants
// to extract, the test surface here matches podcast-themes exactly.
function eventKey(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .join(" ");
}

// Normalize a feature title for substring matching — strip [Show] prefix,
// @handle prefix, lowercase, collapse whitespace.
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@\w+:\s*/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Hard de-dup: any candidate event whose normalized headline contains
// (or is contained in) a normalized feature title is DROPPED and logged.
// Same check against entity strings. Kem-ratified "aggressive as long as
// we don't lose anything by accident" — every drop surfaces in `dropped[]`
// for transparency.
function dedupAgainstFeatures(
  rawEvents: RawEvent[],
  features: ConfirmedFeature[],
): { kept: RawEvent[]; dropped: DropRecord[] } {
  const kept: RawEvent[] = [];
  const dropped: DropRecord[] = [];
  for (const e of rawEvents) {
    const normHeadline = normalizeForMatch(e.headline);
    let matched: { f: ConfirmedFeature; reason: DropRecord["reason"] } | null = null;
    for (const f of features) {
      const normFeatureTitle = normalizeForMatch(f.title);
      // Length gate prevents tiny generic matches ("AI", "open") from
      // dropping legitimate news events. 6 chars catches "OpenAI", "MCP-X",
      // "Opus 4" while letting short event headlines pass.
      if (normFeatureTitle.length >= 6 && normHeadline.includes(normFeatureTitle)) {
        matched = { f, reason: "headline-substring" };
        break;
      }
      for (const ent of f.entities ?? []) {
        const normEnt = ent.toLowerCase().trim();
        if (normEnt.length >= 5 && normHeadline.includes(normEnt)) {
          matched = { f, reason: "entity-substring" };
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      dropped.push({
        candidate_headline: e.headline,
        matched_feature_title: matched.f.title,
        matched_feature_id: matched.f.feature_id,
        reason: matched.reason,
      });
    } else {
      kept.push(e);
    }
  }
  return { kept, dropped };
}

// Aggregate events across chunks by canonical key. Merge shows + excerpts,
// keep first-seen headline/context/category/sentiment (Sonnet's first call
// gets first-say; if iter-42 sees this needs refining, vote or quality-rank).
function aggregateEvents(allChunks: RawEvent[][]): IndustryNewsEvent[] {
  const byKey = new Map<string, IndustryNewsEvent>();
  for (const chunk of allChunks) {
    for (const e of chunk) {
      const key = eventKey(e.headline);
      if (!key) continue;
      const excerpts = (e.excerpts ?? []).filter((x) => x.quote && x.show);
      const existing = byKey.get(key);
      if (!existing) {
        const shows = [...new Set(excerpts.map((x) => x.show))];
        byKey.set(key, {
          key,
          headline: e.headline,
          category: e.category,
          context: e.context,
          labs_involved: e.labs_involved ?? [],
          shows,
          episode_count: excerpts.length,
          coverage_sentiment: e.coverage_sentiment ?? "neutral",
          excerpts,
        });
      } else {
        const seenUrls = new Set(existing.excerpts.map((x) => x.url));
        for (const x of excerpts) {
          if (!seenUrls.has(x.url)) {
            existing.excerpts.push(x);
            seenUrls.add(x.url);
          }
        }
        existing.shows = [...new Set(existing.excerpts.map((x) => x.show))];
        existing.episode_count = existing.excerpts.length;
      }
    }
  }
  // Sort by multi-show count first (stronger signal), then episode_count.
  return [...byKey.values()]
    .sort((a, b) => {
      const showDiff = b.shows.length - a.shows.length;
      if (showDiff !== 0) return showDiff;
      return b.episode_count - a.episode_count;
    })
    .filter((e) => e.shows.length >= 2)
    .slice(0, MAX_EVENTS);
}

// iter-41b SONNET MERGER PASS. Takes the post-de-dup raw events from all
// chunks, asks Sonnet to semantically merge same-event-different-framings
// into one merged event with combined excerpts + shows + episode_count.
// Closes the cross-chunk blindness: chunk 1's "Elon Musk lawsuit" and
// chunk 2's "OpenAI vs Musk trial" become ONE merged event.
const MERGER_SYS = `You are an editorial analyst MERGING duplicate news events that were extracted from different chunks of the same podcast corpus.

You will receive a list of raw event extractions. Each one has a headline + category + context + labs_involved + excerpts (with show, video_id, url, quote).

Your job: identify which raw extractions describe the SAME underlying news event under different headlines, and merge them into ONE event with the combined excerpts.

Example merger:
- Input: { headline: "Elon Musk lawsuit against OpenAI", excerpts: [{show:"Hard Fork", ...}] }
- Input: { headline: "OpenAI vs Musk trial enters witness phase", excerpts: [{show:"AI Daily Brief", ...}] }
- Output: ONE event with headline like "Elon Musk vs OpenAI trial enters witness-stand phase" and BOTH excerpts merged.

Output strict JSON only, no prose preamble. Schema:

{
  "events": [
    {
      "headline": "best canonical headline (8-16 words, verb-led)",
      "category": "legal | executive | compute | regulatory | product-policy | funding | security | narrative | geopolitics",
      "context": "merged 2-3 sentence editorial context from all input contexts",
      "labs_involved": ["union of all labs from merged inputs"],
      "shows": ["distinct list of show names across merged excerpts"],
      "episode_count": <number of distinct excerpts after merge>,
      "coverage_sentiment": "consensus | contested | skeptical | celebratory | neutral",
      "excerpts": [{ "show": "<...>", "video_id": "<...>", "url": "<...>", "quote": "<verbatim from input>" }]
    }
  ]
}

Rules:
- Recognize underlying events even when headlines differ surface-form. Look at: lab names + people named + topic + context.
- An event mentioned in only ONE input is fine — output it as a single-input event (it'll be filtered downstream if it doesn't pass the multi-show ≥2 threshold).
- An event mentioned across N inputs MUST be merged into ONE output event with all N excerpts combined.
- Keep all excerpts verbatim — do not modify quote text.
- Choose the most canonical (clearest, most informative) headline from the input headlines.
- Do not invent excerpts, shows, video_ids, urls, or quotes that aren't in the input.
- Keep all categories as-is (use the most appropriate category if inputs disagree).
- Output 1-15 merged events maximum.

[ANTI-AI-TROPE]
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, sued, acquired, partnered, restricted, opened, regulated.
- Editorial, blunt, name names. No hedges ("notably", "particularly", etc.). No hype ("fascinating", "revolutionary"). No closers ("In conclusion", "Overall").
- Em-dash as a soft pause is forbidden. Use a period.`;

function buildMergerPrompt(rawEvents: RawEvent[]): string {
  const block = rawEvents
    .map((e, i) => {
      const excerpts = (e.excerpts ?? []).map((x) => `    - show=${x.show} video_id=${x.video_id} url=${x.url} quote="${x.quote.replace(/"/g, "'")}"`).join("\n");
      return `[INPUT-${i + 1}]
headline: ${e.headline}
category: ${e.category}
context: ${e.context}
labs: ${(e.labs_involved ?? []).join(", ")}
coverage_sentiment: ${e.coverage_sentiment ?? "neutral"}
excerpts:
${excerpts}`;
    })
    .join("\n\n---\n\n");
  return `${rawEvents.length} raw event extractions below from 3 chunks of podcast transcripts. Merge same-event-different-framings into ONE event with combined excerpts. Return JSON only.

${block}`;
}

async function runMergerPass(rawEvents: RawEvent[]): Promise<IndustryNewsEvent[]> {
  const prompt = buildMergerPrompt(rawEvents);
  console.log(`  merger prompt: ${Math.round(prompt.length / 1000)}k chars`);
  const raw = await ask(MERGER_SYS, prompt);
  const parsed = parseJson(raw);
  if (!parsed || !parsed.events) {
    throw new Error("merger pass returned unparseable JSON");
  }
  // Reshape parsed events to IndustryNewsEvent (add eventKey)
  return (parsed.events as IndustryNewsEvent[]).map((e) => ({
    key: eventKey(e.headline),
    headline: e.headline,
    category: e.category,
    context: e.context,
    labs_involved: e.labs_involved ?? [],
    shows: [...new Set((e.excerpts ?? []).map((x) => x.show))],
    episode_count: (e.excerpts ?? []).length,
    coverage_sentiment: e.coverage_sentiment ?? "neutral",
    excerpts: e.excerpts ?? [],
  }));
}

async function main(): Promise<void> {
  const items = loadYouTubeWithTranscripts();
  const features = loadConfirmedFeatures();
  console.log(`industry-news: ${items.length} YT items with transcripts, ${features.length} confirmed features`);

  if (items.length === 0) {
    console.warn("no podcast transcripts found — writing empty industry-news file");
    fs.writeFileSync(
      `${DATA}/industry-news.json`,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          source_transcript_count: 0,
          events: [],
          dropped: [],
          pipeline_stats: {
            chunks_run: 0,
            chunks_failed: 0,
            raw_events_extracted: 0,
            events_after_dedup: 0,
            events_after_aggregation: 0,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  // iter-41b: chunked extraction (parallel via Promise.all), then Sonnet merger.
  // PARALLEL fires all chunk Sonnet calls concurrently. Total wall-clock =
  // slowest chunk, not sum of all. If one chunk times out, others still complete
  // independently — no sequential cascade.
  const chunks: YTItem[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }
  console.log(`chunked into ${chunks.length} batches of ≤${CHUNK_SIZE} (PARALLEL)`);

  // Pre-warm: 1-line throwaway call to warm OAuth + Sonnet model before parallel fires.
  // Closes the cold-start cost that's been killing chunk 1 of every sequential run.
  console.log(`pre-warming Sonnet...`);
  try {
    await ask("Respond with the single word: ok.", "ping");
    console.log(`pre-warm: ok`);
  } catch (e) {
    console.warn(`pre-warm failed (continuing):`, (e as Error).message);
  }

  const chunkPromises = chunks.map(async (chunk, i) => {
    const prompt = buildPrompt(chunk);
    console.log(`  chunk ${i + 1}/${chunks.length} — ${chunk.length} items, ${Math.round(prompt.length / 1000)}k chars [parallel]`);
    try {
      const raw = await ask(SYS, prompt);
      const parsed = parseJson(raw);
      if (!parsed) {
        console.error(`  chunk ${i + 1}: unparseable Sonnet output. Raw head:\n`, raw.slice(0, 300));
        return { events: [] as RawEvent[], failed: true };
      }
      const events = (parsed.events ?? []) as RawEvent[];
      console.log(`  chunk ${i + 1}: ${events.length} events`);
      return { events, failed: false };
    } catch (e) {
      console.error(`  chunk ${i + 1}: Sonnet call failed:`, (e as Error).message);
      return { events: [] as RawEvent[], failed: true };
    }
  });
  const settled = await Promise.all(chunkPromises);
  const chunkResults: RawEvent[][] = settled.map((s) => s.events);
  const chunksFailed = settled.filter((s) => s.failed).length;
  console.log(`parallel done: ${chunks.length - chunksFailed}/${chunks.length} chunks succeeded`);

  const rawCount = chunkResults.reduce((acc, c) => acc + c.length, 0);

  // De-dup against features-confirmed BEFORE merger
  const dedupResults = chunkResults.map((chunk) => dedupAgainstFeatures(chunk, features));
  const keptChunks = dedupResults.map((r) => r.kept);
  const allDropped = dedupResults.flatMap((r) => r.dropped);
  const keptCount = keptChunks.reduce((acc, c) => acc + c.length, 0);
  const allKept = keptChunks.flat();
  console.log(`de-dup: kept ${keptCount} / ${rawCount} (dropped ${allDropped.length} as feature-overlaps)`);

  // iter-41b SONNET MERGER PASS: takes ALL kept raw events from all chunks,
  // asks Sonnet to semantically group same-event-different-framings into
  // merged events. Closes cross-chunk blindness ("Musk lawsuit" in chunk 1
  // + "OpenAI vs Musk trial" in chunk 2 = SAME event after merger).
  let events: IndustryNewsEvent[] = [];
  if (allKept.length > 0) {
    console.log(`merger: asking Sonnet to semantically group ${allKept.length} raw events`);
    try {
      const mergedRaw = await runMergerPass(allKept);
      console.log(`merger: returned ${mergedRaw.length} merged events`);
      // Apply final filter: shows.length >= 2 (multi-show signal floor)
      events = mergedRaw
        .filter((e) => e.shows.length >= 2)
        .sort((a, b) => {
          const showDiff = b.shows.length - a.shows.length;
          if (showDiff !== 0) return showDiff;
          return b.episode_count - a.episode_count;
        })
        .slice(0, MAX_EVENTS);
      console.log(`merger: ${events.length} events after multi-show filter`);
    } catch (e) {
      console.error(`merger: Sonnet call failed, falling back to deterministic aggregateEvents:`, (e as Error).message);
      events = aggregateEvents(keptChunks);
    }
  }

  const output: IndustryNewsOutput = {
    generated_at: new Date().toISOString(),
    source_transcript_count: items.length,
    events,
    dropped: allDropped,
    pipeline_stats: {
      chunks_run: chunks.length,
      chunks_failed: chunksFailed,
      raw_events_extracted: rawCount,
      events_after_dedup: keptCount,
      events_after_aggregation: events.length,
    },
  };
  fs.writeFileSync(`${DATA}/industry-news.json`, JSON.stringify(output, null, 2));
  console.log(
    `wrote data/industry-news.json — ${events.length} events from ${rawCount} raw extractions (${allDropped.length} dropped by de-dup, ${chunksFailed}/${chunks.length} chunks failed)`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
