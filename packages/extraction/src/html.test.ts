import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseHtml } from "./html.js";

describe("static content extraction", () => {
  it("extracts main text, attribution metadata, and safe outbound links", async () => {
    const html = await readFile(
      new URL("../test/fixtures/article.html", import.meta.url),
      "utf8",
    );
    const result = parseHtml(html, "https://example.com/source");

    expect(result.title).toBe("SignalForge Fixture Article");
    expect(result.canonicalUrl).toBe("https://example.com/research/fixture");
    expect(result.metadata).toMatchObject({
      description: "A deterministic extraction fixture.",
      language: "en",
      publishedAt: "2026-07-18T08:00:00Z",
    });
    expect(result.text).toContain("Backend engineering signals");
    expect(result.text).not.toMatch(/cookies|site header|script text/iu);
    expect(result.text.match(/Repeated footer phrase/gu)).toHaveLength(1);
    expect(result.outboundLinks).toEqual(["https://example.com/jobs/backend"]);
  });
});
