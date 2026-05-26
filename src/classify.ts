import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedItem } from './types.ts';
import { harvestMode } from './harvesters/_fixtures.ts';

const execFileAsync = promisify(execFile);

/**
 * ISC-113/114/115 — the reasoning classifier.
 *
 * Kem's 3-problem frame named FILTERING as a reasoning step that "actually
 * verifies something" instead of trusting synthetic metrics. The advisor's key
 * fix (ISA iteration 10): a free-form reason from the same model that made the
 * call can be a confident hallucination — so the reason MUST cite a CHECKABLE
 * ANCHOR, a phrase mechanically present in the item.
 *
 * This module carries the SAME boundary discipline the harvesters use:
 *   - ABOVE the boundary (non-deterministic): `classifyItems` — a batched LLM
 *     call via Inference.ts. Mode-aware: short-circuits in fixture/replay so it
 *     never breaks the no-network-egress determinism contract (ISC-56/61).
 *   - THE BOUNDARY ARTIFACT: the anchor. `validateAnchor` — pure: is the cited
 *     anchor literally present in the item?
 *   - BELOW the boundary (deterministic, fully testable): `resolveClassification`
 *     — applies the FAIL-OPEN DROP RULE. A `marketing`/`not-AI` drop is honored
 *     ONLY if its anchor validates; a `keep` is always honored. Reasoning can
 *     only REMOVE an item on a mechanically-checkable reason. This carries the
 *     iteration-11 precision lesson (false drops are worse than missed leaks)
 *     into the reasoning tier.
 *
 * FAIL-OPEN COST MODEL (advisor, iteration 13): a false-keep is one junk item
 * in a ~380-item feed — cheap and visible; a false-drop is lost real signal —
 * expensive and invisible. The rule is deliberately biased toward keep. The
 * anchor check catches *invented* quotes (hallucinations); it does NOT catch
 * *real-but-irrelevant* quotes — that residual hole is accepted, not a defect,
 * and is not closeable without an LLM judging relevance (the circularity this
 * whole boundary exists to avoid). `filter.ts` is the deterministic backstop
 * for the distributed marketing-ness the anchor check structurally can't catch.
 *
 * `classify.test.ts` tests the pure core offline — no LLM, deterministic.
 */

export type Verdict = 'AI-news' | 'AI-adjacent' | 'marketing' | 'not-AI';

const VERDICTS: ReadonlySet<string> = new Set<Verdict>(['AI-news', 'AI-adjacent', 'marketing', 'not-AI']);
const DROP_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['marketing', 'not-AI']);

/** Raw, untrusted output of the LLM call — one per item. */
export type RawClassification = { verdict: Verdict; reason: string; anchor: string };

/** The resolved, trustworthy classification — after the anchor rule is applied. */
export type ResolvedClassification = {
  verdict: Verdict;
  reason: string;
  anchor: string;
  anchorValid: boolean;
  action: 'keep' | 'drop';
};

export type ClassifyDrop = { item: NormalizedItem; reason: string };
export type ClassifyResult = {
  kept: NormalizedItem[];
  dropped: ClassifyDrop[];
  /** Resolved classification per item, keyed by url — for the render layer (ISC-115). */
  resolved: Map<string, ResolvedClassification>;
};

/** Case-fold, fold curly quotes to straight, collapse whitespace. Real item
 * titles carry smart quotes (the live run showed 'Made by Africa, Loved by the
 * World'); a model echoing straight quotes must still match. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimum normalized anchor length. A 3-char fragment or a single common word
 * ("model", "the AI") is present in almost any item — it would let a model
 * rubber-stamp a drop with a trivially-present token. 8 chars demands a real
 * phrase. (advisor, iteration 13 — the trivial-anchor hole.) */
const MIN_ANCHOR_LEN = 8;

/**
 * The boundary primitive. An anchor is valid iff it is a literal, normalized
 * substring of the item's title or raw_text AND at least MIN_ANCHOR_LEN chars.
 * NOTE: this validates anchor *presence*, not *relevance* — a real-but-
 * irrelevant quote still passes. That residual hole is accepted under the
 * fail-open cost model in the module header; closing it would require an LLM
 * judging relevance, the circularity this boundary exists to avoid.
 */
export function validateAnchor(item: NormalizedItem, anchor: string): boolean {
  const a = norm(anchor);
  if (a.length < MIN_ANCHOR_LEN) return false;
  const haystack = norm(`${item.title} ${item.raw_text}`);
  return haystack.includes(a);
}

/**
 * The deterministic core. Applies the fail-open drop rule:
 *  - a DROP verdict (marketing/not-AI) is honored ONLY if its anchor validates;
 *    an un-checkable drop is downgraded to keep — a verifier with an
 *    un-checkable reason is a rubber stamp (iteration-11 precision lesson).
 *  - a KEEP verdict (AI-news/AI-adjacent) is always honored — never lose real
 *    signal on a hallucinated anchor.
 */
export function resolveClassification(item: NormalizedItem, raw: RawClassification): ResolvedClassification {
  const verdict: Verdict = VERDICTS.has(raw.verdict) ? raw.verdict : 'AI-adjacent';
  const anchor = (raw.anchor ?? '').trim();
  const anchorValid = validateAnchor(item, anchor);
  const wantsDrop = DROP_VERDICTS.has(verdict);
  const action: 'keep' | 'drop' = wantsDrop && anchorValid ? 'drop' : 'keep';
  let reason = (raw.reason ?? '').trim() || `${verdict} (no reason given)`;
  if (wantsDrop && !anchorValid) {
    // The model wanted to drop but its reason points at nothing checkable —
    // keep it (fail-open) and say so honestly.
    reason = `kept — ${verdict} verdict had an uncheckable anchor (${anchor || 'none'})`;
  }
  return { verdict, reason, anchor, anchorValid, action };
}

// ── LLM layer (above the boundary — non-deterministic, network-bound) ────────

const INFERENCE = join(homedir(), '.claude', 'PAI', 'TOOLS', 'Inference.ts');
const BATCH_SIZE = 25;
const CONCURRENCY = 4;
// T-ISC-C — propagate the Session-18 timeout-discipline pattern from
// classify-reception.ts. Inference.ts at `--level fast` defaults to 15s
// internally; 25-item batched JSON payloads need much more. Without an
// explicit `--timeout` flag every batch silently returns null and the
// classifier falls back to platform priors (the 1029/1029 prior-fallback bug).
// Empirically a 25-item batch averages ~52s; with CONCURRENCY=4 variance
// pushes outliers over 60s, so 120s gives safe headroom. (Probed
// 2026-05-16: 25-item batch = 52.5s; 10-item batch = 25.3s.)
const INFERENCE_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You classify items for an AI-trends report. For EACH input item, decide a verdict and write a one-line reason that cites a CHECKABLE ANCHOR.

VERDICTS:
- AI-news: a substantive AI development — a model/feature/product release, research result, or industry news.
- AI-adjacent: related to AI but not itself news — opinion, meta-discussion, tooling chatter, a how-to.
- marketing: corporate promotion, event marketing, or consumer puff with no news substance.
- not-AI: not about AI at all.

ANCHOR RULE (critical): the "anchor" MUST be a short exact phrase (a few words, a named entity, or a URL) copied VERBATIM from the item's title or text. It must be a literal substring — never a paraphrase. The anchor is how a human checks your verdict without re-reading everything.

OUTPUT: a JSON array, one object per input item, SAME ORDER, SAME LENGTH:
[{"verdict":"AI-news","reason":"...","anchor":"..."}]
Output ONLY the JSON array.`;

type BatchInput = { i: number; title: string; text: string };

function extractJsonArray(stdout: string): RawClassification[] | null {
  const tryParse = (s: string): RawClassification[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as RawClassification[]) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stdout.trim());
  if (direct) return direct;
  // Inference.ts may wrap the array in surrounding text — extract the array span.
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start >= 0 && end > start) return tryParse(stdout.slice(start, end + 1));
  return null;
}

async function classifyBatch(items: NormalizedItem[]): Promise<RawClassification[] | null> {
  const payload: BatchInput[] = items.map((it, i) => ({
    i,
    title: it.title.slice(0, 240),
    text: it.raw_text.slice(0, 480),
  }));
  try {
    // execFile with an argument array — no shell interpolation (PAI security
    // rule). Subscription-billed via the Inference.ts `claude` subprocess.
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

/** Stash the resolved classification on the item so the render layer (ISC-115)
 * can show the anchored "why it's here" reason without re-running anything. */
function stash(item: NormalizedItem, r: ResolvedClassification): void {
  item.meta = {
    ...(item.meta ?? {}),
    classify: { verdict: r.verdict, reason: r.reason, anchor: r.anchor, anchorValid: r.anchorValid },
  };
}

/**
 * Classify every item. Mode-aware: in fixture/replay mode (or CLASSIFY=0) this
 * makes NO network calls — every item is kept, honestly labelled un-classified.
 * In live mode it batches items through Inference.ts with bounded concurrency;
 * a failed batch fails open (all kept, labelled "classifier unavailable").
 */
export async function classifyItems(items: NormalizedItem[]): Promise<ClassifyResult> {
  const kept: NormalizedItem[] = [];
  const dropped: ClassifyDrop[] = [];
  const resolved = new Map<string, ResolvedClassification>();

  // Short-circuit — same discipline as verifier.ts. Breaking this would
  // silently break the no-network-egress determinism contract (ISC-56/61).
  if (harvestMode() !== 'live' || process.env.CLASSIFY === '0') {
    const why =
      process.env.CLASSIFY === '0' ? 'classify disabled (CLASSIFY=0)' : `classify skipped (${harvestMode()} mode)`;
    for (const it of items) {
      const r: ResolvedClassification = {
        verdict: 'AI-adjacent', reason: why, anchor: '', anchorValid: false, action: 'keep',
      };
      stash(it, r);
      resolved.set(it.url, r);
      kept.push(it);
    }
    return { kept, dropped, resolved };
  }

  // Live mode — batch through the LLM, bounded concurrency.
  const batches: NormalizedItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));

  const results: (RawClassification[] | null)[] = new Array(batches.length);
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
      const r: ResolvedClassification = raw
        ? resolveClassification(it, raw)
        : // Batch call failed — fail open: keep the item, say so honestly.
          { verdict: 'AI-adjacent', reason: 'kept — classifier unavailable for this batch', anchor: '', anchorValid: false, action: 'keep' };
      stash(it, r);
      resolved.set(it.url, r);
      if (r.action === 'drop') dropped.push({ item: it, reason: `${r.verdict}: ${r.reason}` });
      else kept.push(it);
    }
  }
  return { kept, dropped, resolved };
}
