// extract-industry-news-entities.ts — iter-41 close (v8 doctrine)
//
// Reads data/youtube.json (60 hydrated podcast transcripts), counts named-entity
// mentions per transcript, counts co-occurrences per pair (both entities surfaced
// in the same transcript = +1 edge weight). Writes data/industry-news-entities.json.
//
// The entity DICTIONARY is curated in-repo (schema layer) — versioned, transparent,
// inspectable. The COUNTS are corpus-derived (data layer). This is the same pattern
// as KNOWN_TOOLS from iter-22+: dictionary fixed, signal data-derived.
//
// Aliases let a single canonical entity match several surface spellings (Musk also
// matches "Elon Musk", "Elon"; OpenAI also matches "Open AI"; Anthropic also
// matches "Anthropic's"). All matching is case-insensitive whole-word.
//
// Output is deterministic — same youtube.json → byte-identical entities JSON.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const YT_PATH = join(ROOT, "data", "youtube.json");
const OUT_PATH = join(ROOT, "data", "industry-news-entities.json");

interface EntityDef {
  id: string;
  category: "openai" | "anthropic" | "musk-orbit" | "geopolitics" | "platform" | "podcast" | "exec";
  aliases: string[]; // matched case-insensitive whole-word; the canonical id is also included automatically
}

// Curated entity dictionary. Mirrors the entities the iter-41 design conversation
// surfaced (Musk-OpenAI, SpaceX-Anthropic, Trump-Xi, AI Doom narrative cluster).
// Categories drive the constellation color palette deterministically.
const ENTITY_DICT: EntityDef[] = [
  // OpenAI orbit
  { id: "OpenAI", category: "openai", aliases: ["Open AI", "OpenAI's"] },
  { id: "GPT", category: "openai", aliases: ["GPT-4", "GPT-5", "GPT5", "ChatGPT"] },
  { id: "Sam Altman", category: "exec", aliases: ["Altman", "Sam"] },

  // Anthropic orbit
  { id: "Anthropic", category: "anthropic", aliases: ["Anthropic's"] },
  { id: "Claude", category: "anthropic", aliases: ["Claude Code", "Claude 4"] },
  { id: "Dario", category: "exec", aliases: ["Dario Amodei"] },
  { id: "MCP", category: "anthropic", aliases: ["Model Context Protocol"] },

  // Musk orbit
  { id: "Musk", category: "musk-orbit", aliases: ["Elon Musk", "Elon"] },
  { id: "SpaceX", category: "musk-orbit", aliases: [] },
  { id: "xAI", category: "musk-orbit", aliases: ["Grok"] },

  // Geopolitics
  { id: "Trump", category: "geopolitics", aliases: ["President Trump"] },
  { id: "Xi", category: "geopolitics", aliases: ["Xi Jinping"] },
  { id: "China", category: "geopolitics", aliases: ["Chinese"] },
  { id: "Pax Silica", category: "geopolitics", aliases: [] },

  // Platform / industry
  { id: "Microsoft", category: "platform", aliases: [] },
  { id: "Google", category: "platform", aliases: ["Alphabet"] },
  { id: "NVIDIA", category: "platform", aliases: ["Nvidia"] },
  { id: "Stargate", category: "platform", aliases: [] },

  // Podcasts (these are also the SHOWS surveyed)
  { id: "Hard Fork", category: "podcast", aliases: [] },
  { id: "AI Daily Brief", category: "podcast", aliases: [] },
  { id: "All-In", category: "podcast", aliases: ["All In Podcast"] },
  { id: "Lenny's", category: "podcast", aliases: ["Lenny", "Lenny's Podcast"] },
  { id: "No Priors", category: "podcast", aliases: [] },
  { id: "Cognitive Revolution", category: "podcast", aliases: [] },

  // Other execs / handles
  { id: "Benioff", category: "exec", aliases: ["Marc Benioff"] },
];

interface YtItem {
  title?: string;
  meta?: { transcript?: string; transcript_status?: string | null; channel?: string };
}

interface EntityCount { id: string; category: string; count: number; }
interface CoEdge { a: string; b: string; weight: number; }
interface Mention { entity: string; transcript_index: number; }
interface OutShape {
  generated_from: string;
  source_transcript_count: number;
  entities: EntityCount[];
  cooccurrences: CoEdge[];
  mentions_total: number;
  cooccurrence_pairs: number;
}

function buildMatcher(def: EntityDef): RegExp {
  // All canonical id + aliases, sorted longest-first so multi-word matches before subset.
  const all = [def.id, ...def.aliases].sort((a, b) => b.length - a.length);
  const escaped = all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // \b word boundaries on both sides. Case-insensitive.
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

  // counts[entity_id] = total mention count across corpus
  const counts = new Map<string, number>();
  // perTranscript[i] = Set of entity_ids surfaced in that transcript
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

  // Co-occurrence edges: for each pair (a, b) with a<b lex, count transcripts where both surface
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

  // Filter co-edges to weight >= 2 (single co-occurrence is noise across 60 transcripts).
  const MIN_CO_WEIGHT = 2;
  const cooccurrences: CoEdge[] = Array.from(coMap.entries())
    .filter(([, w]) => w >= MIN_CO_WEIGHT)
    .map(([key, weight]) => {
      const [a, b] = key.split("|");
      return { a: a!, b: b!, weight };
    })
    .sort((p, q) => q.weight - p.weight || (p.a < q.a ? -1 : 1));

  // Entity list — sorted by count desc, then id asc for stable tiebreak.
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
    generated_from: "scripts/extract-industry-news-entities.ts vs data/youtube.json (transcripts where meta.transcript_status === 'present')",
    source_transcript_count: transcripts.length,
    entities,
    cooccurrences,
    mentions_total: mentionsTotal,
    cooccurrence_pairs: cooccurrences.length,
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`extract-industry-news-entities: ${transcripts.length} transcripts → ${entities.length} entities (${mentionsTotal} mentions) + ${cooccurrences.length} co-edges`);
  console.log(`top-5: ${entities.slice(0, 5).map((e) => `${e.id}=${e.count}`).join(" · ")}`);
  console.log(`top-5 co-edges: ${cooccurrences.slice(0, 5).map((c) => `${c.a}↔${c.b}=${c.weight}`).join(" · ")}`);
  console.log(`wrote ${OUT_PATH}`);
}

if (import.meta.main) main();
