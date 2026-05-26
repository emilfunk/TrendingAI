// src/harvesters/features-deep.ts — feature-specific deep harvest (v1.0 fix-stack).
//
// Diagnostic from v0.9 walk: generic AI keyword harvests (TRENDING_QUERY in
// x.ts; #ai/#aitools hashtags in tiktok/instagram) miss feature-specific
// reactions. /goal had 1 X item. Opus 4.7 had 1 X item + 2 IG. Codex mobile
// had 1 X item. This script runs FEATURE-NAMED queries per ship and merges
// results into the existing data/{x,tiktok,instagram}.json files with URL
// dedup, so downstream validator/render see one unified pool per source.
//
// Gates:
//   HARVEST_PAID=1 required (this is paid Apify spend, estimated $0.70-1.40 total).
//   APIFY_TOKEN required.

import * as fs from "node:fs";
import * as path from "node:path";

// Portable bundle: resolve paths relative to the package.json directory.
// Bun's `bun run X` sets cwd to the package root.
const PROJECT = process.cwd();
const DATA = `${PROJECT}/data`;
const TOKEN = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN ?? "";
const PAID = process.env.HARVEST_PAID === "1";

const X_ACTOR = "apidojo~twitter-scraper-lite";
const TT_ACTOR = (process.env.TIKTOK_APIFY_ACTOR ?? "clockworks/tiktok-scraper").replace("/", "~");
const IG_ACTOR = (process.env.INSTAGRAM_APIFY_ACTOR ?? "apify/instagram-hashtag-scraper").replace("/", "~");

interface Feature {
  id: string;
  x_queries: string[];        // tweet search queries
  tiktok_hashtags: string[];  // TT hashtag terms (without #)
  instagram_hashtags: string[];
  since_date?: string;        // ISO date for `since:` in X queries
}

// Release dates inform `since:` to keep queries tight to the actual launch window.
const FEATURES: Feature[] = [
  {
    id: "goal",
    x_queries: [`("/goal" OR "slash goal" OR "Claude Code goal") (Claude OR Anthropic OR ClaudeCode) min_faves:5 lang:en`],
    tiktok_hashtags: ["claudecode", "claudecodegoal", "anthropic"],
    instagram_hashtags: ["claudecode", "anthropicai"],
    since_date: "2026-05-05",
  },
  {
    id: "codex-mobile",
    x_queries: [`("Codex on mobile" OR "Codex mobile" OR "Codex in ChatGPT mobile" OR "Codex iOS" OR "Codex Android") min_faves:5 lang:en`],
    tiktok_hashtags: ["chatgptmobile", "codex", "codexai", "openaichatgpt"],
    instagram_hashtags: ["chatgpt", "codex", "openai"],
    since_date: "2026-05-14",
  },
  {
    id: "opus-4-7",
    x_queries: [`("Opus 4.7" OR "Claude Opus 4.7" OR "opus-4-7") min_faves:5 lang:en`],
    tiktok_hashtags: ["claudeopus", "opus47", "claude47", "claudeai"],
    instagram_hashtags: ["claudeopus", "anthropicai", "opus47"],
    since_date: "2026-05-12",
  },
  {
    id: "mcp",
    x_queries: [`("Model Context Protocol" OR "MCP server" OR "MCP servers" OR "#MCP") min_faves:5 lang:en`],
    tiktok_hashtags: ["mcp", "modelcontextprotocol", "claudemcp"],
    instagram_hashtags: ["mcp", "claudemcp"],
    since_date: "2026-05-09",
  },
  {
    id: "smb",
    x_queries: [`("Claude for Small Business" OR "Claude SMB" OR "Cowork" OR "tenex_labs") (Claude OR Anthropic) min_faves:5 lang:en`],
    tiktok_hashtags: ["claudesmb", "smallbusinessai", "cowork", "claudeforbusiness"],
    instagram_hashtags: ["claudesmb", "smallbusinessai", "cowork"],
    since_date: "2026-05-08",
  },
  {
    // 2026-05-16 fix: feature renamed from "creative-work" to "claude-design" — actual
    // product is Claude Design (Anthropic Labs, launched 2026-04-17, dedicated visual
    // canvas, separate usage tracking). Prior name was a guess; verified via WebSearch.
    id: "claude-design",
    x_queries: [`("Claude Design" OR "claude.ai/design" OR "anthropic design") min_faves:5 lang:en`],
    tiktok_hashtags: ["claudedesign", "anthropicclaude", "claudeai", "anthropicdesign"],
    instagram_hashtags: ["claudedesign", "anthropicai", "anthropicclaude"],
    since_date: "2026-04-17",
  },
];

// ---------- helpers ----------

interface NormalizedItem {
  title?: string;
  url?: string;
  source: "x" | "tiktok" | "instagram";
  ts?: string;
  engagement?: number;
  raw_text?: string;
  meta?: Record<string, unknown>;
}

async function callApify(actor: string, input: Record<string, unknown>, label: string): Promise<unknown[]> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Apify ${actor} (${label}): HTTP ${res.status} — ${body.slice(0, 240)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeX(t: any, queryLabel: string): NormalizedItem | null {
  const url = t.url;
  const text = t.text;
  if (!url || !text) return null;
  const author = t.author?.userName ?? t.authorUsername ?? "unknown";
  const likes = t.likeCount ?? t.likesCount ?? 0;
  const rts = t.retweetCount ?? t.retweetsCount ?? 0;
  const replies = t.replyCount ?? t.repliesCount ?? 0;
  const views = t.viewCount ?? t.viewsCount ?? 0;
  const followers = t.author?.followersCount ?? t.author?.followers ?? t.authorFollowersCount ?? 0;
  const ts = t.createdAt ?? t.timestamp ?? new Date().toISOString();
  const engagement = likes + rts * 2 + replies + Math.floor(views / 100);
  const cleaned = text.replace(/\s+/g, " ").trim();
  return {
    title: `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? "…" : ""}`,
    url,
    source: "x",
    ts,
    engagement,
    raw_text: cleaned,
    meta: { author, likes, retweets: rts, replies, views, followers, x_tier: "feature-query", feature_query: queryLabel },
  };
}

function normalizeTT(t: any, hashtag: string): NormalizedItem | null {
  const url = t.webVideoUrl ?? t.url;
  const text = t.text ?? t.title ?? "";
  if (!url) return null;
  const author = t.authorMeta?.name ?? t.authorMeta?.uniqueId ?? t.author ?? "unknown";
  const likes = t.diggCount ?? t.likeCount ?? 0;
  const shares = t.shareCount ?? 0;
  const comments = t.commentCount ?? 0;
  const plays = t.playCount ?? 0;
  const followers = t.authorMeta?.fans ?? t.authorMeta?.followerCount ?? 0;
  const ts = t.createTimeISO ?? (t.createTime ? new Date(t.createTime * 1000).toISOString() : new Date().toISOString());
  const engagement = likes + shares * 2 + comments + Math.floor(plays / 1000);
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  return {
    title: `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? "…" : ""}`,
    url,
    source: "tiktok",
    ts,
    engagement,
    raw_text: cleaned,
    meta: { author, likes, shares, comments, plays, followers, media: url, feature_hashtag: hashtag },
  };
}

function normalizeIG(p: any, hashtag: string): NormalizedItem | null {
  const url = p.url ?? p.permalink;
  if (!url) return null;
  const text = p.caption ?? p.text ?? "";
  const author = p.ownerUsername ?? p.username ?? "unknown";
  const likes = p.likesCount ?? 0;
  const comments = p.commentsCount ?? 0;
  const views = p.videoViewCount ?? p.viewCount ?? 0;
  const followers = p.ownerFollowersCount ?? 0;
  const ts = p.timestamp ?? new Date().toISOString();
  const engagement = likes + comments * 2 + Math.floor(views / 100);
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  const media = p.videoUrl ?? p.url ?? "";
  return {
    title: `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? "…" : ""}`,
    url,
    source: "instagram",
    ts,
    engagement,
    raw_text: cleaned,
    meta: { author, likes, comments, views, followers, media, feature_hashtag: hashtag },
  };
}

function mergeByUrl(existing: NormalizedItem[], incoming: NormalizedItem[]): { merged: NormalizedItem[]; added: number; updated: number } {
  const byUrl = new Map<string, NormalizedItem>();
  for (const it of existing) if (it.url) byUrl.set(it.url, it);
  let added = 0;
  let updated = 0;
  for (const it of incoming) {
    if (!it.url) continue;
    if (byUrl.has(it.url)) {
      // keep existing meta but enrich with feature query/hashtag tag
      const cur = byUrl.get(it.url)!;
      cur.meta = { ...cur.meta, ...it.meta };
      updated++;
    } else {
      byUrl.set(it.url, it);
      added++;
    }
  }
  return { merged: Array.from(byUrl.values()), added, updated };
}

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return fallback; }
}

// ---------- main ----------

async function main() {
  if (!PAID) {
    console.error("HARVEST_PAID=1 not set — this script makes paid Apify calls. Re-run: HARVEST_PAID=1 bun src/harvesters/features-deep.ts");
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("APIFY_TOKEN missing");
    process.exit(3);
  }
  // FEATURES_ONLY env: comma-separated ship ids to restrict the harvest.
  // Use case: re-run JUST claude-design after renaming, without re-paying for the other 5.
  const onlyEnv = process.env.FEATURES_ONLY ?? "";
  const onlySet = new Set(onlyEnv.split(",").map((s) => s.trim()).filter(Boolean));
  const active = onlySet.size > 0 ? FEATURES.filter((f) => onlySet.has(f.id)) : FEATURES;
  if (onlySet.size > 0) console.log(`FEATURES_ONLY=${onlyEnv} — restricted to ${active.length} of ${FEATURES.length} features`);
  console.log(`features-deep harvest starting — ${active.length} feature(s) × (X queries + TT hashtags + IG hashtags)`);

  const xNew: NormalizedItem[] = [];
  const ttNew: NormalizedItem[] = [];
  const igNew: NormalizedItem[] = [];
  const errors: string[] = [];

  for (const f of active) {
    console.log(`\n── ${f.id} ──`);

    // X
    for (const q of f.x_queries) {
      const sinceClause = f.since_date ? ` since:${f.since_date}` : "";
      const query = q + sinceClause;
      try {
        console.log(`  X query: ${query.slice(0, 100)}`);
        const raw = await callApify(X_ACTOR, { searchTerms: [query], maxItems: 30, sort: "Top" }, `${f.id}-x`);
        const normalized = raw.map((t) => normalizeX(t, `${f.id}:${q.slice(0, 40)}`)).filter((n): n is NormalizedItem => !!n);
        xNew.push(...normalized);
        console.log(`    → ${raw.length} raw, ${normalized.length} normalized`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`X ${f.id}: ${msg.slice(0, 160)}`);
        console.error(`    ERR ${msg.slice(0, 160)}`);
      }
    }

    // TikTok
    if (f.tiktok_hashtags.length > 0) {
      try {
        console.log(`  TT hashtags: ${f.tiktok_hashtags.join(", ")}`);
        const raw = await callApify(TT_ACTOR, { hashtags: f.tiktok_hashtags, resultsPerPage: 20, shouldDownloadVideos: false }, `${f.id}-tt`);
        const normalized = raw.map((t) => normalizeTT(t, `${f.id}:${f.tiktok_hashtags[0]}`)).filter((n): n is NormalizedItem => !!n);
        ttNew.push(...normalized);
        console.log(`    → ${raw.length} raw, ${normalized.length} normalized`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`TT ${f.id}: ${msg.slice(0, 160)}`);
        console.error(`    ERR ${msg.slice(0, 160)}`);
      }
    }

    // Instagram
    if (f.instagram_hashtags.length > 0) {
      try {
        console.log(`  IG hashtags: ${f.instagram_hashtags.join(", ")}`);
        const raw = await callApify(IG_ACTOR, { hashtags: f.instagram_hashtags, resultsLimit: 20 }, `${f.id}-ig`);
        const normalized = raw.map((p) => normalizeIG(p, `${f.id}:${f.instagram_hashtags[0]}`)).filter((n): n is NormalizedItem => !!n);
        igNew.push(...normalized);
        console.log(`    → ${raw.length} raw, ${normalized.length} normalized`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`IG ${f.id}: ${msg.slice(0, 160)}`);
        console.error(`    ERR ${msg.slice(0, 160)}`);
      }
    }
  }

  console.log(`\n── MERGE ──`);
  const existingX = loadJson<NormalizedItem[]>(`${DATA}/x.json`, []);
  const existingTT = loadJson<NormalizedItem[]>(`${DATA}/tiktok.json`, []);
  const existingIG = loadJson<NormalizedItem[]>(`${DATA}/instagram.json`, []);

  const x = mergeByUrl(existingX, xNew);
  const tt = mergeByUrl(existingTT, ttNew);
  const ig = mergeByUrl(existingIG, igNew);

  console.log(`  X:  was ${existingX.length}, +${x.added} new, ${x.updated} enriched → ${x.merged.length}`);
  console.log(`  TT: was ${existingTT.length}, +${tt.added} new, ${tt.updated} enriched → ${tt.merged.length}`);
  console.log(`  IG: was ${existingIG.length}, +${ig.added} new, ${ig.updated} enriched → ${ig.merged.length}`);

  fs.writeFileSync(`${DATA}/x.json`, JSON.stringify(x.merged, null, 2));
  fs.writeFileSync(`${DATA}/tiktok.json`, JSON.stringify(tt.merged, null, 2));
  fs.writeFileSync(`${DATA}/instagram.json`, JSON.stringify(ig.merged, null, 2));

  if (errors.length > 0) {
    console.log(`\n${errors.length} errors:`);
    for (const e of errors) console.log(`  - ${e}`);
  }
  console.log(`\nfeatures-deep harvest complete.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
