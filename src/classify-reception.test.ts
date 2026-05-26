import { test, expect } from 'bun:test';
import {
  validateReceptionAnchor,
  resolveReception,
  classifyReception,
} from './classify-reception.ts';
import type { RawReception, Sentiment } from './classify-reception.ts';
import type { NormalizedItem } from './types.ts';

type Comment = { author?: string; text?: string; points?: number | null; ts?: string };

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

function withComments(it: NormalizedItem, comments: Comment[]): NormalizedItem {
  return { ...it, meta: { ...(it.meta ?? {}), comments } };
}

/**
 * ISC-125/126/127 regression harness — the reception classifier's PURE core,
 * tested offline (no LLM, deterministic). The classifier is only a verifier
 * if it has BOTH a true-positive (a real ratioed item flagged when its anchor
 * is mechanically present in the comments) AND a fail-open guard (a ratioed
 * verdict with an un-checkable anchor downgrades to ratioed:false, never
 * silently downrank real signal on a hallucinated quote). The anchor is the
 * boundary artifact; validateReceptionAnchor is its test.
 */

// ── validateReceptionAnchor — the boundary primitive ────────────────────────

test('validateReceptionAnchor — a literal substring of the comment corpus passes', () => {
  const comments: Comment[] = [
    { text: 'I pay Claude, to use Claude, to write instructions for Claude, to review code from Claude' },
    { text: 'Have we all just given up?' },
  ];
  expect(validateReceptionAnchor(comments, 'pay Claude, to use Claude')).toBe(true);
  expect(validateReceptionAnchor(comments, 'just given up')).toBe(true);
  expect(validateReceptionAnchor(comments, 'JUST  given   up')).toBe(true); // whitespace + case normalized
});

test('validateReceptionAnchor — a paraphrase, an absent phrase, or a too-short anchor fails', () => {
  const comments: Comment[] = [
    { text: 'I pay Claude, to use Claude, to write instructions for Claude' },
  ];
  expect(validateReceptionAnchor(comments, 'developer is frustrated')).toBe(false); // paraphrase
  expect(validateReceptionAnchor(comments, 'GPT-5 is better')).toBe(false); // absent
  expect(validateReceptionAnchor(comments, 'pay')).toBe(false); // too short
  expect(validateReceptionAnchor(comments, '')).toBe(false); // empty
});

test('validateReceptionAnchor — a curly/straight quote mismatch still validates (normalization)', () => {
  const comments: Comment[] = [{ text: "‘Made by Africa, Loved by the World’ is hype" }];
  expect(validateReceptionAnchor(comments, "'Made by Africa, Loved by the World'")).toBe(true);
});

test('validateReceptionAnchor — an anchor that would span two comments is NOT valid', () => {
  // A real anchor must come from ONE commenter — a phrase that only exists
  // by concatenating the tail of A onto the head of B is not a quote from
  // anyone. This guards a class of false positives the concatenated-corpus
  // approach would silently allow.
  const comments: Comment[] = [
    { text: 'this looks like trash' },
    { text: 'review the code carefully' },
  ];
  expect(validateReceptionAnchor(comments, 'trash review the code')).toBe(false);
  expect(validateReceptionAnchor(comments, 'review the code')).toBe(true); // entirely in comment 2
});

// ── resolveReception — the deterministic core (ISC-126 fail-open) ───────────

test('ISC-126 TRUE-POSITIVE — a ratioed verdict with a valid anchor is honored', () => {
  const comments: Comment[] = [
    { text: "I pay Claude, to use Claude, to write instructions for Claude. Have we all just given up?" },
    { text: 'Holy vibe coding batman this looks like a repository with just a bazillion prompts.' },
    { text: "That's looks like a fair bit of ceremony for what it does." },
  ];
  const raw: RawReception = {
    sentiment: 'negative',
    ratioed: true,
    endorsed: false,
    reason: 'developer exasperation across comments',
    anchor: 'pay Claude, to use Claude',
  };
  const r = resolveReception(comments, raw);
  expect(r.ratioed).toBe(true);
  expect(r.endorsed).toBe(false);
  expect(r.sentiment).toBe('negative');
  expect(r.anchorValid).toBe(true);
});

test('ISC-126 FAIL-OPEN GUARD — a ratioed verdict with an un-checkable anchor is DOWNGRADED', () => {
  // The model says "ratioed=true, sentiment=negative" but cites an anchor that
  // appears nowhere in the comments. A verifier whose reason can't be checked
  // is a rubber stamp on an anti-trending decision; downgrade, never honor.
  const comments: Comment[] = [
    { text: 'Interesting project, will try it out' },
    { text: 'Cool approach' },
  ];
  const raw: RawReception = {
    sentiment: 'negative',
    ratioed: true,
    endorsed: false,
    reason: 'community hates this',
    anchor: 'this is utter trash',
  };
  const r = resolveReception(comments, raw);
  expect(r.ratioed).toBe(false); // fail-open — the ratioed flag is not honored
  expect(r.endorsed).toBe(false);
  expect(r.sentiment).toBe('neutral'); // sentiment also downgraded without anchor
  expect(r.anchorValid).toBe(false);
  expect(r.reason).toContain('uncheckable');
});

test('ISC-126 endorsed=true with an un-checkable anchor is DOWNGRADED', () => {
  const comments: Comment[] = [{ text: 'okay, makes sense I guess' }];
  const raw: RawReception = {
    sentiment: 'positive',
    ratioed: false,
    endorsed: true,
    reason: 'community loves this',
    anchor: 'this is amazing, the best ever',
  };
  const r = resolveReception(comments, raw);
  expect(r.endorsed).toBe(false); // un-checkable endorsement is not honored
  expect(r.anchorValid).toBe(false);
});

test('a negative sentiment WITH a valid anchor but ratioed=false is honored as negative-not-ratioed', () => {
  // Disagreement / technical debate is negative sentiment but NOT ratioed.
  // The classifier MUST be able to express that.
  const comments: Comment[] = [
    { text: 'I think the benchmark methodology has a hole here' },
    { text: 'The selection bias point is real — they should account for it' },
  ];
  const raw: RawReception = {
    sentiment: 'negative',
    ratioed: false,
    endorsed: false,
    reason: 'technical critique, not hostility',
    anchor: 'benchmark methodology has a hole',
  };
  const r = resolveReception(comments, raw);
  expect(r.sentiment).toBe('negative');
  expect(r.ratioed).toBe(false);
  expect(r.endorsed).toBe(false);
  expect(r.anchorValid).toBe(true);
});

test('unknown sentiment string degrades to neutral', () => {
  const comments: Comment[] = [{ text: 'a reasonable comment with enough characters to anchor' }];
  const raw = {
    sentiment: 'enthusiastic' as unknown as Sentiment,
    ratioed: false,
    endorsed: false,
    reason: 'x',
    anchor: 'a reasonable comment',
  } as RawReception;
  const r = resolveReception(comments, raw);
  expect(r.sentiment).toBe('neutral');
  expect(r.anchorValid).toBe(true);
});

// ── classifyReception — orchestration tier (mode-aware) ─────────────────────

test('classifyReception — fixture mode makes NO network calls and stashes NO meta.reception', async () => {
  // harvestMode() defaults to 'live'; force fixture mode for this test so the
  // short-circuit fires. The item must come out of the call with NO
  // meta.reception field — absent = "no signal computed" (honest), never
  // a fabricated neutral.
  const prev = process.env.HARVEST_MODE;
  process.env.HARVEST_MODE = 'fixture';
  try {
    const it = withComments(item({ url: 'https://hn/x' }), [
      { author: 'a', text: 'one comment that is long enough to anchor against' },
    ]);
    const res = await classifyReception([it]);
    expect(res.classified).toBe(0);
    expect(res.noComments).toBe(0);
    expect(res.failed).toBe(0);
    // meta.comments survives; meta.reception is absent.
    expect((it.meta as Record<string, unknown>).comments).toBeDefined();
    expect((it.meta as Record<string, unknown>).reception).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.HARVEST_MODE;
    else process.env.HARVEST_MODE = prev;
  }
});

test('classifyReception — CLASSIFY=0 disables the LLM even in live mode', async () => {
  const prevMode = process.env.HARVEST_MODE;
  const prevClassify = process.env.CLASSIFY;
  process.env.HARVEST_MODE = 'live';
  process.env.CLASSIFY = '0';
  try {
    const it = withComments(item({ url: 'https://hn/y' }), [
      { author: 'a', text: 'another comment long enough to anchor against' },
    ]);
    const res = await classifyReception([it]);
    expect(res.classified).toBe(0);
    expect((it.meta as Record<string, unknown>).reception).toBeUndefined();
  } finally {
    if (prevMode === undefined) delete process.env.HARVEST_MODE;
    else process.env.HARVEST_MODE = prevMode;
    if (prevClassify === undefined) delete process.env.CLASSIFY;
    else process.env.CLASSIFY = prevClassify;
  }
});

test('classifyReception — items without comments are counted as noComments, never get meta.reception', async () => {
  const a = item({ url: 'https://hn/a' }); // no meta.comments at all
  const b = withComments(item({ url: 'https://hn/b' }), []); // meta.comments = []
  const res = await classifyReception([a, b]);
  expect(res.classified).toBe(0);
  expect(res.noComments).toBe(2);
  expect((a.meta as Record<string, unknown> | undefined)?.reception).toBeUndefined();
  expect((b.meta as Record<string, unknown>).reception).toBeUndefined();
});
