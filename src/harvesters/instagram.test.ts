import { test, expect } from 'bun:test';
import { normalize } from './instagram.ts';

/**
 * ISC-172 — Instagram normalize() returns NormalizedItem with `source:
 * 'instagram'`, engagement from likes/comments/plays, and `meta.media`
 * populated with the reel URL (or post URL fallback). Pure unit tests.
 */

test('normalize returns NormalizedItem with source=instagram and meta.media on a complete reel item', () => {
  const raw = {
    url: 'https://www.instagram.com/reel/C7q8L4mNvX2/',
    videoUrl: 'https://video.instagram.com/v/C7q8L4mNvX2.mp4',
    caption: 'Claude shipped Excel integrations today #ai #claude',
    ownerUsername: 'thealexstudio',
    likesCount: 9750,
    commentsCount: 412,
    videoPlayCount: 318000,
    timestamp: '2026-05-13T16:21:08.000Z',
    type: 'Video',
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.source).toBe('instagram');
  expect(item!.url).toBe(raw.url);
  // Reel video URL preferred over the canonical reel URL for meta.media
  expect((item!.meta as { media?: string }).media).toBe(raw.videoUrl);
  // engagement: likes + comments*2 + floor(plays/100) = 9750 + 824 + 3180 = 13754
  expect(item!.engagement).toBe(13754);
});

test('normalize falls back to post URL for meta.media when videoUrl absent', () => {
  const raw = {
    url: 'https://www.instagram.com/p/C7hN9KrtVwq/',
    caption: 'carousel post',
    ownerUsername: 'mlmondays',
    likesCount: 1620,
    commentsCount: 78,
    timestamp: '2026-05-10T09:14:23.000Z',
    type: 'Sidecar',
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect((item!.meta as { media?: string }).media).toBe(raw.url);
});

test('normalize constructs URL from shortCode when url absent', () => {
  const raw = {
    shortCode: 'C7hN9KrtVwq',
    caption: 'hello',
    ownerUsername: 'fallback',
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.url).toBe('https://www.instagram.com/p/C7hN9KrtVwq/');
});

test('normalize returns null when caption AND text missing', () => {
  const raw = { url: 'https://www.instagram.com/p/x/', ownerUsername: 'x' };
  expect(normalize(raw)).toBeNull();
});

test('normalize returns null when url cannot be resolved', () => {
  const raw = { caption: 'no url, no shortcode', ownerUsername: 'x' };
  expect(normalize(raw)).toBeNull();
});

test('normalize handles zero engagement (no NaN)', () => {
  const raw = {
    url: 'https://www.instagram.com/p/zero/',
    caption: 'silence',
    ownerUsername: 'zero',
  };
  const item = normalize(raw);
  expect(item).not.toBeNull();
  expect(item!.engagement).toBe(0);
  expect(Number.isFinite(item!.engagement)).toBe(true);
});
