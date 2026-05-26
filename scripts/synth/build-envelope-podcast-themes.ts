#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync } from "fs";
const DATA = `${process.cwd()}/data`;
const OUT_DIR = `${DATA}/_envelopes/podcast-themes`;
mkdirSync(OUT_DIR, { recursive: true });

const CHUNK_SIZE = 25;
const HEAD_CHARS = 700;

const yt: any[] = JSON.parse(readFileSync(`${DATA}/youtube.json`, "utf-8"));
const features: any[] = JSON.parse(readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));

const transcripts = yt.filter((it) => (it?.meta?.transcript ?? "").length > 200);
transcripts.sort((a, b) => a.url.localeCompare(b.url));

const extractShowName = (title: string): string => {
  const m = (title || "").match(/^\[([^\]]+)\]/);
  return m?.[1]?.trim() ?? "";
};
const extractYouTubeId = (url: string): string => {
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? "";
};
const extractCleanTitle = (title: string): string => {
  return (title || "").replace(/^\[[^\]]+\]\s*/, "").trim();
};

// Build exclusion list of already-confirmed features (title + entities)
const exclusions: string[] = [];
for (const f of features) {
  exclusions.push(`- ${f.title} (entities: ${(f.entities || []).join(", ")})`);
}

// Chunk transcripts
const chunks: any[][] = [];
for (let i = 0; i < transcripts.length; i += CHUNK_SIZE) chunks.push(transcripts.slice(i, i + CHUNK_SIZE));

for (let ci = 0; ci < chunks.length; ci++) {
  const chunk = chunks[ci];
  const blocks = chunk.map((t, i) => {
    const show = extractShowName(t.title);
    const videoId = extractYouTubeId(t.url);
    const cleanTitle = extractCleanTitle(t.title);
    const head = (t.meta.transcript || "").slice(0, HEAD_CHARS);
    return `[V${i + 1}] show="${show}" video_id=${videoId}
URL: ${t.url}
TITLE: ${cleanTitle}
TRANSCRIPT (first ${HEAD_CHARS} chars): ${head}`;
  }).join("\n\n");

  const envelope = `Surface 5-8 themes that are discussed by 2+ DIFFERENT podcasts in the supplied set. EXCLUDE themes that are essentially one of these already-confirmed feature launches:
${exclusions.join("\n")}

${chunk.length} podcast transcript chunks below.

${blocks}

Return JSON only matching the schema. Empty themes array acceptable if no cross-podcast convergence exists in this chunk.`;
  writeFileSync(`${OUT_DIR}/chunk-${String(ci + 1).padStart(2, "0")}.envelope.txt`, envelope);
  console.log(`  ✓ chunk-${String(ci + 1).padStart(2, "0")} · ${chunk.length} transcripts`);
}

writeFileSync(`${OUT_DIR}/_summary.json`, JSON.stringify({ chunks: chunks.length, transcripts: transcripts.length, chunk_size: CHUNK_SIZE }, null, 2));
console.log(`wrote ${chunks.length} chunk envelopes → ${OUT_DIR}/`);
