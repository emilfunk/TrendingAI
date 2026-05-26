/**
 * One-shot smoke test for T-ISC-C fix.
 *
 * Reads a small slice of items from data/all.json, runs them through
 * classifyTypes() with HARVEST_MODE=live forced so the real Inference.ts
 * batch path executes (not the short-circuit fallback). Reports the
 * classifier-source + content-type distribution so we can confirm the
 * 15s-timeout bug is gone.
 *
 * NOT a permanent script — delete after verification or keep as a
 * targeted smoke probe.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../src/types.ts';

// Force live mode so the LLM classifier actually fires (default fixture
// mode short-circuits to platform prior — that's the path we are NOT
// testing here).
process.env.HARVEST_MODE = 'live';

const { classifyTypes } = await import('../src/classify-type.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const raw = await readFile(resolve(ROOT, 'data', 'all.json'), 'utf-8');
const parsed = JSON.parse(raw) as { items?: NormalizedItem[] } | NormalizedItem[];
const allItems: NormalizedItem[] = Array.isArray(parsed) ? parsed : (parsed.items ?? []);

// Take a balanced slice across sources so the smoke test covers multiple
// platform priors, not just the first 25 of a single source.
const SLICE_PER_SOURCE = 4;
const bySource = new Map<string, NormalizedItem[]>();
for (const it of allItems) {
  const arr = bySource.get(it.source) ?? [];
  if (arr.length < SLICE_PER_SOURCE) {
    arr.push(it);
    bySource.set(it.source, arr);
  }
}
const sample: NormalizedItem[] = [];
for (const arr of bySource.values()) sample.push(...arr);

console.log(`Smoke test: ${sample.length} items across ${bySource.size} source classes`);
console.log(`Starting classifyTypes() at ${new Date().toISOString()}...`);

const t0 = Date.now();
const result = await classifyTypes(sample);
const elapsedMs = Date.now() - t0;

console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s`);
console.log();

// Tally by classifier source — this is the headline metric.
const sourceTally = new Map<string, number>();
const typeTally = new Map<string, number>();
for (const r of result.resolved.values()) {
  sourceTally.set(r.source, (sourceTally.get(r.source) ?? 0) + 1);
  typeTally.set(r.type, (typeTally.get(r.type) ?? 0) + 1);
}

console.log('classifier source distribution:');
for (const [k, v] of sourceTally) console.log(`  ${k}: ${v}`);
console.log();
console.log('content-type distribution:');
for (const [k, v] of typeTally) console.log(`  ${k}: ${v}`);
console.log();

// Show first 10 LLM-verdict items with their anchors so we can eyeball
// whether the verdicts make sense.
console.log('first 10 LLM-verdict items:');
let shown = 0;
for (const it of sample) {
  if (shown >= 10) break;
  const r = result.resolved.get(it.url);
  if (!r || r.source !== 'llm') continue;
  const valid = r.anchorValid ? '✓' : '✗';
  console.log(
    `  [${it.source}] type=${r.type.padEnd(18)} anchor=${valid} prior=${r.matchesPrior ? '✓' : '✗'} | ${it.title.slice(0, 80)}`,
  );
  shown++;
}

// Headline result: if prior-fallback is still 100%, the fix didn't work.
const prior = sourceTally.get('prior-fallback') ?? 0;
const llm = sourceTally.get('llm') ?? 0;
const total = sample.length;
console.log();
if (llm === 0) {
  console.log(`FAIL: 0/${total} LLM verdicts; ${prior}/${total} prior-fallback. Fix did not land.`);
  process.exit(1);
} else if (prior > llm) {
  console.log(
    `PARTIAL: ${llm}/${total} LLM, ${prior}/${total} prior-fallback. Fix helps but BATCH_SIZE may still need tuning.`,
  );
} else {
  console.log(`PASS: ${llm}/${total} LLM verdicts dominant; ${prior}/${total} prior-fallback. T-ISC-C closed.`);
}
