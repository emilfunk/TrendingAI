import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedItem, Source } from './types.ts';
import { validateAnchor } from './classify.ts';
import { harvestMode } from './harvesters/_fixtures.ts';

const execFileAsync = promisify(execFile);

/**
 * ISC-146 / ISC-148 / ISC-149 — the 8-type content-type classifier.
 *
 * Kem's iteration-15 structural unlock: categorisation has TWO axes, not one.
 * Content-TYPE is a per-item property (this module). TREND is a cross-type
 * grouping (a downstream concern — same trend surfaces as a paper + a thread
 * + a video + a repo). This module does only the per-item half.
 *
 * Same three-boundary discipline as classify.ts:
 *   - ABOVE the boundary (non-deterministic): a batched LLM call. Mode-aware
 *     short-circuit in fixture/replay so the no-network-egress contract
 *     (ISC-56/61) is preserved.
 *   - THE BOUNDARY ARTIFACT: the anchor. validateAnchor is imported from
 *     classify.ts — single source of truth for the substring-presence rule.
 *   - BELOW the boundary (deterministic, fully testable):
 *     resolveTypeClassification — applies two rules:
 *
 *       (1) ISC-148 — uncategorized fallback. If the LLM verdict's anchor is
 *           NOT mechanically present in the item, the verdict is uncheckable.
 *           Fall back to the platform prior's first type (or 'uncategorized'
 *           if the source has no prior). An item is NEVER silently mis-typed
 *           on an uncheckable verdict.
 *
 *       (2) ISC-149 — platform-prior mismatch flag. The platform a piece of
 *           signal arrives on is a prior: arxiv → research, github → repo,
 *           youtube → tutorial/influencer-content. A verdict that contradicts
 *           the prior is HONORED but FLAGGED (`matchesPrior: false`); the
 *           render layer can show the mismatch instead of silently accepting
 *           e.g. an arXiv item classified as `news`.
 *
 * classify-type.test.ts tests the pure core offline — no LLM, deterministic.
 */

export type ContentType =
  | 'news'                  // overarching themes — model announcements, mainstream coverage
  | 'enterprise-news'       // company-level: investments, partnerships, compute deals, court cases
  | 'feature'               // a specific feature ships — a /goal command, a new capability
  | 'tutorial'              // how-to, walkthrough, explainer
  | 'trending-repo'         // a code repository trending right now
  | 'research'              // a paper, technique, or research finding
  | 'influencer-content'    // a personality talking about AI — Reels/TikTok/personal threads
  | 'community'             // discussion / debate / question / opinion
  | 'uncategorized';        // ISC-148 fallback when verdict is uncheckable

const TYPES: ReadonlySet<string> = new Set<ContentType>([
  'news',
  'enterprise-news',
  'feature',
  'tutorial',
  'trending-repo',
  'research',
  'influencer-content',
  'community',
  'uncategorized',
]);

/**
 * ISC-149 — platform→expected-type prior. Documented, inspectable. A prior
 * with multiple expected types means any of them matches; a verdict outside
 * the prior is flagged not rejected (the platform is a prior, not a rule —
 * a tutorial about a paper IS a tutorial, posted on arxiv-sanity etc.).
 *
 * Order within each platform's prior matters: the FIRST entry is the
 * fall-back type used when the LLM verdict is uncheckable (ISC-148).
 */
export const PLATFORM_PRIOR: Record<Source, ContentType[]> = {
  arxiv: ['research'],
  github: ['trending-repo'],
  frontier: ['enterprise-news', 'feature', 'news'],
  youtube: ['tutorial', 'influencer-content', 'feature'],
  x: ['news', 'feature', 'community', 'influencer-content'],
  hn: ['news', 'feature', 'community'],
  reddit: ['community', 'news'],
  bluesky: ['community', 'feature'],
  // Session 19.5 — short-form social. AI content on TikTok / Instagram is
  // dominated by feature demos and influencer-style walkthroughs; tutorials
  // happen but are shorter-form than the YouTube long-form prior.
  tiktok: ['influencer-content', 'feature', 'tutorial'],
  instagram: ['influencer-content', 'feature', 'tutorial'],
  // Iteration 20 scaffolding — editorial AI-news aggregators publish curated
  // daily/weekly news roundups; the dominant content type is `news` with
  // occasional `enterprise-news` and `feature` deep-dives.
  editorial: ['news', 'enterprise-news', 'feature'],
  // Iteration 20 scaffolding — enterprise-news publishers cover AI as part of
  // business reporting; `enterprise-news` is the dominant type, with `news` and
  // occasional `feature` longform.
  enterprise: ['enterprise-news', 'news', 'feature'],
};

export type RawTypeClassification = { type: ContentType; reason: string; anchor: string };

export type ResolvedTypeClassification = {
  type: ContentType;
  reason: string;
  anchor: string;
  anchorValid: boolean;
  /** The platform prior for this item's source (read-only context for the render layer). */
  platformPrior: ContentType[];
  /** ISC-149 — true when the resolved type sits inside the platform prior, or when no prior exists for the source. */
  matchesPrior: boolean;
  /** Where the resolved type came from: the LLM (anchor-validated), the platform prior (fallback), or a mode short-circuit. */
  source: 'llm' | 'prior-fallback' | 'short-circuit';
};

export type TypeClassifyResult = {
  /** All items pass through — the type classifier never drops. Drops are classify.ts's job. */
  items: NormalizedItem[];
  /** Resolved classification per item, keyed by url — for the render layer. */
  resolved: Map<string, ResolvedTypeClassification>;
};

/**
 * The deterministic core. Mirrors classify.ts's fail-open spirit but adapted
 * for typing: we never DROP on an uncheckable verdict — we fall back to the
 * platform prior. ISC-148 routes any genuinely-uncertain item to
 * `uncategorized` (when the prior is empty / unknown).
 */
export function resolveTypeClassification(
  item: NormalizedItem,
  raw: RawTypeClassification | null,
): ResolvedTypeClassification {
  const prior = PLATFORM_PRIOR[item.source] ?? [];

  if (raw === null) {
    // LLM batch failed — fall back to prior. Honest source label.
    const fallback = prior[0] ?? 'uncategorized';
    return {
      type: fallback,
      reason: 'fell back to platform prior — classifier unavailable for this batch',
      anchor: '',
      anchorValid: false,
      platformPrior: prior,
      matchesPrior: prior.length === 0 ? true : prior.includes(fallback),
      source: 'prior-fallback',
    };
  }

  const claimedType: ContentType = TYPES.has(raw.type) ? raw.type : 'uncategorized';
  const anchor = (raw.anchor ?? '').trim();
  const anchorValid = validateAnchor(item, anchor);

  if (!anchorValid) {
    // ISC-148 — the verdict is uncheckable. Fall back to platform prior; never
    // silently accept an unchecked type.
    const fallback = prior[0] ?? 'uncategorized';
    return {
      type: fallback,
      reason: `fell back to platform prior — anchor unchecked (${anchor || 'none'})`,
      anchor,
      anchorValid: false,
      platformPrior: prior,
      matchesPrior: prior.length === 0 ? true : prior.includes(fallback),
      source: 'prior-fallback',
    };
  }

  // ISC-149 — a verdict that contradicts the prior is HONORED but FLAGGED.
  // The render layer can surface the mismatch (an arxiv item that's actually
  // tutorial-shaped is real, but the reader should see the platform mismatch).
  const matchesPrior = prior.length === 0 ? true : prior.includes(claimedType);
  return {
    type: claimedType,
    reason: raw.reason?.trim() || `classified as ${claimedType}`,
    anchor,
    anchorValid: true,
    platformPrior: prior,
    matchesPrior,
    source: 'llm',
  };
}

// ── LLM layer (above the boundary — non-deterministic, network-bound) ───────

const INFERENCE = join(homedir(), '.claude', 'PAI', 'TOOLS', 'Inference.ts');
const BATCH_SIZE = 25;
const CONCURRENCY = 4;
// T-ISC-C — propagate Session-18 timeout-discipline pattern from
// classify-reception.ts. See classify.ts for the full reasoning. Without this,
// every batch silently times out at the Inference.ts 15s `--level fast`
// default and we get 100% prior-fallback in typed.json.
// Empirically a 25-item batch averages ~52s; with CONCURRENCY=4 variance
// pushes outliers over 60s, so 120s gives safe headroom. (Probed
// 2026-05-16: 25-item batch = 52.5s; 10-item batch = 25.3s.)
const INFERENCE_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You assign a CONTENT-TYPE to each item in an AI-trends feed. Exactly one type per item.

TYPES (use these names verbatim):
- news: overarching big-theme news — a model release, mainstream coverage, an industry headline.
- enterprise-news: a company-level event — investment, partnership, compute deal, court case, leadership change.
- feature: a specific feature or capability shipped (e.g. a "/goal" command, a new tool).
- tutorial: how-to, walkthrough, explainer, beginner guide.
- trending-repo: a code repository itself (NOT a blog post about a repo).
- research: a paper, technique, benchmark, or research finding.
- influencer-content: a personality talking about AI — a Reel, a TikTok, a personal thread, a creator video.
- community: discussion, debate, question, opinion, meta-chatter.

ANCHOR RULE (critical): the "anchor" MUST be a short exact phrase (a few words, a named entity, or a URL) copied VERBATIM from the item's title or text. It must be a literal substring — never a paraphrase. The anchor is how a human checks your type assignment without re-reading everything.

OUTPUT: a JSON array, one object per input item, SAME ORDER, SAME LENGTH:
[{"type":"news","reason":"...","anchor":"..."}]
Output ONLY the JSON array.`;

type BatchInput = { i: number; title: string; text: string; source: Source };

function extractJsonArray(stdout: string): RawTypeClassification[] | null {
  const tryParse = (s: string): RawTypeClassification[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as RawTypeClassification[]) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stdout.trim());
  if (direct) return direct;
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start >= 0 && end > start) return tryParse(stdout.slice(start, end + 1));
  return null;
}

async function classifyBatch(items: NormalizedItem[]): Promise<RawTypeClassification[] | null> {
  const payload: BatchInput[] = items.map((it, i) => ({
    i,
    title: it.title.slice(0, 240),
    text: it.raw_text.slice(0, 480),
    source: it.source,
  }));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        INFERENCE,
        '--json',
        '--level',
        'fast',
        '--timeout',
        String(INFERENCE_TIMEOUT_MS),
        SYSTEM_PROMPT,
        JSON.stringify(payload),
      ],
      { timeout: INFERENCE_TIMEOUT_MS + 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = extractJsonArray(stdout);
    if (!parsed || parsed.length !== items.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stash the resolved type on the item so the render layer can show it. */
function stash(item: NormalizedItem, r: ResolvedTypeClassification): void {
  item.meta = {
    ...(item.meta ?? {}),
    type: {
      value: r.type,
      reason: r.reason,
      anchor: r.anchor,
      anchorValid: r.anchorValid,
      platformPrior: r.platformPrior,
      matchesPrior: r.matchesPrior,
      source: r.source,
    },
  };
}

/**
 * Classify every item by content-type. Mode-aware: in fixture/replay mode (or
 * CLASSIFY_TYPE=0) every item gets its platform-prior type as a short-circuit
 * — no network egress, fully deterministic. In live mode, batched through
 * Inference.ts; a failed batch falls back to platform prior per ISC-148.
 *
 * Unlike classify.ts (which can drop items), this module never drops — typing
 * is metadata, not a gate. Drops are the reasoning classifier's job.
 */
export async function classifyTypes(items: NormalizedItem[]): Promise<TypeClassifyResult> {
  const resolved = new Map<string, ResolvedTypeClassification>();

  // Short-circuit — same discipline as classify.ts. Use the platform prior as
  // a deterministic type assignment when the LLM cannot run.
  if (harvestMode() !== 'live' || process.env.CLASSIFY_TYPE === '0') {
    const why =
      process.env.CLASSIFY_TYPE === '0'
        ? 'type-classify disabled (CLASSIFY_TYPE=0)'
        : `type-classify short-circuit (${harvestMode()} mode) — used platform prior`;
    for (const it of items) {
      const prior = PLATFORM_PRIOR[it.source] ?? [];
      const type: ContentType = prior[0] ?? 'uncategorized';
      const r: ResolvedTypeClassification = {
        type,
        reason: why,
        anchor: '',
        anchorValid: false,
        platformPrior: prior,
        matchesPrior: prior.length === 0 ? true : prior.includes(type),
        source: 'short-circuit',
      };
      stash(it, r);
      resolved.set(it.url, r);
    }
    return { items, resolved };
  }

  // Live mode — batch through the LLM, bounded concurrency.
  const batches: NormalizedItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));

  const results: (RawTypeClassification[] | null)[] = new Array(batches.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < batches.length) {
      const idx = next++;
      results[idx] = await classifyBatch(batches[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const raws = results[b];
    for (let j = 0; j < batch.length; j++) {
      const it = batch[j]!;
      const raw = raws?.[j] ?? null;
      const r = resolveTypeClassification(it, raw);
      stash(it, r);
      resolved.set(it.url, r);
    }
  }
  return { items, resolved };
}

/**
 * Read the resolved type back off an item's meta. Convenience for the render
 * layer and the benchmark check; mirrors how classify.ts stashes its result.
 * Returns null if the item was never run through classifyTypes.
 */
export function getResolvedType(item: NormalizedItem): ResolvedTypeClassification | null {
  const m = item.meta?.['type'];
  if (!m || typeof m !== 'object') return null;
  const t = m as Record<string, unknown>;
  if (typeof t.value !== 'string' || !TYPES.has(t.value)) return null;
  return {
    type: t.value as ContentType,
    reason: typeof t.reason === 'string' ? t.reason : '',
    anchor: typeof t.anchor === 'string' ? t.anchor : '',
    anchorValid: t.anchorValid === true,
    platformPrior: Array.isArray(t.platformPrior) ? (t.platformPrior as ContentType[]) : [],
    matchesPrior: t.matchesPrior === true,
    source: (t.source as ResolvedTypeClassification['source']) ?? 'short-circuit',
  };
}
