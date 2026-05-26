// ISC-411 (iter-30 follow-up) — tests for the lab-X candidate expansion
// added to src/harvesters/x-replies.ts. Covers: filter gates, ship_id format,
// canonical-URL dedup against existing main-sources.

import { describe, it, expect } from "bun:test";
import type { NormalizedItem } from "../types.ts";
import {
  pickLabXCandidates,
  mergeSources,
  type ValidationRow,
} from "./x-replies.ts";

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

describe("pickLabXCandidates", () => {
  it("filters non-lab authors", () => {
    const items = [makeXItem({ author: "RandomCreator", engagement: 50_000 })];
    expect(pickLabXCandidates(items).length).toBe(0);
  });

  it("filters posts below engagement floor", () => {
    const items = [makeXItem({ author: "ClaudeDevs", engagement: 9_999 })];
    expect(pickLabXCandidates(items).length).toBe(0);
  });

  it("filters posts whose URL has no status-id segment", () => {
    const items = [makeXItem({ url: "https://x.com/ClaudeDevs/profile", engagement: 50_000 })];
    expect(pickLabXCandidates(items).length).toBe(0);
  });

  it("accepts a lab-X post above engagement floor and emits labx- prefixed ship_id", () => {
    const items = [
      makeXItem({
        url: "https://x.com/sama/status/2055034461591588916",
        author: "sama",
        title: "@sama: Codex in the ChatGPT mobile app!",
        engagement: 23_301,
      }),
    ];
    const out = pickLabXCandidates(items);
    expect(out.length).toBe(1);
    expect(out[0]!.ship).toBe("labx-sama-588916");
    expect(out[0]!.source).toBe("x");
    expect(out[0]!.verdict).toBe("VALIDATED");
    expect(out[0]!.url).toBe("https://x.com/sama/status/2055034461591588916");
    expect(out[0]!.author).toBe("sama");
    expect(out[0]!.engagement).toBe(23_301);
  });

  it("preserves the lab post's title as ship_name (truncated to 120)", () => {
    const longTitle = "@AnthropicAI: " + "x".repeat(200);
    const items = [makeXItem({ author: "AnthropicAI", title: longTitle, engagement: 50_000 })];
    const out = pickLabXCandidates(items);
    expect(out[0]!.ship_name.length).toBe(120);
  });
});

describe("mergeSources", () => {
  const mainSource: ValidationRow = {
    ship: "goal",
    ship_name: "/goal · Claude Code",
    source: "x",
    url: "https://x.com/ClaudeDevs/status/2054351031279186040",
    author: "ClaudeDevs",
    engagement: 32_936,
    verdict: "VALIDATED",
    reason: "feature-shortlist VALIDATED",
  };

  const labXCandidate: ValidationRow = {
    ship: "labx-sama-588916",
    ship_name: "@sama: Codex in the ChatGPT mobile app!",
    source: "x",
    url: "https://x.com/sama/status/2055034461591588916",
    author: "sama",
    engagement: 23_301,
    verdict: "VALIDATED",
    reason: "ISC-411 lab-X candidate",
  };

  it("appends lab-X candidates that aren't already in main-sources", () => {
    const merged = mergeSources([mainSource], [labXCandidate]);
    expect(merged.length).toBe(2);
    expect(merged[0]!.ship).toBe("goal");
    expect(merged[1]!.ship).toBe("labx-sama-588916");
  });

  it("drops a lab-X duplicate that matches a main-source URL (main wins, ship_id preserved)", () => {
    const dup: ValidationRow = {
      ...labXCandidate,
      url: mainSource.url,
      ship: "labx-claudedevs-186040",
    };
    const merged = mergeSources([mainSource], [dup]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.ship).toBe("goal");
  });

  it("treats trailing-slash + query suffixes as the same canonical URL for dedup", () => {
    const dup: ValidationRow = {
      ...labXCandidate,
      url: mainSource.url + "/?utm=share",
      ship: "labx-claudedevs-186040",
    };
    const merged = mergeSources([mainSource], [dup]);
    expect(merged.length).toBe(1);
  });

  it("returns main-sources unchanged when lab-X list is empty", () => {
    expect(mergeSources([mainSource], [])).toEqual([mainSource]);
  });
});
