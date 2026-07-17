import { describe, expect, it } from "vitest";

import { WorkerRuntime, type Closable } from "./runtime.js";

function closable(name: string, events: string[]): Closable {
  return {
    close: async () => {
      events.push(name);
    },
  };
}

describe("worker graceful shutdown", () => {
  it("closes active workers before shared resources", async () => {
    const events: string[] = [];
    const runtime = new WorkerRuntime(
      [closable("worker-a", events), closable("worker-b", events)],
      [closable("queues", events), closable("database", events)],
    );

    await runtime.close();

    expect(events.slice(0, 2).sort()).toEqual(["worker-a", "worker-b"]);
    expect(events.slice(2)).toEqual(["queues", "database"]);
  });
});
