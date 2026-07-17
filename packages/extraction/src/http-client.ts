import http, { type RequestOptions } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

import { ExtractionError, toExtractionError } from "./errors.js";
import type { RequestLimiter } from "./limiter.js";
import { normalizeSourceUrl, resolvePublicAddresses } from "./url-policy.js";
import type { DnsResolver, ResolvedAddress } from "./types.js";

export interface TransportRequest {
  url: string;
  addresses: ResolvedAddress[];
  headers: Readonly<Record<string, string>>;
  connectionTimeoutMs: number;
  signal: AbortSignal;
}

export interface TransportResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  discard(): void;
}

export interface HttpTransport {
  request(input: TransportRequest): Promise<TransportResponse>;
}

export interface SafeHttpClientConfiguration {
  userAgent: string;
  maxBodyBytes: number;
  maxRedirects: number;
  connectionTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface SafeHttpResponse {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  headers: Readonly<Record<string, string | undefined>>;
  contentType?: string;
  body: Buffer;
  redirectCount: number;
  durationMs: number;
}

export interface SafeHttpRequestOptions {
  signal: AbortSignal;
  maxBodyBytes?: number;
  acceptedContentTypes?: readonly string[];
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class SafeHttpClient {
  public constructor(
    private readonly configuration: SafeHttpClientConfiguration,
    private readonly resolver: DnsResolver,
    private readonly limiter: RequestLimiter,
    private readonly transport: HttpTransport = new NodeHttpTransport(),
  ) {}

  public async get(
    sourceUrl: string,
    options: SafeHttpRequestOptions,
  ): Promise<SafeHttpResponse> {
    const startedAt = Date.now();
    const requestedUrl = normalizeSourceUrl(sourceUrl);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(
        new ExtractionError(
          "REQUEST_TIMEOUT",
          `Request exceeded ${this.configuration.totalTimeoutMs}ms`,
          { retryable: true },
        ),
      );
    }, this.configuration.totalTimeoutMs);

    try {
      let currentUrl = requestedUrl;
      let redirectCount = 0;

      while (true) {
        const normalizedUrl = normalizeSourceUrl(currentUrl);
        const url = new URL(normalizedUrl);
        const addresses = await abortable(
          resolvePublicAddresses(normalizedUrl, this.resolver),
          controller.signal,
        );
        const response = await abortable(
          this.limiter.schedule(url.hostname, () =>
            this.transport.request({
              url: normalizedUrl,
              addresses,
              headers: {
                accept: "text/html,text/plain;q=0.9",
                "accept-language": "en-US,en;q=0.8",
                "user-agent": this.configuration.userAgent,
              },
              connectionTimeoutMs: this.configuration.connectionTimeoutMs,
              signal: controller.signal,
            }),
          ),
          controller.signal,
        );

        if (redirectStatuses.has(response.statusCode)) {
          response.discard();
          if (redirectCount >= this.configuration.maxRedirects) {
            throw new ExtractionError(
              "REDIRECT_LIMIT_EXCEEDED",
              `Source exceeded ${this.configuration.maxRedirects} redirects`,
              { retryable: false, httpStatus: response.statusCode },
            );
          }
          const location = response.headers.location;
          if (location === undefined || location.trim() === "") {
            throw new ExtractionError(
              "INVALID_REDIRECT",
              "Redirect response did not include a Location header",
              { retryable: false, httpStatus: response.statusCode },
            );
          }
          try {
            currentUrl = new URL(location, normalizedUrl).toString();
          } catch (error: unknown) {
            throw new ExtractionError(
              "INVALID_REDIRECT",
              "Redirect Location header was invalid",
              {
                retryable: false,
                httpStatus: response.statusCode,
                cause: error,
              },
            );
          }
          redirectCount += 1;
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.discard();
          return {
            requestedUrl,
            finalUrl: normalizedUrl,
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.alloc(0),
            redirectCount,
            durationMs: Date.now() - startedAt,
          };
        }

        const contentType = parseContentType(response.headers["content-type"]);
        const acceptedContentTypes = options.acceptedContentTypes ?? [
          "text/html",
          "text/plain",
        ];
        if (
          contentType === undefined ||
          !acceptedContentTypes.includes(contentType)
        ) {
          response.discard();
          throw new ExtractionError(
            "UNSUPPORTED_CONTENT_TYPE",
            `Unsupported response content type: ${contentType ?? "missing"}`,
            {
              retryable: false,
              httpStatus: response.statusCode,
              fetchStatus: "BLOCKED",
            },
          );
        }
        const maxBodyBytes =
          options.maxBodyBytes ?? this.configuration.maxBodyBytes;
        const contentLength = parseContentLength(
          response.headers["content-length"],
        );
        if (contentLength !== undefined && contentLength > maxBodyBytes) {
          response.discard();
          throw bodyTooLarge(maxBodyBytes, response.statusCode);
        }

        let body: Buffer;
        try {
          body = await readLimitedBody(
            response.body,
            maxBodyBytes,
            response.statusCode,
          );
        } catch (error: unknown) {
          response.discard();
          throw error;
        }
        return {
          requestedUrl,
          finalUrl: normalizedUrl,
          statusCode: response.statusCode,
          headers: response.headers,
          contentType,
          body,
          redirectCount,
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof ExtractionError
          ? reason
          : new ExtractionError("REQUEST_TIMEOUT", "Request was aborted", {
              retryable: true,
              cause: reason,
            });
      }
      throw toExtractionError(error);
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class NodeHttpTransport implements HttpTransport {
  public async request(input: TransportRequest): Promise<TransportResponse> {
    const url = new URL(input.url);
    const lookup = createPinnedLookup(input.addresses);
    const requestOptions: RequestOptions = {
      method: "GET",
      headers: input.headers,
      signal: input.signal,
      lookup,
      agent: false,
    };
    const client = url.protocol === "https:" ? https : http;

    return new Promise<TransportResponse>((resolve, reject) => {
      const request = client.request(url, requestOptions, (response) => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : value;
        }
        resolve({
          statusCode: response.statusCode ?? 0,
          headers,
          body: response,
          discard: () => response.destroy(),
        });
      });
      request.setTimeout(input.connectionTimeoutMs, () => {
        request.destroy(
          new ExtractionError(
            "REQUEST_TIMEOUT",
            `Connection exceeded ${input.connectionTimeoutMs}ms`,
            { retryable: true },
          ),
        );
      });
      request.once("error", reject);
      request.end();
    });
  }
}

export async function readLimitedBody(
  body: AsyncIterable<Uint8Array>,
  maxBodyBytes: number,
  httpStatus?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw bodyTooLarge(maxBodyBytes, httpStatus);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family;
    const candidates =
      family === 4 || family === 6
        ? addresses.filter((address) => address.family === family)
        : addresses;
    const selected = candidates[0] ?? addresses[0];
    if (selected === undefined) {
      callback(
        Object.assign(new Error("No validated DNS address is available"), {
          code: "ENOTFOUND",
        }),
        "",
      );
      return;
    }
    if (options.all) {
      callback(null, candidates.length === 0 ? addresses : candidates);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function parseContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function bodyTooLarge(
  maxBodyBytes: number,
  httpStatus?: number,
): ExtractionError {
  return new ExtractionError(
    "BODY_TOO_LARGE",
    `Response exceeded the ${maxBodyBytes}-byte body limit`,
    {
      retryable: false,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      fetchStatus: "BLOCKED",
    },
  );
}
