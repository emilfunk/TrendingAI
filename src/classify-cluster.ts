// src/classify-cluster.ts — content-type classifier for discovery clusters (v1.1).
//
// Kem 2026-05-16: the references he names (/goal, Opus 4.7, MCP, Claude Design)
// are ground-truth indicators of whether the surfacing is honest — NOT inputs
// to a hardcoded search. His role is qualitative evaluator; the system's role
// is to discover. The v1.1 discover.ts pivot removed the hardcoded SHIPS oracle
// and clusters items via dedupe.ts + ranks by trending signal. First-pass
// output (data/discovery.json) showed the honest truth: TT/IG creator
// economy is dominated by tutorial content ("5 things to do with Claude",
// "AI hacks") — they out-rank actual feature announcements in raw signal.
//
// This classifier types each top cluster so the render can SEPARATE
// feature-trending from tutorial-trending. Both views matter (creator-decision
// support needs both "what's NEW to react to" and "what TEMPLATES are working"),
// but they're different lenses.
//
// CONTENT TYPES:
//   LAB_ANNOUNCE     — a lab (Anthropic/OpenAI/Google/Meta) announcing a feature
//   FEATURE_REACTION — a creator reacting to / demoing / critiquing a specific named feature
//   TOOL_RELEASE     — a third-party tool / repo release (Grok Build, fabric, etc.)
//   NEWS             — press/editorial coverage of a story
//   TUTORIAL         — "5 things to know" / "how to use" generic guides
//   ENTERTAINMENT    — astrology / sandwich / unrelated content
//   DRAMA            — public criticism / controversy / pricing complaints
//   OTHER            — doesn't fit cleanly
//
// OUTPUT: data/discovery-typed.json — discovery.json + content_type + reason

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;
const CONCURRENCY = 4;

type ContentType = "LAB_ANNOUNCE" | "FEATURE_REACTION" | "TOOL_RELEASE" | "NEWS" | "TUTORIAL" | "ENTERTAINMENT" | "DRAMA" | "OTHER";

interface DiscoveryCluster {
  rank: number;
  label: string;
  trending_score: number;
  signals: Record<string, unknown>;
  rep_item: { source: string; author: string; engagement: number; followers: number; url?: string; title: string };
  sample_titles: string[];
  sources_breakdown: Record<string, number>;
}

interface TypedCluster extends DiscoveryCluster {
  content_type: ContentType;
  type_reason: string;
  feature_relevant: boolean;
}

const SYS = `You are a content-type classifier for AI-news clusters. Read the CLUSTER LABEL and SAMPLE TITLES, then output ONE LINE in this exact format:
TYPE: <LAB_ANNOUNCE|FEATURE_REACTION|TOOL_RELEASE|NEWS|TUTORIAL|ENTERTAINMENT|DRAMA|OTHER> | REASON: <one short sentence>

Definitions:
- LAB_ANNOUNCE: a major lab (Anthropic, OpenAI, Google DeepMind, Meta, xAI) announcing a specific named feature or product release.
- FEATURE_REACTION: a creator or developer reacting to, demoing, critiquing, or detailing a SPECIFIC named feature (e.g. "I tried /goal", "Opus 4.7 is great at X").
- TOOL_RELEASE: a third-party tool, repo, framework, or library release (e.g. Grok Build, fabric, new MCP server, GitHub project launch).
- NEWS: press/editorial coverage of an AI industry story (acquisition, deal, regulation, hire).
- TUTORIAL: generic "top 5 Claude tips", "AI hacks", "how to use ChatGPT", evergreen explainer content not tied to a specific feature release.
- ENTERTAINMENT: astrology, memes, viral video unrelated to AI substance, off-topic content that happened to use AI hashtags.
- DRAMA: public criticism, pricing complaints, controversy, layoff news, criticism of a company's behavior.
- OTHER: doesn't fit cleanly.

Pick the BEST single type. When a cluster has mixed content, classify by the REP (highest-engagement item).`;

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
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`))));
  });
}

function parseLine(raw: string): { type: ContentType; reason: string } {
  const lines = raw.split("\n");
  const line = lines.find((l) => l.startsWith("TYPE:")) ?? lines[0] ?? "";
  const m = line.match(/TYPE:\s*(LAB_ANNOUNCE|FEATURE_REACTION|TOOL_RELEASE|NEWS|TUTORIAL|ENTERTAINMENT|DRAMA|OTHER)\s*\|\s*REASON:\s*(.+)/i);
  if (!m) return { type: "OTHER", reason: `unparseable: ${line.slice(0, 140)}` };
  return { type: (m[1] ?? "OTHER").toUpperCase() as ContentType, reason: (m[2] ?? "").trim() };
}

async function classifyOne(c: DiscoveryCluster): Promise<TypedCluster> {
  const sample = c.sample_titles.slice(0, 4).map((t, i) => `  ${i + 1}. ${t.slice(0, 200)}`).join("\n");
  const platforms = Object.entries(c.sources_breakdown).map(([k, v]) => `${k}:${v}`).join(", ");
  const userPrompt = `CLUSTER LABEL: ${c.label.slice(0, 200)}
PLATFORM BREAKDOWN: ${platforms}
REP AUTHOR: @${c.rep_item.author} (${c.rep_item.followers} followers, ${c.rep_item.engagement} engagement)

SAMPLE TITLES (top 4 by engagement):
${sample}`;
  try {
    const raw = await ask(SYS, userPrompt);
    const { type, reason } = parseLine(raw);
    const feature_relevant = type === "LAB_ANNOUNCE" || type === "FEATURE_REACTION" || type === "TOOL_RELEASE" || type === "DRAMA" || type === "NEWS";
    return { ...c, content_type: type, type_reason: reason, feature_relevant };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...c, content_type: "OTHER", type_reason: `classifier-error: ${msg.slice(0, 80)}`, feature_relevant: false };
  }
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
  if (!fs.existsSync(`${DATA}/discovery.json`)) {
    console.error("data/discovery.json missing — run src/discover.ts first");
    process.exit(1);
  }
  const clusters: DiscoveryCluster[] = JSON.parse(fs.readFileSync(`${DATA}/discovery.json`, "utf-8"));
  console.log(`classifying ${clusters.length} clusters by content-type (concurrency=${CONCURRENCY})...`);
  const t0 = Date.now();
  const typed = await pool(clusters, CONCURRENCY, classifyOne);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const counts: Record<string, number> = {};
  for (const t of typed) counts[t.content_type] = (counts[t.content_type] || 0) + 1;
  console.log(`\ntyped ${typed.length} clusters in ${dt}s:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);

  fs.writeFileSync(`${DATA}/discovery-typed.json`, JSON.stringify(typed, null, 2));
  console.log(`\nwrote → data/discovery-typed.json`);

  // Feature-trending lens: only LAB_ANNOUNCE + FEATURE_REACTION + TOOL_RELEASE
  const featureLens = typed.filter((t) => t.feature_relevant && (t.content_type === "LAB_ANNOUNCE" || t.content_type === "FEATURE_REACTION" || t.content_type === "TOOL_RELEASE"));
  featureLens.sort((a, b) => b.trending_score - a.trending_score);
  console.log(`\n=== FEATURE-TRENDING LENS (LAB_ANNOUNCE + FEATURE_REACTION + TOOL_RELEASE), top 15 ===`);
  for (const t of featureLens.slice(0, 15)) {
    console.log(`  #${String(t.rank).padStart(2)} [${t.content_type.padEnd(16)}] score=${String(t.trending_score).padStart(5)}  ${t.label.slice(0, 90)}`);
    console.log(`        → ${t.type_reason.slice(0, 130)}`);
  }

  console.log(`\n=== TUTORIAL LENS (creator-template trending), top 10 ===`);
  const tutorialLens = typed.filter((t) => t.content_type === "TUTORIAL").sort((a, b) => b.trending_score - a.trending_score).slice(0, 10);
  for (const t of tutorialLens) {
    console.log(`  #${String(t.rank).padStart(2)} score=${String(t.trending_score).padStart(5)}  ${t.label.slice(0, 100)}`);
  }

  // Ground-truth audit: did Kem's references surface ANYWHERE?
  const truthRefs = ["/goal", "opus 4.7", "claude opus 4.7", "claude design", "model context protocol", "mcp ", "codex mobile", "codex on mobile", "claude for small business", "claude smb", "cowork"];
  console.log(`\n=== GROUND-TRUTH AUDIT (Kem's reference features) ===`);
  for (const ref of truthRefs) {
    const matches = typed.filter((t) => {
      const blob = (t.label + " " + t.sample_titles.join(" ")).toLowerCase();
      return blob.includes(ref.toLowerCase());
    });
    if (matches.length === 0) {
      console.log(`  ✗ "${ref}" → NOT SURFACED in any of ${typed.length} top clusters`);
    } else {
      console.log(`  ✓ "${ref}" → ${matches.length} cluster(s): ` + matches.slice(0, 2).map((m) => `#${m.rank} [${m.content_type}]`).join(", "));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
