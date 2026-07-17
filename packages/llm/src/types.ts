export type LlmMessageRole = "system" | "user";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

export interface LlmCompletionRequest {
  model: string;
  messages: readonly LlmMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type LlmMetadataValue = boolean | number | string | null;

export interface LlmCompletionResponse {
  content: string;
  model: string;
  usage?: LlmUsage;
  metadata?: Readonly<Record<string, LlmMetadataValue>>;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export interface TokenPricing {
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
}
