import type { Cluster, VerifyResult } from './types.ts';
import { harvestMode } from './harvesters/_fixtures.ts';

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 8;

async function probe(url: string): Promise<VerifyResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ctl.signal, redirect: 'follow' });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, { method: 'GET', signal: ctl.signal, redirect: 'follow' });
    }
    return { url, ok: res.ok || (res.status >= 200 && res.status < 400), status: res.status };
  } catch {
    return { url, ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function verifyAndPrune(
  clusters: Cluster[],
): Promise<{ clusters: Cluster[]; pass_rate: number | null }> {
  // Fixture mode (ISC-56 / ISC-61): fixtures are curated, committed replay
  // inputs. Probing their URLs would leak network egress into a "no network"
  // run AND make the surviving-cluster set depend on live network state —
  // breaking byte-identical replay. So no probe — but pass_rate is `null`, not
  // a fabricated `1.0`: nothing was verified, the report must say so honestly.
  if (harvestMode() !== 'live') {
    return { clusters, pass_rate: null };
  }

  const urls = new Set<string>();
  for (const c of clusters) for (const it of c.items) urls.add(it.url);
  const results = await runWithConcurrency(Array.from(urls), CONCURRENCY, probe);
  const okSet = new Set(results.filter((r) => r.ok).map((r) => r.url));
  const total = results.length;
  const passed = okSet.size;

  const pruned: Cluster[] = [];
  for (const c of clusters) {
    const keep = c.items.filter((it) => okSet.has(it.url));
    if (keep.length === 0) continue;
    pruned.push({ ...c, items: keep });
  }
  return { clusters: pruned, pass_rate: total > 0 ? passed / total : 0 };
}
