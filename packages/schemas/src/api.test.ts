import { describe, expect, it } from "vitest";

import {
  createResearchJobRequestSchema,
  idempotencyHeadersSchema,
  resultsPaginationQuerySchema,
} from "./api.js";

describe("API schemas", () => {
  it("parses and trims a valid creation request", () => {
    const result = createResearchJobRequestSchema(2).parse({
      query: "  Find hiring signals  ",
      sources: ["https://example.com/jobs"],
      schema: {
        type: "companyHiringSignal",
        fields: [
          "company",
          "website",
          "role",
          "location",
          "signal",
          "sourceUrl",
          "evidence",
        ],
      },
    });

    expect(result.query).toBe("Find hiring signals");
  });

  it("rejects more than the configured maximum number of sources", () => {
    const result = createResearchJobRequestSchema(1).safeParse({
      query: "Find hiring signals",
      sources: ["https://example.com/a", "https://example.com/b"],
      schema: {
        type: "companyHiringSignal",
        fields: [
          "company",
          "website",
          "role",
          "location",
          "signal",
          "sourceUrl",
          "evidence",
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("coerces query-string pagination and applies defaults", () => {
    expect(resultsPaginationQuerySchema.parse({ page: "2" })).toEqual({
      page: 2,
      limit: 20,
    });
  });

  it("validates the optional Idempotency-Key header", () => {
    expect(
      idempotencyHeadersSchema.parse({ "idempotency-key": "research_123" }),
    ).toMatchObject({ "idempotency-key": "research_123" });
    expect(
      idempotencyHeadersSchema.safeParse({ "idempotency-key": "bad key" })
        .success,
    ).toBe(false);
  });
});
