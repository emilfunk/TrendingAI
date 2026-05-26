#!/usr/bin/env bun
// ISC-308 / ISC-423 (iter-31) — Instagram transcript hydration script.
//
// PURPOSE
// Closes the carry-forward IG transcript signal gap that's been sitting in
// the parking lot for 16+ iters. The chain (yt-dlp → ffmpeg → Groq Whisper)
// has been LIVE-verified end-to-end since iter-24.5 ISC-306 ($0.001/reel for
// a 704-char transcript on @handlytech). What's been missing: a script that
// runs that chain against the existing 42-URL whitelist pool already on
// disk and merges the results into data/instagram.json so downstream
// `enrichWithTranscripts(instagram)` in reason-cluster.ts has signal to read.
//
// SOURCE OF TRUTH for the cached pool
//   data/raw/instagram/2026-05-16T11-24-36-691Z__whitelist.json
//   Apify-emitted profile snapshot, 6 whitelist creators × ≤12 latestPosts.
//   42 of 72 posts are reels (type=Video); the rest are carousels w/ no
//   audio. We pull only the reels — Groq Whisper bills per audio second so
//   hashtag-content extraction would blow the cost ceiling.
//
// COST PROJECTION (iter-30 close)
//   42 reels × ~$0.001 Groq Whisper = ~$0.04. Comfortably inside the
//   quarterly £18 Apify credit balance + $5-50/mo single-user ceiling.
//
// IDEMPOTENT
// Reels already in data/instagram.json with meta.transcript_status === 'present'
// are skipped — the script can re-run safely without re-billing Groq for the
// same audio.
//
// ENV REQUIRED
//   HARVEST_PAID=1            — gate per harvesters/instagram.ts contract
//   EXTRACT_IG_TRANSCRIPTS=1  — explicit opt-in
//   GROQ_API_KEY              — read from .env via Bun's auto-loader
//
// USAGE
//   HARVEST_PAID=1 EXTRACT_IG_TRANSCRIPTS=1 bun scripts/hydrate-ig-transcripts.ts
//   HARVEST_PAID=1 EXTRACT_IG_TRANSCRIPTS=1 bun scripts/hydrate-ig-transcripts.ts \
//     data/raw/instagram/<custom-whitelist-snapshot>.json
//
// VERIFY
//   jq '[.[] | select(.meta.transcript_status == "present")] | length' \
//     data/instagram.json   # expect ≥30 (71% of 42 floor)

import * as fs from "node:fs";
import * as path from "node:path";
import type { NormalizedItem } from "../src/types.ts";
import {
  normalize,
  attachTranscript,
  extractInstagramReelTranscript,
} from "../src/harvesters/instagram.ts";

// Portable bundle: resolve against package.json directory via process.cwd().
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DEFAULT_WHITELIST = path.join(
  DATA,
  "raw/instagram/2026-05-16T11-24-36-691Z__whitelist.json",
);

interface WhitelistProfile {
  username?: string;
  latestPosts?: Array<Record<string, unknown>>;
}

function loadCachedWhitelist(snapshotPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Whitelist snapshot not found at ${snapshotPath}`);
  }
  const data = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as WhitelistProfile[];
  if (!Array.isArray(data)) {
    throw new Error(`Whitelist snapshot is not an array: ${snapshotPath}`);
  }
  const items: Array<Record<string, unknown>> = [];
  for (const profile of data) {
    const posts = profile.latestPosts ?? [];
    for (const p of posts) {
      // Carry the owner-username down from the profile if the post object
      // lacks it (some Apify shapes omit owner on nested children).
      if (!p.ownerUsername && profile.username) p.ownerUsername = profile.username;
      items.push(p);
    }
  }
  return items;
}

function isReel(item: Record<string, unknown>): boolean {
  if (item.type === "Video") return true;
  if (item.productType === "clips") return true;
  const url = (item.url as string | undefined) ?? "";
  if (/\/reel\//.test(url)) return true;
  return false;
}

function loadExistingInstagram(): NormalizedItem[] {
  const p = path.join(DATA, "instagram.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf-8")) as NormalizedItem[];
}

function writeInstagram(items: NormalizedItem[]): void {
  const p = path.join(DATA, "instagram.json");
  fs.writeFileSync(p, JSON.stringify(items, null, 2));
}

async function main(): Promise<void> {
  if (process.env.HARVEST_PAID !== "1") {
    throw new Error(
      "HARVEST_PAID=1 required (paid Groq Whisper spend ~$0.04/run)",
    );
  }
  if (process.env.EXTRACT_IG_TRANSCRIPTS !== "1") {
    throw new Error("EXTRACT_IG_TRANSCRIPTS=1 required (explicit opt-in)");
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY missing from env (add to .env (in this project root))");
  }

  const snapshotPath = process.argv[2] ?? DEFAULT_WHITELIST;
  console.log(`hydrate-ig: loading whitelist snapshot ${snapshotPath}`);
  const rawPosts = loadCachedWhitelist(snapshotPath);
  console.log(`hydrate-ig: ${rawPosts.length} total posts in snapshot`);

  // Normalize via the shared instagram.ts normalize() helper so meta/engagement
  // formulas are identical to the harvester's main path.
  const normalized: NormalizedItem[] = [];
  for (const p of rawPosts) {
    const n = normalize(p as Parameters<typeof normalize>[0]);
    if (!n) continue;
    if (!isReel(p)) continue;
    normalized.push(n);
  }
  console.log(`hydrate-ig: ${normalized.length} reels after normalize + filter`);

  // Merge into existing instagram.json by URL — preserve hashtag items, add
  // whitelist reels that aren't already present.
  const existing = loadExistingInstagram();
  const byUrl = new Map<string, NormalizedItem>();
  for (const it of existing) byUrl.set(it.url, it);
  let added = 0;
  for (const n of normalized) {
    if (!byUrl.has(n.url)) {
      byUrl.set(n.url, n);
      added++;
    }
  }
  console.log(`hydrate-ig: ${added} new whitelist reels added to instagram.json (was ${existing.length}, now ${byUrl.size})`);

  // Now extract transcripts — sequential to honor IG rate limits + Groq
  // limits per iter-24.5 chain doctrine.
  const targetUrls = normalized.map((n) => n.url);
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (let i = 0; i < targetUrls.length; i++) {
    const url = targetUrls[i]!;
    const current = byUrl.get(url);
    if (!current) {
      fail++;
      continue;
    }
    const meta = current.meta as { transcript_status?: string } | undefined;
    if (meta?.transcript_status === "present") {
      console.log(`[${i + 1}/${targetUrls.length}] SKIP (already present) ${url}`);
      skip++;
      continue;
    }
    console.log(`[${i + 1}/${targetUrls.length}] extracting ${url}`);
    try {
      const transcript = await extractInstagramReelTranscript(url);
      const updated = attachTranscript(current, transcript ?? undefined);
      byUrl.set(url, updated);
      if (transcript) {
        ok++;
        console.log(`    ✓ ${transcript.length} chars`);
      } else {
        fail++;
        console.log(`    ✗ transcript was null`);
      }
    } catch (e) {
      fail++;
      console.error(`    ✗ ${e instanceof Error ? e.message : e}`);
    }
    // 500ms inter-reel sleep matches the harvester convention.
    await new Promise((r) => setTimeout(r, 500));
  }

  const final = Array.from(byUrl.values());
  writeInstagram(final);
  const present = final.filter((i) => {
    const m = i.meta as { transcript_status?: string } | undefined;
    return m?.transcript_status === "present";
  }).length;
  console.log(
    `hydrate-ig: done — ${ok} new transcripts, ${skip} skipped, ${fail} failed; data/instagram.json now has ${present}/${final.length} items with transcript_status=present`,
  );
}

main().catch((e) => {
  console.error("hydrate-ig failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
