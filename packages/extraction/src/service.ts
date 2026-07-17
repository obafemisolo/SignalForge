import { createHash } from "node:crypto";

import { ExtractionError, toExtractionError } from "./errors.js";
import { parseHtml, isMeaningfulContent, normalizeReadableText } from "./html.js";
import { NodeHttpTransport, SafeHttpClient } from "./http-client.js";
import { RequestLimiter } from "./limiter.js";
import { PlaywrightHtmlRenderer } from "./playwright-renderer.js";
import { RobotsPolicy } from "./robots.js";
import { normalizeSourceUrl, SystemDnsResolver } from "./url-policy.js";
import type {
  ExtractionConfiguration,
  ExtractionResult,
  HtmlRenderer,
} from "./types.js";

export class ControlledWebExtractor {
  public constructor(
    private readonly configuration: ExtractionConfiguration,
    private readonly client: SafeHttpClient,
    private readonly robots: RobotsPolicy,
    private readonly renderer: HtmlRenderer,
  ) {}

  public async extract(
    sourceUrl: string,
    signal: AbortSignal,
  ): Promise<ExtractionResult> {
    const startedAt = Date.now();
    let mode = "HTTP" as const;
    try {
      const normalizedUrl = normalizeSourceUrl(sourceUrl);
      await this.robots.assertAllowed(normalizedUrl, signal);
      const response = await this.client.get(normalizedUrl, { signal });
      assertSuccessfulStatus(response.statusCode);

      let parsed =
        response.contentType === "text/html"
          ? parseHtml(response.body.toString("utf8"), response.finalUrl)
          : {
              text: normalizeReadableText(response.body.toString("utf8")),
              metadata: {},
              outboundLinks: [],
              accessRestricted: false,
            };
      if (parsed.accessRestricted) {
        throw new ExtractionError(
          "ACCESS_RESTRICTED",
          "The page appears to require authentication or human verification",
          {
            retryable: false,
            httpStatus: response.statusCode,
            fetchStatus: "BLOCKED",
          },
        );
      }

      if (
        response.contentType === "text/html" &&
        !isMeaningfulContent(
          parsed.text,
          this.configuration.minimumContentCharacters,
        ) &&
        this.configuration.playwrightEnabled
      ) {
        mode = "PLAYWRIGHT";
        const rendered = await this.renderer.render(
          response.body.toString("utf8"),
          response.finalUrl,
          signal,
        );
        parsed = parseHtml(rendered, response.finalUrl);
      }
      if (
        !isMeaningfulContent(
          parsed.text,
          this.configuration.minimumContentCharacters,
        )
      ) {
        throw new ExtractionError(
          parsed.text === "" ? "EMPTY_CONTENT" : "INSUFFICIENT_CONTENT",
          "The page did not contain enough meaningful readable content",
          { retryable: false, httpStatus: response.statusCode },
        );
      }

      return {
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        ...(parsed.canonicalUrl === undefined
          ? {}
          : { canonicalUrl: parsed.canonicalUrl }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        text: parsed.text,
        metadata: parsed.metadata,
        outboundLinks: parsed.outboundLinks,
        contentHash: createHash("sha256").update(parsed.text).digest("hex"),
        httpStatus: response.statusCode,
        fetchMode: mode,
        fetchDurationMs: Date.now() - startedAt,
      };
    } catch (error: unknown) {
      throw toExtractionError(error).withTelemetry(Date.now() - startedAt, mode);
    }
  }

  public close(): Promise<void> {
    return this.renderer.close();
  }
}

export function createControlledWebExtractor(
  configuration: ExtractionConfiguration,
): ControlledWebExtractor {
  const limiter = new RequestLimiter(
    configuration.globalConcurrency,
    configuration.domainConcurrency,
    configuration.domainDelayMs,
  );
  const client = new SafeHttpClient(
    configuration,
    new SystemDnsResolver(),
    limiter,
    new NodeHttpTransport(),
  );
  const renderer = new PlaywrightHtmlRenderer(
    configuration.userAgent,
    configuration.totalTimeoutMs,
  );
  return new ControlledWebExtractor(
    configuration,
    client,
    new RobotsPolicy(client, limiter, configuration.userAgent),
    renderer,
  );
}

function assertSuccessfulStatus(status: number): void {
  if (status >= 200 && status < 300) {
    return;
  }
  const common = { httpStatus: status } as const;
  if (status === 408) {
    throw new ExtractionError("REQUEST_TIMEOUT", "Source returned HTTP 408", {
      retryable: true,
      ...common,
    });
  }
  if (status === 429) {
    throw new ExtractionError("RATE_LIMITED", "Source returned HTTP 429", {
      retryable: true,
      ...common,
    });
  }
  if (status >= 500) {
    throw new ExtractionError(
      "HTTP_SERVER_ERROR",
      `Source returned HTTP ${status}`,
      { retryable: true, ...common },
    );
  }
  const restricted = status === 401 || status === 403;
  throw new ExtractionError(
    restricted ? "ACCESS_RESTRICTED" : "HTTP_CLIENT_ERROR",
    `Source returned HTTP ${status}`,
    {
      retryable: false,
      ...common,
      ...(restricted ? { fetchStatus: "BLOCKED" as const } : {}),
    },
  );
}
