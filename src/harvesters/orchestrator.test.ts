import { test, expect } from 'bun:test';
import { computeActiveSequence, HARVEST_SEQUENCE, PAID_SOURCES } from './orchestrator.ts';

/**
 * ISC-173 / ISC-174 (Session 19.5) regression-guard.
 *
 * Iteration 7 burned ~$0.20 because token presence was treated as spend
 * authorization. The post-mortem fix was the explicit `HARVEST_PAID=1` opt-in.
 * Session 19.5 added tiktok + instagram as paid sources behind the same gate
 * INSTEAD of inventing a parallel one — these tests are what makes the
 * "regression-prevent" claim verifiable at audit. The test matrix covers all
 * four input combinations + a failing-on-removal assertion per paid source.
 */

test('PAID_SOURCES contains x, tiktok, instagram (failing-on-removal regression guard)', () => {
  // If anyone removes a paid source from the set, exactly these assertions
  // break — that is the iter-7 regression they would re-introduce.
  expect(PAID_SOURCES.has('x')).toBe(true);
  expect(PAID_SOURCES.has('tiktok')).toBe(true);
  expect(PAID_SOURCES.has('instagram')).toBe(true);
});

test('paid sources are EXCLUDED when no token (regardless of HARVEST_PAID)', () => {
  // Without a token there is nothing to authorize, but the test asserts the
  // gate's structure: paid sources should not appear even if the user
  // mistakenly set HARVEST_PAID=1.
  const seq = computeActiveSequence({ hasToken: false, paidEnabled: true });
  expect(seq.includes('x')).toBe(false);
  expect(seq.includes('tiktok')).toBe(false);
  expect(seq.includes('instagram')).toBe(false);
});

test('paid sources are EXCLUDED when token present but HARVEST_PAID unset (iter-7 regression scenario)', () => {
  // This is THE iter-7 bug shape: token in env, no explicit opt-in. The system
  // must NOT auto-include paid sources just because the token exists.
  const seq = computeActiveSequence({ hasToken: true, paidEnabled: false });
  expect(seq.includes('x')).toBe(false);
  expect(seq.includes('tiktok')).toBe(false);
  expect(seq.includes('instagram')).toBe(false);
});

test('paid sources are INCLUDED only when token present AND HARVEST_PAID=1', () => {
  const seq = computeActiveSequence({ hasToken: true, paidEnabled: true });
  expect(seq.includes('x')).toBe(true);
  expect(seq.includes('tiktok')).toBe(true);
  expect(seq.includes('instagram')).toBe(true);
});

test('non-paid sources are always included regardless of gate state', () => {
  const states = [
    { hasToken: false, paidEnabled: false },
    { hasToken: false, paidEnabled: true },
    { hasToken: true, paidEnabled: false },
    { hasToken: true, paidEnabled: true },
  ];
  const nonPaid: Array<typeof HARVEST_SEQUENCE[number]> = HARVEST_SEQUENCE.filter(
    (s) => !PAID_SOURCES.has(s),
  );
  for (const s of states) {
    const seq = computeActiveSequence(s);
    for (const np of nonPaid) {
      expect(seq.includes(np)).toBe(true);
    }
  }
});

test('active sequence preserves HARVEST_SEQUENCE ordering (ISC-154 invariant)', () => {
  // The documented order is part of the contract — filtering must not reorder.
  const seq = computeActiveSequence({ hasToken: true, paidEnabled: true });
  let lastIdx = -1;
  for (const s of seq) {
    const idx = HARVEST_SEQUENCE.indexOf(s);
    expect(idx).toBeGreaterThan(lastIdx);
    lastIdx = idx;
  }
});
