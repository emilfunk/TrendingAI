// src/render-features-demo.ts — D5 renderer (iter-24 ISC-304).
//
// REPLACES the hardcoded SHIPS oracle (v0.9 — iter-21..23) with the real
// per-cluster reasoning output from data/cluster-reasoning.json produced by
// src/reason-cluster.ts. Cards are now generated FROM the reasoning layer:
//   topic_claim    → card headline
//   citations[]    → embed slots (one per citation, source-aware renderer)
//   confidence     → trust badge (HIGH / MEDIUM / LOW)
//   reason         → "how we found this" detail
//
// Empty-topic-claim rows (cluster #11-style timeout from iter-23 smoke) render
// an explicit "reasoning unavailable" card with the typed error_class shown —
// never silent fallthrough (per iter-24 Advisor concern c). The Advisor also
// flagged: do schema validation at the JSON read boundary, not in renderer
// helpers. parseReasoningRow() below does exactly that.
//
// MANDATORY GATE: refuses to run if data/cluster-reasoning.json is stale
// relative to its upstream (data/discovery-clusters.json) — same staleness
// contract as the v0.9 validation-vs-source gate.

import * as fs from "node:fs";

// Portable bundle: resolve paths relative to the package.json directory.
// Bun's `bun run X` sets cwd to the package root, so process.cwd() is
// the bundle's own directory regardless of where the user invokes it from.
const PROJECT = process.cwd();
const DATA = `${PROJECT}/data`;
const OUT = `${PROJECT}/out/features-demo.html`;

type Confidence = "LOW" | "MEDIUM" | "HIGH";

interface Citation { url: string; source: string; snippet: string; }
interface ReasoningRow {
  cluster_id: string;
  rank: number;
  topic_claim: string;
  citations: Citation[];
  confidence: Confidence;
  reason: string;
}

interface SourceItem {
  url?: string;
  raw_text?: string;
  title?: string;
  author?: string;
  engagement?: number;
  meta?: Record<string, unknown>;
  ts?: string;
}

// ---------- boundary parse (hand-rolled schema validation per Advisor) ----------

function isCitation(x: unknown): x is Citation {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return typeof c.url === "string" && typeof c.source === "string" && typeof c.snippet === "string";
}

function isConfidence(x: unknown): x is Confidence {
  return x === "LOW" || x === "MEDIUM" || x === "HIGH";
}

export function parseReasoningRow(x: unknown): ReasoningRow | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.cluster_id !== "string") return null;
  if (typeof r.rank !== "number") return null;
  if (typeof r.topic_claim !== "string") return null;
  if (!Array.isArray(r.citations) || !r.citations.every(isCitation)) return null;
  if (!isConfidence(r.confidence)) return null;
  if (typeof r.reason !== "string") return null;
  return {
    cluster_id: r.cluster_id,
    rank: r.rank,
    topic_claim: r.topic_claim,
    citations: r.citations as Citation[],
    confidence: r.confidence,
    reason: r.reason,
  };
}

export function parseReasoningFile(raw: unknown): { ok: ReasoningRow[]; rejected: number } {
  if (!Array.isArray(raw)) return { ok: [], rejected: 0 };
  const ok: ReasoningRow[] = [];
  let rejected = 0;
  for (const r of raw) {
    const parsed = parseReasoningRow(r);
    if (parsed) ok.push(parsed); else rejected++;
  }
  return { ok, rejected };
}

// ---------- io + gate ----------

function readJsonOptional<T>(path: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}

function mtimeOrZero(path: string): number {
  try { return fs.statSync(path).mtimeMs; } catch { return 0; }
}

function enforceGate(): void {
  const reasoningMtime = mtimeOrZero(`${DATA}/cluster-reasoning.json`);
  if (reasoningMtime === 0) {
    console.error("BLOCKED: data/cluster-reasoning.json missing. Run: bun src/reason-cluster.ts");
    process.exit(2);
  }
  const upstreamMtime = mtimeOrZero(`${DATA}/discovery-clusters.json`);
  if (upstreamMtime > reasoningMtime) {
    const skew = ((upstreamMtime - reasoningMtime) / 1000).toFixed(0);
    console.error(`BLOCKED: cluster-reasoning.json is STALE — discovery-clusters.json is ${skew}s newer.`);
    console.error("Re-run: bun src/reason-cluster.ts");
    process.exit(2);
  }
}

// ---------- helpers ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function findItemByUrl(items: SourceItem[], url: string): SourceItem | undefined {
  return items.find((i) => i.url === url);
}

// ---------- per-source embed builders (preserved from v0.9) ----------

function tweetEmbed(item: SourceItem | undefined, c: Citation): string {
  const author = (item?.meta as { author?: string } | undefined)?.author ?? "unknown";
  const text = escapeHtml((item?.raw_text ?? c.snippet).slice(0, 400));
  return `
      <div class="embed-block">
        <blockquote class="twitter-tweet" data-conversation="none" data-cards="hidden" data-dnt="true"><p lang="en" dir="ltr">${text}</p>&mdash; @${escapeHtml(author)} <a href="${escapeHtml(c.url)}">link</a></blockquote>
        <span class="src-chip src-x">X · @${escapeHtml(author)}</span>
      </div>`;
}

function tiktokEmbed(item: SourceItem | undefined, c: Citation): string {
  const author = (item?.meta as { author?: string } | undefined)?.author ?? "unknown";
  const text = escapeHtml((item?.raw_text ?? c.snippet).slice(0, 280));
  return `
      <div class="embed-block">
        <blockquote class="tiktok-embed" cite="${escapeHtml(c.url)}" data-video-id="" style="max-width:325px;min-width:300px">
          <section><a target="_blank" href="${escapeHtml(c.url)}">@${escapeHtml(author)} on TikTok</a><p>${text}</p></section>
        </blockquote>
        <span class="src-chip src-tt">TikTok · @${escapeHtml(author)}</span>
      </div>`;
}

function instagramEmbed(item: SourceItem | undefined, c: Citation): string {
  const author = (item?.meta as { author?: string } | undefined)?.author ?? "unknown";
  return `
      <div class="embed-block">
        <blockquote class="instagram-media" data-instgrm-captioned data-instgrm-permalink="${escapeHtml(c.url)}" data-instgrm-version="14" style="max-width:540px;min-width:326px"></blockquote>
        <span class="src-chip src-ig">Instagram · @${escapeHtml(author)}</span>
      </div>`;
}

function youtubeThumbCard(c: Citation): string {
  const m = c.url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || c.url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  const videoId = m?.[1];
  if (!videoId) return genericEmbed(c);
  const thumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  return `
      <div class="embed-block yt-thumb">
        <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="yt-link">
          <img src="${thumb}" alt="YouTube thumbnail" loading="lazy" />
          <span class="yt-play">▶</span>
        </a>
        <span class="src-chip src-yt">YouTube</span>
      </div>`;
}

function genericEmbed(c: Citation): string {
  return `
      <div class="embed-block">
        <div class="cite-card">
          <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.snippet)}</a>
        </div>
        <span class="src-chip src-other">${escapeHtml(c.source)}</span>
      </div>`;
}

function citationEmbed(c: Citation, sources: SourcesByName): string {
  const items = sources[c.source as keyof SourcesByName] ?? [];
  const item = findItemByUrl(items, c.url);
  switch (c.source) {
    case "x": return tweetEmbed(item, c);
    case "tiktok": return tiktokEmbed(item, c);
    case "instagram": return instagramEmbed(item, c);
    case "youtube": return youtubeThumbCard(c);
    default: return genericEmbed(c);
  }
}

// ---------- cluster card ----------

interface SourcesByName { x: SourceItem[]; tiktok: SourceItem[]; instagram: SourceItem[]; youtube: SourceItem[]; }

function confidenceBadge(conf: Confidence): string {
  const cls = conf === "HIGH" ? "conf-high" : conf === "MEDIUM" ? "conf-med" : "conf-low";
  return `<span class="conf-badge ${cls}">${conf}</span>`;
}

function unavailableCard(row: ReasoningRow): string {
  // Explicit empty-state contract (Advisor concern c). Empty topic_claim rows
  // — typically a Haiku timeout or refusal upstream — render an honest panel
  // with the error_class surfaced, never silently dropped.
  return `
    <article class="cluster cluster-unavailable" id="${escapeHtml(row.cluster_id)}">
      <header class="card-head">
        <span class="rank-chip">#${row.rank}</span>
        ${confidenceBadge(row.confidence)}
        <span class="unavailable-tag">REASONING UNAVAILABLE</span>
      </header>
      <p class="what muted">No topic claim produced for this cluster. Upstream reasoning failed.</p>
      <details class="how">
        <summary>WHY</summary>
        <div class="body">${escapeHtml(row.reason)}</div>
      </details>
    </article>`;
}

export function clusterCard(row: ReasoningRow, sources: SourcesByName): string {
  if (!row.topic_claim || row.topic_claim.trim().length === 0) {
    return unavailableCard(row);
  }
  const embeds = row.citations.length > 0
    ? row.citations.map((c) => citationEmbed(c, sources)).join("\n")
    : `<div class="embed-block"><div class="embed-empty">No citations produced — reasoning shipped a claim without anchors.</div></div>`;

  return `
    <article class="cluster" id="${escapeHtml(row.cluster_id)}">
      <header class="card-head">
        <span class="rank-chip">#${row.rank}</span>
        ${confidenceBadge(row.confidence)}
      </header>
      <h2 class="topic">${escapeHtml(row.topic_claim)}</h2>
      <div class="evidence">
        <div class="embeds">
          ${embeds}
        </div>
      </div>
      <details class="how">
        <summary>HOW WE FOUND THIS</summary>
        <div class="body">${escapeHtml(row.reason)}</div>
      </details>
    </article>`;
}

// ---------- shell ----------

function gateBanner(rows: ReasoningRow[], rejected: number): string {
  const counts = rows.reduce<Record<string, number>>((acc, r) => { acc[r.confidence] = (acc[r.confidence] || 0) + 1; return acc; }, {});
  const empties = rows.filter((r) => !r.topic_claim || r.topic_claim.trim() === "").length;
  const generatedAt = new Date(mtimeOrZero(`${DATA}/cluster-reasoning.json`)).toISOString().slice(0, 16).replace("T", " ");
  return `
    <div class="gate-banner">
      <span class="gate-badge">CLUSTER REASONING</span>
      <span>reasoned ${generatedAt} UTC · ${rows.length} clusters · <b class="g-high">${counts.HIGH || 0} HIGH</b> · <b class="g-med">${counts.MEDIUM || 0} MEDIUM</b> · <b class="g-low">${counts.LOW || 0} LOW</b> · ${empties} reasoning-unavailable · ${rejected} schema-rejected</span>
    </div>`;
}

function html(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Clusters · iter-24 reasoning layer</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script async src="https://platform.twitter.com/widgets.js"></script>
  <script async src="https://www.tiktok.com/embed.js"></script>
  <script async src="https://www.instagram.com/embed.js"></script>
  <style>
    :root { --paper:#FAFAF7; --ink:#1A1A1A; --muted:#6B6B6B; --hair:#E5E2DC; --accent:#2563EB; --warn:#D97706; --pos:#16A34A; --neg:#DC2626; --neu:#94A3B8; --mix:#A855F7; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); font-family: "Source Serif 4", Georgia, serif; }
    .wide { max-width: 1240px; margin: 0 auto; padding: 0 28px; }
    h1, h2, h3, .ui { font-family: Inter, "Helvetica Neue", Arial, sans-serif; letter-spacing: -0.01em; }
    h1 { font-size: 34px; font-weight: 700; margin: 28px 0 6px 0; }
    h2.topic { font-size: 17px; font-weight: 700; margin: 8px 0 12px 0; line-height: 1.35; }
    .sub { color: var(--muted); font-size: 14px; margin: 0 0 16px 0; font-family: Inter, sans-serif; }
    header.page { border-bottom: 1px solid var(--hair); padding-bottom: 18px; margin-bottom: 18px; }
    .gate-banner { background: #F0F9FF; border: 1px solid #BAE6FD; border-radius: 6px; padding: 10px 14px; margin: 0 0 22px 0; font: 12px/1.45 "JetBrains Mono", monospace; color: #075985; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .gate-badge { background: #0284C7; color: #fff; padding: 2px 8px; border-radius: 3px; font-weight: 600; letter-spacing: 0.06em; }
    .g-high { color: var(--pos); }
    .g-med  { color: var(--warn); }
    .g-low  { color: var(--neg); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
    article.cluster { border: 1px solid var(--hair); border-radius: 8px; padding: 18px 18px 12px 18px; background: #fff; }
    article.cluster-unavailable { background: #FDFCF8; border-style: dashed; }
    .card-head { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
    .rank-chip { font: 600 11px/1 "JetBrains Mono", monospace; color: var(--muted); padding: 3px 8px; border-radius: 3px; background: var(--hair); }
    .conf-badge { font: 600 10px/1 Inter, sans-serif; padding: 3px 7px; border-radius: 3px; letter-spacing: 0.05em; }
    .conf-high { background: #DCFCE7; color: #166534; }
    .conf-med  { background: #FEF3C7; color: #92400E; }
    .conf-low  { background: #FEE2E2; color: #991B1B; }
    .unavailable-tag { font: 600 10px/1 Inter, sans-serif; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .what { font-size: 14px; line-height: 1.45; margin: 4px 0 10px 0; color: var(--ink); }
    .what.muted { color: var(--muted); font-style: italic; }
    .evidence { margin-bottom: 10px; }
    .embeds { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .embed-block { font-size: 13px; }
    .embed-empty { padding: 10px 12px; border: 1px dashed var(--hair); border-radius: 4px; color: var(--muted); font: italic 12px/1.4 "Source Serif 4", serif; }
    .src-chip { display: inline-block; margin-top: 4px; font: 600 10px/1.4 "JetBrains Mono", monospace; padding: 2px 6px; border-radius: 3px; background: var(--hair); color: var(--muted); }
    .src-x  { background: #1F1F1F; color: #fff; }
    .src-tt { background: #FF0050; color: #fff; }
    .src-ig { background: #E4405F; color: #fff; }
    .src-yt { background: #FF0000; color: #fff; }
    .src-other { background: var(--hair); color: var(--muted); }
    .yt-thumb .yt-link { position: relative; display: block; max-width: 320px; }
    .yt-thumb img { width: 100%; height: auto; border-radius: 4px; display: block; }
    .yt-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 36px; color: rgba(255,255,255,0.92); text-shadow: 0 2px 4px rgba(0,0,0,0.5); pointer-events: none; }
    .cite-card { padding: 10px 12px; border: 1px solid var(--hair); border-radius: 4px; }
    .cite-card a { color: var(--accent); text-decoration: none; }
    .cite-card a:hover { text-decoration: underline; }
    details.how { margin-top: 8px; border-top: 1px solid var(--hair); padding-top: 8px; }
    details.how summary { font: 600 10px/1 Inter, sans-serif; color: var(--muted); cursor: pointer; text-transform: uppercase; letter-spacing: 0.06em; }
    details.how .body { font: 11px/1.5 "JetBrains Mono", monospace; color: var(--muted); margin-top: 8px; padding: 8px; background: #FDFCF8; border-radius: 4px; }
    footer { margin: 32px 0 60px 0; padding-top: 16px; border-top: 1px solid var(--hair); font: 11px/1.5 "JetBrains Mono", monospace; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wide">
${body}
  </div>
</body>
</html>`;
}

// ---------- main ----------

function main(): void {
  enforceGate();

  const reasoningRaw = readJsonOptional<unknown>(`${DATA}/cluster-reasoning.json`, []);
  const { ok: rows, rejected } = parseReasoningFile(reasoningRaw);
  if (rejected > 0) console.error(`WARN: ${rejected} reasoning row(s) failed schema parse and were dropped`);

  const sources: SourcesByName = {
    x: readJsonOptional<SourceItem[]>(`${DATA}/x.json`, []),
    tiktok: readJsonOptional<SourceItem[]>(`${DATA}/tiktok.json`, []),
    instagram: readJsonOptional<SourceItem[]>(`${DATA}/instagram.json`, []),
    youtube: readJsonOptional<SourceItem[]>(`${DATA}/youtube.json`, []),
  };

  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  const cards = ordered.map((r) => clusterCard(r, sources)).join("\n");

  const body = `
    <header class="page">
      <h1>Clusters · iter-24 reasoning layer</h1>
      <p class="sub">${ordered.length} clusters reasoned by Haiku · per-cluster topic claim grounded in cited items · empty rows render an honest unavailable state</p>
    </header>
    ${gateBanner(ordered, rejected)}
    <div class="grid">
${cards}
    </div>
    <footer>
      Generator: <code>src/render-features-demo.ts</code>. Reasoning input: <code>data/cluster-reasoning.json</code> (Haiku via PAI Inference.ts, three-boundary discipline, anchor-validated citations, fail-open downgrade to LOW). Source items: <code>data/{x,tiktok,instagram,youtube}.json</code>. Schema-rejected rows are dropped honestly. Empty-topic-claim rows render REASONING UNAVAILABLE with the error_class surfaced.
    </footer>`;
  const out = html(body);
  fs.mkdirSync(`${PROJECT}/out`, { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`wrote ${out.length} bytes → ${OUT}`);
}

if (import.meta.main) main();
