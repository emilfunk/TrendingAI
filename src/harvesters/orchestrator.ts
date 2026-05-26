import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestHN, drainHNCommentErrors } from './hn.ts';
import { harvestArxiv } from './arxiv.ts';
import { harvestGitHub } from './github.ts';
import { harvestX } from './x.ts';
import { harvestFrontier } from './frontier.ts';
import { harvestYouTube } from './youtube.ts';
import { harvestReddit } from './reddit.ts';
import { harvestBluesky } from './bluesky.ts';
// iter-46 F4 — orchestrator imports the FULL pipeline wrappers so whitelist +
// transcript-extraction (gated by HARVEST_PAID + EXTRACT_TT/IG_TRANSCRIPTS env
// vars) fires under `bun run harvest:all`. Previously imported `harvestTikTok`
// / `harvestInstagram` which are only the hashtag pass.
import { harvestTikTokFull } from './tiktok.ts';
import { harvestInstagramFull } from './instagram.ts';
import { harvestEditorial } from './editorial.ts';
import { harvestEnterprise } from './enterprise.ts';
import { harvestMode, loadFixture } from './_fixtures.ts';
import { paidSourcesEnabled } from '../sources.ts';
import { stableStringify } from '../stable-json.ts';
import type { NormalizedItem, Source } from '../types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * ISC-154 — explicit, documented harvest sequence. Kem's call (iteration 15):
 * "we need to sequence where we're looking: news and then …" — coverage order
 * is a deliberate written choice, not incidental to Promise.all ordering. The
 * array order IS the sequence; Promise.all still fires concurrently for speed,
 * but the order is the answer to "where are we looking first?" and is logged
 * on every run.
 *
 * The order:
 *   1. frontier  — primary AI news (lab announcements)
 *   2. x         — news + community from builders (paid, opt-in)
 *   3. arxiv     — authoritative research
 *   4. hn        — community + news amplifier
 *   5. reddit    — community signal
 *   6. github    — code / trending repos
 *   7. youtube   — tutorial + influencer-content
 *   8. bluesky   — federated AI-research-crowd
 *   9. tiktok    — short-form AI demos / reactions (paid, opt-in — Session 19.5)
 *  10. instagram — short-form AI reels / posts (paid, opt-in — Session 19.5)
 *
 * FIXTURE_SOURCES mirrors HARVEST_SEQUENCE so fixture-mode runs are
 * deterministic and reflect the same "where we're looking" order live runs do.
 */
// Iteration 20 scaffolding — editorial + enterprise slotted between frontier-lab
// announcements and authoritative-research (arxiv) so the "news" half of the
// sequence is contiguous: frontier (first-party announcements) → editorial
// (aggregator news) → enterprise (publisher news) → arxiv (research) → community.
export const HARVEST_SEQUENCE: Source[] = ['frontier', 'editorial', 'enterprise', 'x', 'arxiv', 'hn', 'reddit', 'github', 'youtube', 'bluesky', 'tiktok', 'instagram'];
const FIXTURE_SOURCES: Source[] = HARVEST_SEQUENCE;

/**
 * ISC-173 / ISC-174 (Session 19.5) — paid-source regression guard.
 *
 * Paid sources (`costsMoney: true` in SOURCE_REGISTRY) are auto-included in
 * `harvest:all` ONLY when the token is present AND `HARVEST_PAID=1` is
 * explicitly set. Token presence alone is *capability*, not *spend
 * authorization* — conflating them turned a routine fixture-regen into an
 * ungated ~$0.20 Apify charge in iteration 7. Session 19.5 reused this gate
 * for tiktok + instagram instead of inventing a parallel one; the set lives at
 * module scope (was previously inside `harvestAll`) so an `orchestrator.test.ts`
 * can assert it directly — a failing-on-removal regression test is what makes
 * the "regression-prevent" claim hold up at audit (advisor, 2026-05-15 S19.5).
 *
 * `computeActiveSequence` is a pure helper that takes the gate inputs
 * explicitly so the test matrix covers {hasToken yes/no} × {paidEnabled yes/no}
 * without env mutation.
 */
export const PAID_SOURCES: ReadonlySet<Source> = new Set<Source>(['x', 'tiktok', 'instagram']);

export function computeActiveSequence(opts: { hasToken: boolean; paidEnabled: boolean }): Source[] {
  const includePaid = opts.hasToken && opts.paidEnabled;
  return HARVEST_SEQUENCE.filter((s) => !PAID_SOURCES.has(s) || includePaid);
}

async function runOne<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ name: string; ok: true; value: T } | { name: string; ok: false; error: string }> {
  try {
    const value = await fn();
    return { name, ok: true, value };
  } catch (e) {
    return { name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function harvestAll(): Promise<{
  items: NormalizedItem[];
  bySource: Record<string, number>;
  errors: string[];
}> {
  const mode = harvestMode();

  // Replay mode: re-render from the last live harvest (data/all.json) with zero
  // network egress and zero spend. Distinct from fixture mode — fixtures are the
  // small committed schema-boundary artifacts; data/all.json is the FULL last
  // live harvest. Used to iterate on dedupe/score/filter/render without
  // re-paying for a paid source (X). coverageForRun() correctly reports these
  // as "replay" — this process did not pull them live, even though the
  // underlying snapshot in data/all.json was captured live.
  if (mode === 'replay') {
    const allPath = resolve(ROOT, 'data', 'all.json');
    try {
      const parsed = JSON.parse(await readFile(allPath, 'utf8')) as {
        items?: NormalizedItem[];
        bySource?: Record<string, number>;
      };
      const items = parsed.items ?? [];
      return {
        items,
        bySource: parsed.bySource ?? {},
        errors: [
          `harvest mode: replay — ${items.length} items re-rendered from data/all.json, no network egress`,
        ],
      };
    } catch (e) {
      return {
        items: [],
        bySource: {},
        errors: [
          `replay mode: could not read data/all.json (${e instanceof Error ? e.message : String(e)}) — run a live \`bun run report\` first`,
        ],
      };
    }
  }

  // Fixture mode: no network egress. Replay committed snapshots through the
  // exact same downstream pipeline (dedupe -> score -> verify -> render).
  if (mode !== 'live') {
    const items: NormalizedItem[] = [];
    const bySource: Record<string, number> = {};
    const errors: string[] = [`harvest mode: ${mode} — fixtures only, no network egress`];
    for (const s of FIXTURE_SOURCES) {
      const fx = await loadFixture(s, mode);
      items.push(...fx);
      bySource[s] = fx.length;
      if (fx.length === 0) errors.push(`${s}: no ${mode} fixture found (skipped)`);
    }
    return { items, bySource, errors };
  }

  const hasApifyToken = Boolean(process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN);
  const paidEnabled = paidSourcesEnabled();
  const includePaid = hasApifyToken && paidEnabled;

  // Sequence emitted on every run — makes the documented order visible at
  // runtime, not just in the source comment. ISC-154. Gate behavior is owned
  // by the pure `computeActiveSequence` helper (ISC-173/174 regression-guard).
  const activeSequence = computeActiveSequence({ hasToken: hasApifyToken, paidEnabled });
  console.error(`harvest sequence: ${activeSequence.join(' -> ')}`);

  const HARVESTERS: Record<Source, () => Promise<NormalizedItem[]>> = {
    frontier: harvestFrontier,
    x: harvestX,
    arxiv: harvestArxiv,
    hn: harvestHN,
    reddit: harvestReddit,
    github: harvestGitHub,
    youtube: harvestYouTube,
    bluesky: harvestBluesky,
    tiktok: harvestTikTokFull,
    instagram: harvestInstagramFull,
    editorial: harvestEditorial,
    enterprise: harvestEnterprise,
  };
  const tasks = activeSequence.map((s) => runOne(s, HARVESTERS[s]));

  const results = await Promise.all(tasks);
  const items: NormalizedItem[] = [];
  const bySource: Record<string, number> = {};
  const errors: string[] = [];
  for (const r of results) {
    if (r.ok) {
      // Claim boundary (ISC-58): stamp the capture timestamp per source. All
      // sources harvest concurrently, so a per-source run-time stamp is the
      // honest, hand-checkable answer to "when was this captured?".
      const capturedAt = new Date().toISOString();
      for (const it of r.value) it.captured_at ??= capturedAt;
      items.push(...r.value);
      bySource[r.name] = r.value.length;
    } else {
      errors.push(`${r.name}: ${r.error}`);
      bySource[r.name] = 0;
    }
  }
  if (!hasApifyToken) {
    errors.push('x: skipped — no APIFY_TOKEN in env');
    errors.push('tiktok: skipped — no APIFY_TOKEN in env');
    errors.push('instagram: skipped — no APIFY_TOKEN in env');
  } else if (!includePaid) {
    errors.push('x: skipped — paid source; set HARVEST_PAID=1 to include X in harvest:all');
    errors.push('tiktok: skipped — paid source; set HARVEST_PAID=1 to include TikTok in harvest:all');
    errors.push('instagram: skipped — paid source; set HARVEST_PAID=1 to include Instagram in harvest:all');
  }
  // ISC-155 anti-criterion: hn comment-fetch failures land on the harvest
  // result's top-level errors[], not silently in per-item meta. The harvester
  // populates them via a module-scoped buffer; drain after the dispatch.
  errors.push(...drainHNCommentErrors());
  await checkSourceDeath(bySource, errors);
  return { items, bySource, errors };
}

/**
 * ISC-111 — silent source-death alarm. A source that returned N>0 items in a
 * prior live run and returns 0 now is a likely silent breakage (feed moved,
 * auth expired, path changed, gzip) — not genuine "no news". Compared against a
 * persisted baseline; the alarm goes into `errors` so it surfaces in the run
 * log. Best-effort: a missing/corrupt baseline just means "first run", and a
 * baseline-write failure must never fail the harvest. Live path only — fixture
 * counts are snapshot-fixed and would false-alarm.
 */
export async function checkSourceDeath(
  bySource: Record<string, number>,
  errors: string[],
  baselinePath: string = resolve(ROOT, 'data', '.source-baseline.json'),
): Promise<void> {
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, number>;
  } catch {
    /* first run / no baseline yet */
  }
  for (const [src, prev] of Object.entries(baseline)) {
    if (prev > 0 && (bySource[src] ?? 0) === 0) {
      errors.push(
        `ALARM ${src}: returned ${prev} items last live run, 0 now — likely silent source death (feed moved / auth expired / path changed)`,
      );
    }
  }
  try {
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, stableStringify({ ...baseline, ...bySource }));
  } catch {
    /* best-effort — a baseline write failure must not fail the harvest */
  }
}

async function main(): Promise<void> {
  const { items, bySource, errors } = await harvestAll();
  if (items.length === 0) {
    console.error('All harvesters returned zero items.');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }

  // iter-46 F3 — partition by source and write per-source files (data/x.json,
  // data/tiktok.json, …) so downstream `bun run features:first` and the
  // bundle's Run.md Stage 2 verify probe see the per-source files where they
  // expect them. Pre-iter-46 the orchestrator wrote ONLY data/all.json (a
  // combined blob) and per-source files arrived via runtime-patching by the
  // inner Opus session — every fresh run required that workaround. With this
  // change `bun run harvest:all` produces per-source files directly. The
  // combined all.json is dropped (downstream code reads per-source).
  const dataDir = resolve(ROOT, 'data');
  await mkdir(dataDir, { recursive: true });
  const itemsBySource: Record<string, NormalizedItem[]> = {};
  for (const it of items) {
    const src = it.source;
    if (!src) continue;
    (itemsBySource[src] ??= []).push(it);
  }
  const writtenFiles: string[] = [];
  for (const [src, srcItems] of Object.entries(itemsBySource)) {
    const outPath = resolve(dataDir, `${src}.json`);
    await writeFile(outPath, JSON.stringify(srcItems, null, 2));
    writtenFiles.push(`${src}:${srcItems.length}`);
  }
  console.log(
    `harvest:all — ${items.length} items across ${writtenFiles.length} per-source files (` +
      writtenFiles.join(', ') +
      `) → ${dataDir}/`,
  );
  if (errors.length > 0) {
    for (const e of errors) console.error('  WARN ' + e);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('harvest:all failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
