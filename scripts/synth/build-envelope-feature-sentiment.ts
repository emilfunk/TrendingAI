#!/usr/bin/env bun
// Build per-feature envelope text for inline-Opus synthesis. Mirrors the
// envelope builder in src/feature-sentiment.ts (the legacy subprocess path)
// but writes the envelope to disk instead of piping to a child process.
//
// Reads:
//   data/features-confirmed.json
//   data/{x,tiktok,instagram,youtube}.json
//   data/comment-sentiment.json (optional)
//
// Writes:
//   data/_envelopes/feature-sentiment/<feature_id>.envelope.txt
//   data/_envelopes/feature-sentiment/_summary.json  (manifest of all envelopes)

import { readFileSync, writeFileSync } from "fs";

const DATA = `${process.cwd()}/data`;
const OUT_DIR = `${DATA}/_envelopes/feature-sentiment`;
const MAX_RESPONSE_ITEMS_PER_FEATURE = 25;
const MAX_CHARS_PER_ITEM = 600;

const TUTORIAL_HYPE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "save-this", re: /\b(save this|bookmark this|send to your team|share with your team)\b/i },
  { name: "thread-cta", re: /\b(thread|🧵|🪡)\b/i },
  { name: "only-x-you-need", re: /\b(the only|only \d+|the (?:complete|definitive|ultimate)) [a-z]+ you (?:need|will ever need)\b/i },
  { name: "commands-tutorial", re: /\b\d+ (?:claude|gpt|ai|prompts?|skills?|commands?|tools?|features?|hacks?|tips?|tricks?|things|ways)\b/i },
  { name: "numbered-list", re: /(?:^|\n)\s*\d+[\.\)]\s+[A-Z]/m },
  { name: "follow-cta", re: /\b(follow (?:me )?for more|like.{0,20}follow|comment ['"]?\w+['"]? and)\b/i },
  { name: "step-by-step", re: /\b(step[- ]by[- ]step|step \d+|here'?s how)\b/i },
  { name: "drop-cta", re: /\b(drop a (?:like|comment)|drop ["']?\w+["']? below)\b/i },
];

const LAB_AFFILIATED = new Set([
  "bcherny", "sama", "boris", "thsottiaux", "alexalbert__", "karpathy",
  "AnthropicAI", "anthropicai", "ClaudeDevs", "claudedevs", "claudeai", "ClaudeAI",
  "OpenAI", "openai", "GeminiApp", "Google", "GoogleDeepMind", "xai", "elonmusk",
  "miramurati", "gdb", "fchollet", "demishassabis",
]);

function tutorialHypeScore(text: string): { score: number; matched: string[] } {
  const matched: string[] = [];
  for (const p of TUTORIAL_HYPE_PATTERNS) {
    if (p.re.test(text)) matched.push(p.name);
  }
  return { score: matched.length, matched };
}

function aggregateTutorialHype(itemsText: string[]): { dominant: boolean; hyped_items: number; total_items: number } {
  let hyped = 0;
  for (const t of itemsText) if (tutorialHypeScore(t).score >= 2) hyped += 1;
  return {
    dominant: hyped >= 2 && hyped / Math.max(itemsText.length, 1) >= 0.4,
    hyped_items: hyped,
    total_items: itemsText.length,
  };
}

function loadJsonArray(path: string): any[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
}

function indexByUrl(items: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const it of items) if (it.url) m.set(it.url, it);
  return m;
}

function resolveAuthor(r: any, item: any): string {
  if (r.author && r.author.trim()) return r.author.trim();
  const metaAuthor = item?.meta?.author;
  if (metaAuthor && metaAuthor.trim()) return metaAuthor.trim();
  if (r.source === "youtube") {
    const src = item?.title ?? r.title ?? "";
    const m = src.match(/^\[([^\]]+)\]/);
    if (m && m[1]) return m[1].trim();
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

function indexCommentSentimentByStatusId(rows: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of rows) {
    const id = (r.tweet_url || "").match(/status\/(\d+)/)?.[1];
    if (id) m.set(id, r);
  }
  return m;
}

function loadCommentSentimentIndex(): Map<string, any> {
  try {
    const rows = JSON.parse(readFileSync(`${DATA}/comment-sentiment.json`, "utf-8"));
    return indexCommentSentimentByStatusId(Array.isArray(rows) ? rows : []);
  } catch {
    return new Map();
  }
}

function replySignalFor(r: any, idx: Map<string, any>): any {
  if (r.source !== "x") return undefined;
  const id = (r.url || "").match(/status\/(\d+)/)?.[1];
  if (!id) return undefined;
  const cs = idx.get(id);
  if (!cs || (cs.agg?.total ?? 0) < 5) return undefined;
  const total = cs.agg.total;
  const pos = (cs.agg.positive / total) * 100;
  const neg = (cs.agg.negative / total) * 100;
  return { count: total, positive_pct: pos, negative_pct: neg, ratioed: total >= 10 && pos < 40 };
}

function buildEnvelope(feature: any, indices: Record<string, Map<string, any>>, csIdx: Map<string, any>): { envelope: string; itemCount: number; hype: any } {
  const ranked = [...(feature.responses || [])].sort((a: any, b: any) => {
    const score = (m: string) => m === "transcript" ? 3 : m === "raw_text" ? 2 : 1;
    const ds = score(b.match_in) - score(a.match_in);
    if (ds !== 0) return ds;
    return (b.engagement || 0) - (a.engagement || 0);
  });
  const selected = ranked.slice(0, MAX_RESPONSE_ITEMS_PER_FEATURE);
  const items = selected.map((r: any) => {
    const item = indices[r.source]?.get(r.url);
    let text = "";
    if (r.match_in === "transcript" && item?.meta?.transcript) {
      const t: string = item.meta.transcript;
      const idx = t.toLowerCase().indexOf((r.matched_entity || "").toLowerCase());
      if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        const end = Math.min(t.length, idx + (r.matched_entity || "").length + 400);
        text = `[transcript window] ${t.slice(start, end)}`;
      } else {
        text = `[transcript head] ${t.slice(0, MAX_CHARS_PER_ITEM)}`;
      }
    } else {
      text = item?.raw_text ?? r.title ?? "";
    }
    const is_podcast = r.source === "youtube";
    return {
      author: resolveAuthor(r, item),
      source: r.source,
      text: (text || "").slice(0, MAX_CHARS_PER_ITEM),
      engagement: r.engagement,
      url: r.url,
      is_podcast,
      video_id: is_podcast ? extractYouTubeId(r.url) : undefined,
      show_name: is_podcast ? extractShowName(item?.title ?? r.title ?? "") : undefined,
      reply_signal: replySignalFor(r, csIdx),
    };
  });
  const hype = aggregateTutorialHype(items.map((i: any) => i.text));

  const itemsBlock = items.map((it: any, i: number) => {
    const author = it.author || "(no author)";
    const affil = LAB_AFFILIATED.has(author.replace(/^@/, "")) ? " [LAB-AFFILIATED]" : "";
    const eng = typeof it.engagement === "number" ? `  (${it.engagement} eng)` : "";
    const podcast = it.is_podcast ? ` [PODCAST video_id=${it.video_id ?? "?"} show="${it.show_name ?? "unknown"}"]` : "";
    const reply = it.reply_signal
      ? `\n  [REPLY SIGNAL: count=${it.reply_signal.count} pos=${it.reply_signal.positive_pct.toFixed(0)}% neg=${it.reply_signal.negative_pct.toFixed(0)}%${it.reply_signal.ratioed ? " RATIOED" : ""}]`
      : "";
    const urlLine = it.url ? `\n  URL: ${it.url}` : "";
    return `[${i + 1}] @${author}${affil} · ${it.source}${eng}${podcast}${reply}${urlLine}\n${it.text}`;
  }).join("\n\n");

  const hypeLine = `HYPE-DOMINANT: ${hype.dominant ? "yes" : "no"} (deterministic count: ${hype.hyped_items} of ${hype.total_items} top items match tutorial-hype regex indicators)`;
  const envelope = `FEATURE: ${feature.lab} — ${feature.title}
LAB ANCHOR URL: ${feature.url}
ENTITIES MATCHED: ${(feature.entities || []).join(", ")}
${hypeLine}

${items.length} creator items below. Tags: [LAB-AFFILIATED] = handle works at the lab; their "praise" is internal storytelling, not validation. [PODCAST] = YT podcast/video item, generate one podcast_synth entry. [REPLY SIGNAL] = aggregated comment-sentiment on the post; pos%/neg% are reply distribution, RATIOED means high-engagement post with negative-dominant replies (contradiction signal).

${itemsBlock}

Synthesize per schema. Apply the rules above — especially the spade-a-spade clause when HYPE-DOMINANT is yes, the competitor-recommendation clause when a reply names a competitor, and the RATIOED clause when reply-signal contradicts post engagement.

Return JSON only.`;
  return { envelope, itemCount: items.length, hype };
}

function main() {
  const features = JSON.parse(readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const indices: Record<string, Map<string, any>> = {
    x: indexByUrl(loadJsonArray(`${DATA}/x.json`)),
    tiktok: indexByUrl(loadJsonArray(`${DATA}/tiktok.json`)),
    instagram: indexByUrl(loadJsonArray(`${DATA}/instagram.json`)),
    youtube: indexByUrl(loadJsonArray(`${DATA}/youtube.json`)),
  };
  const csIdx = loadCommentSentimentIndex();

  const summary: any[] = [];
  for (const f of features) {
    const { envelope, itemCount, hype } = buildEnvelope(f, indices, csIdx);
    const outPath = `${OUT_DIR}/${f.feature_id}.envelope.txt`;
    writeFileSync(outPath, envelope);
    summary.push({
      feature_id: f.feature_id,
      feature_title: f.title,
      lab: f.lab,
      url: f.url,
      itemCount,
      hype,
      envelope_path: outPath,
    });
    console.log(`  ✓ ${f.feature_id} · ${itemCount} items · hype=${hype.dominant ? "YES" : "no"} (${hype.hyped_items}/${hype.total_items})`);
  }
  writeFileSync(`${OUT_DIR}/_summary.json`, JSON.stringify(summary, null, 2));
  console.log(`wrote ${summary.length} envelopes → ${OUT_DIR}/`);
}

main();
