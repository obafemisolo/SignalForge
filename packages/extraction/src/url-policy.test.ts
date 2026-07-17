import { describe, expect, it } from "vitest";

import { ExtractionError } from "./errors.js";
import { normalizeSourceUrl, resolvePublicAddresses } from "./url-policy.js";

describe("source URL policy", () => {
  it("normalizes host casing, query order, and fragments", () => {
    expect(
      normalizeSourceUrl(" HTTPS://Example.COM/jobs?z=2&a=1#section "),
    ).toBe("https://example.com/jobs?a=1&z=2");
  });

  it.each([
    "ftp://example.com/file",
    "https://user:secret@example.com/",
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://metadata.google.internal/",
  ])("blocks an unsafe URL: %s", (url) => {
    expect(() => normalizeSourceUrl(url)).toThrow(ExtractionError);
  });

  it("rejects a hostname when any resolved address is private", async () => {
    await expect(
      resolvePublicAddresses("https://example.com/", {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "192.168.1.2", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS_BLOCKED",
      retryable: false,
    });
  });
});
