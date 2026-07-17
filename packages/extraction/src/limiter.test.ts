import { describe, expect, it } from "vitest";

import { RequestLimiter } from "./limiter.js";

describe("request limiter resource bounds", () => {
  it("evicts idle domains while refusing unbounded active-domain growth", async () => {
    const limiter = new RequestLimiter(1, 1, 0, 1);
    let release: (() => void) | undefined;
    const first = limiter.schedule(
      "first.example",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(
      limiter.schedule("second.example", async () => undefined),
    ).rejects.toThrow("Domain limiter capacity exhausted");

    release?.();
    await first;
    await limiter.schedule("second.example", async () => undefined);
  });
});
