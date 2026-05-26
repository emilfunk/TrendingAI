import type { Cluster, NormalizedItem, Source } from './types.ts';

const WINDOW_HOURS = 24 * 7;

const LEADING_SOURCES: Source[] = ['arxiv', 'frontier'];

const SOURCE_WEIGHT: Record<Source, number> = {
  arxiv: 1.1,
  frontier: 1.2,
  github: 1.0,
  hn: 1.0,
  x: 1.0,
  youtube: 1.0,
  reddit: 1.0,
  bluesky: 1.0,
  // Session 19.5 — short-form social weights at 1.0 (same as X/YouTube). The
  // "What's Viral" lens surfaces these regardless of weight; per-source ranking
  // already scopes their contribution.
  tiktok: 1.0,
  instagram: 1.0,
  // Iteration 20 scaffolding — editorial AI-news as a curated-secondary signal:
  // weight 1.05 (slightly above community but below frontier-lab first-party
  // announcements). Enterprise news as a traditional-publisher signal: weight
  // 1.0 (parity with community sources — credible but not authoritative on AI
  // technical claims).
  editorial: 1.05,
  enterprise: 1.0,
};

// ISC-158/159 (Session 19) — reception integration.
// `meta.reception` is written by classify-reception.ts. Only `anchorValid===true`
// verdicts get honored — the fail-open guard in resolveReception downgrades
// un-checkable verdicts on write; this re-asserts the guard on read so a future
// schema drift never silently regresses. Ratioed wins over endorsed within a
// single cluster: hostile evidence trumps mixed-positive (ISC-127 anti-trending).
export const RATIOED_PENALTY = 0.6;
export const ENDORSED_BONUS = 1.15;
const SCORE_CEILING = 1.0;

type ReceptionMeta = {
  sentiment?: string;
  ratioed?: boolean;
  endorsed?: boolean;
  anchor?: string;
  anchorValid?: boolean;
  reason?: string;
};

function clusterReceptionMultiplier(c: Cluster): number {
  let hasValidatedRatioed = false;
  let hasValidatedEndorsed = false;
  for (const it of c.items) {
    const r = it.meta?.reception as ReceptionMeta | undefined;
    if (!r || r.anchorValid !== true) continue;
    if (r.ratioed === true) hasValidatedRatioed = true;
    else if (r.endorsed === true) hasValidatedEndorsed = true;
  }
  if (hasValidatedRatioed) return RATIOED_PENALTY;
  if (hasValidatedEndorsed) return ENDORSED_BONUS;
  return 1.0;
}

function ageHours(ts: string): number {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return WINDOW_HOURS;
  return Math.max(1, (Date.now() - t) / 3_600_000);
}

function normalizeWithinSource(items: NormalizedItem[]): Map<NormalizedItem, number> {
  const bySource = new Map<Source, NormalizedItem[]>();
  for (const it of items) {
    const arr = bySource.get(it.source) ?? [];
    arr.push(it);
    bySource.set(it.source, arr);
  }
  const out = new Map<NormalizedItem, number>();
  for (const [, arr] of bySource) {
    const engagements = arr.map((x) => x.engagement);
    const max = Math.max(...engagements);
    for (const it of arr) {
      let normalized: number;
      if (max <= 0) {
        normalized = 0.5;
      } else if (it.engagement <= 0) {
        normalized = 0.3;
      } else {
        normalized = it.engagement / max;
      }
      out.set(it, normalized);
    }
  }
  return out;
}

function distinctSourcesUniverse(items: NormalizedItem[]): number {
  const present = new Set<Source>();
  for (const it of items) present.add(it.source);
  return Math.max(2, present.size);
}

export function scoreClusters(clusters: Cluster[]): Cluster[] {
  const allItems = clusters.flatMap((c) => c.items);
  const normEng = normalizeWithinSource(allItems);
  const sourceUniverseSize = distinctSourcesUniverse(allItems);

  for (const c of clusters) {
    const sources = new Set<Source>();
    let engSum = 0;
    let recencySum = 0;
    let leadingCount = 0;
    for (const it of c.items) {
      sources.add(it.source);
      const rawNorm = normEng.get(it) ?? 0;
      const weighted = rawNorm * (SOURCE_WEIGHT[it.source] ?? 1.0);
      engSum += weighted;
      recencySum += 1 / ageHours(it.ts);
      if (LEADING_SOURCES.includes(it.source)) leadingCount++;
    }
    const n = c.items.length;
    c.velocity = Math.min(1, (recencySum / n) * WINDOW_HOURS / 4);
    c.cross_source = Math.min(1, sources.size / sourceUniverseSize);
    c.engagement_mean = n > 0 ? Math.min(1, engSum / n) : 0;
    c.leading_source_share = n > 0 ? leadingCount / n : 0;

    const baseScore = 0.4 * c.velocity + 0.4 * c.cross_source + 0.2 * c.engagement_mean;
    c.score = Math.min(SCORE_CEILING, baseScore * clusterReceptionMultiplier(c));

    c.viral_score = c.engagement_mean * c.velocity * Math.min(1, c.cross_source * 1.5);

    const tractionFloor = Math.min(1, c.engagement_mean + 0.15);
    const underratedness = 1 - c.engagement_mean;
    c.pre_viral_score = c.leading_source_share * c.velocity * underratedness * tractionFloor;
  }

  clusters.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const va = tsVariance(a.items);
    const vb = tsVariance(b.items);
    return va - vb;
  });

  return clusters;
}

function tsVariance(items: NormalizedItem[]): number {
  if (items.length < 2) return 0;
  const xs = items.map((i) => Date.parse(i.ts)).filter((n) => !Number.isNaN(n));
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}

export function diversityFilter(clusters: Cluster[]): Cluster[] {
  const seenArxivPrefix = new Set<string>();
  const seenGithubOwner = new Set<string>();
  const out: Cluster[] = [];
  for (const c of clusters) {
    const arxivIds = c.items
      .filter((i) => i.source === 'arxiv')
      .map((i) => (i.meta?.id as string | undefined) ?? '')
      .map((id) => id.replace(/v\d+$/, '').slice(-12));
    const prefix = arxivIds[0] ?? '';
    if (prefix && seenArxivPrefix.has(prefix)) continue;
    if (prefix) seenArxivPrefix.add(prefix);

    const ghOwners = c.items
      .filter((i) => i.source === 'github')
      // ISC-120 — GitHub item titles are now descriptions, not `owner/repo`
      // slugs; the slug lives in meta.repo. Owner-diversity dedup keys off
      // meta.repo so it keeps working after the title change.
      .map((i) => String((i.meta?.repo as string | undefined) ?? i.title).split('/')[0] ?? '');
    const owner = ghOwners[0] ?? '';
    if (c.items.length === 1 && owner && seenGithubOwner.has(owner)) continue;
    if (owner) seenGithubOwner.add(owner);

    out.push(c);
  }
  return out;
}

export function topN(clusters: Cluster[], n = 10): Cluster[] {
  return diversityFilter(clusters).slice(0, n);
}

export function topViral(clusters: Cluster[], n = 5): Cluster[] {
  return [...clusters].sort((a, b) => b.viral_score - a.viral_score).slice(0, n);
}

export function topPreViral(clusters: Cluster[], n = 5, exclude: Set<string> = new Set()): Cluster[] {
  return [...clusters]
    .filter((c) => !exclude.has(c.id))
    .filter((c) => c.pre_viral_score > 0)
    .sort((a, b) => b.pre_viral_score - a.pre_viral_score)
    .slice(0, n);
}
