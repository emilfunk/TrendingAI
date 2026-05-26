import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_PATH = resolve(__dirname, '..', 'benchmark', 'known-stories.json');

const ALLOWED_TYPES = [
  'news', 'enterprise-news', 'feature', 'tutorial', 'trending-repo',
  'research', 'influencer-content', 'community', 'uncategorized',
] as const;
const ALLOWED_PLATFORMS = ['hn', 'arxiv', 'github', 'x', 'frontier', 'youtube', 'reddit', 'bluesky'] as const;

/**
 * ISC-153 shape test — keeps the benchmark oracle honest. Without this, the
 * file could drift to expectedType: 'newz' or expectedPlatforms: ['twitter']
 * and silently never match anything in a real harvest.
 */
test('benchmark/known-stories.json — every story has a known type and known platforms', async () => {
  const raw = await readFile(BENCHMARK_PATH, 'utf8');
  const data = JSON.parse(raw) as {
    version: number;
    stories: {
      id: string;
      expectedType: string;
      expectedPlatforms: string[];
      matchTerms: string[];
    }[];
  };
  expect(data.version).toBeGreaterThan(0);
  expect(data.stories.length).toBeGreaterThan(0);
  const seenIds = new Set<string>();
  for (const s of data.stories) {
    expect(s.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(seenIds.has(s.id)).toBe(false);
    seenIds.add(s.id);
    expect(ALLOWED_TYPES).toContain(s.expectedType);
    expect(s.expectedPlatforms.length).toBeGreaterThan(0);
    for (const p of s.expectedPlatforms) expect(ALLOWED_PLATFORMS).toContain(p);
    expect(s.matchTerms.length).toBeGreaterThan(0);
    for (const t of s.matchTerms) expect(t.length).toBeGreaterThan(0);
  }
});
