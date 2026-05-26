import { describe, expect, test } from 'bun:test';
import { cadenceFromTimestamps, computeCadence } from './cadence.ts';

const NOW = new Date('2026-05-15T20:00:00Z');
const hourAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();
const dayAgo = (n: number) => hourAgo(n * 24);

describe('cadenceFromTimestamps', () => {
  test('happy path: 4 evenly-spaced episodes within 30d returns positive items_30d and avg_gap', () => {
    const c = cadenceFromTimestamps('FakeChan', [dayAgo(1), dayAgo(8), dayAgo(15), dayAgo(22)], NOW);
    expect(c.channelId).toBe('FakeChan');
    expect(c.items_30d).toBe(4);
    expect(c.avg_gap_hours).toBe(168);
    expect(c.last_item_iso).toBe(dayAgo(1));
  });

  test('empty input: items_30d=0, avg_gap=null, last_item_iso=null', () => {
    const c = cadenceFromTimestamps('EmptyChan', [], NOW);
    expect(c.items_30d).toBe(0);
    expect(c.avg_gap_hours).toBeNull();
    expect(c.last_item_iso).toBeNull();
  });

  test('single item in window: avg_gap_hours stays null (cannot compute gap from one item)', () => {
    const c = cadenceFromTimestamps('OneShot', [dayAgo(5)], NOW);
    expect(c.items_30d).toBe(1);
    expect(c.avg_gap_hours).toBeNull();
    expect(c.last_item_iso).toBe(dayAgo(5));
  });

  test('sparse channel: last episode > 30d ago — items_30d=0 but last_item_iso preserved (channel went silent)', () => {
    const c = cadenceFromTimestamps('DeadChan', [dayAgo(45), dayAgo(60)], NOW);
    expect(c.items_30d).toBe(0);
    expect(c.avg_gap_hours).toBeNull();
    expect(c.last_item_iso).toBe(dayAgo(45));
  });

  test('unsorted input is handled: items are sorted desc internally before windowing', () => {
    const c = cadenceFromTimestamps('Jumbled', [dayAgo(15), dayAgo(1), dayAgo(8)], NOW);
    expect(c.items_30d).toBe(3);
    expect(c.last_item_iso).toBe(dayAgo(1));
  });
});

describe('computeCadence', () => {
  test('returns [] gracefully when rawDir does not exist (anti per ISC-237)', async () => {
    const out = await computeCadence('/nonexistent/path/that/should/never/exist', NOW);
    expect(out).toEqual([]);
  });
});
