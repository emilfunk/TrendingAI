// src/feature-sentiment.ts — per-feature voice-of-creator extraction.
//
// Kem (2026-05-16): "If you'd actually read the transcripts, actually read what's
// being said, you have a very different picture. You're just not doing the work."
// True. Substring match + render is NOT the work. This script reads the actual
// creator content per feature and asks Haiku to extract:
//   - overall sentiment direction (positive / mixed / negative / complaint-dominant)
//   - top 3 things people are praising
//   - top 3 things people are complaining about
//   - 3 notable verbatim quotes (with author)
//   - one-sentence summary
// Output → data/feature-sentiment.json keyed by feature_id.

import * as fs from "node:fs";
import { spawn } from "node:child_process";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
// D-WALK-2 (iter-29) raised TIMEOUT_MS 180_000 → 300_000. The Wave 2 prompt
// adds per-item cited_items_why captions (one per supplied item, up to 25)
// and 0-2 counter_narratives sentences — meaningfully more output tokens than
// the iter-28 schema. Features with 30+ creators (MCP, Opus 4.7) timed out
// at 180s on iter-29 first run. 300s = ~5 min hard cap matches Sonnet's
// observed tail behavior for the heaviest single-call output.
// iter-32 — bumped 300s → 480s. Opus 4.7 (34 creators, 25 prompt items, biggest
// per-feature payload) timed out at 300s on iter-32 first pass with the
// creator_recommendation schema extension (additional output tokens). 480s
// keeps a comfortable margin for the heaviest features without blocking the
// concurrency=3 pool on shorter calls.
const TIMEOUT_MS = 480_000;
const CONCURRENCY = 3;
const MAX_RESPONSE_ITEMS_PER_FEATURE = 25;
const MAX_CHARS_PER_ITEM = 600;

interface ResponseItem {
  source: string;
  author: string;
  url: string;
  title: string;
  match_in: "title" | "raw_text" | "transcript";
  matched_entity: string;
  engagement: number;
}

interface ConfirmedFeature {
  feature_id: string;
  lab: string;
  title: string;
  url: string;
  ts: string;
  entities: string[];
  responses: ResponseItem[];
  distinct_platforms: number;
  distinct_creators: number;
  podcast_mentions: number;
  score: number;
}

interface SourceItem {
  title: string;
  url: string;
  raw_text?: string;
  meta?: { author?: string; transcript?: string };
}

interface SentimentRow {
  feature_id: string;
  feature_title: string;
  sample_size: number;
  overall_sentiment: "positive" | "mixed" | "negative" | "complaint-dominant" | "unclear";
  summary_sentence: string;
  praises: string[];
  complaints: string[];
  notable_quotes: { author: string; source: string; quote: string }[];
  // D9/D10 + S6 — dominant_pattern is the editorial frame the report renders.
  // Sonnet picks from {tutorial-hype | adoption | complaint | news | meta}
  // using the deterministic regex-based hype-count as ground truth (per
  // ISC-375), not free-form classification. Stable across runs.
  dominant_pattern?: "tutorial-hype" | "adoption" | "complaint" | "news" | "meta";
  // D11/D12 — one synth_line per YT podcast item with transcript. Generated
  // in the same Sonnet pass as the per-feature sentiment. Renderer prepends
  // as italic-serif lede above each transcript window.
  podcast_synth?: { video_id: string; show_name: string; synth_line: string }[];
  // D6/D7 — populated by the SECOND cross-narrative Sonnet pass after all
  // per-feature sentiments land. Empty = this feature isn't part of any
  // substrate narrative; non-empty = render the substrate-narrative tag for
  // each listed narrative_id below the per-feature summary.
  cross_narrative_ids?: string[];
  // D-WALK-2 (iter-29 Wave 2) — per-item WHY-THIS-ITEM justification. Map
  // from response URL → one-line caption explaining why the item is on this
  // card. Items Sonnet cannot justify are omitted from this map; the renderer
  // hides the item entirely (drop-on-unjustifiable per ISC-381) so the
  // "I don't see the relationship" defect class never reaches the reader.
  cited_items_why?: Record<string, string>;
  // D-WALK-6 (iter-29 Wave 2) — counter-narratives surfaced from this
  // feature's own reply pool when high-engagement negative replies cite a
  // competitor lab having already shipped the same capability. Short
  // sentences, max 30 words each. Rendered as a "↩ COUNTER NARRATIVE" tag
  // line on the card. Empty when no counter-narrative is present.
  counter_narratives?: string[];
  // iter-32 creator-decision-support (per ISA Principle v6.5). The reader is
  // a content-creator deciding what to make next. Sonnet writes one specific
  // recommendation per feature, grounded in THIS feature's actual sentiment +
  // complaints + counter-narrative state — never generic "make a tutorial."
  // Absent / null = Sonnet couldn't honestly recommend anything (out of pool).
  creator_recommendation?: {
    angle: string;
    format: "tutorial" | "opinion" | "demo" | "explainer" | "reaction" | "comparison" | "post-mortem";
    hook: string;
  } | null;
  error?: string;
}

interface CrossNarrative {
  narrative_id: string;
  theme: string;
  implicated_feature_ids: string[];
  substrate_sentence: string;
  confidence: "high" | "med" | "low";
}

// S6/ISC-375 — Deterministic tutorial-hype indicator patterns. Sonnet does
// NOT classify hype free-form; this regex set scores every item 0/1 per
// indicator, Sonnet receives the totals and picks the dominant_pattern from
// pre-computed counts. Stable across runs.
const TUTORIAL_HYPE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "save-this", re: /\b(save this|bookmark this|send to your team|share with your team)\b/i },
  { name: "thread-cta", re: /\b(thread|🧵|🪡)\b/i },
  { name: "only-x-you-need", re: /\b(the only|only \d+|the (?:complete|definitive|ultimate)) [a-z]+ you (?:need|will ever need)\b/i },
  { name: "commands-tutorial", re: /\b\d+ (?:claude|gpt|ai|prompts?|skills?|commands?|tools?|features?|hacks?|tips?|tricks?|things|ways)\b/i },
  { name: "numbered-list", re: /(?:^|\n)\s*\d+[\.\)]\s+[A-Z]/m },
  { name: "follow-cta", re: /\b(follow (?:me )?for more|like.{0,20}follow|comment ['"]?\w+['"]? and)\b/i },
  { name: "step-by-step", re: /\b(step[- ]by[- ]step|step \d+|here'?s how)\b/i },
  { name: "drop-cta", re: /\b(drop a (?:like|comment)|drop ["']?\w+["']? below)\b/i },
];

function tutorialHypeScore(text: string): { score: number; matched: string[] } {
  const matched: string[] = [];
  for (const p of TUTORIAL_HYPE_PATTERNS) {
    if (p.re.test(text)) matched.push(p.name);
  }
  return { score: matched.length, matched };
}

// Aggregate tutorial-hype across a feature's top items. >= 2 items with
// >= 2 indicators each = tutorial-hype dominant.
function aggregateTutorialHype(itemsText: string[]): { dominant: boolean; hyped_items: number; total_items: number } {
  let hyped = 0;
  for (const t of itemsText) {
    if (tutorialHypeScore(t).score >= 2) hyped += 1;
  }
  return { dominant: hyped >= 2 && hyped / Math.max(itemsText.length, 1) >= 0.4, hyped_items: hyped, total_items: itemsText.length };
}

function loadSource(name: string): SourceItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/${name}.json`, "utf-8"));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
}

function indexByUrl(items: SourceItem[]): Map<string, SourceItem> {
  const m = new Map<string, SourceItem>();
  for (const it of items) if (it.url) m.set(it.url, it);
  return m;
}

const SYS = `You are an editorial analyst synthesizing creator reactions to a single AI lab feature. Output strict JSON only, no prose preamble.

Schema:
{
  "overall_sentiment": "positive" | "mixed" | "negative" | "complaint-dominant" | "unclear",
  "dominant_pattern": "tutorial-hype" | "adoption" | "complaint" | "news" | "meta",
  "summary_sentence": "one analytical sentence (max 50 words) that names WHO is reacting and WHAT the substance is — not generic 'creators are split'",
  "praises": ["0-3 specific things people praise — quote distinctive language, not generic 'it's good'"],
  "complaints": ["0-3 specific things people complain about — quote distinctive language, not generic 'it's bad'"],
  "notable_quotes": [{"author": "@handle", "source": "x|tiktok|instagram|youtube", "quote": "verbatim 8-25 words from the item"}],
  "podcast_synth": [{"video_id": "<from item header>", "show_name": "<show name from header>", "synth_line": "one-sentence (max 30 words) what this podcast actually argued about THIS feature"}],
  "cited_items_why": { "<item URL exactly as in [N] header>": "one-line (max 20 words) explanation of WHY this specific item is relevant to THIS feature — what the author actually said/did about it" },
  "counter_narratives": ["0-2 short sentences (max 30 words each) naming a competitor-already-shipped pattern visible in this feature's own item pool — e.g. negative replies citing 'OpenAI Codex already has /goal'. Empty array when no such pattern is present."],
  "creator_recommendation": {
    "angle": "string — one-sentence (15-30 words) angle a content-creator could take that ISN'T already saturated in the current item pool; must be grounded in the actual sentiment / complaints / counter-narrative state, NEVER generic 'make a tutorial' or 'do an explainer'",
    "format": "string — exactly one of: tutorial, opinion, demo, explainer, reaction, comparison, post-mortem",
    "hook": "string — the opening line of that piece (8-20 words); voice-driven, specific, would actually land. NOT 'In this video we explore...' boilerplate"
  }
}

NOTE on creator_recommendation: this field is MANDATORY in every response. It is the editorial reason the reader (a content-creator) opened this report at all. If the item pool genuinely cannot support a grounded recommendation (sample too small AND all items off-topic AND no real signal), set the entire creator_recommendation value to JSON null — but null is the exception, not the default. Default disposition: emit a real recommendation per the rules below.

Synthesis rules — these matter:

[CRITICAL — call it for what it is]
- If the deterministic tutorial-hype counter (supplied below as HYPE-DOMINANT: yes/no with hyped_items/total_items) says HYPE-DOMINANT yes, you MUST set dominant_pattern="tutorial-hype" AND open summary_sentence with a blunt callout: "Two highest-engagement posts are tutorial-format hype threads by @X / @Y; this is creator-content-about-the-feature, not creator-adoption." Do NOT paraphrase as "creators are exploring." Spade-a-spade.
- If a top-engagement reply explicitly recommends a competitor OR signals churn ("switching to X", "ditching Claude", "X just released a free version", "use any-agent instead"), surface that in summary_sentence as the dominant signal — not buried in notable_quotes. Competitor-recommendation in a high-engagement reply is the story.
- A high-engagement post that is RATIOED in its replies (see [REPLY SIGNAL] line — pos_pct < 40% AND total >= 10) is contradiction, not endorsement. summary_sentence must name the gap: "@X's 130k post celebrates the feature, but its reply thread is 78% negative — the post is hype, the reception is critique."

[D-WALK-2 — WHY-THIS-ITEM justification, mandatory]
- For EVERY supplied item [N], emit a "cited_items_why" entry keyed by the item's URL with a one-line caption (max 20 words) naming WHY that specific item is on this feature card. The caption answers: "what did THIS author actually say/do about THIS feature?" — not a generic "discusses the feature."
- If you cannot honestly justify an item's relevance in one line (the item only tangentially mentions the matched entity, the author was talking about something else, the post is generic AI content), OMIT it from cited_items_why. Omitted items get DROPPED from the rendered card — better silent omission than fabricated relevance.
- Example: { "https://x.com/karpathy/status/...": "Karpathy proposes an alternative agent-loop architecture that doesn't use Claude Code, illustrating broader skepticism of the harness approach." } — not "Karpathy comments on the feature."

[D-WALK-6 — Lab-B-already-shipped counter-narrative, conditional]
- If high-engagement negative replies in the item pool cite a competitor lab having shipped the same capability earlier (e.g. negative replies on Anthropic's /goal noting "OpenAI Codex shipped /goal first," or replies on Claude Skills citing GPT custom-GPTs as prior art), surface this as a "counter_narratives" entry: a short sentence naming Lab B + the prior release + why it matters here.
- Genuine signal only — passing mentions of competitors don't count. The counter-narrative must be a substantive critique that the feature card would otherwise miss.
- Output empty array when no such pattern is visible.

[author-context]
- When a praise quote comes from an Anthropic/OpenAI/lab employee (handles like @bcherny, @sama, @AnthropicAI — flagged [LAB-AFFILIATED] in the item header), say so — that context changes the meaning of "creator praise."
- When a complaint is structural (model regression, performance failure, policy nerf), name the structural issue — don't paraphrase as generic "behavioral change."

[output]
- praises[] and complaints[] each have 0-3 entries. If creators aren't praising/complaining, output empty array — never fabricate.
- notable_quotes[] has 1-3 entries, each verbatim from the supplied items.
- podcast_synth[] has one entry per [PODCAST] tagged item in the supplied list. synth_line names WHAT the podcast argued about THIS feature specifically, not a general topic summary. If no [PODCAST] items, output empty array.
- cited_items_why is keyed by URL exactly as supplied in each item's [N] @author · source line (the supplied items each have a URL line below the body — use that exact string). Items you cannot justify are silently omitted.
- counter_narratives is 0-2 short sentences. Each must name a specific competitor + a specific prior shipment + why it matters here. Empty array if not applicable.

[iter-32 — creator_recommendation, mandatory unless honestly out-of-pool]
- The reader of this report IS a content-creator deciding what to make next about AI. creator_recommendation is the reason they opened this report instead of doom-scrolling X.
- The angle must reflect THIS feature's SPECIFIC state — what the existing item pool is MISSING. Examples of grounded angles:
  - For a RATIOED feature: "Side-by-side test of @theo's regression claim vs the lab's announcement demo — does the 130k-engagement post hold up?"
  - For a counter-narrative-active feature: "OpenAI Codex shipped /goal first — 5-min comparison of the two implementations and what each handles better."
  - For tutorial-hype-dominant: "Skip the 'save this thread' threads. 10-min substantive demo showing what the feature actually does in production."
  - For complaint-dominant: "Post-mortem on the June 15 policy change — what changed, who got affected, what the workarounds are."
  - For adoption: "Build-along: a working agent using [feature] across 3 sessions, with the gotchas the lab announcement skips."
- Forbidden angles: "What is X?" explainers, "Top 5 features you didn't know about", anything that could apply to any AI launch.
- format: pick the ONE that fits the angle. tutorial = step-by-step. opinion = take-driven. demo = show-don't-tell. explainer = mechanism-first. reaction = video reply to specific cited content. comparison = head-to-head. post-mortem = retrospective after-something-broke.
- hook: the actual first sentence. Specific named subject, specific verb, specific stakes. "Theo Browne cancelled his Claude sub. I tried his exact workflow on Opus 4.7 to see if he was right." — that lands. "In this video we explore the new agent view feature." — that's dead on arrival.
- creator_recommendation: null is acceptable when the item pool genuinely doesn't support a grounded recommendation (sample too small, all items are off-topic, no actual signal to riff on). Better null than fabricated.
- "complaint-dominant" means most reactions are negative/frustrated/critical — distinct from "negative" which would mean uniformly bad.
- "unclear" only if items are too off-topic or sparse to judge.
- dominant_pattern reflects the WHOLE feature's editorial frame: tutorial-hype (creators making content about it), adoption (creators actually using/evaluating it), complaint (substantive critique dominant), news (informational coverage), meta (about the feature's policy/pricing/access rather than the feature itself).
- Never invent quotes. Only use text that appears in the supplied items.

[ANTI-AI-TROPE — every string field above is bound by these. The reader is a builder, not a magazine subscriber.]
- Direct, clinical, necessary. Every sentence carries weight. Sentence-or-paragraph as content demands; nothing more, nothing less.
- Forbidden openers: "Let's dive in", "Let's explore", "Let's break this down", "Here's the thing", "Here's how it works", "It's worth noting that", "I'd be happy to", "Feel free to", "Let me know if".
- Forbidden hedges: "notably", "particularly", "remarkably", "essentially", "fundamentally", "ultimately", "arguably", "crucially", "indeed", "importantly", "in essence", "at its core".
- Forbidden hype: "fascinating", "exciting", "game-changer", "revolutionary", "paradigm shift".
- Forbidden closers: "In conclusion", "To summarize", "Overall this is", "I hope this helps".
- Forbidden rhetorical reflexes: "Not just X — Y", "Not X. Y.", "X is a Y — and a Z", "The cool part?".
- Forbidden abstractions: "represents a shift", "represents a fundamental", "marks a significant".
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, added, removed, adopted by.
- Em-dash as a soft pause is forbidden. Use a period instead.`;

// Handles known to be employed by, founders of, or executives at the AI labs
// we're tracking. When one of these accounts "praises" a feature, that's not
// community feedback — that's the company telling its own story. Sonnet needs
// this context to write honest synthesis.
const LAB_AFFILIATED = new Set([
  "bcherny", "sama", "boris", "thsottiaux", "alexalbert__", "karpathy",
  "AnthropicAI", "anthropicai", "ClaudeDevs", "claudedevs", "claudeai", "ClaudeAI",
  "OpenAI", "openai", "GeminiApp", "Google", "GoogleDeepMind", "xai", "elonmusk",
  "miramurati", "gdb", "fchollet", "demishassabis",
]);

interface PromptItem {
  author: string;
  source: string;
  text: string;
  engagement?: number;
  url?: string;
  is_podcast?: boolean;
  video_id?: string;
  show_name?: string;
  reply_signal?: { count: number; positive_pct: number; negative_pct: number; ratioed: boolean };
}

function buildPrompt(
  feature: ConfirmedFeature,
  items: PromptItem[],
  hype: { dominant: boolean; hyped_items: number; total_items: number },
): string {
  const itemsBlock = items
    .map((it, i) => {
      const author = it.author || "(no author)";
      const affil = LAB_AFFILIATED.has(author.replace(/^@/, "")) ? " [LAB-AFFILIATED]" : "";
      const eng = typeof it.engagement === "number" ? `  (${it.engagement} eng)` : "";
      const podcast = it.is_podcast ? ` [PODCAST video_id=${it.video_id ?? "?"} show="${it.show_name ?? "unknown"}"]` : "";
      const reply = it.reply_signal
        ? `\n  [REPLY SIGNAL: count=${it.reply_signal.count} pos=${it.reply_signal.positive_pct.toFixed(0)}% neg=${it.reply_signal.negative_pct.toFixed(0)}%${it.reply_signal.ratioed ? " RATIOED" : ""}]`
        : "";
      const urlLine = it.url ? `\n  URL: ${it.url}` : "";
      return `[${i + 1}] @${author}${affil} · ${it.source}${eng}${podcast}${reply}${urlLine}\n${it.text}`;
    })
    .join("\n\n");
  const hypeLine = `HYPE-DOMINANT: ${hype.dominant ? "yes" : "no"} (deterministic count: ${hype.hyped_items} of ${hype.total_items} top items match tutorial-hype regex indicators)`;
  return `FEATURE: ${feature.lab} — ${feature.title}
LAB ANCHOR URL: ${feature.url}
ENTITIES MATCHED: ${feature.entities.join(", ")}
${hypeLine}

${items.length} creator items below. Tags: [LAB-AFFILIATED] = handle works at the lab; their "praise" is internal storytelling, not validation. [PODCAST] = YT podcast/video item, generate one podcast_synth entry. [REPLY SIGNAL] = aggregated comment-sentiment on the post; pos%/neg% are reply distribution, RATIOED means high-engagement post with negative-dominant replies (contradiction signal).

${itemsBlock}

Synthesize per schema. Apply the rules above — especially the spade-a-spade clause when HYPE-DOMINANT is yes, the competitor-recommendation clause when a reply names a competitor, and the RATIOED clause when reply-signal contradicts post engagement.

Return JSON only.`;
}

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
        "--level",
        // Sonnet via subscription auth (per PAI Inference.ts contract):
        // Haiku (`fast`) produced generic "creators are split" synthesis.
        // Sonnet handles author-context awareness and structural critique
        // naming that the editorial frame requires.
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

function parseJson(raw: string): Partial<SentimentRow> | null {
  let trimmed = raw.trim();
  // strip fenced code block if present
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/);
  if (fence) trimmed = fence[1]!;
  // find outer {...}
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

// Resolve the best author label for a response. YouTube items frequently have
// empty meta.author; their channel name lives in the title as "[Channel] Title".
function resolveAuthor(r: ResponseItem, item: SourceItem | undefined): string {
  if (r.author && r.author.trim().length > 0) return r.author.trim();
  const metaAuthor = item?.meta?.author;
  if (metaAuthor && metaAuthor.trim().length > 0) return metaAuthor.trim();
  if (r.source === "youtube") {
    const src = item?.title ?? r.title ?? "";
    const m = src.match(/^\[([^\]]+)\]/);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

// Extract video_id from a YouTube URL — same heuristic the renderer uses.
function extractYouTubeId(url: string): string {
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? "";
}

// Extract show name from "[Show Name] Title" pattern that the YT harvester emits.
function extractShowName(title: string): string {
  const m = title.match(/^\[([^\]]+)\]/);
  return m?.[1]?.trim() ?? "";
}

interface CommentSentimentRow {
  tweet_url: string;
  agg: { positive: number; negative: number; neutral: number; total: number; dominant: string };
}

function indexCommentSentimentByStatusId(rows: CommentSentimentRow[]): Map<string, CommentSentimentRow> {
  const m = new Map<string, CommentSentimentRow>();
  for (const r of rows) {
    const id = r.tweet_url.match(/status\/(\d+)/)?.[1];
    if (id) m.set(id, r);
  }
  return m;
}

function loadCommentSentimentIndex(): Map<string, CommentSentimentRow> {
  try {
    const rows: CommentSentimentRow[] = JSON.parse(fs.readFileSync(`${DATA}/comment-sentiment.json`, "utf-8"));
    return indexCommentSentimentByStatusId(rows);
  } catch {
    return new Map();
  }
}

// Build a reply_signal for an X item if we have comment-sentiment data for it.
// Ratioed = total >= 10 AND positive_pct < 40% — high-engagement post whose
// reply thread contradicts its surface signal. Per ISC-372 (advisor S3 resolve).
function replySignalFor(r: ResponseItem, idx: Map<string, CommentSentimentRow>): PromptItem["reply_signal"] {
  if (r.source !== "x") return undefined;
  const id = r.url.match(/status\/(\d+)/)?.[1];
  if (!id) return undefined;
  const cs = idx.get(id);
  if (!cs || cs.agg.total < 5) return undefined;
  const total = cs.agg.total;
  const pos = (cs.agg.positive / total) * 100;
  const neg = (cs.agg.negative / total) * 100;
  return { count: total, positive_pct: pos, negative_pct: neg, ratioed: total >= 10 && pos < 40 };
}

async function processFeature(
  feature: ConfirmedFeature,
  indices: Record<string, Map<string, SourceItem>>,
  commentSentimentIdx: Map<string, CommentSentimentRow>,
): Promise<SentimentRow> {
  // Build the item corpus: prefer items whose match was in transcript or raw_text
  // (richer content) over title-only matches. Cap at MAX_RESPONSE_ITEMS_PER_FEATURE.
  const ranked = [...feature.responses].sort((a, b) => {
    const score = (m: "title" | "raw_text" | "transcript") =>
      m === "transcript" ? 3 : m === "raw_text" ? 2 : 1;
    const ds = score(b.match_in) - score(a.match_in);
    if (ds !== 0) return ds;
    return b.engagement - a.engagement;
  });
  const selected = ranked.slice(0, MAX_RESPONSE_ITEMS_PER_FEATURE);
  const items: PromptItem[] = selected.map((r) => {
    const item = indices[r.source]?.get(r.url);
    let text = "";
    if (r.match_in === "transcript" && item?.meta?.transcript) {
      const t = item.meta.transcript;
      const idx = t.toLowerCase().indexOf(r.matched_entity.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        const end = Math.min(t.length, idx + r.matched_entity.length + 400);
        text = `[transcript window] ${t.slice(start, end)}`;
      } else {
        text = `[transcript head] ${t.slice(0, MAX_CHARS_PER_ITEM)}`;
      }
    } else {
      text = item?.raw_text ?? r.title;
    }
    const is_podcast = r.source === "youtube";
    return {
      author: resolveAuthor(r, item),
      source: r.source,
      text: text.slice(0, MAX_CHARS_PER_ITEM),
      engagement: r.engagement,
      url: r.url,
      is_podcast,
      video_id: is_podcast ? extractYouTubeId(r.url) : undefined,
      show_name: is_podcast ? extractShowName(item?.title ?? r.title) : undefined,
      reply_signal: replySignalFor(r, commentSentimentIdx),
    };
  });

  // S6/ISC-375 — deterministic tutorial-hype aggregate from item texts. Sonnet
  // picks dominant_pattern from this count; doesn't classify free-form.
  const hype = aggregateTutorialHype(items.map((i) => i.text));

  const userPrompt = buildPrompt(feature, items, hype);
  try {
    const raw = await ask(SYS, userPrompt);
    const parsed = parseJson(raw);
    if (!parsed) throw new Error("non-JSON response");
    const podcastSynth = Array.isArray(parsed.podcast_synth)
      ? (parsed.podcast_synth as { video_id?: string; show_name?: string; synth_line?: string }[])
          .filter((p) => p.synth_line && p.video_id)
          .map((p) => ({ video_id: String(p.video_id), show_name: String(p.show_name ?? ""), synth_line: String(p.synth_line) }))
      : [];
    const citedItemsWhyRaw = (parsed as { cited_items_why?: unknown }).cited_items_why;
    const citedItemsWhy: Record<string, string> = {};
    if (citedItemsWhyRaw && typeof citedItemsWhyRaw === "object" && !Array.isArray(citedItemsWhyRaw)) {
      for (const [url, why] of Object.entries(citedItemsWhyRaw as Record<string, unknown>)) {
        if (typeof why === "string" && why.trim().length >= 10) {
          citedItemsWhy[url] = why.trim();
        }
      }
    }
    const counterNarrativesRaw = (parsed as { counter_narratives?: unknown }).counter_narratives;
    const counterNarratives = Array.isArray(counterNarrativesRaw)
      ? (counterNarrativesRaw as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 2)
      : [];
    // iter-32 — extract creator_recommendation (was silently dropped on the
    // first two iter-32 Sonnet runs because the return-object did not enumerate
    // the new field added to SentimentRow). Validate shape + format whitelist.
    const VALID_CR_FORMATS = new Set(["tutorial", "opinion", "demo", "explainer", "reaction", "comparison", "post-mortem"]);
    const crRaw = (parsed as { creator_recommendation?: unknown }).creator_recommendation;
    let creatorRecommendation: SentimentRow["creator_recommendation"] = null;
    if (crRaw && typeof crRaw === "object" && !Array.isArray(crRaw)) {
      const cr = crRaw as { angle?: unknown; format?: unknown; hook?: unknown };
      if (
        typeof cr.angle === "string" && cr.angle.trim().length >= 10 &&
        typeof cr.format === "string" && VALID_CR_FORMATS.has(cr.format) &&
        typeof cr.hook === "string" && cr.hook.trim().length >= 8
      ) {
        creatorRecommendation = {
          angle: cr.angle.trim(),
          format: cr.format as NonNullable<SentimentRow["creator_recommendation"]>["format"],
          hook: cr.hook.trim(),
        };
      }
    }
    return {
      feature_id: feature.feature_id,
      feature_title: feature.title,
      sample_size: items.length,
      overall_sentiment: (parsed.overall_sentiment ?? "unclear") as SentimentRow["overall_sentiment"],
      dominant_pattern: parsed.dominant_pattern as SentimentRow["dominant_pattern"],
      summary_sentence: parsed.summary_sentence ?? "",
      praises: Array.isArray(parsed.praises) ? parsed.praises.slice(0, 3) : [],
      complaints: Array.isArray(parsed.complaints) ? parsed.complaints.slice(0, 3) : [],
      notable_quotes: Array.isArray(parsed.notable_quotes) ? parsed.notable_quotes.slice(0, 3) : [],
      podcast_synth: podcastSynth,
      cross_narrative_ids: [], // populated by cross-narrative pass
      cited_items_why: citedItemsWhy,
      counter_narratives: counterNarratives,
      creator_recommendation: creatorRecommendation,
    };
  } catch (e) {
    return {
      feature_id: feature.feature_id,
      feature_title: feature.title,
      sample_size: items.length,
      overall_sentiment: "unclear",
      summary_sentence: "",
      praises: [],
      complaints: [],
      notable_quotes: [],
      podcast_synth: [],
      cross_narrative_ids: [],
      cited_items_why: {},
      counter_narratives: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// D6/D7 + ISC-371 — Cross-narrative pass. SECOND Sonnet call after all
// per-feature sentiments land. Sees the whole batch, identifies substrate
// narratives spanning 2+ features. Volume minimization is in the prompt:
// "only surface genuine substrate events, pair-wise overlap is NOT a
// narrative, if unsure return empty." Confidence-tagged so render can fold
// med/low behind a dropdown (per Kem 2026-05-16 redirect — same pattern as
// unclear-sentiment fold, not a numeric cap).
const CROSS_NARRATIVE_SYS = `You are an editorial analyst looking across an entire batch of AI lab features. Your job: identify SUBSTRATE NARRATIVES — cross-cutting threads where 2+ features share a genuine substrate event (a lab action, a policy shift, a market dynamic, an ecosystem move).

Output strict JSON only:
{
  "narratives": [
    {
      "narrative_id": "kebab-case-id",
      "theme": "short phrase naming the substrate event (e.g. 'labs restricting Max plan while competitors open access')",
      "implicated_feature_ids": ["feature_id_1", "feature_id_2"],
      "substrate_sentence": "ONE sentence (max 40 words) connecting the features via the substrate event, with a specific quoted phrase per implicated feature so the reader can verify the connection",
      "confidence": "high" | "med" | "low"
    }
  ]
}

Rules — these matter, strict:
- A narrative requires ≥2 features sharing a genuine substrate event. Pair-wise semantic overlap (both mention "agents") is NOT a narrative.
- Genuine substrate events include: lab policy change, lab pricing change, lab access restriction or opening, regulatory action, competitor mirror-move, ecosystem migration, **lab security positioning** (one lab's security announcement framed against another's; e.g. OpenAI's GPT-5.5-Cyber positioned against Anthropic's prior security work). NOT: "both are AI features" or "both got tutorials."
- **D-WALK-7 — Security positioning class**: actively look for cross-lab security narratives. If two features touch security (one lab launching a cyber model, another lab's safety/governance posture), and a substrate event connects them (e.g. "OpenAI responds to Anthropic's security framing with GPT-5.5-Cyber"), surface as a narrative with confidence reflecting evidence strength.
- substrate_sentence MUST include a specific quoted phrase or named entity per implicated feature so the reader can verify (e.g. "Anthropic's Agent SDK 'June 15 subscription policy change' and xAI's 'use your @grok subscription inside @NousResearch Hermes Agent' frame opposing access trajectories").
- confidence: high = strong evidence, named substrate event, clear contrast or alignment. med = plausible but evidence thinner. low = pattern visible but interpretation requires reach.
- If unsure whether a candidate narrative is genuine, return empty array. Better to surface zero than to spray vague "AI is hot" threads.

[ANTI-AI-TROPE — every string field above is bound by these. Reader is a builder, not a magazine subscriber.]
- Direct, clinical, necessary. Sentence-or-paragraph as content demands; nothing more, nothing less.
- Forbidden openers: "Let's dive in", "Let's explore", "Here's the thing", "It's worth noting that".
- Forbidden hedges: "notably", "particularly", "remarkably", "essentially", "fundamentally", "ultimately", "arguably", "crucially", "indeed", "importantly", "in essence", "at its core".
- Forbidden hype: "fascinating", "exciting", "game-changer", "revolutionary", "paradigm shift".
- Forbidden closers: "In conclusion", "To summarize", "Overall this is".
- Forbidden rhetorical reflexes: "Not just X — Y", "Not X. Y.".
- Forbidden abstractions: "represents a shift", "marks a significant".
- Forbidden verb "shift" — use the actual mechanism: released, moved to, replaced, started, stopped, added, removed, adopted by.
- Em-dash as a soft pause is forbidden. Use a period instead.

Output JSON only.`;

async function runCrossNarrativePass(rows: SentimentRow[]): Promise<CrossNarrative[]> {
  // Build a compact feature summary the cross-pass can reason over without
  // re-reading the entire response corpus. Just feature_id + title + lab +
  // dominant_pattern + summary_sentence is enough for substrate-event spotting.
  const batch = rows.map((r) => ({
    feature_id: r.feature_id,
    feature_title: r.feature_title,
    dominant_pattern: r.dominant_pattern ?? "unknown",
    overall_sentiment: r.overall_sentiment,
    summary_sentence: r.summary_sentence,
  }));
  const userPrompt = `BATCH of ${batch.length} features below. Identify substrate narratives per the rules.

${batch.map((b, i) => `[${i + 1}] feature_id=${b.feature_id} dominant_pattern=${b.dominant_pattern} sentiment=${b.overall_sentiment}\n  title: ${b.feature_title}\n  summary: ${b.summary_sentence}`).join("\n\n")}

Return JSON {narratives: [...]} only.`;
  try {
    const raw = await ask(CROSS_NARRATIVE_SYS, userPrompt);
    const parsed = parseJson(raw) as { narratives?: CrossNarrative[] } | null;
    if (!parsed || !Array.isArray(parsed.narratives)) return [];
    return parsed.narratives
      .filter((n) => n && n.narrative_id && Array.isArray(n.implicated_feature_ids) && n.implicated_feature_ids.length >= 2 && n.substrate_sentence)
      .map((n) => ({
        narrative_id: String(n.narrative_id),
        theme: String(n.theme ?? ""),
        implicated_feature_ids: n.implicated_feature_ids.map(String),
        substrate_sentence: String(n.substrate_sentence),
        confidence: (n.confidence === "high" || n.confidence === "med" || n.confidence === "low") ? n.confidence : "low",
      }));
  } catch (e) {
    console.warn(`cross-narrative pass failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function main(): Promise<void> {
  const features: ConfirmedFeature[] = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const indices: Record<string, Map<string, SourceItem>> = {
    x: indexByUrl(loadSource("x")),
    tiktok: indexByUrl(loadSource("tiktok")),
    instagram: indexByUrl(loadSource("instagram")),
    youtube: indexByUrl(loadSource("youtube")),
  };
  // S3/ISC-372 — comment-sentiment loaded HERE (per-feature sentiment now
  // sees reply-signal data). Empty Map if data/comment-sentiment.json absent
  // or stale — sentiment falls back to engagement-only reasoning.
  const commentSentimentIdx = loadCommentSentimentIndex();
  console.log(`comment-sentiment data: ${commentSentimentIdx.size} tweets with reply signal`);

  console.log(`processing ${features.length} features at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  const rows: SentimentRow[] = new Array(features.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < features.length) {
      const idx = i++;
      const f = features[idx]!;
      const row = await processFeature(f, indices, commentSentimentIdx);
      rows[idx] = row;
      const pattern = row.dominant_pattern ? `[${row.dominant_pattern}]` : "";
      const synth = row.podcast_synth && row.podcast_synth.length > 0 ? ` +${row.podcast_synth.length} podcast-synth` : "";
      console.log(`  [${idx + 1}/${features.length}] ${row.overall_sentiment.padEnd(20)} ${pattern.padEnd(18)} ${f.title.slice(0, 50)}${synth}${row.error ? ` (ERR: ${row.error.slice(0, 60)})` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`per-feature pass done in ${dt}s`);

  // D6/D7 + ISC-371 — Cross-narrative pass. Single Sonnet call sees the whole
  // batch, returns substrate narratives with confidence tags. Populates
  // cross_narrative_ids on each row that's implicated.
  console.log(`cross-narrative pass over ${rows.length} features...`);
  const tn = Date.now();
  const narratives = await runCrossNarrativePass(rows);
  console.log(`cross-narrative pass done in ${((Date.now() - tn) / 1000).toFixed(1)}s — found ${narratives.length} narratives (${narratives.filter((n) => n.confidence === "high").length} high · ${narratives.filter((n) => n.confidence === "med").length} med · ${narratives.filter((n) => n.confidence === "low").length} low)`);
  for (const n of narratives) {
    for (const fid of n.implicated_feature_ids) {
      const row = rows.find((r) => r.feature_id === fid);
      if (row) {
        row.cross_narrative_ids = row.cross_narrative_ids ?? [];
        row.cross_narrative_ids.push(n.narrative_id);
      }
    }
  }

  fs.writeFileSync(`${DATA}/feature-sentiment.json`, JSON.stringify(rows, null, 2));
  console.log(`wrote ${rows.length} sentiment rows → data/feature-sentiment.json`);
  fs.writeFileSync(`${DATA}/cross-narratives.json`, JSON.stringify(narratives, null, 2));
  console.log(`wrote ${narratives.length} cross-narratives → data/cross-narratives.json`);
}

main();
