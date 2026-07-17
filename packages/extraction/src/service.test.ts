import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { TransportRequest, TransportResponse } from "./http-client.js";
import { SafeHttpClient } from "./http-client.js";
import { RequestLimiter } from "./limiter.js";
import { RobotsPolicy } from "./robots.js";
import { ControlledWebExtractor } from "./service.js";
import type { ExtractionConfiguration, HtmlRenderer } from "./types.js";

const configuration: ExtractionConfiguration = {
  userAgent: "SignalForgeBot/0.1 tests",
  maxBodyBytes: 100_000,
  maxRedirects: 3,
  connectionTimeoutMs: 100,
  totalTimeoutMs: 1_000,
  globalConcurrency: 2,
  domainConcurrency: 1,
  domainDelayMs: 0,
  minimumContentCharacters: 100,
  playwrightEnabled: true,
};

function transportResponse(
  statusCode: number,
  contentType: string,
  body: string,
): TransportResponse {
  return {
    statusCode,
    headers: { "content-type": contentType },
    body: Readable.from([body]),
    discard: vi.fn(),
  };
}

function extractor(
  sourceHtml: string,
  robotsBody: string,
  renderer: HtmlRenderer,
): ControlledWebExtractor {
  const limiter = new RequestLimiter(2, 1, 0);
  const client = new SafeHttpClient(
    configuration,
    {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    },
    limiter,
    {
      request: async (input: TransportRequest) =>
        input.url.endsWith("/robots.txt")
          ? transportResponse(200, "text/plain", robotsBody)
          : transportResponse(200, "text/html", sourceHtml),
    },
  );
  return new ControlledWebExtractor(
    configuration,
    client,
    new RobotsPolicy(client, limiter, configuration.userAgent),
    renderer,
  );
}

describe("controlled web extraction service", () => {
  it("uses static HTML first and produces a stable content hash", async () => {
    const article = await fixture();
    const renderer = {
      render: vi.fn(async () => article),
      close: vi.fn(async () => undefined),
    };
    const result = await extractor(
      article,
      "User-agent: *\nAllow: /",
      renderer,
    ).extract("https://example.com/article", new AbortController().signal);

    expect(result.fetchMode).toBe("HTTP");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.canonicalUrl).toBe("https://example.com/research/fixture");
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("honors robots.txt without requesting the source page", async () => {
    const renderer = {
      render: vi.fn(async (html: string) => html),
      close: vi.fn(async () => undefined),
    };
    await expect(
      extractor(
        "<main>content</main>",
        "User-agent: *\nDisallow: /private",
        renderer,
      ).extract(
        "https://example.com/private/report",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "ROBOTS_DISALLOWED",
      retryable: false,
      fetchStatus: "SKIPPED",
    });
  });

  it("falls back to network-blocked Playwright rendering for a thin shell", async () => {
    const article = await fixture();
    const renderer = {
      render: vi.fn(async () => article),
      close: vi.fn(async () => undefined),
    };
    const result = await extractor(
      "<html><body><main>Loading</main></body></html>",
      "User-agent: *\nAllow: /",
      renderer,
    ).extract("https://example.com/shell", new AbortController().signal);

    expect(result.fetchMode).toBe("PLAYWRIGHT");
    expect(result.text).toContain("Backend engineering signals");
    expect(renderer.render).toHaveBeenCalledOnce();
  });
});

async function fixture(): Promise<string> {
  return readFile(
    new URL("../test/fixtures/article.html", import.meta.url),
    "utf8",
  );
}
