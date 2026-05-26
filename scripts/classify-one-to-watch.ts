#!/usr/bin/env bun
/**
 * scripts/classify-one-to-watch.ts (iter-45 first cut, written iter-44 phase 1)
 *
 * Deterministic classifier for the One to Watch section. Reads 5+1 streams,
 * excludes already-anchored items, classifies into buckets, computes
 * cross-source corroboration, picks the worked example. Output:
 * data/one-to-watch.json.
 *
 * Per Kem 2026-05-18: "We have to use the real data."
 *
 * v8 doctrine: re-running this script against unchanged input data produces
 * byte-identical output. The snapshot IS the input to the renderer.
 *
 * Streams: arxiv + frontier RSS + x + tiktok + instagram + github
 * Buckets: predict-ahead / likely-surface / today / hustler
 * Worked example: highest-conviction predict-ahead item (tiebreak alphabetic)
 */

import fs from "fs";

const DATA = "data";

// ---------- HANDLE SETS ----------

// Expanded lab list (features-first.ts has 9; this adds the ones that
// silently slipped through iter-44 OBSERVE: Moonshot, DeepSeek, Mistral,
// Perplexity, Meta, plus other AI labs worth tracking).
const LAB_X_ACCOUNTS = new Set([
  // Already in features-first.ts:
  "AnthropicAI", "ClaudeDevs", "claudeai", "GeminiApp",
  "Google", "GoogleDeepMind", "OpenAI", "sama", "xai",
  // NEW iter-45 — silently missing from prior cycles:
  "Kimi_Moonshot", "deepseek_ai", "DeepSeekAI", "MistralAI", "perplexity_ai",
  "MetaAI", "NVIDIAAI", "runwayml", "midjourney", "cohere", "Cohere_Labs",
  "HuggingFace", "huggingface", "ai21labs", "character_ai", "groqinc",
  "TogetherCompute", "Together", "AIatMeta",
]);

const NOTABLE_CREATOR_HANDLES = new Set([
  "karpathy", "simonw", "agentic.james", "Theo", "theo", "fireship",
  "Saranormous", "eladgil", "harrystebbings", "omarsar0", "_akhaliq",
  "fchollet", "hardmaru", "YannicKilcher", "TheAhmadOsman", "DanielMiessler",
  "ColeMedin", "MervinPraison", "nicksaraev", "LiamOttley", "milesdeutscher",
  "danshipper", "natolambert", "labenz", "askalphaxiv", "AlexFinn",
  "businessbarista", "tenex_labs", "alexisohanian", "JinjingLiang",
  "augmentcode", "bridgemindai", "hasantoxr", "rubenhassid",
  "thsottiaux", "trikcode", "karthikponna19", "AsymEdge", "rentierdigital_phil",
  "DataChaz", "charliejhills", "bcherny", "sairahul1", "Venkydotdev",
  "sabrina_ramonov", "bio_makers1", "rileybrown.ai", "tommythings",
  "gazi.ai", "adam.digital", "brandnat", "kanekallaway", "justinfineberg",
  "danmartell", "yourchatgptguide", "handlytech", "rpn", "harpercarrollai",
  "therundownai", "Chase-H-AI",
]);

// Subset of NOTABLE that posts research/technique (named-voice industry signal,
// not creator-tutorial). Used to distinguish "named voice" from "playbook" when
// post format markers are absent or weak.
const RESEARCH_NAMED_HANDLES = new Set([
  "karpathy", "simonw", "fchollet", "hardmaru", "YannicKilcher",
  "DanielMiessler", "natolambert", "labenz", "askalphaxiv",
  "AlexFinn", "DataChaz", "theo", "Theo", "agentic.james",
  "AsymEdge", "rentierdigital_phil", "bcherny", "sairahul1",
  "Venkydotdev", "omarsar0", "_akhaliq", "milesdeutscher",
  "JinjingLiang", "thsottiaux",
]);

// ---------- FORMAT MARKERS ----------

const HUSTLER_FORMAT_MARKERS: RegExp[] = [
  /\bsave this\b/i,
  /\b\d+x better\b/i,
  /\bI'?ll tell you how\b/i,
  /\bI'?m going to tell you\b/i,
  /\bhere are \d+ /i,
  /\b\d+ prompts?\b/i,
  /\b\d+ hacks?\b/i,
  /\b\d+ tricks?\b/i,
  /\b\d+ ways? to\b/i,
  /\bdays? of AI basics\b/i,
  /\bstop (asking|using) \w+\b/i,
  /\bbest AI tools? (to|for|in)\b/i,
  /\b\d+x in \d+ /i,
  /\bgenius mode\b/i,
];

const NON_AI_NOISE_MARKERS: RegExp[] = [
  /create to serve/i,
  /fall in love with the journey/i,
  /^@?\w+:?\s*(TAG|tag)\s+/i,
  /\b(graduation|graduate|LL\.M\.|law faculty)\b/i,
  /\bbusiness partner\b/i,
  /\b(porsche|GT4|GT2|cayman)\b/i,
  /\bmichaeljackson|#mj\b/i,
];

const AI_KEYWORD_REGEX = /\b(AI|GPT|Claude|Anthropic|OpenAI|LLM|agent|Gemini|prompt|model|Sonnet|Opus|Codex|Cursor|RAG|MCP|DeepSeek|Kimi|Mistral|perplexity|Meta AI|Apple Intelligence|reasoning|inference|transformer|attention|embedding|fine[- ]?tun)\b/i;

// ---------- TYPES ----------

interface Item {
  author: string;
  source: string;
  url: string;
  title: string;
  raw_text: string;
  engagement: number;
  ts: string;
}

type BucketId = "predict-ahead" | "likely-surface" | "today" | "hustler" | "dropped";
type ClassTag =
  | "research" | "lab-editorial"
  | "lab-orphan" | "github-mid" | "cross-source"
  | "named-voice" | "creator-playbook" | "today-misc"
  | "hustler"
  | "non-ai" | "noise" | "candidate";

interface Classified {
  bucket: BucketId;
  class_tag: ClassTag;
  reason: string;
  item: Item;
  corroboration_count: number;
  corroborated_entities: string[];
  conviction_stake: number;
}

// ---------- IO ----------

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(`${DATA}/${p}`, "utf-8")) as T; }
  catch { return fallback; }
}

function normalize(raw: any, sourceFallback: string): Item {
  return {
    author: String(raw.author || raw.meta?.author || "").replace(/^@/, "").trim(),
    source: raw.source || sourceFallback,
    url: raw.url || "",
    title: raw.title || "",
    raw_text: raw.raw_text || "",
    engagement: Number(raw.engagement || raw.meta?.engagement || raw.score || 0),
    ts: String(raw.ts || raw.meta?.ts || raw.meta?.created_at || ""),
  };
}

// ---------- LOAD STREAMS ----------

const features = readJson<any[]>("features-confirmed.json", []);
const anchoredUrls = new Set(
  features.flatMap((f: any) =>
    [f.url, ...(f.responses || []).map((r: any) => r.url)].filter(Boolean)
  )
);

const arxivItems = readJson<any[]>("arxiv.json", []).map(r => normalize(r, "arxiv"));
const frontierItems = readJson<any[]>("frontier.json", []).map(r => normalize(r, "frontier"));
const xItems = readJson<any[]>("x.json", []).map(r => normalize(r, "x"));
const ttItems = readJson<any[]>("tiktok.json", []).map(r => normalize(r, "tiktok"));
const igItems = readJson<any[]>("instagram.json", []).map(r => normalize(r, "instagram"));
const githubItems = readJson<any[]>("github.json", []).map(r => normalize(r, "github"));

// Already-derived GitHub lens picks top-12 by stars — we skip those and take
// 13th–N for the "mid-tier bubbling" zone. Compute top-12 here for exclusion.
const githubSortedByStars = [...githubItems].sort((a, b) => b.engagement - a.engagement);
const githubTop12Urls = new Set(githubSortedByStars.slice(0, 12).map(i => i.url));

// Anchor timestamp = max ts across all loaded items (v8 doctrine — derived not Date.now)
function tsMs(s: string): number {
  if (!s) return 0;
  const ms = new Date(s).getTime();
  return isNaN(ms) ? 0 : ms;
}
const anchorTs = Math.max(
  ...[...arxivItems, ...frontierItems, ...xItems, ...ttItems, ...igItems, ...githubItems].map(i => tsMs(i.ts))
);

// ---------- FILTERS ----------

function isAnchored(i: Item): boolean { return anchoredUrls.has(i.url); }
function hasAIKeyword(i: Item): boolean {
  return AI_KEYWORD_REGEX.test(i.title) || AI_KEYWORD_REGEX.test(i.raw_text.slice(0, 600));
}
function isNonAINoise(i: Item): boolean {
  if (NON_AI_NOISE_MARKERS.some(re => re.test(i.title) || re.test(i.raw_text.slice(0, 600)))) return true;
  const tsYear = i.ts ? new Date(i.ts).getFullYear() : 0;
  if (tsYear > 0 && tsYear < 2024) return true;
  return false;
}
function isHustlerFormat(i: Item): boolean {
  const t = i.title + " " + i.raw_text.slice(0, 600);
  return HUSTLER_FORMAT_MARKERS.some(re => re.test(t));
}

// ---------- STREAM-BASED CLASSIFICATION ----------

function classify(i: Item, lane: string): { bucket: BucketId; class_tag: ClassTag; reason: string } | null {
  if (isAnchored(i)) return null;

  if (["x", "tiktok", "instagram"].includes(lane)) {
    if (!hasAIKeyword(i)) return { bucket: "dropped", class_tag: "non-ai", reason: "no AI keyword" };
    if (isNonAINoise(i)) return { bucket: "dropped", class_tag: "noise", reason: "non-AI noise marker" };
  }

  if (lane === "arxiv") return { bucket: "predict-ahead", class_tag: "research", reason: "arxiv paper" };
  if (lane === "frontier") return { bucket: "predict-ahead", class_tag: "lab-editorial", reason: "frontier RSS lab editorial" };

  if (lane === "github") {
    if (githubTop12Urls.has(i.url)) return null; // skip top-12 (already in GitHub lens)
    if (i.engagement < 1000) return null; // skip low-star noise
    if (i.engagement >= 10000) return null; // skip already-viral
    return { bucket: "likely-surface", class_tag: "github-mid", reason: `github mid-tier (${i.engagement} ⭐)` };
  }

  // X / TT / IG
  const author = i.author;
  if (LAB_X_ACCOUNTS.has(author)) {
    return { bucket: "likely-surface", class_tag: "lab-orphan", reason: "lab-X orphan" };
  }
  const isWhitelisted = NOTABLE_CREATOR_HANDLES.has(author) || NOTABLE_CREATOR_HANDLES.has(author.toLowerCase());
  if (isWhitelisted) {
    if (isHustlerFormat(i)) {
      if (i.engagement >= 100_000) {
        return { bucket: "hustler", class_tag: "hustler", reason: "high-engagement playbook format (saturation)" };
      }
      return { bucket: "today", class_tag: "creator-playbook", reason: "playbook format from whitelist" };
    }
    if (RESEARCH_NAMED_HANDLES.has(author) || RESEARCH_NAMED_HANDLES.has(author.toLowerCase())) {
      return { bucket: "today", class_tag: "named-voice", reason: "research-named handle" };
    }
    return { bucket: "today", class_tag: "today-misc", reason: "whitelist orphan (uncategorized)" };
  }

  // Non-whitelist X/TT/IG — promoted later if cross-source corroborated
  return { bucket: "dropped", class_tag: "candidate", reason: "non-whitelist (will promote if cross-source corroborated)" };
}

// ---------- CROSS-SOURCE CORROBORATION ----------

const ENTITY_RE = /\b(?:[A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){1,2}|\/[a-z]+|[A-Z][a-zA-Z]+ \d(?:\.\d+)?)\b/g;
const ENTITY_STOPWORDS = new Set([
  // Geography / generic
  "United States", "New York", "Wall Street", "World War", "South China",
  "United Kingdom", "New York Times", "Silicon Valley", "Bay Area",
  // Time
  "Last Week", "Last Year", "Last Month", "This Week", "This Year",
  "Last Time", "Real Time", "Long Time", "First Time", "Right Now",
  "Today", "Tomorrow", "Yesterday",
  // Generic adjectives
  "Open Source", "Long Term", "Big Tech", "Big Data", "Big Deal",
  "Way Better", "Pretty Good", "Pretty Cool", "Pretty Solid",
  "Old Fashioned", "Real World", "End User", "Long Term Benefit",
  // Generic AI terms that match everything and inflate corroboration
  "AI", "Artificial Intelligence", "Machine Learning", "Deep Learning",
  "AI Engineering", "AI Apocalypse", "AI Daily", "American Dynamism",
  "AI Agent", "AI Agents", "AI Coding", "AI Model", "AI Models",
  "AI Tool", "AI Tools", "AI Code", "AI Industry", "AI Race",
  "AI Safety", "AI Lab", "AI Labs", "AI System", "AI Systems",
  "AI Power", "AI Powered", "AI Generated", "AI Generation",
  // Common product names so common they correlate across all sources
  "Claude", "ChatGPT", "Codex", "Cursor", "GPT", "OpenAI",
  "Anthropic", "Google", "Gemini", "Meta", "Apple",
  "Claude Code", "Claude Sonnet", "Claude Opus", "Claude Pro", "Claude Max",
  "ChatGPT Pro", "GPT 4", "GPT 5",
  // Common verbs as noun-phrase starters
  "Hard Fork", "Cold Start",
]);

function extractEntities(i: Item): string[] {
  const text = (i.title + " " + i.raw_text.slice(0, 1500));
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(text)) !== null) {
    const e = m[0];
    if (ENTITY_STOPWORDS.has(e)) continue;
    if (e.length < 4) continue;
    if (/^\d/.test(e)) continue;
    out.add(e);
  }
  return [...out];
}

// Build entity → distinct-authors map across all non-anchored items
const allCandidates: { item: Item; lane: string }[] = [
  ...arxivItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "arxiv" })),
  ...frontierItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "frontier" })),
  ...xItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "x" })),
  ...ttItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "tiktok" })),
  ...igItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "instagram" })),
  ...githubItems.filter(i => !isAnchored(i)).map(i => ({ item: i, lane: "github" })),
];

const entityToAuthors = new Map<string, Set<string>>();
for (const { item } of allCandidates) {
  if (!hasAIKeyword(item) && !["arxiv", "frontier", "github"].includes(item.source)) continue;
  for (const e of extractEntities(item)) {
    if (!entityToAuthors.has(e)) entityToAuthors.set(e, new Set());
    entityToAuthors.get(e)!.add(item.author || "(no-author)");
  }
}

function corroborationFor(i: Item): { count: number; entities: string[] } {
  const ents = extractEntities(i);
  let maxCount = 1;
  const corr: string[] = [];
  for (const e of ents) {
    const auths = entityToAuthors.get(e);
    if (auths && auths.size >= 2) {
      corr.push(`${e} (${auths.size}-src)`);
      if (auths.size > maxCount) maxCount = auths.size;
    }
  }
  return { count: maxCount >= 2 ? maxCount : 0, entities: corr.slice(0, 5) };
}

// ---------- CONVICTION FORMULA ----------

function convictionStake(item: Item, bucket: BucketId, classTag: ClassTag, corrCount: number): number {
  // class_tag weight — arxiv research outranks frontier marketing within predict-ahead
  const tagWeight: Partial<Record<ClassTag, number>> = {
    "research": 3.5,    // arxiv = strongest predict-ahead signal
    "lab-editorial": 2, // frontier RSS = lab marketing, weaker signal
    "lab-orphan": 2.5,
    "cross-source": 2.5,
    "github-mid": 2,
    "named-voice": 1.5,
    "creator-playbook": 0.8,
    "today-misc": 1,
    "hustler": 0,
  };
  const tw = tagWeight[classTag] ?? 1;
  const engBonus = item.engagement > 0 ? Math.log10(item.engagement + 1) / 3 : 0;
  const ageMs = item.ts ? anchorTs - tsMs(item.ts) : Number.MAX_SAFE_INTEGER;
  const ageDays = ageMs / 86_400_000;
  const recencyBonus = ageDays <= 7 ? 1 : ageDays <= 14 ? 0.5 : 0;
  // Corroboration bonus capped at +2 to prevent buzz-domination
  const corrBonus = Math.min(2, corrCount);
  const raw = tw + engBonus + corrBonus + recencyBonus;
  // 5-point conviction scale: 1=low, 2=med, 3=high, 4=very-high, 5=top
  return Math.min(5, Math.max(1, Math.round(raw)));
}

// ---------- RUN CLASSIFICATION ----------

const classified: Classified[] = [];

function process(items: Item[], lane: string) {
  for (const item of items) {
    const c = classify(item, lane);
    if (!c) continue;
    const corr = corroborationFor(item);

    let { bucket, class_tag, reason } = c;
    // Promote non-whitelist candidates if cross-source corroborated
    if (bucket === "dropped" && class_tag === "candidate" && corr.count >= 2) {
      bucket = "likely-surface";
      class_tag = "cross-source";
      reason = `cross-source corroborated (${corr.count} sources)`;
    }
    if (bucket === "dropped" && (class_tag === "non-ai" || class_tag === "noise")) {
      // Keep dropped record for the dropped_as_noise list
      classified.push({ bucket, class_tag, reason, item, corroboration_count: 0, corroborated_entities: [], conviction_stake: 0 });
      continue;
    }
    if (bucket === "dropped") continue;

    const stake = convictionStake(item, bucket, class_tag, corr.count);
    classified.push({
      bucket, class_tag, reason, item,
      corroboration_count: corr.count,
      corroborated_entities: corr.entities,
      conviction_stake: stake,
    });
  }
}

process(arxivItems, "arxiv");
process(frontierItems, "frontier");
process(xItems, "x");
process(ttItems, "tiktok");
process(igItems, "instagram");
process(githubItems, "github");

// ---------- CAPS + DEDUPE ----------

// Cap 1 per author per bucket (mirror iter-31 rebalanceNotableOrphans pattern)
// AND top-N per bucket (editorial budget — render space is finite)
const PER_BUCKET_CAPS = {
  "predict-ahead": 8,    // 4 arxiv + 4 lab-editorial typical
  "likely-surface": 12,  // mix of lab-orphan + github-mid + cross-source
  "today": 8,            // 4 named-voice + 4 creator-playbook
  "hustler": 4,          // saturation absorbers
};

function capAndDedupe(items: Classified[], cap: number): Classified[] {
  const sorted = [...items].sort((a, b) => {
    if (b.conviction_stake !== a.conviction_stake) return b.conviction_stake - a.conviction_stake;
    if (b.corroboration_count !== a.corroboration_count) return b.corroboration_count - a.corroboration_count;
    return (b.item.engagement || 0) - (a.item.engagement || 0);
  });
  const out: Classified[] = [];
  const seenAuthors = new Set<string>();
  for (const c of sorted) {
    if (out.length >= cap) break;
    const key = (c.item.author || c.item.url).toLowerCase();
    if (seenAuthors.has(key)) continue;
    seenAuthors.add(key);
    out.push(c);
  }
  return out;
}

const capped: Classified[] = [];
for (const [bucket, cap] of Object.entries(PER_BUCKET_CAPS) as [BucketId, number][]) {
  const subset = classified.filter(c => c.bucket === bucket);
  capped.push(...capAndDedupe(subset, cap));
}

// ---------- WORKED EXAMPLE SELECTOR ----------

// Only arxiv items eligible (research is the canonical predict-ahead lane;
// frontier RSS is lab marketing, less editorially interesting as a chain
// origin). Pick highest-conviction; tiebreak by AI-tooling-relevance keyword
// in title (agent/harness/retrieval/memory/RAG/attention/inference/skill),
// then corroboration, then alphabetic. The keyword gate prevents false-
// positive entity matches (e.g. "From Data to Action: Refinery Optimization")
// from winning the worked-example slot.
const AI_TOOLING_KEYWORDS = /\b(agent|agentic|harness|retrieval|RAG|memory|attention|inference|reasoning|skill|context|prompt|search)\b/i;
const arxivOnly = capped.filter(c => c.class_tag === "research");
arxivOnly.sort((a, b) => {
  if (b.conviction_stake !== a.conviction_stake) return b.conviction_stake - a.conviction_stake;
  const aHasKw = AI_TOOLING_KEYWORDS.test(a.item.title) ? 1 : 0;
  const bHasKw = AI_TOOLING_KEYWORDS.test(b.item.title) ? 1 : 0;
  if (aHasKw !== bHasKw) return bHasKw - aHasKw;
  if (b.corroboration_count !== a.corroboration_count) return b.corroboration_count - a.corroboration_count;
  return a.item.title.localeCompare(b.item.title);
});
const workedExample = arxivOnly[0] || capped.find(c => c.bucket === "predict-ahead") || null;

// ---------- TALLIES + OUTPUT ----------

const byBucketRaw = { "predict-ahead": 0, "likely-surface": 0, "today": 0, "hustler": 0, "dropped": 0 };
for (const c of classified) byBucketRaw[c.bucket]++;

const byBucketCapped = { "predict-ahead": 0, "likely-surface": 0, "today": 0, "hustler": 0, "dropped": 0 };
for (const c of capped) byBucketCapped[c.bucket]++;

const dropped = classified.filter(c => c.bucket === "dropped");
const kept = capped; // capped is already the post-cap, post-author-dedupe set

kept.sort((a, b) => {
  const order = { "predict-ahead": 0, "likely-surface": 1, "today": 2, "hustler": 3, "dropped": 4 };
  if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
  return b.conviction_stake - a.conviction_stake;
});

const output = {
  schema_version: 3,
  doctrine_note: "Deterministic classification per Kem 2026-05-18 'we have to use the real data'. Reads 6 streams (arxiv + frontier + x + tiktok + instagram + github), filters non-anchored items, classifies by stream-based rules + cross-source corroboration. Re-running against unchanged data produces byte-identical output.",
  generator: "scripts/classify-one-to-watch.ts",
  anchor_ts: new Date(anchorTs).toISOString(),
  inputs: {
    arxiv: arxivItems.length, frontier: frontierItems.length,
    x: xItems.length, tiktok: ttItems.length, instagram: igItems.length, github: githubItems.length,
    anchored_excluded: anchoredUrls.size,
  },
  lab_handles_expanded_iter45: ["Kimi_Moonshot", "deepseek_ai", "MistralAI", "perplexity_ai", "MetaAI", "NVIDIAAI", "runwayml", "midjourney", "cohere", "HuggingFace", "ai21labs", "character_ai", "groqinc", "TogetherCompute", "AIatMeta"],
  tally: {
    kept: kept.length,
    predict_ahead: byBucketCapped["predict-ahead"],
    likely_surface: byBucketCapped["likely-surface"],
    today: byBucketCapped["today"],
    hustler: byBucketCapped["hustler"],
    dropped: dropped.length,
    raw_classified_pre_cap: classified.filter(c => c.bucket !== "dropped").length,
    raw_by_bucket: byBucketRaw,
    caps_applied: PER_BUCKET_CAPS,
  },
  worked_example: workedExample ? {
    title: workedExample.item.title,
    url: workedExample.item.url,
    author: workedExample.item.author,
    source: workedExample.item.source,
    bucket: workedExample.bucket,
    class_tag: workedExample.class_tag,
    conviction_stake: workedExample.conviction_stake,
    corroboration_count: workedExample.corroboration_count,
    corroborated_entities: workedExample.corroborated_entities,
    propagation_chain_template: [
      { stage: 1, lane: "research", status: "observed", note: "this item" },
      { stage: 2, lane: "systems", status: "predicted", note: "systems-thinking debate downstream of this paper" },
      { stage: 3, lane: "repos", status: "predicted", note: "repos implementing the paper's technique" },
      { stage: 4, lane: "lab-features", status: "predicted", note: "lab features adopting the technique" },
      { stage: 5, lane: "tutorials", status: "predicted", note: "creator tutorials about the technique" },
      { stage: 6, lane: "hustler", status: "predicted-terminal", note: "saturation reframe in playbook format" },
    ],
  } : null,
  items: kept.map(c => ({
    bucket: c.bucket,
    class_tag: c.class_tag,
    author: c.item.author,
    source: c.item.source,
    url: c.item.url,
    title: c.item.title,
    title_teaser: c.item.title.slice(0, 100),
    engagement_at_render: c.item.engagement,
    ts: c.item.ts,
    classification_reason: c.reason,
    corroboration_count: c.corroboration_count,
    corroborated_entities: c.corroborated_entities,
    conviction_stake: c.conviction_stake,
  })),
  dropped_as_noise: dropped.map(c => ({
    author: c.item.author,
    source: c.item.source,
    url: c.item.url,
    title_teaser: c.item.title.slice(0, 100),
    engagement_at_render: c.item.engagement,
    reason: c.reason,
  })),
};

fs.writeFileSync(`${DATA}/one-to-watch.json`, JSON.stringify(output, null, 2));
console.log(`Wrote data/one-to-watch.json — ${kept.length} kept, ${dropped.length} dropped (${classified.length} raw pre-cap)`);
console.log(`  predict-ahead: ${byBucketCapped["predict-ahead"]} (raw ${byBucketRaw["predict-ahead"]})`);
console.log(`  likely-surface: ${byBucketCapped["likely-surface"]} (raw ${byBucketRaw["likely-surface"]})`);
console.log(`  today: ${byBucketCapped["today"]} (raw ${byBucketRaw["today"]})`);
console.log(`  hustler: ${byBucketCapped["hustler"]} (raw ${byBucketRaw["hustler"]})`);
console.log(`  worked example: ${workedExample?.item.title?.slice(0, 80) ?? "(none)"}`);
