// extract-security-entities.ts — iter-42 D2 (v8 doctrine)
//
// Mirror of scripts/extract-industry-news-entities.ts for the Security lens.
// Reads data/youtube.json (60 hydrated podcast transcripts), counts
// security-concept mentions per transcript, counts co-occurrences per pair
// (both concepts surfaced in the same transcript = +1 edge weight). Writes
// data/security-entities.json.
//
// The concept DICTIONARY is curated in-repo (schema layer) — versioned,
// transparent, inspectable. The COUNTS are corpus-derived (data layer).
// Same pattern as extract-industry-news-entities.ts.
//
// "Entities" here are SECURITY CONCEPTS / NAMED INCIDENTS rather than
// people/orgs — TanStack supply-chain hack, prompt-injection class, reward
// hacking, model welfare, etc. Category drives the constellation palette.
//
// Output is deterministic — same youtube.json → byte-identical entities JSON.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const YT_PATH = join(ROOT, "data", "youtube.json");
const OUT_PATH = join(ROOT, "data", "security-entities.json");

interface EntityDef {
  id: string;
  category: "alignment" | "supply-chain" | "agentic" | "cyber" | "red-team" | "policy";
  aliases: string[]; // matched case-insensitive whole-word; canonical id auto-included
}

// Curated security-concept dictionary. Six categories drive the constellation
// color palette. Aliases let surface-spellings match a single canonical id
// (TanStack also matches Tanstack/tanstack; zero-day also matches zeroday).
const ENTITY_DICT: EntityDef[] = [
  // Alignment-research — what labs talk about when they talk about safety
  { id: "reward hacking", category: "alignment", aliases: ["reward hack", "reward hacky", "reward hacks"] },
  { id: "model welfare", category: "alignment", aliases: [] },
  { id: "misalignment", category: "alignment", aliases: ["misaligned"] },
  { id: "deceptive alignment", category: "alignment", aliases: [] },
  { id: "interpretability", category: "alignment", aliases: ["interpretable"] },
  { id: "alignment", category: "alignment", aliases: [] },

  // Supply-chain — concrete package-ecosystem attacks
  { id: "TanStack", category: "supply-chain", aliases: ["Tanstack", "tanstack"] },
  { id: "supply chain attack", category: "supply-chain", aliases: ["supply-chain attack"] },
  { id: "malicious package", category: "supply-chain", aliases: ["malicious npm", "malicious pypi"] },
  { id: "npm compromise", category: "supply-chain", aliases: [] },

  // Agentic security — model-input / tool-use attack surface
  { id: "prompt injection", category: "agentic", aliases: ["prompt-injection"] },
  { id: "jailbreak", category: "agentic", aliases: ["jailbreaks", "jailbreaking"] },
  { id: "indirect injection", category: "agentic", aliases: ["indirect prompt injection"] },
  { id: "tool poisoning", category: "agentic", aliases: [] },

  // Cyber-incident — generic security event vocabulary
  { id: "breach", category: "cyber", aliases: ["data breach"] },
  { id: "ransomware", category: "cyber", aliases: [] },
  { id: "zero-day", category: "cyber", aliases: ["zeroday", "0-day"] },
  { id: "exfiltrate", category: "cyber", aliases: ["exfiltration"] },
  { id: "backdoor", category: "cyber", aliases: [] },
  { id: "cyber attack", category: "cyber", aliases: ["cyberattack"] },

  // Red-team / evals — adversarial pressure on models
  { id: "red team", category: "red-team", aliases: ["red-team", "red-teaming", "red teaming"] },
  { id: "adversarial", category: "red-team", aliases: [] },

  // Lab policy / governance — what the labs themselves do about safety
  { id: "misuse", category: "policy", aliases: [] },
  { id: "acceptable use", category: "policy", aliases: ["acceptable use policy", "AUP"] },
  { id: "responsible scaling", category: "policy", aliases: ["RSP", "responsible scaling policy"] },
  { id: "safety case", category: "policy", aliases: [] },
];

interface YtItem {
  title?: string;
  meta?: { transcript?: string; transcript_status?: string | null; channel?: string };
}

interface EntityCount { id: string; category: string; count: number; }
interface CoEdge { a: string; b: string; weight: number; }
interface OutShape {
  generated_from: string;
  source_transcript_count: number;
  entities: EntityCount[];
  cooccurrences: CoEdge[];
  mentions_total: number;
  cooccurrence_pairs: number;
}

function buildMatcher(def: EntityDef): RegExp {
  const all = [def.id, ...def.aliases].sort((a, b) => b.length - a.length);
  const escaped = all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
}

function countMentions(transcript: string, matcher: RegExp): number {
  const m = transcript.match(matcher);
  return m ? m.length : 0;
}

function main() {
  const raw = readFileSync(YT_PATH, "utf8");
  const items: YtItem[] = JSON.parse(raw);
  const transcripts: { text: string; channel: string }[] = items
    .filter((it) => it.meta?.transcript_status === "present" && (it.meta?.transcript ?? "").length > 0)
    .map((it) => ({ text: it.meta!.transcript!, channel: it.meta?.channel ?? "" }));

  if (transcripts.length === 0) {
    throw new Error("no hydrated transcripts found in data/youtube.json (transcript_status === 'present')");
  }

  const matchers = ENTITY_DICT.map((def) => ({ def, re: buildMatcher(def) }));

  const counts = new Map<string, number>();
  const perTranscript: Set<string>[] = transcripts.map(() => new Set<string>());

  for (let ti = 0; ti < transcripts.length; ti++) {
    const text = transcripts[ti]!.text;
    for (const { def, re } of matchers) {
      const n = countMentions(text, re);
      if (n > 0) {
        counts.set(def.id, (counts.get(def.id) ?? 0) + n);
        perTranscript[ti]!.add(def.id);
      }
    }
  }

  const coMap = new Map<string, number>();
  for (const surfaced of perTranscript) {
    const arr = Array.from(surfaced).sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`;
        coMap.set(key, (coMap.get(key) ?? 0) + 1);
      }
    }
  }

  const MIN_CO_WEIGHT = 2;
  const cooccurrences: CoEdge[] = Array.from(coMap.entries())
    .filter(([, w]) => w >= MIN_CO_WEIGHT)
    .map(([key, weight]) => {
      const [a, b] = key.split("|");
      return { a: a!, b: b!, weight };
    })
    .sort((p, q) => q.weight - p.weight || (p.a < q.a ? -1 : 1));

  const entities: EntityCount[] = ENTITY_DICT
    .map((def) => ({
      id: def.id,
      category: def.category,
      count: counts.get(def.id) ?? 0,
    }))
    .filter((e) => e.count > 0)
    .sort((p, q) => q.count - p.count || (p.id < q.id ? -1 : 1));

  const mentionsTotal = entities.reduce((s, e) => s + e.count, 0);

  const out: OutShape = {
    generated_from: "scripts/extract-security-entities.ts vs data/youtube.json (transcripts where meta.transcript_status === 'present')",
    source_transcript_count: transcripts.length,
    entities,
    cooccurrences,
    mentions_total: mentionsTotal,
    cooccurrence_pairs: cooccurrences.length,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`extract-security-entities: ${transcripts.length} transcripts → ${entities.length} concepts (${mentionsTotal} mentions) + ${cooccurrences.length} co-edges`);
  console.log(`top-5: ${entities.slice(0, 5).map((e) => `${e.id}=${e.count}`).join(" · ")}`);
  console.log(`top-5 co-edges: ${cooccurrences.slice(0, 5).map((c) => `${c.a}↔${c.b}=${c.weight}`).join(" · ")}`);
  console.log(`wrote ${OUT_PATH}`);
}

if (import.meta.main) main();
