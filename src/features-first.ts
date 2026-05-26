// src/features-first.ts — feature-first pipeline.
//
// Kem spec (2026-05-16, after iter-24.5 cluster-render diagnostic showed
// clusters were the wrong unit): "What are the features? What are the people
// talking about it? Has it come up in a podcast? Link relevant Instagram,
// Twitter, etc. that relate to that feature. The fact that it comes across
// all of these places is what verifies that it's worth highlighting."
//
// Pipeline:
//   1. Candidates = frontier.json (lab blog posts) + lab X accounts.
//   2. Per candidate, extract 1-3 key entities (Haiku, deterministic).
//   3. Match entities against ALL social/community items by substring on
//      title + raw_text + meta.transcript. No LLM in match layer.
//   4. Score = distinct platforms × distinct creators. Confirmed >= 2
//      platforms AND >= 3 creators (lab announcement excluded from count
//      so corroboration is genuine — not "the lab tweeted it AND posted
//      a blog about it").
//   5. Output data/features-confirmed.json.

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { NormalizedItem } from "./types.ts";

// D-WALK-13 — deterministic content-derived feature_id (iter-29 Wave 2 prereq).
// Defect class closed: enumeration-based IDs (`xl-${out.length}` /
// `fr-${out.length}`) shift whenever the upstream candidate set adds, drops,
// or reorders an item. Iter-28's D-WALK-1 anchor-quality gate dropped card 04
// and forced a one-shot re-key of feature-sentiment.json by title because
// every following feature's index slid by one. Content-derived IDs eliminate
// this entire defect class: same URL → same ID forever.
//
// Mechanism:
//   - lab-x candidates: prefer the x.com status-id segment (the canonical
//     tweet identity); fall back to slug-hash if the URL pattern misses.
//   - frontier candidates: slug-hash of the canonical blog URL.
//   - seeded candidates: keep their hand-named `seed-*` IDs (already stable).
//
// Probe (ISC-377): two consecutive runs of features-first.ts produce
// byte-identical `data/features-confirmed.json`.
// Probe (ISC-378): no auto-extracted feature_id matches `^(xl|fr)-[0-9]+$`.
function urlSlugHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}
function deriveLabXFeatureId(url: string): string {
  const statusId = url.match(/status\/(\d+)/)?.[1];
  if (statusId) return `xl-${statusId}`;
  return `xl-${urlSlugHash(url)}`;
}
function deriveFrontierFeatureId(url: string): string {
  return `fr-${urlSlugHash(url)}`;
}

// D-WALK-8 — `is_lab_official` derived from lab-authoritative URL host OR
// from author handle membership in LAB_X_ACCOUNTS (iter-29 Wave 2).
// Defect class closed: Finance Agents card's "is it official? Anthropic
// just shipped 10 finance agents — but are they official?" authority
// ambiguity Kem named at iter-28 OBSERVE. Render layer surfaces the
// derived bool as an OFFICIAL pill in the meta-row.
//
// Mechanism: derive from canonical-host + author pair, never hardcode
// per-card. New lab announcing on existing host = automatically official;
// commentator extracting a lab feature on their own site = automatically
// NOT official. Iter-N+1 inherits the rule without re-tagging.
const LAB_OFFICIAL_HOSTS = new Set([
  "anthropic.com", "www.anthropic.com",
  "openai.com", "www.openai.com",
  "code.claude.com", "claude.com", "www.claude.com",
  "claude.ai", "www.claude.ai",
  "deepmind.google", "www.deepmind.google",
  "ai.google.dev", "blog.google",
  "x.ai", "www.x.ai",
  "ai.meta.com", "about.fb.com",
]);
function deriveIsLabOfficial(url: string, author: string): boolean {
  // Lab-X account authorship is intrinsically official (LAB_X_ACCOUNTS is
  // the verified-handle whitelist used everywhere in the pipeline).
  const handle = (author ?? "").replace(/^@/, "").trim();
  if (handle && LAB_X_ACCOUNTS.has(handle)) return true;
  // URL host match — covers frontier blogs and lab-hosted docs.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (LAB_OFFICIAL_HOSTS.has(host)) return true;
    // x.com/<lab-handle>/status/N — extract handle from path and check.
    if (host === "x.com" || host === "twitter.com" || host === "www.x.com") {
      const pathHandle = new URL(url).pathname.split("/").filter(Boolean)[0];
      if (pathHandle && LAB_X_ACCOUNTS.has(pathHandle)) return true;
    }
  } catch { /* malformed URL — fall through */ }
  return false;
}

// iter-46 close F13 — path-portability. Read/write against the current
// working directory's data/ so a cloned bundle works for any end-user.
const DATA = `${process.cwd()}/data`;

export const LAB_X_ACCOUNTS = new Set([
  "AnthropicAI", "ClaudeDevs", "claudeai", "GeminiApp",
  "Google", "GoogleDeepMind", "OpenAI", "sama", "xai",
]);

// D8 universal quality-gate mechanism (per ISC-370, advisor S1 resolve).
// The TRACKED_LABS set is DERIVED, not hardcoded, so adding a new lab is a
// data event (new frontier.json publisher) rather than a code edit. Two
// sources:
//   1. FOUNDATION_FLOOR — the five labs whose presence is structural, not
//      contingent. Removing any of these requires Kem-decision, not code
//      drift. Source: PROJECTS.md TrendingAI lineage; these are the labs
//      every iter has tracked since iter-1.
//   2. Frontier publishers within the last 90 days — any lab that's shipped
//      an announcement in the harvest window earns tracked-lab status for
//      that window. HuggingFace will pass when it's actively shipping; will
//      fail when its frontier presence goes stale. Tied to data, not opinion.
const FOUNDATION_FLOOR = new Set([
  "anthropic", "openai", "google", "googledeepmind", "deepmind",
  "xai", "x.ai", "meta", "meta ai", "metaai",
]);
const FRONTIER_TRACKING_WINDOW_DAYS = 90;

function buildTrackedLabPredicate(frontierItems: NormalizedItem[]): (lab: string) => boolean {
  // v8 determinism (iter-39) — window cutoff is relative to the latest
  // frontier harvest ts, NOT Date.now(). Same frontier.json → same tracked-
  // lab set forever. Falls back to Date.now() ONLY when frontierItems is
  // empty (degenerate case; in practice frontier always has items).
  const stamps = frontierItems
    .map((it) => new Date(it.ts).getTime())
    .filter((t) => !isNaN(t));
  const referenceMs = stamps.length > 0 ? Math.max(...stamps) : Date.now();
  const cutoff = referenceMs - FRONTIER_TRACKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentPublishers = new Set<string>();
  for (const it of frontierItems) {
    const ts = new Date(it.ts).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const pub = ((it.meta as { publisher?: string } | undefined)?.publisher ?? "").toLowerCase().trim();
    if (pub) recentPublishers.add(pub);
  }
  return (lab: string): boolean => {
    const low = lab.toLowerCase().trim();
    if (FOUNDATION_FLOOR.has(low)) return true;
    if (recentPublishers.has(low)) return true;
    return false;
  };
}

// Engagement floor for keeping a feature whose lab is NOT tracked
// AND whose distinct_creators is below the universal threshold. Captures
// the case where a non-tracked lab ships something that nonetheless gets
// massive reach (e.g. a niche actor going viral). Threshold is the same
// "high-signal lab post" floor Kem named for D4 tiering — symmetry between
// "this is worth surfacing" and "this should get a tier boost."
export const QUALITY_GATE_HIGH_ENGAGEMENT = 10_000;
// iter-46 — lowered from 5 to 4 (Kem walk 2026-05-26 — Databricks GPT-5.5 enterprise
// + Google Gemini 3.5 frontier intelligence both have 4 distinct non-lab creators,
// real cross-platform features, dropped only because the floor was one creator too
// strict. The class floor in F12 still requires xl-* to have ≥3 responses + ≥2
// creators, so this only changes the secondary creator-count threshold.
const QUALITY_GATE_MIN_CREATORS = 4;

function loadJson<T>(p: string, fb: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return fb; }
}

function loadItems(name: string): NormalizedItem[] {
  const raw = loadJson<NormalizedItem[] | { items?: NormalizedItem[] }>(`${DATA}/${name}.json`, []);
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

interface FeatureCandidate {
  feature_id: string;
  source: "frontier" | "lab-x" | "seed";
  lab: string;
  title: string;
  url: string;
  ts: string;
  entity_phrases: string[];
  // Engagement of the canonical lab-source post (if known). For lab-x and
  // seeded candidates the source is a tweet — engagement is what the lab's
  // own announcement drew. D4 tier formula uses this; D8 quality gate falls
  // back to this when distinct_creators is sparse. Zero when unknown
  // (frontier blog posts don't have a like-count proxy).
  source_engagement?: number;
  // D-WALK-8 (iter-29): derived in buildCandidates() and carried to
  // ConfirmedFeature so the renderer reads one field, not the URL pattern.
  is_lab_official?: boolean;
}

// Hand-seeded candidates for features whose canonical lab name doesn't survive
// entity extraction — either because the announcement text is lowercase
// ("agent view"), or the title has no capitalised two-word phrase ("Agents
// for financial services"), or the feature is named entirely by the creator
// community (Claude Skills, Subagents, Agent SDK). Without these seeds the
// substrate-level conversation is invisible to the pipeline even though the
// social corpus is full of it.
//
// Each seed creates a candidate that goes through the same findResponses +
// score + dedupe pipeline as auto-extracted candidates. entity_phrases are
// lowercase substrings (matching is case-insensitive). Lab + URL anchor the
// feature to a canonical source for the report.
const SEEDED_FEATURES: FeatureCandidate[] = [
  {
    feature_id: "seed-agent-view",
    source: "seed",
    lab: "Anthropic",
    title: "@claudeai: New in Claude Code: agent view. One list of all your sessions, available today as a research preview.",
    url: "https://x.com/claudeai/status/2053940934736228454",
    ts: "2026-05-11T20:50:53.000Z",
    entity_phrases: ["agent view"],
  },
  {
    feature_id: "seed-mcp",
    source: "seed",
    lab: "Anthropic",
    title: "[Anthropic] Introducing the Model Context Protocol",
    url: "https://www.anthropic.com/news/model-context-protocol",
    ts: "2026-05-07T20:07:05.000Z",
    entity_phrases: ["model context protocol", "mcp"],
  },
  {
    feature_id: "seed-agent-sdk",
    source: "seed",
    lab: "Anthropic",
    title: "Claude Agent SDK — programmatic interface for building agents (June 15 subscription policy change)",
    url: "https://x.com/ClaudeDevs/status/2054610152817619388",
    ts: "2026-05-13T00:00:00.000Z",
    entity_phrases: ["agent sdk"],
  },
  {
    feature_id: "seed-claude-skills",
    source: "seed",
    lab: "Anthropic",
    title: "Claude Skills — reusable instruction sets Claude loads on demand",
    url: "https://code.claude.com/docs/en/skills",
    ts: "2026-05-01T00:00:00.000Z",
    entity_phrases: ["claude skills"],
  },
  {
    feature_id: "seed-subagents",
    source: "seed",
    lab: "Anthropic",
    title: "Claude Code subagents — specialised child agents with isolated context",
    url: "https://code.claude.com/docs/en/sub-agents",
    ts: "2026-05-01T00:00:00.000Z",
    entity_phrases: ["subagents", "background subagents"],
  },
  {
    feature_id: "seed-finance-agents",
    source: "seed",
    lab: "Anthropic",
    title: "[Anthropic] Agents for financial services",
    url: "https://www.anthropic.com/news/finance-agents",
    ts: "2026-05-07T20:29:52.000Z",
    entity_phrases: ["finance agents", "agents for financial services"],
  },
  // iter-32 D-WALK-22 — accepted by Kem 2026-05-17 from data/seed-candidates.json.
  // Each surfaced via the iter-30 LLM pre-pass (lab-X + high-engagement +
  // empty-entity + negative-dominant reply pool). Existing-seed-collision: null.
  {
    feature_id: "seed-codex-mobile",
    source: "seed",
    lab: "OpenAI",
    title: "@OpenAI: Now in preview — Codex in the ChatGPT mobile app. Start new work, review outputs, steer execution, and approve next steps.",
    url: "https://x.com/OpenAI/status/2055016850849993072",
    ts: "2026-05-14T20:06:12.000Z",
    entity_phrases: ["codex mobile"],
  },
  {
    feature_id: "seed-us-china-ai-competition",
    source: "seed",
    lab: "Anthropic",
    title: "@AnthropicAI: We've published a paper that explains our views on AI competition between the US and China.",
    url: "https://x.com/AnthropicAI/status/2054987444664377374",
    ts: "2026-05-14T18:09:21.000Z",
    entity_phrases: ["us china ai competition"],
  },
  {
    feature_id: "seed-notebooks-in-gemini",
    source: "seed",
    lab: "Google",
    title: "@GeminiApp: Notebooks in Gemini bring organization to complex tasks like the grad school application process.",
    url: "https://x.com/GeminiApp/status/2052805372050604187",
    ts: "2026-05-08T17:38:34.000Z",
    entity_phrases: ["notebooks in gemini"],
  },
];

// Deterministic entity extraction — no LLM. Heuristic: take quoted phrases,
// proper-noun-ish runs, slash-commands, and capitalized 2-3 word product names.
// Filter generic AI/Code/Tool tokens so we match on the distinctive name.
const GENERIC_STOPWORDS = new Set([
  "ai", "the", "a", "an", "and", "or", "but", "in", "on", "at", "of", "to",
  "for", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "can", "could", "may", "might", "must", "shall", "this", "that", "these",
  "those", "what", "when", "where", "why", "how", "new", "now", "today",
  "introducing", "introduces", "introduced", "launching", "launches",
  "launched", "announces", "announced", "shipped", "ships", "release",
  "releases", "released", "update", "updates", "updated", "use", "using",
  "used", "build", "building", "built", "make", "making", "made", "code",
  "tool", "tools", "model", "models", "research", "team", "company",
  "openai", "anthropic", "google", "deepmind", "claude", "gemini", "grok",
  "chatgpt", "gpt", "llm", "ml", "agent", "agents", "feature", "features",
]);

// Generic product containers — these are NOT features, they are platforms
// that many features ship into. Matching on these creates massive noise
// (e.g. "Claude Code" appears in 100+ creator posts about 20 different
// features). Block them from entity list. Also blocks lab account handles
// that the CamelCase regex would otherwise grab from titles.
const GENERIC_PRODUCTS = new Set([
  "claude code", "claude api", "claude desktop", "claude chat",
  "chatgpt", "chat gpt", "openai api", "openai platform",
  "google ai", "google cloud", "google deepmind",
  "anthropic api", "anthropic console",
  "gemini api", "gemini app", "gemini advanced",
  "grok api", "grok web",
  "codex cli", "codex web",
  "cursor", "claude", "openai", "anthropic", "google", "deepmind",
  "gemini", "grok", "codex", "chatgpt", "api", "windows", "macos",
  "linux", "android", "ios", "iphone", "ipad", "mac",
  // Lab account handles (CamelCase regex picks these up from titles)
  "anthropicai", "claudedevs", "claudeai", "geminiapp",
  "googledeepmind", "openai", "xai",
  // iter-46 — distribution / content platforms. Defect class closed (Kem
  // walk 2026-05-26): feature title "Listen to the OpenAI Podcast on Spotify
  // / Apple / YouTube" → extractEntities returned ["YouTube"] → matched on
  // every post containing "YouTube" (TikTok creators on YouTube automation,
  // X posts about YouTube money), zero of which are about the OpenAI Podcast
  // launch. Platform names appear in launch posts as channel labels, not as
  // the feature itself; if a real feature ever IS named after one of these
  // (unlikely), it'd land as a slash-command or versioned-model match anyway.
  "youtube", "spotify", "tiktok", "instagram", "facebook", "twitter",
  "linkedin", "reddit", "discord", "slack", "github",
  "apple podcasts", "google podcasts", "amazon music", "soundcloud",
]);

// D-WALK-1 — Anchor-term quality gate (iter-28 structural fix).
// Defect class: a single generic English word ("recently", "today", "soon")
// gets extracted by extractFeatureFromAnnouncement and becomes an anchor;
// then substring-matched against every social post containing that word,
// producing ~15-item cards with zero semantic relevance to the lab feature.
// Root example: iter-27 card 04 — feature title "...including one we shipped
// recently" → anchor "recently" → matched on karpathy/Theo/agentic.james/
// simonw/gazi.ai for posts that have nothing to do with keeping Claude
// working until job-done.
//
// Mechanism: ANY phrase extracted as an anchor must be one of:
//   (a) slash-command — "/goal"
//   (b) hashtag — "#claudecode"
//   (c) versioned model name — "Opus 4.7", "GPT-5.5"
//   (d) multi-word phrase whose first token is not an adverb/stopword
//   (e) proper-noun-style single token (handled by extractEntities' CamelCase
//       regex; isValidAnchorPhrase only sees lowercase-normalized phrases from
//       extractFeatureFromAnnouncement and rejects single lowercase words).
//
// The test: would this same fix prevent a future not-yet-observed instance
// of the same defect class? Yes — any future "...we shipped soon" or "now
// available today" lab title rejects "soon" / "today" by the same rule.
const TIME_INTENSITY_ADVERBS = new Set([
  "recently", "soon", "today", "currently", "lately", "briefly",
  "finally", "mostly", "really", "just", "quite", "rather",
  "now", "yesterday", "tomorrow", "earlier", "later",
  "always", "never", "often", "sometimes", "usually", "almost",
  "nearly", "actually", "basically", "essentially", "literally",
  "simply", "totally", "completely", "entirely", "fully", "partly",
  "kind", "very", "still", "yet", "already", "again",
  "here", "there", "everywhere", "anywhere", "nowhere",
]);

// ISC-410 (iter-31) — narrowly-scoped gerunds that act as time-adverbs in
// lab announcement titles. The Two-word Title-Case regex in extractEntities
// captures phrases like "Starting June 15" or "Coming Soon" — neither names
// a feature, both are temporal scaffolding around an announcement. This set
// stays small on purpose: lifting it wholesale to all common gerunds would
// kill legitimate entities like "Reading Comprehension". Only gerunds that
// repeatedly show up as Title-Case lead-words on social posts AND never as
// the first word of a real product name make the list.
//
// Worked example (iter-30 close): @ClaudeDevs Agent-SDK June-15 dedicated-
// credit post → extractEntities returned ["Starting June 15"] → D-WALK-22's
// empty-entity gate routed around the post entirely. Without this set the
// gate would never see real Agent-SDK-class drama.
const ANNOUNCEMENT_VERB_GERUNDS = new Set([
  "starting", "going", "coming", "moving", "shipping", "rolling",
  "getting", "making", "becoming", "trying", "testing",
  "ending", "stopping", "leaving",
]);

// ISC-410 (iter-31) — first-word reject set for multi-word entity phrases.
// This is DERIVED FROM GENERIC_STOPWORDS minus lab/product names that ARE
// valid first words in real two-word product names ("Claude Design", "Grok
// Build", "OpenAI Codex", "Agent View", "Model Context Protocol", etc.).
// The narrow set covers: auxiliary verbs, articles, prepositions, wh-words,
// and the "new"/"now"-class generic intros — none of which ever lead a real
// product name. Lab/product family names ("claude", "openai", "agent",
// "model", "code", "tool", "gpt") are intentionally excluded.
//
// Mechanism: extractEntities' Two-word Title-Case regex captures any
// "Capital Capital" sequence in a title — "Is Claude Down" → "Is Claude"
// would silently become an anchor without this gate. The fix mirrors the
// check isValidAnchorPhrase already does for the announcement-fallback path,
// closing the consistency gap iter-30 close named.
const FIRST_WORD_REJECT_AUX = new Set([
  "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "should", "can", "could", "may", "might", "must", "shall",
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "of", "to",
  "for", "with", "by", "from",
  "this", "that", "these", "those", "what", "when", "where", "why", "how",
  "new",
]);

export function isDistinctiveEntity(s: string): boolean {
  const norm = s.toLowerCase().trim();
  if (norm.length < 3) return false;
  if (GENERIC_STOPWORDS.has(norm)) return false;
  if (GENERIC_PRODUCTS.has(norm)) return false;
  if (TIME_INTENSITY_ADVERBS.has(norm)) return false;
  // Generic launch-phrase prefixes ("Introducing Claude", "Introducing the X")
  // — common in lab announcement titles, not actual feature names. Without this
  // filter, every Anthropic announcement extracts "Introducing Claude" and
  // the dedupe step collapses unrelated features as duplicates.
  if (/^(introducing|introduction)\b/.test(norm)) return false;
  if (/^(announcing|launching|presenting)\b/.test(norm)) return false;
  // ISC-410 (iter-31) — first-word reject for multi-word phrases.
  // Worked example: "Starting June 15" used to pass (no single-word match in
  // any stop set), now rejects because "starting" is in
  // ANNOUNCEMENT_VERB_GERUNDS. "Reading Comprehension" still passes —
  // "reading" is not in any reject set. "Grok Build" / "Claude Design"
  // still pass — lab names are NOT in FIRST_WORD_REJECT_AUX by design.
  const words = norm.split(/\s+/);
  if (words.length >= 2) {
    const first = words[0] ?? "";
    if (TIME_INTENSITY_ADVERBS.has(first)) return false;
    if (FIRST_WORD_REJECT_AUX.has(first)) return false;
    if (ANNOUNCEMENT_VERB_GERUNDS.has(first)) return false;
  }
  return true;
}

function isValidAnchorPhrase(phrase: string): boolean {
  const norm = phrase.toLowerCase().trim();
  if (norm.length < 3) return false;
  if (GENERIC_STOPWORDS.has(norm)) return false;
  if (GENERIC_PRODUCTS.has(norm)) return false;
  if (TIME_INTENSITY_ADVERBS.has(norm)) return false;
  if (norm.startsWith("/")) return true; // slash-command
  if (norm.startsWith("#")) return true; // hashtag
  // Versioned model name in the phrase
  if (/\b(opus|sonnet|haiku|gpt|claude|grok|gemini|mercury|deepseek|llama|mistral|qwen|kimi)[-\s]?\d+(\.\d+)?\b/i.test(norm)) return true;
  const words = norm.split(/\s+/);
  if (words.length >= 2) {
    // Multi-word: first token must not be a stopword/adverb — otherwise the
    // phrase is really a fragment that begins after the lab verb ("shipped
    // recently in claude code" → captured "recently in claude code" → first
    // token "recently" is an adverb, reject).
    const first = words[0] ?? "";
    if (TIME_INTENSITY_ADVERBS.has(first)) return false;
    if (GENERIC_STOPWORDS.has(first)) return false;
    return true;
  }
  // Single-word lowercase phrase from an announcement pattern is rejected.
  // Proper-noun single tokens come from extractEntities' CamelCase regex
  // and don't pass through this function — they enter via isDistinctiveEntity.
  return false;
}

// Fallback extractor for lab announcements where the canonical entity is
// lowercase or otherwise misses the Title-Case regex (e.g. "New in Claude
// Code: agent view"). Pulls the noun phrase that follows announcement verbs.
// Lowercase OK because match layer is case-insensitive.
export function extractFeatureFromAnnouncement(text: string): string[] {
  const t = text.toLowerCase();
  const patterns = [
    /new in [a-z 0-9]+:\s+([a-z][a-z 0-9_/\-]{2,40})/,
    /introducing (?:the )?([a-z][a-z 0-9_/\-]{2,40})/,
    /announcing (?:the )?([a-z][a-z 0-9_/\-]{2,40})/,
    /(?:now available|shipped|now in research preview)[: ]+([a-z][a-z 0-9_/\-]{2,40})/,
    /released[: ]+([a-z][a-z 0-9_/\-]{2,40})/,
  ];
  const out: string[] = [];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const phrase = m[1].trim().replace(/\s+/g, " ").replace(/[.,!?;:].*$/, "");
      // D-WALK-1 gate: phrase must pass anchor-quality check before becoming
      // a feature anchor. Replaces the old length/GENERIC_PRODUCTS/STOPWORDS
      // triad which let "recently" / "today" / "soon" through.
      if (isValidAnchorPhrase(phrase)) {
        out.push(phrase);
      }
    }
  }
  // Dedupe
  return Array.from(new Set(out));
}

export function extractEntities(title: string): string[] {
  // 1. slash-commands like /goal, /caveman
  const slashCommands = (title.match(/\/[a-z][a-z0-9_-]{2,}/g) ?? []);
  // 2. CamelCase / PascalCase product names like "Codex", "Sora", "Veo", "Whisper", "DeepSeek"
  const camelCase = (title.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []);
  // 3. Two-word capitalized phrases like "Claude Design", "Grok Build", "Codex CLI"
  const twoWord = (title.match(/\b[A-Z][a-z]+ [A-Z][a-z]+(?:\s+\d+(?:\.\d+)?)?\b/g) ?? []);
  // 4. Quoted strings
  const quoted = (title.match(/["']([^"']{4,40})["']/g) ?? []).map((s) => s.replace(/^["']|["']$/g, ""));
  // 5. Versioned model names like "Opus 4.7", "GPT-5.5", "Gemini 3 Flash"
  const versioned = (title.match(/\b(?:Opus|Sonnet|Haiku|GPT|Claude|Gemini|Grok|Llama|DeepSeek)[\s-]?\d+(?:\.\d+)?(?:[\s-][A-Z][a-z]+)?\b/g) ?? []);

  const candidates = [...slashCommands, ...camelCase, ...twoWord, ...quoted, ...versioned]
    .map((s) => s.trim())
    .filter(isDistinctiveEntity);

  // Dedup + cap at 3 most distinctive (prefer longest)
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

// Index X items by status-id so seed/lab-x candidates whose URL is an x.com
// tweet can lookup their canonical lab-post engagement. Per ISC-376 (advisor
// S7 BLOCKING resolve) — without this, D4 tier-boost and D8 quality gate
// silently default to 0 and Agent View never elevates.
function indexXByStatusId(items: NormalizedItem[]): Map<string, NormalizedItem> {
  const m = new Map<string, NormalizedItem>();
  for (const it of items) {
    const id = (it.url ?? "").match(/status\/(\d+)/)?.[1];
    if (id) m.set(id, it);
  }
  return m;
}

function lookupSourceEngagement(url: string, xByStatusId: Map<string, NormalizedItem>): number {
  const id = url.match(/status\/(\d+)/)?.[1];
  if (!id) return 0;
  const item = xByStatusId.get(id);
  return item?.engagement ?? 0;
}

function buildCandidates(xItems: NormalizedItem[], xByStatusId: Map<string, NormalizedItem>): FeatureCandidate[] {
  const out: FeatureCandidate[] = [];
  const frontier = loadItems("frontier");
  for (const it of frontier) {
    const lab = ((it.meta as { publisher?: string } | undefined)?.publisher) ?? "lab";
    const entities = extractEntities(it.title);
    if (entities.length === 0) continue;
    out.push({
      feature_id: deriveFrontierFeatureId(it.url),
      source: "frontier",
      lab,
      title: it.title,
      url: it.url,
      ts: it.ts,
      entity_phrases: entities,
      source_engagement: 0, // frontier blog posts have no like-count proxy
      is_lab_official: deriveIsLabOfficial(it.url, ""),
    });
  }
  for (const it of xItems) {
    const author = ((it.meta as { author?: string } | undefined)?.author) ?? "";
    if (!LAB_X_ACCOUNTS.has(author)) continue;
    // Two-stage extraction: Title-Case regexes first (existing), then
    // announcement-pattern fallback for lowercase feature names.
    let entities = extractEntities(it.title);
    if (entities.length === 0) {
      entities = extractFeatureFromAnnouncement((it.title ?? "") + " " + (it.raw_text ?? ""));
    }
    if (entities.length === 0) continue;
    out.push({
      feature_id: deriveLabXFeatureId(it.url),
      source: "lab-x",
      lab: author,
      title: it.title,
      url: it.url,
      ts: it.ts,
      entity_phrases: entities,
      source_engagement: it.engagement ?? 0,
      is_lab_official: deriveIsLabOfficial(it.url, author),
    });
  }
  // Resolve source_engagement + is_lab_official for SEEDED features whose
  // canonical URL is an x.com tweet. The seed entries already have URL +
  // lab name — engagement is looked up from the x.json corpus; lab-official
  // is derived from URL host / x.com path handle per deriveIsLabOfficial().
  for (const seed of SEEDED_FEATURES) {
    seed.source_engagement = lookupSourceEngagement(seed.url, xByStatusId);
    seed.is_lab_official = deriveIsLabOfficial(seed.url, "");
  }
  return out;
}

interface ResponseItem {
  source: string;
  author: string;
  url: string;
  title: string;
  match_in: "title" | "raw_text" | "transcript";
  matched_entity: string;
  engagement: number;
}

// Lab and product names that should appear in the same window as a matched
// entity for transcript matches on generic 1-2 word entities. Without an
// anchor, "small business" matched in a Spencer Pratt LA podcast is noise,
// not evidence of creator buy-in to "Claude for Small Business".
const ANCHOR_TERMS = [
  "claude", "anthropic", "opus", "sonnet",
  "openai", "gpt", "chatgpt", "sora", "codex",
  "google", "gemini", "deepmind",
  "grok", "xai", "x.ai",
  "huggingface", "hugging face",
  "meta ai", "llama",
  "mistral", "deepseek", "qwen", "kimi", "moonshot",
];

function entityRequiresAnchor(entity: string): boolean {
  // Slash commands are intrinsically distinctive
  if (entity.startsWith("/")) return false;
  // Versioned model names like "Opus 4.7", "GPT-5.5"
  if (/\d/.test(entity)) return false;
  // 3+ word phrases are usually specific enough
  const wordCount = entity.split(/\s+/).length;
  if (wordCount >= 3) return false;
  return true;
}

// iter-46 F9 — tightened window + self-overlap guard + feature-specific token requirement.
// Defect class closed (UAT examples):
//   • "Grok Build" feature cites a SpaceX/NVIDIA All-In Podcast — "grok" was a substring
//     of "grok build" so it self-anchored its own match. Now "grok" cannot count as anchor
//     when entity contains "grok".
//   • "Project Glasswing" feature cites a Codex Tips podcast — "anthropic" appeared in
//     passing within ±300 but no other Glasswing-specific token was nearby. Now requires
//     a feature-specific token from candidate's OTHER entity phrases (single-entity
//     candidates fall back to ≥2 distinct anchor terms, a multi-anchor saturation check).
// Window narrowed 300 → 200 per UAT_FINDINGS.md spec (tighter coupling = less passing-mention noise).
const ANCHOR_WINDOW_RADIUS = 200;
function windowHasAnchor(text: string, entityLow: string, candidate: FeatureCandidate): boolean {
  const idx = text.indexOf(entityLow);
  if (idx < 0) return false;
  const start = Math.max(0, idx - ANCHOR_WINDOW_RADIUS);
  const end = Math.min(text.length, idx + entityLow.length + ANCHOR_WINDOW_RADIUS);
  const window = text.slice(start, end);

  // Tokens that are part of the matched entity itself — these cannot count as anchors
  // (a match supplying its own anchor is circular). E.g. "grok" in "grok build".
  const entityTokens = new Set(entityLow.split(/\s+/).filter((t) => t.length > 0));

  const labLow = candidate.lab.toLowerCase();
  const labIsValidAnchor = labLow && labLow !== "lab" && !entityTokens.has(labLow);
  const otherAnchors = ANCHOR_TERMS.filter((a) => !entityTokens.has(a));

  const hasLabAnchor = labIsValidAnchor && window.includes(labLow);
  const matchingOtherAnchors = otherAnchors.filter((a) => window.includes(a));
  const hasAnyAnchor = hasLabAnchor || matchingOtherAnchors.length > 0;
  if (!hasAnyAnchor) return false;

  // Feature-specific tokens: distinctive words from the candidate's OTHER entity phrases,
  // minus tokens already in the matched entity. Proves the discussion is ABOUT this
  // specific feature, not just adjacent to its lab name.
  const otherPhraseTokens = candidate.entity_phrases
    .filter((p) => p.toLowerCase() !== entityLow)
    .flatMap((p) => p.toLowerCase().split(/\s+/))
    .filter((tok) => tok.length >= 4 && !entityTokens.has(tok));

  if (otherPhraseTokens.length > 0) {
    // Multi-phrase candidate: require at least one OTHER feature-specific token in window.
    return otherPhraseTokens.some((tok) => window.includes(tok));
  }

  // Single-phrase candidate fallback: require multi-anchor saturation (≥2 distinct
  // non-overlapping anchor terms in window) — a single passing lab mention is not enough,
  // but if the window cites the lab AND two of its other products/families the discussion
  // is plausibly in-domain.
  const distinctAnchorCount = (hasLabAnchor ? 1 : 0) + matchingOtherAnchors.length;
  return distinctAnchorCount >= 2;
}

function findResponses(
  candidate: FeatureCandidate,
  socialItems: NormalizedItem[],
  excludeLabAccounts: boolean,
): ResponseItem[] {
  const responses: ResponseItem[] = [];
  for (const it of socialItems) {
    if (it.url === candidate.url) continue;
    const meta = (it.meta as { author?: string; transcript?: string } | undefined) ?? {};
    const author = meta.author ?? "";
    if (excludeLabAccounts && LAB_X_ACCOUNTS.has(author)) continue;
    const titleLow = (it.title ?? "").toLowerCase();
    const rawLow = (it.raw_text ?? "").toLowerCase();
    const transLow = (meta.transcript ?? "").toLowerCase();
    for (const entity of candidate.entity_phrases) {
      const e = entity.toLowerCase();
      let match_in: "title" | "raw_text" | "transcript" | null = null;
      if (titleLow.includes(e)) match_in = "title";
      else if (rawLow.includes(e)) match_in = "raw_text";
      else if (transLow.includes(e)) {
        // Transcript matches on generic entities require a lab/anchor in the window.
        // iter-46 F9: windowHasAnchor signature now takes the candidate so it can
        // check feature-specific tokens (UAT off-topic citation defect class).
        if (entityRequiresAnchor(entity) && !windowHasAnchor(transLow, e, candidate)) {
          continue; // skip — likely generic-entity noise
        }
        match_in = "transcript";
      }
      if (match_in) {
        responses.push({
          source: it.source,
          author,
          url: it.url ?? "",
          title: it.title ?? "",
          match_in,
          matched_entity: entity,
          engagement: it.engagement ?? 0,
        });
        break;
      }
    }
  }
  return responses;
}

// Collapse near-duplicate features: if a lower-scored feature shares >=50% of
// its entity vocabulary with a higher-scored kept feature, drop it. This kills
// the "Opus 4.7 lab post" + "Opus 4.7 Fast Mode tweet" twin-card pattern where
// both candidates extract overlapping entities and pull the same citation pool.
function dedupeByEntityOverlap(features: ConfirmedFeature[]): ConfirmedFeature[] {
  const kept: ConfirmedFeature[] = [];
  for (const f of features) {
    const fEnts = new Set(f.entities.map((e) => e.toLowerCase()));
    if (fEnts.size === 0) { kept.push(f); continue; }
    let isDup = false;
    for (const k of kept) {
      const kEnts = new Set(k.entities.map((e) => e.toLowerCase()));
      let overlap = 0;
      for (const e of fEnts) if (kEnts.has(e)) overlap++;
      if (overlap / fEnts.size >= 0.5) { isDup = true; break; }
    }
    if (!isDup) kept.push(f);
  }
  return kept;
}

// D1 — Response-pool dedupe (structural fix). Defect class: two "different"
// features sharing the same evidence. Mechanism: pair-wise comparison of
// confirmed features after entity-overlap dedupe; if a lower-scored feature
// B's response URLs are >=70% subset of a higher-scored A's responses, then
// B's unique-to-B responses are absorbed into A and B is dropped.
//
// Threshold derivation (per ISC-374): 70% = majority (>50%) + 20-point
// buffer to prevent flapping at the boundary. Chosen because a feature
// whose evidence is >50% another's already shares more than it doesn't,
// and the buffer keeps borderline cases from collapsing on a single-item
// swing. Single named constant; future tuning is a one-line edit.
//
// No score-ratio guard: the entity-overlap dedupe pass already removes
// candidates sharing >=50% of entity vocabulary, so any two features that
// reach this pass have distinct entity sets. Score divergence between
// such features (e.g. /goal score=39 vs "how do you keep Claude" score=12)
// reflects unique-to-each evidence, not that they're separate features —
// the subset criterion correctly identifies the smaller one as a sub-aspect.
function dedupeByResponsePool(features: ConfirmedFeature[]): ConfirmedFeature[] {
  const SUBSET_THRESHOLD = 0.70;
  // Process in score order so the "higher-scored A" is always already kept.
  const sorted = [...features].sort((a, b) => b.score - a.score);
  const kept: ConfirmedFeature[] = [];
  for (const b of sorted) {
    const bUrls = new Set(b.responses.map((r) => r.url));
    if (bUrls.size === 0) { kept.push(b); continue; }
    let absorbedInto: ConfirmedFeature | null = null;
    for (const a of kept) {
      if (a.score < b.score) continue; // a must outscore b
      const aUrls = new Set(a.responses.map((r) => r.url));
      let overlap = 0;
      for (const u of bUrls) if (aUrls.has(u)) overlap++;
      const subsetRatio = overlap / bUrls.size;
      if (subsetRatio >= SUBSET_THRESHOLD) {
        absorbedInto = a;
        break;
      }
    }
    if (absorbedInto) {
      // Merge b's unique-to-b responses into a so no evidence is lost
      const aUrls = new Set(absorbedInto.responses.map((r) => r.url));
      for (const r of b.responses) {
        if (!aUrls.has(r.url)) absorbedInto.responses.push(r);
      }
      // Recompute platform/creator counts after merge
      const platforms = new Set(absorbedInto.responses.map((r) => r.source));
      const creators = new Set(absorbedInto.responses.map((r) => r.author).filter((a) => a.length > 0));
      absorbedInto.distinct_platforms = platforms.size;
      absorbedInto.distinct_creators = creators.size;
      absorbedInto.score = platforms.size * creators.size;
    } else {
      kept.push(b);
    }
  }
  // Re-sort by (possibly bumped) score so output order is stable
  return kept.sort((a, b) => b.score - a.score);
}

// D2 — Wrong-context match filter (structural fix). Defect class: a generic
// entity ("agent", "design", "build", "cyber") matched in a post that's
// actually about a DIFFERENT named feature. Mechanism: when an entity is
// short (≤2 words) or in a generic-stoplist, AND the post's text has higher
// overlap with another feature's entities than with ours, drop the match as
// wrong-context. Per-feature pass — receives ownEntities + the union of
// every OTHER feature's entities. Iter-28+ inherits this without re-fixing
// the same Tibo-as-GPT-5.5-Cyber defect.
const WRONG_CONTEXT_STOPLIST = new Set([
  "agent", "agents", "design", "build", "code", "skills", "skill",
  "cyber", "trust", "access", "view", "credit", "credits", "plan",
  "plans", "session", "sessions", "preview", "free", "pro", "max",
]);

function entityIsGenericForCrossFeatureCheck(entity: string): boolean {
  const norm = entity.toLowerCase().trim();
  if (norm.startsWith("/")) return false; // slash-commands are intrinsically distinctive
  if (/\d/.test(norm)) return false; // versioned model names
  const words = norm.split(/\s+/);
  if (words.length >= 3) return false; // 3+ word phrases are usually specific
  if (WRONG_CONTEXT_STOPLIST.has(norm)) return true;
  if (words.length <= 2) return true;
  return false;
}

function countEntityMatches(text: string, entities: string[]): number {
  let n = 0;
  for (const e of entities) {
    const el = e.toLowerCase();
    if (el.length < 3) continue;
    if (text.includes(el)) n++;
  }
  return n;
}

// Per ISC-373 (advisor S4 resolve): margin requirement (other must beat
// matched by ≥2, not just strict-greater) prevents tie-break false positives
// where a post genuinely cross-references both features. Telemetry log lets
// iter-28 audit drops without re-running.
const WRONG_CONTEXT_MARGIN = 2;
const WRONG_CONTEXT_LOG_PATH = `${DATA}/wrong-context-drops.jsonl`;

function filterWrongContextResponses(
  feature: ConfirmedFeature,
  socialIndex: Map<string, NormalizedItem>,
  otherFeatureEntities: string[],
  dropLog: string[],
): ResponseItem[] {
  return feature.responses.filter((r) => {
    if (!entityIsGenericForCrossFeatureCheck(r.matched_entity)) return true;
    const item = socialIndex.get(r.url);
    if (!item) return true; // can't check — keep conservatively
    const text = ((item.title ?? "") + " " + (item.raw_text ?? "")).toLowerCase();
    const ownMatches = countEntityMatches(text, feature.entities);
    const otherMatches = countEntityMatches(text, otherFeatureEntities);
    if (otherMatches >= ownMatches + WRONG_CONTEXT_MARGIN) {
      dropLog.push(JSON.stringify({
        feature_id: feature.feature_id,
        url: r.url,
        matched_entity: r.matched_entity,
        own_count: ownMatches,
        other_count: otherMatches,
      }));
      return false;
    }
    return true;
  });
}

// D8 — Universal feature quality gate (structural fix, per ISC-370 derived).
// Defect class: noise features clear the bar with thin signal (HuggingFace
// Building Blocks with 4 creators and no engagement). Mechanism: feature
// must pass ANY of three clauses — distinct_creators >= 5, lab is tracked
// (per derived isTrackedLab predicate), or source_engagement >= 10k. A
// feature failing all three is dropped. Iter-28+ inherits this without
// per-card "drop HuggingFace" patches. The isTrackedLab predicate is
// data-derived (foundation-floor + 90-day frontier presence), so a lab
// goes stale automatically and a new lab promotes automatically — no
// hardcoded constant maintenance.
// iter-46 F12 — minimum substantive evidence floor per feature class.
// Defect class closed: tracked-lab bypass was waiving the creator threshold
// completely, so Gemini Omni (xl-* from GoogleDeepMind) passed with 0 responses,
// 0 creators, src_eng=3780. Being a tracked lab proves the lab matters; it
// doesn't prove THIS specific announcement has cross-platform signal worth a
// dedicated card. After F12: lab-X candidates need ≥3 responses + ≥2 distinct
// non-lab creators; frontier candidates need ≥2 responses + ≥1 creator. Seeded
// features bypass (they're explicitly curated entry points).
const FEATURE_CLASS_FLOORS = {
  xl: { responses: 3, creators: 2 },
  fr: { responses: 2, creators: 1 },
} as const;

function meetsClassFloor(f: ConfirmedFeature): boolean {
  const responseCount = f.responses?.length ?? 0;
  if (f.feature_id.startsWith("xl-")) {
    return responseCount >= FEATURE_CLASS_FLOORS.xl.responses && f.distinct_creators >= FEATURE_CLASS_FLOORS.xl.creators;
  }
  if (f.feature_id.startsWith("fr-")) {
    return responseCount >= FEATURE_CLASS_FLOORS.fr.responses && f.distinct_creators >= FEATURE_CLASS_FLOORS.fr.creators;
  }
  // Seeded features (seed-*) skip the class floor — they're hand-curated entry
  // points — BUT iter-46 close added a baseline: a seed with zero evidence
  // renders an empty card with no notable_quotes / praises / complaints to
  // display, which is visible noise. Require ≥1 response. Hand-curated seeds
  // without any creator pickup this cycle simply don't surface until the
  // substrate appears.
  return (f.responses?.length ?? 0) >= 1;
}

function passesQualityGate(f: ConfirmedFeature, isTrackedLab: (lab: string) => boolean): boolean {
  // iter-46 F12: class floor is a hard prerequisite. Tracked-lab + source-eng
  // bypasses still exist for high-volume / strong-substrate cases, but they no
  // longer waive the basic "this feature has cited evidence" requirement.
  if (!meetsClassFloor(f)) return false;

  if (f.distinct_creators >= QUALITY_GATE_MIN_CREATORS) return true;
  if (isTrackedLab(f.lab)) return true;
  if ((f.source_engagement ?? 0) >= QUALITY_GATE_HIGH_ENGAGEMENT) return true;
  return false;
}

// Build a combined social-item index by URL across all sources, for
// filterWrongContextResponses to look up original post text. Constructed
// once per main() run.
function buildSocialIndex(sources: NormalizedItem[][]): Map<string, NormalizedItem> {
  const m = new Map<string, NormalizedItem>();
  for (const arr of sources) for (const it of arr) if (it.url) m.set(it.url, it);
  return m;
}

// D-WALK-12 — Notable-this-period (not feature-tied) panel.
// Defect class addressed: D-WALK-1's anchor stoplist correctly rejects
// generic-word matches (e.g. "recently"), but the underlying social posts
// (karpathy on HTML rendering, agentic.james on GSD framework) are
// independently interesting signal from whitelisted creators. Without
// D-WALK-12 these posts silently disappear from the report — D-WALK-1
// closes a noise channel but opens a signal channel that has nowhere to go.
//
// Mechanism: after all features are confirmed and quality-gated, scan ALL
// social items for ones where (a) author is a known notable handle or lab
// account, (b) engagement ≥ NOTABLE_ENGAGEMENT_FLOOR, (c) URL not claimed
// by any feature's response pool. Emit top-N (by engagement) to
// data/notable-orphans.json for the renderer to slot between T1 and T2.
//
// Whitelist construction: lab accounts (LAB_X_ACCOUNTS) plus a curated
// notable-creator set drawn from existing harvester whitelists (X, TT, IG,
// YT). Kept inline to avoid module-coupling; sync with harvester files
// when handles are added/removed. Adding a handle is a one-line edit.
const NOTABLE_CREATOR_HANDLES = new Set([
  // X creators (research / podcaster / influencer voices)
  "karpathy", "simonw", "agentic.james", "Theo", "theo", "fireship",
  "Saranormous", "eladgil", "harrystebbings", "omarsar0", "_akhaliq",
  "fchollet", "hardmaru", "YannicKilcher", "TheAhmadOsman", "DanielMiessler",
  "ColeMedin", "MervinPraison", "nicksaraev", "LiamOttley", "milesdeutscher",
  "danshipper", "natolambert", "labenz", "askalphaxiv", "AlexFinn",
  "businessbarista", "tenex_labs", "alexisohanian", "JinjingLiang",
  "augmentcode", "bridgemindai", "hasantoxr", "rubenhassid",
  "thsottiaux", "trikcode", "karthikponna19", "AsymEdge", "rentierdigital_phil",
  "DataChaz", "charliejhills", "bcherny", "sairahul1", "Venkydotdev",
  // TT/IG/YT creators
  "sabrina_ramonov", "bio_makers1", "rileybrown.ai", "tommythings",
  "gazi.ai", "adam.digital", "brandnat", "kanekallaway", "justinfineberg",
  "danmartell", "yourchatgptguide", "handlytech", "rpn", "harpercarrollai",
  "therundownai", "Chase-H-AI",
]);

function isNotableAuthor(author: string): boolean {
  if (!author) return false;
  const norm = author.replace(/^@/, "").trim();
  if (LAB_X_ACCOUNTS.has(norm)) return true;
  if (NOTABLE_CREATOR_HANDLES.has(norm)) return true;
  if (NOTABLE_CREATOR_HANDLES.has(norm.toLowerCase())) return true;
  return false;
}

interface NotableOrphan {
  source: string;
  author: string;
  url: string;
  title: string;
  raw_text: string;
  engagement: number;
  ts: string;
}

const NOTABLE_ENGAGEMENT_FLOOR = 1000;
const NOTABLE_MAX_EMIT = 30;
// D-WALK-20 (iter-31) — per-platform cap for the initial selection pass.
// Math.ceil(NOTABLE_MAX_EMIT / 4) = 8 assumes ≥4 platforms could contribute
// (x / tiktok / instagram / youtube — reddit / hn / bluesky / etc. also
// emit orphans but at lower volume). The number is held in code, not env,
// because changing it changes the rendered top-12 mix — should be a code
// review decision. Pass 2 backfills any leftover slots respecting only the
// per-author cap, so a platform-starved cycle still hits NOTABLE_MAX_EMIT.
const NOTABLE_PER_PLATFORM_INITIAL_CAP = 8;

// ISC-418 / D-WALK-20 (iter-31) — Notable platform-balance rebalance.
//
// Defect class (iter-29 close): top-12 Notable panel dominated by TikTok
// creators with 100k-650k engagement (Justin Fineberg 657k, RileyBrown 397k,
// Brandnat 302k...) because pure engagement-desc sort is platform-blind.
// X-platform creators Kem named (karpathy 49k, agentic.james 9.8k, simonw
// 776) sit further down the engagement list and never reach top-12 visible.
// Result: the panel reads as "TT viral noise" instead of "high-signal posts
// from creators we care about."
//
// Mechanism: two-pass selection.
//   Pass 1 — cap-1-per-author AND cap-per-platform (NOTABLE_PER_PLATFORM_
//     INITIAL_CAP). Author dedupe first (rileybrown.ai's 2 top posts collapse
//     to 1); platform cap caps TikTok at 8 even if it has 23 viral candidates.
//   Pass 2 — backfill remaining slots from the same engagement-desc pool,
//     respecting ONLY the per-author cap. This way a cycle where IG/YT
//     produced no orphans still emits NOTABLE_MAX_EMIT items (the platform
//     cap was a balance hint, not a hard ceiling).
//
// Anti-corner-case: when distinct_authors_in_pool < NOTABLE_MAX_EMIT, the
// output length is exactly distinct_authors_in_pool. This is intentional —
// emitting the same author twice in the Notable panel is the original
// defect we're closing.
//
// Renderer-side coupling: render-features-first.ts slices top-12 from the
// emitted pool. With pass 1 enforcing ≤8 per platform, top-12 reliably
// contains ≥4 non-TikTok orphans (assuming ≥4 platforms produced any).
export function rebalanceNotableOrphans(
  orphans: NotableOrphan[],
  maxEmit: number,
  perPlatformCap: number = NOTABLE_PER_PLATFORM_INITIAL_CAP,
): NotableOrphan[] {
  // orphans assumed pre-sorted by engagement desc; defensive copy.
  const sorted = [...orphans].sort((a, b) => b.engagement - a.engagement);
  const out: NotableOrphan[] = [];
  const seenAuthors = new Set<string>();
  const platformCounts = new Map<string, number>();

  // Pass 1: cap-1-per-author + cap-per-platform.
  for (const o of sorted) {
    if (out.length >= maxEmit) break;
    if (!o.author) continue;
    if (seenAuthors.has(o.author)) continue;
    const platCount = platformCounts.get(o.source) ?? 0;
    if (platCount >= perPlatformCap) continue;
    out.push(o);
    seenAuthors.add(o.author);
    platformCounts.set(o.source, platCount + 1);
  }

  // Pass 2: backfill respecting only the per-author cap.
  if (out.length < maxEmit) {
    for (const o of sorted) {
      if (out.length >= maxEmit) break;
      if (!o.author) continue;
      if (seenAuthors.has(o.author)) continue;
      out.push(o);
      seenAuthors.add(o.author);
    }
  }

  return out;
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
  // Carried forward from FeatureCandidate so the renderer's tier formula and
  // the quality gate can both read source-post engagement without re-loading
  // x.json. See D4 (tier formula) and D8 (quality gate).
  source_engagement?: number;
  // D-WALK-8 (iter-29): rendered as OFFICIAL pill in meta-row. Derived from
  // URL host + author in buildCandidates() per deriveIsLabOfficial(); never
  // hand-tagged per card.
  is_lab_official?: boolean;
}

function main(): void {
  // Load x.json once — needed for both candidate building (LAB_X_ACCOUNTS
  // scan) and source-engagement lookup (seeded candidates whose URL is an
  // x.com tweet). Per ISC-376 advisor fix.
  const xItems = loadItems("x");
  const xByStatusId = indexXByStatusId(xItems);

  const autoCandidates = buildCandidates(xItems, xByStatusId);
  const candidates = [...SEEDED_FEATURES, ...autoCandidates];
  console.log(`candidates: ${candidates.length} (${SEEDED_FEATURES.length} seeded + ${autoCandidates.length} auto from frontier + lab-x)`);

  // Build the data-derived tracked-lab predicate from frontier.json per
  // ISC-370 (advisor S1 resolve). No hardcoded TRACKED_LABS constant.
  const frontierItems = loadItems("frontier");
  const isTrackedLab = buildTrackedLabPredicate(frontierItems);

  const socialSources = ["tiktok", "instagram", "youtube", "reddit", "hn", "bluesky", "editorial", "enterprise"];
  const socialArrays: NormalizedItem[][] = [xItems];
  for (const s of socialSources) socialArrays.push(loadItems(s));
  const social = socialArrays.flat();
  console.log(`social corpus: ${social.length} items`);
  const socialIndex = buildSocialIndex(socialArrays);

  const confirmed: ConfirmedFeature[] = [];
  for (const c of candidates) {
    const responses = findResponses(c, social, true);
    if (responses.length === 0) continue;
    const platforms = new Set(responses.map((r) => r.source));
    const creators = new Set(responses.map((r) => r.author).filter((a) => a.length > 0));
    const podcast_mentions = responses.filter((r) => r.source === "youtube" && r.match_in === "transcript").length;
    const score = platforms.size * creators.size;
    // Threshold model: the lab post IS the feature definition; community
    // reach is the secondary layer. Lab-X and seeded candidates pass with
    // ≥1 cross-channel reactor (the lab said it shipped — that's the
    // primary signal, any community echo confirms it's landing). Frontier
    // blog posts stay strict because the blog publishes non-feature
    // corporate content (e.g. Long-Term Benefit Trust) that we don't want
    // surfacing as features unless multiple creators corroborate.
    const isLabSourced = c.source === "lab-x" || c.source === "seed";
    const minPlatforms = isLabSourced ? 1 : 2;
    const minCreators = isLabSourced ? 1 : 3;
    if (platforms.size >= minPlatforms && creators.size >= minCreators) {
      confirmed.push({
        feature_id: c.feature_id,
        lab: c.lab,
        title: c.title,
        url: c.url,
        ts: c.ts,
        entities: c.entity_phrases,
        responses: responses.sort((a, b) => b.engagement - a.engagement),
        distinct_platforms: platforms.size,
        distinct_creators: creators.size,
        podcast_mentions,
        score,
        source_engagement: c.source_engagement ?? 0,
        is_lab_official: c.is_lab_official ?? false,
      });
    }
  }

  // D2 — wrong-context filter pass (per ISC-373 with telemetry log).
  // For each confirmed feature, build the union of every OTHER feature's
  // entities and drop responses where the post is more about another feature.
  const wrongContextDropLog: string[] = [];
  for (const f of confirmed) {
    const otherEntities: string[] = [];
    for (const g of confirmed) {
      if (g.feature_id === f.feature_id) continue;
      for (const e of g.entities) otherEntities.push(e);
    }
    const filtered = filterWrongContextResponses(f, socialIndex, otherEntities, wrongContextDropLog);
    if (filtered.length !== f.responses.length) {
      f.responses = filtered;
      // Recompute platform/creator counts after wrong-context drops
      const platforms = new Set(f.responses.map((r) => r.source));
      const creators = new Set(f.responses.map((r) => r.author).filter((a) => a.length > 0));
      f.distinct_platforms = platforms.size;
      f.distinct_creators = creators.size;
      f.score = platforms.size * creators.size;
      f.podcast_mentions = f.responses.filter((r) => r.source === "youtube" && r.match_in === "transcript").length;
    }
  }
  fs.writeFileSync(WRONG_CONTEXT_LOG_PATH, wrongContextDropLog.join("\n") + (wrongContextDropLog.length ? "\n" : ""));
  console.log(`wrong-context drops: ${wrongContextDropLog.length} (logged to data/wrong-context-drops.jsonl)`);

  confirmed.sort((a, b) => b.score - a.score);
  const beforeEntityDedupe = confirmed.length;
  const entityDeduped = dedupeByEntityOverlap(confirmed);
  console.log(`features: ${beforeEntityDedupe} → ${entityDeduped.length} after entity-overlap dedupe`);

  // D1 — response-pool dedupe pass (per ISC-310 with 70% threshold).
  const responseDeduped = dedupeByResponsePool(entityDeduped);
  console.log(`features: ${entityDeduped.length} → ${responseDeduped.length} after response-pool dedupe`);

  // D8 — universal quality gate (per ISC-336 with derived isTrackedLab).
  const gated = responseDeduped.filter((f) => {
    const passes = passesQualityGate(f, isTrackedLab);
    if (!passes) {
      console.log(`  quality-gate DROP: ${f.lab} — ${f.title.slice(0, 60)} (creators=${f.distinct_creators}, source_eng=${f.source_engagement ?? 0})`);
    }
    return passes;
  });
  console.log(`features: ${responseDeduped.length} → ${gated.length} after quality gate`);

  for (const c of gated.slice(0, 20)) {
    console.log(`  [${c.lab.padEnd(16)}] score=${c.score.toString().padStart(4)} platforms=${c.distinct_platforms} creators=${c.distinct_creators} podcast=${c.podcast_mentions} src_eng=${c.source_engagement ?? 0}  ${c.title.slice(0, 80)}`);
  }

  fs.writeFileSync(`${DATA}/features-confirmed.json`, JSON.stringify(gated, null, 2));
  console.log(`wrote ${gated.length} features → data/features-confirmed.json`);

  // D-WALK-12 — Notable-this-period emission. Build the claimed-URL set
  // from confirmed features' response pools, then scan all social items for
  // whitelisted authors with engagement ≥ floor whose URL isn't claimed.
  const claimedUrls = new Set<string>();
  for (const f of gated) for (const r of f.responses) claimedUrls.add(r.url);

  const orphans: NotableOrphan[] = [];
  // Re-iterate the social arrays we already loaded; each carries a `source`
  // field so we don't need a parallel index.
  for (const arr of socialArrays) {
    for (const it of arr) {
      if (!it.url || claimedUrls.has(it.url)) continue;
      const author = ((it.meta as { author?: string } | undefined)?.author) ?? "";
      if (!isNotableAuthor(author)) continue;
      const eng = it.engagement ?? 0;
      if (eng < NOTABLE_ENGAGEMENT_FLOOR) continue;
      // Skip lab announcement posts that are themselves lab sources for a
      // feature card — those are still semantically part of a feature even
      // if the URL wasn't in the response pool (the feature card uses the
      // canonical URL as f.url, not as a response).
      let isLabSourceUrl = false;
      for (const f of gated) if (f.url === it.url) { isLabSourceUrl = true; break; }
      if (isLabSourceUrl) continue;
      orphans.push({
        source: it.source,
        author,
        url: it.url,
        title: it.title ?? "",
        raw_text: it.raw_text ?? "",
        engagement: eng,
        ts: it.ts ?? "",
      });
    }
  }
  orphans.sort((a, b) => b.engagement - a.engagement);
  const topOrphans = rebalanceNotableOrphans(orphans, NOTABLE_MAX_EMIT);
  fs.writeFileSync(`${DATA}/notable-orphans.json`, JSON.stringify(topOrphans, null, 2));
  const platformBreakdown = topOrphans.reduce<Record<string, number>>((acc, o) => {
    acc[o.source] = (acc[o.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`wrote ${topOrphans.length} notable orphans → data/notable-orphans.json (from ${orphans.length} candidates, platforms: ${JSON.stringify(platformBreakdown)})`);

  // D-WALK-5 — Pipeline-stats emission for the renderer's process-log
  // header. Concrete process metrics so the reader can see what was scanned,
  // not just what shipped. Values that can't be recovered without re-running
  // other pipeline stages (sonnet_passes is feature-sentiment.ts territory,
  // total_spend isn't tracked anywhere) are emitted as "n/a" or counted
  // structurally (sonnet per_feature = gated.length when sentiment file
  // exists). Renderer falls back to "n/a" when this file is missing so
  // partial-pipeline runs don't break rendering.
  const transcriptCounts: Record<string, number> = {};
  for (const src of ["youtube", "tiktok", "instagram"]) {
    const items = loadItems(src);
    transcriptCounts[src] = items.filter((it) => ((it.meta as { transcript?: string } | undefined)?.transcript ?? "").length > 0).length;
  }
  const sourcesScanned = ["x", "tiktok", "instagram", "youtube", "reddit", "hn", "bluesky", "editorial", "enterprise", "frontier"];
  const itemsBySource: Record<string, number> = {};
  for (const src of sourcesScanned) itemsBySource[src] = loadItems(src).length;
  const itemsTotal = Object.values(itemsBySource).reduce((a, b) => a + b, 0);

  let xRepliesClassified = 0;
  try {
    const cs = JSON.parse(fs.readFileSync(`${DATA}/comment-sentiment.json`, "utf-8"));
    if (Array.isArray(cs)) {
      for (const r of cs) xRepliesClassified += (r.replies?.length ?? 0);
    }
  } catch { /* file optional */ }

  const sentimentExists = fs.existsSync(`${DATA}/feature-sentiment.json`);
  const crossNarrativesExists = fs.existsSync(`${DATA}/cross-narratives.json`);

  const pipelineStats = {
    harvest_timestamp: new Date().toISOString(),
    sources_scanned: sourcesScanned,
    items_per_source: itemsBySource,
    items_total: itemsTotal,
    features_confirmed: gated.length,
    transcripts_extracted: transcriptCounts,
    x_replies_classified: xRepliesClassified,
    sonnet_passes: {
      per_feature: sentimentExists ? gated.length : 0,
      cross_narrative: crossNarrativesExists ? 1 : 0,
    },
    notable_orphans: topOrphans.length,
    wrong_context_drops: wrongContextDropLog.length,
    total_spend_usd_hard: "n/a",
  };
  fs.writeFileSync(`${DATA}/pipeline-stats.json`, JSON.stringify(pipelineStats, null, 2));
  console.log(`wrote pipeline-stats.json (items_total=${itemsTotal}, transcripts=yt=${transcriptCounts.youtube}/tt=${transcriptCounts.tiktok}/ig=${transcriptCounts.instagram}, x_replies=${xRepliesClassified})`);
}

if (import.meta.main) {
  main();
}
