import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots');

function dateKey(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, (v as Record<string, unknown>)[k]]),
      );
    }
    return v;
  }, 2);
}

export async function writeSnapshot(items: NormalizedItem[], at: Date = new Date()): Promise<string> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const path = join(SNAPSHOTS_DIR, `${dateKey(at)}.json`);
  const payload = {
    generated_at: at.toISOString(),
    item_count: items.length,
    items,
  };
  await writeFile(path, stableStringify(payload), 'utf8');
  return path;
}

async function main(): Promise<void> {
  const allPath = join(ROOT, 'data', 'all.json');
  let items: NormalizedItem[] = [];
  try {
    const raw = await readFile(allPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      items = parsed as NormalizedItem[];
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
      items = (parsed as { items: NormalizedItem[] }).items;
    } else {
      console.error(`  WARN snapshot: data/all.json has unexpected shape — wrote empty snapshot.`);
    }
  } catch {
    console.error(`  WARN snapshot: data/all.json missing — run \`bun run report\` first. Writing empty snapshot.`);
  }
  const at = new Date();
  const path = await writeSnapshot(items, at);
  console.log(`snapshot written: ${path} (${items.length} items, ${at.toISOString()})`);
}

if (import.meta.main) {
  await main();
}
