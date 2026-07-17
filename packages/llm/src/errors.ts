export type LlmErrorCode =
  | "LLM_CONFIGURATION_ERROR"
  | "LLM_PROVIDER_TIMEOUT"
  | "LLM_PROVIDER_UNAVAILABLE"
  | "LLM_PROVIDER_REJECTED"
  | "LLM_RESPONSE_INVALID"
  | "LLM_CONTENT_LIMIT_EXCEEDED"
  | "UNSUPPORTED_EXTRACTION_SCHEMA";

export interface LlmErrorOptions {
  retryable: boolean;
  statusCode?: number;
  issues?: readonly string[];
  cause?: unknown;
}

export class LlmExtractionError extends Error {
  public readonly code: LlmErrorCode;
  public readonly retryable: boolean;
  public readonly statusCode: number | undefined;
  public readonly issues: readonly string[];

  public constructor(
    code: LlmErrorCode,
    message: string,
    options: LlmErrorOptions,
  ) {
    super(message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "LlmExtractionError";
    this.code = code;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.issues = options.issues ?? [];
  }
}
