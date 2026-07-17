import { describe, expect, it } from "vitest";

describe("SignalForge workspace", () => {
  it("boots with a starter test suite", () => {
    expect("signalforge").toMatch(/^signalforge$/);
  });
});
