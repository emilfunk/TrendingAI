import type { NormalizedItem, Source } from './types.ts';

/**
 * ISC-112 — rule-based leak filter.
 *
 * The per-harvester AI-keyword gates are necessary but not sufficient: mixed-
 * content feeds still leak noise — Meta's "Celebrating African Cinema"
 * (corporate-event marketing), Google AI's "5 gardening tips you can try right
 * in Search" (consumer puff), an "FFmpeg" video from an AI researcher's
 * mixed-topic YouTube channel.
 *
 * Scope is deliberately narrow — learned from a live run that produced false
 * positives (an arXiv paper saying "training recipe", a researcher tweeting
 * "celebrate" both got dropped):
 *   - Deny-patterns match the TITLE only. raw_text (abstracts, full tweet/post
 *     bodies) is long and produces incidental matches.
 *   - Deny-patterns apply only to `frontier` and `youtube` — the RSS-fed mixed-
 *     content sources the iteration-9 audit actually named. arXiv/HN/GitHub/X/
 *     Reddit/Bluesky have tight harvest-time gates already.
 *   - YouTube additionally must carry a positive AI signal (title or body) —
 *     curated channels still publish off-topic uploads.
 *
 * Every drop is returned with its reason — the caller logs them, so the filter
 * is auditable and never silently eats signal.
 */

/** Sources whose titles are subject to the deny-list (the mixed-content feeds). */
const DENY_SOURCES: ReadonlySet<Source> = new Set<Source>(['frontier', 'youtube']);

const DENY_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'corporate-event-marketing',
    re: /\b(celebrat(?:e|es|ing)|black history month|women'?s history month|pride month|earth day|partner spotlight|community spotlight|customer spotlight|now hiring|we'?re hiring|join our team|african cinema|made by africa)\b/i,
  },
  {
    name: 'consumer-lifestyle-puff',
    re: /\b(gardening|gift guide|holiday gift|home decor|life ?hacks?|tips you can try|things you (?:can|should) try|spring cleaning|meal prep)\b/i,
  },
  {
    name: 'off-topic',
    re: /\b(how to (?:cook|paint|draw|knit)|daily vlog|gameplay walkthrough)\b/i,
  },
];

/**
 * Positive AI signal — required of YouTube items (title or body). A curated
 * channel still mixes in non-AI uploads (the "FFmpeg on Lex Fridman's channel"
 * leak). Other sources already gate on AI keywords at harvest.
 */
const AI_POSITIVE =
  /\b(AI|LLM|GPT|Claude|Gemini|Llama|Mistral|Grok|DeepSeek|model|agent(?:ic|s)?|reasoning|RAG|fine[- ]?tun|transformer|diffusion|prompt|inference|training|alignment|neural|machine learning|deep learning|multimodal|embedding|benchmark|chatbot|generative|AGI|open[- ]?weight|frontier|robot|autonomous|compute)\b/i;

export type FilterDrop = { item: NormalizedItem; reason: string };
export type FilterResult = { kept: NormalizedItem[]; dropped: FilterDrop[] };

export function applyLeakFilter(items: NormalizedItem[]): FilterResult {
  const kept: NormalizedItem[] = [];
  const dropped: FilterDrop[] = [];
  for (const it of items) {
    let reason = '';
    if (DENY_SOURCES.has(it.source)) {
      // Title only — raw_text is too noisy and caused incidental matches.
      for (const p of DENY_PATTERNS) {
        if (p.re.test(it.title)) {
          reason = `deny:${p.name}`;
          break;
        }
      }
    }
    if (!reason && it.source === 'youtube' && !AI_POSITIVE.test(`${it.title} ${it.raw_text}`)) {
      reason = 'deny:youtube-no-ai-signal';
    }
    if (reason) dropped.push({ item: it, reason });
    else kept.push(it);
  }
  return { kept, dropped };
}
