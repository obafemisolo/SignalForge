import { describe, expect, it } from "vitest";

import {
  PublicUrlError,
  compileExtractionSchema,
  normalizePublicSourceUrl,
} from "./service.js";

describe("research job service helpers", () => {
  it("compiles the submitted field contract into valid JSON Schema", () => {
    expect(
      compileExtractionSchema("companySignal", ["company", "role"]),
    ).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "companySignal",
      type: "object",
      properties: { company: {}, role: {} },
      required: ["company", "role"],
      additionalProperties: false,
    });
  });

  it("normalizes public URLs without fragments", () => {
    expect(
      normalizePublicSourceUrl("https://EXAMPLE.com/jobs?b=2&a=1#roles"),
    ).toEqual({
      sourceUrl: "https://EXAMPLE.com/jobs?b=2&a=1#roles",
      normalizedUrl: "https://example.com/jobs?a=1&b=2",
      domain: "example.com",
    });
  });

  it.each([
    "http://localhost/jobs",
    "http://127.0.0.1/jobs",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/jobs",
  ])("rejects a non-public destination: %s", (url) => {
    expect(() => normalizePublicSourceUrl(url)).toThrow(PublicUrlError);
  });
});
