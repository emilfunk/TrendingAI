export type Source = 'hn' | 'arxiv' | 'github' | 'x' | 'frontier' | 'youtube' | 'reddit' | 'bluesky' | 'tiktok' | 'instagram' | 'editorial' | 'enterprise';

export type ChannelCadence = {
  channelId: string;
  items_30d: number;
  avg_gap_hours: number | null;
  last_item_iso: string | null;
};

export type NormalizedItem = {
  title: string;
  url: string;
  source: Source;
  ts: string;
  engagement: number;
  raw_text: string;
  /**
   * Claim boundary (ISA ISC-58) — when this item's raw upstream response was
   * captured. Distinct from `ts` (the item's own publish time). Optional on the
   * type so fixtures committed before this field existed still typecheck.
   * Live items get the harvest-run time, stamped per-source in orchestrator.ts.
   * Fixture items get the value content-sourced from the fixture body — baked
   * in by make-fixtures.ts from the live harvest stamp, deliberately NOT derived
   * from file mtime (git does not preserve mtime, so a fresh clone would
   * fabricate capture times — refuted in iteration 6, see ISA Changelog).
   * Fixtures predating the field carry no captured_at and render 'unknown' —
   * honest, never a guessed checkout artifact (ISC-61).
   */
  captured_at?: string;
  meta?: Record<string, unknown>;
};

/**
 * ISC-67 — mailing-list schema sanity check. A future mailing-list source
 * (Mailman / Google Groups archives) maps onto NormalizedItem with NO schema
 * change: title = subject line, url = archive permalink, source = 'mailinglist',
 * ts = Date header (ISO), engagement = thread reply count, raw_text = first
 * ~400 chars of body, meta = { listName, messageId, author }. The deferred
 * source is therefore not locked out by the current schema.
 */

export type Cluster = {
  id: string;
  label: string;
  items: NormalizedItem[];
  velocity: number;
  cross_source: number;
  engagement_mean: number;
  leading_source_share: number;
  score: number;
  viral_score: number;
  pre_viral_score: number;
  confidence: 'HIGH' | 'MED' | 'LOW';
};

export type VerifyResult = {
  url: string;
  ok: boolean;
  status: number;
};

export type RunStats = {
  generated_at: string;
  source_counts: Record<Source, number>;
  dedupe_in: number;
  dedupe_out: number;
  /**
   * Live mode: fraction of probed URLs that passed liveness (0..1).
   * Fixture mode: `null` — fixture URLs are asserted live by the fixture
   * contract, not probed. `null` is reported honestly as "skipped"; a
   * fabricated `1` would read as "100% verified" when nothing was verified.
   */
  verification_pass_rate: number | null;
};
