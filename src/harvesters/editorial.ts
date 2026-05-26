import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

// S22 OBSERVE additions (Kem-named, 2026-05-15) — AI podcast whitelist seeds.
// Kem flagged podcasts as a first-class section in the editorial-magazine
// vision. AI Daily Brief is ISC-227 carry-forward (canonical feed URL still
// needed). Additional Kem-recommended podcasts to be sourced via S22 research-
// task on consolidated AI-podcast lists. Once URLs land, they go into
// PUBLISHER_FEEDS below as 1-line edits per ISC-195 design.
//
// Candidate podcast seeds (feed URLs TBC at morning resume):
//   - AI Daily Brief (Nathaniel Whittemore) — ISC-227 anchor
//   - Latent Space (Swyx + Alessio)
//   - The Cognitive Revolution (Nathan Labenz)
//   - Practical AI
//   - No Priors (Sarah Guo + Elad Gil)
//   - Lex Fridman Podcast (already in YouTube; may also have audio feed)

/**
 * Editorial AI-news harvester (S20 / Engineer-A → Glitch direct after worktree
 * isolation unavailable, iteration 20).
 *
 * Two aggregator-newsletter RSS sources, each one a curated AI-news roundup:
 *   - AI Daily Brief — daily podcast/newsletter on AI news
 *   - Last Week in AI — weekly podcast/newsletter on AI research + industry
 *
 * Distinct from frontier (lab first-party blogs) and from enterprise (publisher
 * AI coverage): editorial sources are *curated secondary signal* — someone has
 * already filtered the firehose to "what matters this day/week". Useful as a
 * sanity check against the report's own clustering: if a story dominates Daily
 * Brief but the report missed it, the report has a coverage gap.
 *
 * Zero-auth public RSS. ISC-183..193.
 */

type EditorialFeed = { publisher: string; label: string; url: string };

/**
 * Per-publisher feed URLs as a documented constant: a feed URL change is a
 * 1-line edit, never a code-path change. If a URL rots, search the source
 * page for the current RSS and replace inline — do not invent.
 *
 * URL-rot notes (S20 probe, 2026-05-15):
 *   - AI Daily Brief — every guessable RSS slug (Fireside `aidailybrief`,
 *     `the-ai-daily-brief`, Megaphone, Simplecast, Anchor) returned 404.
 *     Dropped from this iteration; left as a follow-up if Kem confirms the
 *     canonical feed URL.
 *   - The Batch (deeplearning.ai) — `/the-batch/feed/` redirects to
 *     `/the-batch/feed` which 404s. Dropped from this iteration.
 *   - Import AI (Jack Clark) — `jack-clark.net/feed/` returned 200. Used.
 *   - Last Week in AI (Andrey Kurenkov) — `lastweekin.ai/feed` returned 200,
 *     real Substack RSS with weekly items. Used.
 */
const FEEDS: EditorialFeed[] = [
  // Last Week in AI — weekly AI news + research roundup (Substack-hosted).
  { publisher: 'last-week-in-ai', label: 'Last Week in AI', url: 'https://lastweekin.ai/feed' },
  // Import AI — Jack Clark's weekly AI newsletter (WordPress-hosted).
  { publisher: 'import-ai', label: 'Import AI', url: 'https://jack-clark.net/feed/' },
];

const MAX_AGE_DAYS = 14;
const PER_FEED_CAP = 20;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripCdataAndTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function extractFirst(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m && m[1] !== undefined ? m[1] : null;
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]+)"`, 'i');
  const m = re.exec(block);
  return m ? (m[1] ?? null) : null;
}

/**
 * Engagement is a freshness proxy: no engagement metric on RSS, so freshness
 * within the window stands in. Matches the frontier.ts shape so the two source
 * classes rank comparably on the recency axis.
 */
function freshnessEngagement(ageHours: number): number {
  return Math.max(0, Math.round(100 - ageHours / 2));
}

export function normalize(
  feed: EditorialFeed,
  rawTitle: string,
  link: string,
  pubRaw: string,
  summaryRaw: string,
  now: number = Date.now(),
): NormalizedItem | null {
  const title = decodeEntities(stripCdataAndTags(rawTitle));
  const summary = decodeEntities(stripCdataAndTags(summaryRaw));
  if (!title || !link) return null;

  const tsParsed = pubRaw ? Date.parse(pubRaw) : NaN;
  const tsMs = Number.isNaN(tsParsed) ? now : tsParsed;
  const ageHours = Math.max(0, (now - tsMs) / 3_600_000);
  if (ageHours > MAX_AGE_DAYS * 24) return null;

  return {
    title: `[${feed.label}] ${title}`,
    url: link.trim(),
    source: 'editorial',
    ts: new Date(tsMs).toISOString(),
    engagement: freshnessEngagement(ageHours),
    raw_text: title + ' — ' + summary.slice(0, 280),
    meta: {
      publisher: feed.publisher,
      label: feed.label,
      summary: summary.slice(0, 280),
      date_basis: Number.isNaN(tsParsed) ? 'feed-fallback' : 'feed-pubdate',
    },
  };
}

async function fetchFeed(feed: EditorialFeed): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)' },
    });
    if (!res.ok) throw new Error(`${feed.publisher}: HTTP ${res.status}`);
    const xml = await res.text();
    await captureRaw('editorial', feed.publisher, xml);

    const isAtom = /<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml);
    const itemBlocks = isAtom ? extractAll(xml, 'entry') : extractAll(xml, 'item');

    const items: NormalizedItem[] = [];
    const now = Date.now();
    for (const block of itemBlocks) {
      const rawTitle = extractFirst(block, 'title') ?? '';
      let link = '';
      if (isAtom) {
        link = extractAttr(block, 'link', 'href') ?? '';
      } else {
        link = (extractFirst(block, 'link') ?? '').trim();
        if (!link) link = extractAttr(block, 'link', 'href') ?? '';
      }
      const pubRaw =
        extractFirst(block, 'pubDate') ??
        extractFirst(block, 'published') ??
        extractFirst(block, 'updated') ??
        extractFirst(block, 'dc:date') ??
        '';
      const summaryRaw =
        extractFirst(block, 'description') ??
        extractFirst(block, 'summary') ??
        extractFirst(block, 'content:encoded') ??
        extractFirst(block, 'content') ??
        '';
      const item = normalize(feed, rawTitle, link, pubRaw, summaryRaw, now);
      if (item) items.push(item);
    }
    items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return items.slice(0, PER_FEED_CAP);
  } finally {
    clearTimeout(timer);
  }
}

export async function harvestEditorial(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(FEEDS.map((feed) => fetchFeed(feed)));
  const items: NormalizedItem[] = [];
  let okCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const feed = FEEDS[i];
    if (!feed) continue;
    if (r && r.status === 'fulfilled') {
      items.push(...r.value);
      okCount += 1;
      console.error(`  editorial:${feed.publisher} ok (${r.value.length} items)`);
    } else if (r && r.status === 'rejected') {
      console.error(`  WARN editorial:${feed.publisher} — ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  if (okCount === 0 && FEEDS.length > 0) {
    throw new Error('editorial: all feeds failed');
  }
  return items;
}

if (import.meta.main) {
  try {
    const items = await harvestEditorial();
    console.error(`harvest:editorial — ${items.length} items (` +
      FEEDS.map((f) => `${f.publisher}:${items.filter((i) => (i.meta as { publisher?: string } | undefined)?.publisher === f.publisher).length}`).join(', ') +
      ')');
    console.log(JSON.stringify(items, null, 2));
  } catch (e) {
    console.error('harvest:editorial failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
