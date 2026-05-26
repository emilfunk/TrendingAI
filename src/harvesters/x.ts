import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const ACTOR = 'apidojo~twitter-scraper-lite';

// Tier 1 — official org accounts + famous researchers. The original ISC-39/40
// whitelist; do not renumber or rename (ISC-40 verification references it).
const FRONTIER_ACCOUNTS = [
  'AnthropicAI',
  'OpenAI',
  'GoogleDeepMind',
  'Meta_AI',
  'MistralAI',
  'xai',
  'sama',
  'karpathy',
  'ylecun',
  'demishassabis',
  'goodside',
  'simonw',
  'JimFan',
  'percyliang',
  'iScienceLuvr',
];

// Tier 2 — ISC-124 "builders" tier. Individual frontier-lab engineers / PMs who
// ship and publicly discuss the actual features, plus the official Claude Code
// dev channel. Distinct from the org accounts (Tier 1) and famous academics.
// Kem flagged the gap: "I'm still not seeing anything about typical Claude
// features. The Claude devs on Twitter — their tweets aren't factored in."
// Every handle here is session-confirmed — web-sourced, named by Kem, or
// verified by the iteration-13 research pass against a live x.com profile. The
// ISA decision rule forbids guessed handles; unverified candidates (Sid
// Bidasaria, Mistral/xAI ICs) are quarantined in the ISA, not added here.
const BUILDER_ACCOUNTS = [
  'bcherny',         // Boris Cherny — creator/lead of Claude Code, Anthropic
  'trq212',          // Thariq Shihipar — Anthropic, Claude Code team
  '_catwu',          // Cat Wu — Head of Product, Claude Code & Cowork, Anthropic
  'alexalbert__',    // Alex Albert — Head of Developer Relations, Anthropic
  'romainhuet',      // Romain Huet — Head of Developer Experience, OpenAI (Codex/API)
  'aidan_mclau',     // Aidan McLaughlin — research scientist, model design, OpenAI
  'OfficialLoganK',  // Logan Kilpatrick — Product lead, Google AI Studio + Gemini API
  'ClaudeDevs',      // official Claude Code / Claude platform dev channel
];

// Tier 3 — ISC-124 "creators" tier. High-signal AI/dev content creators whose
// posts cover AI stories and releases well. Kem: "theo content often covers
// great stories." Handles Kem-provided or research-verified only. (Simon
// Willison is a creator too but already in Tier 1 — not duplicated.)
//
// 2026-05-16 EVENING — ratified Kem-walked slate expansion. Audit-corrected:
// Lex Fridman and Cleo Abram excluded (audit found 25-35% / 25% AI respectively
// — below the AI-discourse signal floor). ThePrimeagen kept conditional pending
// Kem call at next session (audit: 15-20% AI). Chase Hannegan X handle is
// `chaseai__` (TWO underscores) per chaseai.io — distinct from the TikTok
// handle `@chase_ai_` and the unrelated YouTube `@chaseai18` (Vishesh Zorin).
const CREATOR_ACCOUNTS = [
  'theo',           // Theo Browne (t3.gg) — AI/dev content creator (also posts as @t3dotgg)
  'swyx',           // Shawn Wang — Latent Space, AI Engineer conf
  'steipete',       // Peter Steinberger — OpenClaw, agentic-engineering practitioner
  'MatthewBerman',  // Matthew Berman — AI news/education (Forward Future)
  'rileybrown_ai',  // Riley Brown — agentic/vibe-coding tools coverage
  'HamelHusain',    // Hamel Husain — AI engineer, LLM evals authority
  'minimaxir',      // Max Woolf — hype-free model-release analysis
  'ThePrimeagen',   // ThePrimeagen — major dev creator (audit: 15-20% AI; CONDITIONAL pending Kem call)
  'mattpocockuk',   // Matt Pocock — TypeScript educator, prolific Claude Skills author; Kem-named iter-5 2026-05-16
  // Talking-head-viral adds (2026-05-16 EVENING ratified slate)
  'chaseai__',      // Chase Hannegan — chaseai.io (TWO underscores); SC "Chase X handle fix"
  'fireship',       // Fireship — audit reversal, 75% AI not 30%
  'NetworkChuck',   // NetworkChuck — 5.16M, hard AI pivot 60-70%
  'kevinroose',     // Kevin Roose — Hard Fork
  'CaseyNewton',    // Casey Newton — Hard Fork
  'bilawalsidhu',   // Bilawal Sidhu — viral AI + spatial
  'dwarkesh_sp',    // Dwarkesh Patel — Dwarkesh Podcast
  'DwarkeshPatel',  // Dwarkesh Patel — alt handle
  'Saranormous',    // Sarah Guo — Conviction
  'eladgil',        // Elad Gil — investor + commentary
  'harrystebbings', // Harry Stebbings — 20VC, podcast host
  // Hustler / SKOOL cluster
  'nicksaraev',     // Nick Saraev — Maker School (400K YT, #1 SKOOL)
  'LiamOttley',     // Liam Ottley — AAA Accelerator (706K YT)
  'theaiadvantage', // Igor Pogany — The AI Advantage (~1M YT)
  'nateherk',       // Nate Herk — 700K YT
  'brettmalinowski',// Brett Malinowski — WGMI Academy
  'DavidOndrej',    // David Ondrej — Imperium Academy
  'JakeVanClief',   // Jake Van Clief — Clief Notes SKOOL (edge-case)
  'indydevdan',     // IndyDevDan — Kem's "engineer focused" pick
  'ColeMedin',      // Cole Medin — Kem knows him
  'MervinPraison',  // Mervin Praison
  // Research / news (light) — admit-all per Kem ratify
  '_akhaliq',       // HF Daily Papers (469K)
  'askalphaxiv',    // alphaXiv
  'fchollet',       // François Chollet (657K)
  'hardmaru',       // David Ha (384K)
  'YannicKilcher',  // Yannic Kilcher (308K X; also YT)
  'TheAhmadOsman',  // Ahmad Osman — AI-infra niche
  // Podcast hosts (admit-all)
  'danshipper',     // Dan Shipper — Every
  'natolambert',    // Nathan Lambert — Interconnects
  'labenz',         // Nathan Labenz — Cognitive Revolution (below floor but completes pair)
  // Open-source / aligned-with-PAI doctrine
  'DanielMiessler', // Daniel Miessler — Unsupervised Learning newsletter (Kem-named)
];

// The full harvest whitelist — all three tiers. `accountTier()` maps a handle
// back to its tier so each harvested item can be stamped with provenance.
const WHITELIST_ACCOUNTS = [
  ...FRONTIER_ACCOUNTS,
  ...BUILDER_ACCOUNTS,
  ...CREATOR_ACCOUNTS,
];

const BUILDER_SET = new Set(BUILDER_ACCOUNTS.map((u) => u.toLowerCase()));
const CREATOR_SET = new Set(CREATOR_ACCOUNTS.map((u) => u.toLowerCase()));
const FRONTIER_SET = new Set(FRONTIER_ACCOUNTS.map((u) => u.toLowerCase()));

type XTier = 'frontier' | 'builder' | 'creator' | 'search';

function accountTier(username: string): XTier {
  const u = username.toLowerCase();
  if (BUILDER_SET.has(u)) return 'builder';
  if (CREATOR_SET.has(u)) return 'creator';
  if (FRONTIER_SET.has(u)) return 'frontier';
  return 'search'; // surfaced by the trending-search query, not the whitelist
}

const TRENDING_QUERY = '(Claude OR "GPT-5" OR Gemini OR "frontier model" OR LLM OR transformer) min_faves:200 lang:en';

type RawTweet = {
  id?: string;
  url?: string;
  text?: string;
  author?: { userName?: string; name?: string; followersCount?: number; followers?: number };
  authorUsername?: string;
  authorDisplayName?: string;
  authorFollowersCount?: number;
  createdAt?: string;
  timestamp?: string;
  likeCount?: number;
  likesCount?: number;
  retweetCount?: number;
  retweetsCount?: number;
  replyCount?: number;
  repliesCount?: number;
  viewCount?: number;
  viewsCount?: number;
};

function envToken(): string {
  const t = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!t || !t.trim()) {
    throw new Error('APIFY_TOKEN missing — add it to .env (in this project root) or export APIFY_TOKEN=...');
  }
  return t.trim();
}

async function runActor(input: Record<string, unknown>, label: string): Promise<RawTweet[]> {
  const token = envToken();
  // ISC-68: the Apify token travels in the Authorization header, never in the
  // URL query string — URLs leak into access logs, proxy logs, and history.
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?format=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Apify actor ${ACTOR}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    await captureRaw('x', label, text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? (data as RawTweet[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

function normalize(t: RawTweet): NormalizedItem | null {
  const url = t.url;
  const text = t.text;
  if (!url || !text) return null;
  const author = t.author?.userName ?? t.authorUsername ?? 'unknown';
  const likes = t.likeCount ?? t.likesCount ?? 0;
  const rts = t.retweetCount ?? t.retweetsCount ?? 0;
  const replies = t.replyCount ?? t.repliesCount ?? 0;
  const views = t.viewCount ?? t.viewsCount ?? 0;
  const ts = t.createdAt ?? t.timestamp ?? new Date().toISOString();
  const engagement = likes + rts * 2 + replies + Math.floor(views / 100);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const title = `@${author}: ${cleaned.slice(0, 120)}${cleaned.length > 120 ? '…' : ''}`;
  // ISC-F5 (2026-05-16): capture followers so downstream ranking can weight by
  // creator reach, not just absolute engagement. A 100k-follower @Karpathy
  // post with 500 likes beats a 582-follower post with 3 likes; without this,
  // they sort identically by raw engagement.
  const followers = t.author?.followersCount ?? t.author?.followers ?? t.authorFollowersCount ?? 0;
  return {
    title,
    url,
    source: 'x',
    ts,
    engagement,
    raw_text: cleaned,
    // x_tier records WHICH whitelist tier surfaced this item (ISC-124) — so the
    // report and any spot-check can see "this came from the builders tier", not
    // just "from X". 'search' = surfaced by the trending query, not whitelisted.
    meta: { author, likes, retweets: rts, replies, views, followers, x_tier: accountTier(author) },
  };
}

export async function harvestX(): Promise<NormalizedItem[]> {
  const oneWeekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

  // ISC-124: the whitelist now spans all three tiers (~31 accounts) — too many
  // for a single `from:a OR from:b ...` query (Twitter search caps query
  // length, so one giant query silently truncates). Chunk it; the Apify
  // actor's `searchTerms` is an array and runs each query in the same run.
  //
  // ISC-124 ROOT-CAUSE FIX (2026-05-16): the prior single-runActor call with
  // searchTerms=accountQueries shared a 60-item budget across ALL chunks. Low-
  // activity-in-window whitelist members (swyx, HamelHusain, mattpocockuk,
  // minimaxir) got squeezed by high-activity ones (steipete, ylecun, theo).
  // Symptom: those 4 accounts returned 0 items in v0.9 despite being in the
  // whitelist. Fix: each chunk is its OWN runActor() call with its own
  // maxItems budget, so quiet creators get the same per-chunk share. Total
  // potential items goes from ~60 to ~120 (3 chunks × 40 max).
  const ACCOUNT_CHUNK = 8;
  const accountQueries: string[] = [];
  for (let i = 0; i < WHITELIST_ACCOUNTS.length; i += ACCOUNT_CHUNK) {
    const chunk = WHITELIST_ACCOUNTS.slice(i, i + ACCOUNT_CHUNK);
    accountQueries.push(`(${chunk.map((u) => `from:${u}`).join(' OR ')}) since:${oneWeekAgo}`);
  }

  const perChunkPromises = accountQueries.map((q, idx) =>
    runActor({ searchTerms: [q], maxItems: 40, sort: 'Latest' }, `accounts-chunk-${idx}`)
  );
  const trendingPromise = runActor({ searchTerms: [`${TRENDING_QUERY} since:${oneWeekAgo}`], maxItems: 40, sort: 'Top' }, 'trending');
  const allResults = await Promise.allSettled([...perChunkPromises, trendingPromise]);

  const raw: RawTweet[] = [];
  let failedCount = 0;
  for (const [idx, result] of allResults.entries()) {
    const label = idx < perChunkPromises.length ? `accounts-chunk-${idx}` : 'trending';
    if (result.status === 'fulfilled') {
      raw.push(...result.value);
    } else {
      failedCount++;
      console.error(`  X ${label} query failed:`, result.reason instanceof Error ? result.reason.message : result.reason);
    }
  }

  if (raw.length === 0 && failedCount === allResults.length) {
    throw new Error('All X queries failed — see errors above');
  }

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const t of raw) {
    const n = normalize(t);
    if (!n) continue;
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    items.push(n);
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestX();
  if (items.length === 0) {
    console.error('X harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'x.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  console.log(`X: ${items.length} tweets → ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('X harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
