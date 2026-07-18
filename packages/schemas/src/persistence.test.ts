import { describe, expect, it } from "vitest";

import {
  evidenceItemSchema,
  extractedRecordCreateInputSchema,
  researchJobCreateInputSchema,
} from "./persistence.js";

describe("persistence schemas", () => {
  it("accepts a bounded research job request", () => {
    const result = researchJobCreateInputSchema.parse({
      query: "  Compare the supplied public sources.  ",
      requestedSources: ["https://example.com/"],
      extractionSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    });

    expect(result.query).toBe("Compare the supplied public sources.");
  });

  it("rejects duplicate requested source URLs", () => {
    expect(() =>
      researchJobCreateInputSchema.parse({
        query: "Research the source",
        requestedSources: ["https://example.com/", "https://example.com/"],
        extractionSchema: { type: "object" },
      }),
    ).toThrow("requestedSources must not contain duplicates");
  });

  it("requires complete, ordered evidence offsets", () => {
    expect(() =>
      evidenceItemSchema.parse({
        quote: "supporting text",
        startOffset: 10,
      }),
    ).toThrow("startOffset and endOffset must be provided together");

    expect(() =>
      evidenceItemSchema.parse({
        quote: "supporting text",
        startOffset: 20,
        endOffset: 10,
      }),
    ).toThrow("startOffset and endOffset must be provided together");
  });

  it("requires at least one source attribution for an extracted record", () => {
    const result = extractedRecordCreateInputSchema.safeParse({
      researchJobId: "00000000-0000-4000-8000-000000000001",
      sourceDocumentId: "00000000-0000-4000-8000-000000000002",
      recordType: "project",
      structuredData: { name: "SignalForge" },
      evidence: [{ quote: "SignalForge" }],
      confidenceScore: 0.9,
      relevanceScore: 0.9,
      deduplicationKey: "project:signalforge",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["sourceAttributions"] }),
        ]),
      );
    }
  });
});
