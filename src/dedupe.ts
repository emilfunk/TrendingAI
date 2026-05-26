import type { NormalizedItem, Cluster } from './types.ts';

const STOPWORDS = new Set([
  'a','an','the','and','or','of','for','to','in','on','with','by','from','as','at','is','are','be',
  'this','that','it','we','our','their','your','my','i','you','he','she','they','them','his','her',
  'using','use','via','can','will','do','does','not','no','if','but','about','vs','via','into','onto',
  'paper','model','models','llm','llms','ai','agents','agent','toward','towards','new','approach','study','learning',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// canonUrl is the project's single canonical URL identity. Exported so callers
// outside dedupe — notably src/reason-cluster.ts citation anchor-validation —
// can match the EXACT same string the dedupe pipeline emitted, instead of
// mirroring the implementation (mirror drift is silent: citations would quietly
// stop matching on the first dedupe change). Per iter-24 Advisor (ISC-299).
export function canonUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    let p = url.pathname.replace(/\/$/, '');
    return (url.host + p).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function dedupeAndCluster(items: NormalizedItem[]): { clusters: Cluster[]; in_count: number; out_count: number } {
  const inCount = items.length;
  const byUrl = new Map<string, NormalizedItem>();
  for (const it of items) {
    if (!it.url) continue;
    const key = canonUrl(it.url);
    const existing = byUrl.get(key);
    if (!existing || it.engagement > existing.engagement) byUrl.set(key, it);
  }
  const deduped = Array.from(byUrl.values());

  // Cluster by overlap-count on the PROTOTYPE (first item's tokens), not aggregated tokens.
  // Two items share a cluster if they share ≥2 significant tokens, OR ≥1 significant bigram.
  type Bucket = { prototype: Set<string>; bigrams: Set<string>; items: NormalizedItem[]; };
  const buckets: Bucket[] = [];

  function bigramsOf(tokens: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (!a || !b) continue;
      out.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
    return out;
  }
  function sharedCount<T>(a: Set<T>, b: Set<T>): number {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
  }

  for (const it of deduped) {
    // ISC-238 — when a transcript-bearing youtube item enters the cluster step,
    // augment the tokenization input with the first 800 chars of its transcript.
    // raw_text already includes that prefix per src/harvesters/youtube.ts; we
    // pull it in here so cross-platform clusters can match on transcript-only
    // keywords (a YouTube video transcript mentioning "Claude Sonnet 4.6
    // vision" clusters with an arXiv paper or X post on the same), not just
    // title-only.
    const transcriptStatus = (it.meta as { transcript_status?: string } | undefined)?.transcript_status;
    const tokSource = transcriptStatus === 'present' ? `${it.title} ${it.raw_text.slice(0, 800)}` : it.title;
    const toks = tokenize(tokSource);
    const tokSet = new Set(toks);
    const bigSet = bigramsOf(toks);
    if (tokSet.size === 0) {
      buckets.push({ prototype: tokSet, bigrams: bigSet, items: [it] });
      continue;
    }
    let best: { idx: number; score: number } = { idx: -1, score: 0 };
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (!bucket) continue;
      const bigramOverlap = sharedCount(bigSet, bucket.bigrams);
      const tokenOverlap = sharedCount(tokSet, bucket.prototype);
      const score = bigramOverlap * 2 + tokenOverlap;
      if (score > best.score) best = { idx: i, score };
    }
    if (best.idx >= 0 && best.score >= 2) {
      const bucket = buckets[best.idx];
      if (bucket) {
        bucket.items.push(it);
        for (const bg of bigSet) bucket.bigrams.add(bg);
      }
    } else {
      buckets.push({ prototype: tokSet, bigrams: bigSet, items: [it] });
    }
  }

  const clusters: Cluster[] = buckets
    .filter((b) => b.items.length >= 1)
    .map((b, i) => {
      // ISC-116 — entity-anchored label. Token-overlap still drives *grouping*
      // (the bucket loop above); it no longer drives the *label*. A cluster's
      // label is a REAL item title — its highest-engagement member's, with the
      // `[source]` prefix stripped — never a token-fragment join like
      // "openai chatgpt how". The representative is picked deterministically:
      // highest engagement, ties broken by earliest ts then title, so identical
      // input always yields the same label (ISC-61 determinism).
      // Sort cluster items rep-first (highest engagement; ties → earliest ts,
      // then title). render.ts reads c.items[0] for the summary, sparkline and
      // single-item label — making the rep items[0] keeps the label, summary
      // and timing line all describing the SAME item, not three different ones.
      const sortedItems = [...b.items].sort(
        (x, y) =>
          y.engagement - x.engagement ||
          Date.parse(x.ts) - Date.parse(y.ts) ||
          x.title.localeCompare(y.title),
      );
      const rep = sortedItems[0];
      const label =
        (rep?.title ?? `cluster-${i}`).replace(/^\[[^\]]+\]\s*/, '').trim() ||
        rep?.title ||
        `cluster-${i}`;
      return {
        id: `c${i}`,
        label,
        items: sortedItems,
        velocity: 0,
        cross_source: 0,
        engagement_mean: 0,
        leading_source_share: 0,
        score: 0,
        viral_score: 0,
        pre_viral_score: 0,
        confidence: 'LOW' as const,
      };
    });

  return { clusters, in_count: inCount, out_count: deduped.length };
}
