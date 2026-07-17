import { describe, expect, it, vi } from "vitest";

import {
  normalizeCompanyName,
  normalizeHiringSignal,
  normalizeRoleName,
  normalizeUrl,
  processHiringSignals,
  scoreHiringSignal,
  type HiringSignalValue,
} from "./index.js";

const source = {
  sourceDocumentId: "69dbaa4d-64b8-4991-9314-2a8074b93fd8",
  sourceUrl: "https://jobs.acme.example/backend",
  publishedAt: new Date("2026-07-01T00:00:00.000Z"),
  credibilityScore: 0.85,
};
const now = new Date("2026-07-17T00:00:00.000Z");

function signal(overrides: Partial<HiringSignalValue> = {}): HiringSignalValue {
  return {
    company: "Acme Technologies Ltd.",
    website: "https://ACME.example/",
    role: "Senior Back End Developer",
    location: " Lagos, Nigeria ",
    signal: "Acme is hiring a senior backend engineer.",
    sourceUrl: "https://jobs.acme.example/backend?utm_source=test",
    evidence: "Acme is hiring a Senior Backend Engineer in Lagos.",
    confidenceScore: 0.9,
    ...overrides,
  };
}

describe("record normalization", () => {
  it("normalizes matching values while retaining original variants", () => {
    expect(normalizeCompanyName("  ACME, Ltd. ")).toBe("acme");
    expect(normalizeRoleName("Sr. Back End Developer")).toBe(
      "senior backend engineer",
    );
    expect(
      normalizeUrl("https://EXAMPLE.com/jobs?utm_source=x&b=2&a=1#description"),
    ).toBe("https://example.com/jobs?a=1&b=2");

    const normalized = normalizeHiringSignal(signal());
    expect(normalized).toMatchObject({
      company: "acme technologies",
      role: "senior backend engineer",
      domain: "acme.example",
      location: "lagos nigeria",
      originalVariants: {
        companies: ["Acme Technologies Ltd."],
        roles: ["Senior Back End Developer"],
      },
    });
  });
});

describe("deterministic deduplication", () => {
  it("merges exact duplicates and keeps unique evidence", async () => {
    const result = await processHiringSignals(
      [
        signal(),
        signal({
          evidence:
            "Apply now for Acme's Senior Backend Engineer opening in Lagos.",
          confidenceScore: 0.8,
        }),
      ],
      "Find companies hiring backend engineers in Lagos",
      source,
      { now },
    );

    expect(result.duplicatesRemoved).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.attributions[0]?.evidence).toHaveLength(2);
    expect(result.records[0]?.confidenceScore).toBe(0.9);
  });

  it("merges near duplicates using deterministic normalized signal overlap", async () => {
    const result = await processHiringSignals(
      [
        signal(),
        signal({
          sourceUrl: "https://jobs.acme.example/openings/123",
          signal: "Acme is hiring a senior backend engineer now.",
        }),
      ],
      "backend engineer hiring",
      source,
      { now },
    );

    expect(result.records).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("preserves and flags conflicting records instead of discarding them", async () => {
    const result = await processHiringSignals(
      [
        signal(),
        signal({
          location: "Abuja, Nigeria",
          evidence: "Acme is hiring a Senior Backend Engineer in Abuja.",
        }),
      ],
      "backend engineer hiring",
      source,
      { now },
    );

    expect(result.records).toHaveLength(2);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.conflictsDetected).toBe(1);
    expect(result.records.every((record) => record.reviewRequired)).toBe(true);
    expect(result.records.flatMap((record) => record.conflicts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LOCATION_MISMATCH" }),
      ]),
    );
  });

  it("does not invoke optional semantic matching when it is disabled", async () => {
    const similarity = vi.fn(async () => 1);
    const result = await processHiringSignals(
      [
        signal(),
        signal({
          company: "Different Company",
          website: "https://different.example",
        }),
      ],
      "backend engineer hiring",
      source,
      { now, semanticMatcher: { similarity } },
    );

    expect(result.records).toHaveLength(2);
    expect(result.semanticMatchingUsed).toBe(false);
    expect(similarity).not.toHaveBeenCalled();
  });
});

describe("relevance scoring", () => {
  it("returns a repeatable 0-1 score with an explanation for every component", async () => {
    const processed = await processHiringSignals(
      [signal()],
      "Find Acme backend engineer hiring in Lagos",
      source,
      { now },
    );
    const record = processed.records[0];
    if (record === undefined) {
      throw new Error("Expected one processed record");
    }

    const first = scoreHiringSignal(record, "Acme backend engineer Lagos", now);
    const second = scoreHiringSignal(
      record,
      "Acme backend engineer Lagos",
      now,
    );

    expect(first).toEqual(second);
    expect(first.total).toBeGreaterThanOrEqual(0);
    expect(first.total).toBeLessThanOrEqual(1);
    expect(Object.keys(first.components)).toHaveLength(6);
    expect(first.components.queryKeywordOverlap.reason).toContain(
      "query keywords matched",
    );
    expect(first.components.sourceCredibility.score).toBe(0.85);
  });
});
