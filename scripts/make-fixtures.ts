/**
 * Derives committed fixtures from the latest live harvest.
 *
 * Run AFTER `bun run harvest:all` (which writes data/all.json). Produces:
 *   fixtures/{source}.json       — happy path: top-N real captured items by engagement
 *   fixtures/edge/{source}.json  — edge cases: deterministic degenerate mutations
 *                                  of the happy-path slice (zero/negative signal,
 *                                  empty text, no meta, unicode + overlong title,
 *                                  exact-duplicate URL to exercise dedupe).
 *
 * Fixtures are small, curated, and committed to git — distinct from the
 * gitignored archival snapshots under data/raw/ (ISA ISC-57).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem, Source } from '../src/types.ts';
import { stableStringify } from '../src/stable-json.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// X included as of iteration 7: a paid Apify run returned real (non-demo)
// tweets, so X now has a real captured snapshot to derive a replay fixture
// from. This is the "covered by replay" path for the Class-2 source (ISC-69) —
// make-fixtures simply skips any source absent from data/all.json, so a
// token-less harvest still produces fixtures for the seven Class-1 sources.
const SOURCES: Source[] = ['hn', 'arxiv', 'github', 'frontier', 'youtube', 'reddit', 'bluesky', 'x'];
const PER_SOURCE = 4;

function edgeCases(base: NormalizedItem): NormalizedItem[] {
  return [
    // zero-signal item: no engagement, empty body, missing meta
    { ...base, engagement: 0, raw_text: '', meta: {} },
    // hostile shape: negative engagement + unicode + overlong title
    {
      ...base,
      title: '🤖 ' + '语言模型 nÃ¶ise '.repeat(40),
      engagement: -5,
      raw_text: '🤖🤖🤖',
    },
    // exact-duplicate url — must collapse in dedupe, not crash
    { ...base },
  ];
}

async function main(): Promise<void> {
  const raw = await readFile(resolve(ROOT, 'data', 'all.json'), 'utf8');
  const all = JSON.parse(raw) as { items: NormalizedItem[] };

  await mkdir(resolve(ROOT, 'fixtures', 'edge'), { recursive: true });

  for (const s of SOURCES) {
    const items = all.items.filter((i) => i.source === s);
    const happy = [...items].sort((a, b) => b.engagement - a.engagement).slice(0, PER_SOURCE);
    if (happy.length === 0) {
      console.error(`  skip ${s}: no items in data/all.json`);
      continue;
    }
    await writeFile(resolve(ROOT, 'fixtures', `${s}.json`), stableStringify(happy) + '\n');
    const base = happy[0];
    const edge = base ? edgeCases(base) : [];
    await writeFile(resolve(ROOT, 'fixtures', 'edge', `${s}.json`), stableStringify(edge) + '\n');
    console.log(`fixtures/${s}.json — ${happy.length} items · fixtures/edge/${s}.json — ${edge.length} items`);
  }
}

main().catch((e) => {
  console.error('make-fixtures failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
