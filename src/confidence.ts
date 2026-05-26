import type { Cluster, Source } from './types.ts';

/**
 * ISC-104 — the HIGH-confidence badge is SUPPRESSED until cross-source merges
 * are verified genuine. The iteration-9 audit found token-overlap clustering
 * produces false cross-source merges (unrelated items sharing a token) that
 * were then stamped HIGH — certifying token collisions as corroboration. Until
 * the correlation reasoning step (ISC-117/119) verifies that a multi-source
 * cluster is genuinely the same story, "≥2 sources" is not trustworthy
 * evidence of corroboration, so it caps at MED. HIGH returns when a
 * reasoning-confirmed, anchor-cited link can back it.
 */
export function tagConfidence(clusters: Cluster[]): Cluster[] {
  for (const c of clusters) {
    const sources = new Set<Source>(c.items.map((i) => i.source));
    if (sources.size >= 2 || c.items.length >= 3) {
      c.confidence = 'MED';
    } else {
      c.confidence = 'LOW';
    }
  }
  return clusters;
}
