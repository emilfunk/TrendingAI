// validate-embeds.ts — Haiku validation pass for Features v0.6 candidate embeds.
// Output: data/validation.json with VALIDATED | ADJACENT | OFF-TOPIC per (ship, source, embed)

import { spawn } from "child_process";
import * as fs from "fs";

const HOME = process.env.HOME!;
const DATA = `${process.cwd()}/data`;

type Item = { url?: string; raw_text?: string; title?: string; author?: string; engagement?: number; meta?: any };

function loadJson(path: string): Item[] {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function findTop(items: Item[], terms: string[]): Item | null {
  const hits = items.filter((i) => {
    const s = ((i.raw_text || "") + " " + (i.title || "") + " " + (i.url || "")).toLowerCase();
    return terms.some((t) => s.includes(t.toLowerCase()));
  });
  if (!hits.length) return null;
  return hits.sort((a, b) => (b.engagement || 0) - (a.engagement || 0))[0];
}

const x  = loadJson(`${DATA}/x.json`);
const tt = loadJson(`${DATA}/tiktok.json`);
const ig = loadJson(`${DATA}/instagram.json`);

const SHIPS = [
  { id: "goal",          name: "/goal · Claude Code",         desc: "An Anthropic Claude Code slash command that lets the user declare what 'done' looks like so the agent keeps working until it gets there.",
    terms: ["/goal"] },
  { id: "codex-mobile",  name: "Codex in ChatGPT mobile app", desc: "OpenAI's Codex coding agent surfaced inside the ChatGPT mobile app — start work, review output, approve next steps from a phone.",
    terms: ["codex in the chatgpt mobile", "codex on the chatgpt mobile", "codex mobile"] },
  { id: "opus-4-7",      name: "Claude Opus 4.7",             desc: "Anthropic's Claude Opus 4.7 model release with tighter multi-step reasoning.",
    terms: ["opus 4.7", "claude opus 4.7"] },
  { id: "mcp",           name: "Model Context Protocol",      desc: "Anthropic's open standard for how models reach into external tools and data sources.",
    terms: ["model context protocol", "mcp"] },
  { id: "smb",           name: "Claude for Small Business",   desc: "Anthropic's first SMB-targeted product tier with admin controls for 1-100 person companies.",
    terms: ["claude for small business", "small business"] },
  { id: "creative-work", name: "Claude for Creative Work",    desc: "Anthropic's pitch at the design and writing audience — workflow-shaped features for creative production.",
    terms: ["claude for creative work", "creative work"] },
];

const candidates: { ship: typeof SHIPS[0]; source: string; item: Item }[] = [];
for (const ship of SHIPS) {
  for (const [source, items] of [["x", x], ["tiktok", tt], ["instagram", ig]] as const) {
    const top = findTop(items, ship.terms);
    if (top) candidates.push({ ship, source, item: top });
  }
}
console.log(`SHIPS=${SHIPS.length}, candidates=${candidates.length}`);

function ask(systemPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [
      `${HOME}/.claude/PAI/TOOLS/Inference.ts`,
      "--level", "fast",
      "--timeout", "60000",
      systemPrompt,
      userPrompt,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err.slice(0,200)}`)));
  });
}

const sysPrompt = `You are an editorial classifier. Read the FEATURE and the POST. Decide whether the post substantively discusses the named FEATURE. Reply with ONE line in this format:
VERDICT: <VALIDATED|ADJACENT|OFF-TOPIC> | REASON: <one short sentence>
Definitions: VALIDATED = post is specifically about the named feature. ADJACENT = post is about a related Claude/AI/coding topic but not THIS specific feature. OFF-TOPIC = post is unrelated.`;

(async () => {
  const results: any[] = [];
  for (const c of candidates) {
    const text = (c.item.raw_text || c.item.title || "").slice(0, 1200);
    const author = c.item.author || c.item.meta?.author || "unknown";
    const userPrompt = `FEATURE: ${c.ship.name}
FEATURE DESCRIPTION: ${c.ship.desc}

POST AUTHOR: ${author}
POST PLATFORM: ${c.source}
POST TEXT:
"""
${text}
"""`;

    try {
      const verdict = await ask(sysPrompt, userPrompt);
      const line = verdict.split("\n").find((l) => l.startsWith("VERDICT:")) || verdict.split("\n")[0];
      console.log(`[${c.ship.id.padEnd(14)} / ${c.source.padEnd(10)} / @${author.padEnd(22)}] ${line.slice(0,140)}`);
      results.push({ ship: c.ship.id, ship_name: c.ship.name, source: c.source, url: c.item.url, author, engagement: c.item.engagement, raw: verdict, line });
    } catch (e: any) {
      console.log(`[${c.ship.id} / ${c.source} / @${author}] ERROR: ${e.message}`);
      results.push({ ship: c.ship.id, ship_name: c.ship.name, source: c.source, url: c.item.url, author, error: e.message });
    }
  }
  fs.writeFileSync(`${DATA}/validation.json`, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${results.length} verdicts → data/validation.json`);
})();
