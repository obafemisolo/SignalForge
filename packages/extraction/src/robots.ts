import robotsParser from "robots-parser";

import { ExtractionError } from "./errors.js";
import { SafeHttpClient } from "./http-client.js";
import { RequestLimiter } from "./limiter.js";

interface CachedRobots {
  body?: string;
  expiresAt: number;
}

export class RobotsPolicy {
  private readonly cache = new Map<string, CachedRobots>();

  public constructor(
    private readonly client: SafeHttpClient,
    private readonly limiter: RequestLimiter,
    private readonly userAgent: string,
    private readonly cacheTtlMs = 300_000,
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
      this.cache.set(origin, cached);
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
        };
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return { expiresAt: Date.now() + this.cacheTtlMs };
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
}

function robotsUnavailable(status: number): ExtractionError {
  return new ExtractionError(
    status === 429 ? "RATE_LIMITED" : "ROBOTS_UNREACHABLE",
    `robots.txt returned HTTP ${status}`,
    { retryable: true, httpStatus: status },
  );
}
