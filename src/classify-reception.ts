import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedItem } from './types.ts';
import { harvestMode } from './harvesters/_fixtures.ts';

const execFileAsync = promisify(execFile);

/**
 * ISC-125/126/127 — the reception classifier (Session 18).
 *
 * Iteration 16.2 named the structural gap: the Anthropic Claude-plan-change
 * story surfaced in the harvest, but the *dev-anger* reaction to it was
 * "structurally invisible" — the report had no place to put community
 * sentiment, endorsement, or whether a story was getting *ratioed* in the
 * comments. Session 17 closed half of that gap by capturing HN comments
 * onto `item.meta.comments[]` (ISC-155). This module closes the other half:
 * it reads those comments and emits a reception verdict.
 *
 * The same three-boundary discipline the rest of the pipeline uses applies:
 *
 *   - ABOVE the boundary (non-deterministic): `classifyReceptionLLM` — a
 *     batched Inference.ts call (Haiku, fast level) returning one verdict
 *     per item. Mode-aware short-circuit: fixture / replay / CLASSIFY=0
 *     makes NO network calls — items just don't get a `meta.reception`
 *     populated, which is honest (no reception signal was computed).
 *
 *   - THE BOUNDARY ARTIFACT: the anchor — a short literal substring of one
 *     of the captured comments. `validateReceptionAnchor` is pure: was the
 *     cited anchor mechanically present in the comment corpus?
 *
 *   - BELOW the boundary (deterministic, fully testable): `resolveReception`
 *     applies the FAIL-OPEN RULE on the high-impact flag — `ratioed === true`
 *     is honored ONLY if its anchor validates. An un-checkable ratioed flag
 *     is a rubber stamp on an anti-trending decision; downgrade to
 *     `ratioed: false` with a reason that says so. Sentiment and endorsed
 *     are returned as the model said when an anchor is checkable, and
 *     downgraded to neutral / false when not.
 *
 * FAIL-OPEN COST MODEL (carried from classify.ts iteration 13): a false
 * `ratioed=true` would silently downrank a real trending story — expensive
 * and invisible to the reader. A false `ratioed=false` keeps a junky story
 * in the report for one cycle — cheap and visible. Bias toward NOT firing
 * the anti-trending flag without checkable evidence.
 *
 * The Claude-plan-change benchmark items are the falsifier. If the
 * reception classifier reads "Show HN: adamsreview", "Use the Claude Agent
 * SDK with Your Claude Plan", or "Claude subscriptions no longer include
 * Agent SDK and Claude -p usage" as anything other than developer-negative
 * / exasperated when their actual comments contain the
 * "I pay Claude, to use Claude, to write instructions for Claude, to
 * review code from Claude. Have we all just given up?" reply, then ISC-126's
 * rule needs tightening — the falsifier is named so we'd catch it on the
 * very next live run.
 *
 * Items WITHOUT comments (most non-HN sources, and HN items with
 * `num_comments === 0`) do NOT receive a `meta.reception` — absence is the
 * honest signal. Downstream consumers should treat absent reception as
 * "no signal" — never as "neutral" or "fine".
 */

/** Coarse community sentiment over the comment corpus. */
export type Sentiment = 'positive' | 'negative' | 'mixed' | 'neutral';

const SENTIMENTS: ReadonlySet<string> = new Set<Sentiment>(['positive', 'negative', 'mixed', 'neutral']);

/** Raw, untrusted output of the LLM call — one per item. */
export type RawReception = {
  sentiment: Sentiment;
  ratioed: boolean;
  endorsed: boolean;
  reason: string;
  anchor: string;
};

/** The resolved, trustworthy reception verdict — after the anchor rule is applied. */
export type ResolvedReception = {
  sentiment: Sentiment;
  ratioed: boolean;
  endorsed: boolean;
  reason: string;
  anchor: string;
  anchorValid: boolean;
  /** When set, the LLM call was not run for this item — fixture / replay / disabled. */
  skipped?: boolean;
};

/** Shape of a captured comment on `item.meta.comments[]` (from Session 17 — see hn.ts). */
type Comment = { author?: string; text?: string; points?: number | null; ts?: string };

/** Case-fold, fold curly quotes to straight, collapse whitespace — same as classify.ts. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimum normalized anchor length. 8 chars — same as classify.ts. A trivial
 * "yes" or "no" found in any comment would let a model rubber-stamp a ratioed
 * verdict on a coincidental token. */
const MIN_ANCHOR_LEN = 8;

/**
 * The boundary primitive. The anchor must be a literal, normalized substring
 * of ONE of the comments AND at least MIN_ANCHOR_LEN chars. Per-comment
 * matching is deliberate: an anchor that "spans" two comments by accident
 * (the tail of comment A + the head of comment B happening to concatenate
 * into a phrase) is NOT a real quote from any one commenter — the verifier
 * would not be able to point a reader at a single line.
 */
export function validateReceptionAnchor(comments: ReadonlyArray<Comment>, anchor: string): boolean {
  const a = norm(anchor);
  if (a.length < MIN_ANCHOR_LEN) return false;
  for (const c of comments) {
    if (norm(c.text ?? '').includes(a)) return true;
  }
  return false;
}

/**
 * The deterministic core. Applies the fail-open rule on the high-impact flag:
 *   - `ratioed: true` is honored ONLY if the anchor validates;
 *     an un-checkable ratioed verdict is downgraded to false with reason.
 *   - `endorsed: true` follows the same rule (a false-positive endorsement
 *     in the report would be visibly wrong to a reader — same cost shape).
 *   - sentiment is honored when anchor validates; downgraded to 'neutral'
 *     with a reason when not. Sentiment without checkable backing is noise.
 */
export function resolveReception(comments: ReadonlyArray<Comment>, raw: RawReception): ResolvedReception {
  const anchor = (raw.anchor ?? '').trim();
  const anchorValid = validateReceptionAnchor(comments, anchor);
  const sentiment: Sentiment = SENTIMENTS.has(raw.sentiment) ? raw.sentiment : 'neutral';
  let reason = (raw.reason ?? '').trim() || `reception ${sentiment} (no reason given)`;

  if (!anchorValid) {
    reason = `downgraded — reception verdict had an uncheckable anchor (${anchor || 'none'})`;
    return {
      sentiment: 'neutral',
      ratioed: false,
      endorsed: false,
      reason,
      anchor,
      anchorValid: false,
    };
  }

  return {
    sentiment,
    ratioed: Boolean(raw.ratioed),
    endorsed: Boolean(raw.endorsed),
    reason,
    anchor,
    anchorValid: true,
  };
}

// ── LLM layer (above the boundary — non-deterministic, network-bound) ────────

const INFERENCE = join(homedir(), '.claude', 'PAI', 'TOOLS', 'Inference.ts');
// Per-batch sizing tuned against live Haiku throughput. 5 items × 8 comments ×
// 280 chars overruns the fast-level budget — see iteration-18 Decisions for the
// observed timeout. 3 × 6 × 240 stays comfortably under the 60s inner timeout
// at typical comment lengths.
// BATCH_SIZE=1 is deliberate (iteration-18 tuning, see Decisions): Haiku at
// fast level reliably handles a single item with up to 6 comments inside its
// budget, but 2+ items per batch produces frequent timeouts / length-mismatch
// failures (~25% drop rate at BATCH_SIZE=2 in live testing). Single-item calls
// trade extra round-trips for completeness — 71 items at CONCURRENCY=4 runs
// in ~2 minutes, which is fine for the daily-cadence pipeline.
const BATCH_SIZE = 1;
const CONCURRENCY = 4;
const COMMENTS_PER_ITEM = 6;
const COMMENT_CHARS = 240;

const SYSTEM_PROMPT = `You assess community reception of items in an AI-trends report by reading their comments.

For EACH input item, return a JSON object with FIVE fields:
- "sentiment": one of "positive", "negative", "mixed", "neutral" — the dominant community stance across the comments.
- "ratioed": boolean — true ONLY when the comments are predominantly negative or hostile toward the item itself (its premise, its quality, its actor), to the degree that a reader would call it "getting ratioed". Mere disagreement or technical debate is NOT ratioed. A single negative comment among neutrals is NOT ratioed.
- "endorsed": boolean — true ONLY when the comments are predominantly enthusiastic / approving / building on the item. Polite acknowledgment is NOT endorsed.
- "reason": one-line explanation (max ~140 chars).
- "anchor": a SHORT exact phrase (a few words, ~8-60 chars) copied VERBATIM from one of the comments — the line a human would read to verify your verdict. It MUST be a literal substring of one of the comment texts, never a paraphrase. If you cannot cite one, return "" — the verdict will be downgraded.

OUTPUT: a JSON array of objects, SAME ORDER and SAME LENGTH as input items. Output ONLY the JSON array.`;

type BatchInput = {
  i: number;
  title: string;
  comments: { author: string; points: number | null; text: string }[];
};

/** Parse Inference.ts's `--json` stdout into an array of RawReception.
 *
 * Quirk (observed iteration 18): Inference.ts's `--json` path tries object-match
 * FIRST and array-match second (Inference.ts §parse). A response containing
 * `[{...}]` therefore comes back as the inner object, not the wrapping array.
 * For our purposes, a single-object response is equivalent to a one-element
 * array — so when the input was one item AND the parsed shape is an object,
 * wrap it. Multi-item responses come through correctly as arrays.
 */
function extractJsonArray(stdout: string, expectedLen: number): RawReception[] | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const coerce = (v: unknown): RawReception[] | null => {
    if (Array.isArray(v)) return v as RawReception[];
    if (expectedLen === 1 && v && typeof v === 'object') return [v as RawReception];
    return null;
  };

  const direct = coerce(tryParse(stdout.trim()));
  if (direct) return direct;

  // Fallback — Inference.ts is supposed to JSON.stringify the parsed value, so
  // the direct parse normally succeeds. Keep the bracket-span fallback for the
  // rare case where stdout is plain LLM output that wasn't pre-parsed.
  const aStart = stdout.indexOf('[');
  const aEnd = stdout.lastIndexOf(']');
  if (aStart >= 0 && aEnd > aStart) {
    const c = coerce(tryParse(stdout.slice(aStart, aEnd + 1)));
    if (c) return c;
  }
  const oStart = stdout.indexOf('{');
  const oEnd = stdout.lastIndexOf('}');
  if (oStart >= 0 && oEnd > oStart) {
    const c = coerce(tryParse(stdout.slice(oStart, oEnd + 1)));
    if (c) return c;
  }
  return null;
}

/** Inference.ts's internal `--timeout` budget — 60s is enough for a 5-item Haiku
 * batch carrying its comment payload (live measurement: a single item with 8
 * comments runs in ~12-14s on cold-start; warm batches finish in ~5-8s). The
 * outer execFile timeout is set higher than this so the inner timeout is the
 * one that fires honestly (with the "Timeout after Nms" error from Inference.ts)
 * rather than the outer one masking it. */
const INFERENCE_TIMEOUT_MS = 60_000;

async function classifyBatch(items: NormalizedItem[]): Promise<RawReception[] | null> {
  const payload: BatchInput[] = items.map((it, i) => {
    const comments = ((it.meta?.comments as Comment[] | undefined) ?? []).slice(0, COMMENTS_PER_ITEM);
    return {
      i,
      title: it.title.slice(0, 200),
      comments: comments.map((c) => ({
        author: (c.author ?? 'anon').slice(0, 40),
        points: typeof c.points === 'number' ? c.points : null,
        text: (c.text ?? '').slice(0, COMMENT_CHARS),
      })),
    };
  });
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
    const parsed = extractJsonArray(stdout, items.length);
    if (!parsed || parsed.length !== items.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stash the resolved reception on the item — render and scoring can read it
 * without re-running anything. Items not eligible for reception (no comments)
 * never receive this field — absence is the honest "no signal" marker. */
function stash(item: NormalizedItem, r: ResolvedReception): void {
  item.meta = {
    ...(item.meta ?? {}),
    reception: {
      sentiment: r.sentiment,
      ratioed: r.ratioed,
      endorsed: r.endorsed,
      reason: r.reason,
      anchor: r.anchor,
      anchorValid: r.anchorValid,
    },
  };
}

export type ReceptionResult = {
  /** Number of items that received a reception verdict (had ≥1 comment). */
  classified: number;
  /** Number of items skipped (no comments). */
  noComments: number;
  /** Items whose batch call failed — left without `meta.reception` (honest). */
  failed: number;
  /** Items flagged ratioed=true after anchor validation. */
  ratioed: number;
  /** Items flagged endorsed=true after anchor validation. */
  endorsed: number;
  /** Resolved reception per item, keyed by url — for downstream consumers. */
  resolved: Map<string, ResolvedReception>;
};

/**
 * Classify reception for every item that carries comments. Items without
 * comments are left untouched. Mode-aware: in fixture/replay (or CLASSIFY=0)
 * makes NO network calls — items just don't get `meta.reception`. In live
 * mode, batches through Inference.ts with bounded concurrency; a failed batch
 * fails open (leaves `meta.reception` absent, logs an honest count).
 */
export async function classifyReception(items: NormalizedItem[]): Promise<ReceptionResult> {
  const resolved = new Map<string, ResolvedReception>();
  let classified = 0;
  let noComments = 0;
  let failed = 0;
  let ratioed = 0;
  let endorsed = 0;

  const eligible = items.filter((it) => Array.isArray(it.meta?.comments) && (it.meta!.comments as Comment[]).length > 0);
  noComments = items.length - eligible.length;

  if (eligible.length === 0) {
    return { classified, noComments, failed, ratioed, endorsed, resolved };
  }

  // Short-circuit — same discipline as classify.ts. Breaking this would
  // silently break the no-network-egress determinism contract (ISC-56/61).
  if (harvestMode() !== 'live' || process.env.CLASSIFY === '0') {
    // Honest absence — do not stash `meta.reception`. The render layer
    // treats absent reception as "no signal" — never as neutral.
    return { classified, noComments, failed, ratioed, endorsed, resolved };
  }

  // Live mode — batch through the LLM, bounded concurrency.
  const batches: NormalizedItem[][] = [];
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) batches.push(eligible.slice(i, i + BATCH_SIZE));

  const results: (RawReception[] | null)[] = new Array(batches.length);
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
      const raw = raws?.[j];
      if (!raw) {
        // Batch failed — leave `meta.reception` absent (honest no-signal).
        failed++;
        continue;
      }
      const comments = (it.meta?.comments as Comment[] | undefined) ?? [];
      const r = resolveReception(comments, raw);
      stash(it, r);
      resolved.set(it.url, r);
      classified++;
      if (r.ratioed) ratioed++;
      if (r.endorsed) endorsed++;
    }
  }
  return { classified, noComments, failed, ratioed, endorsed, resolved };
}
