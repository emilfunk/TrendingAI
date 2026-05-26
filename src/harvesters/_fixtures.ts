import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem, Source } from '../types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(__dirname, '..', '..', 'fixtures');

/**
 * Schema boundary — the fixture half of the v2 determinism contract.
 *
 * `data/raw/` snapshots (gitignored, archival) and `fixtures/` (small, curated,
 * committed) are two DISTINCT artifacts. Raw snapshots prove what the network
 * returned at capture time; fixtures are the curated, in-git replay inputs that
 * make the pipeline reproducible with ZERO network egress:
 *
 *   HARVEST_MODE=live          (default) — hit the network, capture raw snapshots
 *   HARVEST_MODE=fixture       — replay fixtures/{source}.json (happy path)
 *   HARVEST_MODE=fixture-edge  — replay fixtures/edge/{source}.json (degenerate shapes)
 *   HARVEST_MODE=replay        — re-render from data/all.json (the last live
 *                                harvest) — iterate on dedupe/score/filter/
 *                                render with zero network egress and zero spend
 *
 * Both fixture modes are pure: given the same committed fixtures, the pipeline
 * produces the same clusters every run. Replay mode is pure for a fixed
 * data/all.json.
 */
export type HarvestMode = 'live' | 'fixture' | 'fixture-edge' | 'replay';

export function harvestMode(): HarvestMode {
  const m = (process.env.HARVEST_MODE ?? 'live').trim().toLowerCase();
  if (m === 'fixture') return 'fixture';
  if (m === 'fixture-edge' || m === 'edge') return 'fixture-edge';
  if (m === 'replay') return 'replay';
  return 'live';
}

/**
 * Loads a committed fixture for a source. Returns [] for live mode or when a
 * fixture file is absent — the orchestrator treats a missing fixture the same
 * way it treats a harvester that returned nothing: a logged gap, not a crash.
 */
export async function loadFixture(source: Source, mode: HarvestMode): Promise<NormalizedItem[]> {
  if (mode === 'live') return [];
  const path =
    mode === 'fixture-edge'
      ? resolve(FIXTURE_ROOT, 'edge', `${source}.json`)
      : resolve(FIXTURE_ROOT, `${source}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Claim boundary (ISC-58) in replay: captured_at is read from the fixture
    // file *body* — content-sourced, baked in by make-fixtures.ts from the live
    // harvest stamp. It is deliberately NOT backfilled from file mtime: git does
    // not preserve mtime, so a fresh clone or a make-fixtures rerun would
    // fabricate capture times. Fixtures that predate the field carry no
    // captured_at and render 'unknown' — honest, not a guessed checkout artifact.
    return parsed as NormalizedItem[];
  } catch {
    return [];
  }
}
