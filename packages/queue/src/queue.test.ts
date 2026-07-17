import { describe, expect, it } from "vitest";

import {
  QUEUE_ATTEMPTS,
  QUEUE_NAMES,
  contentExtractionJobId,
  getJobOptions,
  recordProcessingJobId,
  sourceFetchJobId,
  sourceStageJobDataSchema,
  type SourceStageJobData,
} from "./index.js";

const sourceJob: SourceStageJobData = {
  researchJobId: "3f8b80d7-d42d-4439-826f-cd80b973fb81",
  sourceDocumentId: "69dbaa4d-64b8-4991-9314-2a8074b93fd8",
  pipelineAttempt: 0,
  requestedAt: "2026-07-18T10:00:00.000Z",
  requestId: "07883774-668f-449c-a84a-bc35fcf8e588",
  timeoutMs: 30_000,
};

describe("queue contracts", () => {
  it("defines all required queues", () => {
    expect(Object.values(QUEUE_NAMES)).toEqual([
      "research-orchestration",
      "source-fetch",
      "content-extraction",
      "record-processing",
      "dead-letter",
    ]);
  });

  it("validates typed stage payloads", () => {
    expect(sourceStageJobDataSchema.parse(sourceJob)).toEqual(sourceJob);
    expect(
      sourceStageJobDataSchema.safeParse({
        ...sourceJob,
        pipelineAttempt: -1,
      }).success,
    ).toBe(false);
  });

  it("uses deterministic IDs and changes them only for a new pipeline attempt", () => {
    expect(sourceFetchJobId(sourceJob)).toBe(sourceFetchJobId(sourceJob));
    expect(contentExtractionJobId(sourceJob)).toContain(
      sourceJob.sourceDocumentId,
    );
    expect(recordProcessingJobId(sourceJob)).not.toBe(
      recordProcessingJobId({ ...sourceJob, pipelineAttempt: 1 }),
    );
  });

  it("configures bounded retries with exponential backoff", () => {
    const options = getJobOptions(
      QUEUE_NAMES.sourceFetch,
      sourceFetchJobId(sourceJob),
    );

    expect(options.attempts).toBe(QUEUE_ATTEMPTS["source-fetch"]);
    expect(options.attempts).toBe(4);
    expect(options.backoff).toEqual({ type: "exponential", delay: 1_000 });
  });
});
