import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BullMqQueueSystem, RESEARCH_ORCHESTRATION_QUEUE } from "./index.js";

const redisUrl = process.env.TEST_REDIS_URL;
const describeWithRedis =
  redisUrl === undefined ? describe.skip : describe.sequential;

describeWithRedis("BullMQ duplicate prevention", () => {
  const prefix = `signalforge-test-${randomUUID()}`;
  let publisher: BullMqQueueSystem;
  let redis: Redis;
  let inspectionQueue: Queue;

  beforeAll(() => {
    if (redisUrl === undefined) {
      throw new Error("TEST_REDIS_URL must be defined");
    }
    publisher = new BullMqQueueSystem({ redisUrl, prefix });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    inspectionQueue = new Queue(RESEARCH_ORCHESTRATION_QUEUE, {
      connection: redis,
      prefix,
    });
  });

  afterAll(async () => {
    await inspectionQueue.obliterate({ force: true });
    await inspectionQueue.close();
    await publisher.close();
    redis.disconnect();
  });

  it("keeps one job when the same deterministic job is submitted twice", async () => {
    const payload = {
      researchJobId: "3f8b80d7-d42d-4439-826f-cd80b973fb81",
      requestedAt: "2026-07-18T10:00:00.000Z",
      requestId: "07883774-668f-449c-a84a-bc35fcf8e588",
    };

    await publisher.enqueueResearchJob(payload);
    await publisher.enqueueResearchJob(payload);

    await expect(
      inspectionQueue.getJobCounts("waiting"),
    ).resolves.toMatchObject({ waiting: 1 });
  });
});
