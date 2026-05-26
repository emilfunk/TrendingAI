import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = resolve(__dirname, '..', '..', 'data', 'raw');

/**
 * Capture boundary — the foundational primitive of the v2 determinism contract.
 *
 * Snapshots a harvester's RAW upstream response to disk before any normalization
 * happens. The live network fetch is non-deterministic for every source — that is
 * physics, not a defect. Everything below this captured snapshot is pure and
 * reproducible; the snapshot is what makes the rest of the pipeline replayable.
 *
 * Best-effort by design: a snapshot-write failure must NEVER crash a harvest —
 * it logs a warning and returns. `label` disambiguates multi-call harvesters
 * (x.ts, frontier.ts) — pass the feed name or query name.
 *
 * Raw snapshots under data/raw/ are gitignored archival artifacts, distinct from
 * the small curated fixtures under fixtures/ (see ISA ISC-57).
 */
export async function captureRaw(source: string, label: string, body: string): Promise<void> {
  try {
    const ext = body.trimStart().startsWith('<') ? 'xml' : 'json';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'response';
    const dir = resolve(RAW_ROOT, source);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `${ts}__${safeLabel}.${ext}`), body);
  } catch (e) {
    console.error(`  WARN capture: ${source}/${label} snapshot failed — ${e instanceof Error ? e.message : e}`);
  }
}
