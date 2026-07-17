import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

describe("structured logger redaction", () => {
  it("redacts API keys, authorization headers, cookies, and secrets", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(
      { level: "info", service: "redaction-test" },
      destination,
    );

    logger.info({
      authorization: "Bearer root-secret",
      cookie: "session=secret-cookie",
      apiKey: "provider-secret",
      password: "database-secret",
      req: {
        headers: {
          authorization: "Bearer nested-secret",
          cookie: "session=nested-cookie",
        },
      },
      safe: "visible",
    });

    expect(output).toContain("[REDACTED]");
    expect(output).toContain('"safe":"visible"');
    expect(output).not.toContain("root-secret");
    expect(output).not.toContain("secret-cookie");
    expect(output).not.toContain("provider-secret");
    expect(output).not.toContain("database-secret");
    expect(output).not.toContain("nested-secret");
  });
});
