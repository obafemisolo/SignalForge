import { LlmExtractionError } from "./errors.js";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "./types.js";

export type FakeLlmOutcome =
  | LlmCompletionResponse
  | Error
  | ((request: LlmCompletionRequest) => Promise<LlmCompletionResponse>);

export class FakeLlmProvider implements LlmProvider {
  public readonly name = "fake";
  public readonly requests: LlmCompletionRequest[] = [];
  private readonly outcomes: FakeLlmOutcome[];

  public constructor(outcomes: readonly FakeLlmOutcome[]) {
    this.outcomes = [...outcomes];
  }

  public async complete(
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    this.requests.push(request);
    request.signal.throwIfAborted();
    const outcome = this.outcomes.shift();
    if (outcome === undefined) {
      throw new LlmExtractionError(
        "LLM_PROVIDER_UNAVAILABLE",
        "Fake provider has no queued response",
        { retryable: false },
      );
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return typeof outcome === "function" ? outcome(request) : outcome;
  }
}
