import { test, expect } from 'bun:test';
import { coverageForRun, SOURCE_REGISTRY, paidSourcesEnabled, type SourceMeta } from './sources.ts';
import type { Source } from './types.ts';

/**
 * ISC-69 regression suite — the "covered live ≠ covered by replay" boundary.
 * A `grep` on report.html proves the footer renders today; this proves the
 * classification logic cannot silently regress tomorrow.
 *
 * The live registry currently has no `canLive: false` source, so the
 * NON-canLive branch is exercised via an injected registry — the reason
 * `coverageForRun` takes the registry as a parameter.
 */
const TEST_REGISTRY = {
  ...SOURCE_REGISTRY,
  x: { ...SOURCE_REGISTRY.x, canLive: false },
} as Record<Source, SourceMeta>;

function withMode<T>(mode: string, fn: () => T): T {
  const prev = process.env.HARVEST_MODE;
  process.env.HARVEST_MODE = mode;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HARVEST_MODE;
    else process.env.HARVEST_MODE = prev;
  }
}

test('ISC-69: live mode + canLive source with items → covered live', () => {
  withMode('live', () => {
    const cov = coverageForRun({ hn: 81, arxiv: 50 });
    expect(cov.find((c) => c.source === 'hn')?.mode).toBe('live');
    expect(cov.find((c) => c.source === 'arxiv')?.mode).toBe('live');
  });
});

test('ISC-69: live mode + NON-canLive source with items → covered by replay, never live', () => {
  withMode('live', () => {
    // A source that produced items without being live-capable can only have
    // done so from a snapshot path — it must never be reported as "live".
    const cov = coverageForRun({ x: 99 }, TEST_REGISTRY);
    expect(cov.find((c) => c.source === 'x')?.mode).toBe('replay');
  });
});

test('ISC-69: fixture mode → every contributing source is covered by replay', () => {
  withMode('fixture', () => {
    const cov = coverageForRun({ hn: 4, x: 4, arxiv: 4 });
    for (const s of ['hn', 'x', 'arxiv'] as Source[]) {
      expect(cov.find((c) => c.source === s)?.mode).toBe('replay');
    }
  });
});

test('ISC-69: fixture mode never reports live, even for a canLive source', () => {
  withMode('fixture', () => {
    const cov = coverageForRun({ hn: 4 });
    expect(cov.find((c) => c.source === 'hn')?.mode).not.toBe('live');
  });
});

test('ISC-69: zero items → absent, in both modes', () => {
  withMode('live', () => {
    expect(coverageForRun({ hn: 81 }).find((c) => c.source === 'github')?.mode).toBe('absent');
  });
  withMode('fixture', () => {
    expect(coverageForRun({ hn: 4 }).find((c) => c.source === 'github')?.mode).toBe('absent');
  });
});

test('ISC-69: partial coverage — live, replay-only, and absent classify independently', () => {
  withMode('live', () => {
    const cov = coverageForRun({ hn: 81, x: 99, github: 0 }, TEST_REGISTRY);
    expect(cov.find((c) => c.source === 'hn')?.mode).toBe('live'); // canLive + items
    expect(cov.find((c) => c.source === 'x')?.mode).toBe('replay'); // !canLive + items
    expect(cov.find((c) => c.source === 'github')?.mode).toBe('absent'); // no items
  });
});

test('paid sources: not opted in by default → disabled', () => {
  const prev = process.env.HARVEST_PAID;
  delete process.env.HARVEST_PAID;
  try {
    expect(paidSourcesEnabled()).toBe(false);
  } finally {
    if (prev !== undefined) process.env.HARVEST_PAID = prev;
  }
});

test('paid sources: HARVEST_PAID=1 → enabled', () => {
  const prev = process.env.HARVEST_PAID;
  process.env.HARVEST_PAID = '1';
  try {
    expect(paidSourcesEnabled()).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.HARVEST_PAID;
    else process.env.HARVEST_PAID = prev;
  }
});

test('registry: every source declares costsMoney; only Class-2 X costs money', () => {
  for (const meta of Object.values(SOURCE_REGISTRY)) {
    expect(typeof meta.costsMoney).toBe('boolean');
  }
  expect(SOURCE_REGISTRY.x.costsMoney).toBe(true);
  expect(SOURCE_REGISTRY.x.authClass).toBe('class-2');
  expect(SOURCE_REGISTRY.hn.costsMoney).toBe(false);
});
