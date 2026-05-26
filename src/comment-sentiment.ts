// src/comment-sentiment.ts — per-reply sentiment classifier (v0.9).
//
// Reads data/x-replies.json (produced by src/harvesters/x-replies.ts), scores
// each reply via Haiku for sentiment toward the parent tweet's feature, writes
// data/comment-sentiment.json. Reuses three-boundary discipline from
// src/classify-reception.ts (S18 proven pattern): LLM call above the
// boundary, anchor check at the boundary, deterministic resolve below.
//
// OUTPUT: data/comment-sentiment.json — array of { tweet_url, ship_id, agg, replies[] }
// where each reply gets { sentiment, reason, anchor_present } and `agg` carries
// the per-tweet rollup the renderer uses for the sentiment bar.

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const CONCURRENCY = 4;

type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";

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

interface TweetRow {
  tweet_url: string;
  tweet_ship_id: string;
  tweet_ship_name: string;
  tweet_author?: string;
  fetched_at: string;
  reply_count: number;
  replies: ReplyRow[];
  error?: string;
}

interface ScoredReply extends ReplyRow {
  sentiment: Sentiment;
  reason: string;
  anchor_present: boolean;
}

interface AggSentiment {
  positive: number;
  negative: number;
  neutral: number;
  mixed: number;
  total: number;
  dominant: Sentiment | "UNKNOWN";
  total_likes_positive: number;
  total_likes_negative: number;
}

interface OutRow {
  tweet_url: string;
  ship_id: string;
  ship_name: string;
  tweet_author?: string;
  agg: AggSentiment;
  replies: ScoredReply[];
}

const SYS = `You are a sentiment classifier for tweet replies. Read the FEATURE the parent tweet is about and the REPLY text. Decide the reply's sentiment toward the feature.
Reply with ONE line in this EXACT format:
SENTIMENT: <POSITIVE|NEGATIVE|NEUTRAL|MIXED> | REASON: <one short sentence quoting a fragment from the reply that justifies your call>

Definitions:
- POSITIVE: reply praises, supports, or expresses excitement about the feature.
- NEGATIVE: reply criticizes, complains about, mocks, or is disappointed in the feature.
- NEUTRAL: reply is a question, a joke unrelated to opinion, an off-topic tangent, or simply factual.
- MIXED: reply expresses both positive and negative reactions in the same comment.

Quote a real fragment from the reply in your reason — if you can't quote anything specific, choose NEUTRAL.`;

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
        "--level",
        "fast",
        "--timeout",
        "60000",
        systemPrompt,
        userPrompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

function parseLine(raw: string): { sentiment: Sentiment; reason: string } {
  const lines = raw.split("\n");
  const line = lines.find((l) => l.startsWith("SENTIMENT:")) ?? lines[0] ?? "";
  const m = line.match(/SENTIMENT:\s*(POSITIVE|NEGATIVE|NEUTRAL|MIXED)\s*\|\s*REASON:\s*(.+)/i);
  if (!m) return { sentiment: "NEUTRAL", reason: `unparseable: ${line.slice(0, 140)}` };
  return { sentiment: (m[1] ?? "NEUTRAL").toUpperCase() as Sentiment, reason: (m[2] ?? "").trim() };
}

// Anchor check: the reason should quote at least 5 consecutive chars from the
// reply text. If not, the reason is a rubber stamp — downgrade to NEUTRAL.
function anchorMatches(reason: string, replyText: string): boolean {
  // Pull out the longest quoted substring (between quotes) from the reason
  const quoted = reason.match(/["'`]([^"'`]{5,})["'`]/);
  if (quoted && quoted[1]) {
    return replyText.toLowerCase().includes(quoted[1].toLowerCase());
  }
  // Fallback: any 8-char window in reason appears in reply
  const lower = replyText.toLowerCase();
  for (let i = 0; i + 8 <= reason.length; i++) {
    const window = reason.slice(i, i + 8).toLowerCase();
    if (window.trim().length < 6) continue;
    if (lower.includes(window)) return true;
  }
  return false;
}

async function scoreReply(featureName: string, reply: ReplyRow): Promise<ScoredReply> {
  const userPrompt = `FEATURE: ${featureName}

REPLY AUTHOR: @${reply.author}
REPLY LIKES: ${reply.likes}
REPLY TEXT:
"""
${reply.text.slice(0, 800)}
"""`;
  try {
    const raw = await ask(SYS, userPrompt);
    const { sentiment, reason } = parseLine(raw);
    const anchor = anchorMatches(reason, reply.text);
    // Fail-open: if no anchor and sentiment is strong (POS/NEG), downgrade to NEUTRAL
    const finalSentiment: Sentiment = !anchor && (sentiment === "POSITIVE" || sentiment === "NEGATIVE") ? "NEUTRAL" : sentiment;
    const finalReason = !anchor && finalSentiment === "NEUTRAL" && sentiment !== "NEUTRAL"
      ? `downgraded from ${sentiment} — no anchor match: ${reason}`
      : reason;
    return { ...reply, sentiment: finalSentiment, reason: finalReason, anchor_present: anchor };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...reply, sentiment: "NEUTRAL", reason: `classifier-error: ${msg.slice(0, 80)}`, anchor_present: false };
  }
}

function rollup(scored: ScoredReply[]): AggSentiment {
  const total = scored.length;
  let positive = 0, negative = 0, neutral = 0, mixed = 0;
  let total_likes_positive = 0, total_likes_negative = 0;
  for (const s of scored) {
    if (s.sentiment === "POSITIVE") { positive++; total_likes_positive += s.likes; }
    else if (s.sentiment === "NEGATIVE") { negative++; total_likes_negative += s.likes; }
    else if (s.sentiment === "MIXED") { mixed++; }
    else neutral++;
  }
  let dominant: Sentiment | "UNKNOWN" = "UNKNOWN";
  if (total === 0) dominant = "UNKNOWN";
  else if (positive > negative && positive > neutral) dominant = "POSITIVE";
  else if (negative > positive && negative > neutral) dominant = "NEGATIVE";
  else if (neutral > positive && neutral > negative) dominant = "NEUTRAL";
  else dominant = "MIXED";
  return { positive, negative, neutral, mixed, total, dominant, total_likes_positive, total_likes_negative };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      if (item === undefined) continue;
      out[idx] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function main() {
  if (!fs.existsSync(`${DATA}/x-replies.json`)) {
    console.error("data/x-replies.json missing — run src/harvesters/x-replies.ts first");
    process.exit(1);
  }
  const tweets: TweetRow[] = JSON.parse(fs.readFileSync(`${DATA}/x-replies.json`, "utf-8"));
  console.log(`scoring replies for ${tweets.length} tweets...`);

  const out: OutRow[] = [];
  for (const t of tweets) {
    if (!t.replies.length) {
      console.log(`  ${t.tweet_ship_id} → 0 replies (skip)`);
      out.push({
        tweet_url: t.tweet_url,
        ship_id: t.tweet_ship_id,
        ship_name: t.tweet_ship_name,
        tweet_author: t.tweet_author,
        agg: { positive: 0, negative: 0, neutral: 0, mixed: 0, total: 0, dominant: "UNKNOWN", total_likes_positive: 0, total_likes_negative: 0 },
        replies: [],
      });
      continue;
    }
    console.log(`\n${t.tweet_ship_id} → scoring ${t.replies.length} replies (feature: ${t.tweet_ship_name})`);
    const scored = await pool(t.replies, CONCURRENCY, (r) => scoreReply(t.tweet_ship_name, r));
    const agg = rollup(scored);
    console.log(`  agg: +${agg.positive} -${agg.negative} ·${agg.neutral} ~${agg.mixed} → ${agg.dominant}`);
    out.push({
      tweet_url: t.tweet_url,
      ship_id: t.tweet_ship_id,
      ship_name: t.tweet_ship_name,
      tweet_author: t.tweet_author,
      agg,
      replies: scored,
    });
  }
  fs.writeFileSync(`${DATA}/comment-sentiment.json`, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${out.length} tweets with sentiment → data/comment-sentiment.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
