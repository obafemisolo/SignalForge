import { describe, expect, it } from "vitest";

import {
  elapsedMilliseconds,
  formatDuration,
  isTerminalStatus,
  recordsToCsv,
} from "./helpers";

describe("research job UI helpers", () => {
  it("stops polling terminal jobs", () => {
    expect(isTerminalStatus("COMPLETED")).toBe(true);
    expect(isTerminalStatus("PARTIAL")).toBe(true);
    expect(isTerminalStatus("RUNNING")).toBe(false);
  });

  it("formats elapsed time for active and completed jobs", () => {
    const started = "2026-01-01T00:00:00.000Z";
    expect(elapsedMilliseconds(started, "2026-01-01T00:01:05.000Z")).toBe(
      65_000,
    );
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("escapes CSV values safely", () => {
    const csv = recordsToCsv([
      {
        company: "Acme, Inc.",
        role: "Backend",
        location: null,
        signal: "Hiring\nnow",
        relevanceScore: 0.9,
        confidenceScore: 0.8,
        sourceUrl: "https://example.com",
        evidence: "A quote",
      },
    ]);
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain('"Hiring\nnow"');
  });

  it("neutralizes spreadsheet formula values", () => {
    const csv = recordsToCsv([
      {
        company: '=HYPERLINK("https://attacker.test")',
        role: "+cmd|'/C calc'!A1",
        location: "-10+5",
        signal: "@SUM(A1:A2)",
        relevanceScore: 0.5,
        confidenceScore: 0.5,
        sourceUrl: "https://example.com",
        evidence: "Evidence",
      },
    ]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-10+5");
    expect(csv).toContain("'@SUM");
  });
});
