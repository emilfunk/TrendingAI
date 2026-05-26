import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SOURCE_REGISTRY, coverageForRun, type CoverageMode } from './sources.ts';
import type { ChannelCadence, Cluster, NormalizedItem, RunStats, Source } from './types.ts';
import { computeCadence } from './cadence.ts';

const CADENCE_CAP = 8;

export function clusterHasTranscript(c: Cluster): boolean {
  return c.items.some((i) => (i.meta as { transcript_status?: string } | undefined)?.transcript_status === 'present');
}

export function cadenceAside(cadences: ChannelCadence[]): string {
  const active = cadences
    .filter((c) => c.items_30d > 0)
    .sort((a, b) => b.items_30d - a.items_30d)
    .slice(0, CADENCE_CAP);
  if (active.length === 0) return '';
  const rows = active
    .map((c) => {
      const name = escapeHtml(c.channelId.replace(/_/g, ' '));
      const gap = c.avg_gap_hours === null ? '—' : `${c.avg_gap_hours}h`;
      return `<li><b>${name}</b> · ${c.items_30d} in 30d · avg gap ${gap}</li>`;
    })
    .join('');
  return `<aside class="cadence-aside"><h3>YouTube cadence (last 30d)</h3><ul>${rows}</ul><small>From <code>data/raw/youtube/</code> snapshots; sparse channels omitted (anti per ISC-237).</small></aside>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Deterministic thousands grouping (no locale/ICU dependency — ISC-61).
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Source label + accent now live in the registry (src/sources.ts) — one home
// for source metadata, not three. These derived maps keep the call sites below
// unchanged.
const SOURCE_LABEL = Object.fromEntries(
  Object.entries(SOURCE_REGISTRY).map(([s, m]) => [s, m.label]),
) as Record<Source, string>;
const SOURCE_ACCENT = Object.fromEntries(
  Object.entries(SOURCE_REGISTRY).map(([s, m]) => [s, m.accent]),
) as Record<Source, string>;

/**
 * ISC-69 — render the "covered live ≠ covered by replay" distinction in the
 * footer. A frozen-snapshot source is reported as "covered by replay", never
 * silently as an autonomous live source; Class-2 sources surface their note.
 */
function coverageFooter(stats: RunStats): string {
  const cov = coverageForRun(stats.source_counts);
  const group = (m: CoverageMode): string => {
    const rows = cov.filter((c) => c.mode === m);
    if (rows.length === 0) return '—';
    return rows
      .map((c) => `${SOURCE_REGISTRY[c.source].label}${m === 'absent' ? '' : ` ${c.count}`}`)
      .join(', ');
  };
  const class2Notes = cov
    .filter((c) => SOURCE_REGISTRY[c.source].authClass === 'class-2' && c.mode !== 'live')
    .map((c) => SOURCE_REGISTRY[c.source].note)
    .filter((n): n is string => Boolean(n));
  const noteHtml = class2Notes.length
    ? `<span class="cov-note">${escapeHtml(class2Notes.join(' '))}</span>`
    : '';
  return (
    `Covered live: ${escapeHtml(group('live'))} · ` +
    `Covered by replay: ${escapeHtml(group('replay'))} · ` +
    `Not covered this run: ${escapeHtml(group('absent'))}. ` +
    `A frozen-snapshot replay is counted as "covered by replay", never as an autonomous live source.${noteHtml}`
  );
}

function sentenceCase(s: string): string {
  if (!s) return s;
  return s[0]?.toUpperCase() + s.slice(1);
}

// ISC-160/162 (Session 19) — reception evidence surface.
// `meta.reception` is written by classify-reception.ts only for items with
// captured comments. Items without comments (or runs that short-circuit out
// of live mode) have no `meta.reception` — they render with NO reception
// line, never a fabricated neutral (ISC-162 anti).
type ReceptionMeta = {
  sentiment?: string;
  ratioed?: boolean;
  endorsed?: boolean;
  anchor?: string;
  anchorValid?: boolean;
  reason?: string;
};

const ANCHOR_MAX = 100;

function receptionLabel(r: ReceptionMeta): string {
  if (r.anchorValid === true && r.ratioed === true) return 'ratioed';
  if (r.anchorValid === true && r.endorsed === true) return 'endorsed';
  return r.sentiment || 'unknown';
}

function receptionHtml(item: NormalizedItem): string {
  const r = item.meta?.reception as ReceptionMeta | undefined;
  if (!r) return '';
  const label = receptionLabel(r);
  const anchorRaw = r.anchor || '';
  const truncated = anchorRaw.length > ANCHOR_MAX
    ? anchorRaw.slice(0, ANCHOR_MAX) + '…'
    : anchorRaw;
  const quoted = truncated ? `"${truncated}"` : '(no anchor)';
  return `<span class="reception reception-${escapeHtml(label)}">${escapeHtml(label)}: ${escapeHtml(quoted)}</span>`;
}

function prettyLabel(c: Cluster): string {
  if (c.items.length === 1) {
    const item = c.items[0];
    if (!item) return c.label;
    if (item.source === 'frontier') return item.title.replace(/^\[[^\]]+\]\s*/, '');
    if (item.source === 'x') return item.title.split(': ').slice(1).join(': ') || item.title;
    return sentenceCase(item.title.replace(/^\[[^\]]+\]\s*/, ''));
  }
  return sentenceCase(c.label.replace(/\b\w/g, (m, idx, str) => idx === 0 ? m.toUpperCase() : m));
}

function confidencePill(c: Cluster['confidence']): string {
  const color = c === 'HIGH' ? '#15803d' : c === 'MED' ? '#a16207' : '#525252';
  const label = c === 'HIGH' ? 'high' : c === 'MED' ? 'med' : 'low';
  return `<span class="pill conf-${c.toLowerCase()}" style="--pill:${color}">${label} confidence</span>`;
}

function sourcePill(s: Source): string {
  const color = SOURCE_ACCENT[s];
  return `<span class="source-pill" style="--pill:${color}">${SOURCE_LABEL[s]}</span>`;
}

function sparkline(items: Cluster['items']): string {
  const tsList = items
    .map((i) => Date.parse(i.ts))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (tsList.length < 2) return '';
  const min = tsList[0]!;
  const max = tsList[tsList.length - 1]!;
  const range = Math.max(1, max - min);
  const points = tsList.map((t, i) => {
    const x = 4 + ((t - min) / range) * 92;
    const y = 12 - (i / Math.max(1, tsList.length - 1)) * 8;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function topicBlock(c: Cluster, opts: { showScores?: boolean } = {}): string {
  const sources = Array.from(new Set(c.items.map((i) => i.source))).sort();
  const sample = c.items[0];
  const label = prettyLabel(c);
  const summary = sample ? escapeHtml(sample.raw_text.slice(0, 240)) : '';
  const accent = sample ? SOURCE_ACCENT[sample.source] : '#7c7c7c';

  const sourceBlocks = sources
    .map((s) => {
      const itemsForSource = c.items.filter((i) => i.source === s);
      const links = itemsForSource
        .slice(0, 3)
        .map((i) => {
          const t = escapeHtml(i.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 96));
          // Claim boundary (ISC-58/59): every rendered item carries its source
          // permalink, the raw metric it was scored on, and its capture time.
          const metric = groupDigits(i.engagement);
          const cap = escapeHtml(i.captured_at || 'unknown');
          const rec = receptionHtml(i);
          return `<div class="claim-item"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${t}</a><span class="claim-meta">📊 ${metric} engagement · 📸 captured ${cap}</span>${rec}</div>`;
        })
        .join('');
      return `<div class="src" style="--accent:${SOURCE_ACCENT[s]}">${sourcePill(s)} <span class="src-count">${itemsForSource.length} item${itemsForSource.length === 1 ? '' : 's'}</span><div class="src-links">${links}</div></div>`;
    })
    .join('');

  const scoreLine = opts.showScores
    ? `<div class="scores">score <b>${c.score.toFixed(2)}</b> · viral <b>${c.viral_score.toFixed(2)}</b> · pre-viral <b>${c.pre_viral_score.toFixed(2)}</b> · velocity ${c.velocity.toFixed(2)} · cross-src ${c.cross_source.toFixed(2)}</div>`
    : `<div class="scores">score <b>${c.score.toFixed(2)}</b> · velocity ${c.velocity.toFixed(2)} · cross-src ${c.cross_source.toFixed(2)}</div>`;

  const transcriptMarker = clusterHasTranscript(c)
    ? `<span class="has-transcript" title="cluster includes a transcript-bearing video">📝</span>`
    : '';

  return `
    <article class="topic" style="--accent:${accent}">
      <header>
        <h3>${transcriptMarker}${escapeHtml(label)}</h3>
        <div class="meta-row">
          ${confidencePill(c.confidence)}
          <span class="spark-wrap" title="item timing">${sparkline(c.items)}</span>
        </div>
      </header>
      <p class="summary">${summary}</p>
      ${scoreLine}
      <div class="sources">${sourceBlocks}</div>
    </article>
  `;
}

function lensSection(title: string, subtitle: string, clusters: Cluster[], icon: string): string {
  if (clusters.length === 0) return '';
  return `
    <section class="lens">
      <header class="lens-head">
        <h2><span class="lens-icon">${icon}</span> ${title}</h2>
        <p class="lens-sub">${subtitle}</p>
      </header>
      <div class="lens-grid">
        ${clusters.map((c) => topicBlock(c, { showScores: true })).join('')}
      </div>
    </section>
  `;
}

const PER_SOURCE_CAP = 12;

/**
 * ISC-120 — every contributing source gets its own ranked, capped section.
 * Previously this filtered the global top-N, so a high-volume but lower-scored
 * source (HN, 81 items) could get zero blocks. Now each platform ranks its own
 * clusters by that platform's peak engagement (cluster score breaks ties) —
 * "trending by platform" needs per-platform RANKING, not just sectioning.
 */
function sourceSection(source: Source, allClusters: Cluster[]): string {
  const ranked = allClusters
    .filter((c) => c.items.some((i) => i.source === source))
    .map((c) => ({
      c,
      srcEng: Math.max(
        0,
        ...c.items.filter((i) => i.source === source).map((i) => i.engagement),
      ),
    }))
    .sort((a, b) => b.srcEng - a.srcEng || b.c.score - a.c.score)
    .slice(0, PER_SOURCE_CAP)
    .map((x) => x.c);
  if (ranked.length === 0) return '';
  return `
    <section class="src-section">
      <h2 style="--accent:${SOURCE_ACCENT[source]}">${SOURCE_LABEL[source]} <span class="src-count">${ranked.length}</span></h2>
      ${ranked.map((c) => topicBlock(c)).join('')}
    </section>
  `;
}

/**
 * ISC-135 / ISC-178 (Session 19.5) — the "What's Viral" lens. Surfaces short-
 * form social clusters (TikTok + Instagram) as a distinct reader lens, separate
 * from the per-platform sections AND from the viral / pre-viral lenses.
 *
 * Anti-criterion ISC-179: a tiktok/instagram item with `engagement === 0` AND
 * no `meta.media` is junk noise (degraded fixture / dead account) — the lens
 * filters those out at the item level so a cluster that would otherwise carry
 * one good reel doesn't get polluted by an empty placeholder. A cluster with
 * zero surviving short-video items after the filter is dropped from the lens.
 *
 * Cluster selection: any cluster with ≥1 tiktok OR instagram item is a candidate;
 * the item-level filter then strips junk; clusters left with no short-video
 * items are skipped. The ranking inside is by cluster.score (same as the other
 * lenses), capped at 12 — keeps the surface scannable.
 */
const WHATS_VIRAL_CAP = 12;
const WHATS_VIRAL_SOURCES: ReadonlySet<Source> = new Set<Source>(['tiktok', 'instagram']);

export function whatsViralLens(clusters: Cluster[]): Cluster[] {
  const candidates = clusters.filter((c) =>
    c.items.some((i) => WHATS_VIRAL_SOURCES.has(i.source)),
  );
  // ISC-179: filter to "media-rich OR has engagement" at the item level — the
  // anti-criterion targets junk short-video items, not the cluster.
  const cleaned = candidates
    .map((c) => {
      const kept = c.items.filter((i) => {
        if (!WHATS_VIRAL_SOURCES.has(i.source)) return true;
        const hasMedia = Boolean(
          (i.meta as { media?: unknown } | undefined)?.media,
        );
        return i.engagement > 0 || hasMedia;
      });
      // The cluster needs ≥1 surviving short-video item to remain in this lens;
      // otherwise it belongs in some other section, not "What's Viral".
      const hasShortVideo = kept.some((i) => WHATS_VIRAL_SOURCES.has(i.source));
      if (!hasShortVideo || kept.length === 0) return null;
      return { ...c, items: kept };
    })
    .filter((c): c is Cluster => c !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, WHATS_VIRAL_CAP);
  return cleaned;
}

export type RenderInput = {
  viral: Cluster[];
  preViral: Cluster[];
  /**
   * ISC-120 — the full verified+tagged cluster set. Each source section ranks
   * and caps its own slice of this, so every contributing source renders —
   * not just whichever clusters made a global top-N.
   */
  all: Cluster[];
};

export async function render(input: RenderInput, stats: RunStats, outPath: string): Promise<void> {
  const { viral, preViral, all } = input;
  if (all.length === 0 && viral.length === 0) {
    throw new Error('No clusters to render — refusing empty report (ISC-26).');
  }
  for (const c of [...all, ...viral, ...preViral]) {
    if (c.items.length === 0) throw new Error(`Empty cluster ${c.id} — refusing (ISC-26).`);
    for (const it of c.items) {
      if (!it.url) throw new Error(`Cluster ${c.id} item missing url — refusing (ISC-27).`);
      // Claim boundary (ISC-59): no rendered claim is untraceable. url is hard-
      // required above; captured_at is set by the harvest/fixture layer — this
      // is the last-resort guarantee it is never blank in the output. Uses a
      // falsy check, not ??=, so an empty-string or malformed value also
      // degrades to 'unknown' rather than rendering blank.
      if (!it.captured_at) it.captured_at = 'unknown';
    }
  }
  const generated = stats.generated_at;
  // ISC-236: per-channel cadence aside renders below the YouTube section. The
  // computeCadence helper reads data/raw/youtube/*.xml snapshots; ISC-237 anti
  // — when the dir is missing or empty, it returns [] and the aside is a no-op.
  const cadences = await computeCadence();
  const cadenceBlock = cadenceAside(cadences);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Trending in AI · ${generated.slice(0, 10)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap");

:root {
  color-scheme: dark light;
  --bg: #0b0d12;
  --bg-elev: #141821;
  --bg-elev-2: #1c2230;
  --fg: #e8eaed;
  --fg-mute: #98a0b3;
  --fg-faint: #6b7385;
  --border: #232a39;
  --border-soft: #1a202b;
  --link: #9ecaff;
  --pill: #525252;
  --accent: #7c7c7c;
  --hero-grad: linear-gradient(135deg, #1a1f2b 0%, #131722 100%);
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafbfc;
    --bg-elev: #ffffff;
    --bg-elev-2: #f4f5f7;
    --fg: #1a1f2b;
    --fg-mute: #586176;
    --fg-faint: #8b93a5;
    --border: #e3e6ed;
    --border-soft: #ecf0f6;
    --link: #0b5fff;
    --hero-grad: linear-gradient(135deg, #f0f3f8 0%, #e6eaf2 100%);
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-feature-settings: "ss01", "cv11";
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 {
  font-family: "Fraunces", Georgia, "Times New Roman", serif;
  font-weight: 600;
  letter-spacing: -0.015em;
}

header.top {
  max-width: 1180px;
  margin: 0 auto;
  padding: 56px 28px 24px;
  background: var(--hero-grad);
  border-bottom: 1px solid var(--border);
}
header.top h1 {
  margin: 0 0 8px;
  font-size: clamp(34px, 4.5vw, 46px);
  line-height: 1.05;
  font-weight: 700;
}
header.top .kicker {
  font-family: "Inter", sans-serif;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-mute);
  margin-bottom: 14px;
  font-weight: 500;
}
header.top .sub {
  color: var(--fg-mute);
  font-size: 15px;
  max-width: 720px;
}

main {
  max-width: 1180px;
  margin: 0 auto;
  padding: 8px 28px 56px;
}

section.lens {
  margin: 40px 0 16px;
  padding: 28px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
}
section.lens.viral { background: linear-gradient(180deg, color-mix(in oklab, var(--bg-elev) 88%, #ff4d4d 12%) 0%, var(--bg-elev) 100%); }
section.lens.pre-viral { background: linear-gradient(180deg, color-mix(in oklab, var(--bg-elev) 88%, #4d8eff 12%) 0%, var(--bg-elev) 100%); }
section.lens.whats-viral { background: linear-gradient(180deg, color-mix(in oklab, var(--bg-elev) 88%, #ff0050 12%) 0%, var(--bg-elev) 100%); }
.lens-head { margin: 0 0 18px; display: flex; flex-direction: column; gap: 4px; }
.lens-head h2 { margin: 0; font-size: 26px; display: flex; align-items: center; gap: 12px; }
.lens-icon { font-size: 22px; }
.lens-sub { margin: 0; color: var(--fg-mute); font-size: 14px; max-width: 760px; }
.lens-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }

section.src-section { margin: 36px 0 8px; }
section.src-section > h2 {
  font-size: 20px;
  margin: 0 0 14px;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  position: relative;
}
section.src-section > h2::before {
  content: '';
  display: inline-block;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent);
  margin-right: 10px;
  vertical-align: middle;
}

article.topic {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 12px 0;
  transition: border-color 160ms ease, transform 160ms ease;
}
article.topic:hover { border-color: var(--accent); transform: translateY(-1px); }
article.topic > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 6px; }
article.topic h3 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; }
.meta-row { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.pill, .source-pill {
  display: inline-block;
  font-family: "Inter", sans-serif;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  letter-spacing: 0.02em;
  background: color-mix(in oklab, var(--pill) 22%, transparent);
  color: var(--pill);
  border: 1px solid color-mix(in oklab, var(--pill) 35%, transparent);
}
.source-pill { background: color-mix(in oklab, var(--pill) 16%, transparent); }
.spark-wrap { display: inline-flex; width: 60px; height: 14px; color: var(--fg-faint); }
.spark { width: 100%; height: 100%; }
.summary { color: var(--fg); margin: 6px 0 10px; font-size: 14.5px; }
.scores { color: var(--fg-mute); font-size: 12px; font-family: "Inter", monospace; letter-spacing: 0.01em; margin: 4px 0 10px; }
.scores b { color: var(--fg); font-weight: 600; }
.sources { display: flex; flex-direction: column; gap: 6px; }
.src {
  font-size: 13px;
  padding: 8px 11px;
  background: var(--bg-elev-2);
  border-radius: 7px;
  border-left: 2px solid var(--accent);
}
.src-count { color: var(--fg-mute); font-size: 11.5px; margin-left: 4px; }
.src-links { margin-top: 4px; line-height: 1.5; }
.claim-item { margin: 6px 0; }
.claim-item:first-child { margin-top: 0; }
.claim-meta { display: block; font-size: 11px; color: var(--fg-faint); font-family: "Inter", ui-monospace, monospace; letter-spacing: 0.01em; margin-top: 1px; }
.reception { display: block; font-size: 12px; margin-top: 3px; padding: 3px 7px; border-radius: 4px; font-family: "Inter", sans-serif; letter-spacing: 0.01em; font-style: italic; background: color-mix(in oklab, var(--fg) 6%, transparent); border-left: 2px solid var(--fg-faint); color: var(--fg-mute); }
.reception-ratioed { background: color-mix(in oklab, #dc2626 14%, transparent); border-left-color: #dc2626; color: color-mix(in oklab, #fecaca 92%, var(--fg) 8%); }
.reception-endorsed { background: color-mix(in oklab, #15803d 14%, transparent); border-left-color: #15803d; color: color-mix(in oklab, #bbf7d0 92%, var(--fg) 8%); }
.reception-positive { background: color-mix(in oklab, #15803d 9%, transparent); border-left-color: #15803d; }
.reception-negative { background: color-mix(in oklab, #dc2626 9%, transparent); border-left-color: #dc2626; }
.reception-mixed { background: color-mix(in oklab, #a16207 9%, transparent); border-left-color: #a16207; }
.reception-neutral { background: color-mix(in oklab, var(--fg) 4%, transparent); border-left-color: var(--fg-faint); }
.src a { color: var(--link); text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 120ms; }
.src a:hover { border-bottom-color: var(--link); }
.has-transcript { display: inline-block; margin-right: 6px; font-size: 14px; opacity: 0.85; cursor: default; }
.cadence-aside { max-width: 1180px; margin: 14px auto 28px; padding: 14px 18px; background: var(--bg-elev); border-radius: 8px; border-left: 3px solid #cc0000; }
.cadence-aside h3 { margin: 0 0 8px; font-size: 14px; color: var(--fg-mute); letter-spacing: 0.05em; text-transform: uppercase; }
.cadence-aside ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px 18px; font-size: 13px; }
.cadence-aside li b { color: var(--fg); font-weight: 600; }
.cadence-aside small { display: block; margin-top: 10px; color: var(--fg-faint); font-size: 11px; font-style: italic; }

footer {
  color: var(--fg-faint);
  font-size: 12px;
  padding: 32px 28px 56px;
  max-width: 1180px;
  margin: 0 auto;
  border-top: 1px solid var(--border);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
footer .ftr-row b { color: var(--fg-mute); font-weight: 500; display: block; margin-bottom: 2px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
footer .cov-note { display: block; margin-top: 4px; color: var(--fg-faint); font-style: italic; }
code { background: color-mix(in oklab, var(--fg) 8%, transparent); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
</style>
</head>
<body>
<header class="top">
  <div class="kicker">Trending in AI · ${generated.slice(0, 10)}</div>
  <h1>What's moving in AI right now</h1>
  <p class="sub">Cross-source signal from frontier labs, research preprints, top repos, and the conversation around them. Every link verified live before render. Confidence reflects independent corroboration, not popularity.</p>
</header>
<main>
${viral.length > 0 ? `<div class="lens viral">${lensSection('Going Viral Now', 'Peak engagement crossed with cross-source corroboration. These are the topics the crowd is already on.', viral, '🔥').replace('<section class="lens">', '')}</section>` : ''}
${preViral.length > 0 ? `<div class="lens pre-viral">${lensSection('Pre-Viral Signal', 'Recent items from research preprints and frontier-lab announcements with low current engagement. Leading indicators — what the smart money is reading before it breaks.', preViral, '📡').replace('<section class="lens">', '')}</section>` : ''}
${(() => { const wv = whatsViralLens(all); return wv.length > 0 ? `<div class="lens whats-viral">${lensSection("What's Viral", 'Short-form AI content from TikTok + Instagram — feature demos, reactions, how-tos. The platforms where the conversation looks different from text-feeds. Reel links open in-platform.', wv, '🎬').replace('<section class="lens">', '')}</section>` : ''; })()}
${sourceSection('frontier', all)}
${sourceSection('editorial', all)}
${sourceSection('enterprise', all)}
${sourceSection('arxiv', all)}
${sourceSection('github', all)}
${sourceSection('x', all)}
${sourceSection('youtube', all)}
${cadenceBlock}
${sourceSection('reddit', all)}
${sourceSection('bluesky', all)}
${sourceSection('hn', all)}
${sourceSection('tiktok', all)}
${sourceSection('instagram', all)}
</main>
<footer>
  <div class="ftr-row"><b>Generated</b><code>${generated}</code></div>
  <div class="ftr-row"><b>Sources</b>Frontier ${stats.source_counts.frontier ?? 0} · Editorial ${stats.source_counts.editorial ?? 0} · Enterprise ${stats.source_counts.enterprise ?? 0} · arXiv ${stats.source_counts.arxiv ?? 0} · GitHub ${stats.source_counts.github ?? 0} · YouTube ${stats.source_counts.youtube ?? 0} · Reddit ${stats.source_counts.reddit ?? 0} · Bluesky ${stats.source_counts.bluesky ?? 0} · HN ${stats.source_counts.hn ?? 0} · X ${stats.source_counts.x ?? 0} · TikTok ${stats.source_counts.tiktok ?? 0} · Instagram ${stats.source_counts.instagram ?? 0}</div>
  <div class="ftr-row"><b>Dedupe</b>${stats.dedupe_in} in → ${stats.dedupe_out} out</div>
  <div class="ftr-row"><b>URL verification</b>${stats.verification_pass_rate === null ? 'skipped — fixture mode (URLs not probed)' : `${(stats.verification_pass_rate * 100).toFixed(1)}% pass rate`}</div>
  <div class="ftr-row" style="grid-column: 1 / -1; margin-top: 6px;"><b>Pipeline</b>harvest → dedupe → cluster → score → verify URLs → tag confidence → lens (viral / pre-viral / by-source) → render</div>
  <div class="ftr-row" style="grid-column: 1 / -1;"><b>Verifiability</b>Every item shows its source permalink, the raw engagement metric it was scored on, and when that data was captured — so any claim is hand-checkable against the live platform. Note: traceability ≠ correctness — the metric is traceable to its source, not independently verified.</div>
  <div class="ftr-row" style="grid-column: 1 / -1;"><b>Coverage</b>${coverageFooter(stats)}</div>
</footer>
</body>
</html>
`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html);
}
