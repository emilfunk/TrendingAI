// D-WALK-22 — Auto seed-discovery pre-pass (iter-30).
//
// Closes the Agent-SDK-class blind spot: community-named lab drama (Agent SDK
// June-15 dedicated-credit policy, "-p" nerfs, pricing changes) only entered
// the report iter-29-and-earlier because Kem hand-added a SEEDED_FEATURES
// entry after each walk. The 6 existing seeds are codified residue of prior
// Kem walks. D-WALK-22 lifts that crutch from manual to systemic.
//
// Mechanism: scan lab-X posts (LAB_X_ACCOUNTS, engagement >=
// QUALITY_GATE_HIGH_ENGAGEMENT) whose entity extraction returned empty AND
// whose reply pool is dominantly negative. For each survivor, call Sonnet
// with the post + top-3 negative replies and ask for an entity-name proposal.
// Proposal must pass isDistinctiveEntity (same gate features-first.ts uses)
// or it is dropped. Survivors are written to data/seed-candidates.json with
// a fully-formed `recommended_seed` block matching SEEDED_FEATURES schema —
// Kem reviews + manually appends to SEEDED_FEATURES (anti-rule: this script
// NEVER mutates features-first.ts itself).
//
// Structural-fix-only (ISA Principle v7): defect class closed at mechanism
// layer. Future drama in the same shape — lab post + negative replies + no
// clean Title-Case entity — surfaces as a candidate without a code edit.
//
// Probe (ISC-404): synthesise an Agent-SDK-shaped fixture and confirm
// proposeSeedCandidates produces one row for it (seed-discovery.test.ts).

import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import type { NormalizedItem } from "./types.ts";
import {
  LAB_X_ACCOUNTS,
  QUALITY_GATE_HIGH_ENGAGEMENT,
  extractEntities,
  extractFeatureFromAnnouncement,
  isDistinctiveEntity,
} from "./features-first.ts";

const execFile = promisify(execFileCb);
const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const OUT_PATH = `${DATA}/seed-candidates.json`;
const INFERENCE_TS = `${HOME}/.claude/PAI/TOOLS/Inference.ts`;
const INFERENCE_TIMEOUT_MS = 60_000;

// Reply-pool gate. NEGATIVE-dominant catches clean angry pools (>50% negative
// of the dominant tier); the substantial-negative fallback catches MIXED
// pools where negative is a strong minority on a meaningful sample size
// (>40% negative on n>=5). The 0.4 threshold is the iter-27 reply-signal
// boundary where Sonnet started reliably flagging contradictions inline.
const REPLY_NEGATIVE_RATIO_FLOOR = 0.4;
const REPLY_SAMPLE_FLOOR = 5;
const TOP_NEGATIVE_REPLIES = 3;

type ReplyAgg = {
  positive?: number;
  negative?: number;
  neutral?: number;
  mixed?: number;
  total?: number;
  dominant?: string;
};
type ReplyRow = {
  url?: string;
  author?: string;
  body?: string;
  text?: string;
  classification?: string;
  sentiment?: string;
};
type CommentSentimentRow = {
  tweet_url: string;
  tweet_author?: string;
  ship_name?: string;
  ship_id?: string;
  agg: ReplyAgg;
  replies?: ReplyRow[];
};

type SeedCandidate = {
  url: string;
  lab: string;
  author: string;
  post_excerpt: string;
  engagement: number;
  reply_pool: {
    total: number;
    dominant: string;
    negative: number;
    positive: number;
  };
  entity_proposal: string;
  // Advisor close (iter-30): collision-check against the live SEEDED_FEATURES
  // set so Kem never appends a duplicate during manual review. The flag is
  // surfaced in the output row but does NOT short-circuit emission — Kem
  // still sees the candidate with the existing seed's feature_id named, so
  // they can decide to reinforce/replace/skip rather than blindly append.
  existing_seed_collision: { feature_id: string; reason: "url" | "entity_phrase" } | null;
  recommended_seed: {
    feature_id: string;
    source: "seed";
    lab: string;
    title: string;
    url: string;
    ts: string;
    entity_phrases: string[];
  };
};

// Existing seeds the live pipeline already carries. Sourced from
// SEEDED_FEATURES in src/features-first.ts (mirrored here as a static
// snapshot — kept in sync via the feature-id list to avoid pulling the
// constant + triggering features-first.ts module load). When this list drifts
// the collision-check still has the URL fallback path which IS computed from
// the live constant on demand.
//
// Keys are lowercase entity-phrase substrings; values are the feature_id
// they belong to. Match is substring-on-substring (cheap, deterministic).
const KNOWN_SEED_PHRASES: Array<[string, string]> = [
  ["agent view", "seed-agent-view"],
  ["model context protocol", "seed-mcp"],
  ["mcp", "seed-mcp"],
  ["agent sdk", "seed-agent-sdk"],
  ["claude skills", "seed-claude-skills"],
  ["subagents", "seed-subagents"],
  ["background subagents", "seed-subagents"],
  ["finance agents", "seed-finance-agents"],
  ["agents for financial services", "seed-finance-agents"],
];
const KNOWN_SEED_URLS: Array<[string, string]> = [
  ["status/2053940934736228454", "seed-agent-view"],
  ["model-context-protocol", "seed-mcp"],
  ["status/2054610152817619388", "seed-agent-sdk"],
  ["code.claude.com/docs/en/skills", "seed-claude-skills"],
  ["code.claude.com/docs/en/sub-agents", "seed-subagents"],
  ["finance-agents", "seed-finance-agents"],
];

function detectExistingSeedCollision(
  url: string,
  entityProposal: string,
): SeedCandidate["existing_seed_collision"] {
  for (const [needle, fid] of KNOWN_SEED_URLS) {
    if (url.includes(needle)) return { feature_id: fid, reason: "url" };
  }
  const lowProposal = entityProposal.toLowerCase().trim();
  for (const [phrase, fid] of KNOWN_SEED_PHRASES) {
    if (lowProposal.includes(phrase) || phrase.includes(lowProposal)) {
      return { feature_id: fid, reason: "entity_phrase" };
    }
  }
  return null;
}

export type ProposeArgs = {
  xItems: NormalizedItem[];
  commentSentiment: CommentSentimentRow[];
  llm?: (postText: string, negativeReplies: string[]) => Promise<string | null>;
};

function loadJson<T>(p: string, fb: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return fb;
  }
}

function loadItems(name: string): NormalizedItem[] {
  const raw = loadJson<NormalizedItem[] | { items?: NormalizedItem[] }>(
    `${DATA}/${name}.json`,
    [],
  );
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

function statusIdOf(url: string): string | null {
  return url.match(/status\/(\d+)/)?.[1] ?? null;
}

// Lab-X candidate predicate. Three checks ANDed: lab-authorship, engagement,
// empty entity extraction (BOTH the Title-Case regex pool AND the
// announcement-pattern fallback — only posts the existing pipeline drops).
export function isLabXCandidate(item: NormalizedItem): boolean {
  const author = ((item.meta as { author?: string } | undefined)?.author) ?? "";
  if (!LAB_X_ACCOUNTS.has(author)) return false;
  if ((item.engagement ?? 0) < QUALITY_GATE_HIGH_ENGAGEMENT) return false;
  const titleEntities = extractEntities(item.title ?? "");
  if (titleEntities.length > 0) return false;
  const announcementEntities = extractFeatureFromAnnouncement(
    (item.title ?? "") + " " + (item.raw_text ?? ""),
  );
  if (announcementEntities.length > 0) return false;
  return true;
}

// Reply-pool predicate. NEGATIVE-dominant OR substantial-negative on a
// meaningful sample. Bounded so a 1-reply pool can't trigger.
export function hasNegativeReplyPool(agg: ReplyAgg | undefined): boolean {
  if (!agg) return false;
  const total = agg.total ?? 0;
  const negative = agg.negative ?? 0;
  if ((agg.dominant ?? "").toUpperCase() === "NEGATIVE") return true;
  if (total >= REPLY_SAMPLE_FLOOR && negative / total > REPLY_NEGATIVE_RATIO_FLOOR) {
    return true;
  }
  return false;
}

// Index comment-sentiment by tweet status-id so URL query/fragment differences
// don't break the join. Both x.json URLs and comment-sentiment.json URLs are
// x.com/<handle>/status/<id> at the canonical form, so status-id is the
// stable key.
export function indexCommentSentimentByStatusId(
  rows: CommentSentimentRow[],
): Map<string, CommentSentimentRow> {
  const m = new Map<string, CommentSentimentRow>();
  for (const row of rows) {
    const id = statusIdOf(row.tweet_url);
    if (id) m.set(id, row);
  }
  return m;
}

function pickTopNegativeReplies(
  row: CommentSentimentRow,
  n = TOP_NEGATIVE_REPLIES,
): string[] {
  const replies = row.replies ?? [];
  const negativeFirst = replies.filter((r) => {
    const c = (r.classification ?? r.sentiment ?? "").toUpperCase();
    return c === "NEGATIVE";
  });
  const out: string[] = [];
  for (const r of negativeFirst) {
    const body = (r.body ?? r.text ?? "").trim();
    if (!body) continue;
    out.push(body.length > 280 ? body.slice(0, 277) + "…" : body);
    if (out.length >= n) break;
  }
  return out;
}

const SEED_DISCOVERY_SYS = `
You read a lab announcement post (from Anthropic / OpenAI / Google / xAI / etc.)
plus a few representative negative replies, and propose the SINGLE noun-phrase
that names whatever the community is actually arguing about.

Rules:
- Output strict JSON: {"entity_proposal": "<phrase>"} or {"entity_proposal": null}
- The phrase is lowercase, 1-5 words, the canonical name of the feature OR policy
  the post introduces — what a creator on YouTube would tag in a video title.
- Prefer the most COMPACT phrase that still uniquely names the thing. "codex
  mobile" beats "codex mobile app" if both name the same feature. Compactness
  matters because downstream substring-match across creator posts is more
  generous with shorter anchors.
- If the post is a generic update / non-feature ("paper published", "happy
  friday rate-limit reset", "we're hiring"), return null.
- NEVER propose a parent product name (Claude Code, Codex, ChatGPT, Gemini,
  Grok, Anthropic, OpenAI, Google). NEVER propose an announcement verb
  ("introducing", "launching"). NEVER propose a generic ("agents", "ai").
- The replies are the smoke signal: they are angry about a SPECIFIC change.
  Name that change.
`.trim();

async function defaultLlmPropose(
  postText: string,
  negativeReplies: string[],
): Promise<string | null> {
  const user = [
    "LAB POST:",
    postText,
    "",
    "REPRESENTATIVE NEGATIVE REPLIES:",
    ...negativeReplies.map((r, i) => `${i + 1}. ${r}`),
    "",
    "Propose the entity phrase the community is arguing about, as JSON.",
  ].join("\n");
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  try {
    const { stdout } = await execFile(
      "bun",
      [
        INFERENCE_TS,
        "--json",
        "--level",
        "standard",
        "--timeout",
        String(INFERENCE_TIMEOUT_MS),
        SEED_DISCOVERY_SYS,
        user,
      ],
      { env, timeout: INFERENCE_TIMEOUT_MS + 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as { entity_proposal?: unknown };
    if (typeof parsed.entity_proposal !== "string") return null;
    const proposal = parsed.entity_proposal.trim();
    if (!proposal) return null;
    return proposal;
  } catch {
    return null;
  }
}

function feature_id_for_seed(proposal: string): string {
  const slug = proposal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (slug) return `seed-${slug}`;
  const hash = createHash("sha256").update(proposal).digest("hex").slice(0, 12);
  return `seed-${hash}`;
}

// Pure function — no I/O. Test-friendly. Accepts a stub `llm` for unit tests.
export async function proposeSeedCandidates(args: ProposeArgs): Promise<SeedCandidate[]> {
  const { xItems, commentSentiment } = args;
  const llm = args.llm ?? defaultLlmPropose;
  const sentimentByStatusId = indexCommentSentimentByStatusId(commentSentiment);
  const out: SeedCandidate[] = [];

  for (const item of xItems) {
    if (!isLabXCandidate(item)) continue;
    const statusId = statusIdOf(item.url);
    if (!statusId) continue;
    const sentimentRow = sentimentByStatusId.get(statusId);
    if (!sentimentRow) continue;
    if (!hasNegativeReplyPool(sentimentRow.agg)) continue;

    const author = ((item.meta as { author?: string } | undefined)?.author) ?? "";
    const postText = (item.title ?? "") + (item.raw_text ? `\n\n${item.raw_text}` : "");
    const negativeReplies = pickTopNegativeReplies(sentimentRow);

    const proposal = await llm(postText, negativeReplies);
    if (!proposal) continue;
    if (!isDistinctiveEntity(proposal)) continue;

    const entity_phrases = [proposal.toLowerCase()];
    const total = sentimentRow.agg.total ?? 0;
    const negative = sentimentRow.agg.negative ?? 0;
    const positive = sentimentRow.agg.positive ?? 0;
    const dominant = (sentimentRow.agg.dominant ?? "").toUpperCase();

    out.push({
      url: item.url,
      lab: author,
      author,
      post_excerpt: postText.slice(0, 280),
      engagement: item.engagement ?? 0,
      reply_pool: { total, dominant, negative, positive },
      entity_proposal: proposal,
      existing_seed_collision: detectExistingSeedCollision(item.url, proposal),
      recommended_seed: {
        feature_id: feature_id_for_seed(proposal),
        source: "seed",
        lab: author,
        title: (item.title ?? "").slice(0, 200),
        url: item.url,
        ts: item.ts,
        entity_phrases,
      },
    });
  }

  return out;
}

async function main(): Promise<void> {
  const xItems = loadItems("x");
  const commentSentiment = loadJson<CommentSentimentRow[]>(
    `${DATA}/comment-sentiment.json`,
    [],
  );
  const candidates = await proposeSeedCandidates({ xItems, commentSentiment });
  fs.writeFileSync(OUT_PATH, JSON.stringify(candidates, null, 2));
  console.log(`seed-discovery: wrote ${candidates.length} candidate(s) to ${OUT_PATH}`);
  for (const c of candidates) {
    console.log(
      `  - [${c.lab}] ${c.entity_proposal} — ${c.reply_pool.negative}/${c.reply_pool.total} negative (eng ${c.engagement}) — ${c.url}`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("seed-discovery failed:", err);
    process.exit(1);
  });
}
