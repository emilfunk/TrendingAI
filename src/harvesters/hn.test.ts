import { test, expect, beforeEach, afterEach } from 'bun:test';
import { harvestHN, drainHNCommentErrors } from './hn.ts';
import type { NormalizedItem } from '../types.ts';

/**
 * ISC-155 regression — HN comments capture must:
 *  1. populate meta.comments with top-N {author, text, points, ts} for items
 *     where num_comments > 0 (binary probe in the ISC),
 *  2. on per-item fetch failure, emit meta.comments: [] AND surface the
 *     failure via drainHNCommentErrors() so the orchestrator pushes it onto
 *     the top-level harvest-result errors[] — anti-criterion.
 *
 * The harvester talks to two endpoints: /search (story list) and /items/{id}
 * (comment tree). We stub global fetch to return canned bodies for both.
 */

type FetchInit = { signal?: AbortSignal };
type FetchHandler = (url: string, init?: FetchInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

function installFetch(handler: FetchHandler): void {
  // @ts-expect-error — test override
  globalThis.fetch = (input: string | URL | Request, init?: FetchInit) =>
    handler(String(input), init);
}

beforeEach(() => {
  drainHNCommentErrors();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function searchBody(hits: Array<Partial<{ objectID: string; title: string; url: string; num_comments: number; points: number; created_at: string }>>): string {
  return JSON.stringify({
    hits: hits.map((h) => ({
      objectID: h.objectID ?? '1',
      title: h.title ?? 'A title',
      url: h.url ?? 'https://example.com/a',
      num_comments: h.num_comments ?? 0,
      points: h.points ?? 0,
      created_at: h.created_at ?? '2026-05-15T00:00:00.000Z',
    })),
  });
}

function itemBody(children: Array<Partial<{ author: string; text: string; points: number | null; created_at: string }>>): string {
  return JSON.stringify({
    children: children.map((c) => ({
      author: c.author ?? 'alice',
      text: c.text ?? 'Some opinion.',
      points: c.points ?? null,
      created_at: c.created_at ?? '2026-05-15T01:00:00.000Z',
      type: 'comment',
    })),
  });
}

test('ISC-155: items with num_comments > 0 get meta.comments populated', async () => {
  installFetch(async (url) => {
    if (url.includes('/api/v1/search')) {
      return new Response(searchBody([
        { objectID: '100', title: 'Anthropic restructures Claude plan', url: 'https://example.com/anth', num_comments: 12 },
        { objectID: '101', title: 'No-comment item', url: 'https://example.com/quiet', num_comments: 0 },
      ]), { status: 200 });
    }
    if (url.includes('/api/v1/items/100')) {
      return new Response(itemBody([
        { author: 'devanger', text: '<p>This is <i>infuriating</i> &mdash; removed from sub</p>', points: 8 },
        { author: 'apologist', text: 'Probably reasonable given costs.', points: 2 },
      ]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const items = await harvestHN();
  const errors = drainHNCommentErrors();

  const target = items.find((i) => (i.meta as { objectID?: string })?.objectID === '100') as NormalizedItem;
  const quiet = items.find((i) => (i.meta as { objectID?: string })?.objectID === '101') as NormalizedItem;

  expect(target).toBeDefined();
  expect(Array.isArray((target.meta as { comments?: unknown }).comments)).toBe(true);
  const comments = (target.meta as { comments: Array<{ author: string; text: string; points: number | null; ts: string }> }).comments;
  expect(comments.length).toBe(2);
  const first = comments[0]!;
  expect(first.author).toBe('devanger');
  // HTML stripping: tags gone, entities decoded
  expect(first.text).not.toContain('<');
  expect(first.text).toContain('infuriating');

  // Uniform-shape guarantee: even 0-comment items get meta.comments: []
  expect(quiet).toBeDefined();
  expect((quiet.meta as { comments?: unknown }).comments).toEqual([]);

  // No errors on the happy path
  expect(errors).toEqual([]);
});

test('ISC-155 anti-criterion: fetch failure → meta.comments: [] + errors[] entry', async () => {
  installFetch(async (url) => {
    if (url.includes('/api/v1/search')) {
      return new Response(searchBody([
        { objectID: '200', title: 'Will fail', url: 'https://example.com/fail', num_comments: 5 },
      ]), { status: 200 });
    }
    if (url.includes('/api/v1/items/200')) {
      return new Response('upstream broken', { status: 503 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const items = await harvestHN();
  const errors = drainHNCommentErrors();

  const failed = items.find((i) => (i.meta as { objectID?: string })?.objectID === '200') as NormalizedItem;
  expect(failed).toBeDefined();
  // Anti-criterion: NEVER a partial/lying payload — empty array is honest
  expect((failed.meta as { comments?: unknown }).comments).toEqual([]);

  // Anti-criterion: orchestrator drain surfaces a named error
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('hn comments 200');
  expect(errors[0]).toMatch(/HTTP 503/);
});

test('ISC-155: top-N cap honored when item has many comments', async () => {
  installFetch(async (url) => {
    if (url.includes('/api/v1/search')) {
      return new Response(searchBody([
        { objectID: '300', title: 'Big thread', url: 'https://example.com/big', num_comments: 100 },
      ]), { status: 200 });
    }
    if (url.includes('/api/v1/items/300')) {
      const many = Array.from({ length: 50 }, (_, i) => ({
        author: `u${i}`,
        text: `comment ${i}`,
        points: i,
        created_at: '2026-05-15T01:00:00.000Z',
      }));
      return new Response(itemBody(many), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const items = await harvestHN();
  drainHNCommentErrors();
  const big = items.find((i) => (i.meta as { objectID?: string })?.objectID === '300') as NormalizedItem;
  const comments = (big.meta as { comments: unknown[] }).comments;
  expect(comments.length).toBe(10);
});
