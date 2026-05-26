import { test, expect } from 'bun:test';
import { validateAnchor, resolveClassification } from './classify.ts';
import type { Verdict, RawClassification } from './classify.ts';
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
 * ISC-113/114 regression harness — the reasoning classifier's PURE core,
 * tested offline (no LLM, deterministic). The classifier is only a verifier if
 * it has BOTH a true-positive (keeps real AI-news) AND a true-negative (drops
 * real marketing) — AND the rubber-stamp guard: a drop with an un-checkable
 * anchor must NOT be honored, or the "verifier" is indistinguishable from a
 * rubber stamp. The anchor is the boundary artifact; validateAnchor is its
 * test.
 */

// ── validateAnchor — the boundary primitive ─────────────────────────────────

test('validateAnchor — a literal substring of title or raw_text passes', () => {
  const it = item({ title: '[Anthropic] Introducing Claude Opus 4.7', raw_text: 'a new frontier model' });
  expect(validateAnchor(it, 'Claude Opus 4.7')).toBe(true); // in title
  expect(validateAnchor(it, 'frontier model')).toBe(true); // in raw_text
  expect(validateAnchor(it, 'CLAUDE opus  4.7')).toBe(true); // case + whitespace normalized
});

test('validateAnchor — a paraphrase, an absent phrase, or a too-short anchor fails', () => {
  const it = item({ title: '[Anthropic] Introducing Claude Opus 4.7', raw_text: 'a new frontier model' });
  expect(validateAnchor(it, 'a new Anthropic release')).toBe(false); // paraphrase, not a substring
  expect(validateAnchor(it, 'GPT-5')).toBe(false); // simply absent
  expect(validateAnchor(it, 'AI')).toBe(false); // too short to be checkable
  expect(validateAnchor(it, '')).toBe(false); // empty
});

test('validateAnchor — a trivially short single word is NOT a checkable anchor', () => {
  // The advisor's hole (iteration 13): a model could "anchor" a drop on a
  // trivially-present common word. A real anchor must be a real phrase.
  const it = item({ title: 'A new AI model from a frontier lab', raw_text: 'the agent reasons well' });
  expect(validateAnchor(it, 'model')).toBe(false); // present, but too short to be checkable
  expect(validateAnchor(it, 'the AI')).toBe(false); // present, but too short
  expect(validateAnchor(it, 'frontier lab')).toBe(true); // a real phrase, present
});

test('validateAnchor — a curly/straight quote mismatch still validates (normalization)', () => {
  // Real item titles carry smart quotes — the live run showed
  // 'Made by Africa, Loved by the World'. A model echoing straight quotes
  // must still match, or a valid drop is silently discarded.
  const it = item({ title: '[Meta] ‘Made by Africa, Loved by the World’ 2026 showcase' });
  expect(validateAnchor(it, "'Made by Africa, Loved by the World'")).toBe(true);
});

// ── resolveClassification — the deterministic core (ISC-114) ────────────────

test('ISC-114 TRUE-POSITIVE — an AI-news item with a valid anchor is kept', () => {
  const it = item({ source: 'frontier', title: '[OpenAI] GPT-5 reasoning upgrade', raw_text: 'better at math proofs' });
  const raw: RawClassification = {
    verdict: 'AI-news',
    reason: 'a model capability release',
    anchor: 'GPT-5 reasoning upgrade',
  };
  const r = resolveClassification(it, raw);
  expect(r.action).toBe('keep');
  expect(r.verdict).toBe('AI-news');
  expect(r.anchorValid).toBe(true);
});

test('ISC-114 TRUE-NEGATIVE — a marketing item with a valid anchor is dropped', () => {
  const it = item({
    source: 'frontier',
    title: '[Meta] Celebrating African Cinema with Made by Africa',
    raw_text: 'a cultural showcase event',
  });
  const raw: RawClassification = {
    verdict: 'marketing',
    reason: 'corporate event promotion, no AI news',
    anchor: 'Celebrating African Cinema',
  };
  const r = resolveClassification(it, raw);
  expect(r.action).toBe('drop');
  expect(r.verdict).toBe('marketing');
  expect(r.anchorValid).toBe(true);
});

test('ISC-114 RUBBER-STAMP GUARD — a drop verdict with an un-checkable anchor is NOT honored', () => {
  // The model says "drop, it's marketing" but cites an anchor that appears
  // nowhere in the item — an un-checkable reason. A verifier whose reason
  // can't be checked is a rubber stamp; fail open and keep the item.
  const it = item({ source: 'frontier', title: '[Anthropic] Introducing Claude Opus 4.7', raw_text: 'a new frontier model' });
  const raw: RawClassification = {
    verdict: 'marketing',
    reason: 'looks promotional',
    anchor: 'buy now limited offer',
  };
  const r = resolveClassification(it, raw);
  expect(r.action).toBe('keep'); // fail-open — the drop is not honored
  expect(r.anchorValid).toBe(false);
  expect(r.reason).toContain('uncheckable');
});

test('a keep verdict is honored even when its anchor is bad — never lose real signal', () => {
  const it = item({ title: 'New LLM agent benchmark', raw_text: 'reasoning models compared' });
  const raw: RawClassification = {
    verdict: 'AI-news',
    reason: 'a benchmark release',
    anchor: 'totally not present in the item',
  };
  const r = resolveClassification(it, raw);
  expect(r.action).toBe('keep');
  expect(r.anchorValid).toBe(false);
});

test('an unknown verdict string degrades to AI-adjacent and is kept', () => {
  const it = item({ title: 'something about models', raw_text: 'about AI' });
  const raw = { verdict: 'spammy' as unknown as Verdict, reason: 'x', anchor: 'something about models' };
  const r = resolveClassification(it, raw);
  expect(r.verdict).toBe('AI-adjacent');
  expect(r.action).toBe('keep');
});
