import { createRequire } from "node:module";

import { ExtractionError } from "./errors.js";
import type { SafeHttpClient } from "./http-client.js";
import type { RequestLimiter } from "./limiter.js";

interface CachedRobots {
  body?: string;
  expiresAt: number;
  lastUsedAt: number;
}

interface RobotsParser {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as (
  url: string,
  body: string,
) => RobotsParser;

export class RobotsPolicy {
  private readonly cache = new Map<string, CachedRobots>();

  public constructor(
    private readonly client: SafeHttpClient,
    private readonly limiter: RequestLimiter,
    private readonly userAgent: string,
    private readonly cacheTtlMs = 300_000,
    private readonly maxCacheEntries = 1_024,
  ) {}

  public async assertAllowed(
    sourceUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    const target = new URL(sourceUrl);
    const origin = target.origin;
    let cached = this.cache.get(origin);
    if (cached === undefined || cached.expiresAt <= Date.now()) {
      cached = await this.load(origin, signal);
      this.evictIfNeeded();
      this.cache.set(origin, cached);
    } else {
      cached.lastUsedAt = Date.now();
    }
    if (cached.body === undefined) {
      return;
    }

    const parser = robotsParser(`${origin}/robots.txt`, cached.body);
    if (parser.isAllowed(sourceUrl, this.userAgent) === false) {
      throw new ExtractionError(
        "ROBOTS_DISALLOWED",
        "robots.txt does not permit SignalForge to fetch this URL",
        { retryable: false, fetchStatus: "SKIPPED" },
      );
    }
    const crawlDelay = parser.getCrawlDelay(this.userAgent);
    if (typeof crawlDelay === "number" && Number.isFinite(crawlDelay)) {
      this.limiter.setMinimumDomainDelay(
        target.hostname,
        Math.max(0, crawlDelay * 1_000),
      );
    }
  }

  private async load(
    origin: string,
    signal: AbortSignal,
  ): Promise<CachedRobots> {
    try {
      const response = await this.client.get(`${origin}/robots.txt`, {
        signal,
        maxBodyBytes: 500_000,
        acceptedContentTypes: ["text/plain", "text/html"],
      });
      const status = response.statusCode;
      if (status >= 200 && status < 300) {
        return {
          body: response.body.toString("utf8"),
          expiresAt: Date.now() + this.cacheTtlMs,
          lastUsedAt: Date.now(),
        };
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return {
          expiresAt: Date.now() + this.cacheTtlMs,
          lastUsedAt: Date.now(),
        };
      }
      throw robotsUnavailable(status);
    } catch (error: unknown) {
      if (error instanceof ExtractionError) {
        if (!error.retryable) {
          throw error;
        }
        throw new ExtractionError(
          "ROBOTS_UNREACHABLE",
          "robots.txt could not be reached safely",
          {
            retryable: true,
            ...(error.httpStatus === undefined
              ? {}
              : { httpStatus: error.httpStatus }),
            cause: error,
          },
        );
      }
      throw new ExtractionError(
        "ROBOTS_UNREACHABLE",
        "robots.txt could not be reached",
        { retryable: true, cause: error },
      );
    }
  }

  private evictIfNeeded(): void {
    if (this.cache.size < this.maxCacheEntries) {
      return;
    }
    const now = Date.now();
    for (const [origin, cached] of this.cache) {
      if (cached.expiresAt <= now) {
        this.cache.delete(origin);
      }
    }
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = [...this.cache.entries()].sort(
        ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
      )[0];
      if (oldest === undefined) {
        return;
      }
      this.cache.delete(oldest[0]);
    }
  }
}

function robotsUnavailable(status: number): ExtractionError {
  return new ExtractionError(
    status === 429 ? "RATE_LIMITED" : "ROBOTS_UNREACHABLE",
    `robots.txt returned HTTP ${status}`,
    { retryable: true, httpStatus: status },
  );
}
