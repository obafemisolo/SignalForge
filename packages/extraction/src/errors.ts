import type { FetchMode } from "./types.js";

export type ExtractionErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "URL_CREDENTIALS_NOT_ALLOWED"
  | "PRIVATE_ADDRESS_BLOCKED"
  | "DNS_RESOLUTION_FAILED"
  | "ROBOTS_DISALLOWED"
  | "ROBOTS_UNREACHABLE"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "INVALID_REDIRECT"
  | "HTTP_CLIENT_ERROR"
  | "HTTP_SERVER_ERROR"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "EMPTY_CONTENT"
  | "INSUFFICIENT_CONTENT"
  | "ACCESS_RESTRICTED"
  | "BROWSER_UNAVAILABLE";

export interface ExtractionErrorOptions {
  retryable: boolean;
  httpStatus?: number;
  fetchDurationMs?: number;
  fetchMode?: FetchMode;
  fetchStatus?: "FAILED" | "BLOCKED" | "SKIPPED";
  cause?: unknown;
}

export class ExtractionError extends Error {
  public readonly code: ExtractionErrorCode;
  public readonly retryable: boolean;
  public readonly httpStatus: number | undefined;
  public readonly fetchDurationMs: number | undefined;
  public readonly fetchMode: FetchMode | undefined;
  public readonly fetchStatus: "FAILED" | "BLOCKED" | "SKIPPED";

  public constructor(
    code: ExtractionErrorCode,
    message: string,
    options: ExtractionErrorOptions,
  ) {
    super(message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ExtractionError";
    this.code = code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.fetchDurationMs = options.fetchDurationMs;
    this.fetchMode = options.fetchMode;
    this.fetchStatus = options.fetchStatus ?? "FAILED";
  }

  public withTelemetry(
    fetchDurationMs: number,
    fetchMode: FetchMode,
  ): ExtractionError {
    return new ExtractionError(this.code, this.message, {
      retryable: this.retryable,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      fetchDurationMs,
      fetchMode,
      fetchStatus: this.fetchStatus,
      cause: this,
    });
  }
}

export function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ExtractionError("REQUEST_TIMEOUT", "The request was aborted", {
      retryable: true,
      cause: error,
    });
  }
  return new ExtractionError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "Unknown network failure",
    { retryable: true, cause: error },
  );
}
