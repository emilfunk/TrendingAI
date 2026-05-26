import { test, expect } from 'bun:test';
import { resolveTypeClassification, PLATFORM_PRIOR, getResolvedType } from './classify-type.ts';
import type { RawTypeClassification, ContentType } from './classify-type.ts';
import type { NormalizedItem } from './types.ts';

function item(p: Partial<NormalizedItem>): NormalizedItem {
  return {
    title: 'untitled',
    url: 'https://example.com/x',
    source: 'hn',
    ts: '2026-05-14T00:00:00Z',
    engagement: 1,
    raw_text: '',
    ...p,
  };
}

/**
 * ISC-146/148/149 regression harness — the type classifier's pure core,
 * offline (no LLM, deterministic). Two rules to verify:
 *   (148) An uncheckable verdict falls back to the platform prior — never
 *         silently mis-typed.
 *   (149) A verdict outside the platform prior is honored but flagged.
 */

// ── ISC-148 — uncategorized fallback ────────────────────────────────────────

test('ISC-148 — an uncheckable verdict falls back to the platform prior', () => {
  // arXiv prior is ['research']; LLM tries to call this `news` with an anchor
  // not present in the item — uncheckable, so the verdict is not honored.
  const it = item({ source: 'arxiv', title: 'Attention is all you need', raw_text: 'transformer architecture' });
  const raw: RawTypeClassification = {
    type: 'news',
    reason: 'guessing',
    anchor: 'totally not present',
  };
  const r = resolveTypeClassification(it, raw);
  expect(r.type).toBe('research'); // arxiv prior's first entry
  expect(r.source).toBe('prior-fallback');
  expect(r.anchorValid).toBe(false);
  expect(r.reason).toContain('anchor unchecked');
});

test('ISC-148 — a source with no prior falls back to uncategorized on bad anchor', () => {
  // No prior exists for unknown sources — invent a synthetic NormalizedItem
  // with a source we don't have a prior for (cast through unknown for the test).
  const it = { ...item({}), source: 'mailinglist' as unknown as NormalizedItem['source'] };
  const raw: RawTypeClassification = { type: 'tutorial', reason: 'x', anchor: 'not present here' };
  const r = resolveTypeClassification(it, raw);
  expect(r.type).toBe('uncategorized');
  expect(r.source).toBe('prior-fallback');
});

test('ISC-148 — a null batch (LLM unavailable) falls back to platform prior', () => {
  const it = item({ source: 'github', title: 'a trending repo' });
  const r = resolveTypeClassification(it, null);
  expect(r.type).toBe('trending-repo'); // github prior's first entry
  expect(r.source).toBe('prior-fallback');
  expect(r.anchorValid).toBe(false);
  expect(r.reason).toContain('classifier unavailable');
});

// ── ISC-149 — platform-prior mismatch flagging ──────────────────────────────

test('ISC-149 — a verdict outside the platform prior is honored but flagged', () => {
  // arxiv prior is ['research']. A valid-anchor tutorial verdict is honored
  // (real anchor present), but flagged so the render layer can show the
  // platform mismatch.
  const it = item({
    source: 'arxiv',
    title: 'A beginner walkthrough of attention mechanisms',
    raw_text: 'this is a tutorial-style paper',
  });
  const raw: RawTypeClassification = {
    type: 'tutorial',
    reason: 'a beginner walkthrough',
    anchor: 'beginner walkthrough of attention',
  };
  const r = resolveTypeClassification(it, raw);
  expect(r.type).toBe('tutorial'); // honored
  expect(r.anchorValid).toBe(true);
  expect(r.matchesPrior).toBe(false); // but flagged
  expect(r.platformPrior).toEqual(['research']);
});

test('ISC-149 — a verdict inside the platform prior is honored and matches', () => {
  const it = item({
    source: 'arxiv',
    title: 'Attention is all you need',
    raw_text: 'a new transformer architecture for sequence modeling',
  });
  const raw: RawTypeClassification = {
    type: 'research',
    reason: 'a paper introducing a new architecture',
    anchor: 'transformer architecture',
  };
  const r = resolveTypeClassification(it, raw);
  expect(r.type).toBe('research');
  expect(r.anchorValid).toBe(true);
  expect(r.matchesPrior).toBe(true);
});

test('ISC-149 — multi-entry priors match any entry', () => {
  // frontier prior is ['enterprise-news', 'feature', 'news'] — all three should match.
  const it = item({
    source: 'frontier',
    title: '[Anthropic] Introducing Claude Opus 4.7',
    raw_text: 'a new frontier model release',
  });
  for (const t of ['enterprise-news', 'feature', 'news'] as ContentType[]) {
    const raw: RawTypeClassification = { type: t, reason: 'r', anchor: 'frontier model release' };
    const r = resolveTypeClassification(it, raw);
    expect(r.matchesPrior).toBe(true);
  }
  // But 'tutorial' is outside frontier's prior — should be flagged.
  const tutRaw: RawTypeClassification = { type: 'tutorial', reason: 'r', anchor: 'frontier model release' };
  const r = resolveTypeClassification(it, tutRaw);
  expect(r.matchesPrior).toBe(false);
});

// ── Misc ────────────────────────────────────────────────────────────────────

test('an unknown type string degrades to uncategorized (but only if anchor is valid)', () => {
  const it = item({ title: 'something about models', raw_text: 'about AI' });
  const raw = { type: 'banana' as unknown as ContentType, reason: 'x', anchor: 'something about models' };
  const r = resolveTypeClassification(it, raw);
  expect(r.type).toBe('uncategorized');
  expect(r.anchorValid).toBe(true);
  // hn prior is ['news', 'feature', 'community'] — uncategorized is outside it.
  expect(r.matchesPrior).toBe(false);
});

test('every Source in NormalizedItem has a documented platform prior', () => {
  // ISC-149 — the prior is documented and inspectable. Every harvest source
  // must have one (or the fallback path is silently 'uncategorized', which
  // would make the platform-mismatch flag meaningless for that source).
  const sources: NormalizedItem['source'][] = ['hn', 'arxiv', 'github', 'x', 'frontier', 'youtube', 'reddit', 'bluesky'];
  for (const s of sources) {
    const prior = PLATFORM_PRIOR[s];
    expect(prior).toBeDefined();
    expect(prior.length).toBeGreaterThan(0);
  }
});

test('getResolvedType reads back what classifyTypes stashed', () => {
  const it = item({ source: 'github', title: 'a repo trending' });
  it.meta = {
    type: {
      value: 'trending-repo',
      reason: 'r',
      anchor: 'repo trending',
      anchorValid: true,
      platformPrior: ['trending-repo'],
      matchesPrior: true,
      source: 'llm',
    },
  };
  const r = getResolvedType(it);
  expect(r).not.toBeNull();
  expect(r!.type).toBe('trending-repo');
  expect(r!.matchesPrior).toBe(true);
});

test('getResolvedType returns null for unclassified items', () => {
  const it = item({});
  expect(getResolvedType(it)).toBeNull();
});
