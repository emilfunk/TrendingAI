import { describe, expect, test } from "bun:test";
import { parseReasoningRow, parseReasoningFile, clusterCard } from "./render-features-demo.ts";

const validRow = {
  cluster_id: "c1",
  rank: 1,
  topic_claim: "Anthropic ships /goal continuous-execution feature in Claude Code",
  citations: [
    { url: "https://x.com/anthropicai/status/123", source: "x", snippet: "we shipped /goal" },
    { url: "https://x.com/claudedevs/status/456", source: "x", snippet: "how /goal works" },
  ],
  confidence: "HIGH",
  reason: "two ClaudeDevs posts plus the AnthropicAI announcement",
};

describe("parseReasoningRow boundary schema", () => {
  test("happy row parses", () => {
    expect(parseReasoningRow(validRow)).not.toBeNull();
  });

  test("missing cluster_id → null", () => {
    const { cluster_id: _, ...broken } = validRow;
    expect(parseReasoningRow(broken)).toBeNull();
  });

  test("non-LOW/MEDIUM/HIGH confidence → null", () => {
    expect(parseReasoningRow({ ...validRow, confidence: "SUPER" })).toBeNull();
  });

  test("missing citations.url → row rejected", () => {
    expect(parseReasoningRow({ ...validRow, citations: [{ source: "x", snippet: "missing url" }] })).toBeNull();
  });

  test("empty topic_claim is ALLOWED (cluster #11 timeout shape)", () => {
    const empty = { ...validRow, topic_claim: "", confidence: "LOW", reason: "error_class=timeout: Timeout after 60000ms" };
    expect(parseReasoningRow(empty)).not.toBeNull();
  });

  test("non-string topic_claim → null", () => {
    expect(parseReasoningRow({ ...validRow, topic_claim: null })).toBeNull();
  });
});

describe("parseReasoningFile aggregates", () => {
  test("mixed valid + invalid rows: valid pass, invalid counted as rejected", () => {
    const file = [validRow, { not: "a row" }, { ...validRow, confidence: "NOPE" }, validRow];
    const { ok, rejected } = parseReasoningFile(file);
    expect(ok.length).toBe(2);
    expect(rejected).toBe(2);
  });

  test("non-array input → empty ok + 0 rejected", () => {
    const { ok, rejected } = parseReasoningFile({ not: "an array" });
    expect(ok).toEqual([]);
    expect(rejected).toBe(0);
  });
});

const sources = { x: [], tiktok: [], instagram: [], youtube: [] };

describe("clusterCard render", () => {
  test("renders topic_claim as headline", () => {
    const html = clusterCard(parseReasoningRow(validRow)!, sources);
    expect(html).toContain("Anthropic ships /goal");
    expect(html).toContain("HIGH");
    expect(html).toContain("#1");
  });

  test("empty topic_claim renders REASONING UNAVAILABLE card (Advisor concern c)", () => {
    const empty = {
      cluster_id: "c11",
      rank: 11,
      topic_claim: "",
      citations: [],
      confidence: "LOW" as const,
      reason: "error_class=timeout: Timeout after 60000ms",
    };
    const html = clusterCard(empty, sources);
    expect(html).toContain("REASONING UNAVAILABLE");
    expect(html).toContain("cluster-unavailable");
    expect(html).toContain("#11");
    expect(html).toContain("error_class=timeout");
  });

  test("topic_claim is HTML-escaped (XSS-safe)", () => {
    const hostile = parseReasoningRow({ ...validRow, topic_claim: "<script>alert('x')</script>" })!;
    const html = clusterCard(hostile, sources);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("citations route by source: x→tweetEmbed, youtube→thumbCard, unknown→genericEmbed", () => {
    const multi = parseReasoningRow({
      ...validRow,
      citations: [
        { url: "https://x.com/a/1", source: "x", snippet: "x post" },
        { url: "https://www.youtube.com/watch?v=abcd1234", source: "youtube", snippet: "yt vid" },
        { url: "https://substack.com/p/1", source: "substack", snippet: "ss post" },
      ],
    })!;
    const html = clusterCard(multi, sources);
    expect(html).toContain('class="twitter-tweet"');
    expect(html).toContain("img.youtube.com/vi/abcd1234/hqdefault.jpg");
    expect(html).toContain('src-other');
    expect(html).toContain("substack");
  });

  test("zero citations renders honest empty-evidence message — never silent", () => {
    const noCites = parseReasoningRow({ ...validRow, citations: [], confidence: "MEDIUM" })!;
    const html = clusterCard(noCites, sources);
    expect(html).toContain("No citations produced");
  });
});
