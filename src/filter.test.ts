import { test, expect } from 'bun:test';
import { applyLeakFilter } from './filter.ts';
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
 * ISC-112 regression harness. A filter is only a verifier if it has BOTH a
 * true-positive (catches the known leak) AND a true-negative (lets the real
 * thing through) — without the true-negative you can't tell a filter from a
 * rubber stamp. These cases are the exact leaks and the exact false positives
 * a live run surfaced in iteration 11.
 */

test('ISC-112 TRUE-POSITIVE — drops the three named leaks', () => {
  const leaks = [
    item({ source: 'frontier', title: '[Meta] Celebrating African Cinema With the Made by Africa 2026' }),
    item({ source: 'frontier', title: '[Google AI] 5 gardening tips you can try right in Search' }),
    item({
      source: 'youtube',
      title: '[Lex Fridman] FFmpeg: The Incredible Technology Behind Video',
      raw_text: 'video codecs and streaming on the internet',
    }),
  ];
  const { kept, dropped } = applyLeakFilter(leaks);
  expect(kept.length).toBe(0);
  expect(dropped.length).toBe(3);
  expect(dropped.map((d) => d.reason).sort()).toEqual(
    ['deny:consumer-lifestyle-puff', 'deny:corporate-event-marketing', 'deny:youtube-no-ai-signal'].sort(),
  );
});

test('ISC-112 TRUE-NEGATIVE — keeps real items that incidentally matched in raw_text', () => {
  // The live-run false positives: an arXiv paper whose abstract said "recipe",
  // researcher tweets that said "celebrate" / "in your daily life". None are
  // frontier/youtube, so the deny-list must not touch them.
  const real = [
    item({ source: 'arxiv', title: 'Dense vs Sparse Pretraining at Tiny Scale', raw_text: 'we propose a training recipe for ...' }),
    item({ source: 'x', title: '@iScienceLuvr: in the next 1-2 months we celebrate 3 more releases' }),
    item({ source: 'x', title: '@GoogleDeepMind: an AI pointer to help in your daily life' }),
    item({ source: 'frontier', title: '[Anthropic] Introducing Claude Opus 4.7' }),
    item({ source: 'youtube', title: 'New LLM agent benchmark explained', raw_text: 'reasoning models compared' }),
  ];
  const { kept, dropped } = applyLeakFilter(real);
  expect(dropped.length).toBe(0);
  expect(kept.length).toBe(5);
});

test('ISC-112 — the youtube AI-positive gate is youtube-only', () => {
  // A non-AI item from a non-youtube source must NOT be dropped by the youtube
  // gate — other sources gate on AI keywords at harvest time.
  const { dropped } = applyLeakFilter([
    item({ source: 'youtube', title: 'My woodworking weekend', raw_text: 'building a table' }),
    item({ source: 'hn', title: 'A post with no obvious keyword', raw_text: 'plain text' }),
  ]);
  expect(dropped.length).toBe(1);
  expect(dropped[0]?.item.source).toBe('youtube');
  expect(dropped[0]?.reason).toBe('deny:youtube-no-ai-signal');
});
