// src/discover.ts — discovery layer (v1.1 architectural pivot).
//
// Kem-quote 2026-05-16: "I know our reference is things like /goal but that's just a
// metric for me to see that we're finding the right data. It should still be sourcing
// naturally. I'm not doing directly hard-coded searches for it because if you are,
// that defeats the whole purpose of the tool, which is to bring these things up
// naturally."
//
// This script REMOVES the hardcoded SHIPS oracle from the surfacing path. Pipeline:
//
//   1. Read all harvested items (data/x.json + tiktok.json + instagram.json — uses
//      whatever's on disk, no new paid harvest).
//   2. Run existing dedupe.ts (token+bigram entity-anchored clustering — already
//      built S15, augmented with YT transcripts S20).
//   3. Score clusters by trending signal: multi-platform convergence + follower-
//      weighted engagement + creator-credibility tier.
//   4. Output top-N clusters → data/discovery.json. These BECOME the features-of-
//      the-week. /goal / Opus 4.7 / MCP appearing in top-N is the proof discovery
//      works; failing to surface them would be the falsification.
//
// No Apify spend. No Haiku calls in this pass — discovery is fully deterministic
// based on item structure + token clustering. Validation/sentiment runs AFTER
// discovery against whatever clusters surface.

import * as fs from "node:fs";
import { dedupeAndCluster } from "./dedupe.ts";
import type { NormalizedItem, Cluster } from "./types.ts";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return fallback; }
}

// Source-class weight: lab announcements + curated editorial trump unverified social.
const SOURCE_WEIGHT: Record<string, number> = {
  frontier: 1.3, arxiv: 1.1, editorial: 1.05, enterprise: 1.0, github: 1.0,
  hn: 1.0, x: 1.0, youtube: 1.0, reddit: 0.95, bluesky: 0.9, tiktok: 0.85, instagram: 0.85,
};

interface DiscoveryCluster {
  rank: number;
  label: string;
  trending_score: number;
  signals: {
    item_count: number;
    distinct_platforms: number;
    distinct_authors: number;
    sum_engagement: number;
    sum_follower_weighted_engagement: number;
    top_author_followers: number;
    has_lab_post: boolean;
    has_press_post: boolean;
    has_short_form_video: boolean;
  };
  rep_item: { source: string; author: string; engagement: number; followers: number; url?: string; title: string; };
  sample_titles: string[];   // top 5 distinct items in cluster
  sources_breakdown: Record<string, number>;
}

function fwEngagement(it: NormalizedItem): number {
  const eng = it.engagement || 0;
  const followers = ((it.meta as { followers?: number } | undefined)?.followers) || 0;
  return eng * Math.log10(followers + 10);
}

function scoreCluster(c: Cluster): { score: number; signals: DiscoveryCluster["signals"] } {
  const platforms = new Set(c.items.map((i) => i.source));
  const authors = new Set(c.items.map((i) => ((i.meta as { author?: string } | undefined)?.author) || ""));
  const sumEng = c.items.reduce((acc, i) => acc + (i.engagement || 0), 0);
  const sumFw = c.items.reduce((acc, i) => acc + fwEngagement(i), 0);
  const topAuthorFollowers = Math.max(...c.items.map((i) => ((i.meta as { followers?: number } | undefined)?.followers) || 0));
  const hasLab = c.items.some((i) => i.source === "frontier");
  const hasPress = c.items.some((i) => i.source === "editorial" || i.source === "enterprise");
  const hasShortForm = c.items.some((i) => i.source === "tiktok" || i.source === "instagram");

  // Trending score: convergence × reach × credibility. Designed so a feature that
  // appears on 4 platforms with 1 high-follower creator beats a feature with 50
  // low-follower posts on 1 platform.
  const convergence = Math.pow(platforms.size, 1.5);
  const reach = Math.log10(sumFw + 10);
  const sourceWeight = c.items.reduce((acc, i) => acc + (SOURCE_WEIGHT[i.source] || 1.0), 0) / c.items.length;
  const creatorBonus = topAuthorFollowers > 50_000 ? 1.3 : topAuthorFollowers > 10_000 ? 1.1 : 1.0;
  const labBonus = hasLab ? 1.5 : 1.0;
  const score = convergence * reach * sourceWeight * creatorBonus * labBonus * authors.size;

  return {
    score,
    signals: {
      item_count: c.items.length,
      distinct_platforms: platforms.size,
      distinct_authors: authors.size,
      sum_engagement: sumEng,
      sum_follower_weighted_engagement: Math.round(sumFw),
      top_author_followers: topAuthorFollowers,
      has_lab_post: hasLab,
      has_press_post: hasPress,
      has_short_form_video: hasShortForm,
    },
  };
}

function main() {
  const x = loadJson<NormalizedItem[]>(`${DATA}/x.json`, []);
  const tt = loadJson<NormalizedItem[]>(`${DATA}/tiktok.json`, []);
  const ig = loadJson<NormalizedItem[]>(`${DATA}/instagram.json`, []);
  // ISC-307 (iter-24.5): full source coverage. Each loaded the same way it's
  // shipped to disk by its harvester (`bun src/harvesters/<src>.ts`). HN ships
  // a `{items, errors}` envelope (per harvester docs); every other source ships
  // a bare `items[]` array. Unwrap HN at the load site so downstream code stays
  // shape-uniform.
  const yt = loadJson<NormalizedItem[]>(`${DATA}/youtube.json`, []);
  const fr = loadJson<NormalizedItem[]>(`${DATA}/frontier.json`, []);
  const hnRaw = loadJson<{ items?: NormalizedItem[] } | NormalizedItem[]>(`${DATA}/hn.json`, []);
  const hn = Array.isArray(hnRaw) ? hnRaw : (hnRaw.items ?? []);
  const rd = loadJson<NormalizedItem[]>(`${DATA}/reddit.json`, []);
  const gh = loadJson<NormalizedItem[]>(`${DATA}/github.json`, []);
  const ax = loadJson<NormalizedItem[]>(`${DATA}/arxiv.json`, []);
  const bs = loadJson<NormalizedItem[]>(`${DATA}/bluesky.json`, []);
  const ed = loadJson<NormalizedItem[]>(`${DATA}/editorial.json`, []);
  const en = loadJson<NormalizedItem[]>(`${DATA}/enterprise.json`, []);
  const all = [...x, ...tt, ...ig, ...yt, ...fr, ...hn, ...rd, ...gh, ...ax, ...bs, ...ed, ...en];
  console.log(
    `discover: ${all.length} items ` +
    `(X:${x.length} TT:${tt.length} IG:${ig.length} YT:${yt.length} FR:${fr.length} ` +
    `HN:${hn.length} RD:${rd.length} GH:${gh.length} AX:${ax.length} BS:${bs.length} ED:${ed.length} EN:${en.length})`
  );

  // ISC-307 instrumentation (iter-24 — characterizes the upstream coverage gap
  // surfaced by ISC-305 — extended iter-24.5 to report empty-source loads as
  // the new failure mode now that the load list is complete). A zero-count
  // source means its harvester hasn't been re-run recently.
  const loaded: Record<string, number> = {
    x: x.length, tiktok: tt.length, instagram: ig.length, youtube: yt.length,
    frontier: fr.length, hn: hn.length, reddit: rd.length, github: gh.length,
    arxiv: ax.length, bluesky: bs.length, editorial: ed.length, enterprise: en.length,
  };
  const empty = Object.entries(loaded).filter(([, n]) => n === 0).map(([s]) => s);
  if (empty.length > 0) {
    console.log(`discover: EMPTY-SOURCE — these source files loaded zero items (harvester not re-run, or genuinely empty): ${empty.join(', ')}`);
  } else {
    console.log(`discover: SOURCE-COVERAGE — all 12 sources loaded with items (ISC-307 closed iter-24.5).`);
  }

  const { clusters, in_count, out_count } = dedupeAndCluster(all);
  console.log(`dedupeAndCluster: ${in_count} → ${out_count} after URL dedup → ${clusters.length} clusters`);

  const scored = clusters.map((c) => {
    const { score, signals } = scoreCluster(c);
    return { c, score, signals };
  });

  // Keep clusters with ≥2 distinct platforms OR ≥3 items (filter out singletons /
  // single-platform noise — but allow short multi-item single-platform threads
  // through so a viral X moment isn't lost).
  const filtered = scored.filter((s) => s.signals.distinct_platforms >= 2 || s.signals.item_count >= 3);
  const dropped = scored.length - filtered.length;
  // ISC-307 instrumentation: break dropped-cluster count by exclusion reason,
  // so iter-24.5 knows whether the inclusion-rule needs single-platform-OK or
  // item-count-floor tuning. Per-cluster drops named so /goal-class small-
  // signal items can be traced.
  let droppedSinglePlatformSingleton = 0;
  let droppedSinglePlatformTwoItem = 0;
  for (const s of scored) {
    if (s.signals.distinct_platforms >= 2 || s.signals.item_count >= 3) continue;
    if (s.signals.item_count === 1) droppedSinglePlatformSingleton++;
    else droppedSinglePlatformTwoItem++;
  }
  console.log(`discover: DROPPED ${dropped} clusters by trending filter — ${droppedSinglePlatformSingleton} singletons, ${droppedSinglePlatformTwoItem} two-item-single-platform. ISC-305-style content (single-creator high-engagement) is in this bucket.`);
  filtered.sort((a, b) => b.score - a.score);

  const TOP_N = 24;
  const top = filtered.slice(0, TOP_N).map((s, i): DiscoveryCluster => {
    const rep = s.c.items[0]!;
    const repAuthor = ((rep.meta as { author?: string } | undefined)?.author) || "unknown";
    const repFol = ((rep.meta as { followers?: number } | undefined)?.followers) || 0;
    const sources: Record<string, number> = {};
    for (const it of s.c.items) sources[it.source] = (sources[it.source] || 0) + 1;
    return {
      rank: i + 1,
      label: s.c.label,
      trending_score: Math.round(s.score),
      signals: s.signals,
      rep_item: {
        source: rep.source,
        author: repAuthor,
        engagement: rep.engagement || 0,
        followers: repFol,
        url: rep.url,
        title: rep.title,
      },
      sample_titles: s.c.items.slice(0, 5).map((i) => i.title),
      sources_breakdown: sources,
    };
  });

  fs.writeFileSync(`${DATA}/discovery.json`, JSON.stringify(top, null, 2));
  console.log(`\nwrote top-${top.length} clusters → data/discovery.json`);

  // D4 (iter-23): parallel emission of per-cluster items[] so reason-cluster.ts
  // has citation anchors (URLs) without re-running dedupe. Schema is independent
  // of discovery.json — additive, backward-compatible.
  const clusterItems = filtered.slice(0, TOP_N).map((s, i) => {
    const items = s.c.items
      .map((it) => {
        const meta = (it.meta as { author?: string; followers?: number } | undefined) || {};
        return {
          url: it.url || "",
          title: it.title,
          source: it.source,
          engagement: it.engagement || 0,
          author: meta.author || "",
        };
      })
      .filter((it) => it.url.length > 0);
    return {
      rank: i + 1,
      label: s.c.label,
      items,
    };
  });
  // Advisor (iter-23 D4 VERIFY): wrap in versioned envelope + atomic write.
  // schema_version locks the consumer contract; atomic write prevents partial-write
  // corruption (Ctrl-C mid-write) from leaving the downstream reasoning pass with
  // a malformed file. Test for `schema_version` before treating older files as valid.
  const envelope = {
    schema_version: 1 as const,
    generated_at: new Date().toISOString(),
    clusters: clusterItems,
  };
  const finalPath = `${DATA}/discovery-clusters.json`;
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(tmpPath, finalPath);
  const totalAnchors = clusterItems.reduce((acc, c) => acc + c.items.length, 0);
  const clustersBelowFloor = clusterItems.filter((c) => c.items.length < 2).length;
  console.log(`wrote ${clusterItems.length} clusters × ${totalAnchors} URL'd items → data/discovery-clusters.json (schema_version=1, ${clustersBelowFloor} below citation-floor of 2)`);

  // Print a quick text summary so we can immediately eyeball whether discovery
  // surfaced the expected ground-truth (/goal, Opus 4.7, MCP, Codex mobile, SMB,
  // Claude Design). These are NOT inputs — they're the falsifier set.
  console.log(`\n=== TOP ${top.length} DISCOVERED CLUSTERS (no hardcoded oracle) ===`);
  for (const t of top) {
    const platforms = Object.keys(t.sources_breakdown).join("+");
    const labFlag = t.signals.has_lab_post ? " LAB" : "";
    const pressFlag = t.signals.has_press_post ? " PRESS" : "";
    const shortFlag = t.signals.has_short_form_video ? " SHORT" : "";
    console.log(`  #${String(t.rank).padStart(2)}  score=${String(t.trending_score).padStart(6)}  [${platforms.padEnd(20)}]${labFlag}${pressFlag}${shortFlag}  ${t.label.slice(0, 100)}`);
  }
}

main();
