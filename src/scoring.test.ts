import { test, expect } from 'bun:test';
import { scoreClusters, RATIOED_PENALTY, ENDORSED_BONUS } from './scoring.ts';
import type { Cluster, NormalizedItem } from './types.ts';

/**
 * ISC-158/159/161/163 (Session 19) — reception integration into scoring.
 *
 * The reception classifier writes `meta.reception = { sentiment, ratioed,
 * endorsed, anchor, anchorValid, reason }` on items with captured comments.
 * scoreClusters honors `anchorValid===true` verdicts:
 *  - any ratioed-valid item in a cluster multiplies cluster.score by 0.6
 *  - else, any endorsed-valid item multiplies cluster.score by 1.15 (capped 1.0)
 *  - ratioed wins over endorsed within the same cluster (hostile evidence
 *    trumps mixed-positive — the iteration-16.2 anti-trending doctrine)
 *  - anchorValid===false verdicts are ignored (fail-open: a fabricated
 *    ratioed cannot silently downrank real signal)
 */

function item(p: Partial<NormalizedItem>): NormalizedItem {
  return {
    title: 'untitled',
    url: 'https://example.com/x',
    source: 'hn',
    ts: '2026-05-14T00:00:00Z',
    engagement: 100,
    raw_text: '',
    ...p,
  };
}

function cluster(items: NormalizedItem[]): Cluster {
  return {
    id: 'c1',
    label: 'test',
    items,
    velocity: 0,
    cross_source: 0,
    engagement_mean: 0,
    leading_source_share: 0,
    score: 0,
    viral_score: 0,
    pre_viral_score: 0,
    confidence: 'MED',
  };
}

function clone(it: NormalizedItem, meta: Record<string, unknown>): NormalizedItem {
  return { ...it, meta: { ...(it.meta ?? {}), ...meta } };
}

// ── ratioed downrank (ISC-158) ──────────────────────────────────────────────

test('ratioed-validated item downranks cluster.score by 0.6×', () => {
  const base = item({ url: 'https://news.ycombinator.com/item?id=1' });
  const ratioed = clone(base, {
    reception: { sentiment: 'negative', ratioed: true, endorsed: false, anchor: 'fighting complexity with complexity', anchorValid: true, reason: 'hostile' },
  });
  const baselineCluster = cluster([base]);
  const ratioedCluster = cluster([ratioed]);
  scoreClusters([baselineCluster, ratioedCluster]);
  expect(ratioedCluster.score).toBeCloseTo(baselineCluster.score * RATIOED_PENALTY, 6);
});

// ── endorsed bonus + ceiling (ISC-159) ─────────────────────────────────────

test('endorsed-validated item boosts cluster.score by 1.15×, capped at 1.0', () => {
  const base = item({ url: 'https://news.ycombinator.com/item?id=2' });
  const endorsed = clone(base, {
    reception: { sentiment: 'positive', ratioed: false, endorsed: true, anchor: 'proper mad science, love it', anchorValid: true, reason: 'enthusiastic' },
  });
  const baselineCluster = cluster([base]);
  const endorsedCluster = cluster([endorsed]);
  scoreClusters([baselineCluster, endorsedCluster]);
  // Either the bonus applies or it's capped — both outcomes must hold the
  // 1.0 invariant. The cluster.score formula puts max baseline at 1.0, so
  // 1.15× would breach it without the ceiling.
  const expected = Math.min(1.0, baselineCluster.score * ENDORSED_BONUS);
  expect(endorsedCluster.score).toBeCloseTo(expected, 6);
  expect(endorsedCluster.score).toBeLessThanOrEqual(1.0);
});

// ── ratioed wins over endorsed (ISC-158 dominance) ─────────────────────────

test('a cluster with both ratioed-valid AND endorsed-valid items takes the ratioed penalty', () => {
  const base = item({ url: 'https://news.ycombinator.com/item?id=3' });
  const ratioed = clone(item({ url: 'https://news.ycombinator.com/item?id=3a' }), {
    reception: { sentiment: 'negative', ratioed: true, endorsed: false, anchor: 'this is a mess', anchorValid: true, reason: 'hostile' },
  });
  const endorsed = clone(item({ url: 'https://news.ycombinator.com/item?id=3b' }), {
    reception: { sentiment: 'positive', ratioed: false, endorsed: true, anchor: 'love this work', anchorValid: true, reason: 'enthusiastic' },
  });
  const baselineCluster = cluster([base, base, base]);
  const mixedCluster = cluster([base, ratioed, endorsed]);
  scoreClusters([baselineCluster, mixedCluster]);
  // Hostile evidence trumps mixed-positive within a single cluster — ISC-127.
  expect(mixedCluster.score).toBeCloseTo(baselineCluster.score * RATIOED_PENALTY, 6);
});

// ── anchor-invalid guard (ISC-161 anti) ────────────────────────────────────

test('anchorValid===false ratioed verdict is IGNORED — score unchanged (ISC-161)', () => {
  const base = item({ url: 'https://news.ycombinator.com/item?id=4' });
  const fakeRatioed = clone(base, {
    // A model-fabricated "ratioed" verdict with an un-checkable anchor.
    // resolveReception already downgrades this on write; scoring belt-and-suspenders
    // re-asserts the guard so a schema drift never silently downranks real signal.
    reception: { sentiment: 'negative', ratioed: true, endorsed: false, anchor: 'not in any comment', anchorValid: false, reason: 'uncheckable anchor' },
  });
  const baselineCluster = cluster([base]);
  const fakeCluster = cluster([fakeRatioed]);
  scoreClusters([baselineCluster, fakeCluster]);
  expect(fakeCluster.score).toBeCloseTo(baselineCluster.score, 6);
});

test('anchorValid===false endorsed verdict is IGNORED — score unchanged (ISC-161)', () => {
  const base = item({ url: 'https://news.ycombinator.com/item?id=5' });
  const fakeEndorsed = clone(base, {
    reception: { sentiment: 'positive', ratioed: false, endorsed: true, anchor: 'invented quote', anchorValid: false, reason: 'uncheckable anchor' },
  });
  const baselineCluster = cluster([base]);
  const fakeCluster = cluster([fakeEndorsed]);
  scoreClusters([baselineCluster, fakeCluster]);
  expect(fakeCluster.score).toBeCloseTo(baselineCluster.score, 6);
});

// ── absent reception (ISC-162 anti) ────────────────────────────────────────

test('items without meta.reception leave cluster.score unchanged', () => {
  const a = item({ url: 'https://news.ycombinator.com/item?id=6a' });
  const b = item({ url: 'https://news.ycombinator.com/item?id=6b' });
  // Two equivalent clusters; one has no reception data at all.
  const baselineCluster = cluster([a, b]);
  const otherCluster = cluster([a, b]);
  scoreClusters([baselineCluster, otherCluster]);
  expect(otherCluster.score).toBeCloseTo(baselineCluster.score, 6);
});

// ── mixed-cluster behavior (ISC-163) ───────────────────────────────────────

test('a cluster with one ratioed-valid item + two no-reception items still downranks', () => {
  const a = item({ url: 'https://news.ycombinator.com/item?id=7a' });
  const b = item({ url: 'https://news.ycombinator.com/item?id=7b' });
  const ratioed = clone(item({ url: 'https://news.ycombinator.com/item?id=7c' }), {
    reception: { sentiment: 'negative', ratioed: true, endorsed: false, anchor: 'a hostile quote here', anchorValid: true, reason: 'hostile' },
  });
  const baselineCluster = cluster([a, b, a]);
  const mixedCluster = cluster([a, b, ratioed]);
  scoreClusters([baselineCluster, mixedCluster]);
  expect(mixedCluster.score).toBeCloseTo(baselineCluster.score * RATIOED_PENALTY, 6);
});
