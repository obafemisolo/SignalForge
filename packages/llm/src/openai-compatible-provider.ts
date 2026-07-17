import { z } from "zod";

import { LlmExtractionError } from "./errors.js";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMetadataValue,
  LlmProvider,
  LlmUsage,
  TokenPricing,
} from "./types.js";

const responseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    system_fingerprint: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
    choices: z
      .array(
        z.object({
          message: z.object({ content: z.string() }).passthrough(),
        }),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        cost: z.number().finite().nonnegative().optional(),
        cost_usd: z.number().finite().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface OpenAiCompatibleProviderConfiguration {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  pricing?: TokenPricing;
  fetchImplementation?: typeof fetch;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  public readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  public constructor(
    private readonly configuration: OpenAiCompatibleProviderConfiguration,
  ) {
    const url = new URL(configuration.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new LlmExtractionError(
        "LLM_CONFIGURATION_ERROR",
        "LLM base URL must use HTTP or HTTPS",
        { retryable: false },
      );
    }
    if (
      url.hostname.toLocaleLowerCase() === "api.openai.com" &&
      configuration.apiKey === undefined
    ) {
      throw new LlmExtractionError(
        "LLM_CONFIGURATION_ERROR",
        "LLM_API_KEY is required for the default OpenAI endpoint",
        { retryable: false },
      );
    }
    this.baseUrl = url.toString().replace(/\/+$/u, "");
    this.fetchImplementation = configuration.fetchImplementation ?? fetch;
  }

  public async complete(
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(
        new LlmExtractionError(
          "LLM_PROVIDER_TIMEOUT",
          `LLM request exceeded ${this.configuration.timeoutMs}ms`,
          { retryable: true },
        ),
      );
    }, this.configuration.timeoutMs);

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.configuration.apiKey === undefined
              ? {}
              : { authorization: `Bearer ${this.configuration.apiKey}` }),
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            response_format: { type: "json_object" },
            temperature: 0,
            max_completion_tokens: request.maxOutputTokens,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw providerHttpError(response.status);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new LlmExtractionError(
          "LLM_RESPONSE_INVALID",
          "Provider returned an invalid completion envelope",
          {
            retryable: false,
            issues: parsed.error.issues.map((issue) => issue.message),
          },
        );
      }
      const content = parsed.data.choices[0]?.message.content;
      if (content === undefined) {
        throw new LlmExtractionError(
          "LLM_RESPONSE_INVALID",
          "Provider completion did not contain output text",
          { retryable: false },
        );
      }
      const usage = normalizeUsage(
        parsed.data.usage,
        this.configuration.pricing,
      );
      return {
        content,
        model: parsed.data.model ?? request.model,
        ...(usage === undefined ? {} : { usage }),
        metadata: compactMetadata({
          requestId: parsed.data.id,
          systemFingerprint: parsed.data.system_fingerprint,
          serviceTier: parsed.data.service_tier,
        }),
      };
    } catch (error: unknown) {
      if (error instanceof LlmExtractionError) {
        throw error;
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof LlmExtractionError
          ? reason
          : new LlmExtractionError(
              "LLM_PROVIDER_TIMEOUT",
              "LLM request was aborted",
              { retryable: true, cause: reason },
            );
      }
      throw new LlmExtractionError(
        "LLM_PROVIDER_UNAVAILABLE",
        "LLM provider request failed",
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}

function providerHttpError(status: number): LlmExtractionError {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new LlmExtractionError(
    retryable ? "LLM_PROVIDER_UNAVAILABLE" : "LLM_PROVIDER_REJECTED",
    `LLM provider returned HTTP ${status}`,
    { retryable, statusCode: status },
  );
}

function normalizeUsage(
  usage: z.infer<typeof responseSchema>["usage"],
  pricing: TokenPricing | undefined,
): LlmUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const reportedCost = usage.cost_usd ?? usage.cost;
  const calculatedCost =
    reportedCost ?? calculateCost(inputTokens, outputTokens, pricing);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(usage.total_tokens === undefined
      ? {}
      : { totalTokens: usage.total_tokens }),
    ...(calculatedCost === undefined ? {} : { costUsd: calculatedCost }),
  };
}

function calculateCost(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  pricing: TokenPricing | undefined,
): number | undefined {
  if (pricing === undefined) {
    return undefined;
  }
  if (
    pricing.inputCostPerMillionTokens === undefined &&
    pricing.outputCostPerMillionTokens === undefined
  ) {
    return undefined;
  }
  const inputCost =
    inputTokens === undefined || pricing.inputCostPerMillionTokens === undefined
      ? 0
      : (inputTokens / 1_000_000) * pricing.inputCostPerMillionTokens;
  const outputCost =
    outputTokens === undefined ||
    pricing.outputCostPerMillionTokens === undefined
      ? 0
      : (outputTokens / 1_000_000) * pricing.outputCostPerMillionTokens;
  return inputCost + outputCost;
}

function compactMetadata(
  input: Readonly<Record<string, LlmMetadataValue | undefined>>,
): Readonly<Record<string, LlmMetadataValue>> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, LlmMetadataValue] =>
        entry[1] !== undefined && entry[1] !== null,
    ),
  );
}
