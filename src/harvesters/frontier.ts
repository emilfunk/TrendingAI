import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedItem } from '../types.ts';
import { captureRaw } from './_capture.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Frontier-lab harvester. Two acquisition shapes, one normalized output:
 *
 *  - `rss` (default) — the lab publishes a machine-readable RSS/Atom feed.
 *    OpenAI, HuggingFace, Google AI, DeepMind, Meta all do.
 *  - `sitemap` — the lab publishes NO feed (Anthropic, Mistral). Verified
 *    iteration 8: both 404 on /rss.xml, /news/rss.xml, /feed.xml — but both
 *    serve a plain `sitemap.xml` (200) and a static `/news` index (200). So
 *    the gap was never "needs a headless browser" (advisor-corrected) — it's
 *    a static fetch-and-parse: read the sitemap for recent /news/ URLs, then
 *    fetch each article page for its real og:title + og:description.
 */
type FrontierFeed = { name: string; url: string; type?: 'rss' | 'sitemap'; keywordFilter?: RegExp };

const FEEDS: FrontierFeed[] = [
  // ISC-109 — official OpenAI feed. openai.com/blog/rss.xml now 307-redirects;
  // openai.com/news/rss.xml is the live canonical endpoint (probed 200).
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'HuggingFace', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
  { name: 'DeepMind', url: 'https://www.deepmind.com/blog/rss.xml' },
  {
    name: 'Meta',
    url: 'https://about.fb.com/news/feed/',
    keywordFilter: /\b(AI|LLM|model|Llama|agent|machine learning|reasoning|frontier)\b/i,
  },
  // No RSS — sitemap-sourced (see the `sitemap` note above).
  { name: 'Anthropic', url: 'https://www.anthropic.com/sitemap.xml', type: 'sitemap' },
  { name: 'Mistral', url: 'https://mistral.ai/sitemap.xml', type: 'sitemap' },
];

const AI_KEYWORDS = /\b(AI|LLM|GPT|Claude|Gemini|Llama|Mistral|model|agent|reasoning|RAG|fine-tun|transformer|diffusion|prompt|inference|training|alignment|safety|frontier|multimodal|embedding|context window|tokeniz|hallucinat)\b/i;

const CUSTOMER_STORY_PATTERNS = /\b(case study|customer story|scales|teams use|how .+ uses|saves [\d$]|achieves|delivers .+results|powered by|partner spotlight)\b/i;
const PER_LAB_CAP = 20;
const MAX_AGE_DAYS = 14;
// Sitemap path: how many of the most-recent /news/ URLs to actually fetch for
// titles. Bounded so a sitemap with hundreds of entries can't fan out.
const SITEMAP_RECENT_CAP = 12;
// ISC-122 — a sitemap-lastmod within this many days is trusted as a real
// publish date (labs don't re-touch old pages and bump lastmod to today), so
// it escapes the recency discount. Older sitemap items keep the discount.
const RECENT_TRUST_DAYS = 3;

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
 * Pulls a `<meta>` content value by its property/name key. Attribute order
 * varies across sites (content-first vs property-first), so both arrangements
 * are tried.
 */
function extractMeta(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b[^>]*\\b(?:property|name)="${k}"[^>]*\\bcontent="([^"]*)"`, 'i'),
    new RegExp(`<meta\\b[^>]*\\bcontent="([^"]*)"[^>]*\\b(?:property|name)="${k}"`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * `dateBasis` records WHERE `ts` came from, so the date is never presented as
 * more authoritative than it is:
 *   feed-pubdate    — the RSS/Atom item's own <pubDate>/<published> (trustworthy)
 *   feed-fallback   — RSS item had no parseable date; harvest time used
 *   published       — sitemap article exposed <meta article:published_time>
 *   sitemap-lastmod — NO publish date on the page; the sitemap's <lastmod> is
 *                     used. lastmod is "page last modified", not "published" —
 *                     a re-touched older article can look recent. Known caveat.
 */
type DateBasis = 'feed-pubdate' | 'feed-fallback' | 'published' | 'sitemap-lastmod';

function normalizeItem(
  name: string,
  title: string,
  url: string,
  tsMs: number,
  summary: string,
  dateBasis: DateBasis,
): NormalizedItem {
  // Engagement is a recency proxy — same model as the RSS path, so sitemap-
  // sourced labs rank comparably against feed-sourced ones.
  const ageDays = (Date.now() - tsMs) / 86_400_000;
  // `sitemap-lastmod` items have an UNCERTAIN date — lastmod is page-modified,
  // not published, so a re-touched older article can look fresh. Discount their
  // recency-engagement so an uncertain-date item can't take a top slot purely
  // on a possibly-stale "recency". Deterministic arithmetic, fits the
  // determinism-over-magic principle. (Iteration 8: advisor-recommended
  // containment, added after JSON-LD `datePublished` was confirmed absent on
  // both Anthropic and Mistral article pages — there is no cheap true-date fix.)
  // ISC-122 — targeted recency-discount fix. The flat ×0.6 on every
  // sitemap-lastmod item buried fresh headline announcements ("Introducing
  // Claude Opus 4.7") whose only sin was coming from a no-RSS lab. Targeted
  // exclusion: a lastmod within RECENT_TRUST_DAYS is almost certainly a real
  // publish, so it is trusted at full confidence. The ×0.6 still applies to
  // 3–14-day-old sitemap items, where "re-touched older article" is the real
  // risk. NOT a blind revert — the discount is kept where it earns its keep.
  const recencyConfidence =
    dateBasis === 'sitemap-lastmod'
      ? ageDays <= RECENT_TRUST_DAYS
        ? 1.0
        : 0.6
      : 1.0;
  const recencyEngagement = Math.max(1, Math.round((60 - ageDays * 2) * recencyConfidence));
  return {
    title: `[${name}] ${title}`,
    url,
    source: 'frontier',
    ts: new Date(tsMs).toISOString(),
    engagement: recencyEngagement,
    raw_text: title + ' — ' + summary.slice(0, 280),
    meta: { lab: name, summary: summary.slice(0, 280), date_basis: dateBasis },
  };
}

async function fetchFeed(feed: FrontierFeed): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)' },
    });
    if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
    const xml = await res.text();
    await captureRaw('frontier', feed.name, xml);

    const isAtom = /<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml);

    const itemBlocks = isAtom ? extractAll(xml, 'entry') : extractAll(xml, 'item');
    const items: NormalizedItem[] = [];
    const now = Date.now();
    for (const block of itemBlocks) {
      const rawTitle = extractFirst(block, 'title');
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
        extractFirst(block, 'content') ??
        '';
      if (!rawTitle || !link) continue;
      const title = decodeEntities(stripCdataAndTags(rawTitle));
      const summary = decodeEntities(stripCdataAndTags(summaryRaw));
      const combinedForFilter = title + ' ' + summary;

      if (feed.keywordFilter && !feed.keywordFilter.test(combinedForFilter)) continue;
      if (feed.name === 'Meta' || feed.name === 'Google AI') {
        if (!AI_KEYWORDS.test(combinedForFilter)) continue;
      }
      if (CUSTOMER_STORY_PATTERNS.test(combinedForFilter)) continue;

      const tsParsed = pubRaw ? Date.parse(pubRaw) : NaN;
      const tsMs = Number.isNaN(tsParsed) ? now : tsParsed;

      const ageDays = Number.isNaN(tsParsed) ? MAX_AGE_DAYS : (now - tsParsed) / 86_400_000;
      if (ageDays > MAX_AGE_DAYS) continue;

      const basis: DateBasis = Number.isNaN(tsParsed) ? 'feed-fallback' : 'feed-pubdate';
      items.push(normalizeItem(feed.name, title, link.trim(), tsMs, summary, basis));
    }
    items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return items.slice(0, PER_LAB_CAP);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches one article page (from a sitemap-sourced lab) for its real title +
 * summary. Returns null on any failure or filter miss — the caller drops nulls,
 * so a single dead article never sinks the lab's whole harvest.
 */
async function fetchArticle(
  name: string,
  url: string,
  lastmodMs: number,
): Promise<NormalizedItem | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const slug = url.replace(/\/+$/, '').split('/').pop() ?? 'article';
    await captureRaw('frontier', `${name}-${slug}`, html);

    const rawTitle = extractMeta(html, 'og:title') ?? extractFirst(html, 'title') ?? '';
    const title = decodeEntities(stripCdataAndTags(rawTitle))
      // drop a trailing " \ Anthropic" / " | Mistral AI" site-name suffix
      .replace(/\s*[\\|·–-]\s*(Anthropic|Mistral(?:\s*AI)?)\s*$/i, '')
      .trim();
    if (!title) return null;

    const rawSummary =
      extractMeta(html, 'og:description') ?? extractMeta(html, 'description') ?? '';
    const summary = decodeEntities(stripCdataAndTags(rawSummary));

    const combined = title + ' ' + summary;
    if (!AI_KEYWORDS.test(combined)) return null;
    if (CUSTOMER_STORY_PATTERNS.test(combined)) return null;

    // Prefer the article's own published date; fall back to the sitemap lastmod.
    const pubRaw = extractMeta(html, 'article:published_time') ?? '';
    const pubParsed = pubRaw ? Date.parse(pubRaw) : NaN;
    const hasPubDate = !Number.isNaN(pubParsed);
    const tsMs = hasPubDate ? pubParsed : lastmodMs;
    const basis: DateBasis = hasPubDate ? 'published' : 'sitemap-lastmod';

    return normalizeItem(name, title, url, tsMs, summary, basis);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sitemap acquisition path: read the lab's sitemap.xml, keep recent `/news/`
 * URLs, then fetch each article page for its real title. Bounded by
 * SITEMAP_RECENT_CAP so a large sitemap can't fan out unboundedly.
 */
async function fetchSitemapFeed(feed: FrontierFeed): Promise<NormalizedItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  let candidates: { loc: string; lastmod: number }[] = [];
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'TrendingAI/0.1 (hackathon)' },
    });
    if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
    const xml = await res.text();
    await captureRaw('frontier', `${feed.name}-sitemap`, xml);

    const now = Date.now();
    for (const block of extractAll(xml, 'url')) {
      const loc = (extractFirst(block, 'loc') ?? '').trim();
      if (!loc || !/\/news\//.test(loc)) continue;
      const lastmodRaw = extractFirst(block, 'lastmod') ?? '';
      const lastmod = Date.parse(lastmodRaw);
      if (Number.isNaN(lastmod)) continue;
      if ((now - lastmod) / 86_400_000 > MAX_AGE_DAYS) continue;
      candidates.push({ loc, lastmod });
    }
  } finally {
    clearTimeout(timer);
  }

  candidates.sort((a, b) => b.lastmod - a.lastmod);
  candidates = candidates.slice(0, SITEMAP_RECENT_CAP);

  const results = await Promise.allSettled(
    candidates.map((c) => fetchArticle(feed.name, c.loc, c.lastmod)),
  );
  const items: NormalizedItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) items.push(r.value);
  }
  items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return items.slice(0, PER_LAB_CAP);
}

export async function harvestFrontier(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map((f) => (f.type === 'sitemap' ? fetchSitemapFeed(f) : fetchFeed(f))),
  );
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const feed = FEEDS[i];
    if (!r || !feed) continue;
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
    } else {
      console.error(`  frontier ${feed.name} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  return items;
}

async function main(): Promise<void> {
  const items = await harvestFrontier();
  if (items.length === 0) {
    console.error('Frontier harvest: zero items — failing per ISC-8');
    process.exit(1);
  }
  const outPath = resolve(ROOT, 'data', 'frontier.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(items, null, 2));
  const byLab = items.reduce<Record<string, number>>((acc, it) => {
    const lab = String((it.meta as { lab?: string })?.lab ?? '?');
    acc[lab] = (acc[lab] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `Frontier: ${items.length} items (` +
      Object.entries(byLab).map(([k, v]) => `${k}:${v}`).join(', ') +
      `) → ${outPath}`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Frontier harvest failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
