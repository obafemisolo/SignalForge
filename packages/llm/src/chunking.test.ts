import { describe, expect, it } from "vitest";

import { splitIntoBoundedChunks } from "./chunking.js";

describe("bounded LLM content chunking", () => {
  it("splits oversized content without exceeding the configured size", () => {
    const text = `${"A".repeat(700)}\n${"B".repeat(700)}\n${"C".repeat(700)}`;
    const chunks = splitIntoBoundedChunks(text, {
      maxChunkCharacters: 1_000,
      maxChunks: 5,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_000)).toBe(true);
    expect(chunks.join("")).toBe(text.replaceAll("\n", ""));
  });

  it("fails explicitly instead of silently truncating excess content", () => {
    expect(() =>
      splitIntoBoundedChunks("A".repeat(3_000), {
        maxChunkCharacters: 1_000,
        maxChunks: 2,
      }),
    ).toThrow(/more than 2 LLM chunks/u);
  });
});
