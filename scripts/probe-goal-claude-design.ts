// ISC-305 — 2-min dedupe probe.
// Grep data/typed.json for "/goal" and "Claude Design" mentions, locate them
// in data/discovery.json clusters, report whether they merged into a generic
// Claude Code cluster or fell below trending-floor. Decision branch:
//   merged              → iter-24.5 dedupe tightening
//   below trending-floor → iter-24.5 trending-floor tuning
import * as fs from "node:fs";

interface TypedItem { url?: string; source?: string; title?: string; raw_text?: string; engagement?: number; }
interface ClusterItem { url?: string; title?: string; }
interface Cluster { rank: number; label: string; items?: ClusterItem[]; size?: number; }

// Portable bundle: resolve against package.json directory via process.cwd().
const PROJECT = process.cwd();
const typedRaw = JSON.parse(fs.readFileSync(`${PROJECT}/data/typed.json`, "utf-8")) as unknown;
const typed: TypedItem[] = Array.isArray(typedRaw) ? typedRaw : (typedRaw as { items?: TypedItem[] }).items ?? [];
const disc: Cluster[] = JSON.parse(fs.readFileSync(`${PROJECT}/data/discovery.json`, "utf-8"));

const probes: Record<string, (s: string) => boolean> = {
  "/goal": (s) => /\B\/goal\b/.test(s) || /\bslash[\s-]?goal\b/i.test(s),
  "Claude Design": (s) => /claude\s+design/i.test(s),
};

const matches: Record<string, Array<{ url?: string; source?: string; title: string; engagement: number }>> = {};
for (const name of Object.keys(probes)) matches[name] = [];

for (const it of typed) {
  const txt = `${it.title ?? ""}\n${it.raw_text ?? ""}`;
  for (const [name, fn] of Object.entries(probes)) {
    if (fn(txt)) matches[name]!.push({ url: it.url, source: it.source, title: (it.title ?? "").slice(0, 90), engagement: it.engagement ?? 0 });
  }
}

const itemUrlToCluster = new Map<string, { rank: number; label: string; size: number }>();
for (const c of disc) {
  if (!c.items) continue;
  for (const it of c.items) {
    if (it.url) itemUrlToCluster.set(it.url, { rank: c.rank, label: c.label, size: c.items.length });
  }
}

for (const [name, hits] of Object.entries(matches)) {
  console.log(`\n=== ${name} — ${hits.length} match(es) in typed.json ===`);
  for (const h of hits.slice(0, 20)) {
    const cluster = h.url ? itemUrlToCluster.get(h.url) : undefined;
    const where = cluster
      ? `cluster #${cluster.rank} (size ${cluster.size}): ${cluster.label.slice(0, 70)}`
      : `NOT IN ANY DISCOVERY CLUSTER`;
    console.log(`  [${h.source ?? "?"}, eng ${h.engagement}] ${h.title}`);
    console.log(`    → ${where}`);
  }
  if (hits.length > 20) console.log(`  ... and ${hits.length - 20} more`);
}

console.log(`\n=== Cluster membership summary ===`);
const goalClusters = new Set<number>();
const designClusters = new Set<number>();
for (const h of matches["/goal"] ?? []) { const c = h.url ? itemUrlToCluster.get(h.url) : undefined; if (c) goalClusters.add(c.rank); }
for (const h of matches["Claude Design"] ?? []) { const c = h.url ? itemUrlToCluster.get(h.url) : undefined; if (c) designClusters.add(c.rank); }
console.log(`/goal items in clusters: ${[...goalClusters].sort((a, b) => a - b).join(", ") || "(none)"}`);
console.log(`Claude Design items in clusters: ${[...designClusters].sort((a, b) => a - b).join(", ") || "(none)"}`);

const top15 = new Set(disc.slice(0, 15).map((c) => c.rank));
const goalInTop = [...goalClusters].filter((r) => top15.has(r));
const designInTop = [...designClusters].filter((r) => top15.has(r));

console.log(`\n=== DECISION ===`);
console.log(`/goal: ${matches["/goal"]?.length ?? 0} typed item(s), ${goalClusters.size} cluster(s), ${goalInTop.length} inside top-15`);
console.log(`Claude Design: ${matches["Claude Design"]?.length ?? 0} typed item(s), ${designClusters.size} cluster(s), ${designInTop.length} inside top-15`);

const verdicts: string[] = [];
for (const [name, set, inTop] of [["/goal", goalClusters, goalInTop], ["Claude Design", designClusters, designInTop]] as const) {
  if (set.size === 0) {
    verdicts.push(`${name}: NEVER ENTERED DISCOVERY — gap is upstream (harvester or whitelist), not dedupe or floor`);
  } else if (inTop.length > 0) {
    const clusters = inTop.map((r) => disc.find((c) => c.rank === r));
    const labels = clusters.map((c) => c?.label.slice(0, 50)).join(" / ");
    verdicts.push(`${name}: SURFACES in top-15 via cluster(s) ${inTop.join(", ")} — labels: ${labels}`);
  } else {
    const lowestRank = Math.min(...set);
    verdicts.push(`${name}: PRESENT in cluster #${lowestRank} but BELOW top-15 trending-floor → iter-24.5 floor tuning`);
  }
}
for (const v of verdicts) console.log("  " + v);

// Did /goal cluster with generic "Claude Code"?
const generic = disc.filter((c) => /claude\s*code/i.test(c.label)).map((c) => c.rank);
console.log(`\nGeneric "Claude Code"-named clusters: ${generic.join(", ") || "(none found)"}`);
const goalAndGeneric = [...goalClusters].filter((r) => generic.includes(r));
if (goalAndGeneric.length > 0) {
  console.log(`/goal MERGED into generic Claude Code cluster(s) ${goalAndGeneric.join(", ")} → iter-24.5 dedupe tightening`);
} else {
  console.log(`/goal did NOT merge into a generic Claude Code cluster (no overlap)`);
}
