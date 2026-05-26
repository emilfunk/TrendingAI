// scripts/enrich-x-replies.ts — D3 + ISC-318/319/320 + ISC-372.
//
// Iter-27 structural mechanism for "reply-sentiment only on manually-picked
// tweets" defect class. Reads data/features-confirmed.json, picks top-N X
// items per feature by engagement, dedupes against existing data/x-replies.json,
// calls Apify x-post-replies-scraper for the missing URLs, merges results
// back into data/x-replies.json so the schema downstream (comment-sentiment.ts
// + render-features-first.ts) consumes is unchanged.
//
// PIPELINE ORDERING (per ISC-372, advisor S3 resolve): this runs AFTER
// features-first.ts and BEFORE comment-sentiment.ts and feature-sentiment.ts,
// so reply-signal data is available for Sonnet to read when synthesizing
// per-feature sentiment. The previous render-time-only integration meant
// Sonnet wrote "creators are excited" while the replies were 80% negative.
//
// COST: ~$0.01-0.02 per tweet via Apify scraper_one/x-post-replies-scraper.
// 16 features × 3 top tweets = ≤48 tweets; minus existing 3 already in
// data/x-replies.json from iter-22; expect ~40 new tweets ≈ $0.40-0.80
// Apify spend per run. Gated behind HARVEST_PAID=1 (default off — dry runs
// stay free; log "SKIPPED" loud so gap is visible).

import * as fs from "node:fs";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const TOKEN = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN ?? "";
const PAID = process.env.HARVEST_PAID === "1";
const ACTOR = (process.env.X_REPLIES_APIFY_ACTOR ?? "scraper_one~x-post-replies-scraper").replace("/", "~");

const TOP_N_PER_FEATURE = Number(process.env.X_REPLIES_TOP_N ?? "3");
const MAX_REPLIES_PER_POST = 20;
const FETCH_TIMEOUT_MS = 120_000;

interface ResponseItem {
  source: string;
  author: string;
  url: string;
  title: string;
  match_in: "title" | "raw_text" | "transcript";
  matched_entity: string;
  engagement: number;
}

interface ConfirmedFeature {
  feature_id: string;
  lab: string;
  title: string;
  url: string;
  ts: string;
  responses: ResponseItem[];
}

interface ReplyRow {
  url?: string;
  author: string;
  text: string;
  likes: number;
  replies: number;
  retweets: number;
  views: number;
  created_at?: string;
}

interface OutRow {
  tweet_url: string;
  tweet_ship_id: string;
  tweet_ship_name: string;
  tweet_author?: string;
  fetched_at: string;
  reply_count: number;
  replies: ReplyRow[];
  error?: string;
}

interface RawReply {
  postUrl?: string; postId?: string; replyId?: string; replyUrl?: string; replyText?: string;
  timestamp?: number | string;
  author?: { userName?: string; screenName?: string; name?: string };
  url?: string; text?: string; authorUsername?: string;
  likeCount?: number; likesCount?: number; favouriteCount?: number;
  replyCount?: number; repliesCount?: number;
  retweetCount?: number; retweetsCount?: number; repostCount?: number;
  viewCount?: number; viewsCount?: number | string;
  createdAt?: string;
}

function loadJson<T>(p: string, fb: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return fb; }
}

// Pick top-N x.com items per feature by engagement. Skips items whose URL
// isn't a status URL (defensive — some harvest paths leave the link as a
// non-tweet URL). Returns flat list of {tweet_url, feature_id, feature_title,
// author} so we can build OutRow shape downstream.
function pickTopXPerFeature(features: ConfirmedFeature[]): { url: string; feature_id: string; feature_title: string; author: string }[] {
  const out: { url: string; feature_id: string; feature_title: string; author: string }[] = [];
  for (const f of features) {
    const xResponses = f.responses
      .filter((r) => r.source === "x" && /x\.com\/[^/]+\/status\/\d+/.test(r.url))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, TOP_N_PER_FEATURE);
    for (const r of xResponses) {
      out.push({ url: r.url, feature_id: f.feature_id, feature_title: f.title, author: r.author });
    }
  }
  return out;
}

async function fetchReplies(tweetUrl: string): Promise<RawReply[]> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ postUrls: [tweetUrl], maxItems: MAX_REPLIES_PER_POST * 2 }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Apify ${ACTOR}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as RawReply[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeReply(r: RawReply): ReplyRow {
  const author = r.author?.screenName ?? r.author?.userName ?? r.authorUsername ?? "unknown";
  const likes = r.favouriteCount ?? r.likeCount ?? r.likesCount ?? 0;
  const replies = r.replyCount ?? r.repliesCount ?? 0;
  const retweets = r.repostCount ?? r.retweetCount ?? r.retweetsCount ?? 0;
  const viewsRaw = r.viewCount ?? r.viewsCount ?? 0;
  const views = typeof viewsRaw === "string" ? parseInt(viewsRaw, 10) || 0 : viewsRaw;
  const url = r.replyUrl ?? r.url;
  const text = (r.replyText ?? r.text ?? "").replace(/\s+/g, " ").trim();
  let createdAt = r.createdAt;
  if (!createdAt && r.timestamp) {
    const ms = typeof r.timestamp === "string" ? parseInt(r.timestamp, 10) : r.timestamp;
    if (Number.isFinite(ms)) createdAt = new Date(ms).toISOString();
  }
  return { url, author, text, likes, replies, retweets, views, created_at: createdAt };
}

async function main(): Promise<void> {
  if (!fs.existsSync(`${DATA}/features-confirmed.json`)) {
    console.error("data/features-confirmed.json missing — run src/features-first.ts first");
    process.exit(1);
  }
  const features: ConfirmedFeature[] = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const existing = loadJson<OutRow[]>(`${DATA}/x-replies.json`, []);
  const existingUrls = new Set(existing.map((r) => r.tweet_url));

  const candidates = pickTopXPerFeature(features);
  const newCandidates = candidates.filter((c) => !existingUrls.has(c.url));
  console.log(`features=${features.length} top-X-candidates=${candidates.length} already-cached=${candidates.length - newCandidates.length} to-fetch=${newCandidates.length}`);
  for (const c of newCandidates.slice(0, 50)) {
    console.log(`  ${c.feature_id.padEnd(28)} @${c.author.padEnd(20)} ${c.url}`);
  }

  if (newCandidates.length === 0) {
    console.log("nothing new to fetch — data/x-replies.json already covers all top-X items");
    return;
  }
  if (!PAID) {
    console.error("\nSKIPPED reply-sentiment enrichment — HARVEST_PAID=1 not set. Re-run with: HARVEST_PAID=1 bun scripts/enrich-x-replies.ts");
    console.error(`(would have fetched ${newCandidates.length} new tweets at ~$0.01-0.02 each)`);
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("\nAPIFY_TOKEN missing — add to .env (in this project root)");
    process.exit(3);
  }

  const out: OutRow[] = [...existing];
  let errored = 0;
  let totalNewReplies = 0;
  for (const c of newCandidates) {
    console.log(`\nfetching replies for ${c.feature_id} (${c.url})...`);
    try {
      const raw = await fetchReplies(c.url);
      const replies = raw
        .map(normalizeReply)
        .filter((r) => r.text && r.text.length > 0)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, MAX_REPLIES_PER_POST);
      console.log(`  → ${raw.length} raw, ${replies.length} top-by-likes kept`);
      out.push({
        tweet_url: c.url,
        tweet_ship_id: c.feature_id,
        tweet_ship_name: c.feature_title,
        tweet_author: c.author,
        fetched_at: new Date().toISOString(),
        reply_count: replies.length,
        replies,
      });
      totalNewReplies += replies.length;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  → ERROR: ${msg.slice(0, 200)}`);
      out.push({
        tweet_url: c.url,
        tweet_ship_id: c.feature_id,
        tweet_ship_name: c.feature_title,
        tweet_author: c.author,
        fetched_at: new Date().toISOString(),
        reply_count: 0,
        replies: [],
        error: msg.slice(0, 300),
      });
      errored += 1;
    }
  }
  fs.writeFileSync(`${DATA}/x-replies.json`, JSON.stringify(out, null, 2));
  console.log(`\nmerged ${newCandidates.length} new entries → data/x-replies.json (now ${out.length} total tweets, +${totalNewReplies} new replies, ${errored} errors)`);
  console.log(`\nnext step: bun src/comment-sentiment.ts → bun src/feature-sentiment.ts → bun src/render-features-first.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
