import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";

const request = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "Return JSON" }],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
};

describe("OpenAI-compatible provider", () => {
  it("requires credentials for the default OpenAI endpoint", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider({
          baseUrl: "https://api.openai.com/v1",
          timeoutMs: 1_000,
        }),
    ).toThrow(/LLM_API_KEY/u);
  });

  it("normalizes token usage and calculates configured cost", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        id: "request-1",
        model: "served-model",
        choices: [{ message: { content: '{"records":[]}' } }],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 500,
          total_tokens: 1_500,
        },
      }),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://llm.example/v1/",
      apiKey: "test-key",
      timeoutMs: 1_000,
      pricing: {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 4,
      },
      fetchImplementation,
    });
    const result = await provider.complete(request);

    expect(result.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      costUsd: 0.004,
    });
    expect(result.metadata).toEqual({ requestId: "request-1" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://llm.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("classifies provider timeouts as retryable", async () => {
    const fetchImplementation: typeof fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://llm.example/v1",
      timeoutMs: 10,
      fetchImplementation,
    });

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "LLM_PROVIDER_TIMEOUT",
      retryable: true,
    });
  });
});
