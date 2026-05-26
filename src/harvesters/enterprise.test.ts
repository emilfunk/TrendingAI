import { describe, expect, test } from 'bun:test';
import { normalize, isAiItem, isPaywallStub } from './enterprise.ts';

const FEED_TC = { publisher: 'techcrunch', label: 'TechCrunch', url: 'https://x' };
const FEED_BLOOMBERG = { publisher: 'bloomberg-tech', label: 'Bloomberg Technology', url: 'https://x', needsAiFilter: true };
const FEED_TI = { publisher: 'the-information', label: 'The Information', url: 'https://x' };
const FEED_FT = { publisher: 'ft-ai', label: 'FT AI', url: 'https://x' };

describe('enterprise harvester — AI-keyword filter (ISC-197/205)', () => {
  test('isAiItem matches common AI tokens', () => {
    expect(isAiItem('OpenAI launches GPT-5', '')).toBe(true);
    expect(isAiItem('Anthropic raises billions', '')).toBe(true);
    expect(isAiItem('New LLM benchmark', 'transformer-based foundation model')).toBe(true);
    expect(isAiItem('Nvidia earnings beat', 'data center inference demand')).toBe(true);
  });

  test('isAiItem rejects non-AI items', () => {
    expect(isAiItem('Tesla quarterly results', 'EV sales soar')).toBe(false);
    expect(isAiItem('Apple Vision Pro 2', 'AR headset update')).toBe(false);
    expect(isAiItem('Stock market closes higher', 'S&P up 0.8%')).toBe(false);
  });

  test('normalize drops non-AI items on feeds with needsAiFilter (ISC-205)', () => {
    const it = normalize(FEED_BLOOMBERG, 'Tesla Q4 sales', 'https://x', 'Fri, 15 May 2026 08:00:00 GMT', 'EV deliveries.', Date.parse('2026-05-15T12:00:00Z'));
    expect(it).toBeNull();
  });

  test('normalize keeps AI items on feeds with needsAiFilter', () => {
    const it = normalize(FEED_BLOOMBERG, 'Nvidia AI data-center demand surges', 'https://x', 'Fri, 15 May 2026 08:00:00 GMT', 'GPU revenue.', Date.parse('2026-05-15T12:00:00Z'));
    expect(it).not.toBeNull();
    expect(it?.source).toBe('enterprise');
  });

  test('normalize keeps non-AI-keyword items on AI-scoped feeds (no filter)', () => {
    const it = normalize(FEED_TC, 'A general tech story', 'https://x', 'Fri, 15 May 2026 08:00:00 GMT', 'no keywords', Date.parse('2026-05-15T12:00:00Z'));
    expect(it).not.toBeNull();
  });
});

describe('enterprise harvester — paywall heuristic (ISC-206)', () => {
  test('phrase-match flags any publisher', () => {
    expect(isPaywallStub('Subscribe to read', 'techcrunch')).toBe(true);
    expect(isPaywallStub('Log in to continue', 'venturebeat-ai')).toBe(true);
    expect(isPaywallStub('Available for paid subscribers only', 'ars-ai')).toBe(true);
  });

  test('empty summary on paywall-prone publisher flags', () => {
    expect(isPaywallStub('', 'the-information')).toBe(true);
    expect(isPaywallStub('', 'ft-ai')).toBe(true);
    expect(isPaywallStub('', 'bloomberg-tech')).toBe(true);
  });

  test('empty summary on non-paywall publisher does NOT flag (Anti — Register/Ars false-positive)', () => {
    expect(isPaywallStub('', 'the-register-ai')).toBe(false);
    expect(isPaywallStub('', 'ars-ai')).toBe(false);
    expect(isPaywallStub('', 'techcrunch')).toBe(false);
  });

  test('full summary never flags, even on paywall-prone publisher', () => {
    const fullSummary = 'AI startup Anthropic announced new model capabilities and pricing changes for its API customers. The update includes faster inference and improved context handling for agentic workflows.';
    expect(isPaywallStub(fullSummary, 'the-information')).toBe(false);
    expect(isPaywallStub(fullSummary, 'ft-ai')).toBe(false);
  });
});

describe('enterprise harvester — normalize() (ISC-196)', () => {
  const NOW = Date.parse('2026-05-15T12:00:00Z');

  test('happy-path: emits source=enterprise + meta.publisher + meta.paywall', () => {
    const it = normalize(FEED_TC, 'OpenAI launches new agentic feature', 'https://techcrunch.com/article', 'Fri, 15 May 2026 08:00:00 GMT', 'A new agent-mode for ChatGPT enterprise customers, available immediately.', NOW);
    expect(it).not.toBeNull();
    expect(it?.source).toBe('enterprise');
    expect((it?.meta as { publisher?: string } | undefined)?.publisher).toBe('techcrunch');
    expect((it?.meta as { paywall?: boolean } | undefined)?.paywall).toBe(false);
  });

  test('paywall-stub item gets meta.paywall: true but is NOT dropped (ISC-206)', () => {
    const it = normalize(FEED_TI, 'AI deal-flow exclusive', 'https://www.theinformation.com/articles/x', 'Fri, 15 May 2026 08:00:00 GMT', 'Subscribe to read', NOW);
    expect(it).not.toBeNull();
    expect((it?.meta as { paywall?: boolean } | undefined)?.paywall).toBe(true);
  });

  test('missing title returns null', () => {
    expect(normalize(FEED_TC, '', 'https://x', 'Fri, 15 May 2026 08:00:00 GMT', 'AI summary', NOW)).toBeNull();
  });

  test('missing link returns null', () => {
    expect(normalize(FEED_TC, 'AI title', '', 'Fri, 15 May 2026 08:00:00 GMT', 'summary', NOW)).toBeNull();
  });

  test('item older than 14 days dropped', () => {
    const old = new Date(NOW - 20 * 86_400_000).toISOString();
    expect(normalize(FEED_TC, 'old AI item', 'https://x', old, 'summary', NOW)).toBeNull();
  });

  test('CDATA + HTML entities decoded', () => {
    const it = normalize(FEED_FT, '<![CDATA[Nvidia &amp; AMD AI chips]]>', 'https://x', 'Fri, 15 May 2026 08:00:00 GMT', '<![CDATA[<p>GPU vendors compete</p>]]>', NOW);
    expect(it).not.toBeNull();
    expect(it?.title).toContain('Nvidia & AMD');
    expect((it?.meta as { summary?: string } | undefined)?.summary).toContain('GPU vendors compete');
    expect((it?.meta as { summary?: string } | undefined)?.summary).not.toContain('<p>');
  });
});
