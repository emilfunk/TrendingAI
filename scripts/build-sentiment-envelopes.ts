#!/usr/bin/env bun
/**
 * Build per-feature user-prompt envelopes for inline-Opus synthesis.
 * Re-uses the legacy buildPrompt logic from src/feature-sentiment.ts but
 * writes each envelope to /tmp/sentiment-envelopes/ instead of calling Sonnet.
 *
 * Output:
 *   /tmp/sentiment-envelopes/{feature_id}.txt  — the user prompt
 *
 * Invoked by the /trendingai skill workflow at Stage 4a; orchestrator (Opus 4.7
 * in the user's session) then reads each envelope and emits the JSON inline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DATA = `${process.cwd()}/data`;
const OUT_DIR = "/tmp/sentiment-envelopes";

const MAX_RESPONSE_ITEMS_PER_FEATURE = 25;
const MAX_CHARS_PER_ITEM = 600;

interface ResponseItem {
  source: string;
  author?: string;
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
  entities: string[];
  responses: ResponseItem[];
}
interface SourceItem {
  url?: string;
  title?: string;
  raw_text?: string;
  meta?: { transcript?: string; author?: string };
}

const TUTORIAL_HYPE_PATTERNS = [
  { name: "save-this", re: /\b(save this|bookmark this|send to your team|share with your team)\b/i },
  { name: "thread-cta", re: /\b(thread|🧵|🪡)\b/i },
  { name: "only-x-you-need", re: /\b(the only|only \d+|the (?:complete|definitive|ultimate)) [a-z]+ you (?:need|will ever need)\b/i },
  { name: "commands-tutorial", re: /\b\d+ (?:claude|gpt|ai|prompts?|skills?|commands?|tools?|features?|hacks?|tips?|tricks?|things|ways)\b/i },
  { name: "numbered-list", re: /(?:^|\n)\s*\d+[\.\)]\s+[A-Z]/m },
  { name: "follow-cta", re: /\b(follow (?:me )?for more|like.{0,20}follow|comment ['"]?\w+['"]? and)\b/i },
  { name: "step-by-step", re: /\b(step[- ]by[- ]step|step \d+|here'?s how)\b/i },
  { name: "drop-cta", re: /\b(drop a (?:like|comment)|drop ["']?\w+["']? below)\b/i },
];

function tutorialHypeScore(text: string): number {
  return TUTORIAL_HYPE_PATTERNS.filter((p) => p.re.test(text)).length;
}

function aggregateTutorialHype(itemsText: string[]): { dominant: boolean; hyped_items: number; total_items: number } {
  let hyped = 0;
  for (const t of itemsText) if (tutorialHypeScore(t) >= 2) hyped += 1;
  const total = itemsText.length;
  return { dominant: hyped >= 2 && hyped / Math.max(total, 1) >= 0.4, hyped_items: hyped, total_items: total };
}

const LAB_AFFILIATED = new Set([
  "bcherny", "sama", "boris", "thsottiaux", "alexalbert__", "karpathy",
  "AnthropicAI", "anthropicai", "ClaudeDevs", "claudedevs", "claudeai", "ClaudeAI",
  "OpenAI", "openai", "GeminiApp", "Google", "GoogleDeepMind", "xai", "elonmusk",
  "miramurati", "gdb", "fchollet", "demishassabis",
]);

function loadSource(name: string): SourceItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/${name}.json`, "utf-8"));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
}
function indexByUrl(items: SourceItem[]): Map<string, SourceItem> {
  const m = new Map<string, SourceItem>();
  for (const it of items) if (it.url) m.set(it.url, it);
  return m;
}
function resolveAuthor(r: ResponseItem, item: SourceItem | undefined): string {
  if (r.author && r.author.trim().length > 0) return r.author.trim();
  const ma = item?.meta?.author;
  if (ma && ma.trim().length > 0) return ma.trim();
  if (r.source === "youtube") {
    const src = item?.title ?? r.title ?? "";
    const m = src.match(/^\[([^\]]+)\]/);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}
function extractYouTubeId(url: string): string {
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? "";
}
function extractShowName(title: string): string {
  const m = title.match(/^\[([^\]]+)\]/);
  return m?.[1]?.trim() ?? "";
}

interface ReplyRow { tweet_url: string; agg: { positive: number; negative: number; neutral: number; total: number; dominant: string }; }
function loadCommentSentimentIndex(): Map<string, ReplyRow> {
  try {
    const rows: ReplyRow[] = JSON.parse(fs.readFileSync(`${DATA}/comment-sentiment.json`, "utf-8"));
    const m = new Map<string, ReplyRow>();
    for (const r of rows) {
      const id = r.tweet_url.match(/status\/(\d+)/)?.[1];
      if (id) m.set(id, r);
    }
    return m;
  } catch {
    return new Map();
  }
}
function replySignal(r: ResponseItem, idx: Map<string, ReplyRow>): string {
  if (r.source !== "x") return "";
  const id = r.url.match(/status\/(\d+)/)?.[1];
  if (!id) return "";
  const cs = idx.get(id);
  if (!cs || cs.agg.total < 5) return "";
  const total = cs.agg.total;
  const pos = (cs.agg.positive / total) * 100;
  const neg = (cs.agg.negative / total) * 100;
  const ratioed = total >= 10 && pos < 40;
  return `\n  [REPLY SIGNAL: count=${total} pos=${pos.toFixed(0)}% neg=${neg.toFixed(0)}%${ratioed ? " RATIOED" : ""}]`;
}

function buildEnvelope(
  feature: ConfirmedFeature,
  indices: Record<string, Map<string, SourceItem>>,
  csIdx: Map<string, ReplyRow>,
): { envelope: string; itemCount: number; hype: { dominant: boolean; hyped_items: number; total_items: number } } {
  const ranked = [...feature.responses].sort((a, b) => {
    const score = (m: string) => (m === "transcript" ? 3 : m === "raw_text" ? 2 : 1);
    const ds = score(b.match_in) - score(a.match_in);
    if (ds !== 0) return ds;
    return b.engagement - a.engagement;
  });
  const selected = ranked.slice(0, MAX_RESPONSE_ITEMS_PER_FEATURE);
  const items = selected.map((r) => {
    const item = indices[r.source]?.get(r.url);
    let text = "";
    if (r.match_in === "transcript" && item?.meta?.transcript) {
      const t = item.meta.transcript;
      const idx = t.toLowerCase().indexOf(r.matched_entity.toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        const end = Math.min(t.length, idx + r.matched_entity.length + 400);
        text = `[transcript window] ${t.slice(start, end)}`;
      } else {
        text = `[transcript head] ${t.slice(0, MAX_CHARS_PER_ITEM)}`;
      }
    } else {
      text = item?.raw_text ?? r.title;
    }
    return {
      author: resolveAuthor(r, item),
      source: r.source,
      text: text.slice(0, MAX_CHARS_PER_ITEM),
      engagement: r.engagement,
      url: r.url,
      is_podcast: r.source === "youtube",
      video_id: r.source === "youtube" ? extractYouTubeId(r.url) : "",
      show_name: r.source === "youtube" ? extractShowName(item?.title ?? r.title) : "",
      reply: replySignal(r, csIdx),
    };
  });

  const itemsText = items.map((it, i) => {
    const author = it.author || "(no author)";
    const affil = LAB_AFFILIATED.has(author.replace(/^@/, "")) ? " [LAB-AFFILIATED]" : "";
    const eng = typeof it.engagement === "number" ? `  (${it.engagement} eng)` : "";
    const podcast = it.is_podcast ? ` [PODCAST video_id=${it.video_id || "?"} show="${it.show_name || "unknown"}"]` : "";
    const urlLine = it.url ? `\n  URL: ${it.url}` : "";
    return `[${i + 1}] @${author}${affil} · ${it.source}${eng}${podcast}${it.reply}${urlLine}\n${it.text}`;
  }).join("\n\n");

  const hype = aggregateTutorialHype(items.map((i) => i.text));
  const hypeLine = `HYPE-DOMINANT: ${hype.dominant ? "yes" : "no"} (deterministic count: ${hype.hyped_items} of ${hype.total_items} top items match tutorial-hype regex indicators)`;

  const envelope = `FEATURE: ${feature.lab} — ${feature.title}
LAB ANCHOR URL: ${feature.url}
ENTITIES MATCHED: ${feature.entities.join(", ")}
${hypeLine}

${items.length} creator items below. Tags: [LAB-AFFILIATED] = handle works at the lab; their "praise" is internal storytelling, not validation. [PODCAST] = YT podcast/video item, generate one podcast_synth entry. [REPLY SIGNAL] = aggregated comment-sentiment on the post; pos%/neg% are reply distribution, RATIOED means high-engagement post with negative-dominant replies (contradiction signal).

${itemsText}

Synthesize per schema. Apply the rules above — especially the spade-a-spade clause when HYPE-DOMINANT is yes, the competitor-recommendation clause when a reply names a competitor, and the RATIOED clause when reply-signal contradicts post engagement.

Return JSON only.`;

  return { envelope, itemCount: items.length, hype };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const features: ConfirmedFeature[] = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const indices: Record<string, Map<string, SourceItem>> = {
    x: indexByUrl(loadSource("x")),
    tiktok: indexByUrl(loadSource("tiktok")),
    instagram: indexByUrl(loadSource("instagram")),
    youtube: indexByUrl(loadSource("youtube")),
    hn: indexByUrl(loadSource("hn")),
    reddit: indexByUrl(loadSource("reddit")),
    github: indexByUrl(loadSource("github")),
    arxiv: indexByUrl(loadSource("arxiv")),
    bluesky: indexByUrl(loadSource("bluesky")),
    frontier: indexByUrl(loadSource("frontier")),
    editorial: indexByUrl(loadSource("editorial")),
    enterprise: indexByUrl(loadSource("enterprise")),
  };
  const csIdx = loadCommentSentimentIndex();

  console.log(`built indices: ${Object.entries(indices).map(([k, m]) => `${k}=${m.size}`).join(" ")}`);

  const manifest: { feature_id: string; lab: string; title: string; envelope_path: string; item_count: number; hype: any }[] = [];
  for (const feat of features) {
    const { envelope, itemCount, hype } = buildEnvelope(feat, indices, csIdx);
    const filePath = path.join(OUT_DIR, `${feat.feature_id}.txt`);
    fs.writeFileSync(filePath, envelope);
    manifest.push({
      feature_id: feat.feature_id,
      lab: feat.lab,
      title: feat.title,
      envelope_path: filePath,
      item_count: itemCount,
      hype,
    });
    console.log(`✅ ${feat.feature_id} → ${filePath} (${itemCount} items, hype.dominant=${hype.dominant})`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "_manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`✅ wrote manifest → ${OUT_DIR}/_manifest.json`);
}

await main();
