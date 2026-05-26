import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelCadence } from './types.ts';

export type { ChannelCadence };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MS_PER_HOUR = 60 * 60 * 1000;
const WINDOW_30D_MS = 30 * 24 * MS_PER_HOUR;

function extractPublished(xml: string): string[] {
  const re = /<published>([^<]+)<\/published>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

function channelFromFilename(name: string): string {
  const tail = name.replace(/\.xml$/, '');
  const underscoreIdx = tail.indexOf('__');
  return underscoreIdx >= 0 ? tail.slice(underscoreIdx + 2) : tail;
}

export function cadenceFromTimestamps(channelId: string, isoStamps: string[], now: Date = new Date()): ChannelCadence {
  const unique = Array.from(new Set(isoStamps));
  const parsed = unique
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (parsed.length === 0) {
    return { channelId, items_30d: 0, avg_gap_hours: null, last_item_iso: null };
  }
  const last = parsed[0]!;
  const windowStart = now.getTime() - WINDOW_30D_MS;
  const inWindow = parsed.filter((t) => t >= windowStart);
  let avgGapHours: number | null = null;
  if (inWindow.length >= 2) {
    const gaps: number[] = [];
    for (let i = 0; i < inWindow.length - 1; i++) {
      gaps.push(inWindow[i]! - inWindow[i + 1]!);
    }
    const meanMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    avgGapHours = Math.round((meanMs / MS_PER_HOUR) * 10) / 10;
  }
  return {
    channelId,
    items_30d: inWindow.length,
    avg_gap_hours: avgGapHours,
    last_item_iso: new Date(last).toISOString(),
  };
}

export async function computeCadence(rawDir: string = join(ROOT, 'data', 'raw', 'youtube'), now: Date = new Date()): Promise<ChannelCadence[]> {
  let files: string[];
  try {
    files = (await readdir(rawDir)).filter((f) => f.endsWith('.xml'));
  } catch {
    return [];
  }
  const perChannel = new Map<string, string[]>();
  for (const f of files) {
    const channelId = channelFromFilename(f);
    const xml = await readFile(join(rawDir, f), 'utf8');
    const stamps = extractPublished(xml);
    const existing = perChannel.get(channelId) ?? [];
    perChannel.set(channelId, existing.concat(stamps));
  }
  const out: ChannelCadence[] = [];
  for (const [channelId, stamps] of perChannel) {
    out.push(cadenceFromTimestamps(channelId, stamps, now));
  }
  out.sort((a, b) => b.items_30d - a.items_30d);
  return out;
}
