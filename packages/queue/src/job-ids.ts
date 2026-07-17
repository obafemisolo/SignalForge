import type {
  DeadLetterJobData,
  ResearchOrchestrationJobData,
  SourceStageJobData,
} from "./contracts.js";

export function orchestrationJobId(
  data: Omit<ResearchOrchestrationJobData, "timeoutMs">,
): string {
  return data.sourceDocumentIds === undefined
    ? `orchestrate-${data.researchJobId}`
    : `retry-${data.researchJobId}-${data.requestId}`;
}

export function sourceFetchJobId(data: SourceStageJobData): string {
  return stageJobId("fetch", data);
}

export function contentExtractionJobId(data: SourceStageJobData): string {
  return stageJobId("extract", data);
}

export function recordProcessingJobId(data: SourceStageJobData): string {
  return stageJobId("process", data);
}

export function deadLetterJobId(data: DeadLetterJobData): string {
  return `dead-${data.queueName}-${data.jobId}`;
}

function stageJobId(prefix: string, data: SourceStageJobData): string {
  return `${prefix}-${data.sourceDocumentId}-${data.pipelineAttempt}`;
}
