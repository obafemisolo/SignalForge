import { describe, expect, it, vi } from "vitest";

import { RobotsPolicy } from "./robots.js";

describe("robots policy cache bounds", () => {
  it("evicts old origins instead of retaining unbounded cache state", async () => {
    const client = {
      get: vi.fn(async () => ({
        statusCode: 404,
        body: Buffer.alloc(0),
      })),
    };
    const policy = new RobotsPolicy(
      client as never,
      { setMinimumDomainDelay: vi.fn() } as never,
      "SignalForgeBot/0.1 tests",
      300_000,
      1,
    );

    await policy.assertAllowed(
      "https://one.example/jobs",
      new AbortController().signal,
    );
    await policy.assertAllowed(
      "https://two.example/jobs",
      new AbortController().signal,
    );

    expect(client.get).toHaveBeenCalledTimes(2);
  });
});
