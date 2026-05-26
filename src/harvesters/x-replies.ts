// src/harvesters/x-replies.ts — Apify-backed X reply harvester (v0.9).
//
// For each VALIDATED main-source tweet (one per ship × source from
// data/validation.json), pull the top-N replies by likes via the
// scraper_one/x-post-replies-scraper Apify actor. Same HARVEST_PAID gate +
// Authorization-header token discipline as src/harvesters/x.ts (ISC-68).
//
// OUTPUT: data/x-replies.json — array of { tweet_url, tweet_ship_id, replies[] }
// where each reply = { url, author, text, likes, replies, retweets, views }.

import * as fs from "node:fs";
import type { NormalizedItem } from "../types.ts";
import { LAB_X_ACCOUNTS, QUALITY_GATE_HIGH_ENGAGEMENT } from "../features-first.ts";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const TOKEN = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN ?? "";
const PAID = process.env.HARVEST_PAID === "1";
// scraper_one/x-post-replies-scraper — researched in S19.5, never run live yet.
// Override via env var if a different actor name is preferred.
const ACTOR = (process.env.X_REPLIES_APIFY_ACTOR ?? "scraper_one~x-post-replies-scraper").replace("/", "~");
const MAX_REPLIES_PER_POST = 20;

export interface ValidationRow {
  ship: string;
  ship_name: string;
  source: string;
  url?: string;
  author?: string;
  engagement?: number;
  verdict: "VALIDATED" | "ADJACENT" | "OFF-TOPIC";
  reason: string;
}

interface RawReply {
  // scraper_one/x-post-replies-scraper shape (verified via live probe):
  postUrl?: string;
  postId?: string;
  replyId?: string;
  replyUrl?: string;
  replyText?: string;
  timestamp?: number | string;
  author?: { userName?: string; screenName?: string; name?: string };
  // common alternates kept for resilience if actor name is overridden:
  url?: string;
  text?: string;
  authorUsername?: string;
  likeCount?: number;
  likesCount?: number;
  favouriteCount?: number;
  replyCount?: number;
  repliesCount?: number;
  retweetCount?: number;
  retweetsCount?: number;
  repostCount?: number;
  viewCount?: number;
  viewsCount?: number | string;
  createdAt?: string;
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

export function pickMainSources(validation: ValidationRow[]): ValidationRow[] {
  // For each ship × source, pick the highest-engagement VALIDATED row.
  // We want the "main source" tweet per ship (typically X). If no X validation
  // exists for a ship, falls through to no replies for that ship — honest gap.
  const out: ValidationRow[] = [];
  const seen = new Set<string>();
  const byEngagement = [...validation].sort((a, b) => (b.engagement || 0) - (a.engagement || 0));
  for (const row of byEngagement) {
    if (row.source !== "x") continue;
    if (row.verdict !== "VALIDATED") continue;
    if (!row.url) continue;
    const key = row.ship;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ISC-411 (iter-30 follow-up) — pull reply pools for ALL high-engagement
// lab-X posts each cycle, not just the iter-N feature shortlist. Closes the
// data-coverage gap that left D-WALK-22 with 0 live yield: 7 empty-entity
// drama posts (Codex mobile, AnthropicAI paper, Notebooks in Gemini, agent
// view, GoogleDeepMind mouse pointer, Happy Friday rate-limits, How-do-you-
// keep-Claude-working) had no reply pool harvested so the negative-pool gate
// couldn't fire. Pairs with iter-27 deliverable #3 (extend x-replies to every
// top X tweet across features).
//
// Each lab-X candidate is shaped as a synthetic VALIDATED row so the existing
// fetch/normalize/main loop consumes it identically. ship_id format:
// `labx-${author}-${statusId.slice(-6)}` — unique, traceable, distinguishable
// from feature-derived ship_ids by the `labx-` prefix.
export function pickLabXCandidates(xItems: NormalizedItem[]): ValidationRow[] {
  const out: ValidationRow[] = [];
  for (const it of xItems) {
    const author = ((it.meta as { author?: string } | undefined)?.author) ?? "";
    if (!LAB_X_ACCOUNTS.has(author)) continue;
    if ((it.engagement ?? 0) < QUALITY_GATE_HIGH_ENGAGEMENT) continue;
    const statusId = it.url.match(/status\/(\d+)/)?.[1];
    if (!statusId) continue;
    const ship_id = `labx-${author.toLowerCase()}-${statusId.slice(-6)}`;
    out.push({
      ship: ship_id,
      ship_name: (it.title ?? "").slice(0, 120),
      source: "x",
      url: it.url,
      author,
      engagement: it.engagement,
      verdict: "VALIDATED",
      reason: "ISC-411 lab-X candidate (>=10k engagement, author in LAB_X_ACCOUNTS)",
    });
  }
  return out;
}

// Merge feature-shortlist VALIDATED tweets with lab-X candidates, dedup by
// canonical URL (strip trailing slash + query). Feature-shortlist sources
// win on duplicate so existing ship_id is preserved when both paths
// nominate the same tweet — protects the comment-sentiment.json key shape
// the renderer already depends on.
function canonicalUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
}

export function mergeSources(
  mainSources: ValidationRow[],
  labXCandidates: ValidationRow[],
): ValidationRow[] {
  const seen = new Set(mainSources.map((s) => canonicalUrl(s.url ?? "")));
  const out: ValidationRow[] = [...mainSources];
  for (const c of labXCandidates) {
    if (!c.url) continue;
    const key = canonicalUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function loadJson<T>(p: string, fb: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return fb;
  }
}

function loadXItems(): NormalizedItem[] {
  const raw = loadJson<NormalizedItem[] | { items?: NormalizedItem[] }>(`${DATA}/x.json`, []);
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

async function fetchReplies(tweetUrl: string): Promise<RawReply[]> {
  if (!TOKEN) throw new Error("APIFY_TOKEN missing");
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
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

async function main() {
  if (!fs.existsSync(`${DATA}/validation.json`)) {
    console.error("data/validation.json missing — run src/validate-relevance.ts first");
    process.exit(1);
  }
  const validation: ValidationRow[] = JSON.parse(fs.readFileSync(`${DATA}/validation.json`, "utf-8"));
  const mainSources = pickMainSources(validation);
  console.log(`identified ${mainSources.length} main-source feature tweets across ${new Set(mainSources.map((s) => s.ship)).size} ship(s)`);

  // ISC-411 — lab-X candidate expansion. Read data/x.json directly, filter
  // to LAB_X_ACCOUNTS + engagement floor, merge with main-sources (dedup by
  // canonical URL). Each lab-X candidate becomes its own ship_id so the
  // downstream comment-sentiment pass attributes replies correctly.
  const xItems = loadXItems();
  const labX = pickLabXCandidates(xItems);
  console.log(`identified ${labX.length} lab-X candidates >=${QUALITY_GATE_HIGH_ENGAGEMENT} engagement from data/x.json`);
  const sources = mergeSources(mainSources, labX);
  const addedByLabX = sources.length - mainSources.length;
  console.log(`merged: ${sources.length} total sources (+${addedByLabX} after dedup)`);
  for (const s of sources) {
    console.log(`  ${s.ship.padEnd(28)} → @${s.author}: ${s.url}`);
  }

  if (!PAID) {
    console.error("\nHARVEST_PAID=1 not set — refusing to spend Apify credits. Re-run with: HARVEST_PAID=1 bun src/harvesters/x-replies.ts");
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("\nAPIFY_TOKEN missing — add to .env (in this project root)");
    process.exit(3);
  }

  const out: OutRow[] = [];
  for (const s of sources) {
    if (!s.url) continue;
    console.log(`\nfetching replies for ${s.ship} (${s.url})...`);
    try {
      const raw = await fetchReplies(s.url);
      const replies = raw
        .map(normalizeReply)
        .filter((r) => r.text && r.text.length > 0)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, MAX_REPLIES_PER_POST);
      console.log(`  → ${raw.length} raw, ${replies.length} top-by-likes kept`);
      out.push({
        tweet_url: s.url,
        tweet_ship_id: s.ship,
        tweet_ship_name: s.ship_name,
        tweet_author: s.author,
        fetched_at: new Date().toISOString(),
        reply_count: replies.length,
        replies,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  → ERROR: ${msg.slice(0, 200)}`);
      out.push({
        tweet_url: s.url,
        tweet_ship_id: s.ship,
        tweet_ship_name: s.ship_name,
        tweet_author: s.author,
        fetched_at: new Date().toISOString(),
        reply_count: 0,
        replies: [],
        error: msg.slice(0, 300),
      });
    }
  }
  fs.writeFileSync(`${DATA}/x-replies.json`, JSON.stringify(out, null, 2));
  const totalReplies = out.reduce((acc, r) => acc + r.reply_count, 0);
  const errored = out.filter((r) => r.error).length;
  console.log(`\nwrote ${out.length} tweets with ${totalReplies} replies → data/x-replies.json (${errored} errors)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
