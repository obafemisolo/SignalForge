import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from "./http-client.js";
import { readLimitedBody, SafeHttpClient } from "./http-client.js";
import { RequestLimiter } from "./limiter.js";

const signal = new AbortController().signal;

function response(
  statusCode: number,
  headers: Record<string, string>,
  chunks: string[] = [],
): TransportResponse {
  return {
    statusCode,
    headers,
    body: Readable.from(chunks),
    discard: vi.fn(),
  };
}

function client(
  transport: HttpTransport,
  resolutions: Record<string, string>,
  maxRedirects = 3,
): SafeHttpClient {
  return new SafeHttpClient(
    {
      userAgent: "SignalForgeBot/0.1 tests",
      maxBodyBytes: 100,
      maxRedirects,
      connectionTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    },
    {
      resolve: async (hostname) => [
        { address: resolutions[hostname] ?? "93.184.216.34", family: 4 },
      ],
    },
    new RequestLimiter(2, 1, 0),
    transport,
  );
}

describe("safe HTTP client", () => {
  it("revalidates a redirect before issuing its next request", async () => {
    const request = vi.fn(async (input: TransportRequest) =>
      input.url.includes("example.com")
        ? response(302, { location: "http://internal.test/private" })
        : response(200, { "content-type": "text/html" }, ["not reached"]),
    );

    await expect(
      client(
        { request },
        { "example.com": "93.184.216.34", "internal.test": "127.0.0.1" },
      ).get("https://example.com/start", { signal }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS_BLOCKED" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect count", async () => {
    const transport = {
      request: async (input: TransportRequest) =>
        response(302, { location: `${input.url}/again` }),
    };
    await expect(
      client(transport, {}, 1).get("https://example.com", { signal }),
    ).rejects.toMatchObject({ code: "REDIRECT_LIMIT_EXCEEDED" });
  });

  it("stops streaming when the response body exceeds its limit", async () => {
    await expect(
      readLimitedBody(Readable.from(["1234", "5678"]), 7),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE", retryable: false });
  });

  it("discards an oversized response stream", async () => {
    const oversized = response(200, { "content-type": "text/plain" }, [
      "1".repeat(60),
      "2".repeat(60),
    ]);
    await expect(
      client({ request: async () => oversized }, {}).get(
        "https://example.com",
        { signal },
      ),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(oversized.discard).toHaveBeenCalledOnce();
  });

  it("rejects file-like content types", async () => {
    await expect(
      client(
        {
          request: async () =>
            response(200, { "content-type": "application/pdf" }, ["%PDF"]),
        },
        {},
      ).get("https://example.com/report.pdf", { signal }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_TYPE" });
  });
});
