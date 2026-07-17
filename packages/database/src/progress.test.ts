import { describe, expect, it } from "vitest";

import { calculateResearchProgress } from "./progress.js";

describe("research progress calculation", () => {
  it("keeps a job running until every source is terminal", () => {
    expect(
      calculateResearchProgress(3, ["SUCCEEDED", "FAILED", "PROCESSING"]),
    ).toMatchObject({
      successfulSources: 1,
      failedSources: 1,
      terminalSources: 2,
      status: "RUNNING",
      isTerminal: false,
    });
  });

  it("completes with partial success when terminal outcomes are mixed", () => {
    expect(
      calculateResearchProgress(3, ["SUCCEEDED", "FAILED", "SUCCEEDED"]),
    ).toMatchObject({
      successfulSources: 2,
      failedSources: 1,
      status: "PARTIAL",
      isTerminal: true,
    });
  });

  it.each([
    [["SUCCEEDED", "SUCCEEDED"] as const, "COMPLETED"],
    [["FAILED", "FAILED"] as const, "FAILED"],
  ])("selects the terminal job status for %j", (statuses, status) => {
    expect(calculateResearchProgress(2, statuses).status).toBe(status);
  });
});
