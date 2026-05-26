// src/validate-relevance.ts — semantic relevance validator (v0.9 verification backbone).
//
// PRIOR ART: scripts/validate-embeds.ts validated only the TOP candidate per
// (ship × source) and the rendered HTML chose to SHOW ADJACENT items with honest
// labels. Kem's v0.8-walk critique: labeling-without-filtering is the same as
// no validation — the reader still sees noise. This validator scores ALL
// top-N candidates per (ship × source); the generator (src/render-features-demo.ts)
// then DROPS ADJACENT/OFF-TOPIC content from main slots, falling through to an
// honest "no on-topic content this harvest window" empty state.
//
// VERDICT TAXONOMY (strict):
//   VALIDATED  = post is specifically about the named feature.
//   ADJACENT   = post is about a related topic in the same product surface but
//                NOT this specific feature (e.g. agentic.james's `-p`/SDK rant
//                is ADJACENT to /goal — same product, different topic).
//   OFF-TOPIC  = post is unrelated.
//
// OUTPUT: data/validation.json — one row per (ship × source × candidate).

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;

type Item = {
  url?: string;
  raw_text?: string;
  title?: string;
  author?: string;
  engagement?: number;
  meta?: Record<string, unknown>;
};

type Verdict = "VALIDATED" | "ADJACENT" | "OFF-TOPIC";

interface Result {
  ship: string;
  ship_name: string;
  source: string;
  url?: string;
  author?: string;
  engagement?: number;
  verdict: Verdict;
  reason: string;
  raw: string;
}

const SHIPS = [
  {
    id: "goal",
    name: "/goal · Claude Code",
    desc: "Anthropic Claude Code slash command that lets the user declare what 'done' looks like so the agent keeps working until it gets there.",
    terms: ["/goal", "slash command goal", "ultimate goal"],
  },
  {
    id: "codex-mobile",
    name: "Codex in ChatGPT mobile app",
    desc: "OpenAI's Codex coding agent surfaced inside the ChatGPT mobile app — start work, review output, approve next steps from a phone.",
    terms: ["codex mobile", "codex on mobile", "codex in chatgpt mobile", "codex on the chatgpt mobile", "chatgpt mobile codex"],
  },
  {
    id: "opus-4-7",
    name: "Claude Opus 4.7",
    desc: "Anthropic's Claude Opus 4.7 model release with tighter multi-step reasoning.",
    terms: ["opus 4.7", "claude opus 4.7", "opus-4-7"],
  },
  {
    id: "mcp",
    name: "Model Context Protocol",
    desc: "Anthropic's open standard for how models reach into external tools and data sources.",
    terms: ["model context protocol", " mcp ", " mcp.", " mcp,", " mcp:", "mcp server"],
  },
  {
    id: "smb",
    name: "Claude for Small Business",
    desc: "Anthropic's first SMB-targeted product tier with admin controls for 1-100 person companies.",
    terms: ["claude for small business", "claude smb", "small business plan"],
  },
  {
    id: "claude-design",
    name: "Claude Design",
    desc: "Anthropic Labs product (launched Apr 17 2026, powered by Opus 4.7) — a visual canvas for designs, prototypes, slides, and one-pagers, with its own dedicated usage tracking separate from chat or Claude Code limits.",
    terms: ["claude design", "claude.ai/design", "claude-design", "claudedesign", "anthropic design", "design canvas", "design workspace"],
  },
] as const;

const SOURCES = ["x", "tiktok", "instagram"] as const;
const MAX_CANDIDATES_PER_SHIP_PER_SOURCE = 5;
const CONCURRENCY = 4;

function loadJson(p: string): Item[] {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Item[];
  } catch {
    return [];
  }
}

function findCandidates(items: Item[], terms: readonly string[], n: number): Item[] {
  const hits = items.filter((i) => {
    const s = ((i.raw_text || "") + " " + (i.title || "") + " " + (i.url || "")).toLowerCase();
    return terms.some((t) => s.includes(t.toLowerCase()));
  });
  // ISC-F5 (2026-05-16): follower-weighted ranking. Raw engagement biases
  // toward viral randoms (582-follower account with one viral hit beats a
  // 100k-follower thoughtful post that "only" got 500 likes). The weight is
  // engagement × log(followers+10) — log-scaled so the difference between
  // 1k and 10k followers matters less than between 100 and 10k, but the
  // tail-end zero-follower noise is suppressed.
  const score = (i: Item) => {
    const eng = i.engagement || 0;
    const followers = (i.meta as { followers?: number } | undefined)?.followers || 0;
    return eng * Math.log10(followers + 10);
  };
  return hits.sort((a, b) => score(b) - score(a)).slice(0, n);
}

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
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

const SYS = `You are an editorial validator. Read the FEATURE and the POST. Decide if the post substantively discusses the named FEATURE itself (not just a related topic in the same product).
Reply with ONE line in this EXACT format:
VERDICT: <VALIDATED|ADJACENT|OFF-TOPIC> | REASON: <one short sentence>

Definitions:
- VALIDATED: post is specifically about the named feature (announces it, demos it, reacts to it, or critiques it by name).
- ADJACENT: post is about a related topic in the same product surface but NOT this specific feature. Example: a post about Claude Code's pricing/SDK changes is ADJACENT to a post about /goal — same product, different topic.
- OFF-TOPIC: post is unrelated.

Be strict. ADJACENT content will be DROPPED from the feature card. When in doubt between VALIDATED and ADJACENT, choose ADJACENT.`;

function parseVerdict(raw: string): { verdict: Verdict; reason: string; line: string } {
  const lines = raw.split("\n");
  const line = lines.find((l) => l.startsWith("VERDICT:")) ?? lines[0] ?? "";
  const m = line.match(/VERDICT:\s*(VALIDATED|ADJACENT|OFF-TOPIC)\s*\|\s*REASON:\s*(.+)/i);
  if (!m) return { verdict: "OFF-TOPIC", reason: `unparseable: ${line.slice(0, 140)}`, line };
  return { verdict: (m[1] ?? "OFF-TOPIC").toUpperCase() as Verdict, reason: (m[2] ?? "").trim(), line };
}

async function validateOne(c: {
  ship: (typeof SHIPS)[number];
  source: string;
  item: Item;
}): Promise<Result> {
  const text = (c.item.raw_text || c.item.title || "").slice(0, 1500);
  const author = c.item.author || (c.item.meta as Record<string, string> | undefined)?.author || "unknown";
  const userPrompt = `FEATURE: ${c.ship.name}
FEATURE DESCRIPTION: ${c.ship.desc}

POST AUTHOR: ${author}
POST PLATFORM: ${c.source}
POST TEXT:
"""
${text}
"""`;
  try {
    const raw = await ask(SYS, userPrompt);
    const { verdict, reason, line } = parseVerdict(raw);
    return {
      ship: c.ship.id,
      ship_name: c.ship.name,
      source: c.source,
      url: c.item.url,
      author,
      engagement: c.item.engagement,
      verdict,
      reason,
      raw: line,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ship: c.ship.id,
      ship_name: c.ship.name,
      source: c.source,
      url: c.item.url,
      author,
      engagement: c.item.engagement,
      verdict: "OFF-TOPIC",
      reason: `validator-error: ${msg.slice(0, 100)}`,
      raw: msg,
    };
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
  const dataBySource: Record<string, Item[]> = {
    x: loadJson(`${DATA}/x.json`),
    tiktok: loadJson(`${DATA}/tiktok.json`),
    instagram: loadJson(`${DATA}/instagram.json`),
  };

  const tasks: { ship: (typeof SHIPS)[number]; source: string; item: Item }[] = [];
  for (const ship of SHIPS) {
    for (const source of SOURCES) {
      const items = dataBySource[source] || [];
      const cands = findCandidates(items, ship.terms, MAX_CANDIDATES_PER_SHIP_PER_SOURCE);
      for (const item of cands) tasks.push({ ship, source, item });
    }
  }
  console.log(`ships=${SHIPS.length}, total candidates=${tasks.length}, concurrency=${CONCURRENCY}`);
  if (!tasks.length) {
    console.error("no candidates — abort");
    process.exit(1);
  }

  const t0 = Date.now();
  const results = await pool(tasks, CONCURRENCY, validateOne);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `\nvalidated ${results.length} in ${dt}s — VALIDATED:${counts.VALIDATED || 0} ADJACENT:${counts.ADJACENT || 0} OFF-TOPIC:${counts["OFF-TOPIC"] || 0}`,
  );

  // Print per-ship breakdown so Kem can eyeball
  for (const ship of SHIPS) {
    const shipResults = results.filter((r) => r.ship === ship.id);
    const valid = shipResults.filter((r) => r.verdict === "VALIDATED");
    const adj = shipResults.filter((r) => r.verdict === "ADJACENT");
    console.log(`  ${ship.id.padEnd(14)} → ${shipResults.length} cands · ${valid.length} VAL · ${adj.length} ADJ`);
  }

  fs.writeFileSync(`${DATA}/validation.json`, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${results.length} verdicts → data/validation.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
