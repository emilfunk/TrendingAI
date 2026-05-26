import { describe, expect, test } from 'bun:test';
import { clusterHasTranscript, cadenceAside } from './render.ts';
import type { Cluster, NormalizedItem, ChannelCadence } from './types.ts';

function mkItem(meta?: Record<string, unknown>): NormalizedItem {
  return {
    title: 'Test item',
    url: 'https://example.com/x',
    source: 'youtube',
    ts: '2026-05-15T10:00:00Z',
    engagement: 100,
    raw_text: 'sample raw_text',
    meta,
  };
}

function mkCluster(items: NormalizedItem[]): Cluster {
  return {
    id: 'c0',
    label: 'test cluster',
    items,
    velocity: 0,
    cross_source: 0,
    engagement_mean: 0,
    leading_source_share: 0,
    score: 0.5,
    viral_score: 0,
    pre_viral_score: 0,
    confidence: 'MED',
  };
}

describe('clusterHasTranscript (ISC-239)', () => {
  test('returns true when at least one item carries meta.transcript_status === "present"', () => {
    const c = mkCluster([mkItem({ transcript_status: 'present' }), mkItem({ transcript_status: 'unavailable' })]);
    expect(clusterHasTranscript(c)).toBe(true);
  });

  test('returns false when no item carries a present transcript', () => {
    const c = mkCluster([mkItem({ transcript_status: 'unavailable' }), mkItem(), mkItem({ other: 'x' })]);
    expect(clusterHasTranscript(c)).toBe(false);
  });
});

describe('cadenceAside (ISC-236 + ISC-237 anti)', () => {
  test('renders aside for active channels with items_30d > 0', () => {
    const cadences: ChannelCadence[] = [
      { channelId: 'Yannic_Kilcher', items_30d: 4, avg_gap_hours: 168, last_item_iso: '2026-05-12T00:00:00Z' },
      { channelId: 'Lex_Fridman', items_30d: 1, avg_gap_hours: null, last_item_iso: '2026-05-06T00:00:00Z' },
    ];
    const html = cadenceAside(cadences);
    expect(html).toContain('YouTube cadence (last 30d)');
    expect(html).toContain('Yannic Kilcher');
    expect(html).toContain('4 in 30d');
    expect(html).toContain('168h');
    expect(html).toContain('Lex Fridman');
    expect(html).toContain('avg gap —'); // null gap renders as em dash
  });

  test('ISC-237 anti: empty cadence list returns empty string (no broken aside)', () => {
    expect(cadenceAside([])).toBe('');
  });

  test('ISC-237 anti: channels with items_30d=0 are filtered out before render', () => {
    const cadences: ChannelCadence[] = [
      { channelId: 'DeadChan', items_30d: 0, avg_gap_hours: null, last_item_iso: '2025-01-01T00:00:00Z' },
    ];
    expect(cadenceAside(cadences)).toBe('');
  });
});
