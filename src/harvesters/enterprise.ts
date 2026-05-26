import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

/**
 * Enterprise-news AI harvester (S20 / Engineer-B → Glitch direct, iteration 20).
 *
 * Traditional publishers covering AI as part of business/tech reporting. Class-1
 * zero-auth public RSS. Distinct from editorial (curated AI-only newsletters)
 * and frontier (lab first-party announcements): enterprise sources are general-
 * audience publishers with an AI section — they cover deal-flow, funding,
 * regulation, and product launches alongside the technical content.
 *
 * Two source-specific concerns this harvester owns:
 *   - AI-keyword filter (ISC-197): Bloomberg Technology and The Register are
 *     general tech sections that mix AI with non-AI; we filter at title+summary
 *     for AI/LLM/GPT/agent/etc. keywords so only AI items survive. Publisher
 *     AI-scoped feeds (TechCrunch AI, VentureBeat AI, Ars AI) usually pass.
 *   - Paywall-stub flagging (ISC-206): The Information serves RSS items with
 *     empty/<50-char summaries. We FLAG these via meta.paywall: true rather
 *     than drop them — the title alone is still useful signal.
 *
 * ISC-194..207.
 */

type EnterpriseFeed = {
  publisher: string;
  label: string;
  url: string;
  /** If true, applies the AI-keyword filter (off for already-AI-scoped feeds). */
  needsAiFilter?: boolean;
};

/**
 * Per-publisher feed URLs as a documented constant (ISC-195). 1-line edit if a
 * URL rots. Probed 2026-05-15:
 *   ✓ TechCrunch AI         200
 *   ✓ The Information       200  (paywall — stubs flagged not dropped)
 *   ✓ Bloomberg Technology  200  (general-tech — AI-keyword filter applied)
 *   ✓ FT AI                 200
 *   ✓ The Verge AI          200
 *   ✓ The Register AI       200
 *   ✓ VentureBeat AI        200
 *   ✓ Ars Technica AI       200
 *   ✗ Reuters               no live RSS found at probe — DROPPED for S20
 */
const PUBLISHER_FEEDS: EnterpriseFeed[] = [
  { publisher: 'techcrunch',      label: 'TechCrunch',          url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { publisher: 'the-information', label: 'The Information',     url: 'https://www.theinformation.com/feed' },
  { publisher: 'bloomberg-tech',  label: 'Bloomberg Technology', url: 'https://feeds.bloomberg.com/technology/news.rss', needsAiFilter: true },
  { publisher: 'ft-ai',           label: 'FT AI',                url: 'https://www.ft.com/artificial-intelligence?format=rss' },
  { publisher: 'the-verge-ai',    label: 'The Verge AI',         url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { publisher: 'the-register-ai', label: 'The Register AI',      url: 'https://www.theregister.com/headlines.atom?section=AI%2BML' },
  { publisher: 'venturebeat-ai',  label: 'VentureBeat AI',       url: 'https://venturebeat.com/category/ai/feed/' },
  { publisher: 'ars-ai',          label: 'Ars Technica AI',      url: 'https://arstechnica.com/ai/feed/' },
];

const MAX_AGE_DAYS = 14;
const PER_FEED_CAP = 15;

const AI_KEYWORDS: RegExp[] = [
  /\bAI\b/i, /\bA\.I\.\b/i, /\bartificial intelligence\b/i, /\bLLM\b/i, /\bGPT(-\d+)?\b/i,
  /\bChatGPT\b/i, /\bClaude\b/i, /\bGemini\b/i, /\bMistral\b/i, /\bLlama\b/i,
  /\bagent(s|ic|ic AI)?\b/i, /\bneural\b/i, /\bgenerative\b/i,
  /\bfoundation model\b/i, /\btransformer\b/i, /\bmachine learning\b/i,
  /\bdeep learning\b/i, /\bcopilot\b/i, /\bOpenAI\b/i, /\bAnthropic\b/i,
  /\bDeepMind\b/i, /\bNvidia\b/i, /\bRAG\b/i, /\binference\b/i,
];

export function isAiItem(title: string, summary: string): boolean {
  const text = `${title}\n${summary}`;
  return AI_KEYWORDS.some((re) => re.test(text));
}

/**
 * Publishers that regularly paywall AI content. The empty-summary heuristic
 * is too noisy across the whole publisher set — The Register and Ars publish
 * short-summary items that aren't actually paywalled — so we constrain
 * "empty → paywall" to publishers we already know paywall their AI section.
 * Phrase-match still applies everywhere as a defense-in-depth.
 */
const PAYWALL_PUBLISHERS: ReadonlySet<string> = new Set([
  'the-information',
  'ft-ai',
  'bloomberg-tech',
]);

/**
 * Paywall heuristic (ISC-206): an empty/<30-char summary on a paywall-prone
 * publisher OR a "subscribe to read" phrase anywhere signals a stub. We FLAG
 * not drop — the title still counts as signal that something happened.
 *
 * Tightened from the initial <50-char threshold after the live S20 probe
 * showed The Register / Ars ship terse-but-real items at 40-50 chars: their
 * shortness was a publisher style, not a paywall.
 */
export function isPaywallStub(summary: string, publisher: string): boolean {
  const trimmed = summary.trim();
  if (/subscribe to read|log in to continue|paid subscribers|sign in to read/i.test(trimmed)) return true;
  if (!PAYWALL_PUBLISHERS.has(publisher)) return false;
  if (trimmed.length === 0) return true;
  if (trimmed.length < 30) return true;
  return false;
}

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

function freshnessEngagement(ageHours: number): number {
  return Math.max(0, Math.round(100 - ageHours / 2));
}

export function normalize(
  feed: EnterpriseFeed,
  rawTitle: string,
  link: string,
  pubRaw: string,
  summaryRaw: string,
  now: number = Date.now(),
): NormalizedItem | null {
  const title = decodeEntities(stripCdataAndTags(rawTitle));
  const summary = decodeEntities(stripCdataAndTags(summaryRaw));
  if (!title || !link) return null;

  // ISC-197 / ISC-205 anti: non-AI items on general-tech feeds are filtered at
  // harvest, not later. Publisher-AI-scoped feeds skip the filter.
  if (feed.needsAiFilter && !isAiItem(title, summary)) return null;

  const tsParsed = pubRaw ? Date.parse(pubRaw) : NaN;
  const tsMs = Number.isNaN(tsParsed) ? now : tsParsed;
  const ageHours = Math.max(0, (now - tsMs) / 3_600_000);
  if (ageHours > MAX_AGE_DAYS * 24) return null;

  const paywall = isPaywallStub(summary, feed.publisher);

  return {
    title: `[${feed.label}] ${title}`,
    url: link.trim(),
    source: 'enterprise',
    ts: new Date(tsMs).toISOString(),
    engagement: freshnessEngagement(ageHours),
    raw_text: title + ' — ' + summary.slice(0, 280),
    meta: {
      publisher: feed.publisher,
      label: feed.label,
      summary: summary.slice(0, 280),
      paywall,
      date_basis: Number.isNaN(tsParsed) ? 'feed-fallback' : 'feed-pubdate',
    },
  };
}

async function fetchFeed(feed: EnterpriseFeed): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)' },
    });
    if (!res.ok) throw new Error(`${feed.publisher}: HTTP ${res.status}`);
    const xml = await res.text();
    await captureRaw('enterprise', feed.publisher, xml);

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

export async function harvestEnterprise(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(PUBLISHER_FEEDS.map((feed) => fetchFeed(feed)));
  const items: NormalizedItem[] = [];
  let okCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const feed = PUBLISHER_FEEDS[i];
    if (!feed) continue;
    if (r && r.status === 'fulfilled') {
      items.push(...r.value);
      okCount += 1;
      console.error(`  enterprise:${feed.publisher} ok (${r.value.length} items)`);
    } else if (r && r.status === 'rejected') {
      console.error(`  WARN enterprise:${feed.publisher} — ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  if (okCount === 0 && PUBLISHER_FEEDS.length > 0) {
    throw new Error('enterprise: all feeds failed');
  }
  return items;
}

if (import.meta.main) {
  try {
    const items = await harvestEnterprise();
    const byPublisher = items.reduce<Record<string, number>>((acc, it) => {
      const p = (it.meta as { publisher?: string } | undefined)?.publisher ?? '?';
      acc[p] = (acc[p] ?? 0) + 1;
      return acc;
    }, {});
    const paywallCount = items.filter((i) => (i.meta as { paywall?: boolean } | undefined)?.paywall).length;
    console.error(`harvest:enterprise — ${items.length} items (` +
      Object.entries(byPublisher).map(([k, v]) => `${k}:${v}`).join(', ') +
      `) — ${paywallCount} paywall-flagged`);
    console.log(JSON.stringify(items, null, 2));
  } catch (e) {
    console.error('harvest:enterprise failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
