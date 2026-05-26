import type { Source } from './types.ts';
import { harvestMode } from './harvesters/_fixtures.ts';

/**
 * Source registry — the single source of truth for per-source metadata.
 *
 * ISC-69 — the "covered live ≠ covered by replay" boundary. A source's auth
 * class and intrinsic live-capability are static facts and live here; whether
 * a given *run* covered a source live or by replay is a runtime fact computed
 * by `coverageForRun`. A frozen-snapshot replay is never silently promoted to
 * an "autonomous live source" — the registry forces that distinction to be
 * named in the rendered output.
 *
 * It also consolidates the label + accent maps render.ts previously kept as
 * standalone literals, so source metadata has one home, not three.
 */

/**
 * Auth tiering from the v2 contract. Class-1 sources reach their data over
 * zero/low-auth public endpoints; Class-2 sources are adversarial to scrape
 * and need a credentialed, paid provider path (Apify).
 */
export type AuthClass = 'class-1' | 'class-2';

/**
 * How the *current run* covered a source — the ISC-69 distinction made explicit:
 *   live   — this run pulled the source autonomously over the network
 *   replay — this run sourced it from a committed fixture snapshot only
 *   absent — the source contributed nothing this run (no token / no fixture / error)
 */
export type CoverageMode = 'live' | 'replay' | 'absent';

export type SourceMeta = {
  source: Source;
  label: string;
  accent: string;
  authClass: AuthClass;
  /** Acquisition method — how this source's data is actually fetched (ISC-90 groundwork). */
  acquisition: string;
  /**
   * Is the source capable of an autonomous live harvest? Class-1 sources are
   * all `true` — zero-auth endpoints, verified live in iteration 4. X became
   * `true` in iteration 7 once a paid Apify Starter run returned 99 real
   * (non-demo) tweets; before that it could only be covered by replay.
   */
  canLive: boolean;
  /**
   * Does a live harvest of this source spend real money? `canLive` describes
   * *capability*; `costsMoney` describes *authorization risk*. The orchestrator
   * must never auto-include a `costsMoney` source in `harvest:all` on token
   * presence alone — token presence is capability, not a spend go-ahead.
   * Gated behind `paidSourcesEnabled()` (iteration 7, advisor-flagged: a
   * token-presence auto-trigger is a recurring billing leak).
   */
  costsMoney: boolean;
  note?: string;
};

export const SOURCE_REGISTRY: Record<Source, SourceMeta> = {
  frontier: { source: 'frontier', label: 'Frontier Labs', accent: '#10a37f', authClass: 'class-1', acquisition: 'lab blog RSS/Atom feeds', canLive: true, costsMoney: false },
  arxiv:    { source: 'arxiv',    label: 'arXiv',         accent: '#b31b1b', authClass: 'class-1', acquisition: 'arXiv export API',          canLive: true, costsMoney: false },
  github:   { source: 'github',   label: 'GitHub',        accent: '#6e5494', authClass: 'class-1', acquisition: 'GitHub Search API',        canLive: true, costsMoney: false },
  x:        { source: 'x',        label: 'X / Twitter',   accent: '#1d9bf0', authClass: 'class-2', acquisition: 'Apify actor apidojo/twitter-scraper-lite', canLive: true, costsMoney: true, note: 'X is Class-2: it requires a paid Apify token, and a live harvest spends real money. It is covered live only when the token is present AND paid sources are explicitly opted in for the run (HARVEST_PAID=1) — otherwise it is covered by replay from a committed snapshot, never silently promoted to an autonomous source.' },
  youtube:  { source: 'youtube',  label: 'YouTube',       accent: '#ff0033', authClass: 'class-1', acquisition: 'channel RSS feeds',        canLive: true, costsMoney: false },
  reddit:   { source: 'reddit',   label: 'Reddit',        accent: '#ff4500', authClass: 'class-1', acquisition: 'old.reddit JSON endpoints', canLive: true, costsMoney: false },
  bluesky:  { source: 'bluesky',  label: 'Bluesky',       accent: '#0085ff', authClass: 'class-1', acquisition: 'AT Protocol getAuthorFeed', canLive: true, costsMoney: false },
  hn:       { source: 'hn',       label: 'Hacker News',   accent: '#ff6600', authClass: 'class-1', acquisition: 'HN Algolia search API',     canLive: true, costsMoney: false },
  tiktok:   { source: 'tiktok',   label: 'TikTok',        accent: '#ff0050', authClass: 'class-2', acquisition: 'Apify actor (default clockworks/tiktok-scraper, overridable via TIKTOK_APIFY_ACTOR)', canLive: true, costsMoney: true, note: 'TikTok is Class-2: it requires a paid Apify token, and a live harvest spends real money. Covered live only when the token is present AND paid sources are explicitly opted in (HARVEST_PAID=1) — otherwise covered by replay from a committed snapshot, never silently promoted to an autonomous source. Same posture as X.' },
  instagram:{ source: 'instagram',label: 'Instagram',     accent: '#e1306c', authClass: 'class-2', acquisition: 'Apify actor (default apify/instagram-hashtag-scraper, overridable via INSTAGRAM_APIFY_ACTOR)', canLive: true, costsMoney: true, note: 'Instagram is Class-2: paid Apify token + explicit HARVEST_PAID=1 opt-in for live coverage; otherwise covered by replay only. Same posture as X.' },
  // Iteration 20 scaffolding (S20) — editorial AI-news source class: aggregator
  // newsletters/podcasts about AI as a *content kind* distinct from frontier-lab
  // blogs (which are first-party announcements) and HN/Reddit (which are
  // community). Zero-auth public RSS.
  editorial:{ source: 'editorial',label: 'Editorial AI News', accent: '#7c3aed', authClass: 'class-1', acquisition: 'curated AI-news RSS feeds (AI Daily Brief, Last Week in AI)', canLive: true, costsMoney: false, note: 'Editorial sources are aggregator/curation newsletters (AI Daily Brief, Last Week in AI). Class-1 zero-auth RSS. Distinct from enterprise-news (Bloomberg/TechCrunch/etc.) which is publisher-style reporting, and from frontier (lab blogs) which is first-party.' },
  // Iteration 20 scaffolding (S20) — enterprise-news source class: traditional
  // publishers covering AI as part of business/tech reporting. Adds AI-keyword
  // filtering + paywall-stub flagging on top of standard RSS.
  enterprise:{source: 'enterprise',label: 'Enterprise News', accent: '#0f766e', authClass: 'class-1', acquisition: 'publisher AI-section RSS (TechCrunch, The Information, Bloomberg AI, FT AI, Reuters, The Verge, The Register)', canLive: true, costsMoney: false, note: 'Enterprise-news sources are traditional publishers. Class-1 zero-auth RSS. Items filtered by AI-keyword check (title+summary); paywalled-stub items flagged rather than dropped.' },
};

/**
 * Paid sources (`costsMoney: true`) are auto-included in `harvest:all` ONLY
 * when explicitly opted in for the run. Token presence is *capability*, not a
 * *spend authorization* — conflating them turned a routine fixture-regen into
 * an ungated ~$0.20 Apify charge in iteration 7. Standalone `bun run harvest:x`
 * is unaffected: invoking the paid harvester by name IS the explicit opt-in.
 */
export function paidSourcesEnabled(): boolean {
  const v = (process.env.HARVEST_PAID ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export type RunCoverage = {
  source: Source;
  mode: CoverageMode;
  count: number;
  authClass: AuthClass;
};

/**
 * Classifies how the current run covered each source. The honest answer
 * depends on BOTH the harvest mode and what actually returned items:
 *
 *   HARVEST_MODE=fixture / fixture-edge → every contributing source is `replay`
 *   HARVEST_MODE=live                   → a source with items is `live` iff it
 *                                         `canLive`; a source that produced
 *                                         items without `canLive` can only have
 *                                         done so from a snapshot path, so it
 *                                         reports `replay`; zero items is `absent`.
 *
 * This is the ISC-69 guarantee in code: a frozen-snapshot source is never
 * reported as "covered live".
 *
 * `registry` is injectable so the {canLive yes/no} × {mode live/fixture} matrix
 * is unit-testable without a source that happens to have `canLive: false` in
 * the live registry (iteration 7, advisor-flagged).
 */
export function coverageForRun(
  bySource: Record<string, number>,
  registry: Record<Source, SourceMeta> = SOURCE_REGISTRY,
): RunCoverage[] {
  const live = harvestMode() === 'live';
  return (Object.keys(registry) as Source[]).map((source) => {
    const count = bySource[source] ?? 0;
    const { authClass, canLive } = registry[source];
    let mode: CoverageMode;
    if (count === 0) mode = 'absent';
    else if (!live) mode = 'replay';
    else mode = canLive ? 'live' : 'replay';
    return { source, mode, count, authClass };
  });
}
