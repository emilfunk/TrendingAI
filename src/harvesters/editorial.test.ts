import { describe, expect, test } from 'bun:test';
import { normalize } from './editorial.ts';

const FEED_LWIA = { publisher: 'last-week-in-ai', label: 'Last Week in AI', url: 'https://lastweekin.ai/feed' };
const FEED_IMPORT = { publisher: 'import-ai', label: 'Import AI', url: 'https://jack-clark.net/feed/' };

describe('editorial harvester normalize() (ISC-184)', () => {
  const NOW = Date.parse('2026-05-15T12:00:00Z');

  test('returns NormalizedItem with source=editorial + meta.publisher on a happy-path item', () => {
    const it = normalize(
      FEED_LWIA,
      'Last Week in AI #340 — DeepSeek v4, Vision Banana',
      'https://lastweekin.ai/p/lwia-340',
      'Fri, 15 May 2026 08:00:00 GMT',
      'Weekly AI roundup covering OpenAI v Musk, DeepSeek, vision models.',
      NOW,
    );
    expect(it).not.toBeNull();
    expect(it?.source).toBe('editorial');
    expect((it?.meta as { publisher?: string } | undefined)?.publisher).toBe('last-week-in-ai');
    expect((it?.meta as { date_basis?: string } | undefined)?.date_basis).toBe('feed-pubdate');
    expect(it?.title.startsWith('[Last Week in AI]')).toBe(true);
    expect(it?.engagement).toBeGreaterThan(0);
  });

  test('engagement is a freshness proxy: fresher item scores higher than older one (ISC-184)', () => {
    const fresh = normalize(FEED_IMPORT, 'fresh', 'https://x', new Date(NOW - 2 * 3_600_000).toISOString(), '', NOW);
    const stale = normalize(FEED_IMPORT, 'stale', 'https://y', new Date(NOW - 100 * 3_600_000).toISOString(), '', NOW);
    expect(fresh).not.toBeNull();
    expect(stale).not.toBeNull();
    expect(fresh!.engagement).toBeGreaterThan(stale!.engagement);
  });

  test('missing title returns null', () => {
    const it = normalize(FEED_LWIA, '', 'https://x', 'Fri, 15 May 2026 00:00:00 GMT', 'has summary', NOW);
    expect(it).toBeNull();
  });

  test('missing link returns null', () => {
    const it = normalize(FEED_LWIA, 'has title', '', 'Fri, 15 May 2026 00:00:00 GMT', 'has summary', NOW);
    expect(it).toBeNull();
  });

  test('missing pubDate falls back to fetch time + tags date_basis feed-fallback', () => {
    const it = normalize(FEED_IMPORT, 'no-date item', 'https://x', '', 'summary', NOW);
    expect(it).not.toBeNull();
    expect((it?.meta as { date_basis?: string } | undefined)?.date_basis).toBe('feed-fallback');
    expect(Date.parse(it!.ts)).toBe(NOW);
  });

  test('item older than 14 days is dropped (ISC-184 freshness window)', () => {
    const old = new Date(NOW - 20 * 86_400_000).toISOString();
    const it = normalize(FEED_LWIA, 'stale', 'https://x', old, 'summary', NOW);
    expect(it).toBeNull();
  });

  test('CDATA + HTML entities decoded in title and summary', () => {
    const it = normalize(
      FEED_LWIA,
      '<![CDATA[Anthropic &amp; OpenAI — what&#39;s new]]>',
      'https://x',
      'Fri, 15 May 2026 08:00:00 GMT',
      '<![CDATA[Summary with <p>tags</p> &amp; entities]]>',
      NOW,
    );
    expect(it).not.toBeNull();
    expect(it?.title).toContain('Anthropic & OpenAI');
    expect(it?.title).toContain("what's new");
    expect((it?.meta as { summary?: string } | undefined)?.summary).toContain('& entities');
    expect((it?.meta as { summary?: string } | undefined)?.summary).not.toContain('<p>');
  });

  test('Anti (ISC-192): editorial items do not clash URL-wise with frontier hosts', () => {
    // Smoke: an editorial item's URL must NOT be on a frontier-lab host. The
    // feed URLs configured for editorial (lastweekin.ai, jack-clark.net) cannot
    // produce openai.com/anthropic.com/deepmind.com canonical URLs — this test
    // asserts the input invariant the feed-selection upholds.
    const it = normalize(
      FEED_LWIA,
      'A linked item',
      'https://lastweekin.ai/p/some-post',
      'Fri, 15 May 2026 08:00:00 GMT',
      'summary',
      NOW,
    );
    expect(it).not.toBeNull();
    const url = it!.url;
    const frontierHosts = ['openai.com', 'anthropic.com', 'deepmind.com', 'huggingface.co', 'blog.google', 'about.fb.com', 'mistral.ai'];
    for (const h of frontierHosts) {
      expect(url).not.toContain(h);
    }
  });
});
