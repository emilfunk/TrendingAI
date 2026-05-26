/**
 * ISC-153 — benchmark check. Loads `benchmark/known-stories.json` and reports,
 * for each known-real AI story, whether it surfaced in the last live harvest
 * (`data/all.json`) and whether the surfacing items were correctly typed.
 *
 * Run AFTER a live `bun run report`:
 *   bun scripts/check-benchmark.ts
 *
 * The file is the test oracle (not a paragraph about one — advisor, iteration
 * 15). Output is structured: a JSON report at `out/benchmark-check.json` plus
 * a console summary so the result lives both in the repo and in the run log.
 *
 * Exit code: 0 always (the check is informational, not a CI gate yet — the
 * harvest cadence and the story-set both evolve faster than CI thresholds).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../src/types.ts';
import type { ContentType } from '../src/classify-type.ts';
import { getResolvedType } from '../src/classify-type.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BENCHMARK_PATH = resolve(ROOT, 'benchmark', 'known-stories.json');
// Prefer data/typed.json (post-classify-type snapshot) — that's where the
// typed meta lives. Fall back to data/all.json (raw harvest) with a notice if
// typed.json is missing (e.g. an old harvest predating the typing pipeline).
const TYPED_PATH = resolve(ROOT, 'data', 'typed.json');
const ALL_PATH = resolve(ROOT, 'data', 'all.json');
const REPORT_PATH = resolve(ROOT, 'out', 'benchmark-check.json');

type Story = {
  id: string;
  name: string;
  expectedType: ContentType;
  expectedPlatforms: string[];
  matchTerms: string[];
  matchAllRequired?: boolean;
  minimumMatchedTerms?: number;
  notes?: string;
};

type Benchmark = {
  version: number;
  purpose: string;
  matchPolicy: string;
  stories: Story[];
};

type StoryResult = {
  id: string;
  name: string;
  surfaced: boolean;
  matchedCount: number;
  matchedSources: Record<string, number>;
  expectedPlatformsHit: string[];
  expectedPlatformsMissed: string[];
  observedTypes: Record<string, number>;
  expectedTypeCount: number;
  typedAsExpected: boolean;
  examples: { title: string; url: string; source: string; type: string | null }[];
  notes?: string;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function itemMatchesStory(item: NormalizedItem, story: Story): { matched: boolean; matchedTermsCount: number } {
  const hay = norm(`${item.title} ${item.raw_text}`);
  const terms = story.matchTerms.map(norm);
  const min =
    story.matchAllRequired === true
      ? terms.length
      : Math.max(1, story.minimumMatchedTerms ?? 1);
  let hits = 0;
  for (const t of terms) if (t && hay.includes(t)) hits++;
  return { matched: hits >= min, matchedTermsCount: hits };
}

async function loadBenchmark(): Promise<Benchmark> {
  const raw = await readFile(BENCHMARK_PATH, 'utf8');
  return JSON.parse(raw) as Benchmark;
}

async function loadHarvest(): Promise<{ items: NormalizedItem[]; sourcePath: string }> {
  try {
    const raw = await readFile(TYPED_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { items?: NormalizedItem[] };
    return { items: parsed.items ?? [], sourcePath: TYPED_PATH };
  } catch {
    // Fall back to raw harvest — types will be null but surfacing still works.
    const raw = await readFile(ALL_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { items?: NormalizedItem[] };
    return { items: parsed.items ?? [], sourcePath: ALL_PATH };
  }
}

function checkStory(story: Story, items: NormalizedItem[]): StoryResult {
  const matched: NormalizedItem[] = [];
  for (const it of items) {
    const { matched: m } = itemMatchesStory(it, story);
    if (m) matched.push(it);
  }

  const matchedSources: Record<string, number> = {};
  const observedTypes: Record<string, number> = {};
  let expectedTypeCount = 0;
  for (const it of matched) {
    matchedSources[it.source] = (matchedSources[it.source] ?? 0) + 1;
    const t = getResolvedType(it)?.type ?? null;
    const tKey = t ?? 'unclassified';
    observedTypes[tKey] = (observedTypes[tKey] ?? 0) + 1;
    if (t === story.expectedType) expectedTypeCount++;
  }

  const expectedPlatformsHit = story.expectedPlatforms.filter((p) => (matchedSources[p] ?? 0) > 0);
  const expectedPlatformsMissed = story.expectedPlatforms.filter((p) => (matchedSources[p] ?? 0) === 0);

  return {
    id: story.id,
    name: story.name,
    surfaced: matched.length > 0,
    matchedCount: matched.length,
    matchedSources,
    expectedPlatformsHit,
    expectedPlatformsMissed,
    observedTypes,
    expectedTypeCount,
    typedAsExpected: matched.length > 0 && expectedTypeCount > 0,
    examples: matched.slice(0, 3).map((it) => ({
      title: it.title.slice(0, 120),
      url: it.url,
      source: it.source,
      type: getResolvedType(it)?.type ?? null,
    })),
    notes: story.notes,
  };
}

async function main(): Promise<void> {
  let benchmark: Benchmark;
  try {
    benchmark = await loadBenchmark();
  } catch (e) {
    console.error(`could not load benchmark file: ${e instanceof Error ? e.message : e}`);
    process.exit(0);
    return;
  }

  let items: NormalizedItem[];
  let sourcePath: string;
  try {
    const loaded = await loadHarvest();
    items = loaded.items;
    sourcePath = loaded.sourcePath;
  } catch {
    console.error(
      `data/typed.json and data/all.json both missing — run a live \`bun run report\` first, then re-run this check.`,
    );
    process.exit(0);
    return;
  }
  const usedFallback = sourcePath.endsWith('all.json');
  if (usedFallback) {
    console.error(
      'NOTE: reading from data/all.json (raw harvest) — types will appear unclassified. Run a live `bun run report` to populate data/typed.json with classified items.',
    );
  }

  const results = benchmark.stories.map((s) => checkStory(s, items));

  const surfaced = results.filter((r) => r.surfaced).length;
  const typed = results.filter((r) => r.typedAsExpected).length;
  const total = results.length;

  console.log('=== benchmark check ===');
  console.log(`harvest: ${items.length} items`);
  console.log(`stories: ${surfaced}/${total} surfaced, ${typed}/${total} typed as expected`);
  console.log('');
  for (const r of results) {
    const status = r.surfaced ? (r.typedAsExpected ? 'OK ' : 'TYPE-MISS') : 'MISSING';
    console.log(`  [${status}] ${r.id} — ${r.name}`);
    console.log(`     matched: ${r.matchedCount} items`);
    if (r.matchedCount > 0) {
      const sources = Object.entries(r.matchedSources).map(([k, v]) => `${k}:${v}`).join(', ');
      const types = Object.entries(r.observedTypes).map(([k, v]) => `${k}:${v}`).join(', ');
      console.log(`     sources: ${sources}`);
      console.log(`     types:   ${types}`);
      if (r.expectedPlatformsMissed.length > 0) {
        console.log(`     missing-platforms: ${r.expectedPlatformsMissed.join(', ')}`);
      }
      for (const ex of r.examples) {
        console.log(`     • [${ex.source}/${ex.type ?? 'unclassified'}] ${ex.title}`);
      }
    }
  }

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        harvest_item_count: items.length,
        summary: { surfaced, typed_as_expected: typed, total },
        results,
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log(`structured report: ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error('benchmark check failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
