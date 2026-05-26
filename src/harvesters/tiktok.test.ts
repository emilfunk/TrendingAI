import { test, expect } from 'bun:test';
import { normalize } from './tiktok.ts';

/**
 * ISC-171 — TikTok normalize() returns NormalizedItem with `source: 'tiktok'`,
 * engagement composed from likes/shares/comments/plays, and `meta.media`
 * populated with the reel URL. Pure unit tests — no network, no Apify.
 */

test('normalize returns NormalizedItem with source=tiktok and meta.media on a complete raw item', () => {
  const raw = {
    webVideoUrl: 'https://www.tiktok.com/@aiexplained/video/7397822541098273029',
    text: 'Claude Code agent view is wild #ai #claude',
    authorMeta: { name: 'aiexplained', nickName: 'AI Explained' },
    diggCount: 1200,
    playCount: 48000,
    shareCount: 80,
    commentCount: 45,
    createTimeISO: '2026-05-13T14:02:11.000Z',
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.source).toBe('tiktok');
  expect(item!.url).toBe(raw.webVideoUrl);
  expect((item!.meta as { media?: string }).media).toBe(raw.webVideoUrl);
  // engagement formula: likes + shares*2 + comments + floor(plays/100) =
  // 1200 + 160 + 45 + 480 = 1885
  expect(item!.engagement).toBe(1885);
  expect(item!.title.startsWith('@aiexplained:')).toBe(true);
});

test('normalize returns null when url is missing', () => {
  const raw = { text: 'a post with no url', authorMeta: { name: 'x' } };
  expect(normalize(raw)).toBeNull();
});

test('normalize returns null when text is missing', () => {
  const raw = { webVideoUrl: 'https://www.tiktok.com/@x/video/1', authorMeta: { name: 'x' } };
  expect(normalize(raw)).toBeNull();
});

test('normalize falls back to url field and unknown author when authorMeta absent', () => {
  const raw = { url: 'https://www.tiktok.com/@anon/video/1', text: 'hi' };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.source).toBe('tiktok');
  expect((item!.meta as { author?: string }).author).toBe('unknown');
});

test('normalize handles zero engagement gracefully (no NaN)', () => {
  const raw = {
    webVideoUrl: 'https://www.tiktok.com/@zero/video/1',
    text: 'silence',
    authorMeta: { name: 'zero' },
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.engagement).toBe(0);
  expect(Number.isFinite(item!.engagement)).toBe(true);
});
