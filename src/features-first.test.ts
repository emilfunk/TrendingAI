import { describe, it, expect } from "bun:test";
import { isDistinctiveEntity, extractEntities, rebalanceNotableOrphans } from "./features-first";

interface Orphan {
  source: string;
  author: string;
  url: string;
  title: string;
  raw_text: string;
  engagement: number;
  ts: string;
}

function mkOrphan(source: string, author: string, engagement: number, n: number): Orphan {
  return {
    source,
    author,
    url: `https://${source}.test/${author}/${n}`,
    title: `${author} post #${n}`,
    raw_text: `body ${n}`,
    engagement,
    ts: "2026-05-17T00:00:00Z",
  };
}

// ISC-410 / ISC-414 (iter-31) — first-word-stopword check coverage.
// The iter-30 close named a structural defect: extractEntities' Two-word
// Title-Case regex captured "Starting June 15" from the @ClaudeDevs Agent-SDK
// post and the phrase passed isDistinctiveEntity because "starting" had no
// single-token presence in any reject set. The fix lifts a first-word check
// (mirroring what isValidAnchorPhrase already does for the announcement-
// fallback path) into isDistinctiveEntity so both extractor paths filter
// consistently.
//
// Anti-regression discipline: legitimate two-word entities whose first word
// is a lab/product family name MUST still pass — "Grok Build" / "Claude
// Design" / "OpenAI Codex" / "Agent View" / "Model Context". Lab names are
// explicitly excluded from FIRST_WORD_REJECT_AUX for this reason.

describe("ISC-410: isDistinctiveEntity first-word reject", () => {
  it("rejects 'Starting June 15' — gerund-adverb lead", () => {
    expect(isDistinctiveEntity("Starting June 15")).toBe(false);
  });
  it("rejects 'Coming Soon' — gerund-adverb lead", () => {
    expect(isDistinctiveEntity("Coming Soon")).toBe(false);
  });
  it("rejects 'Going Public' — gerund-adverb lead", () => {
    expect(isDistinctiveEntity("Going Public")).toBe(false);
  });
  it("rejects 'Is Claude' — be-verb lead", () => {
    expect(isDistinctiveEntity("Is Claude")).toBe(false);
  });
  it("rejects 'The Best' — article lead", () => {
    expect(isDistinctiveEntity("The Best")).toBe(false);
  });
  it("rejects 'This Week' — wh-word lead", () => {
    expect(isDistinctiveEntity("This Week")).toBe(false);
  });
  it("rejects 'For Developers' — preposition lead", () => {
    expect(isDistinctiveEntity("For Developers")).toBe(false);
  });
  it("preserves 'Reading Comprehension' — 'reading' is not a stopword/adverb/gerund", () => {
    expect(isDistinctiveEntity("Reading Comprehension")).toBe(true);
  });
  it("preserves 'Grok Build' — lab name lead", () => {
    expect(isDistinctiveEntity("Grok Build")).toBe(true);
  });
  it("preserves 'Claude Design' — lab name lead", () => {
    expect(isDistinctiveEntity("Claude Design")).toBe(true);
  });
  it("preserves 'OpenAI Codex' — lab name lead", () => {
    expect(isDistinctiveEntity("OpenAI Codex")).toBe(true);
  });
  it("preserves 'Agent View' — product family lead", () => {
    expect(isDistinctiveEntity("Agent View")).toBe(true);
  });
  it("preserves 'Model Context' — product family lead", () => {
    expect(isDistinctiveEntity("Model Context")).toBe(true);
  });
  it("preserves 'Opus 4.7' — versioned model name (single token after norm)", () => {
    expect(isDistinctiveEntity("Opus 4.7")).toBe(true);
  });
});

describe("ISC-410: extractEntities integration", () => {
  it("Agent-SDK June-15 post — extractEntities returns [] (was ['Starting June 15'])", () => {
    expect(extractEntities("@ClaudeDevs: Starting June 15, paid Claude plans...")).toEqual([]);
  });
  it("Coming Soon post — no anchor extracted", () => {
    expect(extractEntities("Coming Soon to xAI")).toEqual([]);
  });
  it("Reading Comprehension benchmark — anchor preserved", () => {
    expect(extractEntities("Reading Comprehension benchmark")).toEqual(["Reading Comprehension"]);
  });
  it("Just-released-Opus-4.7 — versioned model still captured", () => {
    expect(extractEntities("Just released Opus 4.7")).toEqual(["Opus 4.7"]);
  });
  it("slash-command anchor — '/goal' still captured regardless of title prefix", () => {
    expect(extractEntities("Today launches /goal command")).toEqual(["/goal"]);
  });
  it("lab-name + product two-word — 'Grok Build' anchor preserved", () => {
    expect(extractEntities("xai @xai: An early beta of Grok Build, an agentic CLI...")).toContain("Grok Build");
  });
});

// ISC-418 / ISC-419 / D-WALK-20 (iter-31) — Notable platform-balance rebalance.
// Iter-29 close defect: top-12 Notable panel dominated by viral TT creators;
// X-platform high-signal posts (karpathy 49k, agentic.james 9.8k, simonw 776)
// never reached top-12 visible because pure engagement-desc sort is platform-
// blind. Fix is two-pass: pass 1 caps per author AND per platform; pass 2
// backfills remaining slots respecting only per-author cap (so platform-
// starved cycles still hit NOTABLE_MAX_EMIT). Anti-corner-case: when
// distinct_authors_in_pool < maxEmit, output length is exactly that count —
// emitting the same author twice would re-introduce the defect.

describe("ISC-418: rebalanceNotableOrphans cap-1-per-author + cap-per-platform", () => {
  it("caps a single author to 1 even with many high-engagement posts", () => {
    const orphans: Orphan[] = Array.from({ length: 10 }, (_, i) =>
      mkOrphan("tiktok", "rileybrown.ai", 400_000 - i, i),
    );
    const out = rebalanceNotableOrphans(orphans, 30, 8);
    expect(out.length).toBe(1);
    expect(out[0]?.engagement).toBe(400_000);
  });

  it("respects per-platform cap in pass 1 — TT 23 distinct authors, cap 8 → 8 TT", () => {
    const tt: Orphan[] = Array.from({ length: 23 }, (_, i) =>
      mkOrphan("tiktok", `tt-author-${i}`, 100_000 - i * 1000, i),
    );
    const x: Orphan[] = Array.from({ length: 7 }, (_, i) =>
      mkOrphan("x", `x-author-${i}`, 50_000 - i * 1000, i),
    );
    const out = rebalanceNotableOrphans([...tt, ...x], 30, 8);
    const ttCount = out.filter((o) => o.source === "tiktok").length;
    const xCount = out.filter((o) => o.source === "x").length;
    // Pass 1: 8 TT + 7 X = 15. Pass 2 backfills 15 remaining TT (no per-platform
    // cap in pass 2), respecting cap-1-per-author → another 15 distinct TT
    // authors. Total: 23 TT + 7 X = 30.
    expect(out.length).toBe(30);
    expect(ttCount).toBe(23);
    expect(xCount).toBe(7);
  });

  it("backfill fires when initial cap leaves slots open", () => {
    // 5 TT authors only; pass 1 takes all 5 (under cap). 0 backfill needed.
    const orphans: Orphan[] = Array.from({ length: 5 }, (_, i) =>
      mkOrphan("tiktok", `tt-author-${i}`, 100_000 - i * 1000, i),
    );
    const out = rebalanceNotableOrphans(orphans, 30, 8);
    expect(out.length).toBe(5);
  });

  it("output respects engagement order within author/platform constraints", () => {
    const orphans: Orphan[] = [
      mkOrphan("x", "karpathy", 49_000, 0),
      mkOrphan("tiktok", "rileybrown.ai", 396_000, 0),
      mkOrphan("x", "simonw", 776, 0),
      mkOrphan("tiktok", "rileybrown.ai", 395_000, 1), // dropped — author dup
      mkOrphan("x", "AnthropicAI", 45_000, 0),
      mkOrphan("tiktok", "brandnat", 302_000, 0),
    ];
    const out = rebalanceNotableOrphans(orphans, 30, 8);
    // Cap-1-per-author drops rileybrown.ai's second post. Remaining 5 distinct.
    expect(out.length).toBe(5);
    // Sorted by engagement desc: rileybrown.ai 396k, brandnat 302k, karpathy 49k,
    // AnthropicAI 45k, simonw 776.
    expect(out.map((o) => o.engagement)).toEqual([396_000, 302_000, 49_000, 45_000, 776]);
  });

  it("empty author is skipped (anti — would create false dedupe key)", () => {
    const orphans: Orphan[] = [
      mkOrphan("x", "", 100_000, 0),
      mkOrphan("x", "karpathy", 49_000, 0),
    ];
    const out = rebalanceNotableOrphans(orphans, 30, 8);
    expect(out.length).toBe(1);
    expect(out[0]?.author).toBe("karpathy");
  });
});

