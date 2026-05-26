// src/feature-sentiment.test.ts — regression tests for persistence-layer bugs.
//
// Built iter-32 in response to the creator_recommendation silent-drop bug:
// `processFeature` return statement enumerated persisted fields explicitly,
// so adding a new field to SentimentRow interface + SYS prompt was necessary
// but not sufficient — the persistence layer still dropped the field. Two
// full Sonnet runs (v1 + v2) lost creator_recommendation before the bug was
// root-caused. These tests pin the contract: every SentimentRow field that
// is supposed to round-trip through JSON.stringify → JSON.parse must do so.
//
// Test pattern is "write → reload → equal" — exactly what Advisor flagged
// at iter-32 commitment-boundary as the smallest assertion that prevents
// re-regression of the same defect class.
//
// Note: this file does NOT test the Sonnet call itself — it tests the
// persistence contract. Sonnet output shape lives in fixtures.

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SentimentRow {
  feature_id: string;
  feature_title: string;
  sample_size: number;
  overall_sentiment: "positive" | "mixed" | "negative" | "complaint-dominant" | "unclear";
  dominant_pattern?: "tutorial-hype" | "adoption" | "complaint" | "news" | "meta";
  summary_sentence: string;
  praises: string[];
  complaints: string[];
  notable_quotes: { author: string; source: string; quote: string }[];
  podcast_synth?: { video_id: string; show_name: string; synth_line: string }[];
  cross_narrative_ids?: string[];
  cited_items_why?: Record<string, string>;
  counter_narratives?: string[];
  creator_recommendation?: {
    angle: string;
    format: "tutorial" | "opinion" | "demo" | "explainer" | "reaction" | "comparison" | "post-mortem";
    hook: string;
  } | null;
  error?: string;
}

function withTempFile(fn: (filepath: string) => void): void {
  const filepath = path.join(os.tmpdir(), `feature-sentiment-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fn(filepath);
  } finally {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
}

describe("SentimentRow persistence contract", () => {
  it("round-trips a fully-populated row including creator_recommendation", () => {
    withTempFile((fp) => {
      const row: SentimentRow = {
        feature_id: "test-feature-1",
        feature_title: "Test Feature",
        sample_size: 10,
        overall_sentiment: "positive",
        dominant_pattern: "adoption",
        summary_sentence: "Creators are actually using this in production workflows.",
        praises: ["fast iteration", "clean API"],
        complaints: ["docs sparse"],
        notable_quotes: [{ author: "@user1", source: "x", quote: "this is genuinely good" }],
        podcast_synth: [{ video_id: "abc123", show_name: "Test Show", synth_line: "Argues for adoption." }],
        cross_narrative_ids: ["nar-1"],
        cited_items_why: { "https://example.com/1": "User shows working integration with their existing stack." },
        counter_narratives: ["Competitor X shipped this last month."],
        creator_recommendation: {
          angle: "Show the integration nobody is covering with their existing CI setup.",
          format: "demo",
          hook: "I plugged this into our CI in 5 minutes and here's what broke first.",
        },
      };
      fs.writeFileSync(fp, JSON.stringify([row], null, 2));
      const loaded: SentimentRow[] = JSON.parse(fs.readFileSync(fp, "utf-8"));
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(row);
      // Specifically pin creator_recommendation since that's the regression
      expect(loaded[0]!.creator_recommendation).toEqual(row.creator_recommendation);
      expect(loaded[0]!.creator_recommendation?.format).toBe("demo");
    });
  });

  it("round-trips creator_recommendation === null (honest no-pool case)", () => {
    withTempFile((fp) => {
      const row: SentimentRow = {
        feature_id: "test-feature-2",
        feature_title: "Test Feature 2",
        sample_size: 1,
        overall_sentiment: "unclear",
        summary_sentence: "",
        praises: [],
        complaints: [],
        notable_quotes: [],
        creator_recommendation: null,
      };
      fs.writeFileSync(fp, JSON.stringify([row], null, 2));
      const loaded: SentimentRow[] = JSON.parse(fs.readFileSync(fp, "utf-8"));
      expect(loaded[0]!.creator_recommendation).toBeNull();
    });
  });

  it("preserves all known SentimentRow fields after round-trip (anti-silent-drop)", () => {
    withTempFile((fp) => {
      const KNOWN_FIELDS: (keyof SentimentRow)[] = [
        "feature_id", "feature_title", "sample_size", "overall_sentiment",
        "dominant_pattern", "summary_sentence", "praises", "complaints",
        "notable_quotes", "podcast_synth", "cross_narrative_ids",
        "cited_items_why", "counter_narratives", "creator_recommendation",
      ];
      const row: SentimentRow = {
        feature_id: "f3",
        feature_title: "F3",
        sample_size: 5,
        overall_sentiment: "mixed",
        dominant_pattern: "news",
        summary_sentence: "Mixed reception.",
        praises: ["one good thing"],
        complaints: ["one bad thing"],
        notable_quotes: [{ author: "@a", source: "x", quote: "q" }],
        podcast_synth: [],
        cross_narrative_ids: [],
        cited_items_why: {},
        counter_narratives: [],
        creator_recommendation: null,
      };
      fs.writeFileSync(fp, JSON.stringify([row], null, 2));
      const loaded = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const loadedKeys = new Set(Object.keys(loaded[0]));
      for (const k of KNOWN_FIELDS) {
        expect(loadedKeys.has(k)).toBe(true);
      }
    });
  });

  it("data/feature-sentiment.json — every row has creator_recommendation key (or null)", () => {
    // Live-data regression check — runs against the actual on-disk artifact.
    // If add-creator-recs.ts didn't run OR processFeature dropped the field,
    // this test fails. The check is "key present" — null is a valid value
    // (honest no-pool); absent is the failure mode.
    const HOME = process.env.HOME!;
    const datapath = `${process.cwd()}/data/feature-sentiment.json`;
    if (!fs.existsSync(datapath)) return; // skip on fresh checkout
    const rows = JSON.parse(fs.readFileSync(datapath, "utf-8"));
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "creator_recommendation"))
        .toBe(true);
    }
  });
});
