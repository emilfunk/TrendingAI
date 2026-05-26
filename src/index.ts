import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { harvestAll } from './harvesters/orchestrator.ts';
import { harvestMode } from './harvesters/_fixtures.ts';
import { stableStringify } from './stable-json.ts';
import { dedupeAndCluster } from './dedupe.ts';
import { scoreClusters, topViral, topPreViral } from './scoring.ts';
import { verifyAndPrune } from './verifier.ts';
import { tagConfidence } from './confidence.ts';
import { render } from './render.ts';
import { applyLeakFilter } from './filter.ts';
import { classifyItems } from './classify.ts';
import { classifyTypes } from './classify-type.ts';
import { classifyReception } from './classify-reception.ts';
import type { RunStats, Source } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'out', 'report.html');

async function main(): Promise<void> {
  console.log('TrendingAI :: pipeline start');

  const harvest = await harvestAll();
  console.log(
    `  harvest: ${harvest.items.length} items (` +
    Object.entries(harvest.bySource).map(([k, v]) => `${k}:${v}`).join(', ') + ')'
  );
  if (harvest.errors.length) for (const e of harvest.errors) console.error(`  WARN ${e}`);
  if (harvest.items.length === 0) {
    console.error('All harvesters returned zero — aborting.');
    process.exit(1);
  }

  // Persist the raw harvest so a live `bun run report` leaves the same
  // inspectable artifact `bun run harvest:all` does — lets any source be
  // spot-checked (e.g. confirm X returned real tweets, not demo data) without
  // re-harvesting. Skipped in fixture/edge mode (the input already lives in
  // fixtures/, and overwriting data/all.json with replayed items would be
  // misleading). data/all.json is gitignored — run output, not a contract.
  if (harvestMode() === 'live') {
    await mkdir(resolve(ROOT, 'data'), { recursive: true });
    await writeFile(
      resolve(ROOT, 'data', 'all.json'),
      stableStringify({ bySource: harvest.bySource, errors: harvest.errors, items: harvest.items }),
    );
  }

  // ISC-112 — rule-based leak filter. Drops corporate-marketing, consumer puff,
  // and off-topic items that slipped past the per-harvester AI gates. Every
  // drop is logged with its reason — the filter is auditable, never silent.
  const { kept, dropped } = applyLeakFilter(harvest.items);
  if (dropped.length > 0) {
    const byReason = dropped.reduce<Record<string, number>>((a, d) => {
      a[d.reason] = (a[d.reason] ?? 0) + 1;
      return a;
    }, {});
    console.log(
      `  filter: ${harvest.items.length} in -> ${kept.length} kept, ${dropped.length} dropped (` +
        Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join(', ') + ')',
    );
    for (const d of dropped.slice(0, 25)) {
      console.log(`    drop [${d.reason}] ${d.item.title.slice(0, 84)}`);
    }
    if (dropped.length > 25) console.log(`    … and ${dropped.length - 25} more`);
  } else {
    console.log(`  filter: ${harvest.items.length} in -> ${kept.length} kept, 0 dropped`);
  }

  // ISC-113 — reasoning classifier. A per-item verdict {AI-news/AI-adjacent/
  // marketing/not-AI} with an anchor-cited reason; marketing/not-AI dropped,
  // but ONLY when the reason cites an anchor mechanically present in the item
  // (fail-open — see classify.ts). Mode-aware: no network egress in fixture/
  // replay mode. Every kept item carries meta.classify for the render layer.
  const classified = await classifyItems(kept);
  if (classified.dropped.length > 0) {
    console.log(
      `  classify: ${kept.length} in -> ${classified.kept.length} kept, ${classified.dropped.length} dropped`,
    );
    for (const d of classified.dropped.slice(0, 25)) {
      console.log(`    drop [${d.reason.slice(0, 84)}] ${d.item.title.slice(0, 64)}`);
    }
    if (classified.dropped.length > 25) console.log(`    … and ${classified.dropped.length - 25} more`);
  } else {
    console.log(`  classify: ${kept.length} in -> ${classified.kept.length} kept, 0 dropped`);
  }

  // ISC-146/148/149 — content-type classifier. Assigns each kept item one of
  // 8 types (news / enterprise-news / feature / tutorial / trending-repo /
  // research / influencer-content / community) using a platform-prior baseline
  // + LLM verdict + anchor validation. Below-confidence verdicts route to the
  // platform prior (ISC-148); platform-mismatched verdicts are flagged (149).
  // Never drops — typing is metadata. Mode-aware short-circuit identical to
  // classify.ts so fixture/replay stay deterministic (ISC-56/61).
  await classifyTypes(classified.kept);
  const byType = classified.kept.reduce<Record<string, number>>((a, it) => {
    const t = (it.meta?.type as { value?: string } | undefined)?.value ?? 'uncategorized';
    a[t] = (a[t] ?? 0) + 1;
    return a;
  }, {});
  console.log(
    `  type-classify: ${classified.kept.length} typed (` +
      Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(', ') + ')',
  );

  // ISC-125/126/127 — reception classifier (Session 18). Reads the HN comment
  // corpus captured by ISC-155 and emits a per-item reception verdict
  // {sentiment, ratioed, endorsed, anchor} stashed on meta.reception.
  // Anti-trending: a validated meta.reception.ratioed === true downranks the
  // cluster in scoring (downstream consumers honor it; absent meta.reception
  // is treated as no-signal, never as neutral). Mode-aware short-circuit
  // matches classify.ts: fixture/replay leave meta.reception ABSENT (the
  // honest no-signal marker) rather than fabricate a neutral verdict.
  const reception = await classifyReception(classified.kept);
  console.log(
    `  reception: ${reception.classified} classified, ${reception.noComments} no-comments, ` +
      `${reception.failed} failed, ${reception.ratioed} ratioed, ${reception.endorsed} endorsed`,
  );

  // ISC-153 — persist the typed snapshot for the benchmark check (scripts/
  // check-benchmark.ts). Distinct from data/all.json (raw harvest, written
  // earlier above) — typed.json contains items AFTER filter + classify +
  // classify-type, with meta.type stashed per item. Live mode only — fixture
  // and replay are themselves deterministic re-renders that don't need a
  // fresh snapshot. data/typed.json is gitignored alongside data/all.json.
  if (harvestMode() === 'live') {
    await writeFile(
      resolve(ROOT, 'data', 'typed.json'),
      stableStringify({ generated_at: new Date().toISOString(), items: classified.kept }),
    );
  }

  const { clusters: clustersRaw, in_count, out_count } = dedupeAndCluster(classified.kept);
  console.log(`  dedupe: ${in_count} in -> ${out_count} out, ${clustersRaw.length} clusters`);

  const scored = scoreClusters(clustersRaw);
  console.log(`  scored: ${scored.length} clusters`);

  const { clusters: verified, pass_rate } = await verifyAndPrune(scored);
  const passRateLabel = pass_rate === null ? 'skipped (fixture mode)' : `${(pass_rate * 100).toFixed(1)}% pass rate`;
  console.log(`  verify: ${passRateLabel}, ${verified.length} clusters survive`);

  const tagged = tagConfidence(verified);

  const viral = topViral(tagged, 5);
  const viralIds = new Set(viral.map((c) => c.id));
  const preViral = topPreViral(tagged, 5, viralIds);

  console.log(`  lens: all-${tagged.length} | viral-${viral.length} | pre-viral-${preViral.length}`);

  const stats: RunStats = {
    generated_at: new Date().toISOString(),
    source_counts: harvest.bySource as Record<Source, number>,
    dedupe_in: in_count,
    dedupe_out: out_count,
    verification_pass_rate: pass_rate,
  };

  await render({ viral, preViral, all: tagged }, stats, OUT);
  console.log(`  render: ${OUT}`);
  console.log('TrendingAI :: pipeline complete');
}

main().catch((e) => {
  console.error('pipeline failed:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
