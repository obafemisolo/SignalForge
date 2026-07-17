import { describe, expect, it } from "vitest";

import { createMetrics } from "./metrics.js";

describe("SignalForge metrics", () => {
  it("renders API, queue, LLM, and duplicate metrics", async () => {
    const metrics = createMetrics({
      service: "test",
      collectProcessMetrics: false,
    });
    metrics.observeApiRequest("GET", "/health/live", 200, 12);
    metrics.setQueueDepth("source-fetch", "waiting", 3);
    metrics.observeLlmRequest({
      provider: "fake",
      model: "test-model",
      status: "success",
      durationMs: 20,
      totalTokens: 10,
      costUsd: 0.01,
    });
    metrics.observeDuplicatesRemoved(2);

    const output = await metrics.render();
    expect(output).toContain("signalforge_api_requests_total");
    expect(output).toMatch(
      /signalforge_queue_depth\{[^}]*queue_name="source-fetch"[^}]*state="waiting"[^}]*\} 3/u,
    );
    expect(output).toContain("signalforge_llm_tokens_total");
    expect(output).toContain(
      'signalforge_duplicate_records_removed_total{service="test"} 2',
    );
  });
});
