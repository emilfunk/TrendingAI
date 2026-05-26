// D-WALK-22 — Tests for src/seed-discovery.ts (iter-30).
// Covers each gate independently + the Agent-SDK-shaped holdout probe
// (ISC-404) that proves the mechanism would have caught the Agent SDK /
// June-15 dedicated-credit drama without manual seeding.

import { describe, it, expect } from "bun:test";
import type { NormalizedItem } from "./types.ts";
import {
  proposeSeedCandidates,
  isLabXCandidate,
  hasNegativeReplyPool,
  indexCommentSentimentByStatusId,
} from "./seed-discovery.ts";

function makeXItem(over: Partial<NormalizedItem> & { author?: string }): NormalizedItem {
  const { author, ...rest } = over;
  return {
    url: "https://x.com/ClaudeDevs/status/1111111111111111111",
    title: "@ClaudeDevs: example",
    raw_text: "example",
    ts: "2026-05-15T12:00:00.000Z",
    source: "x",
    engagement: 20_000,
    meta: { author: author ?? "ClaudeDevs" },
    ...rest,
  } as NormalizedItem;
}

const NEGATIVE_AGG = {
  total: 20,
  dominant: "NEGATIVE",
  negative: 12,
  positive: 2,
  neutral: 3,
  mixed: 3,
};

describe("isLabXCandidate", () => {
  it("rejects non-lab authors even at high engagement with empty entities", () => {
    const item = makeXItem({ author: "RandomCreator", title: "@randomcreator: thoughts" });
    expect(isLabXCandidate(item)).toBe(false);
  });

  it("rejects lab authors below the engagement floor", () => {
    const item = makeXItem({ engagement: 9_999, title: "@ClaudeDevs: ambient" });
    expect(isLabXCandidate(item)).toBe(false);
  });

  it("rejects posts whose Title-Case entity extraction is non-empty (Grok Build)", () => {
    const item = makeXItem({
      author: "xai",
      title: "@xai: An early beta of Grok Build, an agentic CLI for coding...",
      raw_text: "Grok Build is now available.",
      engagement: 545_913,
    });
    expect(isLabXCandidate(item)).toBe(false);
  });

  it("rejects posts whose announcement-pattern fallback extracts a surviving entity (vision support)", () => {
    const item = makeXItem({
      author: "OpenAI",
      title: "@OpenAI: New in ChatGPT: vision support coming soon to paid users",
      raw_text: "available today",
      engagement: 50_000,
    });
    expect(isLabXCandidate(item)).toBe(false);
  });

  it("accepts a lab post with genuinely empty entity extraction at high engagement (@sama Codex mobile)", () => {
    const item = makeXItem({
      author: "sama",
      title: "@sama: Codex in the ChatGPT mobile app!",
      raw_text: "Codex in the ChatGPT mobile app!",
      engagement: 23_301,
    });
    expect(isLabXCandidate(item)).toBe(true);
  });
});

describe("hasNegativeReplyPool", () => {
  it("returns true on dominant NEGATIVE", () => {
    expect(hasNegativeReplyPool(NEGATIVE_AGG)).toBe(true);
  });

  it("returns true on MIXED-but-substantial-negative (>40% on n>=5)", () => {
    expect(
      hasNegativeReplyPool({ total: 20, dominant: "MIXED", negative: 9, positive: 4 }),
    ).toBe(true);
  });

  it("returns false on positive-dominant", () => {
    expect(
      hasNegativeReplyPool({ total: 20, dominant: "POSITIVE", negative: 2, positive: 14 }),
    ).toBe(false);
  });

  it("returns false on tiny sample even if negative ratio is high", () => {
    expect(
      hasNegativeReplyPool({ total: 4, dominant: "MIXED", negative: 3, positive: 0 }),
    ).toBe(false);
  });

  it("returns false on undefined agg", () => {
    expect(hasNegativeReplyPool(undefined)).toBe(false);
  });
});

describe("indexCommentSentimentByStatusId", () => {
  it("keys rows by status-id segment", () => {
    const idx = indexCommentSentimentByStatusId([
      {
        tweet_url: "https://x.com/ClaudeDevs/status/2054610152817619388",
        agg: NEGATIVE_AGG,
      },
    ]);
    expect(idx.has("2054610152817619388")).toBe(true);
  });

  it("skips rows without a status-id", () => {
    const idx = indexCommentSentimentByStatusId([
      { tweet_url: "https://example.com/no-id", agg: NEGATIVE_AGG },
    ]);
    expect(idx.size).toBe(0);
  });
});

describe("proposeSeedCandidates — ISC-404 holdout probe (genuinely-empty-entity lab post)", () => {
  it("proposes a seed for a lab post with empty entities + negative replies + lab author (@sama Codex mobile)", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/sama/status/2055034461591588916",
        author: "sama",
        title: "@sama: Codex in the ChatGPT mobile app!",
        raw_text: "Codex in the ChatGPT mobile app!",
        engagement: 23_301,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/sama/status/2055034461591588916",
        agg: NEGATIVE_AGG,
        replies: [
          { author: "dev1", body: "this kills my desktop workflow", classification: "NEGATIVE" },
          { author: "dev2", body: "mobile is half-baked for codex", classification: "NEGATIVE" },
        ],
      },
    ];
    const stubLlm = async () => "codex mobile preview";
    const out = await proposeSeedCandidates({ xItems, commentSentiment, llm: stubLlm });
    expect(out.length).toBe(1);
    expect(out[0]!.entity_proposal).toBe("codex mobile preview");
    expect(out[0]!.recommended_seed.entity_phrases).toEqual(["codex mobile preview"]);
    expect(out[0]!.recommended_seed.source).toBe("seed");
    expect(out[0]!.reply_pool.total).toBe(20);
    expect(out[0]!.reply_pool.dominant).toBe("NEGATIVE");
  });

  it("drops a candidate when LLM proposal is a GENERIC_PRODUCTS name (ISC-401 anti)", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/sama/status/2055034461591588916",
        author: "sama",
        title: "@sama: Codex in the ChatGPT mobile app!",
        raw_text: "Codex in the ChatGPT mobile app!",
        engagement: 23_301,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/sama/status/2055034461591588916",
        agg: NEGATIVE_AGG,
        replies: [{ body: "this is half-baked", classification: "NEGATIVE" }],
      },
    ];
    const stubLlmReturnsBlocked = async () => "claude code";
    const out = await proposeSeedCandidates({
      xItems,
      commentSentiment,
      llm: stubLlmReturnsBlocked,
    });
    expect(out.length).toBe(0);
  });

  it("drops a candidate when LLM returns null (non-feature post)", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/AnthropicAI/status/2054987444664377374",
        author: "AnthropicAI",
        title: "@AnthropicAI: We've published a paper that explains our views on AI competition between the US and China.",
        raw_text: "the US and democratic allies should...",
        engagement: 45_534,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/AnthropicAI/status/2054987444664377374",
        agg: NEGATIVE_AGG,
      },
    ];
    const stubLlmReturnsNull = async () => null;
    const out = await proposeSeedCandidates({
      xItems,
      commentSentiment,
      llm: stubLlmReturnsNull,
    });
    expect(out.length).toBe(0);
  });

  it("ISC-412 collision-check: flags candidate whose URL matches an existing SEEDED_FEATURE", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/claudeai/status/2053940934736228454",
        author: "claudeai",
        title: "@claudeai: New in Claude Code: agent view.",
        raw_text: "available today as a research preview",
        engagement: 92_418,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/claudeai/status/2053940934736228454",
        agg: NEGATIVE_AGG,
      },
    ];
    const stubLlm = async () => "session timeline view";
    const out = await proposeSeedCandidates({ xItems, commentSentiment, llm: stubLlm });
    expect(out.length).toBe(1);
    expect(out[0]!.existing_seed_collision).toEqual({ feature_id: "seed-agent-view", reason: "url" });
  });

  it("ISC-412 collision-check: flags candidate whose entity proposal matches an existing seed phrase", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/AnthropicAI/status/9999999999999999999",
        author: "AnthropicAI",
        title: "@AnthropicAI: refreshed docs",
        raw_text: "refreshed docs",
        engagement: 50_000,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/AnthropicAI/status/9999999999999999999",
        agg: NEGATIVE_AGG,
      },
    ];
    const stubLlm = async () => "model context protocol";
    const out = await proposeSeedCandidates({ xItems, commentSentiment, llm: stubLlm });
    expect(out.length).toBe(1);
    expect(out[0]!.existing_seed_collision).toEqual({ feature_id: "seed-mcp", reason: "entity_phrase" });
  });

  it("ISC-412 collision-check: returns null for a genuinely-new proposal", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/sama/status/2055034461591588916",
        author: "sama",
        title: "@sama: Codex in the ChatGPT mobile app!",
        raw_text: "Codex in the ChatGPT mobile app!",
        engagement: 23_301,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/sama/status/2055034461591588916",
        agg: NEGATIVE_AGG,
      },
    ];
    const stubLlm = async () => "codex mobile preview";
    const out = await proposeSeedCandidates({ xItems, commentSentiment, llm: stubLlm });
    expect(out.length).toBe(1);
    expect(out[0]!.existing_seed_collision).toBeNull();
  });

  it("drops a candidate with positive-dominant reply pool (sentiment-join gate)", async () => {
    const xItems: NormalizedItem[] = [
      makeXItem({
        url: "https://x.com/ClaudeDevs/status/2054610152817619388",
        author: "ClaudeDevs",
        title: "@ClaudeDevs: ambient policy update",
        raw_text: "details inside",
        engagement: 114_719,
      }),
    ];
    const commentSentiment = [
      {
        tweet_url: "https://x.com/ClaudeDevs/status/2054610152817619388",
        agg: { total: 20, dominant: "POSITIVE", negative: 1, positive: 15 },
      },
    ];
    const stubLlm = async () => "some feature";
    const out = await proposeSeedCandidates({ xItems, commentSentiment, llm: stubLlm });
    expect(out.length).toBe(0);
  });
});
