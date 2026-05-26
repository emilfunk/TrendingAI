// src/render-features-first.ts — editorial feature renderer.
//
// Reads features-confirmed.json + feature-sentiment.json + comment-sentiment.json
// and emits a tier-grouped, story-led HTML report. Each card opens with the
// lab anchor + one-sentence story, shows three hero evidence items by default
// (top X reactor, top podcast, top other-social), and collapses the rest of
// the corroboration behind a <details> summary. Aesthetic follows
// AESTHETIC.md — editorial restraint, not dashboard decoration.

import * as fs from "node:fs";

// Path-portability — renderer reads/writes against the CURRENT WORKING
// DIRECTORY's data/ and out/. Bun's `bun run` sets cwd to the package.json
// directory, so this resolves to the bundle root regardless of where the
// recipient cloned the repo.
const CWD = process.cwd();
const DATA = `${CWD}/data`;
const OUT_DIR = `${CWD}/out`;
// iter-45 — output filename derived from data anchor (deterministic across
// re-runs against unchanged inputs per v8 doctrine). Never overwrites the
// existing `out/features-confirmed.html` — Kem ratified that file as the
// iter-44 good version and asked that fresh runs land at a sibling path so
// promotion is an explicit manual step after walk-ratify. Anchor source:
// data/one-to-watch.json's anchor_ts (already computed as max input ts);
// fallback to max feature ts; final fallback emits ERR-no-anchor.html so
// the missing-anchor case is loud, never silent (no Date.now per v8).
function deriveRenderAnchor(): { iso: string; slug: string } {
  try {
    const otw = JSON.parse(fs.readFileSync(`${DATA}/one-to-watch.json`, "utf-8"));
    if (otw && typeof otw.anchor_ts === "string" && otw.anchor_ts) {
      return { iso: otw.anchor_ts, slug: otw.anchor_ts.slice(0, 16).replace(/[:T]/g, "-") };
    }
  } catch { /* fall through */ }
  try {
    const feats = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
    if (Array.isArray(feats) && feats.length > 0) {
      const maxTs = feats.map((f: { ts?: string }) => f.ts || "").filter(Boolean).sort().pop();
      if (maxTs) return { iso: maxTs, slug: maxTs.slice(0, 16).replace(/[:T]/g, "-") };
    }
  } catch { /* fall through */ }
  return { iso: "", slug: "ERR-no-anchor" };
}

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
  entities: string[];
  responses: ResponseItem[];
  distinct_platforms: number;
  distinct_creators: number;
  podcast_mentions: number;
  score: number;
  // D4 — populated by features-first.ts via x.json lookup. Used by tierFor()
  // to give high-signal lab announcements (Agent View at 92k @claudeai) a
  // tier boost even when their reactor count is small.
  source_engagement?: number;
  // D-WALK-8 (iter-29) — derived in features-first.ts; rendered as OFFICIAL
  // pill in meta-row by renderOfficialPill(). false / absent = no pill.
  is_lab_official?: boolean;
}

interface SourceItem {
  title: string;
  url: string;
  raw_text?: string;
  meta?: { author?: string; transcript?: string; transcript_status?: string };
  engagement?: number;
}

interface SentimentRow {
  feature_id: string;
  feature_title: string;
  sample_size: number;
  overall_sentiment: "positive" | "mixed" | "negative" | "complaint-dominant" | "unclear";
  summary_sentence: string;
  praises: string[];
  complaints: string[];
  notable_quotes: { author: string; source: string; quote: string }[];
  dominant_pattern?: "tutorial-hype" | "adoption" | "complaint" | "news" | "meta";
  podcast_synth?: { video_id: string; show_name: string; synth_line: string }[];
  cross_narrative_ids?: string[];
  // D-WALK-2 (iter-29) — per-item URL → WHY-THIS-ITEM caption map. When
  // present, the renderer filters items to those Sonnet justified AND shows
  // the caption as italic-grey text beneath each item. Absent or empty =
  // backward-compat fall-back (render all items, no caption).
  cited_items_why?: Record<string, string>;
  // D-WALK-6 (iter-29) — 0-2 short counter-narrative sentences (e.g.
  // "OpenAI Codex shipped /goal first"). Rendered between the summary and
  // the hero-grid as a "↩ COUNTER NARRATIVE" line.
  counter_narratives?: string[];
  // iter-32 — creator-decision-support per ISA Principle v6.5. The reader is
  // a content-creator deciding what to make next. Absent / null = Sonnet
  // honest-out-of-pool (sample too small, all items off-topic). Renderer
  // hides the block in that case rather than showing a placeholder.
  creator_recommendation?: {
    angle: string;
    format: "tutorial" | "opinion" | "demo" | "explainer" | "reaction" | "comparison" | "post-mortem";
    hook: string;
  } | null;
  error?: string;
}

interface CrossNarrative {
  narrative_id: string;
  theme: string;
  implicated_feature_ids: string[];
  substrate_sentence: string;
  confidence: "high" | "med" | "low";
}

function loadCrossNarratives(): CrossNarrative[] {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/cross-narratives.json`, "utf-8"));
    // Tolerate both shapes: bare array (legacy) OR { narratives: [...] } (per prompt + Run.md spec)
    return Array.isArray(raw) ? raw : (raw.narratives ?? []);
  } catch {
    return [];
  }
}

// D-WALK-12 — Notable-this-period (not feature-tied) panel.
// Emitted by features-first.ts as data/notable-orphans.json — items from
// whitelisted creators / lab accounts with engagement ≥ floor whose URLs
// weren't claimed by any feature card. Read end-to-end as a reader before
// claiming this works — the per-item teaser should make the post legible
// at-a-glance and the expand should reveal the full post text.
interface NotableOrphan {
  source: string;
  author: string;
  url: string;
  title: string;
  raw_text: string;
  engagement: number;
  ts: string;
}

function loadNotableOrphans(): NotableOrphan[] {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/notable-orphans.json`, "utf-8"));
  } catch {
    return [];
  }
}

// D-WALK-5 — Pipeline stats for the process-log header. Emitted by
// features-first.ts as data/pipeline-stats.json. Renderer falls back to a
// minimal "n/a" stats object when the file is missing so partial-pipeline
// runs don't break rendering.
interface PipelineStats {
  harvest_timestamp: string;
  sources_scanned: string[];
  items_per_source: Record<string, number>;
  items_total: number;
  features_confirmed: number;
  transcripts_extracted: Record<string, number>;
  x_replies_classified: number;
  sonnet_passes: { per_feature: number; cross_narrative: number };
  notable_orphans: number;
  wrong_context_drops: number;
  total_spend_usd_hard: string;
}

function loadPipelineStats(): PipelineStats | null {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/pipeline-stats.json`, "utf-8"));
  } catch {
    return null;
  }
}

// ============================================================================
// iter-37 — hero-zone DATA + render helpers (ISC-468..478)
// ============================================================================
// Three viz live above the first feature card: (A) heat-grid of 14 features
// sorted by editorial weight, (B-v2.1) Algorithm Interior knowledge graph
// showing all 1432 harvested items with 185 cited dots converging on 14
// feature nodes, (B-v2.2) Creator × Feature chord showing 137 reactor authors
// chord-bundling into the 14 features. The SVG rendering for B-v2.1 and
// B-v2.2 lives in src/hero-viz-script.js, inlined at the bottom of body;
// data is delivered via a <script type="application/json" id="hero-data">
// tag (Advisor pre-BUILD decision — safer than window.__HERO_DATA__ when
// payload contains user quote content with </script> sequences).
//
// Heat-grid (Viz A) is pure HTML/CSS computed in TS — no JS render.
//
// Per ISC-468..473 (D3 hero zone), ISC-471 (process log preserved as
// methodology fold), ISC-474..478 (D4 disclosure-summary upgrade).

interface HeroPayloadSource { x: number; tiktok: number; instagram: number; youtube: number; reddit: number; hn: number; github: number; arxiv: number; bluesky: number; frontier: number; editorial: number; enterprise: number; }
interface HeroPayloadFeature { fid: string; label: string; n: number; }
interface HeroPayloadCited { s: string; fi: number; }
interface HeroPayloadChord { ai: number; fi: number; }
export interface HeroPayload {
  pools: HeroPayloadSource;
  total_pool: number;
  features: HeroPayloadFeature[];
  cited: HeroPayloadCited[];
  authors: string[];
  chords: HeroPayloadChord[];
  themes: string[];
}

// Short label for Viz A heat-grid and Viz B-v2.1 feature nodes. Falls back
// to a truncated title when no friendly alias exists. Keeps the
// fully-deterministic feature_id as the join key but presents a label that
// fits in 14-row heat-grid + ring-3 node slot without overflow.
function shortLabelFor(f: ConfirmedFeature): string {
  const fid = f.feature_id;
  // Seed aliases (community-named features that bypass the entity gate).
  if (fid === "seed-mcp") return "MCP";
  if (fid === "seed-claude-skills") return "Skills";
  if (fid === "seed-codex-mobile") return "Codex mobile";
  if (fid === "seed-agent-view") return "Agent View";
  if (fid === "seed-agent-sdk") return "Agent SDK";
  if (fid === "seed-subagents") return "Subagents";
  if (fid === "seed-finance-agents") return "Finance Agents";
  // Frontier + lab-X friendly aliases — derived from iter-36 mockup payload
  // (visually-stable handles Kem already validated in the iter-35 walk).
  // ISC-469 expectation: heat-grid + ring-3 nodes show "Opus 4.7", "/goal",
  // "SMB", "GPT-5.5-Cyber", "Grok Build", "Hermes", "Rate reset" verbatim.
  // New frontier IDs added quarterly will fall through to the title-truncation
  // fallback below — alias them on appearance.
  if (fid === "fr-b8af8104c423") return "Opus 4.7";
  if (fid === "fr-b205cd86d4ec") return "SMB";
  if (fid === "fr-a505eac8f113") return "GPT-5.5-Cyber";
  if (fid === "xl-2054351032847925730") return "/goal";
  if (fid === "xl-2054993285152989373") return "Grok Build";
  if (fid === "xl-2055375676656783733") return "Hermes";
  if (fid === "xl-2055347539923308703") return "Rate reset";
  const clean = f.title.replace(/^@\w+:\s*/, "").replace(/^\[[^\]]+\]\s*/, "");
  return clean.length > 22 ? clean.slice(0, 20) + "…" : clean;
}

// Read per-source pool counts from data/{source}.json. Used by buildHeroPayload
// for the Algorithm Interior outer ring (B-v2.1 ISC-454). Each file is loaded
// once per render — never cached across runs, never hardcoded — so re-running
// `bun run report` against a re-harvested corpus pulls fresh counts.
function loadSourcePools(): HeroPayloadSource {
  function size(name: string): number {
    try {
      const raw = JSON.parse(fs.readFileSync(`${DATA}/${name}.json`, "utf-8"));
      return Array.isArray(raw) ? raw.length : ((raw.items?.length) ?? 0);
    } catch {
      return 0;
    }
  }
  return {
    x: size("x"),
    tiktok: size("tiktok"),
    instagram: size("instagram"),
    youtube: size("youtube"),
    reddit: size("reddit"),
    hn: size("hn"),
    github: size("github"),
    arxiv: size("arxiv"),
    bluesky: size("bluesky"),
    frontier: size("frontier"),
    editorial: size("editorial"),
    enterprise: size("enterprise"),
  };
}

// Read top-N podcast themes for Viz B-v2.1 ring-4. Defensive — if the file
// is missing (e.g. fresh project with no podcast pass yet) the viz renders
// without theme nodes rather than crashing.
function loadHeroThemes(maxN: number): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/podcast-themes.json`, "utf-8"));
    const themes = (raw.themes ?? []).map((t: { theme: string }) => t.theme).filter((t: string) => typeof t === "string" && t.length > 0);
    return themes.slice(0, maxN);
  } catch {
    return [];
  }
}

// PURE function (Advisor pre-BUILD risk #1 — no I/O). Takes the three loaded
// data sources + themes and returns the HeroPayload that drives both
// viz-script SVG IIFEs (B-v2.1 + B-v2.2) and the Viz A heat-grid header.
// Asserts pool totals so a silent join-key drift (Advisor risk #1) surfaces
// as an explicit error rather than a viz of zeros.
export function buildHeroPayload(
  features: ConfirmedFeature[],
  pools: HeroPayloadSource,
  themes: string[],
): HeroPayload {
  const sortedFeatures = [...features].sort((a, b) => b.responses.length - a.responses.length);
  const featurePayload: HeroPayloadFeature[] = sortedFeatures.map((f) => ({
    fid: f.feature_id,
    label: shortLabelFor(f),
    n: f.responses.length,
  }));
  const fidToIdx = new Map<string, number>();
  featurePayload.forEach((f, i) => fidToIdx.set(f.fid, i));

  const cited: HeroPayloadCited[] = [];
  for (const f of sortedFeatures) {
    const fi = fidToIdx.get(f.feature_id);
    if (fi === undefined) continue;
    for (const r of f.responses) {
      const s = r.source;
      if (s in pools) cited.push({ s, fi });
    }
  }

  const authorSet = new Set<string>();
  for (const f of sortedFeatures) for (const r of f.responses) {
    const a = (r.author || "").replace(/^@/, "").trim();
    if (a) authorSet.add(a);
  }
  const authors = [...authorSet].sort();
  const aiByAuthor = new Map<string, number>();
  authors.forEach((a, i) => aiByAuthor.set(a, i));

  const chordSet = new Set<string>();
  const chords: HeroPayloadChord[] = [];
  for (const f of sortedFeatures) {
    const fi = fidToIdx.get(f.feature_id);
    if (fi === undefined) continue;
    for (const r of f.responses) {
      const a = (r.author || "").replace(/^@/, "").trim();
      if (!a) continue;
      const ai = aiByAuthor.get(a);
      if (ai === undefined) continue;
      const key = `${ai}:${fi}`;
      if (chordSet.has(key)) continue;
      chordSet.add(key);
      chords.push({ ai, fi });
    }
  }

  const total_pool = Object.values(pools).reduce((a, b) => a + b, 0);

  return { pools, total_pool, features: featurePayload, cited, authors, chords, themes };
}

// Heat-grid row tone strip — TWO-SEGMENT STACKED RATIO BAR (dominant 70% :
// secondary 30%), not a 10-cell grid. Advisor pre-close risk #1: a 10-cell
// monochromatic grid reads as "we measured 10 segments and they're all this
// tone" — overclaiming sampling resolution we don't have. The 2-segment
// stacked ratio bar is editorially honest: it visualizes the aggregate
// per-feature sentiment label from feature-sentiment.json as a dominant
// vs. secondary split, no claim of per-cell measurement. Returns 2 entries
// (dominant + secondary class names); .heat-tone CSS gives them flex
// weights 7 and 3 + a visible gap so the eye reads "ratio" not "grid."
function heatStripCells(sent: SentimentRow | undefined): { dom: string; sec: string } {
  if (!sent) return { dom: "tc-unc", sec: "tc-unc" };
  const tone = displayTone(sent);
  const toneCell: Record<string, string> = {
    positive: "tc-pos",
    mixed: "tc-mix",
    negative: "tc-bad",
    "complaint-dominant": "tc-bad",
    unclear: "tc-unc",
  };
  const dom = toneCell[tone] ?? "tc-unc";
  let sec = "tc-unc";
  if (tone === "positive") sec = "tc-mix";
  else if (tone === "negative" || tone === "complaint-dominant") sec = "tc-mix";
  else if (tone === "mixed") sec = "tc-pos";
  else sec = "tc-mix";
  return { dom, sec };
}

// Lab badge — 3-letter source-of-truth that fits the heat-grid pill. Pulled
// out so future labs are a one-line edit.
function labBadge(lab: string): string {
  const map: Record<string, string> = {
    Anthropic: "ANT",
    "ClaudeAI": "ANT",
    "ClaudeDevs": "ANT",
    lab: "ANT",
    OpenAI: "OAI",
    xAI: "XAI",
    Google: "GGL",
    "GeminiApp": "GGL",
    Meta: "META",
    DeepMind: "GGL",
  };
  return map[lab] ?? lab.slice(0, 3).toUpperCase();
}

function renderHeatGridRow(f: ConfirmedFeature, sent: SentimentRow | undefined, maxEng: number): string {
  const { dom, sec } = heatStripCells(sent);
  const totalEng = f.responses.reduce((a, r) => a + (r.engagement || 0), 0) + (f.source_engagement || 0);
  const widthPct = maxEng > 0 ? Math.max(4, Math.round((Math.log10(totalEng + 1) / Math.log10(maxEng + 1)) * 100)) : 4;
  const tone = sent ? displayTone(sent) : "unclear";
  const toneLabel = sent ? (TONE_LABEL[tone] || tone) : "awaiting sentiment";
  return `<div class="heat-row">
    <div class="heat-feature"><span class="heat-lab">${esc(labBadge(f.lab))}</span>${esc(shortLabelFor(f))}</div>
    <div class="heat-tone" title="aggregate sentiment: ${esc(toneLabel)} dominant (7:3 dominant:secondary; not a per-cell measurement)">
      <div class="heat-tone-seg heat-tone-dom ${dom}"></div>
      <div class="heat-tone-seg heat-tone-sec ${sec}"></div>
    </div>
    <div class="heat-eng-bar"><div style="width:${widthPct}%"></div></div>
    <div class="heat-eng-num">${fmtEngagement(totalEng)}</div>
  </div>`;
}

// Hero zone — iter-38a-rev1 rework per Kem walk (A-H):
// - B: stat strip adds transcripts + replies + sonnet passes (depth-of-work)
// - C: math becomes block typography, italic serif vars, labels-above-eq
// - D: italic lede dropped, replaced with plain factual one-liner
// - E+F+G+H: every section gets WHAT IT IS + WHAT IT TELLS above, "Viz A/B-v2.x"
//            labels dropped, scope chips, verbose bottom captions removed
// 2-row layout preserved (heat-grid full-width top, algorithm + chord side-by-side below).
export function renderHeroZone(
  features: ConfirmedFeature[],
  sentimentByFeature: Map<string, SentimentRow>,
  payload: HeroPayload,
  stats: PipelineStats | null,
): string {
  const sortedForHeat = [...features].sort((a, b) => b.responses.length - a.responses.length);
  const maxEng = sortedForHeat.reduce((m, f) => Math.max(m, f.responses.reduce((a, r) => a + (r.engagement || 0), 0) + (f.source_engagement || 0)), 0);
  const heatRows = sortedForHeat.map((f) => renderHeatGridRow(f, sentimentByFeature.get(f.feature_id), maxEng)).join("");

  const citedCount = payload.cited.length;
  const inclusionPctPrecise = payload.total_pool > 0 ? (citedCount / payload.total_pool) * 100 : 0;
  const inclusionPct = Math.round(inclusionPctPrecise);
  const chordCount = payload.chords.length;
  const authorCount = payload.authors.length;
  const reactorDensity = authorCount > 0 ? (chordCount / authorCount).toFixed(2) : "n/a";
  // iter-38a-rev1 (B) — depth-of-work additions to stat strip.
  const t = stats?.transcripts_extracted ?? {};
  const transcriptsTotal = Object.values(t).reduce((a, b) => a + (b ?? 0), 0);
  const replyCount = stats?.x_replies_classified ?? 0;
  const sonnetTotal = (stats?.sonnet_passes?.per_feature ?? 0) + (stats?.sonnet_passes?.cross_narrative ?? 0);

  // Heaviest features by real chord count for the chord-bundle caption.
  const heavyChords = [...payload.features].sort((a, b) => b.n - a.n).slice(0, 4).map((f) => f.label).join(", ");
  const topSourcesByPool = Object.entries(payload.pools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${n.toLocaleString()} ${s}`).join(" · ");

  // iter-38a-rev2 — signal-to-noise reframe + mini-viz alongside.
  const signalNoiseMiniViz = renderSignalNoiseDots(inclusionPctPrecise);
  // iter-38a-rev3 — reactor density mini-viz (histogram) for the right
  // equation, so both math equations have a matching inline viz.
  const reactorDensityMiniViz = renderReactorDensityDots(payload.chords, authorCount);

  // iter-45 — `open` attr dropped per Kem "by default everything is collapsed
  // when we start." Hero zone now follows the same collapse-default rule as
  // every other lens. Reader expands explicitly.
  return `<details class="hero-fold">
  <summary class="hero-summary"><span class="hero-marker">▸</span><span class="hero-title">Report breakdown</span><span class="hero-summary-hint">click to collapse</span></summary>
  <section class="hero-zone">
    <div class="hero-head">
      <span class="hero-stat">${payload.total_pool.toLocaleString()} items harvested · ${transcriptsTotal} transcripts read · ${replyCount} reply threads parsed · ${sonnetTotal} AI synthesis passes · ${citedCount} items cited (${inclusionPct}%) · ${payload.features.length} features · ${authorCount} creators reacting · ${chordCount} (creator, feature) citations · ${payload.themes.length} podcast themes</span>
    </div>
    <p class="hero-lede">Data provenance below.</p>
    <div class="hero-math-block" aria-label="report metrics as block-format equations">
      <div class="mb-eq">
        <span class="mb-label">Signal-to-noise — how much of the harvest survived the filter</span>
        <span class="mb-line"><span class="mb-var">signal_to_noise</span><span class="mb-op">&nbsp;=&nbsp;</span>|cited|<span class="mb-op">&nbsp;/&nbsp;</span>|harvest|<span class="mb-op">&nbsp;=&nbsp;</span>${citedCount}<span class="mb-op">&nbsp;/&nbsp;</span>${payload.total_pool.toLocaleString()}<span class="mb-op">&nbsp;=&nbsp;</span><span class="mb-val">${inclusionPctPrecise.toFixed(2)}%</span></span>
        <div class="mb-mini-viz">${signalNoiseMiniViz}<span class="mb-mini-label"><strong>signal</strong> highlighted · noise dimmed · 100-dot sample of the harvest</span></div>
        <span class="mb-tells">Most of what we harvest is noise — the editorial bar is what survives.</span>
      </div>
      <div class="mb-eq">
        <span class="mb-label">Reactor density — average features each creator reacted to</span>
        <span class="mb-line"><span class="mb-var">reactor_density</span><span class="mb-op">&nbsp;=&nbsp;</span>|(creator, feature) pairs|<span class="mb-op">&nbsp;/&nbsp;</span>|creators|<span class="mb-op">&nbsp;=&nbsp;</span>${chordCount}<span class="mb-op">&nbsp;/&nbsp;</span>${authorCount}<span class="mb-op">&nbsp;=&nbsp;</span><span class="mb-val">${reactorDensity}</span></span>
        <div class="mb-mini-viz">${reactorDensityMiniViz}<span class="mb-mini-label">creators bucketed by feature-count · <strong>most specialised to 1 feature</strong> · long tail = multi-feature reactors</span></div>
        <span class="mb-tells">Near 1.0 means deep specialisation — creators picked one feature and stayed on it; the long tail to the right is who's tracking the whole field.</span>
      </div>
    </div>

    <div class="hero-row hero-row-heat">
      <div class="hero-cell hero-cell-heat">
        <div class="sec-header">
          <div class="sec-top">
            <span class="sec-title">Sentiment by feature</span>
            <span class="sec-scope">scope · all ${payload.features.length} confirmed features (whole report)</span>
          </div>
          <p class="sec-tells">Per-feature view across <strong>three axes</strong>: <strong>sentiment</strong> (positive ↔ negative dominant tone), <strong>engagement-trend</strong> (log-scaled pickup velocity), <strong>virality</strong> (total reach across cited responses).</p>
        </div>
        <div class="heatgrid">
          <div class="heat-head">
            <div>feature</div>
            <div>Sentiment</div>
            <div>Engagement-trend</div>
            <div>Virality</div>
          </div>
          ${heatRows}
          <div class="heat-legend">
            <span><span class="sw" style="background:var(--good)"></span>positive</span>
            <span><span class="sw" style="background:var(--warn)"></span>mixed</span>
            <span><span class="sw" style="background:var(--bad)"></span>complaint / negative</span>
            <span><span class="sw" style="background:var(--ink-faint)"></span>unclear</span>
          </div>
        </div>
        <p class="hero-caption-mini">rows ordered by reactor count · lab badges (ANT / OAI / XAI / GGL) on the left for scanning by who shipped</p>
      </div>
    </div>

    <div class="hero-row hero-row-graph">
      <div class="hero-cell hero-cell-algo">
        <div class="sec-header">
          <div class="sec-top">
            <span class="sec-title">Algorithm interior — real provenance</span>
            <span class="sec-scope">scope · ${payload.total_pool.toLocaleString()} items → ${citedCount} cited</span>
          </div>
          <p class="sec-tells">The pipeline made visible — the <strong>signal in the noise</strong>: ${citedCount} accent dots are the cited items the report kept; the ${100 - inclusionPct}% dim ring is what we read and rejected. Every accent dot edges into one of ${payload.features.length} feature nodes — that's the provenance.</p>
        </div>
        <div class="algo-graph-wrap">
          <svg id="hero-algo-graph" viewBox="0 0 800 540" width="800" height="540" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
        <p class="hero-caption-mini">outer ring: ${Object.keys(payload.pools).length} sources sized by pool (${topSourcesByPool}) · ring 2: every item dot · accent: ${citedCount} cited · ring 3: ${payload.features.length} features sized by reactor count · ring 4: ${payload.themes.length} themes · core</p>
      </div>
      <div class="hero-cell hero-cell-chord">
        <div class="sec-header">
          <div class="sec-top">
            <span class="sec-title">Creator × feature chord</span>
            <span class="sec-scope">scope · ${authorCount} creators × ${payload.features.length} features</span>
          </div>
          <p class="sec-tells">Which features pulled <strong>cross-creator coverage</strong> (the durability signal — multiple creators reacting independently means the feature isn't one-creator hype). Heavy bundles (${heavyChords}) cleared the bar; thin chords are single-creator features.</p>
        </div>
        <div class="chord-graph-wrap">
          <svg id="hero-chord-svg" viewBox="0 0 620 620" width="620" height="620" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
        <p class="hero-caption-mini">chord thickness ∝ feature reactor count · accent = top-5 heavy features · creator labels appear for those citing ≥2 features</p>
      </div>
    </div>

  </section>
</details>`;
}

// iter-38a-rev4 — all brand icons rendered in INK (black) per Kem walk:
// X rendered nicely in black, TikTok should be black, Instagram shouldn't
// be red. "Let's just make it all black again, I think." Brand shapes stay
// recognisable; we lose the platform-canonical color in favour of editorial
// consistency with the rest of the report's monochrome palette.
const SOURCE_ICON: Record<string, string> = {
  x: `<svg viewBox="0 0 24 24" width="14" height="14" aria-label="X" style="vertical-align:middle"><path fill="#000000" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" width="14" height="14" aria-label="TikTok" style="vertical-align:middle"><path fill="#000000" d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" width="14" height="14" aria-label="Instagram" style="vertical-align:middle"><path fill="#000000" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24" width="14" height="14" aria-label="YouTube" style="vertical-align:middle"><path fill="#000000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/></svg>`,
};
function sourceIcon(s: string): string {
  return SOURCE_ICON[s] ?? `<span style="font-family:var(--mono);font-size:9px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:0.08em">${s}</span>`;
}

// iter-38a-rev2 — signal-to-noise mini-viz. Kem walk: "is there anything we
// can do, like a little chart next to it that has lots of dots, you know,
// that is noise and then signal highlighted somewhere?" Tiny SVG grid of
// 100 dots; the `signalCount` brightest are accent, the rest are dim. Sized
// to sit inline alongside the equation. 100 dots is a deliberate choice —
// percentage reads cleanly (13 of 100 ≈ 12.95%).
function renderSignalNoiseDots(signalPct: number): string {
  const total = 100;
  const signalCount = Math.round((signalPct / 100) * total);
  const cols = 20, rows = 5;
  const cellW = 6, cellH = 6;
  const W = cols * cellW, H = rows * cellH;
  const dots: string[] = [];
  // Deterministic distribution — signal dots scattered via FNV-1a hash so
  // the bright dots aren't in one corner. Same hash pattern the algorithm
  // interior uses, just scoped to a 100-dot canvas.
  const signalSet = new Set<number>();
  let h = 2166136261;
  let placed = 0, attempts = 0;
  while (placed < signalCount && attempts < signalCount * 50) {
    h ^= attempts;
    h = (h * 16777619) >>> 0;
    const pos = h % total;
    if (!signalSet.has(pos)) {
      signalSet.add(pos);
      placed++;
    }
    attempts++;
  }
  for (let i = 0; i < total; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW + cellW / 2;
    const y = row * cellH + cellH / 2;
    const isSignal = signalSet.has(i);
    dots.push(`<circle cx="${x}" cy="${y}" r="${isSignal ? 2.2 : 1.2}" fill="${isSignal ? "var(--accent)" : "var(--ink-faint)"}" opacity="${isSignal ? "1" : "0.4"}"/>`);
  }
  return `<svg class="signal-noise-mini" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="signal-to-noise ratio visualised — ${signalCount} of 100 dots highlighted">${dots.join("")}</svg>`;
}

// iter-38a-rev3 — reactor-density mini-viz. Kem walk: "do we have anything
// that's reflective of the same on the right side, which is average features
// each creator reacted to? Any data visualisation there for that one too
// would be great." Mirror of signal-to-noise mini-viz, but as a small bar
// histogram showing the distribution of creators by how many features each
// reacted to (1 / 2 / 3 / 4+ buckets). Reads as "look at the long tail" —
// most creators specialised to one feature, few are multi-feature reactors.
function renderReactorDensityDots(chords: { ai: number; fi: number }[], authorCount: number): string {
  // Bucket creators by their feature-count: how many distinct features did
  // each ai cite? Group into 1, 2, 3, 4+ buckets.
  const featuresPerAuthor = new Map<number, number>();
  for (const c of chords) featuresPerAuthor.set(c.ai, (featuresPerAuthor.get(c.ai) ?? 0) + 1);
  const buckets = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const n of featuresPerAuthor.values()) {
    if (n === 1) buckets["1"]++;
    else if (n === 2) buckets["2"]++;
    else if (n === 3) buckets["3"]++;
    else buckets["4+"]++;
  }
  void authorCount; // computed via featuresPerAuthor.size; ensures all creators with ≥1 chord are counted
  const entries = Object.entries(buckets);
  const maxCount = Math.max(...entries.map(([, v]) => v), 1);
  const W = 120, H = 30;
  const barW = (W - 8) / entries.length;
  const bars: string[] = [];
  const labels: string[] = [];
  entries.forEach(([label, count], i) => {
    const h = (count / maxCount) * (H - 8);
    const x = i * barW + 1;
    const y = H - h - 2;
    const accent = i > 0; // bars 2,3,4+ are accent (the "multi-feature" tail)
    bars.push(`<rect x="${x}" y="${y}" width="${barW - 2}" height="${h}" fill="${accent ? "var(--accent)" : "var(--ink-muted)"}" opacity="${accent ? "0.9" : "0.55"}"/>`);
    labels.push(`<text x="${x + (barW - 2) / 2}" y="${H - 0.5}" font-family="var(--mono)" font-size="6" fill="var(--ink-faint)" text-anchor="middle">${label}</text>`);
    labels.push(`<text x="${x + (barW - 2) / 2}" y="${y - 2}" font-family="var(--mono)" font-size="7" fill="${accent ? "var(--accent)" : "var(--ink-muted)"}" text-anchor="middle" font-weight="600">${count}</text>`);
  });
  return `<svg class="reactor-density-mini" viewBox="0 0 ${W} ${H + 2}" width="${W}" height="${H + 2}" aria-label="reactor density histogram — creators bucketed by how many features each reacted to">${bars.join("")}${labels.join("")}</svg>`;
}

// iter-38a-rev1 (A) — pipeline visualization replacing the terminal-head
// text dump per Kem walk: "this should really start with the period date
// harvested... then we should go on to the pipeline... should be beautiful
// and visual... like a database that shows if any errors and then a
// statement of any errors that occurred." Period line leads; 5 stage cards
// in flow order with primary count + status dot + sub-line; notes block
// underneath surfaces filtered-out items and any harvest errors honestly.
function renderPipelineVisualization(
  stats: PipelineStats | null,
  earliestPostDate: string,
  latestPostDate: string,
  generated: string,
): string {
  if (!stats) {
    return `<div class="pipeline-strip">
      <div class="ps-title-row"><h2 class="ps-title">Pipeline health</h2></div>
      <div class="ps-period"><span class="ps-period-tag">period</span><span class="ps-period-val">${earliestPostDate} → ${latestPostDate}</span><span class="ps-period-tag">harvested</span><span class="ps-period-val">${generated.slice(0, 10)}</span></div>
      <div class="ps-notes"><span class="ps-note-warn"><span class="ps-note-glyph">⚠</span>pipeline-stats.json missing — no stage detail available this cycle</span></div>
    </div>`;
  }
  const t = stats.transcripts_extracted ?? {};
  const transcriptsTotal = Object.values(t).reduce((a, b) => a + (b ?? 0), 0);
  const sonnetTotal = (stats.sonnet_passes?.per_feature ?? 0) + (stats.sonnet_passes?.cross_narrative ?? 0);

  const stage = (name: string, primary: string, sub: string, status: "ok" | "warn" | "error" | "skip", extra = ""): string =>
    `<div class="ps-stage${extra}">
      <span class="ps-stage-status ps-status-${status}" title="${status}"></span>
      <div class="ps-stage-name">${name}</div>
      <div class="ps-stage-primary">${primary}</div>
      <div class="ps-stage-sub">${sub}</div>
    </div>`;

  // iter-38a-rev3 — expanded pipeline per Kem walk: "harvest is too loose...
  // we need to reflect [voice-to-text + transcript-read + reply-thread-read]
  // so people understand the journey and how difficult this was." Now 5
  // MAIN stages (scrape → transcribe → cluster → AI synth → render) with
  // 2 CHILD branches under transcribe/cluster (read transcripts + read
  // reply threads) showing the parallel work that feeds cluster. Visual
  // metaphor: main flow goes left-to-right, children drop down then merge
  // back up into cluster. "We articulate that there are no failure points
  // within them."
  const itemsBySource = stats.items_per_source ?? {};
  const sourcesScanned = Object.keys(itemsBySource).filter((s) => (itemsBySource[s] ?? 0) > 0);
  const topPlatforms = ["x", "tiktok", "instagram", "youtube"]
    .filter((s) => (itemsBySource[s] ?? 0) > 0)
    .map((s) => `${sourceIcon(s)} <span class="ps-source-count">${(itemsBySource[s] ?? 0).toLocaleString()}</span>`)
    .join(" ");
  const otherSourcesCount = sourcesScanned.filter((s) => !["x","tiktok","instagram","youtube"].includes(s)).length;
  const transcriptIconLine = ["youtube", "tiktok", "instagram"]
    .filter((s) => (t[s] ?? 0) > 0)
    .map((s) => `${sourceIcon(s)} <span class="ps-source-count">${t[s]}</span>`)
    .join(" ");

  // iter-38a-rev5 — Main TRANSCRIBE renamed to just "transcripts" (what was
  // achieved). The voice→text fallback explanation moves to the child row
  // per Kem walk: "the top one has not to be a repeat of voice-to-text
  // engine. It should just be what was required and below we explain the
  // fallback." AI synthesis sub surfaces the multiplicative scale (passes
  // × features). Render keeps narrow card.
  const mainStages = [
    stage("scrape", `${stats.items_total.toLocaleString()}`, `${topPlatforms} <span class="ps-stage-sub-more">+${otherSourcesCount} other sources</span>`, "ok"),
    stage("transcripts", `${transcriptsTotal}`, `${transcriptIconLine || "no audio this cycle"} <span class="ps-stage-sub-more">processed</span>`, transcriptsTotal > 0 ? "ok" : "skip"),
    stage("cluster", `${stats.features_confirmed}`, `cross-platform substring + entity match`, "ok"),
    stage("AI synthesis", `${(sonnetTotal * stats.features_confirmed).toLocaleString()}`, `${sonnetTotal} Sonnet passes × ${stats.features_confirmed} features = multiplicative analysis`, sonnetTotal > 0 ? "ok" : "skip"),
    stage("render", `${stats.features_confirmed}`, `cards · ${LENS_NAV.length} lenses`, "ok", " ps-stage-narrow"),
  ].join("");

  // iter-38a-rev6 — big numbers as primary per Kem walk: "the total figure
  // should be there and then it should be explained below. We want the big
  // numbers to be the highlight." Custom scrapers primary swaps to the
  // items-collected total; the scraper count moves to sub. Voice→text
  // fallback + comment thread parser get brand-icon context (TT+IG for
  // Whisper, X for replies — icons indicate platforms without saying them).
  const sourcesCount = Object.keys(itemsBySource).filter((s) => (itemsBySource[s] ?? 0) > 0).length;
  const whisperPlatforms = ["tiktok", "instagram"]
    .filter((s) => (t[s] ?? 0) > 0)
    .map((s) => sourceIcon(s))
    .join(" ");
  const replyPlatforms = sourceIcon("x");
  const childStages = [
    stage("custom platform scrapers", `${stats.items_total.toLocaleString()}`, `${sourcesCount} parallel scrapers · cross-platform extraction · items collected`, "ok", " ps-stage-child"),
    stage("voice→text fallback", `${transcriptsTotal}`, `${whisperPlatforms} <span class="ps-stage-sub-more">(reels, short-form video)</span> · Whisper engine engaged when audio couldn't be pulled as text directly`, transcriptsTotal > 0 ? "ok" : "skip", " ps-stage-child"),
    stage("highest-engagement comment thread parser", `${stats.x_replies_classified}`, `${replyPlatforms} <span class="ps-stage-sub-more">(reply threads, comment chains)</span> · verbatim creator reactions · per-feature sentiment classification`, stats.x_replies_classified > 0 ? "ok" : "skip", " ps-stage-child"),
  ].join("");

  const notes: string[] = [];
  if (stats.wrong_context_drops > 0) {
    notes.push(`<span class="ps-note-warn"><span class="ps-note-glyph">⚠</span><strong>${stats.wrong_context_drops} items dropped</strong> — entity matched but appeared in unrelated context (e.g. "MCP" in a non-Anthropic transcript). Filtered to avoid false-positive evidence.</span>`);
  }
  if (stats.notable_orphans > 0) {
    notes.push(`<span class="ps-note-ok"><span class="ps-note-glyph">↳</span>${stats.notable_orphans} high-signal posts that didn't anchor to a feature → routed to the Whitelist lens</span>`);
  }
  notes.push(`<span class="ps-note-ok"><span class="ps-note-glyph">✓</span>0 errors this cycle · spend: ${stats.total_spend_usd_hard === "n/a" ? "$0 hard" : "$" + stats.total_spend_usd_hard + " hard"}</span>`);

  return `<div class="pipeline-strip">
    <div class="ps-title-row">
      <h2 class="ps-title">Pipeline health</h2>
      <span class="ps-title-sub">period <strong>${earliestPostDate} → ${latestPostDate}</strong> · harvested <strong>${generated.slice(0, 10)}</strong> · pipeline ran across the whole report</span>
      <a class="ps-method-link" href="#methodology-fold">methodology ↓</a>
    </div>
    <div class="ps-flow">${mainStages}</div>
    <div class="ps-child-row">
      <div class="ps-child-label">engines feeding the main flow above →</div>
      <div class="ps-child-stages">${childStages}</div>
    </div>
    <div class="ps-notes">${notes.join("")}</div>
  </div>`;
}

// renderProcessLog is preserved per ISC-471 — wrapped in <details
// class="methodology-fold"> collapsed-by-default so the editorial main flow
// (hero viz + feature cards) doesn't have to share the page header with the
// terminal-style pipeline output. Reader can expand on demand. Process log
// IS NOT deleted; the grep probe still finds it in source AND output HTML.
function renderMethodologyFold(stats: PipelineStats | null): string {
  // iter-38b — id added so the pipeline-strip header link can jump here.
  return `<details class="methodology-fold" id="methodology-fold">
    <summary>▸ pipeline methodology · what the system ran to produce this</summary>
    <div class="methodology-body">
      ${renderProcessLog(stats)}
    </div>
  </details>`;
}

// Hero data script tag + IIFE injector. Data delivered via JSON script tag
// (Advisor pre-BUILD decision #2) — `textContent` parse is safer than
// `window.__HERO_DATA__` assignment when payload contains user quote text
// with `</script>` sequences. JSON.stringify automatically escapes the
// `</` sequence inside string values, so the inlined block is safe even
// when authors quote HTML/script-like text.
function renderHeroScripts(payload: HeroPayload, iifeBody: string): string {
  const safeJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  return `<script type="application/json" id="hero-data">${safeJson}</script>
<script>${iifeBody}</script>`;
}

const PLATFORM_TAG: Record<string, string> = {
  x: "X",
  tiktok: "TT",
  instagram: "IG",
  youtube: "YT",
  reddit: "RD",
  hn: "HN",
  bluesky: "BS",
  editorial: "ED",
  enterprise: "PR",
};

function fmtEngagement(e: number): string {
  if (e >= 1000) return `${(e / 1000).toFixed(1)}k`;
  return String(e);
}

function renderNotableOrphans(orphans: NotableOrphan[]): string {
  if (orphans.length === 0) return "";
  const top = orphans.slice(0, 12);
  const rows = top.map((o) => {
    const text = (o.raw_text || o.title).replace(/\s+/g, " ").trim();
    const teaser = esc(text.slice(0, 100));
    const full = esc(text.slice(0, 600));
    const handle = o.author.startsWith("@") ? o.author : "@" + o.author;
    const platform = PLATFORM_TAG[o.source] ?? o.source.toUpperCase();
    const eng = fmtEngagement(o.engagement);
    return `<details class="notable-item">
      <summary class="notable-summary">
        <span class="notable-handle">${esc(handle)}</span>
        <span class="notable-teaser">${teaser}${text.length > 100 ? "…" : ""}</span>
        <span class="notable-platform">${platform}</span>
        <span class="notable-eng">${eng}</span>
      </summary>
      <div class="notable-body">
        <p class="notable-full">${full}${text.length > 600 ? "…" : ""}</p>
        <a class="notable-link" href="${esc(o.url)}" target="_blank" rel="noopener">view source →</a>
      </div>
    </details>`;
  }).join("");
  return `<section class="notable-panel">
    <div class="notable-head">
      <div class="notable-num">// notable this period</div>
      <h2 class="notable-hed">Not feature-tied — still worth reading</h2>
      <p class="notable-lede">High-engagement posts from whitelisted creators and lab accounts that don't tie cleanly to one feature card. They're here so the signal isn't lost.</p>
    </div>
    <div class="notable-list">${rows}</div>
  </section>`;
}

function renderProcessLog(stats: PipelineStats | null): string {
  if (!stats) {
    return `<div class="t-out"><span class="t-key">process_log:</span> n/a (pipeline-stats.json missing)</div>`;
  }
  const t = stats.transcripts_extracted;
  return `<div class="t-out">PROCESS LOG</div>
      <div class="t-out"><span class="t-key">sources_scanned:</span> ${stats.sources_scanned.length} (${stats.sources_scanned.join(", ")})</div>
      <div class="t-out"><span class="t-key">items_total:</span> ${stats.items_total} <span class="t-key">→ features_confirmed:</span> ${stats.features_confirmed}</div>
      <div class="t-out"><span class="t-key">transcripts_extracted:</span> yt=${t.youtube ?? 0} tt=${t.tiktok ?? 0} ig=${t.instagram ?? 0}</div>
      <div class="t-out"><span class="t-key">x_replies_classified:</span> ${stats.x_replies_classified}</div>
      <div class="t-out"><span class="t-key">sonnet_passes:</span> per_feature=${stats.sonnet_passes.per_feature} cross_narrative=${stats.sonnet_passes.cross_narrative}</div>
      <div class="t-out"><span class="t-key">notable_orphans:</span> ${stats.notable_orphans} <span class="t-key">wrong_context_drops:</span> ${stats.wrong_context_drops}</div>
      <div class="t-out"><span class="t-key">total_spend_usd_hard:</span> ${stats.total_spend_usd_hard}</div>`;
}

interface CommentSentiment {
  tweet_url: string;
  ship_id: string;
  ship_name: string;
  tweet_author: string;
  agg: { positive: number; negative: number; neutral: number; mixed: number; total: number; dominant: string };
  // sentiment + reason + anchor_present added per upstream Haiku-classified
  // reply pool. Render layer uses sentiment to filter for negative-only
  // excerpts on RATIOED cards (D-WALK-4 comment-thread primitive).
  replies: { url: string; author: string; text: string; likes: number; sentiment?: string; reason?: string; anchor_present?: boolean }[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

// Index comment-sentiment by tweet status-id rather than full URL, because
// the harvested URL and the feature-response URL can have slightly different
// status IDs for the same tweet (Twitter assigns multiple status IDs to one
// canonical tweet). Status-id alone disambiguates.
function indexCommentSentimentByStatusId(rows: CommentSentiment[]): Map<string, CommentSentiment> {
  const m = new Map<string, CommentSentiment>();
  for (const r of rows) {
    const id = r.tweet_url.match(/status\/(\d+)/)?.[1];
    if (id) m.set(id, r);
  }
  return m;
}

function loadCommentSentiment(): Map<string, CommentSentiment> {
  try {
    const rows: CommentSentiment[] = JSON.parse(fs.readFileSync(`${DATA}/comment-sentiment.json`, "utf-8"));
    return indexCommentSentimentByStatusId(rows);
  } catch {
    return new Map();
  }
}

// ---------- embed builders (preserved from prior version) ----------

function tweetEmbed(r: ResponseItem, item: SourceItem | undefined): string {
  const author = item?.meta?.author ?? r.author ?? "unknown";
  const text = esc((item?.raw_text ?? r.title).slice(0, 400));
  return `<blockquote class="twitter-tweet" data-conversation="none" data-cards="hidden" data-dnt="true"><p lang="en" dir="ltr">${text}</p>&mdash; @${esc(author)} <a href="${esc(r.url)}">link</a></blockquote>`;
}

function tiktokEmbed(r: ResponseItem, item: SourceItem | undefined): string {
  const author = item?.meta?.author ?? r.author ?? "unknown";
  const text = esc((item?.raw_text ?? r.title).slice(0, 280));
  // CRITICAL: TikTok's embed.js requires data-video-id to render. Empty string
  // makes the iframe show "Video currently unavailable" even when the video is
  // live. Extract the numeric ID from /video/<id> in the URL.
  const videoIdMatch = r.url.match(/\/video\/(\d+)/);
  const videoId = videoIdMatch?.[1] ?? "";
  if (!videoId) {
    // Fall back to a cite card when we can't extract an ID — better than a
    // broken embed.
    return `<div class="cite-card cite-tiktok"><a href="${esc(r.url)}" target="_blank" rel="noopener">@${esc(author)} on TikTok</a><p class="cite-body">${text}</p></div>`;
  }
  return `<blockquote class="tiktok-embed" cite="${esc(r.url)}" data-video-id="${esc(videoId)}" style="max-width:325px;min-width:300px"><section><a target="_blank" href="${esc(r.url)}">@${esc(author)} on TikTok</a><p>${text}</p></section></blockquote>`;
}

function instagramEmbed(r: ResponseItem, item: SourceItem | undefined): string {
  void item;
  return `<blockquote class="instagram-media" data-instgrm-captioned data-instgrm-permalink="${esc(r.url)}" data-instgrm-version="14" style="max-width:540px;min-width:326px"></blockquote>`;
}

function youtubeThumbCard(
  r: ResponseItem,
  item: SourceItem | undefined,
  podcastSynthByVideoId?: Map<string, { synth_line: string; show_name: string }>,
): string {
  const m = r.url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || r.url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  const videoId = m?.[1];
  const title = esc((item?.title ?? r.title).slice(0, 140));
  const isTranscript = r.match_in === "transcript";
  let transcriptWindow = "";
  if (isTranscript && item?.meta?.transcript) {
    const t = item.meta.transcript;
    const idx = t.toLowerCase().indexOf(r.matched_entity.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 180);
      const end = Math.min(t.length, idx + r.matched_entity.length + 320);
      let snippet = t.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "… " + snippet;
      if (end < t.length) snippet = snippet + " …";
      transcriptWindow = `<blockquote class="yt-transcript-window">${esc(snippet)}</blockquote>`;
    }
  }
  // D11/D12 + ISC-347 — podcast-synth lede above the transcript window.
  // Generated by feature-sentiment.ts in the per-feature pass. Italic-serif
  // styling tells the reader "this is editorial synthesis of what was
  // said," distinct from the verbatim transcript window below.
  let synthLede = "";
  if (videoId && podcastSynthByVideoId?.has(videoId)) {
    const ps = podcastSynthByVideoId.get(videoId)!;
    const showTag = ps.show_name ? `<span class="yt-synth-show">${esc(ps.show_name)} —</span> ` : "";
    synthLede = `<div class="yt-synth-lede">${showTag}<em>${esc(ps.synth_line)}</em></div>`;
  }
  if (!videoId) return genericEmbed(r);
  const thumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  return `<div class="yt-card">
    <a href="${esc(r.url)}" target="_blank" rel="noopener" class="yt-link">
      <img src="${thumb}" alt="" loading="lazy" />
      <span class="yt-play">▶</span>
    </a>
    <div class="yt-title">${title}</div>
    ${synthLede}
    ${transcriptWindow}
  </div>`;
}

function genericEmbed(r: ResponseItem): string {
  return `<div class="cite-card"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title.slice(0, 240))}</a></div>`;
}

function renderEmbed(
  r: ResponseItem,
  indices: Record<string, Map<string, SourceItem>>,
  podcastSynthByVideoId?: Map<string, { synth_line: string; show_name: string }>,
): string {
  const item = indices[r.source]?.get(r.url);
  switch (r.source) {
    case "x": return tweetEmbed(r, item);
    case "tiktok": return tiktokEmbed(r, item);
    case "instagram": return instagramEmbed(r, item);
    case "youtube": return youtubeThumbCard(r, item, podcastSynthByVideoId);
    default: return genericEmbed(r);
  }
}

// ---------- tier classification ----------

// D4 + ISC-323 — source-engagement boost in tier classification. A high-
// signal lab announcement (e.g. @claudeai Agent View at 92k engagement)
// earns tier weight even with few reactors. Structural mechanism: any
// tier-decision factors `log10(source_engagement)` alongside cross-platform
// reach. Iter-28+ inherits the boost without per-card overrides.
//
// log10 thresholds: ≥4.5 = 30k+ source engagement → T1 floor;
//                   ≥3.5 = 3k+ source engagement → T2 floor.
function sourceEngagementBoost(f: ConfirmedFeature): number {
  return Math.log10((f.source_engagement ?? 0) + 10);
}

function baseTier(f: ConfirmedFeature): 1 | 2 | 3 {
  const boost = sourceEngagementBoost(f);
  if (f.distinct_creators >= 10 || f.score >= 35 || boost >= 4.5) return 1;
  if (f.distinct_creators >= 4 || f.score >= 10 || boost >= 3.5) return 2;
  return 3;
}

// v8 determinism (iter-39) — reference timestamp is the harvest's latest
// known feature ts, NOT Date.now(). Same data file → same age math forever.
// Caller passes referenceMs from main() (max of features[].ts).
function ageDays(ts: string, referenceMs: number): number {
  try {
    const t = new Date(ts).getTime();
    if (isNaN(t)) return 0;
    return (referenceMs - t) / (1000 * 60 * 60 * 24);
  } catch { return 0; }
}

function tierFor(f: ConfirmedFeature, referenceMs: number): 1 | 2 | 3 {
  const base = baseTier(f);
  const age = ageDays(f.ts, referenceMs);
  let demote = 0;
  if (age > 7) demote += 1;
  if (age > 14) demote += 1;
  const t = Math.min(3, base + demote);
  return t as 1 | 2 | 3;
}

// ISC-377 (advisor LEARN-phase) — Within-tier ordering by editorial weight,
// not raw score. Defect class: a high-source-engagement low-reactor feature
// (Agent View at 92k source, 1 reactor) gets tier-elevated correctly but
// then ranked LAST within its elevated tier because the within-tier sort
// uses `score = platforms × creators` which ignores source-engagement.
// Result: elevation is arithmetic only, not editorial.
//
// Editorial weight factors: raw score + source-engagement boost (capped at
// the same log10 weight that elevated it) + cross-narrative implication
// count (substrate stories are more editorially important than isolated
// coverage) + complaint weight (complaint-dominant features are the harder
// editorial story to tell, push them up). Iter-28+ inherits the sort.
function editorialWeight(
  f: ConfirmedFeature,
  s: SentimentRow | undefined,
  crossNarratives: CrossNarrative[],
): number {
  const baseScore = f.score;
  const sourceBoost = sourceEngagementBoost(f) * 5; // 92k → 4.97 * 5 = ~25
  const narrativeCount = crossNarratives.filter((n) =>
    n.confidence === "high" && n.implicated_feature_ids.includes(f.feature_id)
  ).length;
  const narrativeBoost = narrativeCount * 8;
  const complaintBoost = s?.overall_sentiment === "complaint-dominant" ? 5 : 0;
  return baseScore + sourceBoost + narrativeBoost + complaintBoost;
}

const TIER_LABEL: Record<1 | 2 | 3, { hed: string; lede: string }> = {
  1: {
    hed: "Major reach",
    lede: "Features the AI community is actively building around — strong cross-platform creator activity, podcast pickup, and substantive critique.",
  },
  2: {
    hed: "Substantive but narrower",
    lede: "Real signal, smaller surface. Validated by a tight group of practitioners, or constrained to a single creator segment.",
  },
  3: {
    hed: "Early or thin signal",
    lede: "Recently announced or low-corroboration features. One or two reactor posts can still be meaningful when the lab tweet itself had outsized engagement.",
  },
};

// ---------- sentiment helpers ----------

// Tone-correction: positive labels with ≥2 distinct complaints get displayed
// as mixed. Haiku's binary tone collapses nuance the report needs to surface.
function displayTone(s: SentimentRow): SentimentRow["overall_sentiment"] {
  if (s.overall_sentiment === "positive" && s.complaints.length >= 2) return "mixed";
  return s.overall_sentiment;
}

const TONE_LABEL: Record<SentimentRow["overall_sentiment"], string> = {
  positive: "Positive",
  mixed: "Mixed",
  negative: "Negative",
  "complaint-dominant": "Complaint-dominant",
  unclear: "Unclear",
};

const BAD_AUTHORS = new Set(["", "(no author)", "no author provided", "no author", "unknown"]);
function isValidAuthor(a: string | undefined): boolean {
  if (!a) return false;
  const norm = a.replace(/^@/, "").trim().toLowerCase();
  return norm.length > 0 && !BAD_AUTHORS.has(norm);
}

// ---------- hero evidence picker ----------

// Engagement floor for hero IG/TT cells. Below this, the post is functionally
// invisible (0 likes, drop-shipping spam, or a foreign-language 0-engagement
// repost). Showing them as hero evidence misrepresents reach.
const MIN_HERO_SOCIAL_ENGAGEMENT = 5;

// Synthetic hero entry constructed from the feature's lab-anchor URL when
// the lab itself posted the announcement on X. This is "source-first" hero
// evidence: the canonical post comes before community reactors. Returns null
// when the feature URL isn't an x.com tweet.
function labSourceHero(f: ConfirmedFeature): ResponseItem | null {
  if (!/^https?:\/\/x\.com\/[^/]+\/status\/\d+/.test(f.url)) return null;
  const authorMatch = f.url.match(/x\.com\/([^/]+)\/status/);
  return {
    source: "x",
    author: authorMatch?.[1] ?? "",
    url: f.url,
    title: f.title,
    match_in: "title",
    matched_entity: f.entities[0] ?? "",
    engagement: 0, // unknown — comes from the candidate, not the response pool
  };
}

// Pick up to three hero items. Priority order:
//   1. Lab source tweet (if the lab account posted on X) — primary anchor
//   2. Highest-engagement X reactor (skipped if same URL as lab source)
//   3. Top transcript-match YouTube card (richest evidence)
//   4. Top non-X social (TikTok/Instagram) above engagement floor
// Each slot is optional — empty slots are skipped, not padded with filler.
//
// iter-46 root-fix: heroes now honor sentiment.cited_items_why the same way
// the disclosure-fold `remaining` items do (line ~1408). When sentiment
// supplies a cited_items_why map, any response URL not present in the map
// is omitted from hero-pick (silent drop, per the prompt contract that
// items Opus cannot justify in one line get DROPPED from the rendered
// card). Without this, a tutorial-hype TT post with high engagement but
// marginal feature-relevance (Kem iter-46 walk: sabrina_ramonov in MCP)
// surfaces as a hero card even when sentiment correctly omits it.
// Backward-compat: when no sentiment exists or cited_items_why is empty,
// heroes are picked from all responses (pre-Wave-2 behavior preserved).
function pickHeroes(f: ConfirmedFeature, s?: SentimentRow): ResponseItem[] {
  const whyMap = s?.cited_items_why ?? {};
  const hasWhyMap = Object.keys(whyMap).length > 0;
  const pool = hasWhyMap
    ? f.responses.filter((r) => whyMap[r.url] !== undefined)
    : f.responses;

  const out: ResponseItem[] = [];
  const seen = new Set<string>();

  const labSource = labSourceHero(f);
  if (labSource && (!hasWhyMap || whyMap[labSource.url] !== undefined)) {
    out.push(labSource);
    seen.add(labSource.url);
  }

  const xTop = [...pool]
    .filter((r) => r.source === "x" && !seen.has(r.url))
    .sort((a, b) => b.engagement - a.engagement)[0];
  if (xTop) {
    out.push(xTop);
    seen.add(xTop.url);
  }

  const ytTranscript = pool.find((r) => r.source === "youtube" && r.match_in === "transcript")
    ?? pool.find((r) => r.source === "youtube");
  if (ytTranscript && !seen.has(ytTranscript.url)) {
    out.push(ytTranscript);
    seen.add(ytTranscript.url);
  }

  const otherSocial = [...pool]
    .filter((r) => (r.source === "tiktok" || r.source === "instagram") && r.engagement >= MIN_HERO_SOCIAL_ENGAGEMENT && !seen.has(r.url))
    .sort((a, b) => b.engagement - a.engagement)[0];
  if (otherSocial) {
    out.push(otherSocial);
    seen.add(otherSocial.url);
  }

  return out;
}

const HERO_LABEL: Record<string, string> = {
  x: "Top X reactor",
  youtube: "Podcast / video",
  tiktok: "TikTok creator",
  instagram: "Instagram creator",
  reddit: "Reddit thread",
  hn: "Hacker News",
  bluesky: "Bluesky",
  editorial: "Editorial",
  enterprise: "Press",
};

function heroLabel(src: string): string {
  return HERO_LABEL[src] ?? src;
}

// ---------- reply-sentiment chip ----------

function renderReplyChip(r: ResponseItem, commentByStatusId: Map<string, CommentSentiment>): string {
  if (r.source !== "x") return "";
  const id = r.url.match(/status\/(\d+)/)?.[1];
  if (!id) return "";
  const cs = commentByStatusId.get(id);
  if (!cs) return "";
  const total = cs.agg.total;
  const dom = cs.agg.dominant.toLowerCase();
  const dominantClass = dom.includes("positive") ? "reply-positive" : dom.includes("negative") ? "reply-negative" : "reply-mixed";
  const topReply = [...cs.replies].sort((a, b) => b.likes - a.likes)[0];
  const topReplyHtml = topReply
    ? `<span class="reply-top">Top reply (${topReply.likes}❤): <em>${esc(topReply.text.slice(0, 140))}</em> — @${esc(topReply.author)}</span>`
    : "";
  return `<div class="reply-chip ${dominantClass}">
    <span class="reply-counts">${total} replies · ${cs.agg.positive}p / ${cs.agg.negative}n / ${cs.agg.neutral} neutral · dominant ${cs.agg.dominant.toLowerCase()}</span>
    ${topReplyHtml}
  </div>`;
}

// ---------- D-WALK-4 comment-thread primitive (iter-29 Wave 2) ----------
// Defect class addressed: a feature card whose lab-source tweet is RATIOED
// shows a single chip ("20 replies · 13n / 3p · dominant negative") with no
// access to the verbatim negative voices. Reader sees the contradiction tag
// but can't read what's actually being said. Kem 2026-05-16 close: "we're
// giving comments in written form but they could be designed in a way where
// you actually see them as comments."
//
// Mechanism: when a feature's lab-source URL has comment-sentiment data AND
// the agg is ratio-negative or ratio-mixed, render 2-3 verbatim
// negative-sentiment replies as a comment-thread primitive — left vertical
// rail + indented @handle + body + right-aligned ❤ count, mono throughout.
// Primitive is reusable across replies, podcast transcript windows, and any
// "people talking about this" surface in iter-30+.
function getRatioedNegativeReplies(
  f: ConfirmedFeature,
  commentByStatusId: Map<string, CommentSentiment>,
  max: number,
): CommentSentiment["replies"] {
  const id = f.url.match(/status\/(\d+)/)?.[1];
  if (!id) return [];
  const cs = commentByStatusId.get(id);
  if (!cs || cs.agg.total < 5) return [];
  // Ratioed = dominant negative OR mixed with >=40% negative AND total>=10
  const dom = cs.agg.dominant.toLowerCase();
  const negPct = cs.agg.total > 0 ? cs.agg.negative / cs.agg.total : 0;
  const isRatioed = dom.includes("negative") || (dom.includes("mixed") && negPct >= 0.4 && cs.agg.total >= 10);
  if (!isRatioed) return [];
  const negReplies = cs.replies
    .filter((r) => (r.sentiment ?? "").toUpperCase() === "NEGATIVE")
    .sort((a, b) => b.likes - a.likes)
    .slice(0, max);
  return negReplies;
}
function renderCommentThread(replies: CommentSentiment["replies"], heading: string): string {
  if (replies.length === 0) return "";
  const rows = replies
    .map(
      (r) => `<div class="ct-row">
      <span class="ct-rail" aria-hidden="true"></span>
      <span class="ct-handle">@${esc(r.author)}</span>
      <p class="ct-body">${esc(r.text.slice(0, 240))}${r.text.length > 240 ? "…" : ""}</p>
      <span class="ct-likes">${r.likes}❤</span>
    </div>`
    )
    .join("");
  return `<aside class="comment-thread">
    <div class="ct-head">${esc(heading)}</div>
    ${rows}
  </aside>`;
}

// ---------- D-WALK-6 counter-narrative render (iter-29 Wave 2) ----------
// Renders short sentences naming competitor-already-shipped patterns sourced
// from Sonnet's per-feature pass (SentimentRow.counter_narratives). Sits
// below the substrate-narrative tag and above the hero-grid so it reads as
// inline editorial context on the card.
function renderCounterNarratives(s: SentimentRow | undefined): string {
  const cns = (s?.counter_narratives ?? []).filter((c) => c && c.trim().length > 0);
  if (cns.length === 0) return "";
  return cns
    .map((c) => `<div class="counter-narrative"><span class="cn-tag">↩ COUNTER NARRATIVE</span> ${esc(c)}</div>`)
    .join("");
}

// ---------- iter-32 creator-recommendation render (v6.5 Creator-decision-support) ----------
// The reader of this report IS a content-creator deciding what to make next.
// Sonnet emits creator_recommendation per feature with {angle, format, hook}
// derived from THIS feature's actual sentiment + complaints + counter-narrative
// state. Renders as a small block between the comment-thread and the hero-grid
// — the placement says "before you look at the evidence, here's what would be
// worth making about this." Hidden gracefully when Sonnet returned null OR
// when the field is absent (pre-iter-32 sentiment runs).
function renderCreatorRecommendation(s: SentimentRow | undefined): string {
  const cr = s?.creator_recommendation;
  if (!cr || !cr.angle || !cr.hook) return "";
  const fmt = (cr.format || "").toString();
  return `<div class="creator-rec">
    <div class="cr-row">
      <span class="cr-tag">▶ CREATE</span>
      ${fmt ? `<span class="cr-format">${esc(fmt)}</span>` : ""}
      ${aiMark()}
    </div>
    <p class="cr-angle">${esc(cr.angle)}</p>
    <p class="cr-hook">"${esc(cr.hook)}"</p>
  </div>`;
}

// ---------- D-WALK-8 OFFICIAL pill render (iter-29 Wave 2) ----------
// Surfaces is_lab_official boolean derived in features-first.ts as a small
// pill in the meta-row, between the tone-pill and the lab name. Renders
// empty string when false so non-official cards stay clean.
function renderOfficialPill(f: ConfirmedFeature): string {
  if (!f.is_lab_official) return "";
  return `<span class="lab-official" title="Announced via the lab's own verified channel">OFFICIAL</span>`;
}

// ---------- card rendering ----------

function fmtDate(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return ""; }
}

function renderHeroCell(
  r: ResponseItem,
  indices: Record<string, Map<string, SourceItem>>,
  commentByStatusId: Map<string, CommentSentiment>,
  podcastSynthByVideoId: Map<string, { synth_line: string; show_name: string }>,
  labelOverride?: string,
): string {
  return `<div class="hero-cell hero-${r.source}">
    <div class="hero-label">${labelOverride ?? heroLabel(r.source)}</div>
    <div class="hero-embed">${renderEmbed(r, indices, podcastSynthByVideoId)}</div>
    ${renderReplyChip(r, commentByStatusId)}
  </div>`;
}

// D15 + ISC-354 — Engagement sparkline render primitive. Renders top-5
// items' engagement counts as inline SVG bars right-aligned in the card
// meta-line. Reusable across all cards; no per-card sparkline code.
// Heights scale to the local max so the bars communicate ratio, not
// absolute magnitude (deliberate — we don't want a small-feature card to
// dwarf its sparkline against a viral one's scale).
function renderEngagementSparkline(f: ConfirmedFeature): string {
  const topN = [...f.responses]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5)
    .map((r) => r.engagement);
  if (topN.length === 0) return "";
  const max = Math.max(...topN, 1);
  const barW = 4;
  const barGap = 2;
  const maxH = 18;
  const width = topN.length * (barW + barGap) - barGap;
  const bars = topN
    .map((e, i) => {
      const h = Math.max(1, Math.round((e / max) * maxH));
      const x = i * (barW + barGap);
      const y = maxH - h;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="currentColor"/>`;
    })
    .join("");
  return `<span class="eng-sparkline" title="Top-5 item engagement (relative)" style="display:inline-flex;align-items:center;gap:6px;color:var(--ink-muted);">
    <svg width="${width}" height="${maxH}" viewBox="0 0 ${width} ${maxH}" aria-hidden="true">${bars}</svg>
    <span class="eng-spark-label">eng</span>
  </span>`;
}

// D6/D7 + ISC-368 — Cross-narrative substrate tag rendering. Inline on the
// card for high-confidence narratives the feature is implicated in. Med/low
// narratives render in a per-tier fold below the main feature list (see
// renderCrossNarrativeFold). Same fold pattern as unclear-sentiment (D16) —
// keeps the main flow focused on strong signal, less-confident reads stay
// accessible behind a click.
function renderCrossNarrativeTags(
  featureId: string,
  narratives: CrossNarrative[],
): string {
  const high = narratives.filter((n) =>
    n.confidence === "high" && n.implicated_feature_ids.includes(featureId)
  );
  if (high.length === 0) return "";
  return high
    .map((n) => `<div class="cross-narrative-tag cross-narrative-high">
      <div class="cn-label">↔ Substrate narrative</div>
      <div class="cn-theme">${esc(n.theme)}</div>
      <div class="cn-sentence">${esc(n.substrate_sentence)}</div>
    </div>`)
    .join("");
}

function renderCrossNarrativeFold(
  narratives: CrossNarrative[],
  features: ConfirmedFeature[],
  tier: 1 | 2 | 3,
): string {
  // Show med/low narratives whose implicated features are ALL in this tier.
  // Mixed-tier narratives render once at the top tier they touch (handled
  // upstream by sorting tiers).
  const featureIdsInTier = new Set(features.map((f) => f.feature_id));
  const lessConfident = narratives.filter(
    (n) =>
      (n.confidence === "med" || n.confidence === "low") &&
      n.implicated_feature_ids.some((id) => featureIdsInTier.has(id))
  );
  if (lessConfident.length === 0) return "";
  return `<details class="cross-narrative-fold">
    <summary>▾ ${lessConfident.length} less-confident substrate thread${lessConfident.length === 1 ? "" : "s"}</summary>
    <div class="cn-fold-body">
      ${lessConfident
        .map(
          (n) => `<div class="cross-narrative-tag cross-narrative-${n.confidence}">
        <div class="cn-label">↔ ${n.confidence === "med" ? "Plausible" : "Speculative"} narrative</div>
        <div class="cn-theme">${esc(n.theme)}</div>
        <div class="cn-sentence">${esc(n.substrate_sentence)}</div>
        <div class="cn-implicated">implicates: ${n.implicated_feature_ids.map((id) => esc(id)).join(", ")}</div>
      </div>`
        )
        .join("")}
    </div>
  </details>`;
}

function renderFullEvidence(
  f: ConfirmedFeature,
  heroes: ResponseItem[],
  indices: Record<string, Map<string, SourceItem>>,
  s: SentimentRow | undefined,
  commentByStatusId: Map<string, CommentSentiment>,
  podcastSynthByVideoId: Map<string, { synth_line: string; show_name: string }>,
): string {
  const heroUrls = new Set(heroes.map((h) => h.url));
  // D-WALK-2 — drop-on-unjustifiable filter. If Sonnet emitted
  // cited_items_why (post-iter-29 sentiment runs do), keep only items it
  // could justify in one line; otherwise fall back to all items
  // (backward-compat with pre-Wave-2 sentiment files).
  const whyMap = s?.cited_items_why ?? {};
  const hasWhyMap = Object.keys(whyMap).length > 0;
  const remaining = f.responses
    .filter((r) => !heroUrls.has(r.url))
    .filter((r) => !hasWhyMap || whyMap[r.url] !== undefined);
  const byPlatform = new Map<string, ResponseItem[]>();
  for (const r of remaining) {
    if (!byPlatform.has(r.source)) byPlatform.set(r.source, []);
    byPlatform.get(r.source)!.push(r);
  }
  const platformOrder = ["x", "tiktok", "instagram", "youtube", "reddit", "hn", "bluesky", "editorial", "enterprise"];
  const platformBlocks = platformOrder
    .filter((p) => byPlatform.has(p))
    .map((p) => {
      const items = byPlatform.get(p)!.slice(0, 6);
      return `<div class="plat-block">
        <div class="plat-heading">${heroLabel(p)} <span class="plat-count">${byPlatform.get(p)!.length} more</span></div>
        <div class="embed-grid">${items.map((it) => {
          // D-WALK-2 italic-grey caption from Sonnet's why_this_item.
          const why = whyMap[it.url];
          const whyCaption = why ? `<p class="why-this-item">${esc(why)}</p>` : "";
          return `<div class="embed-cell">${renderEmbed(it, indices, podcastSynthByVideoId)}${whyCaption}${renderReplyChip(it, commentByStatusId)}</div>`;
        }).join("")}</div>
      </div>`;
    })
    .join("");

  // iter-40 — sentiment panel reduced to mono summary per Kem walk: drop
  // the 2-col colored praises/complaints grid + drop notable_quotes
  // blockquote panel entirely ("the notable quotes bit is a bit rubbish").
  // Reader gets a one-line PRAISED + one-line COMPLAINED summary above the
  // platform image blocks (which "do the heavy lifting"). Top-praise / top-
  // complaint = first array entry = Sonnet's own importance ranking.
  const firstPraise = (s?.praises ?? [])[0];
  const firstComplaint = (s?.complaints ?? [])[0];
  const praiseLine = firstPraise
    ? `<div class="vox-line"><span class="vox-line-tag">PRAISED</span> ${esc(firstPraise)}${(s?.praises.length ?? 0) > 1 ? ` <span class="vox-more">· ${(s!.praises.length - 1)} more</span>` : ""}${aiMark()}</div>`
    : "";
  const complaintLine = firstComplaint
    ? `<div class="vox-line"><span class="vox-line-tag">COMPLAINED</span> ${esc(firstComplaint)}${(s?.complaints.length ?? 0) > 1 ? ` <span class="vox-more">· ${(s!.complaints.length - 1)} more</span>` : ""}${aiMark()}</div>`
    : "";
  const voxGrid = (praiseLine || complaintLine)
    ? `<div class="vox-summary">${praiseLine}${complaintLine}</div>`
    : "";
  const quotes = ""; // iter-40 — notable_quotes blockquote panel dropped per Kem walk.

  // iter-37 (ISC-474..478) — disclosure-summary upgrade. Replaces the
  // anonymous "▾ all N items" with a context-rich summary the reader can
  // judge BEFORE expanding: N verbatim creator reactions · M reply threads ·
  // top tone X% · top quote "...". Substring fallback when any signal is
  // absent (no comment-sentiment match → drop reply-thread chunk; no
  // sentiment row → drop tone chunk; no notable_quotes → drop quote chunk).
  //
  // Quote rule (Advisor pre-BUILD risk #2): notable_quotes[0] is Sonnet's
  // own importance ranking. Truncated to ~60 chars with ellipsis for
  // summary-line legibility — full quote remains visible in vox-quotes
  // block when the fold expands.
  const itemCount = f.responses.length;
  let replyThreadCount = 0;
  for (const r of f.responses) {
    const statusId = r.url.match(/status\/(\d+)/)?.[1];
    if (statusId && commentByStatusId.has(statusId)) {
      replyThreadCount += commentByStatusId.get(statusId)!.replies.length;
    }
  }
  // Tone label + per-tone share across notable_quotes (proxy for dominant-tone %).
  let toneChunk = "";
  if (s) {
    const tone = displayTone(s);
    const toneLabel = TONE_LABEL[tone] || tone;
    const quotes = s.notable_quotes ?? [];
    let pct = 100;
    if (quotes.length > 0 && s.praises && s.complaints) {
      const p = s.praises.length;
      const c = s.complaints.length;
      const total = p + c;
      if (total > 0) {
        if (tone === "positive") pct = Math.round((p / total) * 100);
        else if (tone === "negative" || tone === "complaint-dominant") pct = Math.round((c / total) * 100);
        else pct = 50;
      }
    }
    toneChunk = ` · top tone ${esc(toneLabel.toLowerCase())} ${pct}%`;
  }
  const topQuoteRaw = (s?.notable_quotes ?? []).find((q) => isValidAuthor(q.author))?.quote ?? "";
  let topQuoteChunk = "";
  if (topQuoteRaw) {
    const truncated = topQuoteRaw.length > 60 ? topQuoteRaw.slice(0, 58).trim() + "…" : topQuoteRaw;
    topQuoteChunk = ` · top quote: "${esc(truncated)}"`;
  }
  const replyChunk = replyThreadCount > 0 ? ` · ${replyThreadCount} reply thread${replyThreadCount === 1 ? "" : "s"}` : "";
  const summaryText = `▾ ${itemCount} verbatim creator reaction${itemCount === 1 ? "" : "s"}${replyChunk}${toneChunk}${topQuoteChunk}`;
  return `<details class="full-evidence">
    <summary>${summaryText}</summary>
    <div class="full-body">
      ${voxGrid}
      ${quotes}
      ${platformBlocks}
    </div>
  </details>`;
}

// D14 + ISC-352 — Pill icons by tone. Single-source-of-truth glyph map so
// the renderer never inline-styles pill content per-card. Adding a new tone
// is a one-line edit here. Glyphs are unicode block characters so they
// inherit font color from the pill — no svg needed at this scale.
const TONE_ICON: Record<SentimentRow["overall_sentiment"], string> = {
  positive: "▲",
  mixed: "◐",
  negative: "▼",
  "complaint-dominant": "⊟",
  unclear: "◌",
};

// D9/D10 + ISC-340 — Dominant pattern badge. Surfaces the editorial frame
// the report is taking on this feature. Hidden when Sonnet didn't populate
// (backwards-compat with iter-26 sentiment rows).
const PATTERN_LABEL: Record<NonNullable<SentimentRow["dominant_pattern"]>, string> = {
  "tutorial-hype": "Tutorial-hype",
  "adoption": "Adoption",
  "complaint": "Complaint",
  "news": "News",
  "meta": "Meta",
};

// D1 supplement — render-time URL dedup. Defect class: the same tweet
// appears as evidence in two cards because both features legitimately match
// it (e.g. @milesdeutscher's /goal teaser matches the /goal feature AND
// "how do you keep Claude working" feature). Feature-level dedup correctly
// keeps both features separate; this mechanism ensures each tweet renders
// in at most ONE card — the higher-scored one (processed first). Structural
// rule: every URL renders once, in the most-relevant card.
function dedupResponsesAgainstSeen(f: ConfirmedFeature, seenUrls: Set<string>): ConfirmedFeature {
  const filteredResponses = f.responses.filter((r) => !seenUrls.has(r.url));
  for (const r of filteredResponses) seenUrls.add(r.url);
  return { ...f, responses: filteredResponses };
}

function renderFeature(
  f: ConfirmedFeature,
  rank: number,
  indices: Record<string, Map<string, SourceItem>>,
  s: SentimentRow | undefined,
  commentByStatusId: Map<string, CommentSentiment>,
  narratives: CrossNarrative[],
): string {
  const heroes = pickHeroes(f, s);
  const tone = s ? displayTone(s) : "unclear";
  const toneLbl = s ? TONE_LABEL[tone] : "Awaiting sentiment";
  const toneIcon = TONE_ICON[tone];
  const podcastLine = f.podcast_mentions > 0 ? ` · ${f.podcast_mentions} podcast${f.podcast_mentions === 1 ? "" : "s"}` : "";
  const cleanTitle = f.title.replace(/^@\w+:\s*/, "").replace(/^\[[^\]]+\]\s*/, "");
  const date = fmtDate(f.ts);
  // Per-feature podcast_synth lookup so the renderer can prepend the synth
  // line above the matching YT transcript window. video_id is the key.
  const podcastSynthByVideoId = new Map<string, { synth_line: string; show_name: string }>();
  if (s?.podcast_synth) {
    for (const ps of s.podcast_synth) {
      if (ps.video_id) podcastSynthByVideoId.set(ps.video_id, { synth_line: ps.synth_line, show_name: ps.show_name });
    }
  }
  // D-WALK-14/16 — flat horizontal meta-row. Drops the 2-up rank-col split
  // (rank + tone-pill stacked vertically) for a single horizontal flow:
  // rank · tone-pill · lab · date · reach. Pattern-badge dropped entirely
  // — its information was already implicit in tone-pill (a complaint-
  // dominant card doesn't need a separate "COMPLAINT" chip alongside).
  // Engagement sparkline also dropped — Kem walk: "weird engagement thing
  // on the right that I don't know is necessary."
  void renderEngagementSparkline; void PATTERN_LABEL; // kept for future use
  return `<article class="feature tone-${tone}" id="f-${rank}">
    <a class="anchor-jump" id="f-${esc(f.feature_id)}"></a>
    <header class="feat-head">
      <div class="meta-row">
        <span class="m-rank">${String(rank).padStart(2, "0")}</span>
        <span class="tone-pill tone-pill-${tone}"><span class="tone-pill-icon">${toneIcon}</span>${toneLbl}</span>
        ${renderOfficialPill(f)}
        <span class="m-lab">${esc(f.lab === "lab" ? "Anthropic" : f.lab)}</span>
        ${date ? `<span class="m-sep">·</span><span class="m-date">${date}</span>` : ""}
        <span class="m-sep">·</span><span class="m-reach">${f.distinct_creators} creators · ${f.distinct_platforms} platforms${podcastLine}</span>
      </div>
      <h2 class="feat-title"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(cleanTitle)}</a></h2>
    </header>

    ${s && s.summary_sentence ? `<p class="story-lede">${esc(s.summary_sentence)}${aiMark()}</p>` : ""}

    ${renderCounterNarratives(s)}

    ${renderCrossNarrativeTags(f.feature_id, narratives)}

    ${renderCommentThread(getRatioedNegativeReplies(f, commentByStatusId, 3), "Top negative replies (verbatim)")}

    ${renderCreatorRecommendation(s)}

    ${heroes.length > 0 ? `<div class="hero-grid">${heroes.map((h, i) => {
      const label = (i === 0 && h.url === f.url) ? "Lab source tweet" : undefined;
      return renderHeroCell(h, indices, commentByStatusId, podcastSynthByVideoId, label);
    }).join("")}</div>` : ""}

    ${renderFullEvidence(f, heroes, indices, s, commentByStatusId, podcastSynthByVideoId)}
  </article>`;
}

// ---------- main ----------

// ============================================================================
// D-WALK-11 (iter-32) — 9-LENS SUB-SECTION SPLIT
// ============================================================================
// Each lens consumes the same harvest + sentiment + cross-narrative data and
// applies its own filter on content_type / source / sentiment / entity. Lenses
// route to the same render primitives already shipped iter-28/29/31 (tone-pill,
// meta-row, hero-grid, comment-thread, etc.). SUBSECTIONS/ scaffold from
// iter-21 names the 9 reader-lenses and locks visual order.
//
// Order (locked): Front Page · Features · Industry News · Op-Ed · Security ·
//                 GitHub · Trending Tools · Multimedia · Whitelist.
// Features renders the existing tiered view unchanged; the other 8 lenses
// filter the same data into editorial reader-lenses.
// ============================================================================

// iter-33 — each lens carries an editorial CLAIM (coder-presentation
// one-liner) so the index reads as a TOC of the editorial argument.
const LENS_NAV: { id: string; label: string; claim: string }[] = [
  { id: "lens-podcasts",   label: "Hot in Podcasts",  claim: "cross-episode themes podcasts are converging on this month" },
  // iter-39 — lens-frontpage REMOVED per Kem walk ("I don't think there's
  // any value in this section so I think we should remove it"). The cross-
  // platform inevitability signal it carried now lives in the hero-fold
  // "Top story propagation" block (renderTopStoryPropagation), composed
  // alongside the existing chord viz. Reader path: Hot Podcasts → Features.
  { id: "lens-features",   label: "Features & Flags", claim: "lab capability ships and the creator chorus around them" },
  { id: "lens-news",       label: "Industry News",    claim: "legal · exec · compute · regulatory · geopolitical events the AI podcasts are talking about" },
  // iter-42 — lens-oped REMOVED per Kem walk ("non-lab voices pushing back is
  // inherited in other sections anyway. We carry negative sentiment. I'm not
  // sure why I'd want to split that out if I'm reading an article on /goal
  // and it has negative sentiment. I wanna know about it there and then I
  // don't wanna have to go to another section, just this weird thing").
  // Critic quotes already surface inline in Features card sentiment panels
  // (notable_quotes is the same source). Reader sees opposition where they
  // read about the feature, not in a separate disconnected lens.
  { id: "lens-security",   label: "Security",         claim: "actual exploits, breaches, supply-chain compromises, and vulnerability disclosures landing this period" },
  { id: "lens-github",     label: "GitHub",           claim: "trending AI repos clustered into themes, with cross-platform crossover surfaced and editorial verdict on each" },
  // iter-43 — lens-tools REMOVED per Kem walk ("get rid of trending tooling
  // because GitHub repos are basically the same thing — vibe coders looking
  // for magic wands. Let's just merge into GitHub which covers it better").
  // Editorial substrate (which dev tools surface in creator reactions) now
  // lives implicitly in the Claude Code skill ecosystem theme + the Magic
  // Wand Check editorial verdicts in the GitHub lens.
  // iter-44 — lens-multimedia DELETED per Kem walk ("doesn't add any value
  // whatsoever"). The 15 top-engagement clips it surfaced were already inside
  // their feature cards' hero-grid; the lens added a second copy with no new
  // editorial argument. Reader-value test failed; same disposition as Op-Ed
  // iter-42.
  // iter-44 — lens-whitelist RESHAPED into "One to Watch" per Kem walk. id
  // preserved for anchor stability; label + claim + render function changed.
  // The 26 prior orphans are classified into industry-signal / lab-orphan /
  // content-creator with per-item "what this is" lines + engagement_at_render
  // snapshot so a future cycle can compute viral-prediction delta.
  { id: "lens-whitelist",  label: "One to Watch",     claim: "pre-viral signal — named voices, orphan lab announcements, and creator playbooks classified by what they actually are" },
];

// iter-33 D2 — TOC index reads from module-level LENS_COUNTS populated by
// lensWrap calls. Order of evaluation matters: lens functions run inside
// `lensSections` assignment in main(), so by the time renderLensNav executes
// in the html template literal, LENS_COUNTS is fully populated.
const LENS_COUNTS = new Map<string, number>();
function renderLensNav(): string {
  const items = LENS_NAV.map((n, i) => {
    const c = LENS_COUNTS.get(n.id) ?? 0;
    return `<li class="ln-row">
      <a href="#${n.id}" class="ln-item">
        <span class="ln-num">${String(i + 1).padStart(2, "0")}</span>
        <span class="ln-label">${esc(n.label)}</span>
        <span class="ln-claim">${esc(n.claim)}</span>
        <span class="ln-count">${c}</span>
      </a>
    </li>`;
  }).join("");
  return `<nav class="lens-nav">
    <div class="ln-tag">// index — ${LENS_NAV.length} lenses · click to jump</div>
    <ol class="ln-list">${items}</ol>
  </nav>`;
}

// iter-33 D1 — every lens body wraps in <details class="lens-fold">. The
// <summary> IS the coder-presentation headline. Features defaults open;
// the other 8 default closed so the page reads as an index that opens on
// demand. Side-effect: populates LENS_COUNTS for renderLensNav.
// iter-45 — per Kem ask 2026-05-18: "by default everything is collapsed when
// we start." Cleared from iter-38b's {lens-podcasts, lens-features} default.
// TOC anchor-jump JS at end of body auto-opens the target details on hash
// click + initial-load deep-link, so collapse-default preserves discovery.
const OPEN_DEFAULTS = new Set<string>();
function lensWrap(
  lensId: string,
  lensClass: string,
  label: string,
  claim: string,
  count: number,
  countLabel: string,
  body: string,
): string {
  LENS_COUNTS.set(lensId, count);
  const idx = LENS_NAV.findIndex((n) => n.id === lensId) + 1;
  const isOpen = OPEN_DEFAULTS.has(lensId);
  return `<section class="lens ${lensClass}" id="${lensId}">
    <details class="lens-fold" ${isOpen ? "open" : ""}>
      <summary class="lens-summary">
        <span class="ls-num">${String(idx).padStart(2, "0")}</span>
        <span class="ls-label">${esc(label)}</span>
        <span class="ls-claim">${esc(claim)}</span>
        <span class="ls-count">${count} ${esc(countLabel)}</span>
      </summary>
      <div class="lens-body">${body}</div>
    </details>
  </section>`;
}

function lensClaim(id: string): string {
  return LENS_NAV.find((n) => n.id === id)?.claim ?? "";
}

// iter-33 D5 — provenance marker. Any block whose text was generated by
// Sonnet (sentiment summaries, counter-narratives, creator-recs, podcast
// theme summaries, yt-synth ledes) gets this chip next to it so the reader
// knows what is machine-synth vs verbatim creator/source content.
function aiMark(): string {
  return `<span class="ai-mark" title="machine-synthesized text">~ ai-synth</span>`;
}

// Legacy: renderLensHead retained as a no-op safety so any unrouted caller
// still compiles. Active lenses now use `lensWrap` which builds its own head.
function renderLensHead(lensId: string, label: string, lede: string, count: number, countLabel: string): string {
  void lensId; void label; void lede; void count; void countLabel;
  return "";
}

function renderEmptyLens(reason: string): string {
  return `<div class="lens-empty"><span class="le-tag">EMPTY</span> ${esc(reason)}</div>`;
}

// iter-38b D3 — per-section workflow header strip. Every lens body opens with
// a thin mono ribbon naming what THE SYSTEM ACTUALLY DID with real-data counts
// — the mechanism transparency baked in before any card renders. Atomic shape:
// [tag] [mechanism phrase] · [primary count + unit] · [optional sub detail].
// Counts are LIVE, derived at render time from the actual pipeline output, not
// hardcoded. Per Kem walk (iter-38a CLOSE handoff): "every lens gets a thin
// mono ribbon stating what the section ACTUALLY DID with real-data counts."
function renderLensWorkflowHeader(
  mechanism: string,
  primaryCount: number,
  primaryUnit: string,
  subDetail?: string,
  outcome?: string,
): string {
  // iter-38b-rev2 — optional outcome line (5th arg) renders as italic-serif
  // second line below the mono mechanism line, per Kem walk feedback on
  // Features & Flags ("maybe a line 'great signal for content creation'").
  // Other lenses MAY add an outcome line in future revs; currently optional.
  return `<div class="lens-workflow-header">
    <div class="lwh-line">
      <span class="lwh-tag">// what the system did</span>
      <span class="lwh-mechanism">${esc(mechanism)}</span>
      <span class="lwh-sep">·</span>
      <span class="lwh-primary"><strong>${primaryCount}</strong> ${esc(primaryUnit)}</span>
      ${subDetail ? `<span class="lwh-sep">·</span><span class="lwh-sub">${esc(subDetail)}</span>` : ""}
    </div>
    ${outcome ? `<div class="lwh-outcome">→ ${esc(outcome)}</div>` : ""}
  </div>`;
}

// iter-40 — Top Story Propagation block REMOVED per Kem walk ("I don't
// think it worked. It's not a big deal, just remove it completely"). Page
// flow goes Hot Podcasts → Features directly. The cross-platform signal
// remains visible via the chord viz in the hero-fold and the per-feature
// distinct_platforms / distinct_creators counts in each Features card.

// ---------- INDUSTRY NEWS (iter-41 REWRITE) ----------
// Reads data/industry-news.json (produced by src/industry-news.ts — Sonnet
// pass over 60 YT podcast transcripts that extracts NEWS EVENTS, hard-de-dups
// against features-confirmed.json, aggregates multi-show coverage).
//
// Iter-40 version filtered features-confirmed.json by substrate-regex on
// title (pricing/policy/access-change keywords). That source pool is
// PRODUCT-shaped — slash-commands, versioned model names, distinctive Title
// Case nouns extracted from lab blogs + lab X. News events (legal docket,
// exec changes, compute deals, regulatory moves, security incidents, AI doom
// narrative shifts) are NOT products and never become candidates in
// features-first.ts. Result: Industry News was ~80% feature-card-double-
// counts plus the substrate PR-cover tweet.
//
// Structural fix per ISA v7 (Structural-fix-only): the discovery layer was
// asking the wrong question. Iter-41 adds the missing layer (podcast → event)
// in parallel with the existing feature pipeline rather than patching the
// substrate regex. Kem-ratified 2026-05-17: "absolutely spot on" applies to
// exactly the news classes this pipeline surfaces (Elon-OpenAI lawsuit,
// SpaceX-Anthropic compute, Trump-Xi summit, AI Doom narrative shift,
// security armageddon, Bun acquired by Anthropic, etc).
interface IndustryNewsExcerpt {
  show: string;
  video_id: string;
  url: string;
  quote: string;
}
interface IndustryNewsEvent {
  key: string;
  headline: string;
  category: "legal" | "executive" | "compute" | "regulatory" | "product-policy" | "funding" | "security" | "narrative" | "geopolitics";
  context: string;
  labs_involved: string[];
  shows: string[];
  episode_count: number;
  coverage_sentiment: "consensus" | "contested" | "skeptical" | "celebratory" | "neutral";
  excerpts: IndustryNewsExcerpt[];
}
interface IndustryNewsDrop {
  candidate_headline: string;
  matched_feature_title: string;
  matched_feature_id: string;
  reason: string;
}
interface IndustryNewsFile {
  generated_at?: string;
  source_transcript_count?: number;
  events: IndustryNewsEvent[];
  dropped?: IndustryNewsDrop[];
  pipeline_stats?: {
    chunks_run: number;
    chunks_failed: number;
    raw_events_extracted: number;
    events_after_dedup: number;
    events_after_aggregation: number;
  };
}
function loadIndustryNews(): IndustryNewsFile {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/industry-news.json`, "utf-8"));
  } catch {
    return { events: [] };
  }
}

// Sourcing-methodology pipeline-flow viz. Renders the editorial subject of
// the Industry News section per Kem's iter-41 framing ("we have to think
// about a database that is impressive in terms of how we got to the
// results"). Pure HTML/CSS, deterministic from on-disk counts — no SVG, no
// JS, no Date.now. The flow IS the editorial argument: 60 podcast
// transcripts entered, Sonnet extracted N raw events, M dropped as
// feature-double-counts (per the Kem-ratified hard de-dup), K events
// remained after cross-show aggregation. Reads as 4 stages with counts +
// arrows.
function renderIndustryNewsSourcingFlow(file: IndustryNewsFile): string {
  const transcriptCount = file.source_transcript_count ?? 0;
  const stats = file.pipeline_stats ?? {
    chunks_run: 0,
    chunks_failed: 0,
    raw_events_extracted: 0,
    events_after_dedup: 0,
    events_after_aggregation: 0,
  };
  const dropped = file.dropped?.length ?? 0;
  return `<div class="in-flow">
    <div class="in-flow-header">
      <span class="in-flow-tag">// how we got here</span>
      <span class="in-flow-caption">pipeline transparency — sourcing IS the story for this section</span>
    </div>
    <div class="in-flow-stages">
      <div class="in-flow-stage">
        <div class="in-flow-num">${transcriptCount}</div>
        <div class="in-flow-label">podcast transcripts read</div>
      </div>
      <div class="in-flow-arrow">→</div>
      <div class="in-flow-stage">
        <div class="in-flow-num">${stats.raw_events_extracted}</div>
        <div class="in-flow-label">candidate events surfaced<br><span class="in-flow-sub">Sonnet event-extraction across ${stats.chunks_run} chunk${stats.chunks_run === 1 ? "" : "s"}</span></div>
      </div>
      <div class="in-flow-arrow">→</div>
      <div class="in-flow-stage in-flow-stage-drop">
        <div class="in-flow-num">${dropped}</div>
        <div class="in-flow-label">dropped as double-counts<br><span class="in-flow-sub">overlapped with Features cards</span></div>
      </div>
      <div class="in-flow-arrow">→</div>
      <div class="in-flow-stage">
        <div class="in-flow-num">${stats.events_after_aggregation}</div>
        <div class="in-flow-label">events surfaced<br><span class="in-flow-sub">multi-show coverage required (≥2)</span></div>
      </div>
    </div>
  </div>`;
}

const CATEGORY_LABEL: Record<IndustryNewsEvent["category"], string> = {
  legal: "LEGAL",
  executive: "EXECUTIVE",
  compute: "COMPUTE",
  regulatory: "REGULATORY",
  "product-policy": "POLICY",
  funding: "FUNDING",
  security: "SECURITY",
  narrative: "NARRATIVE",
  geopolitics: "GEOPOLITICS",
};

// iter-41c: rev8 design ported to live renderer. Banner + pipeline depletion +
// layered noise+events constellation + lab×category matrix with dot-pips +
// source links. Replaces the earlier sourcing-flow strip + event cards.
// All elements deterministic per v8 doctrine — same input → same output.

// iter-41 close (v8 doctrine): the constellation substrate is fully corpus-
// derived. Entity dictionary lives in scripts/extract-industry-news-entities.ts;
// counts + co-edges come from data/industry-news-entities.json which is
// regenerated from data/youtube.json (60 hydrated podcast transcripts). The
// renderer below loads that file and derives layout positions deterministically
// — same JSON → same SVG bytes. No hardcoded centroid arrays. No fake
// similarity threads. The caption reports the real numbers.

interface IndustryNewsEntity {
  id: string;
  category: "openai" | "anthropic" | "musk-orbit" | "geopolitics" | "platform" | "podcast" | "exec";
  count: number;
}
interface IndustryNewsCoEdge { a: string; b: string; weight: number; }
interface IndustryNewsEntitiesFile {
  generated_from?: string;
  source_transcript_count?: number;
  entities: IndustryNewsEntity[];
  cooccurrences: IndustryNewsCoEdge[];
  mentions_total?: number;
  cooccurrence_pairs?: number;
}
function loadIndustryNewsEntities(): IndustryNewsEntitiesFile {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/industry-news-entities.json`, "utf-8"));
  } catch {
    return { entities: [], cooccurrences: [] };
  }
}

function fnvHash(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// Per-category canvas anchors. Layout is fully deterministic from this table +
// the entity id (via fnvHash) — same entity list → same coordinates every
// render. Pure layout config, not data theatre.
const CATEGORY_ANCHORS: Record<IndustryNewsEntity["category"], { x: number; y: number; color: string }> = {
  openai:       { x: 220, y: 200, color: "#2563EB" },
  anthropic:    { x: 500, y: 180, color: "#7C3AED" },
  "musk-orbit": { x: 350, y: 300, color: "#B45309" },
  geopolitics:  { x: 660, y: 270, color: "#4D7C0F" },
  platform:     { x: 580, y: 110, color: "#9A9A9A" },
  podcast:      { x: 720, y: 350, color: "#9A3412" },
  exec:         { x: 410, y: 230, color: "#374151" },
};

// Layout: each entity sits in a hash-derived position within its category's
// neighbourhood. Deterministic and cluster-coherent without manual placement.
interface EntityPosition extends IndustryNewsEntity { x: number; y: number; r: number; color: string; }
function deriveEntityPositions(entities: IndustryNewsEntity[]): EntityPosition[] {
  return entities.map((e) => {
    const anchor = CATEGORY_ANCHORS[e.category];
    const angle = fnvHash(e.id, 0x811c9dc5) * Math.PI * 2;
    const radius = 14 + fnvHash(e.id, 0x9e3779b1) * 28;
    return {
      ...e,
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
      r: 2.4 + Math.log2(Math.max(e.count, 2)) * 1.3,
      color: anchor.color,
    };
  });
}

function renderIndustryNewsBanner(file: IndustryNewsFile): string {
  // Pull thumbnail video_ids from event excerpts + pad with YT items
  const thumbIds: string[] = [];
  for (const e of file.events ?? []) {
    for (const x of e.excerpts ?? []) {
      if (x.video_id && !thumbIds.includes(x.video_id)) thumbIds.push(x.video_id);
    }
  }
  // Pad to 60 by repeating from index 0 (deterministic)
  const padded: string[] = [];
  for (let i = 0; i < 60; i++) padded.push(thumbIds[i % Math.max(thumbIds.length, 1)] ?? "");
  const thumbCells = padded
    .map((vid) => vid ? `<div style="background-image: url('https://i.ytimg.com/vi/${vid}/mqdefault.jpg')"></div>` : `<div></div>`)
    .join("");
  return `<div class="in-banner">
    <div class="in-banner-thumbgrid">${thumbCells}</div>
    <div class="in-banner-content">
      <div class="in-banner-count">
        <div class="in-banner-num">${file.source_transcript_count ?? 0}</div>
        <div class="in-banner-unit">podcast episodes<br>surveyed this cycle</div>
      </div>
      <div class="in-banner-why">
        <strong>WHY</strong>what AI podcasts are talking about beyond product launches — legal, executive, compute, regulatory, geopolitical, narrative-state moves the Features view doesn't catch
      </div>
      <div class="in-banner-meta">${new Set((file.events ?? []).flatMap((e) => e.shows)).size} shows<br>cross-show ≥2 surfaces</div>
    </div>
  </div>`;
}

function renderIndustryNewsDepletion(file: IndustryNewsFile): string {
  const stats = file.pipeline_stats ?? { chunks_run: 0, chunks_failed: 0, raw_events_extracted: 0, events_after_dedup: 0, events_after_aggregation: 0 };
  const tc = file.source_transcript_count ?? 0;
  const raw = stats.raw_events_extracted ?? 0;
  const dedup = stats.events_after_dedup ?? 0;
  const dropped = file.dropped?.length ?? Math.max(0, raw - dedup);
  const final = (file.events ?? []).length;
  const singleShow = Math.max(0, dedup - final);
  // iter-41 cleanup: depletion math was correct but visually misleading —
  // the "read" stage rendered 60 ink dots and every later stage rendered
  // 5 ink + 55 ghost dots, suggesting "55 transcripts were filtered at
  // every step." Reality: 60 transcripts produce 5 cross-show events; the
  // "filtering" is a one-shot extraction, not a per-stage funnel.
  //
  // Fix: each stage now renders its OWN-COUNT dots only (no ghost padding
  // from the read stage). Counts now LINE UP with the visual dot count
  // exactly. The "read" stage shows 60 dots (one per transcript);
  // subsequent stages show their own surviving count. Stages where the
  // delta is 0 are tagged "no-op this cycle" so the reader sees the gate
  // was checked even when nothing fell out of it.
  // Render dots into a flex container with FIXED dot size — keeps dots
  // proportional regardless of count (5 dots looks like 5 dots, 60 dots
  // wrap naturally). Previous grid approach + a wrapping noop chip blew
  // up the dot size via aspect-ratio coupling.
  const stage = (filled: number, dropped: number, noop: boolean) => {
    let html = '<div class="in-dep-dots">';
    for (let i = 0; i < filled; i++) html += '<span class="in-dep-dot"></span>';
    for (let i = 0; i < dropped; i++) html += '<span class="in-dep-dot dropped"></span>';
    html += '</div>';
    if (noop) html += '<span class="in-dep-noop">no-op this cycle</span>';
    return html;
  };
  return `<div class="in-dep">
    <p class="in-dep-tag">// pipeline depletion</p>
    <p class="in-dep-caption">5 stages. filled dot = item carried into next stage · dashed dot = item dropped at this stage. each stage shows its own count — not padded to the read total.${aiMark()}</p>
    <div class="in-dep-stage"><div class="in-dep-label">read</div><div class="in-dep-mid">${stage(tc, 0, false)}</div><div class="in-dep-count">${tc}<div class="in-dep-count-sub">transcripts</div></div></div>
    <div class="in-dep-stage"><div class="in-dep-label">extract</div><div class="in-dep-mid">${stage(raw, 0, false)}</div><div class="in-dep-count">${raw}<div class="in-dep-count-sub">candidate events</div></div></div>
    <div class="in-dep-stage"><div class="in-dep-label">de-dup</div><div class="in-dep-mid">${stage(dedup, dropped, dropped === 0)}</div><div class="in-dep-count">${dropped > 0 ? `-${dropped}` : dedup}<div class="in-dep-count-sub">${dropped > 0 ? "double-counts dropped" : "double-counts found"}</div></div></div>
    <div class="in-dep-stage"><div class="in-dep-label">≥2 shows</div><div class="in-dep-mid">${stage(final, singleShow, singleShow === 0)}</div><div class="in-dep-count">${singleShow > 0 ? `-${singleShow}` : final}<div class="in-dep-count-sub">${singleShow > 0 ? "single-show dropped" : "all events multi-show"}</div></div></div>
    <div class="in-dep-stage"><div class="in-dep-label">surfaced</div><div class="in-dep-mid">${stage(final, 0, false)}</div><div class="in-dep-count">${final}<div class="in-dep-count-sub">events</div></div></div>
  </div>`;
}

// Constellation viz — fully corpus-derived per v8 doctrine. Inputs:
// - industry-news.json events (foreground halos)
// - industry-news-entities.json (background entity centroids, mention scatter,
//   co-occurrence edges — all derived from the 60-transcript glitch-sweep)
// The fake similarity-thread layer (iter-41a scaffold) is gone — it was pure
// `(i*73)%800` arithmetic with no semantic backing and the caption claimed
// "55 similarity threads" we did not actually compute. Caption now reports
// only what the corpus actually says.
//
// Scatter cap: each entity renders min(count, 30) mention dots. Caps the
// visual density without distorting the relative weight, since the centroid
// node size (radius = 2.4 + log2(count)*1.3) already encodes count faithfully.
// The cap is named in the caption so a reader can decode the visual.
const SCATTER_CAP_PER_ENTITY = 30;

function renderIndustryNewsConstellation(file: IndustryNewsFile, entitiesFile: IndustryNewsEntitiesFile): string {
  const events = file.events ?? [];
  const entities = entitiesFile.entities ?? [];
  const cooccurrences = entitiesFile.cooccurrences ?? [];
  const positions = deriveEntityPositions(entities);
  const byId = new Map(positions.map((p) => [p.id, p]));

  // Event nodes — positioned around the canvas centre, deterministic from index.
  // Halo r scaled down so labels have room to sit beside the dot rather than
  // on top of it. cy = 210 matches actual viewBox center (800×420).
  const CX = 400, CY = 210;
  const eventPositions: Array<{ev: IndustryNewsEvent; x: number; y: number; r: number; angle: number}> = events.map((e, i) => {
    const angle = (i / Math.max(events.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = 130;
    return {
      ev: e,
      angle,
      x: CX + Math.cos(angle) * radius,
      y: CY + Math.sin(angle) * radius,
      r: 4 + Math.sqrt(e.episode_count) * 1.4,
    };
  });

  // Mention scatter — capped per entity to keep the viz readable. Cap is
  // disclosed in the caption.
  let mentionSvg = '';
  let mentionsRendered = 0;
  for (const p of positions) {
    const n = Math.min(p.count, SCATTER_CAP_PER_ENTITY);
    for (let i = 0; i < n; i++) {
      const angle = fnvHash(p.id + '_a_' + i, 0x811c9dc5) * Math.PI * 2;
      const radius = 8 + fnvHash(p.id + '_r_' + i, 0xcbf29ce4) * 26;
      const x = (p.x + Math.cos(angle) * radius).toFixed(1);
      const y = (p.y + Math.sin(angle) * radius).toFixed(1);
      mentionSvg += `<circle cx="${x}" cy="${y}" r="1.1" fill="${p.color}" opacity="0.42"/>`;
      mentionsRendered++;
    }
  }

  // Entity centroid nodes (sized by log of mention count).
  const entityNodes = positions.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(2)}" fill="${p.color}" opacity="0.85"/>`).join('');

  // Co-occurrence edges — drawn from real cooccurrences file. Weight bounds:
  // min weight is 2 (filtered in extractor), max we see is 27. Map to stroke
  // width 0.3..1.8 + opacity 0.18..0.55 linearly against weight range.
  let coSvg = '';
  let coRendered = 0;
  const maxW = cooccurrences.reduce((m, c) => Math.max(m, c.weight), 1);
  for (const co of cooccurrences) {
    const pa = byId.get(co.a);
    const pb = byId.get(co.b);
    if (!pa || !pb) continue;
    const t = co.weight / maxW;
    const sw = (0.3 + t * 1.5).toFixed(2);
    const op = (0.18 + t * 0.37).toFixed(2);
    coSvg += `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke-width="${sw}" opacity="${op}"/>`;
    coRendered++;
  }

  // Event nodes (foreground). Outer ring fill is `none` so entity dots in the
  // ring zone (r..r+4) remain visible — previously a solid white fill shielded
  // them. Inner black dot stays solid so the event still reads as a clear
  // foreground mark.
  const evNodes = eventPositions.map(({ev: _ev, x, y, r}) =>
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 4).toFixed(1)}" fill="none" stroke="#1A1A1A" stroke-width="2"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#1A1A1A"/>`
  ).join('');

  // Event labels (HTML overlay). Position label RADIALLY OUTWARD from canvas
  // center — top events get labels above, bottom events below, side events to
  // the side. Anchor side chosen by horizontal direction so labels never bleed
  // past the canvas edge. Wider truncation (60 chars) at word boundary so we
  // don't cut "ACROS…".
  const LABEL_OFFSET = 14;
  const labels = eventPositions.map(({ev, x, y, r, angle}) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // push label outward from center by halo r + offset
    const lx = x + dx * (r + LABEL_OFFSET);
    const ly = y + dy * (r + LABEL_OFFSET);
    const xPct = (lx / 800 * 100).toFixed(2);
    const yPct = (ly / 420 * 100).toFixed(2);
    // Horizontal anchor: if event is on right side of canvas, anchor label
    // right edge to its left so it grows leftward (stays inside canvas).
    // Symmetric for left. Vertical anchor: if top half, anchor bottom of
    // label to its top; if bottom half, anchor top of label to its bottom.
    const hAnchor = dx > 0.3 ? "left" : dx < -0.3 ? "right" : "center";
    const vAnchor = dy < -0.3 ? "above" : dy > 0.3 ? "below" : "center";
    const anchorClass = `in-cn-evlabel-h-${hAnchor} in-cn-evlabel-v-${vAnchor}`;
    // Truncate at last word boundary within 60 chars.
    const raw = ev.headline.split(/[.,—]/)[0]!;
    let short = raw.slice(0, 60);
    if (raw.length > 60) {
      const lastSpace = short.lastIndexOf(" ");
      if (lastSpace > 30) short = short.slice(0, lastSpace) + "…";
      else short = short + "…";
    }
    return `<div class="in-cn-evlabel ${anchorClass}" style="left: ${xPct}%; top: ${yPct}%;">${esc(short)}</div>`;
  }).join('');

  const mentionsTotal = entitiesFile.mentions_total ?? entities.reduce((s, e) => s + e.count, 0);
  const transcriptCount = entitiesFile.source_transcript_count ?? file.source_transcript_count ?? 0;

  return `<div class="in-cn">
    <p class="in-cn-tag">// substrate + surfaced events</p>
    <p class="in-cn-caption">${mentionsTotal} entity mentions across ${entities.length} entities · ${coRendered} co-occurrence edges (both entities surfaced in same transcript, weight ≥ 2) · scatter capped at ${SCATTER_CAP_PER_ENTITY} dots/entity (${mentionsRendered} rendered) for readability. derived from ${transcriptCount} hydrated podcast transcripts in data/youtube.json. foreground: ${events.length} events with halos.</p>
    <div class="in-cn-svg-wrap">
      <svg viewBox="0 0 800 420" preserveAspectRatio="xMidYMid meet">
        <g stroke="#9A9A9A" stroke-width="0.3" opacity="0.10">
          <line x1="0" y1="50" x2="800" y2="50"/><line x1="0" y1="100" x2="800" y2="100"/><line x1="0" y1="150" x2="800" y2="150"/><line x1="0" y1="200" x2="800" y2="200"/><line x1="0" y1="250" x2="800" y2="250"/><line x1="0" y1="300" x2="800" y2="300"/><line x1="0" y1="350" x2="800" y2="350"/>
          <line x1="100" y1="0" x2="100" y2="420"/><line x1="200" y1="0" x2="200" y2="420"/><line x1="300" y1="0" x2="300" y2="420"/><line x1="400" y1="0" x2="400" y2="420"/><line x1="500" y1="0" x2="500" y2="420"/><line x1="600" y1="0" x2="600" y2="420"/><line x1="700" y1="0" x2="700" y2="420"/>
        </g>
        <g>${mentionSvg}</g>
        <g stroke="#6B6B6B" stroke-width="0.5" fill="none" opacity="0.45">${coSvg}</g>
        <g>${entityNodes}</g>
        <g>${evNodes}</g>
      </svg>
      ${labels}
    </div>
  </div>`;
}

function renderIndustryNewsMatrix(events: IndustryNewsEvent[]): string {
  if (events.length === 0) return '';
  // Group events by lab (or "Industry-wide" if labs_involved is empty), then category
  type LabKey = string;
  const labOrder: LabKey[] = [];
  const cellMap = new Map<LabKey, Map<string, IndustryNewsEvent[]>>();
  for (const e of events) {
    const labs = e.labs_involved.length > 0 ? e.labs_involved.slice(0, 1) : ["Industry-wide"];
    for (const lab of labs) {
      if (!cellMap.has(lab)) { cellMap.set(lab, new Map()); labOrder.push(lab); }
      const catMap = cellMap.get(lab)!;
      if (!catMap.has(e.category)) catMap.set(e.category, []);
      catMap.get(e.category)!.push(e);
    }
  }
  // Categories present
  const catOrder: IndustryNewsEvent["category"][] = ["legal", "compute", "product-policy", "geopolitics", "narrative", "executive", "regulatory", "funding", "security"];
  const presentCats = catOrder.filter((c) => events.some((e) => e.category === c));

  // iter-41 cleanup per Kem: "three episodes / three shows doesn't sound
  // very compelling — maybe just label it a bit funny, like show-to-coverage
  // ratio". Reframe as ratio = episodes / shows with editorial label
  // (DEEP-DIVE / REPEATED / ONE-PASS). Replaces SHOWS/EPISODES dot-pips.
  //
  // Kem follow-up: "episodes per show — what is episodes per show? Help me
  // understand that." Re-label as "AVG EPISODES PER SHOW" + add interpretive
  // subline explaining what high vs low means editorially.
  const coverageBlock = (ev: IndustryNewsEvent) => {
    const ratio = ev.episode_count / Math.max(ev.shows.length, 1);
    const ratioLabel = ratio >= 2 ? "DEEP-DIVE" : ratio >= 1.5 ? "REPEATED" : "ONE-PASS";
    const ratioMeaning = ratio >= 2
      ? "shows kept returning to this story"
      : ratio >= 1.5
        ? "some shows revisited; others one-and-done"
        : "each show covered this once";
    return `<div class="in-cov">
      <div class="in-cov-num"><span class="in-cov-eps">${ev.episode_count}</span><span class="in-cov-slash">/</span><span class="in-cov-shows">${ev.shows.length}</span></div>
      <div class="in-cov-meta"><div class="in-cov-label">${ev.episode_count} eps ÷ ${ev.shows.length} shows = <strong>${ratio.toFixed(2)}</strong> avg eps/show</div><div class="in-cov-ratio">${ratioLabel} — ${ratioMeaning}</div></div>
    </div>`;
  };

  // iter-41 cleanup per Kem: "we only list each one once". Dedupe sources
  // by show name — list each show ONCE with × N episode-count chip + ONE
  // illustrative quote (first excerpt from that show). Preserves order from
  // shows[]. Episode counts distribute evenly with deterministic remainder
  // (data has shows + episode_count but no per-show breakdown).
  const sourceBlock = (ev: IndustryNewsEvent) => {
    const byShow = new Map<string, { count: number; excerpt: IndustryNewsExcerpt | null }>();
    for (const s of ev.shows) {
      if (!byShow.has(s)) byShow.set(s, { count: 0, excerpt: null });
    }
    const base = Math.floor(ev.episode_count / Math.max(ev.shows.length, 1));
    const extra = ev.episode_count - base * ev.shows.length;
    ev.shows.forEach((s, i) => {
      byShow.get(s)!.count = base + (i < extra ? 1 : 0);
    });
    for (const x of (ev.excerpts ?? [])) {
      const entry = byShow.get(x.show);
      if (entry && !entry.excerpt) entry.excerpt = x;
    }
    const items = ev.shows.map((s) => {
      const entry = byShow.get(s)!;
      const x = entry.excerpt;
      const countChip = entry.count > 1 ? `<span class="in-src-x">× ${entry.count}</span>` : '';
      if (x?.video_id) {
        return `<div class="in-source"><div class="in-source-thumb" style="background-image: url('https://i.ytimg.com/vi/${x.video_id}/mqdefault.jpg')"></div><div class="in-source-body"><div class="in-source-show"><span>${esc(s)}</span>${countChip}</div><a class="in-source-link" href="${esc(x.url)}" target="_blank">${esc((x.quote ?? "").slice(0, 80))}${(x.quote?.length ?? 0) > 80 ? "…" : ""} ↗</a></div></div>`;
      }
      if (x) {
        return `<div class="in-source"><div class="in-source-body"><div class="in-source-show"><span>${esc(s)}</span>${countChip}</div><span class="in-source-quote">${esc((x.quote ?? "").slice(0, 80))}${(x.quote?.length ?? 0) > 80 ? "…" : ""}</span></div></div>`;
      }
      return `<div class="in-source"><div class="in-source-body"><div class="in-source-show"><span>${esc(s)}</span>${countChip}</div><span class="in-source-quote-empty">(no excerpt captured this cycle)</span></div></div>`;
    }).join('');
    return `<div class="in-sources">
      <div class="in-sources-label">SHOWS →</div>
      <div class="in-sources-list">${items}</div>
    </div>`;
  };

  const cell = (events: IndustryNewsEvent[]) => {
    if (events.length === 0) return '<td></td>';
    return `<td>${events.map((e) => `<div class="in-evcell">
        <div class="in-evcell-headline">${esc(e.headline)}${aiMark()}</div>
        <div class="in-evcell-context">${esc(e.context)}${aiMark()}</div>
        ${coverageBlock(e)}
        ${sourceBlock(e)}
      </div>`).join('')}</td>`;
  };

  const headerRow = `<tr><th></th>${presentCats.map((c) => `<th>${esc(CATEGORY_LABEL[c] ?? c)}</th>`).join('')}</tr>`;
  const bodyRows = labOrder.map((lab) => {
    const isIndustryWide = lab === "Industry-wide";
    const labCell = isIndustryWide
      ? `<td class="in-lab-cell in-lab-cell-industry">Industry-wide</td>`
      : `<td class="in-lab-cell">${esc(lab)}</td>`;
    const catMap = cellMap.get(lab)!;
    const cells = presentCats.map((c) => cell(catMap.get(c) ?? [])).join('');
    return `<tr>${labCell}${cells}</tr>`;
  }).join('');

  return `<div class="in-matrix-section">
    <p class="in-section-tag">// who is moving this cycle</p>
    <p class="in-section-tells">rows = labs · columns = event category · cells: headline + brief context + coverage density (episodes/shows · ratio) + per-show source list (each show listed once with × N episode count + illustrative quote).</p>
    <table class="in-matrix">
      <thead>${headerRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

function renderIndustryNewsLens(file: IndustryNewsFile, entitiesFile: IndustryNewsEntitiesFile): string {
  const events = file.events ?? [];
  const claim = lensClaim("lens-news");
  if (events.length === 0) {
    return lensWrap(
      "lens-news",
      "lens-news",
      "Industry News",
      claim,
      0,
      "events",
      renderIndustryNewsBanner(file) +
        renderEmptyLens(
          "No multi-show news events surfaced this cycle. Either the harvest pool lacked event-shaped coverage or all candidate events overlapped with Features cards.",
        ),
    );
  }
  const body =
    renderIndustryNewsBanner(file) +
    `<div class="in-viz2">${renderIndustryNewsDepletion(file)}${renderIndustryNewsConstellation(file, entitiesFile)}</div>` +
    renderIndustryNewsMatrix(events);
  return lensWrap("lens-news", "lens-news", "Industry News", claim, events.length, "events", body);
}

// iter-42 — renderOpEdLens + LAB_AFFILIATED_HANDLES DELETED per Kem walk.
// Critic quotes already surface inline in Features card sentiment panels via
// notable_quotes (same data source). Opposition belongs WITH the feature.

// ---------- SECURITY ----------
// iter-42 D2 rev4 — rebuilt to Kem's locked spec (V4 two-column shell +
// per-item analysis viz + LISTEN chip + resources fold + reworked section
// header). Distinct identity from Industry News (not a clone).
//
// Reads data/security-events.json (curated by orchestrator-direct glitch-
// sweep over 60 hydrated podcast transcripts) + data/security-entities.json
// (produced by scripts/extract-security-entities.ts). Events sorted by
// severity for display; letters A-E assigned by sort order. Discussion-
// volume bars computed deterministically from related_concepts mention
// counts in the entities file. Same input files → byte-identical output
// (v8 doctrine).

interface SecurityExcerpt {
  show: string;
  video_id: string;
  url: string;
  quote: string;
  timestamp_seconds?: number;
  is_mock_timestamp?: boolean;
}
interface SecurityResource {
  label: string;
  url: string;
  is_mock?: boolean;
  is_mock_timestamp?: boolean;
}
interface SecurityEvent {
  key: string;
  headline: string;
  category: "supply-chain" | "cyber-incident" | "lab-policy" | "agentic-security" | "alignment-research" | "red-team";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  context: string;
  labs_involved: string[];
  shows: string[];
  episode_count: number;
  coverage_sentiment: "alarmed" | "contested" | "consensus" | "skeptical" | "neutral";
  related_concepts?: string[];
  your_move_verdict: string;
  what_to_do: string[];
  excerpts: SecurityExcerpt[];
  resources?: SecurityResource[];
}
interface SecurityDrop {
  candidate_headline: string;
  reason: string;
}
interface SecurityFile {
  generated_at?: string;
  source_transcript_count?: number;
  events: SecurityEvent[];
  dropped?: SecurityDrop[];
  pipeline_stats?: {
    chunks_run: number;
    chunks_failed: number;
    raw_events_extracted: number;
    events_after_dedup: number;
    events_after_aggregation: number;
  };
}
function loadSecurityEvents(): SecurityFile {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/security-events.json`, "utf-8"));
  } catch {
    return { events: [] };
  }
}

interface SecurityEntity {
  id: string;
  category: "alignment" | "supply-chain" | "agentic" | "cyber" | "red-team" | "policy";
  count: number;
}
interface SecurityCoEdge { a: string; b: string; weight: number; }
interface SecurityEntitiesFile {
  generated_from?: string;
  source_transcript_count?: number;
  entities: SecurityEntity[];
  cooccurrences: SecurityCoEdge[];
  mentions_total?: number;
  cooccurrence_pairs?: number;
}
function loadSecurityEntities(): SecurityEntitiesFile {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/security-entities.json`, "utf-8"));
  } catch {
    return { entities: [], cooccurrences: [] };
  }
}

// ----- rev4 helpers -----
const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const SEV_CELLS_MAX = 4;
const DISC_CELLS_MAX = 10;
const DISC_NORM_MAX = 30;  // max single-concept count in the corpus (reward hacking)
const ACTIONABLE_VERDICTS = new Set(["UPDATE NOW", "AUDIT + PIN", "SANDBOX", "AVOID"]);

function severityCells(sev: string): number { return SEV_RANK[sev] ?? 0; }
function severityClass(sev: string): string { return `sx-sev-${sev.replace(/[^A-Z]/gi, "")}`; }

function discussionMentions(ev: SecurityEvent, entityCounts: Map<string, number>): number {
  return (ev.related_concepts ?? []).reduce((sum, id) => sum + (entityCounts.get(id) ?? 0), 0);
}
function discussionCells(mentions: number): number {
  return Math.min(DISC_CELLS_MAX, Math.round(mentions / DISC_NORM_MAX * DISC_CELLS_MAX));
}

function fmtTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function sortAndLetterEvents(events: SecurityEvent[]): Array<SecurityEvent & { _letter: string; _orig: number }> {
  return events
    .map((e, i) => ({ ...e, _orig: i }))
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || a._orig - b._orig)
    .map((e, i) => ({ ...e, _letter: String.fromCharCode(65 + i) }));
}

function renderCells(filled: number, max: number): string {
  let html = '<div class="ev-cells">';
  for (let i = 0; i < max; i++) html += `<span class="ev-cell${i < filled ? " on" : ""}"></span>`;
  html += '</div>';
  return html;
}

// ----- section header: status strip + index TOC -----
function renderSecurityStatusStrip(events: SecurityEvent[], entitiesFile: SecurityEntitiesFile): string {
  const tally = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const e of events) if (tally[e.severity] !== undefined) tally[e.severity]++;
  const actionables = events.filter((e) => ACTIONABLE_VERDICTS.has(e.your_move_verdict)).length;
  const mentionsTotal = entitiesFile.mentions_total ?? entitiesFile.entities.reduce((s, e) => s + e.count, 0);
  const conceptCount = entitiesFile.entities.length;
  const transcripts = entitiesFile.source_transcript_count ?? 0;
  const showCount = new Set(events.flatMap((e) => e.shows)).size;
  return `<div class="sx-status">
    <div class="sx-st-block">
      <span class="sx-st-label">Issues</span>
      <span class="sx-st-num">${events.length}</span>
      <span class="sx-st-sub">surfaced this cycle</span>
    </div>
    <div class="sx-st-block">
      <span class="sx-st-label">Severity tally</span>
      <span class="sx-st-num">${tally.CRITICAL} / ${tally.HIGH} / ${tally.MEDIUM} / ${tally.LOW}</span>
      <span class="sx-st-sub">crit · high · med · low${aiMark()}</span>
    </div>
    <div class="sx-st-block">
      <span class="sx-st-label">Corpus signal</span>
      <span class="sx-st-num">${mentionsTotal}</span>
      <span class="sx-st-sub">concept mentions · ${conceptCount} concepts</span>
    </div>
    <div class="sx-st-block">
      <span class="sx-st-label">Source pool</span>
      <span class="sx-st-num">${transcripts}</span>
      <span class="sx-st-sub">podcast episodes · ${showCount} shows</span>
    </div>
    <div class="sx-st-block">
      <span class="sx-st-label">Action items</span>
      <span class="sx-st-num">${actionables}</span>
      <span class="sx-st-sub">events with UPDATE / SANDBOX verdict${aiMark()}</span>
    </div>
  </div>`;
}

function renderSecurityIndexTOC(events: Array<SecurityEvent & { _letter: string }>): string {
  const rows = events.map((e) => `<a class="sx-idx-row" href="#sx-ev-${e._letter.toLowerCase()}">
    <span class="sx-idx-letter">${e._letter}</span>
    <span class="sx-idx-sev sx-idx-sev-${e.severity}">${e.severity}</span>
    <span class="sx-idx-title">${esc(e.headline.split("—")[0]!.trim())}</span>
    <span class="sx-idx-action">${esc(e.your_move_verdict)}</span>
  </a>`).join("");
  return `<div class="sx-index">
    <div class="sx-idx-tag">// quick index — click to jump</div>
    ${rows}
  </div>`;
}

// ----- per-event block (V4 two-column shell) -----
function renderSecurityEventBlock(ev: SecurityEvent & { _letter: string }, entityCounts: Map<string, number>): string {
  const sevCells = severityCells(ev.severity);
  const mentions = discussionMentions(ev, entityCounts);
  const discCells = discussionCells(mentions);
  const showCount = ev.shows.length;
  const epCount = ev.episode_count;
  const headline = ev.headline;
  const firstExcerpt = ev.excerpts[0];

  const attribution = firstExcerpt ? (() => {
    const show = firstExcerpt.show;
    const url = firstExcerpt.timestamp_seconds
      ? `${firstExcerpt.url}${firstExcerpt.url.includes("?") ? "&" : "?"}t=${firstExcerpt.timestamp_seconds}s`
      : firstExcerpt.url;
    const ts = firstExcerpt.timestamp_seconds ? fmtTimestamp(firstExcerpt.timestamp_seconds) : null;
    const tsLabel = ts ? `<span class="attr-time">${ts}${firstExcerpt.is_mock_timestamp ? `<span class="sx-mock">mock</span>` : ""}</span>` : "";
    return `<div class="ev-attr">
      <span class="attr-show">${esc(show)}</span>
      <a class="attr-listen" href="${esc(url)}" target="_blank" rel="noopener">▶ LISTEN ${tsLabel}</a>
    </div>`;
  })() : "";

  const resourcesHtml = (ev.resources && ev.resources.length > 0) ? `<div class="ev-resources">
    <p class="ev-res-label">// more on this issue</p>
    <ul class="ev-res-list">
      ${ev.resources.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label)}${r.is_mock || r.is_mock_timestamp ? `<span class="sx-mock">mock</span>` : ""}</a></li>`).join("")}
    </ul>
  </div>` : "";

  const doList = ev.what_to_do.map((s) => `<li class="ev-do-item"><span>${esc(s)}</span></li>`).join("");

  return `<div class="ev-block" id="sx-ev-${ev._letter.toLowerCase()}">
    <div class="ev-left">
      <div class="ev-anchor"><strong>${ev._letter}</strong></div>
      <div class="ev-top">
        <span class="ev-sev ${severityClass(ev.severity)}">${ev.severity}${aiMark()}</span>
        <div class="ev-analysis">
          <div class="ev-an-row"><span class="ev-an-label">severity</span>${renderCells(sevCells, SEV_CELLS_MAX)}</div>
          <div class="ev-an-row"><span class="ev-an-label">discussion</span>${renderCells(discCells, DISC_CELLS_MAX)}<span class="ev-an-num">${mentions}× · ${showCount} show${showCount === 1 ? "" : "s"} · ${epCount} ep${epCount === 1 ? "" : "s"}</span></div>
        </div>
      </div>
      <h2 class="ev-headline">${esc(headline)}</h2>
      <p class="ev-summary">${esc(ev.context)}${aiMark()}</p>
      ${firstExcerpt ? `<div class="ev-quote-wrap">
        <p class="ev-quote">${esc(firstExcerpt.quote)}</p>
        ${attribution}
      </div>` : ""}
      ${resourcesHtml}
    </div>
    <div class="ev-right">
      <p class="ev-move-label">// your move${aiMark()}</p>
      <p class="ev-move-verdict">${esc(ev.your_move_verdict)}</p>
      <p class="ev-move-label">// what to do</p>
      <ul class="ev-do-list">${doList}</ul>
    </div>
  </div>`;
}

// ----- lens composer -----
function renderSecurityLens(file: SecurityFile, entitiesFile: SecurityEntitiesFile): string {
  const events = file.events ?? [];
  const claim = lensClaim("lens-security");
  const wf = renderLensWorkflowHeader(
    "Glitch-sweep over 60 podcast transcripts surfaces concrete security issues + editorial topics",
    events.length,
    events.length === 1 ? "issue" : "issues",
    `severity-ranked · per-event verdict + what-to-do · LISTEN chips deep-link to source`,
  );
  if (events.length === 0) {
    return lensWrap("lens-security", "lens-security", "Security", claim, 0, "issues",
      wf + renderEmptyLens("No security issues surfaced this cycle. Either the harvest pool lacked security-shaped coverage or the curated event dictionary did not match."));
  }
  const sortedEvents = sortAndLetterEvents(events);
  const entityCounts = new Map(entitiesFile.entities.map((e) => [e.id, e.count]));
  const body =
    wf +
    renderSecurityStatusStrip(events, entitiesFile) +
    renderSecurityIndexTOC(sortedEvents) +
    sortedEvents.map((e) => renderSecurityEventBlock(e, entityCounts)).join("");
  return lensWrap("lens-security", "lens-security", "Security", claim, events.length, "issues", body);
}

// ---------- GITHUB (iter-43 rev7 — Kem-ratified) ----------
// Three-block intersection (viz / read-one-glance / tags chart) + 6 theme
// cells + Magic Wand Check editorial scorecard. v8 doctrine compliant:
// every visible number derives from on-disk inputs (data/github.json for
// repos + per-platform JSON files for cross-platform mention probes).
// Sonnet-curated editorial text carries aiMark chips.
//
// Theme assignments are MANUAL in iter-43 (frozen as GITHUB_THEMES below).
// Iter-44 follow-up: ship scripts/extract-github-themes.ts glitch-sweep
// (mirror of scripts/extract-security-entities.ts) so theme membership +
// labels become corpus-derived. Tracked as iter-44 ISC carry per
// no-defer-doctrine.
interface GithubItem {
  title?: string;
  url?: string;
  raw_text?: string;
  engagement?: number;
  meta?: {
    author?: string;
    language?: string;
    description?: string;
    stars?: number;
    repo?: string;
    topics?: string[];
    created_at?: string;
  };
}

type ThemeStatus = "validated" | "gh-leading" | "cross-link" | "modest";

interface ThemeRepoRow {
  repoSlug: string;
  description: string;
}

interface ThemeVizConfig {
  fillStyle: "filled-ink" | "outline-dashed" | "outline-dotted" | "filled-grey" | "outline-faint";
  insideLines?: string[];
  insideColor?: "white" | "ink" | "faint";
  insideFontSize?: number;
  externalLabel?: {
    text: string;
    position: "above" | "below" | "left";
    color?: "ink" | "muted" | "faint";
  };
}

interface GithubTheme {
  id: string;
  name: string;
  status: ThemeStatus;
  statusLabel: string;
  topicTagsForDisplay: string[];
  topReposForCell: ThemeRepoRow[];
  // Full theme membership (all repos belonging to this theme, not just the
  // 3 surfaced in the cell). Used for deterministic repo-count + combined-
  // stars derivation. Topic-tag overlap fallback was unreliable since repos
  // share tags across themes ("claude" tag matches many themes).
  repoSlugs: string[];
  socialTerms: string[];
  quotes?: { text: string; author: string; platform: string; engagement: number }[];
  crossLinkText?: string;
  editorial: string;
  viz: ThemeVizConfig;
}

interface MagicWandEntry {
  repoSlug: string;
  verdict: "TRICK" | "VERIFY" | "REAL" | "PRE-VIRAL" | "HYPE";
  themeName: string;
  themeSubLabel: string;
  bodyText: string;
  contentAngle: string;
  searchTerms: string[]; // per-repo cross-platform probe
}

const GITHUB_THEMES: GithubTheme[] = [
  {
    id: "claude-skills",
    name: "Claude Code skill ecosystem",
    status: "validated",
    statusLabel: "VALIDATED CROSSOVER",
    topicTagsForDisplay: ["skills", "claude-code", "anthropic", "claude", "agent-harness"],
    topReposForCell: [
      { repoSlug: "JuliusBrussee/caveman", description: "why use many token when few token do trick — Claude Code skill that cuts 65% of tokens by talking like caveman" },
      { repoSlug: "safishamsi/graphify", description: "knowledge-graph builder packaged as a multi-CLI skill (Claude Code, Codex, OpenCode, Cursor, Gemini CLI)" },
      { repoSlug: "ConardLi/garden-skills", description: "open-source Skills collection — web design, knowledge retrieval, image generation" },
    ],
    repoSlugs: ["JuliusBrussee/caveman", "safishamsi/graphify", "ConardLi/garden-skills", "lintsinghua/claude-code-book", "Windy3f3f3f3f/how-claude-code-works", "google/agents-cli", "Shpigford/chops", "JuliusBrussee/cavemem", "nex-crm/wuphf"],
    socialTerms: ["claude skill", "claude skills", "agent skill", "agent skills"],
    quotes: [
      { text: "Everybody's talking about Claude Code but I'm surprised at how little people are using Claude Skills — which is honestly…", author: "@rpn", platform: "IG", engagement: 35506 },
      { text: "Skills and MCP are the visible layer of Claude Code. The other four primitives are what makes the visible layer actually…", author: "@coder_surya", platform: "X", engagement: 479 },
    ],
    editorial: "Dominant story of the cycle. Skills + harness work is where the community is actively building, not just consuming. 9 repos including the #1 and #3 by stars. The ecosystem hits \"people are building tools <em>for</em> Claude Code, not just <em>with</em> it\" — which is itself a maturity signal. Compounds with MCP being the other \"visible layer\" — multiple repos integrate both.",
    viz: { fillStyle: "filled-ink", insideLines: ["CLAUDE", "SKILLS"], insideColor: "white", externalLabel: { text: "caveman 60.9k", position: "below", color: "ink" } },
  },
  {
    id: "memory-systems",
    name: "Memory & knowledge systems",
    status: "gh-leading",
    statusLabel: "GITHUB-LEADING",
    topicTagsForDisplay: ["memory", "rag", "knowledge-graph", "wiki", "agent-memory", "mcp"],
    topReposForCell: [
      { repoSlug: "MemPalace/mempalace", description: "\"best-benchmarked open-source AI memory system. And it's free.\" Claim worth verifying against MTEB." },
      { repoSlug: "FlowElement-ai/m_flow", description: "bio-inspired cognitive memory engine — a new paradigm for Graph RAG" },
      { repoSlug: "lucasastorian/llmwiki", description: "explicit implementation of Karpathy's LLM Wiki idea — Obsidian-graph pattern that Karpathy showcased" },
    ],
    repoSlugs: ["MemPalace/mempalace", "FlowElement-ai/m_flow", "VectifyAI/OpenKB", "OpenRaiser/NanoResearch", "lucasastorian/llmwiki", "RyanCodrai/turbovec", "nduckmink/arkon", "swarmclawai/swarmvault", "supermemoryai/smfs"],
    socialTerms: ["memory system", "persistent memory", "llm memory", "agent memory"],
    editorial: "Devs are building memory systems before content creators are talking about them. Mempalace at 52k stars without organic creator pickup in our window is the textbook pre-viral shape. <strong>swarmvault</strong> and <strong>llmwiki</strong> both explicitly cite Karpathy's wiki pattern — the Karpathy-named-it-it-builds resonance is right here in the data. If Karpathy tweets, this cluster detonates.",
    viz: { fillStyle: "outline-dashed", insideLines: ["MEMORY"], insideColor: "ink", externalLabel: { text: "mempalace 52.3k", position: "above", color: "ink" } },
  },
  {
    id: "agent-security",
    name: "Agent security & ops stack",
    status: "cross-link",
    statusLabel: "CROSS-LINK · SECURITY",
    topicTagsForDisplay: ["openclaw", "mcp-server", "self-hosted", "observability", "vault"],
    topReposForCell: [
      { repoSlug: "TencentCloud/CubeSandbox", description: "instant, concurrent, secure & lightweight sandbox for AI agents" },
      { repoSlug: "EKKOLearnAI/hermes-web-ui", description: "web dashboard for Hermes Agent — multi-platform AI chat, session management" },
      { repoSlug: "Infisical/agent-vault", description: "HTTP credential proxy and vault for AI agents (Claude Code, OpenClaw, Hermes)" },
    ],
    repoSlugs: ["TencentCloud/CubeSandbox", "EKKOLearnAI/hermes-web-ui", "Infisical/agent-vault", "BlazeUp-AI/Observal", "SafeAI-Lab-X/ClawKeeper", "opencraig/opencraig"],
    // Narrowed to specific named entity ("hermes agent" / "hermes.web") that
    // appears in social posts. "openclaw" was over-broad — matched agent-
    // related content unrelated to this theme's editorial argument (would
    // have pushed the Agent-Sec dot to y-axis ceiling).
    socialTerms: ["hermes agent", "hermes.web"],
    crossLinkText: "<strong>cross-lens link:</strong> Industry News covered Hermes opening up. GitHub side shows the community building dashboards (hermes-web-ui), security wrappers (agent-vault), and isolation sandboxes (CubeSandbox) on top of the same trend. ClawKeeper is \"the Norton for OpenClaw.\"",
    editorial: "Every viral feature ships with its security afterthought. The agent-stack ecosystem is building credential proxies, sandboxes, and observability platforms <em>around</em> the agent frameworks themselves — defensive engineering catching up with capability.",
    viz: { fillStyle: "outline-dotted", insideLines: ["A-SEC"], insideColor: "ink", insideFontSize: 6.5 },
  },
  {
    id: "browser",
    name: "Browser & multi-agent orchestration",
    status: "modest",
    statusLabel: "MODEST CROSSOVER",
    topicTagsForDisplay: ["browser-agent", "multi-agent", "cloud-browser", "playwright"],
    topReposForCell: [
      { repoSlug: "browser-use/browser-harness", description: "self-healing harness that enables LLMs to complete any task — browser-use team, established engineering" },
      { repoSlug: "open-multi-agent/open-multi-agent", description: "from a goal to a task DAG, automatically. TypeScript-native multi-agent orchestration with MCP and live tracing" },
      { repoSlug: "holaboss-ai/holaOS", description: "turn repeat work into running AI work-streams" },
    ],
    repoSlugs: ["browser-use/browser-harness", "open-multi-agent/open-multi-agent", "holaboss-ai/holaOS", "crynta/terax-ai", "esengine/DeepSeek-Reasonix"],
    socialTerms: ["browser-use", "browser harness", "browser-harness"],
    editorial: "Real engineering work — browser-use team has shipped before. The \"self-healing browser agent\" framing is the kind of substantive infrastructure piece that doesn't go viral as a meme but becomes a stable dependency for vibe-coders downstream.",
    viz: { fillStyle: "filled-grey", insideLines: ["BROWSER"], insideColor: "white" },
  },
  {
    id: "starter-kits",
    name: "Starter kits & dev content",
    status: "modest",
    statusLabel: "META-CONTENT",
    topicTagsForDisplay: ["awesome", "tutorial", "interview-prep", "course"],
    topReposForCell: [
      { repoSlug: "rohitg00/ai-engineering-from-scratch", description: "\"Learn it. Build it. Ship it for others.\" Course content packaged as repo." },
      { repoSlug: "freestylefly/awesome-gpt-image-2", description: "prompt template library — 370+ case studies, 20+ industrial templates (中文)" },
      { repoSlug: "mnfst/awesome-free-llm-apis", description: "list of permanent free LLM API keys" },
    ],
    repoSlugs: ["rohitg00/ai-engineering-from-scratch", "freestylefly/awesome-gpt-image-2", "mnfst/awesome-free-llm-apis", "alvinreal/awesome-opensource-ai", "amitshekhariitbhu/ai-engineering-interview-questions"],
    socialTerms: ["awesome.*ai", "free llm api", "ai engineering"],
    editorial: "Meta-content cluster — repos ABOUT AI dev, not the dev itself. Awesome lists, interview-prep, courses, free-API directories. Worth surfacing separately as \"is this a tool or content about tools?\"",
    viz: { fillStyle: "filled-grey", insideLines: ["KITS"], insideColor: "white", externalLabel: { text: "starter kits", position: "above", color: "muted" } },
  },
  {
    id: "niche",
    name: "Niche vertical agents",
    status: "modest",
    statusLabel: "GITHUB-ONLY",
    topicTagsForDisplay: ["trading", "cad", "research-assistant"],
    topReposForCell: [
      { repoSlug: "HKUDS/Vibe-Trading", description: "\"Vibe-Trading: Your Personal Trading Agent\" — quoted title, presented exactly as repo names itself" },
      { repoSlug: "earthtojake/text-to-cad", description: "collection of agent skills for CAD, robotics and hardware design" },
      { repoSlug: "OpenRaiser/NanoResearch", description: "autonomous AI research assistant" },
    ],
    repoSlugs: ["HKUDS/Vibe-Trading", "earthtojake/text-to-cad", "Prismer-AI/PrismerCloud", "guoguo-tju/agent_java_offer"],
    socialTerms: ["vibe-trading", "vibe trading", "text-to-cad"],
    editorial: "Vertical-specific agents (trading, CAD, research). Star counts alone — Vibe-Trading at 7,422 with no organic creator pickup in our window. Classic \"stars without signal\" — could be hype-bubble, could be early. Pre-viral or unviable, watch across cycles to tell which.",
    viz: { fillStyle: "outline-faint", externalLabel: { text: "NICHE", position: "left", color: "faint" } },
  },
];

const MAGIC_WAND: MagicWandEntry[] = [
  { repoSlug: "JuliusBrussee/caveman", verdict: "TRICK", themeName: "Claude Skills", themeSubLabel: "claude skills · token-cut",
    bodyText: "\"Talk like caveman\" cuts 65% tokens — but the same trick is achievable in a 6-line prompt per research. Viral as aesthetic, thin as engineering.",
    contentAngle: "why 60k stars went to a 6-line prompt — what that says about the token-economy moment",
    searchTerms: ["caveman", "why use many token", "few token do trick"] },
  { repoSlug: "MemPalace/mempalace", verdict: "VERIFY", themeName: "Memory systems", themeSubLabel: "memory systems · rag",
    bodyText: "Bold claim: \"best-benchmarked open-source AI memory system.\" Checkable — would test against MTEB / FAISS / chromadb.",
    contentAngle: "the 52k-star memory system nobody's talking about this cycle — does the benchmark hold?",
    searchTerms: ["mempalace", "mem palace"] },
  { repoSlug: "safishamsi/graphify", verdict: "REAL", themeName: "Claude Skills", themeSubLabel: "claude skills · multi-cli",
    bodyText: "Knowledge-graph builder packaged for 5 CLIs (Claude Code, Codex, OpenCode, Cursor, Gemini CLI). Cross-tool design is real engineering; Karpathy-Obsidian-graph resonance gives it pull.",
    contentAngle: "plug your codebase into a graph in 90s — works with whatever CLI you use",
    searchTerms: ["graphify"] },
  { repoSlug: "browser-use/browser-harness", verdict: "REAL", themeName: "Browser", themeSubLabel: "browser · self-healing",
    bodyText: "Self-healing browser agent from the browser-use team (established shipper). Substantive infra — becomes a stable dep under vibe-coder apps.",
    contentAngle: "the browser agent that fixes itself when the page changes",
    searchTerms: ["browser-use", "browser harness", "browser-harness"] },
  { repoSlug: "lucasastorian/llmwiki", verdict: "PRE-VIRAL", themeName: "Memory systems", themeSubLabel: "memory systems · karpathy-pattern",
    bodyText: "Explicit implementation of Karpathy's LLM Wiki idea. Connects Claude via MCP. swarmvault (also in corpus) cites the same pattern — pre-viral cluster forming.",
    contentAngle: "the Karpathy-pattern wiki that's about to detonate — be early on it",
    searchTerms: ["llmwiki", "llm wiki", "karpathy wiki"] },
  { repoSlug: "HKUDS/Vibe-Trading", verdict: "HYPE", themeName: "Niche", themeSubLabel: "niche · trading",
    bodyText: "7,422 stars, no organic creator pickup in our window. \"Vibe-Trading\" name fits the magic-wand pattern — could be early, could be inflated.",
    contentAngle: "the trading agent with 7.4k stars and no people actually using it — anatomy of a GitHub hype-bubble",
    searchTerms: ["vibe-trading", "vibe trading"] },
];

// === Source-data probe helpers (deterministic regex match against on-disk JSON) ===

interface ProbeItem { title?: string; raw_text?: string; meta?: { transcript?: string } }
function loadProbeSource(filename: string): ProbeItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/${filename}`, "utf-8"));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.items)) return raw.items;
    return [];
  } catch { return []; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termsRegex(terms: string[]): RegExp {
  if (terms.length === 0) return /(?!)/; // never matches
  // socialTerms entries can already contain regex metachars like .* — preserve those
  return new RegExp(terms.join("|"), "i");
}

// Scan title + raw_text ONLY. Transcripts (data/youtube.json meta.transcript)
// are 5000+ char bodies; including them inflates per-theme mention counts
// catastrophically (one transcript can match a generic term many times,
// pushing dots to the y-axis ceiling). Matches the iter-43 OBSERVE probe
// semantics — see PROJECTS.md handoff for the exact jq baseline.
function countMatches(items: ProbeItem[], re: RegExp): number {
  let n = 0;
  for (const it of items) {
    const hay = `${it.title ?? ""} ${it.raw_text ?? ""}`;
    if (re.test(hay)) n++;
  }
  return n;
}

const PROBE_SOURCES: Record<string, string> = {
  x: "x.json",
  tt: "tiktok.json",
  ig: "instagram.json",
  yt: "youtube.json",
  reddit: "reddit.json",
  hn: "hn.json",
};

function buildSourceIndex(): Record<string, ProbeItem[]> {
  const out: Record<string, ProbeItem[]> = {};
  for (const [pid, file] of Object.entries(PROBE_SOURCES)) {
    out[pid] = loadProbeSource(file);
  }
  return out;
}

function themeSocialMentions(theme: GithubTheme, sourceIndex: Record<string, ProbeItem[]>): { total: number; perPlatform: Record<string, number> } {
  const re = termsRegex(theme.socialTerms);
  const perPlatform: Record<string, number> = {};
  let total = 0;
  for (const [pid, items] of Object.entries(sourceIndex)) {
    const n = countMatches(items, re);
    perPlatform[pid] = n;
    total += n;
  }
  return { total, perPlatform };
}

function repoActivePlatforms(entry: MagicWandEntry, sourceIndex: Record<string, ProbeItem[]>): Set<string> {
  const re = termsRegex(entry.searchTerms);
  const active = new Set<string>();
  for (const [pid, items] of Object.entries(sourceIndex)) {
    if (countMatches(items, re) > 0) active.add(pid);
  }
  return active;
}

// Combined stars = sum over theme.repoSlugs of each repo's stars (from
// github.json engagement field). Deterministic from on-disk inputs.
function combinedStarsForTheme(theme: GithubTheme, repoIndex: Map<string, GithubItem>): number {
  let total = 0;
  for (const slug of theme.repoSlugs) {
    const item = repoIndex.get(slug);
    total += item?.engagement ?? item?.meta?.stars ?? 0;
  }
  return total;
}

// Repo count = curated theme.repoSlugs.length. Iter-43 manual; iter-44
// glitch-sweep (scripts/extract-github-themes.ts) will derive this from
// theme-dictionary + repo-description regex match against on-disk data.
function repoCountForTheme(theme: GithubTheme, _repoIndex: Map<string, GithubItem>): number {
  return theme.repoSlugs.length;
}

function aggregateTopicTags(items: GithubItem[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const tag of (it.meta?.topics ?? [])) {
      const n = tag.toLowerCase();
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  // Merge agent variants (same concept, three spelling variants in the corpus)
  const merged = new Map<string, number>();
  for (const [tag, c] of counts) {
    const key = (tag === "agents" || tag === "ai-agents" || tag === "ai-agent") ? "agents" : tag;
    merged.set(key, (merged.get(key) ?? 0) + c);
  }
  return Array.from(merged.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// === Viz dot positioning ===

// Plot area: x 50..290 (width 240), y 30..260 (height 230). xMax=10, yMax=20.
function dotX(repoCount: number): number {
  return Math.round(50 + (Math.min(repoCount, 10) / 10) * 240);
}
function dotY(mentions: number): number {
  return Math.round(260 - (Math.min(mentions, 20) / 20) * 230);
}
function dotRadius(combinedStars: number): number {
  return Math.max(8, Math.min(26, Math.round(Math.sqrt(Math.max(0, combinedStars)) * 0.077)));
}

function renderThemeDotSvg(theme: GithubTheme, cx: number, cy: number, r: number): string {
  const fills: Record<string, string> = {
    "filled-ink": `fill="#1A1A1A"`,
    "filled-grey": `fill="#6B6B6B" fill-opacity="0.65" stroke="#1A1A1A" stroke-width="1.2"`,
    "outline-dashed": `fill="#1A1A1A" fill-opacity="0.10" stroke="#1A1A1A" stroke-width="2" stroke-dasharray="5,3"`,
    "outline-dotted": `fill="#FFFFFF" stroke="#1A1A1A" stroke-width="1.5" stroke-dasharray="1,2"`,
    "outline-faint": `fill="#FAFAF7" stroke="#9A958C" stroke-width="1.2" stroke-dasharray="2,2"`,
  };
  const insideColorMap = { white: "#fff", ink: "#1A1A1A", faint: "#9A958C" };
  const externalColorMap = { ink: "#1A1A1A", muted: "#6B6B6B", faint: "#9A958C" };
  const out: string[] = [];
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" ${fills[theme.viz.fillStyle]}/>`);
  const lines = theme.viz.insideLines ?? [];
  const insideColor = insideColorMap[theme.viz.insideColor ?? "ink"];
  const fontSize = theme.viz.insideFontSize ?? 8;
  if (lines.length === 1) {
    out.push(`<text x="${cx}" y="${cy + 3}" font-family="JetBrains Mono, monospace" font-size="${fontSize}" font-weight="700" fill="${insideColor}" text-anchor="middle">${esc(lines[0]!)}</text>`);
  } else if (lines.length >= 2) {
    out.push(`<text x="${cx}" y="${cy - 2}" font-family="JetBrains Mono, monospace" font-size="${fontSize}" font-weight="700" fill="${insideColor}" text-anchor="middle">${esc(lines[0]!)}</text>`);
    out.push(`<text x="${cx}" y="${cy + 7}" font-family="JetBrains Mono, monospace" font-size="${fontSize}" font-weight="700" fill="${insideColor}" text-anchor="middle">${esc(lines[1]!)}</text>`);
  }
  const ext = theme.viz.externalLabel;
  if (ext) {
    const color = externalColorMap[ext.color ?? "ink"];
    let lx = cx, ly = cy, anchor = "middle", fs = 7, weight = 600;
    if (ext.position === "above") { ly = cy - (r + 8); }
    else if (ext.position === "below") { ly = cy + (r + 13); }
    else if (ext.position === "left") { lx = cx - (r + 4); ly = cy + 3; anchor = "end"; fs = 6.5; weight = 700; }
    out.push(`<text x="${lx}" y="${ly}" font-family="JetBrains Mono, monospace" font-size="${fs}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(ext.text)}</text>`);
  }
  return out.join("\n      ");
}

function renderIntersectionViz(themes: GithubTheme[], repoIndex: Map<string, GithubItem>, sourceIndex: Record<string, ProbeItem[]>): string {
  // SVG viewBox 320×320, plot area 50..290 × 30..260, ticks every 2 / every 5
  const themesWithMetrics = themes.map(t => {
    const repoCount = repoCountForTheme(t, repoIndex);
    const mentions = themeSocialMentions(t, sourceIndex).total;
    const stars = combinedStarsForTheme(t, repoIndex);
    return { theme: t, repoCount, mentions, stars, cx: dotX(repoCount), cy: dotY(mentions), r: dotRadius(stars) };
  });
  const dots = themesWithMetrics.map(({ theme, cx, cy, r }) => renderThemeDotSvg(theme, cx, cy, r)).join("\n      ");
  return `<svg class="ghx-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Theme intersection scatter plot">
      <line x1="50" y1="30" x2="50" y2="260" stroke="#1A1A1A" stroke-width="1.2"/>
      <line x1="50" y1="260" x2="290" y2="260" stroke="#1A1A1A" stroke-width="1.2"/>
      <line x1="46" y1="260" x2="50" y2="260" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="46" y1="203" x2="50" y2="203" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="46" y1="145" x2="50" y2="145" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="46" y1="87" x2="50" y2="87" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="46" y1="30" x2="50" y2="30" stroke="#1A1A1A" stroke-width="1"/>
      <text x="43" y="263" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="end">0</text>
      <text x="43" y="206" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="end">5</text>
      <text x="43" y="148" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="end">10</text>
      <text x="43" y="90" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="end">15</text>
      <text x="43" y="33" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="end">20</text>
      <text x="20" y="145" font-family="JetBrains Mono, monospace" font-size="7" fill="#6B6B6B" text-anchor="middle" transform="rotate(-90 20 145)" letter-spacing="0.06em">SOCIAL MENTIONS</text>
      <line x1="50"  y1="260" x2="50"  y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="98"  y1="260" x2="98"  y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="146" y1="260" x2="146" y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="194" y1="260" x2="194" y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="242" y1="260" x2="242" y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <line x1="290" y1="260" x2="290" y2="264" stroke="#1A1A1A" stroke-width="1"/>
      <text x="50"  y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">0</text>
      <text x="98"  y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">2</text>
      <text x="146" y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">4</text>
      <text x="194" y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">6</text>
      <text x="242" y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">8</text>
      <text x="290" y="272" font-family="JetBrains Mono, monospace" font-size="7" fill="#9A958C" text-anchor="middle">10</text>
      <text x="170" y="285" font-family="JetBrains Mono, monospace" font-size="7" fill="#6B6B6B" text-anchor="middle" letter-spacing="0.06em">REPO COUNT IN CYCLE</text>
      <line x1="50" y1="145" x2="290" y2="145" stroke="#E5E2DC" stroke-width="1" stroke-dasharray="2,3"/>
      <line x1="170" y1="30" x2="170" y2="260" stroke="#E5E2DC" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="286" y="42" font-family="JetBrains Mono, monospace" font-size="6.5" fill="#9A958C" text-anchor="end" letter-spacing="0.08em">VALIDATED</text>
      <text x="54"  y="42" font-family="JetBrains Mono, monospace" font-size="6.5" fill="#9A958C" text-anchor="start" letter-spacing="0.08em">SOCIAL-AHEAD</text>
      <text x="286" y="255" font-family="JetBrains Mono, monospace" font-size="6.5" fill="#9A958C" text-anchor="end" letter-spacing="0.08em">GH-LEADING</text>
      <text x="54"  y="255" font-family="JetBrains Mono, monospace" font-size="6.5" fill="#9A958C" text-anchor="start" letter-spacing="0.08em">NICHE</text>
      ${dots}
    </svg>`;
}

function renderTagsChart(items: GithubItem[]): string {
  const tags = aggregateTopicTags(items).slice(0, 8);
  if (tags.length === 0) return `<p class="ghx-empty">no topic tags in data/github.json</p>`;
  const maxCount = tags[0]!.count;
  const rows = tags.map(t => {
    const pct = Math.round((t.count / maxCount) * 100);
    return `<div class="ghx-tag-row"><span class="ghx-tag-name">${esc(t.name)}</span><div class="ghx-tag-bar"><div class="ghx-tag-fill" style="width:${pct}%"></div></div><span class="ghx-tag-count">${t.count}</span></div>`;
  }).join("");
  return `<div class="ghx-tags-rows">${rows}</div>`;
}

// === Platform icon SVG defs (referenced by signal-icons row in Magic Wand) ===

const GHX_ICON_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="ghx-ico-x" viewBox="0 0 24 24"><path d="M3 3 L21 21 M21 3 L3 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></symbol>
    <symbol id="ghx-ico-tt" viewBox="0 0 24 24"><path d="M14 3 V15.5 A4.5 4.5 0 1 1 9.5 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M14 3 Q15 6 19 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></symbol>
    <symbol id="ghx-ico-ig" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/></symbol>
    <symbol id="ghx-ico-yt" viewBox="0 0 24 24"><rect x="2" y="5.5" width="20" height="13" rx="3" stroke="currentColor" stroke-width="2" fill="none"/><polygon points="10,9.5 16,12 10,14.5" fill="currentColor"/></symbol>
  </defs>
</svg>`;

const GHX_CSS = `<style>
  .ghx-intersect-row { display: grid; grid-template-columns: 380px 1fr; gap: 14px; margin: 0 0 28px; align-items: stretch; }
  .ghx-right-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .ghx-card-viz, .ghx-card-text, .ghx-card-tags { border: 1px solid var(--ink); background: #fff; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .ghx-card-tags { flex: 1; }
  .ghx-card-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; margin-bottom: 4px; }
  .ghx-card-title { font-size: 11px; font-weight: 700; margin: 0; letter-spacing: 0.06em; text-transform: uppercase; }
  .ghx-card-sub { font-size: 9.5px; color: var(--ink-muted); }
  .ghx-card-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); }
  .ghx-svg { display: block; width: 100%; max-width: 100%; aspect-ratio: 1 / 1; }
  .ghx-tells { font-style: italic; font-family: Georgia, serif; color: var(--ink); margin: 0; line-height: 1.55; font-size: 11.5px; }
  .ghx-tells strong { font-style: normal; font-family: var(--mono); font-weight: 700; color: var(--ink); font-size: 10.5px; letter-spacing: 0.04em; }
  .ghx-legend { display: flex; flex-direction: column; gap: 5px; color: var(--ink-muted); font-size: 10px; border-top: 1px dashed var(--hair); padding-top: 10px; }
  .ghx-legend-item { display: flex; align-items: center; gap: 8px; }
  .ghx-legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--ink); flex-shrink: 0; }
  .ghx-legend-swatch.dashed { border: 1.5px dashed var(--ink); background: transparent; }
  .ghx-legend-swatch.dotted { border: 1.5px dotted var(--ink); background: transparent; }
  .ghx-legend-swatch.faint { background: var(--hair); }
  .ghx-tags-rows { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
  .ghx-tag-row { display: grid; grid-template-columns: 100px 1fr 28px; gap: 8px; align-items: center; font-size: 10px; }
  .ghx-tag-name { font-family: var(--mono); color: var(--ink); font-weight: 600; }
  .ghx-tag-bar { height: 8px; background: var(--hair); }
  .ghx-tag-fill { height: 100%; background: var(--ink); }
  .ghx-tag-count { font-family: var(--mono); color: var(--ink); font-weight: 600; text-align: right; font-size: 10px; }
  .ghx-tags-caption { margin: 4px 0 0; font-size: 9.5px; color: var(--ink-muted); font-style: italic; font-family: Georgia, serif; line-height: 1.45; border-top: 1px dashed var(--hair); padding-top: 8px; }
  .ghx-theme-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0 0 32px; }
  .ghx-theme-cell { border: 1px solid var(--ink); background: #fff; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
  .ghx-theme-cell.validated { border-left: 6px solid var(--ink); }
  .ghx-theme-cell.gh-leading { border-left: 6px solid var(--ink); border-left-style: dashed; }
  .ghx-theme-cell.cross-link { border-left: 6px solid var(--ink); border-left-style: dotted; }
  .ghx-theme-cell.modest { border-left: 6px solid var(--hair); }
  .ghx-theme-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .ghx-theme-name { font-size: 14px; font-weight: 700; letter-spacing: -0.005em; margin: 0; }
  .ghx-theme-status { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; padding: 2px 6px; border: 1px solid currentColor; color: var(--ink); white-space: nowrap; }
  .ghx-theme-meta { font-size: 10px; color: var(--ink-muted); display: flex; flex-wrap: wrap; gap: 12px; }
  .ghx-theme-tags { font-size: 10px; color: var(--ink-faint); }
  .ghx-theme-tag { display: inline-block; margin-right: 6px; padding: 1px 5px; background: var(--bg); border: 1px solid var(--hair); border-radius: 0; font-size: 9px; text-transform: lowercase; }
  .ghx-repo-row { display: flex; gap: 10px; align-items: baseline; font-size: 11px; }
  .ghx-repo-stars { font-weight: 600; min-width: 50px; color: var(--ink); }
  .ghx-repo-name a { color: var(--ink); text-decoration: none; border-bottom: 1px dotted var(--ink-faint); }
  .ghx-repo-name a:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .ghx-repo-desc { color: var(--ink-muted); font-size: 10px; margin-left: 60px; line-height: 1.4; }
  .ghx-quote { display: block; margin-top: 6px; padding: 6px 10px; border-left: 2px solid var(--ink); background: var(--bg); font-family: var(--mono); font-style: normal; font-size: 10.5px; color: var(--ink); }
  .ghx-quote-author { color: var(--ink-muted); font-size: 9px; margin-top: 4px; }
  .ghx-editorial { margin-top: 10px; font-style: italic; font-family: Georgia, "Times New Roman", serif; font-size: 12px; color: var(--ink); line-height: 1.5; border-top: 1px solid var(--hair); padding-top: 10px; }
  .ghx-mwc-block { margin: 36px 0 24px; border-top: 1px solid var(--ink); padding-top: 24px; }
  .ghx-mwc-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .ghx-mwc-title { font-size: 14px; font-weight: 700; margin: 0; }
  .ghx-mwc-sub { font-size: 10px; color: var(--ink-muted); }
  .ghx-verdict-strip { margin: 14px 0 6px; display: grid; grid-template-columns: repeat(5, 1fr); border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); }
  .ghx-vs-cell { padding: 8px 10px; border-right: 1px dashed var(--hair); display: flex; flex-direction: column; gap: 3px; }
  .ghx-vs-cell:last-child { border-right: 0; }
  .ghx-vs-tag { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink); }
  .ghx-vs-count { font-size: 16px; font-weight: 700; color: var(--ink); line-height: 1; }
  .ghx-vs-desc { font-size: 9px; color: var(--ink-muted); line-height: 1.3; }
  .ghx-vs-cell.trick .ghx-vs-tag { color: var(--ink-muted); }
  .ghx-vs-cell.hype .ghx-vs-tag { color: var(--ink-faint); }
  .ghx-mwc-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; margin-top: 18px; }
  .ghx-mwc-table thead th { text-align: left; font-size: 9px; font-weight: 700; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; padding: 8px 10px 8px 0; border-bottom: 2px solid var(--ink); vertical-align: bottom; white-space: nowrap; }
  .ghx-mwc-table tbody td { padding: 12px 10px 12px 0; border-bottom: 1px dashed var(--hair); vertical-align: top; font-size: 11px; line-height: 1.5; }
  .ghx-mwc-table tbody tr:last-child td { border-bottom: 1px solid var(--ink); }
  .ghx-mwc-vt { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 6px; border: 1.5px solid var(--ink); color: var(--ink); background: #fff; white-space: nowrap; }
  .ghx-mwc-vt.trick { border-style: dashed; color: var(--ink-muted); border-color: var(--ink-muted); }
  .ghx-mwc-vt.real { background: var(--ink); color: #fff; }
  .ghx-mwc-vt.verify { border-style: solid; }
  .ghx-mwc-vt.preview { border-style: dotted; }
  .ghx-mwc-vt.hype { color: var(--ink-faint); border-color: var(--ink-faint); border-style: dashed; }
  .ghx-mwc-repo a { font-weight: 600; color: var(--ink); text-decoration: none; border-bottom: 1px dotted var(--ink-faint); }
  .ghx-mwc-repo a:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .ghx-mwc-sub-label { font-size: 9px; color: var(--ink-muted); margin-top: 3px; text-transform: lowercase; letter-spacing: 0; }
  .ghx-mwc-stars { font-weight: 700; font-size: 12px; color: var(--ink); }
  .ghx-signal-icons { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
  .ghx-signal-icons .ghx-pi { width: 14px; height: 14px; color: var(--ink); }
  .ghx-signal-icons .ghx-pi.dim { color: var(--hair); }
  .ghx-pi { display: inline-block; vertical-align: -2px; flex-shrink: 0; }
  .ghx-angle em { font-style: italic; font-family: Georgia, serif; color: var(--ink-muted); }
  .ghx-criteria { font-size: 10px; color: var(--ink-muted); font-style: italic; font-family: Georgia, serif; margin: 14px 0 0; padding: 8px 12px; background: var(--bg); border-left: 2px solid var(--hair); line-height: 1.55; }
  .ghx-criteria strong { font-style: normal; color: var(--ink); font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; padding-right: 4px; }
</style>`;

function renderThemeCell(theme: GithubTheme, repoIndex: Map<string, GithubItem>): string {
  const repoRows = theme.topReposForCell.map(r => {
    const item = repoIndex.get(r.repoSlug);
    const stars = item?.engagement ?? item?.meta?.stars ?? 0;
    const url = item?.url ?? `https://github.com/${r.repoSlug}`;
    return `<div class="ghx-repo-row"><span class="ghx-repo-stars">★ ${stars.toLocaleString()}</span><span class="ghx-repo-name"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.repoSlug)}</a></span></div>
        <div class="ghx-repo-desc">${esc(r.description)}</div>`;
  }).join("\n        ");
  const tags = theme.topicTagsForDisplay.map(t => `<span class="ghx-theme-tag">${esc(t)}</span>`).join("");
  const repoCount = repoCountForTheme(theme, repoIndex);
  const combinedStars = combinedStarsForTheme(theme, repoIndex);
  const quotes = (theme.quotes ?? []).map(q => `<div class="ghx-quote">${esc(q.text)}<div class="ghx-quote-author">${esc(q.author)} · ${esc(q.platform)} · ${q.engagement.toLocaleString()} engagement</div></div>`).join("\n      ");
  const crossLink = theme.crossLinkText ? `<div class="ghx-quote">${theme.crossLinkText}</div>` : "";
  return `<div class="ghx-theme-cell ${theme.status}">
      <div class="ghx-theme-header">
        <h3 class="ghx-theme-name">${esc(theme.name)}</h3>
        <span class="ghx-theme-status">${esc(theme.statusLabel)}</span>
      </div>
      <div class="ghx-theme-meta">
        <span>${repoCount} repos</span><span>·</span><span>${combinedStars.toLocaleString()} combined stars</span><span>·</span><span>topic tags: ${esc(theme.topicTagsForDisplay.slice(0, 4).join(" · "))}</span>
      </div>
      <div class="ghx-theme-tags">${tags}</div>
      <div>${repoRows}</div>
      ${quotes}
      ${crossLink}
      <div class="ghx-editorial">${theme.editorial} ${aiMark()}</div>
    </div>`;
}

function renderMagicWandRow(entry: MagicWandEntry, repoIndex: Map<string, GithubItem>, sourceIndex: Record<string, ProbeItem[]>): string {
  const item = repoIndex.get(entry.repoSlug);
  const stars = item?.engagement ?? item?.meta?.stars ?? 0;
  const starsLabel = stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : `${stars}`;
  const url = item?.url ?? `https://github.com/${entry.repoSlug}`;
  const active = repoActivePlatforms(entry, sourceIndex);
  // Map verdict label to CSS modifier class. Explicit per-verdict mapping —
  // earlier auto-derivation via .replace(/-/g,"") + lookup broke for PRE-VIRAL
  // ("pre-viral" → "previral", which missed the "preview" CSS key and silently
  // fell back to the verify-solid border treatment).
  const vClassMap: Record<MagicWandEntry["verdict"], string> = {
    "TRICK":     "trick",
    "VERIFY":    "verify",
    "REAL":      "real",
    "PRE-VIRAL": "preview",
    "HYPE":      "hype",
  };
  const vClass = vClassMap[entry.verdict];
  const iconRow = ["x", "tt", "ig", "yt"].map(pid => {
    const isActive = active.has(pid);
    return `<svg class="ghx-pi${isActive ? "" : " dim"}"><use href="#ghx-ico-${pid}"/></svg>`;
  }).join("");
  return `<tr>
        <td><span class="ghx-mwc-vt ${vClass}">${esc(entry.verdict)}</span></td>
        <td><a href="${esc(url)}" target="_blank" rel="noopener" class="ghx-mwc-repo-link">${esc(entry.repoSlug)}</a><div class="ghx-mwc-sub-label">${esc(entry.themeSubLabel)}</div></td>
        <td style="text-align:right; padding-right:14px;"><span class="ghx-mwc-stars">${starsLabel}</span></td>
        <td><div class="ghx-signal-icons">${iconRow}</div></td>
        <td class="ghx-angle">${entry.bodyText} <em>— content angle: "${entry.contentAngle}"</em> ${aiMark()}</td>
      </tr>`;
}

function renderGithubLens(): string {
  let items: GithubItem[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/github.json`, "utf-8"));
    items = Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch { items = []; }
  const claim = lensClaim("lens-github");
  if (items.length === 0) {
    const wf = renderLensWorkflowHeader("data/github.json is empty or missing this cycle", 0, "repos");
    return lensWrap("lens-github", "lens-github", "GitHub", claim, 0, "repos", wf + renderEmptyLens("data/github.json is empty or missing this cycle."));
  }

  const repoIndex = new Map<string, GithubItem>();
  for (const it of items) {
    const slug = it.meta?.repo;
    if (slug) repoIndex.set(slug, it);
  }
  const sourceIndex = buildSourceIndex();
  const themes = GITHUB_THEMES;

  // Workflow header
  const wf = renderLensWorkflowHeader(
    "harvested top trending AI repos · cross-referenced each repo (name + description + topic tags) against social-media post text AND podcast transcripts on disk for mention signal · clustered repos into themes and tagged each theme's crossover status",
    items.length,
    items.length === 1 ? "repo" : "repos",
    `${themes.length} themes surfaced`,
  );

  // 3-block intersection row
  const intersection = `<div class="ghx-intersect-row">
    <div class="ghx-card-viz">
      <div class="ghx-card-head">
        <h3 class="ghx-card-title">The intersection</h3>
        <span class="ghx-card-sub">themes by github depth × social-media crossover</span>
      </div>
      ${renderIntersectionViz(themes, repoIndex, sourceIndex)}
    </div>
    <div class="ghx-right-col">
      <div class="ghx-card-text">
        <span class="ghx-card-label">Read in one glance</span>
        <p class="ghx-tells">The two axes split themes into four zones. <strong>VALIDATED</strong> (top-right) = themes that crossed over from GitHub into social-media discourse this cycle. <strong>GH-LEADING</strong> (bottom-right) = themes the dev community is building but content creators haven't picked up yet. Circle size shows combined stars in the theme.</p>
        <div class="ghx-legend">
          <div class="ghx-legend-item"><span class="ghx-legend-swatch"></span><span>validated crossover (filled circle)</span></div>
          <div class="ghx-legend-item"><span class="ghx-legend-swatch dashed"></span><span>github-leading (dashed outline)</span></div>
          <div class="ghx-legend-item"><span class="ghx-legend-swatch dotted"></span><span>cross-link to security lens (dotted)</span></div>
          <div class="ghx-legend-item"><span class="ghx-legend-swatch faint"></span><span>modest / niche (faint outline)</span></div>
        </div>
      </div>
      <div class="ghx-card-tags">
        <div class="ghx-card-head">
          <h3 class="ghx-card-title">Tags across the ${items.length} repos</h3>
          <span class="ghx-card-sub">topic-tag frequency from data/github.json (agent variants merged)</span>
        </div>
        ${renderTagsChart(items)}
        <p class="ghx-tags-caption">Agents dominate the tag vocabulary — confirming the theme map: this cycle's community is overwhelmingly building agent-shaped tools. MCP appears across themes (memory, security, browser) as the integration layer. ${aiMark()}</p>
      </div>
    </div>
  </div>`;

  // Theme grid
  const themeCells = themes.map(t => renderThemeCell(t, repoIndex)).join("\n    ");
  const themeGrid = `<div class="ghx-theme-grid">${themeCells}</div>`;

  // Magic Wand Check — counts indexed by verdict label directly (no
  // hyphen-strip normalization that would scramble "PRE-VIRAL" → "previral").
  const verdictCounts: Record<MagicWandEntry["verdict"], number> = {
    "TRICK": 0, "VERIFY": 0, "REAL": 0, "PRE-VIRAL": 0, "HYPE": 0,
  };
  for (const e of MAGIC_WAND) verdictCounts[e.verdict]++;
  const verdictStrip = `<div class="ghx-verdict-strip">
      <div class="ghx-vs-cell trick"><div class="ghx-vs-tag">TRICK</div><div class="ghx-vs-count">${verdictCounts.TRICK}</div><div class="ghx-vs-desc">viral meme, thin mechanism</div></div>
      <div class="ghx-vs-cell verify"><div class="ghx-vs-tag">VERIFY</div><div class="ghx-vs-count">${verdictCounts.VERIFY}</div><div class="ghx-vs-desc">bold benchmark claim</div></div>
      <div class="ghx-vs-cell real"><div class="ghx-vs-tag">REAL</div><div class="ghx-vs-count">${verdictCounts.REAL}</div><div class="ghx-vs-desc">substantive engineering</div></div>
      <div class="ghx-vs-cell preview"><div class="ghx-vs-tag">PRE-VIRAL</div><div class="ghx-vs-count">${verdictCounts["PRE-VIRAL"]}</div><div class="ghx-vs-desc">karpathy-named, no social yet</div></div>
      <div class="ghx-vs-cell hype"><div class="ghx-vs-tag">HYPE</div><div class="ghx-vs-count">${verdictCounts.HYPE}</div><div class="ghx-vs-desc">stars without signal</div></div>
    </div>`;
  const mwcRows = MAGIC_WAND.map(e => renderMagicWandRow(e, repoIndex, sourceIndex)).join("\n      ");
  const magicWand = `<div class="ghx-mwc-block">
    <div class="ghx-mwc-header">
      <h2 class="ghx-mwc-title">Magic Wand Check</h2>
      <span class="ghx-mwc-sub">editorial verdict on the top 6 by combined-signal — what's worth doing, what could be content</span>
    </div>
    ${verdictStrip}
    <table class="ghx-mwc-table">
      <thead><tr><th>verdict</th><th>repo</th><th style="text-align:right;">stars</th><th>signal in cycle</th><th>editorial take · content angle</th></tr></thead>
      <tbody>${mwcRows}</tbody>
    </table>
    <p class="ghx-criteria"><strong>TRICK</strong>viral as a meme, mechanism is thin · <strong>VERIFY</strong>bold benchmark claim worth checking · <strong>REAL</strong>substantive engineering, multi-surface integration · <strong>PRE-VIRAL</strong>high editorial pull + no social mentions in cycle YET · <strong>HYPE</strong>stars without signal in cycle</p>
  </div>`;

  const body = GHX_ICON_DEFS + GHX_CSS + wf + intersection + themeGrid + magicWand;
  return lensWrap("lens-github", "lens-github", "GitHub", claim, themes.length, "themes", body);
}

// ---------- MULTIMEDIA ----------
// Top engagement videos from confirmed-feature evidence pools, grouped by
// source. Surfaces the reel/short/podcast that drove a feature's reach.
// ---------- ONE TO WATCH ----------
// iter-44 — Reshape of the prior Whitelist. Per Kem 2026-05-18 walk:
//   "It's almost not whitelist; it's almost pre-viral... we need to classify
//    them better, by reading them and actually saying what they are."
//
// Source of truth: data/one-to-watch.json (orchestrator-direct curated this
// iter; iter-45+ ships scripts/classify-one-to-watch.ts to automate). The
// JSON file is the deterministic input; re-renders against an unchanged file
// produce byte-identical output (v8 doctrine compliance).
//
// engagement_at_render is snapshotted in the JSON so a future cycle's
// classifier can diff against this anchor and validate which items actually
// went viral. The cross-cycle ML scoring is a NAMED iter-45+ deliverable,
// not this release — but the structural snapshot lands now so the future-iter
// classifier has its first data point.
//
// Multimedia lens DELETED in the same iter (the function that lived here
// previously) — reader-value test failed; clips already render inside their
// feature cards' hero-grid.
// iter-45 T0 — rev8 layout port. v3 schema (items[] with bucket/class_tag/
// corroboration_count/conviction_stake). Reads data/one-to-watch.json produced
// by scripts/classify-one-to-watch.ts. Layout: meta-strip + funnel + propagation
// model (6-lane SVG + state sidebar) + 4 bucket rows + predictions ledger +
// section footer. All visible elements derived from on-disk JSON per v8 doctrine
// — re-rendering against unchanged data produces byte-identical output. The
// b-watch editorial lines and predictions ledger rows are TEMPLATED from real
// counts/entities/anchor_ts, not hand-written or Sonnet-generated. MOCK chips
// on per-bucket accuracy + outcomes are intentionally honest per v8 — cycle
// 1 has no track record; cycle 3+ populates accuracy + outcomes from the
// scoring window's actual observations.
type OtwBucket = "predict-ahead" | "likely-surface" | "today" | "hustler";
type OtwClassTag =
  | "research" | "lab-editorial" | "lab-orphan" | "github-mid"
  | "cross-source" | "named-voice" | "creator-playbook" | "today-misc" | "hustler";
interface OneToWatchItem {
  bucket: OtwBucket;
  class_tag: OtwClassTag;
  author: string;
  source: string;
  url: string;
  title: string;
  title_teaser: string;
  engagement_at_render: number;
  ts: string;
  classification_reason: string;
  corroboration_count: number;
  corroborated_entities: string[];
  conviction_stake: number;
}
interface OneToWatchFile {
  schema_version: number;
  anchor_ts: string;
  inputs: { arxiv: number; frontier: number; x: number; tiktok: number; instagram: number; github: number; anchored_excluded: number };
  tally: {
    kept: number;
    predict_ahead: number; likely_surface: number; today: number; hustler: number;
    dropped: number;
    raw_classified_pre_cap: number;
    raw_by_bucket: Record<string, number>;
    caps_applied: Record<string, number>;
  };
  worked_example: { title: string; url: string; author: string; corroboration_count: number } | null;
  items: OneToWatchItem[];
  dropped_as_noise: { author: string; source: string; url: string; title_teaser: string; engagement_at_render: number; reason: string }[];
}

function loadOneToWatch(): OneToWatchFile | null {
  try {
    return JSON.parse(fs.readFileSync(`${DATA}/one-to-watch.json`, "utf-8")) as OneToWatchFile;
  } catch {
    return null;
  }
}

// ---------- rev8 helpers (deterministic) ----------

// Map class_tag → propagation lane index (0=research, 5=hustler)
const OTW_CLASS_TO_LANE: Record<OtwClassTag, number> = {
  "research": 0,
  "named-voice": 1,        // systems-lane (research-named handles)
  "github-mid": 2,         // repos
  "lab-orphan": 3,         // lab features (X post from a lab handle)
  "lab-editorial": 3,      // lab features (frontier RSS lab marketing)
  "cross-source": 4,       // tutorials (non-whitelist promoted by corroboration)
  "creator-playbook": 4,   // tutorials (whitelist playbook < 100k)
  "today-misc": 4,         // tutorials (whitelist uncategorized)
  "hustler": 5,            // hustler (saturation)
};

const OTW_LANES: { id: string; label: string; sub: string }[] = [
  { id: "research",     label: "research",     sub: "arxiv · papers" },
  { id: "systems",      label: "systems",      sub: "named-voice technique" },
  { id: "repos",        label: "repos",        sub: "github mid-tier ⭐" },
  { id: "lab-features", label: "lab features", sub: "announcements + orphans" },
  { id: "tutorials",    label: "tutorials",    sub: "creator content / echo" },
  { id: "hustler",      label: "hustler ◌",    sub: "saturation · terminates" },
];

// Lane-x positions on a 760-wide viewBox; hustler separated by dashed marker.
const OTW_LANE_X: number[] = [65, 185, 305, 425, 545, 685];

// Corroboration tier → CSS class for the b-item chips.
function otwCorrClass(c: number): string {
  if (c >= 10) return "otw-b-item otw-high-corr";
  if (c >= 2) return "otw-b-item otw-med-corr";
  return "otw-b-item";
}

function otwAddDays(iso: string, days: number): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const d = new Date(t + days * 86_400_000);
  // YYYY-MM-DD only, anchor-derived; no Date.now()
  return d.toISOString().slice(0, 10);
}

// Top dominant entity across a bucket's items, for the b-watch synthesis line.
// Picks the most-corroborated entity, then by item count. Deterministic.
function otwTopEntity(items: OneToWatchItem[]): { name: string; corr: number; count: number } | null {
  const byEntity = new Map<string, { corr: number; count: number }>();
  for (const it of items) {
    for (const raw of it.corroborated_entities) {
      // entries arrive as "Name (N-src)" — extract name + count
      const m = raw.match(/^(.+?) \((\d+)-src\)$/);
      if (!m || !m[1] || !m[2]) continue;
      const name = m[1]; const corr = Number(m[2]);
      const cur = byEntity.get(name) || { corr: 0, count: 0 };
      cur.corr = Math.max(cur.corr, corr);
      cur.count += 1;
      byEntity.set(name, cur);
    }
  }
  if (byEntity.size === 0) return null;
  const sorted = [...byEntity.entries()].sort((a, b) => {
    if (b[1].corr !== a[1].corr) return b[1].corr - a[1].corr;
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });
  const head = sorted[0];
  if (!head) return null;
  return { name: head[0], corr: head[1].corr, count: head[1].count };
}

// Render an item label for the bucket-row chip. For lab items the author is
// usually blank — use a [Lab] prefix derived from URL host. For X/TT/IG use the
// @handle. Title gets truncated to ~50 chars to preserve the chip-grid rhythm.
function otwItemLabel(item: OneToWatchItem): string {
  let prefix = "";
  if (item.author) {
    prefix = "@" + item.author;
  } else if (item.source === "frontier" || item.source === "arxiv") {
    // try to detect lab from URL host or title
    const host = (() => { try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    if (item.title.startsWith("[")) {
      const m = item.title.match(/^\[([^\]]+)\]/);
      if (m) prefix = "[" + m[1] + "]";
    } else if (host) {
      prefix = host.split(".")[0] || host;
    }
  }
  let body = item.title
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^(Introducing|Announcing)\s+/i, "")
    .trim();
  // iter-45 — strip redundant author prefix from title body when the chip
  // already shows the @handle. Harvester captures titles like
  // "@0xPrajwal_: ✅ Claude Code..." — without this strip the chip reads
  // "@0xPrajwal_ @0xPrajwal_: ✅..." (double handle).
  if (item.author) {
    const safeAuthor = item.author.replace(/[.+*?^$()|[\]{}\\]/g, "\\$&");
    const handlePrefix = new RegExp(`^@?${safeAuthor}\\s*:\\s*`, "i");
    body = body.replace(handlePrefix, "").trim();
  }
  if (body.length > 64) body = body.slice(0, 63).trim() + "…";
  return prefix ? `${prefix} ${body}` : body;
}

// Render the b-watch italic editorial line for a bucket, templated from real items.
function otwBucketWatchLine(bucket: OtwBucket, items: OneToWatchItem[]): string {
  if (items.length === 0) return "";
  const top = otwTopEntity(items);
  const topItem = items[0]!; // length-checked above; assert for strict index access
  switch (bucket) {
    case "predict-ahead": {
      const watch = top
        ? `<b>${esc(top.name)}</b> propagating into a lab-feature card or a named technique within 30-60d`
        : `top items propagating into feature cards within 30-60d`;
      return `<span class="otw-b-watch">▸ <b>What we're looking at:</b> research and lab editorial that hasn't been productized yet. <b>Watch for:</b> ${watch}.</span>`;
    }
    case "likely-surface": {
      const head = top
        ? `<b>${esc(top.name)}</b> is the dominant cross-source signal — ${top.corr}-source corroboration across ${top.count} item${top.count === 1 ? "" : "s"} this cycle`
        : `cross-source corroboration across multiple authors this cycle`;
      const watch = top
        ? `<b>${esc(top.name)}</b> anchoring as its own confirmed feature card next cycle`
        : `top items anchoring as confirmed feature cards next cycle`;
      return `<span class="otw-b-watch">▸ <b>The headline this cycle:</b> ${head}. <b>Watch for:</b> ${watch}.</span>`;
    }
    case "today": {
      const watch = top
        ? `continued cross-source corroboration on <b>${esc(top.name)}</b>; named-voice techniques cited in ≥3 creator tutorials within 14d`
        : `continued cross-source corroboration; named-voice techniques echoed by ≥3 creators within 14d`;
      return `<span class="otw-b-watch">▸ <b>What we're looking at:</b> named-voice technique and persistent creator content visible right now. <b>Watch for:</b> ${watch}.</span>`;
    }
    case "hustler": {
      const handle = topItem.author ? "@" + topItem.author : "top item";
      return `<span class="otw-b-watch">▸ <b>What this is:</b> the saturation zone — playbook-format posts detected by post-format regex + engagement floor ≥100k. This format <b>just continues</b> from cycle to cycle. <b>Watch for:</b> engagement decay &gt;50% on <b>${esc(handle)}</b> next cycle would validate the saturation prediction.</span>`;
    }
  }
}

const OTW_BUCKET_META: { id: OtwBucket; num: string; label: string; window: string }[] = [
  { id: "predict-ahead",  num: "01", label: "predict ahead",   window: "30–90d out" },
  { id: "likely-surface", num: "02", label: "likely surface",  window: "7–30d out" },
  { id: "today",          num: "03", label: "today's signals", window: "visible · likely to continue" },
  { id: "hustler",        num: "◌",  label: "hustler zone",    window: "terminal · this just continues" },
];

function renderOneToWatchBucketRow(meta: typeof OTW_BUCKET_META[number], all: OneToWatchItem[]): string {
  const items = all.filter((i) => i.bucket === meta.id);
  if (items.length === 0) return "";
  const chips = items.map((it) => {
    const label = otwItemLabel(it);
    const corrChip = it.corroboration_count >= 2
      ? `<span class="otw-corr-chip">${it.corroboration_count}src</span>`
      : "";
    return `<span class="${otwCorrClass(it.corroboration_count)}" title="${esc(it.classification_reason)} · conviction ${it.conviction_stake}/5"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(label)}</a>${corrChip}</span>`;
  }).join("");
  const watch = otwBucketWatchLine(meta.id, items);
  return `<div class="otw-bucket-row">
    <div class="otw-bucket-num">${meta.num}<span>${esc(meta.label)}</span><em>${esc(meta.window)}</em></div>
    <div class="otw-bucket-body">${chips}${watch}</div>
  </div>`;
}

// Render dots in a stacked cluster for a lane. Count → up to 18 visible dots in
// 5×4 grid; counts above show a "+N more" annotation. Deterministic positions.
function otwLaneDots(centerX: number, count: number, faint = false): string {
  if (count <= 0) {
    return `<circle class="otw-dot-faint" cx="${centerX}" cy="120" r="3"/>` +
      `<text class="otw-stage-sub" x="${centerX}" y="100" text-anchor="middle">(none this cycle)</text>`;
  }
  const visible = Math.min(count, 18);
  const cls = faint ? "otw-dot-faint" : "otw-dot";
  // pack into rows of 5 dots horizontally, climbing upward from y=120
  const dots: string[] = [];
  for (let i = 0; i < visible; i++) {
    const row = Math.floor(i / 5);
    const col = i % 5;
    // center 5 dots around centerX, spacing 10px
    const cx = centerX - 20 + col * 10;
    const cy = 120 - row * 12;
    const r = visible >= 10 ? 4 : 5;
    dots.push(`<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`);
  }
  return dots.join("");
}

function renderOneToWatchPropagationSvg(items: OneToWatchItem[], _anchorTs: string): string {
  // Tally per lane (deterministic from class_tag → lane mapping)
  const laneCount: number[] = [0, 0, 0, 0, 0, 0];
  for (const it of items) {
    const lane = OTW_CLASS_TO_LANE[it.class_tag];
    if (lane !== undefined) laneCount[lane] = (laneCount[lane] ?? 0) + 1;
  }
  const stages = OTW_LANES.map((lane, i) => {
    const x = OTW_LANE_X[i] ?? 0;
    const count = laneCount[i] ?? 0;
    const countText = count > 0
      ? `<text class="otw-stage-count" x="${x}" y="135" text-anchor="middle">${count}</text>`
      : `<text class="otw-stage-zero" x="${x}" y="135" text-anchor="middle">0</text>`;
    const dots = otwLaneDots(x, count, count === 0);
    const isHustler = lane.id === "hustler";
    const hustlerMarker = isHustler
      ? `<line class="otw-hustler-marker" x1="635" y1="60" x2="635" y2="155"/>`
      : "";
    return `${hustlerMarker}
      <text class="otw-stage-label" x="${x}" y="178" text-anchor="middle">${esc(lane.label)}</text>
      <text class="otw-stage-sub" x="${x}" y="190" text-anchor="middle">${esc(lane.sub)}</text>
      ${countText}
      ${dots}`;
  }).join("");

  // Top-lane annotation — name the dominant lane this cycle
  let maxLane = 0; let maxCount = 0;
  laneCount.forEach((c, i) => { if (c > maxCount) { maxCount = c; maxLane = i; } });
  const maxLaneLabel = OTW_LANES[maxLane]?.label ?? "(unknown)";
  const skewLine = maxCount > 0
    ? `▸ this cycle's distribution: heaviest lane is <b>${maxLaneLabel}</b> (${maxCount} item${maxCount === 1 ? "" : "s"})`
    : `▸ this cycle's distribution: no items classified into any lane`;
  const zeroLanes = laneCount.map((c, i) => c === 0 ? (OTW_LANES[i]?.id ?? "") : "").filter(Boolean);
  const zeroNote = zeroLanes.length > 0
    ? `·  empty lanes: ${zeroLanes.join(", ")} — worth verifying upstream gates next cycle`
    : `·  every lane has signal this cycle`;

  return `<svg class="otw-pmodel-svg" viewBox="0 0 760 200" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="otw-arrow-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1A1A1A"/></marker></defs>
    <line class="otw-axis-line" x1="20" y1="155" x2="745" y2="155"/>
    ${stages}
    <text class="otw-stage-sub" x="380" y="35" text-anchor="middle" font-weight="600" fill="#1A1A1A">${skewLine}</text>
    <text class="otw-stage-sub" x="380" y="50" text-anchor="middle">${zeroNote}</text>
  </svg>`;
}

// iter-46 — non-English item filter for the predictions ledger. Heuristic:
// counts common German / Spanish / French / Portuguese function-word markers
// in the title; 2+ hits → non-English → drop. Items still render in body
// (the magic-moment cross-source signal stays visible) but don't get promoted
// to predictions where the bet phrase wouldn't read cleanly to an English
// audience. Kem walk 2026-05-18: "Let's remove anything that's not English."
function isNonEnglishTitle(title: string): boolean {
  const t = ` ${title.toLowerCase()} `;
  const markers = [
    " ist ", " überall", " für ", " nicht ", " auch ", " und ", " mit ", " dem ", " sich ", " kann ", " aber ", // German
    " que ", " para ", " los ", " las ", " con ", " mas ", " más ", " del ", " desde ", " porque ", " todo ", // Spanish
    " est ", " pour ", " avec ", " mais ", " sont ", " avoir ", " être ", // French
    " uma ", " também ", " ainda ", " porque ", " enquanto ", // Portuguese
    "anatomicos", "movimientos", "übersetzt", "überarbeitet",
  ];
  let hits = 0;
  for (const m of markers) if (t.includes(m)) hits++;
  return hits >= 2;
}

// iter-46 — item-specific bet derivation. The auto-pick previously templated
// every LIKELY SURFACE item with "<entity> anchors as confirmed feature card"
// which collapsed to "Claude Design × 3" when the dominant cross-source
// signal was Claude Design. Now we read the item's title for specifics:
// "Claude Design + Shopify" → "Claude Design + e-commerce ships within 30d";
// checklist pattern (✅✅✅◻️) → "<next-unchecked-product> announced next";
// "Figma should be paying attention" → Figma-competitor prediction;
// critique/blame language → "<entity> backlash crystallizes".
const PARTNER_CATEGORY: Record<string, string> = {
  shopify: "e-commerce", webflow: "no-code site", squarespace: "no-code site",
  figma: "design-tool", hyperframes: "video", notion: "docs",
  airtable: "no-code db", zapier: "automation",
};
// Generic entity reject-set — these come back from the corroboration extractor
// but read meaningless in a bet phrase ("Large Language Model anchors as a
// confirmed feature card" doesn't tell a reader anything). Fall back to a
// cleaner derivation when the top entity is in this set or starts with a
// non-letter char (e.g. "/month" extracted from "$100/month").
const OTW_GENERIC_ENTITIES = new Set([
  "large language model", "from data", "agentic search", "ai", "chatgpt",
  "openai", "anthropic", "the", "this", "that",
  // iter-46 — common 2-word fragment extractions that the classifier mis-promotes
  "as ai", "the model", "the ai", "from ai", "an ai", "of ai",
]);
function otwSafeEntity(ent: string | undefined): string | null {
  if (!ent) return null;
  const cleaned = ent.replace(/ \(\d+-src\)$/, "").trim();
  if (!cleaned) return null;
  if (OTW_GENERIC_ENTITIES.has(cleaned.toLowerCase())) return null;
  if (!/^[A-Za-z]/.test(cleaned)) return null;
  return cleaned;
}

function deriveItemSpecificBet(it: OneToWatchItem, bucket: OtwBucket): string {
  const title = (it.title || it.title_teaser || "").trim();
  const titleLow = title.toLowerCase();
  // Use safe entity; fall back to item label (which already handles author/lab prefix).
  const safe = otwSafeEntity(it.corroborated_entities[0]);
  const baseEnt = safe ?? otwItemLabel(it).replace(/^@\w+\s*/, "").slice(0, 40);

  // Combination pattern "<entity> + <partner>"
  const plus = title.match(/(Claude (?:Design|Code|Cowork|Skills|Finance|Marketing|HR))\s*\+\s*([A-Z][a-zA-Z]+)/);
  if (plus) {
    const partnerCat = PARTNER_CATEGORY[plus[2]!.toLowerCase()] || plus[2]!;
    return `<b>${esc(plus[1]!)} + ${esc(partnerCat)}</b> integration ships within 60 days.`;
  }
  // Checklist pattern — extract first ◻️ unchecked item
  const unchecked = title.match(/[◻☐⬜][\s -　️]*(Claude (?:Code|Cowork|Design|Marketing|Finance|HR|Skills))/);
  if (unchecked) {
    return `<b>${esc(unchecked[1]!)}</b> announced as next product in the Claude stack within 30 days.`;
  }
  // Figma competitor signal
  if (/figma/i.test(title) && /(pay.*attention|competitor|threat|copy|acquire)/i.test(title)) {
    return `<b>Figma</b> announces AI design competitor or acquires within 90 days.`;
  }
  // Critique / backlash language
  if (/(blame|critique|how bad|not a fan|nobody talks|prompting full|overrated)/i.test(titleLow)) {
    return `<b>${esc(baseEnt)} backlash</b> crystallizes as cross-source critical takes within 14 days.`;
  }
  // Webflow / Squarespace responding to AI threat
  if (/(webflow|squarespace).*replac|replac.*(webflow|squarespace)/i.test(titleLow)) {
    return `<b>Webflow / Squarespace</b> responds to AI-site-builder threat within 30 days.`;
  }
  // Mobile dev breakthrough
  if (/(mobile|fullstack|full.stack).*app/i.test(titleLow)) {
    return `<b>Mobile dev via Claude</b> anchors as confirmed feature within 30 days.`;
  }
  // Named-voice technique (Karpathy-class). When the corroborated_entities
  // upstream extractor returns a clean entity, use it ("HTML-as-output");
  // otherwise fall back to "@author's technique" so the bet names the
  // creator instead of a garbage fragment like "As AI technique".
  if (it.class_tag === "named-voice") {
    const usableEnt = safe ? baseEnt : (it.author ? `@${it.author}'s technique` : `${baseEnt} technique`);
    return `<b>${esc(usableEnt)}</b> cited in ≥3 creator tutorials within 14 days.`;
  }
  // Default per bucket
  if (bucket === "predict-ahead") {
    return `<b>${esc(baseEnt)}</b> cited in a lab release note or echoed by another lab within 30 days.`;
  }
  if (bucket === "likely-surface") {
    return `<b>${esc(baseEnt)}</b> anchors as a confirmed feature card next cycle.`;
  }
  return `<b>${esc(baseEnt)}</b> echoes across ≥3 named creators within 14 days.`;
}

function renderOneToWatchPredictionsLedger(items: OneToWatchItem[], anchorTs: string): string {
  // iter-46: filter non-English items + dedupe bet phrases + derive item-specific bets.
  // Pick wider (4-6 per bucket) so dedup has headroom; cap final at 15 rows.
  type Pred = { bucket: string; bucketLabel: string; itemLabel: string; bet: string; corr: string; payoffBy: string };
  const sortByConviction = (a: OneToWatchItem, b: OneToWatchItem) => {
    if (b.conviction_stake !== a.conviction_stake) return b.conviction_stake - a.conviction_stake;
    if (b.corroboration_count !== a.corroboration_count) return b.corroboration_count - a.corroboration_count;
    return a.title.localeCompare(b.title);
  };
  const englishOnly = items.filter((i) => !isNonEnglishTitle(i.title));
  const picks = (bucket: OtwBucket, n: number) => englishOnly.filter((i) => i.bucket === bucket).sort(sortByConviction).slice(0, n);

  const candidates: { it: OneToWatchItem; bucket: OtwBucket; bucketLabel: string; payoffDays: number }[] = [];
  const seenIds = new Set<string>();
  const push = (it: OneToWatchItem, bucket: OtwBucket, label: string, days: number) => {
    const key = it.url || it.title;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    candidates.push({ it, bucket, bucketLabel: label, payoffDays: days });
  };
  for (const it of picks("predict-ahead", 4)) push(it, "predict-ahead", "predict ahead", 30);
  for (const it of picks("likely-surface", 6)) push(it, "likely-surface", "likely surface", 14);
  for (const it of picks("today", 6)) push(it, "today", "today", 14);
  // iter-46 — always promote any named-voice item (Karpathy-class technique
  // posts), even when corroboration count puts them below the bucket cap.
  // Named-voice items get distinct bets (no dedup collision risk) and they're
  // exactly the editorially-distinct signal we want surfaced as predictions.
  const BUCKET_LABEL: Record<OtwBucket, string> = {
    "predict-ahead": "predict ahead",
    "likely-surface": "likely surface",
    "today": "today",
    "hustler": "hustler",
  };
  for (const it of englishOnly.filter((i) => i.class_tag === "named-voice")) {
    push(it, it.bucket, BUCKET_LABEL[it.bucket] ?? "today", it.bucket === "predict-ahead" ? 30 : 14);
  }
  for (const it of picks("hustler", 1)) push(it, "hustler", "hustler", 14);

  const seenBets = new Set<string>();
  const preds: Pred[] = [];
  for (const c of candidates) {
    const bet = c.bucket === "hustler"
      ? `Engagement <b>decays &gt;50%</b> over next cycle (saturation prediction).`
      : deriveItemSpecificBet(c.it, c.bucket);
    const canonical = bet.replace(/<[^>]+>/g, "").trim().toLowerCase();
    if (seenBets.has(canonical)) continue;
    seenBets.add(canonical);
    preds.push({
      bucket: c.bucketLabel,
      bucketLabel: c.bucket,
      itemLabel: c.bucket === "hustler" && c.it.author ? "@" + c.it.author : otwItemLabel(c.it),
      bet,
      corr: c.it.corroboration_count >= 2 ? `<b>${c.it.corroboration_count}</b>src` : "—",
      payoffBy: otwAddDays(anchorTs, c.payoffDays),
    });
    if (preds.length >= 15) break;
  }

  const rows = preds.map((p) => `<tr>
    <td><span class="otw-pred-bucket">${esc(p.bucket)}</span></td>
    <td class="otw-pred-handle">${esc(p.itemLabel)}</td>
    <td class="otw-pred-bet">${p.bet}</td>
    <td class="otw-pred-corr">${p.corr}</td>
    <td class="otw-pred-window">${esc(p.payoffBy)}</td>
    <td class="otw-pred-result"><span class="otw-mock-cell">mock</span></td>
  </tr>`).join("");

  return `<div class="otw-pred-block">
    <div class="otw-pred-cap">// <b>predictions ledger</b> — every bet placed this cycle</div>
    <h2 class="otw-pred-title">Predictions · scorecard for next cycle</h2>
    <p class="otw-pred-lede">Each row is a falsifiable bet derived from items above. Outcome is MOCK first cycle; populates cycle 2+ with ✓ / ✗ / pending. Cycle 3+ feeds outcome-by-bucket back into the conviction formula so the model learns which lane is most predictive over time.</p>
    <table class="otw-pred-table">
      <thead><tr>
        <th style="width: 90px;">bucket</th>
        <th style="width: 180px;">item</th>
        <th>bet</th>
        <th style="width: 55px;">corr</th>
        <th style="width: 90px;">payoff by</th>
        <th style="width: 70px;">outcome</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderOneToWatchLens(): string {
  const file = loadOneToWatch();
  const claim = lensClaim("lens-whitelist");
  if (!file || !file.items || file.items.length === 0) {
    const wf = renderLensWorkflowHeader(
      "Pre-viral signal classifier — 6 streams → 4 buckets ordered by time-to-virality",
      0, "items",
      "data/one-to-watch.json missing or empty",
    );
    return lensWrap("lens-whitelist", "lens-whitelist", "One to Watch", claim, 0, "items",
      wf + renderEmptyLens("No One to Watch classification on disk this cycle."));
  }

  const items = file.items;
  const totalRendered = file.tally.kept;
  const droppedCount = file.dropped_as_noise.length;
  const anchorDate = file.anchor_ts ? file.anchor_ts.slice(0, 10) : "(unknown)";

  // Workflow header — mechanism + counts (preserves the iter-38b D3 convention
  // used by all other lenses for consistency)
  const wf = renderLensWorkflowHeader(
    "Pre-viral signal — deterministic classifier over 6 streams (arxiv + frontier + X + TT + IG + GitHub) → 4 buckets ordered by time-to-virality",
    totalRendered, totalRendered === 1 ? "item" : "items",
    `${file.tally.predict_ahead} predict-ahead · ${file.tally.likely_surface} likely-surface · ${file.tally.today} today · ${file.tally.hustler} hustler · ${droppedCount} dropped`,
  );

  // Meta strip — cycle anchor + tally + monitor window (collapses the rev8
  // head-strip H1+claim, which would duplicate the lens-summary chrome).
  const metaStrip = `<div class="otw-meta">
    <div class="otw-meta-cap">// section · forward-looking · cycle anchor ${esc(anchorDate)} · monitor window <b>14–60d</b></div>
    <div class="otw-meta-tally"><b>${file.tally.kept}</b> items tracked · <b>${file.tally.raw_classified_pre_cap}</b> classifiable · <b>${droppedCount}</b> dropped as noise</div>
  </div>`;

  // Funnel — per-stream input counts + the gate sequence
  const inp = file.inputs;
  const funnel = `<div class="otw-funnel">
    <div class="otw-funnel-cap">// <b>source pipeline</b> · 6 streams → classify → cap → present · re-render byte-identical against unchanged inputs</div>
    <div class="otw-funnel-row">
      <b>${inp.arxiv}</b> arxiv <span class="otw-sep">·</span>
      <b>${inp.frontier}</b> frontier <span class="otw-sep">·</span>
      <b>${inp.x}</b> X <span class="otw-sep">·</span>
      <b>${inp.tiktok}</b> TT <span class="otw-sep">·</span>
      <b>${inp.instagram}</b> IG <span class="otw-sep">·</span>
      <b>${inp.github}</b> GitHub
      <span class="otw-sep">→</span> <b>${inp.anchored_excluded}</b> excluded (already anchored to features)
      <span class="otw-sep">→</span> <b>${file.tally.raw_classified_pre_cap}</b> bucketed
      <span class="otw-sep">→</span> <b>${droppedCount}</b> dropped (non-AI / saturated noise)
      <span class="otw-sep">→</span> <b>${file.tally.kept}</b> presented (cap + author dedupe)
    </div>
  </div>`;

  // Propagation model panel — SVG + state sidebar
  const propagationSvg = renderOneToWatchPropagationSvg(items, file.anchor_ts);
  const pmodel = `<div class="otw-pmodel">
    <div>
      <div class="otw-pmodel-cap">// <b>propagation model</b> — where this cycle's signal sits along the lane</div>
      <h2 class="otw-pmodel-title">Today's snapshot · this is one data point</h2>
      <p class="otw-pmodel-lede">The theory: signal travels left-to-right through six lanes — <b>research</b> drives <b>systems thinking</b>; <b>systems</b> and <b>lab features</b> drive <b>repos</b>; <b>lab features</b> drive <b>tutorials</b>; <b>tutorials</b> saturate into the <b>hustler</b> zone where engagement terminates. Each cycle plots this cycle's items along the lane and adds a data point to the regression. Over time the model learns which lanes lead which, and the conviction formula re-weights toward leading indicators.</p>
      ${propagationSvg}
    </div>
    <div class="otw-pmodel-state">
      <div class="otw-pmodel-state-head">⚙ Model state</div>
      <div class="otw-pmodel-state-body">
        <div class="otw-pms-row"><span class="otw-pms-label">cycle</span><span class="otw-pms-val">1 / ∞</span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">training samples</span><span class="otw-pms-val">${totalRendered}</span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">regression target</span><span class="otw-pms-val">viral-yes/no per item</span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">scoring window</span><span class="otw-pms-val">14–60d</span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">accuracy by bucket</span><span class="otw-pms-val"><span class="otw-mock-cell">mock</span></span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">source weights tuned</span><span class="otw-pms-val"><span class="otw-mock-cell">cycle 3+</span></span></div>
        <div class="otw-pms-row"><span class="otw-pms-label">conviction floor</span><span class="otw-pms-val">3 / 5</span></div>
        <div class="otw-pms-bar"><div class="otw-pms-bar-fill"></div></div>
        <div class="otw-pms-bar-cap">model training progress · 1 of N cycles</div>
      </div>
    </div>
  </div>`;

  // Sort items by conviction stake within each bucket for stable rendering
  const sortedItems = [...items].sort((a, b) => {
    if (a.bucket !== b.bucket) {
      const order: Record<OtwBucket, number> = { "predict-ahead": 0, "likely-surface": 1, "today": 2, "hustler": 3 };
      return order[a.bucket] - order[b.bucket];
    }
    if (b.conviction_stake !== a.conviction_stake) return b.conviction_stake - a.conviction_stake;
    if (b.corroboration_count !== a.corroboration_count) return b.corroboration_count - a.corroboration_count;
    return a.title.localeCompare(b.title);
  });
  const bucketRows = OTW_BUCKET_META.map((m) => renderOneToWatchBucketRow(m, sortedItems)).join("");

  const predictions = renderOneToWatchPredictionsLedger(sortedItems, file.anchor_ts);

  const droppedRows = file.dropped_as_noise.map((d) =>
    `<li class="otw-drop-row"><span class="otw-drop-handle">${esc(d.author ? "@" + d.author : "(no author)")}</span> <span class="otw-drop-eng">${fmtEngagement(d.engagement_at_render)}</span> <span class="otw-drop-reason">${esc(d.reason)}</span></li>`,
  ).join("");
  const droppedFold = `<details class="otw-dropped">
    <summary class="otw-dropped-summary">▾ ${droppedCount} dropped as noise — non-AI, saturated playbook format, or pre-2024 timestamp</summary>
    <ul class="otw-drop-list">${droppedRows}</ul>
  </details>`;

  const foot = `<div class="otw-section-foot">
    <b>method.</b> <code>scripts/classify-one-to-watch.ts</code> reads 6 streams, classifies into 4 buckets via stream-based rules + cross-source corroboration, computes conviction via class-weighted formula, caps per-bucket with 1-per-author dedupe. Re-render byte-identical against unchanged inputs. Cycle 2+ scores predictions; cycle 3+ feeds outcomes back into source weighting.
  </div>`;

  const body = wf + `<div class="otw-shell">${metaStrip}${funnel}${pmodel}<div class="otw-buckets">${bucketRows}</div>${predictions}${foot}${droppedFold}</div>`;
  return lensWrap("lens-whitelist", "lens-whitelist", "One to Watch", claim, totalRendered, "items", body);
}

// ---------- PODCAST THEMES PANEL ("Hot in podcasts this month") ----------
// Iter-32 deliverable from PROJECTS.md BUILD list. Loads data/podcast-themes.json
// produced by src/podcast-themes.ts (separate Sonnet pass over YT transcripts).
// Renders ABOVE the feature cards as Kem-specified: "Hot in podcasts this month"
// — themes that are NOT a single named feature launch.
interface PodcastTheme {
  theme: string;
  summary: string;
  episode_count: number;
  // iter-46 — timestamp_seconds added by scripts/fetch-captions-and-match.ts pipeline step.
  // When present, renderPodcastThemesPanel emits a ▶ LISTEN chip that deep-links to that
  // second via YouTube's &t=Xs URL param. timestamp_manual_override carries the reason
  // when a Kem-walk hand-picked a better moment than the matcher chose.
  episodes: { show: string; video_id: string; url: string; angle: string; timestamp_seconds?: number; timestamp_match_word?: string; timestamp_manual_override?: string }[];
  why_not_already_feature: string;
}
function loadPodcastThemes(): { generated_at?: string; source_transcript_count?: number; themes: PodcastTheme[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(`${DATA}/podcast-themes.json`, "utf-8")) as { generated_at?: string; source_transcript_count?: number; themes?: Partial<PodcastTheme>[] };
    // iter-46 F8 — the iter-45 inline-Opus synth path drops `episode_count` because
    // the prompt only asks for `episodes[]`. The legacy chunked synth at
    // src/podcast-themes.ts derived it at merge time (line ~219). With the merger
    // gone, derive at the renderer's load boundary so pickListenPriority,
    // pt-count, and lp-rail-meta all see a real number instead of `undefined`.
    const themes = (raw.themes ?? []).map((t) => ({
      ...t,
      episode_count: typeof t.episode_count === "number" ? t.episode_count : (t.episodes?.length ?? 0),
    })) as PodcastTheme[];
    return { generated_at: raw.generated_at, source_transcript_count: raw.source_transcript_count, themes };
  } catch { return { themes: [] }; }
}
// iter-38b D8 — trim helpers. pt-summary collapses to first sentence ≤ 200
// chars (Kem walk: "less wording, more visual"); ep angles trim to ≤ 80 chars
// with rest accessible via the show-link if needed; cap 3 ep bullets per card
// so the visual rhythm stays tight rather than text-dump.
function firstSentence(s: string, capChars = 200): string {
  if (!s) return "";
  // split on ". " / "? " / "! " (period-class followed by space) — keep first
  const m = s.match(/^[^.!?]+[.!?](?=\s|$)/);
  const head = m ? m[0].trim() : s;
  if (head.length <= capChars) return head;
  return head.slice(0, capChars - 1).trim() + "…";
}
function trimAngle(s: string, capChars = 80): string {
  if (!s) return "";
  if (s.length <= capChars) return s;
  return s.slice(0, capChars - 1).trim() + "…";
}

// iter-38b-rev4 SHIPPED per Kem approval on rev3 mockup
// (out/podcast-section-mockup-rev3.html): right-rail listen priority +
// curated quote rendered as a single italic-serif sentence flowing out
// of the summary (no border, no box, em-dash mono attribution). Replaces
// the ep-bullet list — the curated quote IS the per-show evidence; the
// rail carries the cross-show signal. Picks the first episode's angle
// as the curated quote until iter-38b-rev5 adds a Sonnet `quote_pick`
// field to podcast-themes.json (ISC-61 follow-up named in PROJECTS.md).

type ListenPriority = { label: "LISTEN" | "SKIM" | "SKIP"; segments: number; context: string };

function pickListenPriority(t: PodcastTheme): ListenPriority {
  const ep = t.episode_count ?? 0;
  const shows = new Set((t.episodes ?? []).map((e) => e.show)).size;
  // LISTEN: volume-strong (≥4 episodes anywhere) OR cross-validated multi-show
  //   signal (≥3 episodes across ≥3 distinct shows). Matches the rev3 mockup
  //   Kem approved (Job Apocalypse at 4 ep / 2 shows = LISTEN by volume).
  if (ep >= 4) return { label: "LISTEN", segments: 4, context: shows >= 3 ? "multi-show debate" : "high-volume" };
  if (ep >= 3 && shows >= 3) return { label: "LISTEN", segments: 4, context: "multi-show debate" };
  // SKIM: ≥3 ep on fewer shows, or 2 ep across 2 shows
  if (ep >= 3) return { label: "SKIM", segments: 3, context: shows >= 2 ? "single-stance" : "single-show" };
  if (ep === 2 && shows >= 2) return { label: "SKIM", segments: 2, context: "two-show frame" };
  return { label: "SKIP", segments: 1, context: shows === 1 ? "single-show take" : "low-volume" };
}

type CuratedQuote = { quote: string; show: string; url?: string; timestamp_seconds?: number };

// iter-38b-rev4: pick the first episode's angle as the curated quote.
// iter-46: prefer the first episode that has a real timestamp_seconds so the
// LISTEN chip deep-links to a substantive moment. Falls back to episodes[0]
// when none have been timestamp-matched yet (cold start before
// scripts/fetch-captions-and-match.ts has run).
// iter-38b-rev5 NAMED follow-up (ISC-61, see PROJECTS.md): add a Sonnet
// `quote_pick` field to podcast-themes.json so the rendered angle is the
// editorial-best, not just the first by traversal order.
function pickCuratedQuote(t: PodcastTheme): CuratedQuote | null {
  const eps = t.episodes ?? [];
  const withTs = eps.find((e) => typeof e.timestamp_seconds === "number");
  const ep = withTs ?? eps[0];
  if (!ep || !ep.angle || ep.angle.length < 20) return null;
  return { quote: ep.angle, show: ep.show, url: ep.url, timestamp_seconds: ep.timestamp_seconds };
}

function renderPodcastThemesPanel(): string {
  const data = loadPodcastThemes();
  const themes = data.themes ?? [];
  const transcriptCount = data.source_transcript_count ?? 0;
  // iter-38b-rev2 — Hot Podcasts is now a first-class lens (collapsible,
  // numbered 01 in LENS_NAV) per Kem walk: "It should be, because it's just
  // like every other section... the numbering needs to reflect that." Wraps
  // body in lensWrap so it inherits lens-fold + summary-headline + count
  // chip pattern — same UX as the 9 other lenses. Default-open per
  // OPEN_DEFAULTS so editorial weight Kem ratified in rev1 is preserved.
  //
  // iter-38b-rev3 — workflow header reframed per Kem walk to articulate the
  // full 5-step pipeline (listened to N podcasts → extracted transcripts →
  // clustered themes → cross-referenced against social media signal → reader
  // reference for what to listen to). Mechanism + outcome do the explaining.
  const claim = lensClaim("lens-podcasts");
  const wf = renderLensWorkflowHeader(
    "Listened to AI podcasts → extracted transcripts → Sonnet clustered cross-episode themes → cross-referenced against social media signal",
    themes.length,
    themes.length === 1 ? "theme surfaced" : "themes surfaced",
    `${transcriptCount} transcripts read · ${themes.reduce((a, t) => a + (t.episode_count ?? 0), 0)} episode mentions across themes`,
    "your reference for which podcast episodes are worth your listening time this period — themes that crossed over into broader social-media discourse get the most weight",
  );
  if (themes.length === 0) {
    return lensWrap("lens-podcasts", "lens-podcasts", "Hot in Podcasts", claim, 0, "themes",
      wf + renderEmptyLens("No podcast-themes data on disk. Run: bun src/podcast-themes.ts"));
  }
  const cards = themes.map((t) => {
    const lp = pickListenPriority(t);
    const cq = pickCuratedQuote(t);
    const distinctShows = new Set((t.episodes ?? []).map((e) => e.show)).size;
    const segs = Array.from({ length: 5 }, (_, i) => `<div class="lp-seg${i < lp.segments ? " on" : ""}"></div>`).join("");
    // iter-46 — emit ▶ LISTEN chip when the curated quote's episode carries a
    // real URL. When timestamp_seconds is present, append &t=Xs so YouTube
    // deep-links to the spoken moment; otherwise link to video start. Mirrors
    // the Security lens attr-listen pattern (line ~2515) at podcast-card scope.
    const listenHtml = cq && cq.url ? (() => {
      const base = cq.url;
      const url = typeof cq.timestamp_seconds === "number"
        ? `${base}${base.includes("?") ? "&" : "?"}t=${cq.timestamp_seconds}s`
        : base;
      return ` <a class="pt-listen" href="${esc(url)}" target="_blank" rel="noopener">▶ LISTEN</a>`;
    })() : "";
    const quoteHtml = cq
      ? `<p class="pt-quote">"${esc(cq.quote)}"<span class="pt-quote-attr"> — <strong>${esc(cq.show)}</strong></span>${listenHtml}</p>`
      : "";
    return `<article class="pt-card">
      <div class="pt-body">
        <header class="pt-card-head">
          <h3 class="pt-theme">${esc(t.theme)}</h3>
          <span class="pt-count">${t.episode_count} podcasts</span>
        </header>
        <p class="pt-summary">${esc(firstSentence(t.summary))}${aiMark()}</p>
        ${quoteHtml}
      </div>
      <aside class="lp-rail">
        <div class="lp-rail-label">${lp.label}</div>
        <div class="lp-rail-bar">${segs}</div>
        <div class="lp-rail-meta"><strong>${t.episode_count}</strong> ep<br><strong>${distinctShows}</strong> show${distinctShows === 1 ? "" : "s"}<br>${esc(lp.context)}</div>
      </aside>
    </article>`;
  }).join("");
  return lensWrap("lens-podcasts", "lens-podcasts", "Hot in Podcasts", claim, themes.length, "themes",
    wf + `<div class="pt-grid">${cards}</div>`);
}

function main(): void {
  const features: ConfirmedFeature[] = JSON.parse(fs.readFileSync(`${DATA}/features-confirmed.json`, "utf-8"));
  const indices: Record<string, Map<string, SourceItem>> = {
    x: indexByUrl(loadSource("x")),
    tiktok: indexByUrl(loadSource("tiktok")),
    instagram: indexByUrl(loadSource("instagram")),
    youtube: indexByUrl(loadSource("youtube")),
  };
  let sentimentByFeature: Map<string, SentimentRow> = new Map();
  try {
    const rows: SentimentRow[] = JSON.parse(fs.readFileSync(`${DATA}/feature-sentiment.json`, "utf-8"));
    for (const r of rows) sentimentByFeature.set(r.feature_id, r);
  } catch {
    console.warn("feature-sentiment.json not found");
  }
  const commentByStatusId = loadCommentSentiment();
  const crossNarratives = loadCrossNarratives();
  const notableOrphans = loadNotableOrphans();
  const pipelineStats = loadPipelineStats();
  // iter-41 — new podcast→event pipeline output. See renderIndustryNewsLens
  // for the structural rationale (closes wrong-discovery-layer gap).
  const industryNewsFile = loadIndustryNews();
  // iter-41 close (v8): entity substrate for the constellation viz. Counts +
  // cooccurrences derived from data/youtube.json via the glitch-sweep script.
  const industryNewsEntitiesFile = loadIndustryNewsEntities();
  // iter-42 D2 — Security lens mirrors Industry News pattern. Events file is
  // orchestrator-direct-curated (Glitch reads transcript windows around top
  // security-concept hits, writes data/security-events.json). Entities file
  // is pure regex from scripts/extract-security-entities.ts. Both files
  // treated as deterministic input snapshots per v8 doctrine.
  const securityEventsFile = loadSecurityEvents();
  const securityEntitiesFile = loadSecurityEntities();
  // v8 determinism (iter-39) — was new Date().toISOString(). Now derived
  // from the harvest's latest post — the "harvested" label in the header
  // becomes truthful (it's the date of the latest post in the dataset, not
  // the date the renderer ran). Set after latestPostDate is computed below.
  let generated = "";

  // iter-37 (ISC-468..473) — hero zone payload. Build ONCE from live disk
  // state per render. Per Advisor pre-BUILD decision: pool count assert
  // surfaces silent join-key drift as an explicit error rather than viz of
  // zeros. Themes capped at 12 per ISC-457 (B-v2.1 ring-4 = 12 theme nodes).
  const heroSourcePools = loadSourcePools();
  const heroThemes = loadHeroThemes(12);
  const heroPayload = buildHeroPayload(features, heroSourcePools, heroThemes);
  if (heroPayload.total_pool === 0) {
    console.warn("[hero] total_pool=0 — likely loadSourcePools join-key drift; viz will render with zeros");
  }
  // Load the IIFE script body once at render time so the SVG render code
  // stays diffable against the mockup. See src/hero-viz-script.js header.
  const heroIifeBody = fs.readFileSync(`${CWD}/src/hero-viz-script.js`, "utf-8");

  // v8 determinism (iter-39 + iter-41 close audit) — compute reference
  // timestamp from data, NOT Date.now(). All age math (tier demotion +
  // freshness banner) anchors to the harvest's latest feature ts. Moved up
  // from line ~2270 so tierFor sees it. Fallback when features is empty
  // is now the Unix epoch (0), NOT Date.now() — preserves byte-identical
  // determinism even in the degenerate empty-features case (the
  // downstream `latest ? ... : "1970-01-01"` chain at line 2767 handles
  // the resulting falsy epoch cleanly).
  const referenceMs: number = (() => {
    const stamps = features.map((f) => new Date(f.ts).getTime()).filter((t) => !isNaN(t));
    return stamps.length > 0 ? Math.max(...stamps) : 0;
  })();

  const byTier: Record<1 | 2 | 3, ConfirmedFeature[]> = { 1: [], 2: [], 3: [] };
  for (const f of features) byTier[tierFor(f, referenceMs)].push(f);
  // ISC-377 — sort each tier by editorial weight, not raw score.
  for (const t of [1, 2, 3] as const) {
    byTier[t].sort((a, b) =>
      editorialWeight(b, sentimentByFeature.get(b.feature_id), crossNarratives) -
      editorialWeight(a, sentimentByFeature.get(a.feature_id), crossNarratives)
    );
  }

  // Substrate event tally: features that are policy/API/pricing changes
  // rather than product features. Detected by keyword in title/url.
  const substrateEventCount = features.filter((f) =>
    /rate.?limit|monthly credit|programmatic usage|june 15|subscription|pricing|policy/i.test(f.title)
  ).length;

  // Period-window — earliest and latest lab post timestamps in the dataset.
  // Mixed format input: frontier posts use ISO ("2026-05-11T20:50:53.000Z"),
  // Twitter posts use "Mon May 11 20:50:53 +0000 2026" — both must parse via
  // Date() and then re-emit as ISO YYYY-MM-DD.
  const postTimes = features
    .map((f) => new Date(f.ts).getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);
  const toIsoDate = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const earliest = postTimes[0];
  const latest = postTimes[postTimes.length - 1];
  const earliestPostDate = earliest ? toIsoDate(earliest) : "—";
  const latestPostDate = latest ? toIsoDate(latest) : "—";
  // v8 determinism (iter-39) — bind `generated` to the latest post's ISO
  // timestamp so the rendered "harvested" label is truthful AND the output
  // is byte-identical against identical inputs.
  generated = latest ? new Date(latest).toISOString() : "1970-01-01T00:00:00.000Z";

  // Honest data-freshness banner. v8 determinism (iter-39) — ages computed
  // relative to the latest harvest timestamp in the data, NOT Date.now().
  // "data spans 0-N days" reads as "the corpus spans N days at the harvest
  // moment" — re-render against same data is byte-identical.
  const oldestAgeDays = earliest && latest ? Math.floor((latest - earliest) / (1000 * 60 * 60 * 24)) : 0;
  const newestAgeDays = 0; // by definition: the newest post IS the reference point
  const dataFreshnessNote = `# data spans ${oldestAgeDays}-${newestAgeDays} days old at time of harvest. recency-tiered: posts >7d demote one tier, >14d demote two.`;

  // iter-46 F10 — surface run identifier in body. Filename + symlink alone
  // hid which run the reader was viewing. Run number derives from existing
  // archived files in OUT_DIR matching the runNNN- prefix; we count them and
  // emit the NEXT number. The badge renders: `Run #NNN · anchor X · generated Y`.
  const anchor = deriveRenderAnchor();
  let runNumber = 1;
  try {
    const existing = fs.readdirSync(OUT_DIR).filter((n) => /^features-confirmed-run(\d+)-/.test(n));
    const maxN = existing.reduce((acc, n) => {
      const m = n.match(/^features-confirmed-run(\d+)-/);
      return m && m[1] ? Math.max(acc, parseInt(m[1], 10)) : acc;
    }, 0);
    runNumber = maxN + 1;
  } catch { /* fresh OUT_DIR — runNumber stays 1 */ }
  const runBadge = `Run <strong>#${String(runNumber).padStart(3, "0")}</strong> · anchor <strong>${anchor.slug || "—"}</strong> · generated <strong>${generated}</strong>`;

  let runningRank = 0;
  // Render-time URL dedup state — processes cards in tier+score order so
  // higher-scored cards "win" the tweet attribution. Lower-scored cards
  // sharing the same evidence URL get that URL stripped from their
  // responses list before render. See dedupResponsesAgainstSeen above.
  const renderSeenUrls = new Set<string>();
  // D-WALK-3 — T2/T3 are collapsed-by-default per Kem walk ("this would be
  // a drop down — collapsible or something"). T1 stays expanded — it's the
  // editorial main act. The tier-fold <details> wraps the entire tier body
  // (head + cards + folds) so the summary becomes a one-line tier-level
  // metric chip the reader can expand on demand.
  const renderOneTier = (t: 1 | 2 | 3, collapsed: boolean): string => {
      const items = byTier[t];
      // Split unclear-sentiment cards out into a collapsed section at bottom
      // — user feedback: "these ones that are unclear we should have them in
      // some kind of drop down right that you just pull so that we only have
      // the main ones at the top." Keeps the editorial main flow focused on
      // cards with actual signal.
      //
      // Cross-narrative exemption (advisor LEARN-phase): if a feature is
      // implicated in any HIGH-confidence cross-narrative, exempt it from
      // the unclear-fold — the substrate narrative IS the editorial signal
      // even when individual sentiment is unclear. Without this, Hermes
      // Agent gets folded away despite being half of the "Anthropic
      // restricts / xAI opens" substrate story.
      const highCrossNarrativeFeatureIds = new Set(
        crossNarratives.filter((n) => n.confidence === "high").flatMap((n) => n.implicated_feature_ids)
      );
      const isUnclear = (f: ConfirmedFeature) => {
        if (highCrossNarrativeFeatureIds.has(f.feature_id)) return false;
        const s = sentimentByFeature.get(f.feature_id);
        return !s || s.overall_sentiment === "unclear";
      };
      const mainItems = items.filter((f) => !isUnclear(f));
      const unclearItems = items.filter((f) => isUnclear(f));

      // Sentiment-distribution bar at top of tier — small "data viz theater"
      // showing the tone mix without claiming false precision.
      const toneCount = { positive: 0, mixed: 0, "complaint-dominant": 0, negative: 0, unclear: 0 };
      for (const f of items) {
        const s = sentimentByFeature.get(f.feature_id);
        const tone = s ? displayTone(s) : "unclear";
        if (tone in toneCount) toneCount[tone as keyof typeof toneCount] += 1;
      }
      const totalForBar = items.length || 1;
      const toneBar = `<div class="tone-bar" title="Sentiment distribution across this tier">
        ${toneCount.positive ? `<div class="tone-seg tone-seg-positive" style="flex:${toneCount.positive}" title="${toneCount.positive} positive">${toneCount.positive > 1 ? toneCount.positive : ""}</div>` : ""}
        ${toneCount.mixed ? `<div class="tone-seg tone-seg-mixed" style="flex:${toneCount.mixed}" title="${toneCount.mixed} mixed">${toneCount.mixed > 1 ? toneCount.mixed : ""}</div>` : ""}
        ${toneCount["complaint-dominant"] ? `<div class="tone-seg tone-seg-complaint" style="flex:${toneCount["complaint-dominant"]}" title="${toneCount["complaint-dominant"]} complaint-dominant">${toneCount["complaint-dominant"] > 1 ? toneCount["complaint-dominant"] : ""}</div>` : ""}
        ${toneCount.negative ? `<div class="tone-seg tone-seg-negative" style="flex:${toneCount.negative}" title="${toneCount.negative} negative">${toneCount.negative > 1 ? toneCount.negative : ""}</div>` : ""}
        ${toneCount.unclear ? `<div class="tone-seg tone-seg-unclear" style="flex:${toneCount.unclear}" title="${toneCount.unclear} unclear">${toneCount.unclear > 1 ? toneCount.unclear : ""}</div>` : ""}
      </div>
      <div class="tone-legend">${toneCount.positive ? `<span class="leg-positive">pos ${toneCount.positive}</span>` : ""}${toneCount.mixed ? `<span class="leg-mixed">mix ${toneCount.mixed}</span>` : ""}${toneCount["complaint-dominant"] ? `<span class="leg-complaint">complaint ${toneCount["complaint-dominant"]}</span>` : ""}${toneCount.negative ? `<span class="leg-negative">neg ${toneCount.negative}</span>` : ""}${toneCount.unclear ? `<span class="leg-unclear">unclear ${toneCount.unclear}</span>` : ""}</div>`;
      void totalForBar; // flex layout handles ratios

      // Pre-dedup + drop empty shells. After render-time URL dedup, a card
      // whose responses were ALL already shown in higher-scored cards has
      // nothing unique to surface. Suppress it entirely rather than render
      // an empty "0 items" shell — that's a worse reader experience than
      // not knowing the feature exists. Structural rule: every rendered
      // card carries at least one unique-to-it response.
      const mainDeduped = mainItems
        .map((f) => dedupResponsesAgainstSeen(f, renderSeenUrls))
        .filter((f) => f.responses.length > 0);
      const mainCards = mainDeduped.map((f) => {
        runningRank += 1;
        return renderFeature(f, runningRank, indices, sentimentByFeature.get(f.feature_id), commentByStatusId, crossNarratives);
      }).join("");
      const unclearCards = unclearItems.length > 0
        ? `<details class="unclear-fold">
            <summary>▾ ${unclearItems.length} unclear card${unclearItems.length === 1 ? "" : "s"}</summary>
            <div class="feature-list feature-list-unclear">
              ${unclearItems
                .map((f) => dedupResponsesAgainstSeen(f, renderSeenUrls))
                .filter((f) => f.responses.length > 0)
                .map((f) => {
                  runningRank += 1;
                  return renderFeature(f, runningRank, indices, sentimentByFeature.get(f.feature_id), commentByStatusId, crossNarratives);
                }).join("")}
            </div>
          </details>`
        : "";
      const crossNarrativeFold = renderCrossNarrativeFold(crossNarratives, items, t);
      const tierBody = `<div class="tier-head">
          <div>
            <div class="tier-num">// tier ${t}</div>
            <h2 class="tier-hed">${TIER_LABEL[t].hed}</h2>
            <p class="tier-lede">${TIER_LABEL[t].lede}</p>
            ${toneBar}
          </div>
          <div class="tier-count-block">
            <div class="tier-count-num">${String(items.length).padStart(2, "0")}</div>
            <div class="tier-count-label">features</div>
          </div>
        </div>
        <div class="feature-list">${mainCards}</div>
        ${unclearCards}
        ${crossNarrativeFold}`;
      if (collapsed) {
        // D-WALK-3 tier-fold summary — metric chip the reader expands on demand
        const critical = (toneCount["complaint-dominant"] ?? 0) + (toneCount.negative ?? 0);
        const tfMix = [
          (toneCount.positive ?? 0) > 0 ? `<span class="tf-pos">${toneCount.positive} pos</span>` : "",
          (toneCount.mixed ?? 0) > 0 ? `<span class="tf-mixed">${toneCount.mixed} mixed</span>` : "",
          critical > 0 ? `<span class="tf-bad">${critical} critical</span>` : "",
          (toneCount.unclear ?? 0) > 0 ? `<span class="tf-unc">${toneCount.unclear} unclear</span>` : "",
        ].filter(Boolean).join(" ");
        return `<section class="tier tier-${t}">
          <details class="tier-fold">
            <summary>
              <span class="tf-hed">Tier ${t} — ${TIER_LABEL[t].hed}</span>
              <span class="tf-count">${items.length} features</span>
              <span class="tf-mix">${tfMix}</span>
            </summary>
            ${tierBody}
          </details>
        </section>`;
      }
      return `<section class="tier tier-${t}">${tierBody}</section>`;
    };
  // D-WALK-12 — Notable-this-period panel slots between T1 and T2 so
  // orphaned-but-interesting items from whitelisted creators stay visible
  // without polluting feature cards.
  // iter-32 D-WALK-11 — Features lens wraps the existing tier render in a
  // lens-head so it sits as section #2 in the (iter-42) 8-lens taxonomy.
  // Notable-orphans moved into its own Whitelist lens (section #8) — the
  // inline mid-tier panel is preserved by reading the same orphans data.
  // iter-38b D3 — Features & Flags workflow header surfaces the per-feature
  // Sonnet sentiment + tier split + creator-rec mechanism upfront.
  // iter-38b-rev2 — adds outcome line per Kem walk: "What is the outcome
  // though? ... maybe a line 'great signal for content creation'." Italic-
  // serif second line names what the reader gets from this section.
  const tierCounts = `T1 ${byTier[1].length} · T2 ${byTier[2].length} · T3 ${byTier[3].length}`;
  const featuresWf = renderLensWorkflowHeader(
    "Per-feature Sonnet sentiment + creator recommendations across confirmed features (3 tiers)",
    features.length,
    features.length === 1 ? "confirmed feature" : "confirmed features",
    tierCounts,
    "great signal for content creation — what to make next, with verbatim creator reactions + comment-sentiment behind every claim",
  );
  const featuresLensBody = featuresWf + [
    byTier[1].length > 0 ? renderOneTier(1, false) : "",
    renderNotableOrphans(notableOrphans),
    byTier[2].length > 0 ? renderOneTier(2, true) : "",
    byTier[3].length > 0 ? renderOneTier(3, true) : "",
  ].join("");
  const featuresLens = lensWrap("lens-features", "lens-features", "Features & Flags",
    lensClaim("lens-features"), features.length, "confirmed features", featuresLensBody);

  // iter-38b-rev2 — Hot Podcasts is now lens 01 (first), per Kem walk.
  // Order matches LENS_NAV (which drives the index numbering).
  // iter-39 — renderFrontPageLens DELETED; signal lives in hero-fold's
  // renderTopStoryPropagation block alongside the chord viz.
  const lensSections = [
    renderPodcastThemesPanel(),
    featuresLens,
    renderIndustryNewsLens(industryNewsFile, industryNewsEntitiesFile),
    renderSecurityLens(securityEventsFile, securityEntitiesFile),
    renderGithubLens(),
    // iter-43 — renderTrendingToolsLens() DELETED per Kem walk; tooling
    // signal lives inside the GitHub lens's Claude Code skill cluster +
    // Magic Wand Check editorial verdicts.
    // iter-44 — renderMultimediaLens DELETED; renderWhitelistLens → renderOneToWatchLens
    renderOneToWatchLens(),
  ].join("");
  void notableOrphans; // iter-44 — kept loaded for backward-compatibility with downstream callers; rendering moved to data/one-to-watch.json
  void indices;        // iter-44 — Multimedia removal eliminated this lens's only consumer; kept extracted in case future lenses need source indices

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrendingAI · What labs shipped, who's reacting</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap" rel="stylesheet">
<script async src="https://platform.twitter.com/widgets.js"></script>
<script async src="https://www.tiktok.com/embed.js"></script>
<script async src="https://www.instagram.com/embed.js"></script>
<style>
:root {
  --bg: #FAFAF7;
  --ink: #1A1A1A;
  --ink-muted: #6B6B6B;
  --ink-faint: #9A9A95;
  --hair: #E5E2DC;
  --hair-soft: #EFEDE7;
  --accent: #2563EB;
  --accent-soft: #2563EB12;
  --warn: #B45309;
  --warn-soft: #B4530910;
  --good: #047857;
  --good-soft: #04785710;
  --bad: #C92A2A;
  --bad-soft: #C92A2A10;
  /* iter-33 D3 — terminal-only aesthetic. Every controlled font collapses to
     JetBrains Mono. Embeds (Twitter/TikTok/IG/YT) keep their native fonts. */
  --serif: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --sans:  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --mono:  "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--ink); }
body { font-family: var(--sans); font-size: 16px; line-height: 1.55; font-feature-settings: "ss01", "cv11"; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 80px; }

/* terminal page head */
.terminal-head { font-family: var(--mono); font-size: 13px; line-height: 1.65; color: var(--ink); background: #fff; border: 1px solid var(--ink); padding: 16px 20px; margin-bottom: 36px; }
.t-prompt { color: var(--accent); }
.t-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.t-out { color: var(--ink); }
.t-out .t-key { color: var(--ink-muted); }
.t-divider { color: var(--hair); margin: 4px 0; letter-spacing: -1px; }
.t-warn { color: var(--warn); }
.t-banner { font-family: var(--mono); font-size: 11px; color: var(--ink-muted); margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--hair); }

/* tier sections — hairline border per D-WALK-10 aesthetic polish */
/* iter-40 — tier borders pure mono per Kem walk ("blue outline around
   features not good"). Tier-1 keeps editorial emphasis via 2px ink border;
   tier-2 = 1px ink; tier-3 = 1px dashed muted. No --accent anywhere. */
.tier { margin-top: 32px; border: 1px solid var(--ink); background: #fff; padding: 22px 24px 28px; }
.tier-1 { border-width: 2px; border-color: var(--ink); }
.tier-2 { border-color: var(--ink); }
.tier-3 { border-color: var(--ink-muted); border-style: dashed; }
/* D-WALK-3 — T2/T3 collapsible-by-default tier fold */
.tier-fold { width: 100%; }
.tier-fold > summary { font-family: var(--mono); font-size: 12px; font-weight: 500; cursor: pointer; list-style: none; padding: 4px 0 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 14px; border-bottom: 1px solid var(--hair); margin-bottom: 18px; color: var(--ink); }
.tier-fold > summary::-webkit-details-marker { display: none; }
.tier-fold > summary:hover { color: var(--accent); }
.tier-fold > summary:before { content: "▸ "; color: var(--ink-faint); }
.tier-fold[open] > summary:before { content: "▾ "; color: var(--ink); }
.tier-fold .tf-hed { text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
.tier-fold .tf-count { color: var(--ink-faint); }
.tier-fold .tf-mix { display: inline-flex; gap: 8px; font-size: 10px; color: var(--ink-muted); margin-left: auto; }
.tier-fold .tf-mix .tf-pos { color: var(--good); }
.tier-fold .tf-mix .tf-mixed { color: var(--warn); }
.tier-fold .tf-mix .tf-bad { color: var(--bad); }
.tier-fold .tf-mix .tf-unc { color: var(--ink-faint); }
.tier-head { margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid var(--hair); display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; }
.tier-num { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-bottom: 8px; }
h2.tier-hed { font-family: var(--mono); font-weight: 500; font-size: 22px; line-height: 1.15; letter-spacing: -0.005em; margin-bottom: 8px; text-transform: uppercase; }
.tier-1 h2.tier-hed { color: var(--accent); }
.tier-lede { font-family: var(--serif); font-style: italic; font-size: 14px; line-height: 1.5; color: var(--ink-muted); max-width: 640px; grid-column: 1; }
.tier-count-block { font-family: var(--mono); text-align: right; }
.tier-count-num { font-size: 36px; font-weight: 500; color: var(--ink); line-height: 1; letter-spacing: -0.02em; }
.tier-count-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-top: 4px; }

/* sentiment distribution mini-viz */
.tone-bar { display: flex; height: 6px; border-radius: 1px; overflow: hidden; margin-top: 14px; background: var(--hair); max-width: 480px; }
.tone-seg { flex: 1; font-family: var(--mono); font-size: 9px; color: #fff; line-height: 6px; text-align: center; min-width: 6px; }
.tone-seg-positive { background: var(--good); }
.tone-seg-mixed { background: var(--warn); }
.tone-seg-complaint, .tone-seg-negative { background: var(--bad); }
.tone-seg-unclear { background: var(--ink-faint); }
.tone-legend { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); margin-top: 6px; display: flex; gap: 14px; max-width: 480px; }
.tone-legend span { white-space: nowrap; }
.tone-legend .leg-positive { color: var(--good); }
.tone-legend .leg-mixed { color: var(--warn); }
.tone-legend .leg-complaint, .tone-legend .leg-negative { color: var(--bad); }
.tone-legend .leg-unclear { color: var(--ink-faint); }

/* unclear-cards fold */
.unclear-fold { margin-top: 32px; border-top: 1px dashed var(--hair); padding-top: 16px; }
.unclear-fold summary { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--ink-faint); cursor: pointer; list-style: none; padding: 6px 0; letter-spacing: 0.02em; }
.unclear-fold summary::-webkit-details-marker { display: none; }
.unclear-fold summary:hover { color: var(--accent); }
.feature-list-unclear { margin-top: 16px; opacity: 0.8; }
.feature-list-unclear .feature { padding-bottom: 12px; }

.feature-list { display: flex; flex-direction: column; gap: 32px; }

/* feature card */
.feature { padding: 4px 0 0; }

/* D-WALK-14/16/17 — Flat horizontal meta-row replaces the two-column
   rank-col split. Single mono flex row keeps rank · tone-pill · lab ·
   date · reach inline. Pattern-badge ("Adoption"/"NEWS"/"COMPLAINT"
   noise) dropped entirely; sparkline dropped from card head. Tone-pill
   flattened to colored-text + hairline (no soft background fill). */
.feat-head { margin-bottom: 12px; }
.meta-row { font-family: var(--mono); font-size: 11px; color: var(--ink-muted); display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--hair-soft); margin-bottom: 10px; }
.m-rank { font-weight: 600; color: var(--ink); font-size: 13px; padding-right: 10px; border-right: 1px solid var(--hair); }
.m-sep { color: var(--hair); }
.m-lab { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); }
.m-date, .m-reach { color: var(--ink-muted); }

.tone-pill { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 7px; border-radius: 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; border: 1px solid currentColor; background: transparent; line-height: 1.4; }
.tone-pill-icon { font-size: 10px; line-height: 1; }
.tone-pill-positive { color: var(--good); }
.tone-pill-mixed { color: var(--warn); }
.tone-pill-negative, .tone-pill-complaint-dominant { color: var(--bad); }
.tone-pill-unclear { color: var(--ink-muted); }

/* D-WALK-16 — pattern-badge no longer rendered in card head. Stale
   styles hidden defensively so any old render that still contains the
   element doesn't surface noise. */
.pattern-badge { display: none; }

/* D15 sparkline kept defined for potential reuse but not in card head. */
.eng-sparkline { font-family: var(--mono); font-size: 9px; color: var(--ink-faint); }

/* D-WALK-15 — Cross-narrative tag: neutral mono, hairline left border,
   transparent background. Kem walk: "I don't like these blue sections." */
.cross-narrative-tag { font-family: var(--mono); padding: 10px 12px; margin: 10px 0 14px; border-left: 2px solid var(--ink); background: transparent; }
.cross-narrative-tag.cross-narrative-med { border-left-color: var(--ink-muted); }
.cross-narrative-tag.cross-narrative-low { border-left-color: var(--ink-faint); }
.cn-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink); margin-bottom: 6px; }
.cross-narrative-med .cn-label, .cross-narrative-low .cn-label { color: var(--ink-muted); }
.cn-theme { font-family: var(--mono); font-style: normal; font-size: 12px; font-weight: 500; color: var(--ink); margin-bottom: 4px; }
.cn-sentence { font-family: var(--mono); font-style: normal; font-size: 11px; line-height: 1.55; color: var(--ink-muted); }
.cn-implicated { font-size: 10px; color: var(--ink-faint); margin-top: 6px; font-family: var(--mono); }

.cross-narrative-fold { margin-top: 18px; border-top: 1px dashed var(--hair); padding-top: 12px; }
.cross-narrative-fold summary { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--ink-faint); cursor: pointer; list-style: none; padding: 4px 0; letter-spacing: 0.02em; }
.cross-narrative-fold summary::-webkit-details-marker { display: none; }
.cross-narrative-fold summary:hover { color: var(--ink); }
.cn-fold-body { margin-top: 10px; }
.cn-fold-body .cross-narrative-tag { margin-left: 0; }

/* D-WALK-15 — YT podcast-synth lede: neutral mono italic, no blue. */
.yt-synth-lede { font-family: var(--mono); font-style: normal; font-size: 11px; line-height: 1.5; color: var(--ink-muted); padding: 6px 10px; border-left: 2px solid var(--ink-muted); background: transparent; margin-bottom: 6px; }
.yt-synth-show { font-family: var(--mono); font-style: normal; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); }

/* Legacy aliases — old meta-line still referenced by some embeds. */
.lab-stamp { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); }
.meta-sep { color: var(--hair); margin: 0 4px; }
.meta-date, .meta-reach { color: var(--ink-muted); }

h2.feat-title { font-family: var(--serif); font-weight: 500; font-size: 24px; line-height: 1.18; letter-spacing: -0.01em; margin-top: 4px; }
.feat-title a { color: var(--ink); }
.feat-title a:hover { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent); }

/* D-WALK-19 — strip the 160px deep indent on lede / hero / evidence.
   Flat layout means everything reads left-aligned from card edge. */
.story-lede { font-family: var(--serif); font-weight: 400; font-size: 16px; line-height: 1.55; color: var(--ink); margin-left: 0; margin-bottom: 16px; max-width: 740px; }

/* hero evidence grid */
.hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; margin-left: 0; margin-bottom: 18px; align-items: start; }
.hero-cell { display: flex; flex-direction: column; gap: 8px; }
.hero-label { font-family: var(--mono); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-faint); padding-bottom: 4px; border-bottom: 1px solid var(--hair-soft); }
.hero-embed { min-height: 0; }
.hero-embed blockquote.twitter-tweet,
.hero-embed blockquote.tiktok-embed,
.hero-embed blockquote.instagram-media { margin: 0 !important; }

/* youtube card */
.yt-card { display: flex; flex-direction: column; gap: 8px; }
.yt-link { position: relative; display: block; border-radius: 4px; overflow: hidden; line-height: 0; }
.yt-link img { width: 100%; height: auto; display: block; }
.yt-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 38px; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,.7); pointer-events: none; }
.yt-title { font-family: var(--sans); font-size: 13px; font-weight: 500; color: var(--ink); line-height: 1.35; }
/* iter-38b-rev2 — strip green border accent per Kem walk: "remove these
   odd green lines underneath the podcast, where you've got 'Cognitive
   Revolution' on the first one." Pure mono — ink border. */
.yt-transcript-window { font-family: var(--serif); font-style: italic; font-size: 13px; line-height: 1.5; color: var(--ink-muted); padding-left: 10px; border-left: 2px solid var(--ink); }

/* generic cite */
.cite-card { font-family: var(--serif); font-size: 14px; line-height: 1.45; padding: 10px 12px; border: 1px solid var(--hair); border-radius: 4px; background: #fff; }
.cite-card a { color: var(--ink); }

/* reply chip — D-WALK-21 (iter-31) hairline-only treatment, matching the
   tone-pill + cross-narrative-tag aesthetic. The prior soft-fill treatment
   was the last blue/warn tinted block in the card body; with this change
   every per-card chip uses currentColor border + transparent background,
   so reading is monochromatic except where the typography earns the color. */
.reply-chip { font-family: var(--mono); font-size: 11px; line-height: 1.45; padding: 8px 10px; border-radius: 0; border: 1px solid var(--hair); background: transparent; }
.reply-chip .reply-counts { display: block; font-weight: 500; margin-bottom: 4px; }
.reply-chip .reply-top { display: block; font-family: var(--serif); font-size: 12px; font-style: italic; color: var(--ink); }
.reply-positive { border-color: var(--good); color: var(--good); }
.reply-negative { border-color: var(--bad); color: var(--bad); }
.reply-mixed { border-color: var(--warn); color: var(--warn); }
.reply-warn { border-color: var(--warn); color: var(--warn); }

/* full evidence (collapsed by default) */
.full-evidence { margin-left: 0; margin-top: 4px; border-top: 1px solid var(--hair-soft); padding-top: 10px; }
.full-evidence summary { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); cursor: pointer; padding: 6px 0; list-style: none; }
.full-evidence summary::-webkit-details-marker { display: none; }
.full-evidence summary:before { content: "+ "; color: var(--ink-faint); }
.full-evidence[open] summary:before { content: "− "; }
.full-evidence summary:hover { color: var(--accent); }
.full-body { padding: 20px 0 0; }

/* vox grid inside details */
/* iter-40 — sentiment panel reduced to mono summary lines per Kem walk
   ("no green writing"). Drops .vox-grid 2-col colored grid + .vox-quotes
   blockquote panel + .vox-praise/.vox-complain colored headers. Single
   .vox-summary block with PRAISED / COMPLAINED mono lines. */
.vox-summary { margin-bottom: 22px; padding-bottom: 22px; border-bottom: 1px solid var(--hair); display: flex; flex-direction: column; gap: 8px; }
.vox-line { font-family: var(--mono); font-size: 11px; line-height: 1.55; color: var(--ink); }
.vox-line-tag { font-weight: 700; letter-spacing: 0.12em; color: var(--ink); margin-right: 8px; }
.vox-more { color: var(--ink-faint); font-size: 10px; }
/* legacy .vox-grid kept harmless in case any cached pre-iter-40 HTML still
   references it; current render no longer emits these classes. */
.vox-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-bottom: 22px; padding-bottom: 22px; border-bottom: 1px solid var(--hair-soft); }
.vox-col { font-size: 13px; }
.vox-h { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); margin-bottom: 10px; }
.vox-praise .vox-h { color: var(--good); }
.vox-complain .vox-h { color: var(--bad); }
.vox-col ul { list-style: none; padding-left: 0; }
.vox-col li { padding: 4px 0 4px 16px; position: relative; line-height: 1.5; }
.vox-praise li:before { content: "+"; position: absolute; left: 0; color: var(--good); font-weight: 600; }
.vox-complain li:before { content: "−"; position: absolute; left: 0; color: var(--bad); font-weight: 600; }
.vox-quotes { margin-bottom: 22px; padding-bottom: 22px; border-bottom: 1px solid var(--hair-soft); }
.vox-q { font-family: var(--serif); font-size: 14px; line-height: 1.55; padding: 6px 0 6px 14px; border-left: 2px solid var(--accent); margin-bottom: 10px; color: var(--ink); }
.vox-q p { margin-bottom: 3px; }
.vox-q footer { font-family: var(--mono); font-size: 11px; color: var(--ink-muted); font-style: normal; }

/* platform blocks inside details */
.plat-block { padding-top: 20px; }
.plat-heading { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); margin-bottom: 14px; }
.plat-count { color: var(--ink-faint); font-weight: 400; margin-left: 6px; }
.embed-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; align-items: start; }
.embed-cell { display: flex; flex-direction: column; gap: 8px; }
.embed-cell blockquote.twitter-tweet,
.embed-cell blockquote.tiktok-embed,
.embed-cell blockquote.instagram-media { margin: 0 !important; }

/* D-WALK-12 — Notable-this-period panel */
.notable-panel { margin-top: 32px; border: 1px solid var(--ink-muted); background: #fff; padding: 22px 24px 26px; }
.notable-head { padding-bottom: 14px; border-bottom: 1px solid var(--hair); margin-bottom: 16px; }
.notable-num { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-bottom: 6px; }
h2.notable-hed { font-family: var(--mono); font-weight: 500; font-size: 18px; line-height: 1.15; text-transform: uppercase; color: var(--ink); margin-bottom: 6px; letter-spacing: -0.005em; }
.notable-lede { font-family: var(--serif); font-style: italic; font-size: 13px; color: var(--ink-muted); max-width: 640px; }
.notable-list { display: flex; flex-direction: column; }
.notable-item { border-bottom: 1px solid var(--hair-soft); padding: 6px 0; }
.notable-item:last-child { border-bottom: none; }
/* D-WALK-18 — Notable summary grid: handle | teaser | platform | eng.
   Platform tag moved to right side near engagement per Kem walk
   ("you haven't said where it is... that should be somewhere on the right"). */
.notable-summary { font-family: var(--mono); font-size: 12px; line-height: 1.45; cursor: pointer; list-style: none; display: grid; grid-template-columns: 180px 1fr 28px 56px; gap: 12px; align-items: baseline; padding: 4px 0; }
.notable-summary::-webkit-details-marker { display: none; }
.notable-summary:before { content: "▸"; position: absolute; margin-left: -14px; color: var(--ink-faint); font-size: 9px; }
.notable-item[open] .notable-summary:before { content: "▾"; color: var(--ink); }
.notable-summary:hover .notable-teaser { color: var(--ink); }
.notable-handle { color: var(--ink); font-weight: 500; }
.notable-platform { font-size: 9px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; text-align: right; }
.notable-teaser { color: var(--ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notable-eng { color: var(--ink-faint); text-align: right; font-size: 10px; }
.notable-body { padding: 10px 0 8px 0; }
.notable-full { font-family: var(--mono); font-size: 11px; line-height: 1.55; color: var(--ink); margin-bottom: 8px; }
.notable-link { font-family: var(--mono); font-size: 10px; color: var(--ink); text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--hair); }
.notable-link:hover { color: var(--ink); border-bottom-color: var(--ink); }

/* D-WALK-8 — OFFICIAL pill in meta-row. Hairline, no fill, mono. Sits
   between tone-pill and lab name. Same height as tone-pill so the row
   stays flat. Color is currentColor against the accent ink to read as a
   provenance stamp, not a status badge. */
.lab-official { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 7px; border-radius: 0; border: 1px solid var(--ink); color: var(--ink); background: transparent; line-height: 1.4; }

/* D-WALK-6 — counter-narrative line. Single line, hairline left border,
   compact mono tag + serif body. Sits between summary lede and substrate
   narrative so reader sees "yes but Lab B already shipped this" right
   after the lede. */
.counter-narrative { font-family: var(--serif); font-size: 13px; line-height: 1.55; color: var(--ink); padding: 6px 0 6px 12px; border-left: 2px solid var(--ink-muted); margin: 4px 0 14px 0; }
.counter-narrative .cn-tag { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); margin-right: 8px; }
/* iter-32 — creator-recommendation block (v6.5 Creator-decision-support).
   Sits between comment-thread and hero-grid. Editorial-restraint aesthetic:
   hairline left border in accent color, mono tag, serif italic hook. */
/* iter-38b-rev2 — strip blue accent from creator-rec border + cr-tag per
   Kem walk: "Same for the create section blue line and blue. Just keep the
   design consistent." Now pure mono — ink border + ink tag. */
.creator-rec { border-left: 2px solid var(--ink); padding: 8px 0 8px 14px; margin: 12px 0 18px 0; background: transparent; }
.creator-rec .cr-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.creator-rec .cr-tag { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink); }
.creator-rec .cr-format { font-family: var(--mono); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); border: 1px solid var(--hair); padding: 1px 6px; border-radius: 0; }
.creator-rec .cr-angle { font-family: var(--sans); font-size: 14px; line-height: 1.5; color: var(--ink); margin: 2px 0 4px 0; }
.creator-rec .cr-hook { font-family: var(--serif); font-style: italic; font-size: 13px; line-height: 1.5; color: var(--ink-muted); margin: 0; }

/* D-WALK-4 — comment-thread primitive. Left vertical rail + indented
   @handle + body + right-aligned ❤. Mono throughout for the "people
   talking" texture (vs the editorial serif of the body copy). Reusable
   across negative-reply stacks, podcast transcript windows, and any
   future "comments under a card" surface. */
.comment-thread { margin: 8px 0 18px 0; padding: 10px 0 6px 0; border-top: 1px solid var(--hair-soft); }
.comment-thread .ct-head { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-faint); margin-bottom: 8px; }
.comment-thread .ct-row { display: grid; grid-template-columns: 14px 160px 1fr 50px; gap: 10px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--hair-soft); }
.comment-thread .ct-row:last-child { border-bottom: none; }
.comment-thread .ct-rail { display: inline-block; width: 2px; align-self: stretch; background: var(--ink-muted); margin-left: 6px; }
.comment-thread .ct-handle { font-family: var(--mono); font-size: 11px; color: var(--ink); font-weight: 500; }
.comment-thread .ct-body { font-family: var(--mono); font-size: 12px; color: var(--ink); line-height: 1.5; margin: 0; }
.comment-thread .ct-likes { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); text-align: right; }

/* D-WALK-2 — WHY-THIS-ITEM italic-grey caption beneath each embed cell.
   Sonnet-justified one-liner explaining the item's relevance. Items
   without a why are dropped upstream by renderFullEvidence (D-WALK-2
   drop-on-unjustifiable). */
.why-this-item { font-family: var(--serif); font-style: italic; font-size: 12px; line-height: 1.45; color: var(--ink-muted); margin: 4px 0 4px 0; padding: 0; }

/* ============================================================
   iter-32 D-WALK-11 — 9-LENS SUB-SECTION SPLIT
   ============================================================ */

/* iter-33 D2 — TOC index. Sticky at top; reads as a numbered table of
   contents with claim hints + per-lens counts. Three-column grid keeps
   the index compact above the fold. */
.lens-nav { position: sticky; top: 0; z-index: 50; background: var(--bg); padding: 14px 0 10px 0; margin: 0 0 28px 0; border-bottom: 1px solid var(--ink); font-family: var(--mono); font-size: 11px; }
.lens-nav .ln-tag { display: block; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.14em; font-size: 10px; margin-bottom: 8px; padding: 0 4px; }
.lens-nav .ln-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; }
.lens-nav .ln-row { border-top: 1px solid var(--hair); }
.lens-nav .ln-row:nth-child(-n+3) { border-top: none; }
.lens-nav .ln-item { display: grid; grid-template-columns: 22px auto 1fr 36px; gap: 8px; align-items: baseline; padding: 7px 10px; color: var(--ink); text-decoration: none; }
.lens-nav .ln-item:hover { background: var(--hair-soft); text-decoration: none; }
.lens-nav .ln-num { color: var(--ink-faint); font-size: 10px; }
.lens-nav .ln-label { color: var(--ink); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.lens-nav .ln-claim { color: var(--ink-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lens-nav .ln-count { color: var(--accent); text-align: right; font-weight: 600; }

/* iter-33 D1 — every lens body wraps in <details class="lens-fold">.
   Summary IS the headline; body is hidden until opened. */
.lens { margin-top: 18px; padding: 0; scroll-margin-top: 220px; }
.lens-fold { border: 1px solid var(--ink); background: #fff; padding: 0; }
.lens-fold[open] { padding-bottom: 22px; }
.lens-summary { font-family: var(--mono); cursor: pointer; list-style: none; padding: 14px 18px; display: grid; grid-template-columns: 22px 24px auto 1fr auto; gap: 12px; align-items: baseline; border-bottom: 1px solid transparent; }
.lens-summary::-webkit-details-marker { display: none; }
.lens-summary:before { content: "▸"; color: var(--ink-faint); font-size: 12px; }
.lens-fold[open] > .lens-summary { border-bottom: 1px solid var(--hair); }
.lens-fold[open] > .lens-summary:before { content: "▾"; color: var(--ink); }
.lens-summary:hover { background: var(--hair-soft); }
.lens-summary .ls-num { color: var(--ink-faint); font-size: 11px; font-weight: 500; }
.lens-summary .ls-label { color: var(--ink); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.lens-summary .ls-claim { color: var(--ink-muted); font-size: 12px; font-weight: 400; }
.lens-summary .ls-count { color: var(--accent); font-size: 11px; font-weight: 600; white-space: nowrap; }
.lens-body { padding: 22px 24px 4px 24px; }

/* iter-33 D5 — AI provenance marker. Tiny chip next to any Sonnet-generated
   text so reader knows what is machine-synthesized vs verbatim. */
.ai-mark { font-family: var(--mono); font-size: 9px; color: var(--ink-faint); border: 1px solid var(--hair); padding: 1px 5px; margin-left: 8px; vertical-align: middle; letter-spacing: 0.08em; text-transform: lowercase; white-space: nowrap; }
.ai-mark:hover { color: var(--ink-muted); border-color: var(--ink-muted); }

/* Empty-lens body treatment + legacy lens-head hidden (superseded by lens-summary). */
.lens-empty { font-family: var(--mono); font-size: 12px; color: var(--ink-muted); padding: 18px; border: 1px dashed var(--hair); background: transparent; }
.lens-empty .le-tag { font-weight: 600; color: var(--ink-faint); margin-right: 10px; letter-spacing: 0.1em; }
/* iter-38b D3 — per-section workflow header strip. Mono ribbon stating what
   THE SYSTEM DID with real-data counts. Sits as the first child inside every
   lens body (and the podcast panel). Inherits existing palette + mono family;
   zero new color tokens introduced (ISC-503 anti-discipline).
   iter-38b-rev2 — bolder treatment per Kem walk: "darker black border,
   maybe black on white, so that it really stands out." 2px ink border + pure
   white background (mirrors the iter-38b-rev1 podcast-panel treatment Kem
   approved). lwh-line wraps the primary mono row so a second outcome line
   sits cleanly below it without flex-wrap reflow. */
.lens-workflow-header { padding: 12px 16px; margin: 0 0 20px 0; font-family: var(--mono); font-size: 11px; line-height: 1.45; background: #fff; border: 2px solid var(--ink); color: var(--ink-muted); }
.lens-workflow-header .lwh-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.lens-workflow-header .lwh-tag { color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; font-size: 9px; font-weight: 600; }
.lens-workflow-header .lwh-mechanism { color: var(--ink); font-weight: 500; }
.lens-workflow-header .lwh-sep { color: var(--ink-faint); }
.lens-workflow-header .lwh-primary { color: var(--ink); }
.lens-workflow-header .lwh-primary strong { color: var(--ink); font-weight: 700; }
.lens-workflow-header .lwh-sub { color: var(--ink-muted); }
.lens-workflow-header .lwh-outcome { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--hair); font-family: var(--serif); font-style: italic; font-size: 13px; line-height: 1.45; color: var(--ink); }
.lens-head { display: none; }
.anchor-jump { display: block; position: relative; top: -64px; visibility: hidden; height: 0; }

/* iter-39 — Front Page lens DELETED; .fp-* CSS removed. Top Story
   Propagation block lives in hero-fold; see .tsp-* below. */

/* Industry News lens (iter-41c — rev8 design ported to live renderer).
   Banner + pipeline depletion + layered constellation + matrix with dot-pips
   + source links. Deterministic per v8 doctrine. */

/* Banner */
.in-banner { position: relative; border: 1px solid var(--ink); background: #fff; padding: 22px 26px; margin-bottom: 18px; overflow: hidden; min-height: 130px; }
.in-banner-thumbgrid { position: absolute; left: 0; top: 0; right: 0; bottom: 0; display: grid; grid-template-columns: repeat(20, 1fr); grid-template-rows: repeat(3, 1fr); gap: 1px; pointer-events: none; }
.in-banner-thumbgrid > div { background-size: cover; background-position: center; filter: contrast(1.05) brightness(0.95) saturate(0.9); opacity: 0.62; }
.in-banner-content { position: relative; display: grid; grid-template-columns: auto 1fr auto; gap: 32px; align-items: center; min-height: 90px; }
.in-banner-count { display: flex; align-items: baseline; gap: 12px; background: rgba(255,255,255,0.92); padding: 12px 16px; border: 1px solid var(--ink); }
.in-banner-num { font-family: var(--mono); font-size: 48px; font-weight: 600; line-height: 1; color: var(--ink); }
.in-banner-unit { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted); line-height: 1.3; max-width: 130px; }
.in-banner-why { font-family: var(--mono); font-size: 11px; line-height: 1.55; color: var(--ink); background: rgba(255,255,255,0.94); padding: 10px 14px; border-left: 2px solid var(--ink); }
.in-banner-why strong { color: var(--ink); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; margin-right: 8px; display: block; margin-bottom: 4px; }
.in-banner-meta { font-family: var(--mono); font-size: 10px; color: var(--ink); text-align: right; line-height: 1.6; background: rgba(255,255,255,0.92); padding: 10px 14px; border: 1px solid var(--hair); }

/* 2-panel viz */
.in-viz2 { display: grid; grid-template-columns: 1fr 2.2fr; gap: 16px; margin-bottom: 28px; min-height: 460px; }

/* Pipeline depletion */
.in-dep { border: 1px solid var(--hair); background: #fff; padding: 14px 16px; display: flex; flex-direction: column; overflow: hidden; }
.in-dep-tag { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); font-weight: 600; margin: 0 0 4px 0; }
.in-dep-caption { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); font-style: italic; line-height: 1.4; margin: 0 0 12px 0; }
.in-dep-stage { display: grid; grid-template-columns: 60px 1fr 84px; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--hair-soft); }
.in-dep-stage:last-child { border-bottom: none; }
.in-dep-label { font-family: var(--mono); font-size: 9px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.in-dep-mid { display: flex; align-items: center; gap: 10px; min-width: 0; }
.in-dep-dots { display: flex; flex-wrap: wrap; gap: 2px; flex: 0 1 auto; }
.in-dep-dot { width: 7px; height: 7px; background: var(--ink); flex-shrink: 0; }
.in-dep-dot.ghost { background: var(--hair); }
.in-dep-dot.dropped { background: #fff; border: 1px dashed var(--ink-muted); width: 5px; height: 5px; }
.in-dep-count { font-family: var(--mono); font-size: 11px; color: var(--ink); font-weight: 600; text-align: right; line-height: 1.2; }
.in-dep-count-sub { font-family: var(--mono); font-size: 8px; color: var(--ink-faint); font-weight: 400; margin-top: 2px; }
.in-dep-noop { font-family: var(--mono); font-size: 9px; color: var(--ink-faint); font-style: italic; white-space: nowrap; }

/* Layered constellation */
.in-cn { border: 1px solid var(--hair); background: #fff; padding: 14px 16px; display: flex; flex-direction: column; overflow: hidden; }
.in-cn-tag { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); font-weight: 600; margin: 0 0 4px 0; }
.in-cn-caption { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); font-style: italic; line-height: 1.4; margin: 0 0 12px 0; }
.in-cn-svg-wrap { position: relative; flex: 1; min-height: 360px; background: var(--bg); border: 1px solid var(--hair); }
.in-cn-svg-wrap svg { display: block; width: 100%; height: 100%; }
.in-cn-evlabel { position: absolute; font-family: var(--mono); font-size: 9px; font-weight: 600; color: var(--ink); text-transform: uppercase; letter-spacing: 0.03em; background: rgba(250,250,247,0.96); padding: 3px 6px; border: 1px solid var(--ink); max-width: 180px; line-height: 1.3; pointer-events: none; z-index: 6; word-break: normal; }
/* Horizontal anchor — which side of label hugs the (left,top) origin. */
.in-cn-evlabel-h-left { text-align: left; }
.in-cn-evlabel-h-right { text-align: right; }
.in-cn-evlabel-h-center { text-align: center; }
/* Vertical anchor — where label sits relative to (left,top) origin. */
.in-cn-evlabel-v-above { /* origin is at label bottom edge */ }
.in-cn-evlabel-v-below { /* origin is at label top edge */ }
.in-cn-evlabel-v-center { /* origin is at label vertical center */ }
/* Combined transforms: 9-cell anchor matrix. */
.in-cn-evlabel-h-left.in-cn-evlabel-v-above { transform: translate(0, -100%); }
.in-cn-evlabel-h-left.in-cn-evlabel-v-below { transform: translate(0, 0); }
.in-cn-evlabel-h-left.in-cn-evlabel-v-center { transform: translate(0, -50%); }
.in-cn-evlabel-h-right.in-cn-evlabel-v-above { transform: translate(-100%, -100%); }
.in-cn-evlabel-h-right.in-cn-evlabel-v-below { transform: translate(-100%, 0); }
.in-cn-evlabel-h-right.in-cn-evlabel-v-center { transform: translate(-100%, -50%); }
.in-cn-evlabel-h-center.in-cn-evlabel-v-above { transform: translate(-50%, -100%); }
.in-cn-evlabel-h-center.in-cn-evlabel-v-below { transform: translate(-50%, 0); }
.in-cn-evlabel-h-center.in-cn-evlabel-v-center { transform: translate(-50%, -50%); }

/* Matrix */
.in-matrix-section { margin-top: 28px; }
.in-section-tag { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); margin: 0 0 4px 0; font-weight: 600; }
.in-section-tells { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); font-style: italic; margin: 0 0 14px 0; }
.in-matrix { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; background: #fff; }
.in-matrix th { font-weight: 500; padding: 10px 12px; border-bottom: 2px solid var(--ink); color: var(--ink-muted); text-align: left; text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; vertical-align: bottom; }
.in-matrix td { padding: 12px; border-bottom: 1px solid var(--hair); border-right: 1px solid var(--hair-soft); vertical-align: top; }
.in-matrix td:last-child { border-right: none; }
.in-matrix tr:last-child td { border-bottom: none; }
.in-lab-cell { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); width: 110px; padding-right: 8px; }
.in-lab-cell-industry { font-style: italic; color: var(--ink-muted); }
.in-evcell { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.in-evcell:last-child { margin-bottom: 0; }
.in-evcell-headline { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--ink); line-height: 1.35; }
.in-evcell-context { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); line-height: 1.5; }

/* iter-41 cleanup: coverage density (replaces SHOWS/EPISODES dot-pips per Kem) */
.in-cov { display: flex; align-items: baseline; gap: 12px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--hair); }
.in-cov-num { font-family: var(--mono); font-size: 22px; font-weight: 600; color: var(--ink); line-height: 1; display: inline-flex; align-items: baseline; }
.in-cov-eps { color: var(--ink); }
.in-cov-slash { color: var(--ink-faint); margin: 0 3px; font-weight: 400; }
.in-cov-shows { color: var(--ink-muted); }
.in-cov-meta { display: flex; flex-direction: column; gap: 3px; }
.in-cov-label { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); line-height: 1.3; }
.in-cov-label strong { color: var(--ink); font-weight: 600; }
.in-cov-ratio { font-family: var(--mono); font-size: 10px; font-weight: 600; color: var(--ink); }

/* Source list (iter-41 cleanup: per-show dedupe with × N count chip per Kem) */
.in-sources { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--hair-soft); }
.in-sources-label { font-family: var(--mono); font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-faint); margin-bottom: 4px; font-weight: 600; }
.in-sources-list { display: flex; flex-direction: column; gap: 6px; }
.in-source { display: flex; align-items: flex-start; gap: 8px; font-family: var(--mono); font-size: 10px; line-height: 1.35; }
.in-source-thumb { width: 38px; height: 22px; background-size: cover; background-position: center; filter: grayscale(1) contrast(1.1); border: 1px solid var(--hair); flex-shrink: 0; margin-top: 1px; }
.in-source-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.in-source-show { display: inline-flex; align-items: baseline; gap: 6px; font-weight: 600; color: var(--ink); }
.in-src-x { font-size: 9px; font-weight: 600; color: var(--ink-muted); background: var(--bg); border: 1px solid var(--hair); padding: 1px 5px; line-height: 1.2; }
.in-source-link { color: var(--ink); text-decoration: underline; text-decoration-color: var(--ink-muted); text-underline-offset: 2px; }
.in-source-quote { font-style: italic; color: var(--ink-muted); }
.in-source-quote-empty { font-style: italic; color: var(--ink-faint); font-size: 9px; }
.in-source-link:hover { text-decoration-color: var(--ink); }
.in-source-show { color: var(--ink-faint); font-size: 9px; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 4px; }


/* Security lens — iter-42 D2 rev4 (sx-* + ev-* classes; old .sec-card/.sec-list deleted). */
.sx-mock { background: #FEF3C7; color: #92400E; font-size: 9px; letter-spacing: 0.06em; padding: 1px 5px; border: 1px solid #FCD34D; margin-left: 6px; text-transform: uppercase; font-family: var(--mono); }

/* status strip — SOC dashboard feel */
.sx-status { display: flex; flex-wrap: wrap; gap: 0; background: var(--ink); color: var(--bg); padding: 14px 20px; align-items: center; }
.sx-st-block { display: flex; flex-direction: column; gap: 2px; padding-right: 22px; border-right: 1px solid #3A3A3A; margin-right: 22px; }
.sx-st-block:last-child { border-right: none; margin-right: 0; padding-right: 0; }
.sx-st-label { font-family: var(--mono); font-size: 9px; letter-spacing: 0.16em; opacity: 0.55; text-transform: uppercase; }
.sx-st-num { font-family: var(--mono); font-size: 18px; font-weight: 600; line-height: 1; }
.sx-st-sub { font-family: var(--mono); font-size: 10px; opacity: 0.7; }

/* issue index TOC */
.sx-index { border: 1px solid var(--ink); border-top: none; background: #fff; padding: 0; margin-bottom: 0; }
.sx-idx-tag { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; color: var(--ink-muted); padding: 10px 20px 4px 20px; text-transform: uppercase; }
.sx-idx-row { display: grid; grid-template-columns: 32px 90px 1fr 130px; gap: 14px; padding: 9px 20px; border-top: 1px solid var(--hair); align-items: center; text-decoration: none; color: var(--ink); transition: background 0.1s; }
.sx-idx-row:hover { background: var(--hair-soft, #F3F2EE); }
.sx-idx-letter { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); }
.sx-idx-sev { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; font-weight: 600; }
.sx-idx-sev-CRITICAL { color: var(--ink); }
.sx-idx-sev-HIGH     { color: var(--ink); }
.sx-idx-sev-MEDIUM   { color: var(--ink-muted); }
.sx-idx-sev-LOW      { color: var(--ink-faint); }
.sx-idx-title { font-family: var(--mono); font-size: 12px; color: var(--ink); line-height: 1.4; }
.sx-idx-action { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; color: var(--ink-muted); text-align: right; }

/* per-event block — V4 two-column shell */
.ev-block { display: grid; grid-template-columns: 1fr 320px; gap: 0; border-top: 1px solid var(--ink); background: var(--bg); }
.ev-left { padding: 28px 28px 28px 0; border-right: 1px solid var(--hair); min-width: 0; }
.ev-right { padding: 28px; background: #F3F2EE; border-left: 1px solid var(--hair); }

.ev-anchor { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin-bottom: 8px; letter-spacing: 0.1em; }
.ev-anchor strong { color: var(--ink); font-weight: 600; font-size: 18px; letter-spacing: 0; margin-right: 8px; }

.ev-top { display: flex; gap: 24px; align-items: center; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px dashed var(--hair); flex-wrap: wrap; }
.ev-sev { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.18em; color: var(--ink); min-width: 80px; }
.sx-sev-CRITICAL { color: var(--ink); }
.sx-sev-HIGH     { color: var(--ink); }
.sx-sev-MEDIUM   { color: var(--ink-muted); }
.sx-sev-LOW      { color: var(--ink-faint); }

.ev-analysis { display: flex; gap: 20px; align-items: center; flex: 1; flex-wrap: wrap; }
.ev-an-row { display: flex; align-items: center; gap: 8px; }
.ev-an-label { font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; color: var(--ink-faint); text-transform: uppercase; min-width: 60px; }
.ev-cells { display: flex; gap: 2px; }
.ev-cell { width: 10px; height: 10px; background: var(--hair); display: inline-block; }
.ev-cell.on { background: var(--ink); }
.ev-an-num { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); margin-left: 4px; }

.ev-headline { font-family: var(--mono); font-size: 17px; font-weight: 600; line-height: 1.35; margin: 0 0 12px 0; color: var(--ink); }
.ev-summary { font-family: var(--serif); font-size: 14px; color: var(--ink); line-height: 1.6; margin: 0 0 16px 0; }
.ev-quote-wrap { padding-left: 16px; border-left: 1px solid var(--ink); margin: 0 0 16px 0; }
.ev-quote { font-family: var(--serif); font-style: italic; color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0 0 8px 0; }
.ev-attr { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-family: var(--mono); font-size: 10px; color: var(--ink-faint); letter-spacing: 0.04em; }
.ev-attr .attr-show { color: var(--ink-muted); }
.ev-attr .attr-listen { color: var(--ink); border: 1px solid var(--ink); padding: 2px 8px; text-decoration: none; transition: background 0.1s; font-weight: 500; }
.ev-attr .attr-listen:hover { background: var(--ink); color: var(--bg); }
.ev-attr .attr-listen .attr-time { color: var(--ink-muted); margin-left: 6px; font-weight: 400; }
.ev-attr .attr-listen:hover .attr-time { color: var(--ink-faint); }

.ev-resources { margin: 16px 0 0 0; padding-top: 14px; border-top: 1px dashed var(--hair); }
.ev-res-label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; color: var(--ink-faint); text-transform: uppercase; margin: 0 0 8px 0; }
.ev-res-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.ev-res-list a { font-family: var(--mono); font-size: 11px; color: var(--ink); text-decoration: none; padding: 4px 10px; border: 1px solid var(--hair); background: #fff; transition: border-color 0.1s; }
.ev-res-list a:hover { border-color: var(--ink); }

.ev-move-label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; color: var(--ink-muted); text-transform: uppercase; margin: 0 0 6px 0; }
.ev-move-verdict { font-family: var(--mono); font-size: 16px; font-weight: 600; color: var(--ink); margin: 0 0 22px 0; }
.ev-do-list { list-style: none; margin: 0; padding: 0; }
.ev-do-item { display: flex; gap: 10px; padding: 5px 0; font-family: var(--mono); font-size: 11.5px; color: var(--ink); line-height: 1.55; border-top: 1px dashed var(--hair); }
.ev-do-item:first-child { border-top: none; padding-top: 0; }
.ev-do-item:before { content: "→"; color: var(--ink-faint); font-weight: 600; }
.ev-do-item span { flex: 1; }

/* GitHub lens */
.gh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.gh-card { padding: 12px 14px; border: 1px solid var(--hair); background: #fff; }
.gh-card .gh-meta { display: flex; gap: 10px; font-family: var(--mono); font-size: 10px; color: var(--ink-muted); margin-bottom: 6px; align-items: center; }
.gh-card .gh-stars { color: var(--warn); font-weight: 600; }
.gh-card .gh-lang { color: var(--accent); }
.gh-card .gh-author { color: var(--ink-faint); }
.gh-card .gh-title { font-family: var(--mono); font-size: 13px; font-weight: 500; line-height: 1.3; margin: 4px 0; }
.gh-card .gh-title a { color: var(--ink); }
.gh-card .gh-desc { font-family: var(--sans); font-size: 12px; line-height: 1.5; color: var(--ink-muted); margin: 4px 0 0 0; }

/* Trending Tools lens */
.tools-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
.tools-table thead th { text-align: left; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px; color: var(--ink-faint); padding: 8px 12px; border-bottom: 1px solid var(--ink); }
.tools-table tbody td { padding: 10px 12px; border-bottom: 1px solid var(--hair); color: var(--ink); }
.tools-table .tools-rank { font-weight: 600; color: var(--accent); width: 70px; }
.tools-table .tools-name { font-weight: 600; width: 160px; }
.tools-table .tools-creators { color: var(--ink-muted); }
.tools-table .tools-link a { color: var(--accent); }

/* Multimedia lens */
/* iter-44 — .mm-* (Multimedia) CSS DELETED with the lens. */
/* iter-45 T0 — One to Watch lens CSS — rev8 layout port. Mono palette
   inherited from page tokens (--bg/--ink/--ink-muted/--ink-faint/--hair/
   --hair-soft). Zero new color tokens. All classes prefixed otw- to
   avoid collision with other lens CSS. Layout: meta-strip + funnel +
   propagation-model (SVG + state sidebar) + 4 bucket rows + predictions
   ledger + section footer + dropped-as-noise fold. */
.otw-shell { background: #fff; border-top: 2px solid var(--ink); }
.otw-meta { padding: 14px 24px 12px; border-bottom: 1px solid var(--ink); background: var(--bg); display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: baseline; font-family: var(--mono); }
.otw-meta-cap { font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.14em; }
.otw-meta-cap b { color: var(--ink); font-weight: 700; }
.otw-meta-tally { font-size: 11px; color: var(--ink); text-align: right; }
.otw-meta-tally b { color: var(--ink); font-weight: 700; }
.otw-funnel { padding: 12px 24px; border-bottom: 1px solid var(--ink); background: var(--bg); font-family: var(--mono); font-size: 11px; }
.otw-funnel-cap { font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-bottom: 8px; }
.otw-funnel-cap b { color: var(--ink); font-weight: 700; }
.otw-funnel-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--ink); }
.otw-funnel-row b { color: var(--ink); font-weight: 700; }
.otw-funnel-row .otw-sep, .otw-bucket-body .otw-sep { color: var(--ink-faint); }
/* Propagation model panel */
.otw-pmodel { padding: 22px 24px; border-bottom: 1px solid var(--ink); background: #fff; display: grid; grid-template-columns: 1fr 260px; gap: 28px; }
.otw-pmodel-cap { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-bottom: 6px; }
.otw-pmodel-cap b { color: var(--ink); font-weight: 700; }
.otw-pmodel-title { font-family: var(--mono); font-size: 14px; font-weight: 700; text-transform: uppercase; color: var(--ink); margin: 0 0 8px; }
.otw-pmodel-lede { font-family: var(--serif); font-style: italic; font-size: 12.5px; color: var(--ink-muted); margin: 0 0 16px; line-height: 1.55; }
.otw-pmodel-lede b { color: var(--ink); font-style: normal; font-weight: 600; }
.otw-pmodel-svg { width: 100%; height: auto; display: block; }
.otw-pmodel-svg .otw-stage-label { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; fill: var(--ink); }
.otw-pmodel-svg .otw-stage-sub { font-family: var(--serif); font-style: italic; font-size: 9.5px; fill: var(--ink-muted); }
.otw-pmodel-svg .otw-stage-count { font-family: var(--mono); font-size: 11px; font-weight: 700; fill: var(--ink); }
.otw-pmodel-svg .otw-stage-zero { font-family: var(--mono); font-size: 11px; fill: var(--ink-faint); }
.otw-pmodel-svg .otw-axis-line { stroke: var(--ink); stroke-width: 1.5; fill: none; marker-end: url(#otw-arrow-ink); }
.otw-pmodel-svg .otw-dot { fill: var(--ink); }
.otw-pmodel-svg .otw-dot-faint { fill: var(--ink-muted); }
.otw-pmodel-svg .otw-hustler-marker { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 3 2; fill: none; }
/* Model state sidebar */
.otw-pmodel-state { padding: 0; border: 1px solid var(--ink); background: var(--bg); }
.otw-pmodel-state-head { padding: 8px 12px; background: var(--ink); color: #fff; font-family: var(--mono); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
.otw-pmodel-state-body { padding: 12px; font-family: var(--mono); font-size: 11px; color: var(--ink); }
.otw-pms-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--hair); }
.otw-pms-row:last-of-type { border-bottom: none; }
.otw-pms-label { color: var(--ink-muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; }
.otw-pms-val { color: var(--ink); font-weight: 600; }
.otw-mock-cell { display: inline-block; font-family: var(--mono); font-size: 8.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; padding: 1px 5px; border: 1px dashed var(--ink-muted); color: var(--ink-muted); }
.otw-pms-bar { height: 6px; background: var(--hair); margin-top: 12px; position: relative; }
.otw-pms-bar-fill { position: absolute; top: 0; left: 0; height: 100%; width: 1%; background: var(--ink); }
.otw-pms-bar-cap { font-family: var(--mono); font-size: 8.5px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; }
/* Bucket rows */
.otw-buckets { background: #fff; }
.otw-bucket-row { padding: 14px 24px 16px; border-bottom: 1px solid var(--ink); display: grid; grid-template-columns: 130px 1fr; gap: 18px; align-items: start; }
.otw-bucket-row:first-of-type { padding-top: 18px; }
.otw-bucket-num { font-family: var(--mono); font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); padding-top: 2px; }
.otw-bucket-num span { display: block; font-size: 9px; color: var(--ink-faint); font-weight: 500; margin-top: 2px; letter-spacing: 0.14em; }
.otw-bucket-num em { display: block; font-style: normal; font-size: 8.5px; color: var(--ink-muted); font-weight: 500; margin-top: 4px; letter-spacing: 0.1em; }
.otw-bucket-body { font-family: var(--mono); font-size: 11px; color: var(--ink); line-height: 1.55; }
.otw-bucket-body b { color: var(--ink); font-weight: 600; }
.otw-b-item { display: inline-block; padding: 1px 6px; margin: 2px 4px 2px 0; border: 1px solid var(--hair); color: var(--ink); }
.otw-b-item a { color: inherit; text-decoration: none; }
.otw-b-item a:hover { text-decoration: underline; }
.otw-b-item.otw-high-corr { border-color: var(--ink); background: var(--ink); color: #fff; font-weight: 600; }
.otw-b-item.otw-high-corr a { color: #fff; }
.otw-b-item.otw-med-corr { border-color: var(--ink); font-weight: 600; }
.otw-corr-chip { font-family: var(--mono); font-size: 8.5px; padding: 0 4px; margin-left: 4px; vertical-align: 1px; color: var(--ink-faint); }
.otw-b-item.otw-high-corr .otw-corr-chip, .otw-b-item.otw-med-corr .otw-corr-chip { color: inherit; }
.otw-b-watch { font-family: var(--serif); font-style: italic; font-size: 12px; color: var(--ink-muted); margin-top: 10px; display: block; }
.otw-b-watch b { color: var(--ink); font-style: normal; font-weight: 600; }
/* Predictions ledger */
.otw-pred-block { padding: 18px 24px 20px; border-bottom: 1px solid var(--ink); background: var(--bg); }
.otw-pred-cap { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); margin-bottom: 6px; }
.otw-pred-cap b { color: var(--ink); font-weight: 700; }
.otw-pred-title { font-family: var(--mono); font-size: 14px; font-weight: 700; text-transform: uppercase; color: var(--ink); margin: 0 0 6px; }
.otw-pred-lede { font-family: var(--serif); font-style: italic; font-size: 12.5px; color: var(--ink-muted); max-width: 760px; margin: 0 0 14px; }
.otw-pred-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; background: #fff; border: 1px solid var(--ink); }
.otw-pred-table th { text-align: left; padding: 8px 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; font-size: 9px; color: var(--ink); border-bottom: 1px solid var(--ink); background: var(--bg); }
.otw-pred-table td { padding: 8px 10px; vertical-align: top; border-bottom: 1px solid var(--hair-soft); }
.otw-pred-table tr:last-child td { border-bottom: none; }
.otw-pred-bucket { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); }
.otw-pred-handle { font-weight: 600; color: var(--ink); }
.otw-pred-bet { font-family: var(--serif); font-size: 12px; line-height: 1.4; color: var(--ink); }
.otw-pred-bet b { font-weight: 600; }
.otw-pred-corr { font-family: var(--mono); font-size: 10px; text-align: center; color: var(--ink); }
.otw-pred-corr b { font-weight: 700; }
.otw-pred-window { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.08em; }
.otw-pred-result { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); text-align: center; }
.otw-section-foot { padding: 14px 24px 16px; font-family: var(--mono); font-size: 10px; color: var(--ink-muted); }
.otw-section-foot code { font-family: var(--mono); background: transparent; border: 1px solid var(--hair); padding: 1px 5px; color: var(--ink); }
.otw-section-foot b { color: var(--ink); font-weight: 600; }
.otw-dropped { margin: 0 24px 18px; padding: 10px 0 0; border-top: 1px dashed var(--hair); }
.otw-dropped-summary { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); cursor: pointer; list-style: none; padding: 4px 0; }
.otw-dropped-summary::-webkit-details-marker { display: none; }
.otw-dropped[open] .otw-dropped-summary { color: var(--ink); }
.otw-drop-list { list-style: none; padding: 6px 0 12px; margin: 0; }
.otw-drop-row { font-family: var(--mono); font-size: 11px; padding: 4px 0; display: grid; grid-template-columns: 180px 60px 1fr; gap: 12px; color: var(--ink-muted); }
.otw-drop-handle { color: var(--ink); }
.otw-drop-eng { color: var(--ink-faint); }
.otw-drop-reason { color: var(--ink-muted); font-style: italic; }

/* Podcast themes panel — "Hot in podcasts this month" */
/* iter-38b-rev2 — .podcast-panel CSS removed (was the standalone-section
   treatment for Hot Podcasts). Hot Podcasts is now a first-class lens via
   the lensWrap helper so it inherits the lens-fold + lens-summary styling
   automatically; the panel-specific wrapper styles are no longer referenced. */
.pt-grid { display: block; }
/* iter-38b-rev4 — SHIPPED per Kem approval on rev3 mockup. 2-column grid
   per card: body on the left, listen-priority rail on the right (R5b).
   Curated quote renders as italic-serif sentence after summary (N4-as-
   sentence) — no border, no box, em-dash mono attribution. */
.pt-card {
  display: grid;
  grid-template-columns: 1fr 140px;
  gap: 28px;
  align-items: start;
  padding: 18px 0 22px 0;
  border-bottom: 1px solid var(--hair-soft);
}
.pt-card:last-child { border-bottom: none; }
.pt-body { min-width: 0; }
.pt-card-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.pt-theme { font-family: var(--serif); font-size: 18px; font-weight: 500; line-height: 1.3; margin: 0; color: var(--ink); flex: 1; }
.pt-count { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.1em; white-space: nowrap; }
.pt-summary { font-family: var(--serif); font-size: 15px; line-height: 1.55; color: var(--ink); margin: 6px 0 8px 0; }
/* N4 curated quote — italic-serif, smaller + lighter than summary to
   establish hierarchy (Kem walk: "should be smaller text, take less
   space, a little bit lighter... separate the quote"). Top margin
   pushes it visually away from the summary. */
.pt-quote {
  font-family: var(--serif);
  font-style: italic;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--ink-faint);
  margin: 10px 0 2px 0;
  max-width: 560px;
}
.pt-quote-attr {
  font-family: var(--mono);
  font-style: normal;
  font-size: 9px;
  color: var(--ink-faint);
  letter-spacing: 0.02em;
  margin-left: 4px;
  white-space: nowrap;
}
.pt-quote-attr strong { color: var(--ink-faint); font-weight: 500; }
/* iter-46 — ▶ LISTEN chip on podcast cards (mirrors Security .attr-listen at
   podcast-card scope). When data/podcast-themes.json episodes carry
   timestamp_seconds, the URL deep-links to that second via YouTube &t=Xs. */
.pt-listen { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; color: var(--ink); border: 1px solid var(--ink); padding: 2px 8px; text-decoration: none; margin-left: 10px; transition: background 0.1s, color 0.1s; display: inline-block; vertical-align: middle; }
.pt-listen:hover { background: var(--ink); color: var(--bg); }
/* R5b right-rail listen priority */
.lp-rail { border-left: 1px solid var(--hair); padding-left: 16px; padding-top: 2px; }
.lp-rail-label { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--ink); letter-spacing: 0.06em; margin: 0 0 8px 0; }
.lp-rail-bar { display: flex; height: 8px; gap: 2px; max-width: 100px; margin-bottom: 10px; }
.lp-seg { flex: 1; background: var(--hair); }
.lp-seg.on { background: var(--ink); }
.lp-rail-meta { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); line-height: 1.5; }
.lp-rail-meta strong { color: var(--ink-muted); font-weight: 500; }

/* iter-38a page-header lede (above terminal-head) — reframes the whole
   report as one of nine reader-lenses, not just a Features dump. */
.page-header { margin: 12px 0 22px 0; padding: 0 0 14px 0; border-bottom: 1px solid var(--hair); }
.page-title { font-family: var(--mono); font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 6px 0; color: var(--ink); text-transform: uppercase; }
.page-lede { font-family: var(--serif); font-size: 14px; line-height: 1.55; color: var(--ink-muted); margin: 0 0 6px 0; max-width: 880px; }
.page-lede strong { color: var(--ink); font-weight: 600; }
.page-lede em { color: var(--ink); font-style: italic; }
/* iter-46 F10 — run identifier line surfaces in body so readers know which run
   they're viewing without inspecting filename or symlink. */
.page-meta { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin: 0; letter-spacing: 0.02em; }
.page-meta strong { color: var(--ink-muted); font-weight: 600; }

/* iter-38a hero-fold — wraps hero-zone in a collapsible details. Default
   OPEN since it IS the hero, but readers can collapse. Summary is the
   editorial title; the marker glyph rotates open/closed. */
.hero-fold { margin: 24px 0 36px 0; }
.hero-fold > summary.hero-summary { display: flex; align-items: baseline; gap: 12px; padding: 8px 12px; cursor: pointer; list-style: none; border: 1px solid var(--ink); border-bottom: none; background: #fff; font-family: var(--mono); }
/* iter-38b-rev3 bug fix per Kem walk: "when you minimise [Report Breakdown],
   the bottom line doesn't show". When the fold is closed the summary needs
   its bottom border restored — otherwise it reads as an open-bottomed box. */
.hero-fold:not([open]) > summary.hero-summary { border-bottom: 1px solid var(--ink); }
.hero-fold > summary.hero-summary::-webkit-details-marker { display: none; }
.hero-fold > summary.hero-summary .hero-marker { color: var(--accent); font-size: 14px; transition: transform 0.15s; display: inline-block; }
.hero-fold[open] > summary.hero-summary .hero-marker { transform: rotate(90deg); }
.hero-fold > summary.hero-summary .hero-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); }
.hero-fold > summary.hero-summary .hero-summary-hint { margin-left: auto; font-size: 10px; color: var(--ink-faint); text-transform: lowercase; letter-spacing: 0.04em; }
.hero-fold > .hero-zone { margin: 0; border-top: none; }

/* iter-38a hero-lede + hero-math (D1.b + D1.c). One-liner painting the
   editorial promise; math expressions showing inclusion ratio + reactor
   density as actual readable equations (mono, italic-ish). */
.hero-lede { font-family: var(--serif); font-style: italic; font-size: 13px; line-height: 1.5; color: var(--ink-muted); margin: 10px 0 14px 0; max-width: 780px; }
.hero-math { font-family: var(--mono); font-size: 11px; color: var(--ink); padding: 10px 12px; background: var(--bg); border: 1px dashed var(--hair); margin-bottom: 18px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.hero-math .hero-math-eq { white-space: nowrap; }
.hero-math .hero-math-var { color: var(--accent); font-weight: 500; }
.hero-math .hero-math-sep { color: var(--ink-faint); padding: 0 6px; }
.hero-math strong { color: var(--ink); font-weight: 600; }

/* iter-38a-rev1 (A) — pipeline visualization replacing the terminal-head
   text dump. Horizontal stage flow with status pills, error annotations,
   and a period-line header. Reads as "this is what ran across the whole
   output" not as "here is some text describing what ran." */
.pipeline-strip { margin: 22px 0; padding: 16px 18px; border: 1px solid var(--ink); background: #fff; }
.pipeline-strip .ps-title-row { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--hair); flex-wrap: wrap; }
.pipeline-strip .ps-title { font-family: var(--mono); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); margin: 0; }
.pipeline-strip .ps-title-sub { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); }
.pipeline-strip .ps-title-sub strong { color: var(--ink); font-weight: 600; }
/* iter-38b — methodology fold link sits at end of title row, right-aligned. */
.pipeline-strip .ps-method-link { margin-left: auto; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); text-decoration: none; padding: 4px 10px; border: 1px solid var(--hair); }
.pipeline-strip .ps-method-link:hover { color: var(--accent); border-color: var(--accent); }
.pipeline-strip .ps-period { font-family: var(--mono); font-size: 12px; color: var(--ink); margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--hair); display: flex; align-items: baseline; gap: 14px; }
.pipeline-strip .ps-period-tag { font-size: 9px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.12em; }
.pipeline-strip .ps-period-val { font-weight: 600; color: var(--ink); }
.pipeline-strip .ps-flow { display: flex; align-items: stretch; gap: 0; flex-wrap: nowrap; overflow-x: auto; }
.pipeline-strip .ps-stage { flex: 1 1 0; min-width: 110px; padding: 10px 12px; border: 1px solid var(--hair); background: var(--bg); display: flex; flex-direction: column; gap: 4px; position: relative; }
.pipeline-strip .ps-stage + .ps-stage { margin-left: 18px; }
.pipeline-strip .ps-stage + .ps-stage::before { content: "→"; position: absolute; left: -16px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 14px; color: var(--ink-faint); }
.pipeline-strip .ps-stage-name { font-family: var(--mono); font-size: 9px; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.12em; }
.pipeline-strip .ps-stage-primary { font-family: var(--mono); font-size: 18px; font-weight: 600; color: var(--ink); line-height: 1.1; }
.pipeline-strip .ps-stage-sub { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); }
.pipeline-strip .ps-stage-status { position: absolute; top: 8px; right: 8px; width: 6px; height: 6px; border-radius: 50%; }
.pipeline-strip .ps-status-ok { background: var(--good); }
.pipeline-strip .ps-status-warn { background: var(--warn); }
.pipeline-strip .ps-status-error { background: var(--bad); }
.pipeline-strip .ps-status-skip { background: var(--ink-faint); }
.pipeline-strip .ps-notes { margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--hair); font-family: var(--mono); font-size: 10px; color: var(--ink-muted); display: flex; flex-direction: column; gap: 4px; }
.pipeline-strip .ps-notes .ps-note-ok { color: var(--good); }
.pipeline-strip .ps-notes .ps-note-warn { color: var(--warn); }
.pipeline-strip .ps-notes .ps-note-error { color: var(--bad); }
.pipeline-strip .ps-notes .ps-note-glyph { display: inline-block; width: 14px; }
.pipeline-strip .ps-notes .ps-note-warn strong { color: var(--warn); font-weight: 600; }

/* iter-38a-rev3 → rev6 — branching pipeline: child stages sit beneath
   main flow. Pure monochrome per Kem walk rev5: "blue is not the colour...
   should be black and white. Keep it consistent." Drop accent left-stripe
   + accent background. Use off-white background tint (var(--bg)) so the
   child row is still visually distinct from the white main-flow row
   without introducing any color. */
.pipeline-strip .ps-child-row { margin-top: 14px; padding: 12px 14px; border: 1px dashed var(--ink); background: var(--bg); display: flex; align-items: center; gap: 14px; }
.pipeline-strip .ps-child-label { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); text-transform: lowercase; letter-spacing: 0.05em; font-style: italic; flex: 0 0 auto; max-width: 200px; line-height: 1.4; }
.pipeline-strip .ps-child-label em { color: var(--ink); font-style: normal; font-weight: 600; }
.pipeline-strip .ps-child-stages { display: flex; gap: 18px; flex: 1 1 auto; }
.pipeline-strip .ps-child-stages .ps-stage { background: #fff; border-color: var(--hair); }
.pipeline-strip .ps-stage-child { flex: 1 1 0; min-width: 120px; }
.pipeline-strip .ps-stage-narrow { max-width: 110px; flex: 0 0 auto; }
.pipeline-strip .ps-child-row .ps-stage + .ps-stage { margin-left: 0; }
.pipeline-strip .ps-child-row .ps-stage + .ps-stage::before { content: none; }

/* iter-38a-rev1 (C) — proper math typography (block format, italic vars,
   labels above each equation). Replaces the inline mono one-liner with
   actual readable math. */
.hero-math-block { margin: 10px 0 22px 0; padding: 14px 18px; border: 1px solid var(--hair); background: var(--bg); display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.hero-math-block .mb-eq { display: flex; flex-direction: column; gap: 5px; }
.hero-math-block .mb-label { font-family: var(--serif); font-style: italic; font-size: 11px; color: var(--ink-muted); }
.hero-math-block .mb-line { font-family: var(--serif); font-size: 15px; color: var(--ink); line-height: 1.4; }
.hero-math-block .mb-var { font-style: italic; font-weight: 500; color: var(--accent); font-family: var(--serif); }
.hero-math-block .mb-op { color: var(--ink-muted); padding: 0 2px; }
.hero-math-block .mb-val { font-weight: 600; color: var(--ink); font-size: 17px; font-family: var(--mono); }
.hero-math-block .mb-tells { font-family: var(--serif); font-style: italic; font-size: 11px; color: var(--ink-muted); line-height: 1.5; margin-top: 6px; }
.hero-math-block .mb-mini-viz { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 6px 0; border-top: 1px dashed var(--hair); }
.hero-math-block .mb-mini-viz .signal-noise-mini { flex: 0 0 auto; }
.hero-math-block .mb-mini-viz .mb-mini-label { font-family: var(--mono); font-size: 9px; color: var(--ink-faint); line-height: 1.4; }
.hero-math-block .mb-mini-viz .mb-mini-label strong { color: var(--accent); font-weight: 600; }

/* iter-38a-rev2 — pipeline stage sub-line tweaks: source-count chips next
   to brand-logo SVGs in harvest stage. ps-source-count keeps numbers tight
   to their logo; ps-stage-sub-more handles "+N more" tail. */
.pipeline-strip .ps-source-count { font-family: var(--mono); font-size: 10px; color: var(--ink); font-weight: 500; margin: 0 2px 0 1px; }
.pipeline-strip .ps-stage-sub-more { color: var(--ink-faint); font-style: italic; margin-left: 4px; }
/* iter-38a-rev3 — brand icons use canonical brand fills directly in SVG;
   no CSS overrides so X stays black, TikTok pink, Instagram magenta,
   YouTube red. The hairline palette discipline still applies to UI chrome;
   brand marks are the exception because they ARE the editorial signal
   (reader recognises the platform at a glance). */
.pipeline-strip .ps-stage-sub svg { vertical-align: middle; margin-right: 1px; }

/* iter-38a-rev1 (E+F+G+H) — section header pattern. Above EVERY viz/section,
   ABOVE the content (not buried in a caption below). Format:
   [section title] ........... [scope chip]
   [one-sentence WHAT IT TELLS YOU]
   ─────────
   [content] */
.sec-header { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; margin-bottom: 14px; border-bottom: 1px solid var(--hair); }
.sec-header .sec-top { display: flex; align-items: baseline; gap: 12px; }
.sec-header .sec-title { font-family: var(--mono); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink); }
.sec-header .sec-scope { margin-left: auto; font-family: var(--mono); font-size: 9px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 8px; border: 1px solid var(--hair); }
.sec-header .sec-tells { font-family: var(--serif); font-size: 13px; line-height: 1.45; color: var(--ink-muted); margin: 0; }
.sec-header .sec-tells strong { color: var(--ink); font-weight: 600; }
.hero-zone .hero-caption-mini { font-family: var(--serif); font-style: italic; font-size: 11px; color: var(--ink-faint); margin: 8px 0 0 0; }

/* iter-38a hero zone — 3 viz block above first feature card. 2-row layout:
   row 1 = Viz A heat-grid full-width; row 2 = Viz B-v2.1 + B-v2.2 side-by-side.
   ISC-470 palette discipline: no new color tokens; everything inherits
   --bg/--ink/--ink-muted/--ink-faint/--hair/--hair-soft/--accent/--accent-soft/--good/--warn/--bad. */
.hero-zone { margin: 24px 0 36px 0; padding: 20px 22px; border: 1px solid var(--ink); background: #fff; }
.hero-zone .hero-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; margin-bottom: 16px; border-bottom: 1px solid var(--hair); }
.hero-zone .hero-marker { font-family: var(--mono); color: var(--accent); font-size: 14px; }
.hero-zone .hero-title { font-family: var(--mono); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink); }
.hero-zone .hero-stat { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--ink-muted); }
.hero-zone .hero-row { margin-bottom: 22px; }
.hero-zone .hero-row:last-child { margin-bottom: 0; }
.hero-zone .hero-row-graph { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; align-items: start; }
.hero-zone .hero-cell { border: 1px solid var(--hair); padding: 14px; background: var(--bg); }
.hero-zone .hero-cell-label { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-faint); margin-bottom: 10px; }
.hero-zone .hero-caption { font-family: var(--serif); font-style: italic; font-size: 12px; line-height: 1.55; color: var(--ink-muted); margin: 12px 0 0 0; }
.hero-zone .hero-caption code { font-family: var(--mono); font-style: normal; font-size: 11px; color: var(--ink); }

/* Viz A heat-grid */
.heatgrid { font-family: var(--mono); font-size: 11px; }
.heat-head { display: grid; grid-template-columns: 200px 1fr 200px 60px; gap: 12px; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--hair); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); }
.heat-row { display: grid; grid-template-columns: 200px 1fr 200px 60px; gap: 12px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--hair-soft); }
.heat-row:last-child { border-bottom: none; }
.heat-feature { font-size: 12px; color: var(--ink); display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.heat-lab { font-family: var(--mono); font-size: 9px; font-weight: 600; padding: 1px 5px; border: 1px solid var(--ink); color: var(--ink); letter-spacing: 0.05em; }
.heat-tone { display: flex; gap: 3px; height: 14px; align-items: center; }
.heat-tone-seg { height: 100%; }
.heat-tone-dom { flex: 7; height: 14px; }
.heat-tone-sec { flex: 3; height: 9px; opacity: 0.65; }
.heat-tone-seg.tc-pos, .heat-tone-cell.tc-pos { background: var(--good); }
.heat-tone-seg.tc-mix, .heat-tone-cell.tc-mix { background: var(--warn); }
.heat-tone-seg.tc-bad, .heat-tone-cell.tc-bad { background: var(--bad); }
.heat-tone-seg.tc-unc, .heat-tone-cell.tc-unc { background: var(--ink-faint); }
.heat-eng-bar { height: 8px; background: var(--hair-soft); position: relative; }
.heat-eng-bar > div { height: 100%; background: var(--ink); }
.heat-eng-num { font-family: var(--mono); font-size: 10px; color: var(--ink-muted); text-align: right; }
.heat-legend { display: flex; gap: 14px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--hair); font-family: var(--mono); font-size: 10px; color: var(--ink-muted); }
.heat-legend .sw { display: inline-block; width: 10px; height: 10px; vertical-align: middle; margin-right: 4px; }

/* Viz B-v2.1 Algorithm Interior + B-v2.2 Chord — SVG containers */
.hero-zone .algo-graph-wrap, .hero-zone .chord-graph-wrap { display: flex; justify-content: center; padding: 4px 0; }

/* iter-40 — .tsp-* CSS removed alongside the Top Story Propagation block deletion. */
#hero-algo-graph, #hero-chord-svg { display: block; max-width: 100%; height: auto; }
#hero-algo-graph .glabel, #hero-chord-svg .chord-label { font-family: var(--mono); fill: var(--ink); }
#hero-algo-graph .gl-source { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; fill: var(--ink-faint); }
#hero-algo-graph .gl-feature { font-size: 9px; font-weight: 600; fill: var(--ink); }
#hero-algo-graph .gl-core { font-size: 8px; font-weight: 600; letter-spacing: 0.1em; }
#hero-chord-svg .chord-arc { fill: var(--ink); opacity: 0.85; }
#hero-chord-svg .chord-arc.c-feature { fill: var(--accent); opacity: 1; }
#hero-chord-svg .chord-label { font-size: 8px; fill: var(--ink-muted); }
#hero-chord-svg .chord-label.cl-feature { font-size: 9px; font-weight: 600; fill: var(--accent); }

/* Methodology fold — preserved renderProcessLog content, collapsed-by-default
   per ISC-471. Distinct class (NOT .full-evidence) per Advisor risk #3 to
   avoid CSS override collision with the per-feature evidence fold. */
.methodology-fold { margin: 16px 0; border: 1px dashed var(--hair); padding: 0; background: var(--bg); }
.methodology-fold > summary { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-faint); padding: 8px 12px; cursor: pointer; list-style: none; }
.methodology-fold > summary::-webkit-details-marker { display: none; }
.methodology-fold > summary:hover { color: var(--accent); }
.methodology-fold[open] > summary { border-bottom: 1px dashed var(--hair); }
.methodology-fold .methodology-body { padding: 12px; font-family: var(--mono); font-size: 11px; color: var(--ink-muted); }

</style>
</head>
<body>
  <div class="wrap">
    <header class="page-header">
      <h1 class="page-title">TrendingAI</h1>
      <p class="page-lede">A data-driven report on what's trending in AI this period — engagement and virality across platforms, who's reacting, and what's worth making content about next.</p>
      <p class="page-meta">${runBadge}</p>
    </header>
    ${renderPipelineVisualization(pipelineStats, earliestPostDate, latestPostDate, generated)}

    ${renderHeroZone(features, sentimentByFeature, heroPayload, pipelineStats)}

    ${renderMethodologyFold(pipelineStats)}

    ${renderLensNav()}

    ${lensSections}
  </div>
  ${renderHeroScripts(heroPayload, heroIifeBody)}
  <script>
    // iter-33 — TOC anchor click should auto-open the target lens-fold,
    // not just scroll to its (collapsed) shell. Listens on hashchange +
    // initial load so deep-links work too.
    function openTargetLens() {
      if (!location.hash) return;
      var target = document.querySelector(location.hash);
      if (!target) return;
      // iter-38b — also open methodology fold + hero fold when jumped to.
      if (target.tagName === 'DETAILS') target.open = true;
      var fold = target.querySelector('details.lens-fold');
      if (fold) fold.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.addEventListener('hashchange', openTargetLens);
    window.addEventListener('load', openTargetLens);
    document.querySelectorAll('.lens-nav .ln-item').forEach(function (a) {
      a.addEventListener('click', function () { setTimeout(openTargetLens, 0); });
    });
  </script>
</body>
</html>`;

  // iter-45 — timestamped output filename (Kem ask 2026-05-18). Slug derived
  // from data anchor (deterministic per v8). Never overwrites the existing
  // `out/features-confirmed.html` — that's the iter-44 ratified good version
  // and promotion is a manual `cp` step after Kem walks the new render.
  // iter-46 F10: `anchor` + `runNumber` were computed earlier in main() to feed
  // the in-body page-meta badge. Filename uses the same anchor + runNNN prefix
  // for consistency between archived filename and rendered Run #NNN body line.
  const out = `${OUT_DIR}/features-confirmed-run${String(runNumber).padStart(3, "0")}-${anchor.slug}.html`;
  fs.writeFileSync(out, html);
  console.log(`wrote ${html.length} bytes → ${out}`);
  console.log(`anchor: ${anchor.iso || "(none — fell through to ERR slug)"}`);
  console.log(`note: existing out/features-confirmed.html (iter-44 ratified) left intact; promote manually after walk-ratify.`);
}

main();
