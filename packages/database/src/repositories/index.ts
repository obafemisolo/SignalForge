import type { PrismaClient } from "../generated/prisma/client.js";
import { ExtractedRecordRepository } from "./extracted-record.repository.js";
import { JobEventRepository } from "./job-event.repository.js";
import { PipelineRepository } from "./pipeline.repository.js";
import { ResearchJobRepository } from "./research-job.repository.js";
import { SourceDocumentRepository } from "./source-document.repository.js";

export interface Repositories {
  extractedRecords: ExtractedRecordRepository;
  jobEvents: JobEventRepository;
  pipeline: PipelineRepository;
  researchJobs: ResearchJobRepository;
  sourceDocuments: SourceDocumentRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    extractedRecords: new ExtractedRecordRepository(prisma),
    jobEvents: new JobEventRepository(prisma),
    pipeline: new PipelineRepository(prisma),
    researchJobs: new ResearchJobRepository(prisma),
    sourceDocuments: new SourceDocumentRepository(prisma),
  };
}

export { ExtractedRecordRepository } from "./extracted-record.repository.js";
export { JobEventRepository } from "./job-event.repository.js";
export * from "./pipeline.repository.js";
export * from "./research-job.repository.js";
export { SourceDocumentRepository } from "./source-document.repository.js";
