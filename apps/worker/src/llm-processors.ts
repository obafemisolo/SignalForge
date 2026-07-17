import type { SignalForgeMetrics } from "@signalforge/observability";
import type {
  ExtractedRecordCreateInput,
  JsonObject,
  JsonValue,
} from "@signalforge/schemas";
import {
  HIRING_SIGNAL_RECORD_TYPE,
  HIRING_SIGNAL_STRUCTURED_FIELDS,
  LlmExtractionError,
  type HiringSignalExtractionResult,
  type LlmUsage,
} from "@signalforge/llm";
import {
  processHiringSignals,
  type ProcessedHiringSignal,
} from "@signalforge/record-processing";
import type { ResearchJob, SourceDocument } from "@signalforge/database";

import type {
  ContentExtractor,
  PipelineRecordProcessingOutcome,
  RecordProcessor,
} from "./pipeline.js";

interface HiringSignalExtractionService {
  extract(input: {
    query: string;
    sourceUrl: string;
    sourceText: string;
    signal: AbortSignal;
  }): Promise<HiringSignalExtractionResult>;
}

interface ResearchJobLookup {
  findById(id: string): Promise<ResearchJob | null>;
}

interface ExtractedRecordBatchStore {
  mergeValidatedForSource(
    researchJobId: string,
    sourceDocumentId: string,
    pipelineAttempt: number,
    inputs: readonly ExtractedRecordCreateInput[],
    tracking: {
      provider: string;
      model: string;
      usage: JsonObject;
      metadata: JsonObject;
      duplicatesRemoved: number;
    },
  ): Promise<RecordProcessingPersistenceResult>;
}

interface RecordProcessingPersistenceResult {
  canonicalRecordCount: number;
  duplicatesRemoved: number;
}

export function createNormalizedContentProcessor(): ContentExtractor {
  return {
    extract: async (source) => {
      if (source.rawContent === null || source.rawContent.trim() === "") {
        throw new LlmExtractionError(
          "LLM_RESPONSE_INVALID",
          "Source has no normalized content for record processing",
          { retryable: false },
        );
      }
    },
  };
}

export function createHiringSignalRecordProcessor(
  extractor: HiringSignalExtractionService,
  researchJobs: ResearchJobLookup,
  extractedRecords: ExtractedRecordBatchStore,
  metrics?: SignalForgeMetrics,
): RecordProcessor {
  return {
    process: async (source, signal) => {
      if (source.rawContent === null || source.rawContent.trim() === "") {
        throw new LlmExtractionError(
          "LLM_RESPONSE_INVALID",
          "Source has no normalized content for LLM extraction",
          { retryable: false },
        );
      }
      const researchJob = await researchJobs.findById(source.researchJobId);
      if (researchJob === null) {
        throw new LlmExtractionError(
          "UNSUPPORTED_EXTRACTION_SCHEMA",
          "Research job was not found for LLM extraction",
          { retryable: false },
        );
      }
      const fields = parseSupportedFields(researchJob.extractionSchema);
      let result: HiringSignalExtractionResult;
      try {
        result = await extractor.extract({
          query: researchJob.query,
          sourceUrl: source.sourceUrl,
          sourceText: source.rawContent,
          signal,
        });
      } catch (error: unknown) {
        const errorCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "LLM_EXTRACTION_FAILED";
        metrics?.observeExtraction(
          errorCode === "LLM_RESPONSE_INVALID"
            ? "validation_failure"
            : "failure",
          errorCode,
        );
        throw error;
      }
      const processingResult = await processHiringSignals(
        result.records,
        researchJob.query,
        {
          sourceDocumentId: source.id,
          sourceUrl: source.sourceUrl,
          ...sourceScoringMetadata(source.metadata),
        },
      );
      const records = processingResult.records.map((record) =>
        toPersistenceRecord(source, fields, record),
      );
      const persistenceResult = await extractedRecords.mergeValidatedForSource(
        source.researchJobId,
        source.id,
        source.processingAttempt,
        records,
        {
          provider: result.provider,
          model: result.model,
          usage: toJsonObject(result.usage),
          metadata: {
            chunkCount: result.chunkCount,
            repairedChunks: result.repairedChunks,
            responseMetadata: result.responseMetadata as JsonValue,
            recordProcessing: {
              duplicatesRemoved: processingResult.duplicatesRemoved,
              conflictsDetected: processingResult.conflictsDetected,
              semanticMatchingUsed: processingResult.semanticMatchingUsed,
            },
          },
          duplicatesRemoved: processingResult.duplicatesRemoved,
        },
      );
      metrics?.observeExtraction("success");
      return {
        duplicatesRemoved: persistenceResult.duplicatesRemoved,
      } satisfies PipelineRecordProcessingOutcome;
    },
  };
}

function parseSupportedFields(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw unsupportedSchema();
  }
  const candidate = schema as Record<string, unknown>;
  if (
    candidate.title !== HIRING_SIGNAL_RECORD_TYPE ||
    !Array.isArray(candidate.required) ||
    candidate.required.some((field) => typeof field !== "string")
  ) {
    throw unsupportedSchema();
  }
  const fields = candidate.required as string[];
  const allowed = new Set<string>([
    ...HIRING_SIGNAL_STRUCTURED_FIELDS,
    "confidenceScore",
  ]);
  const required = new Set(HIRING_SIGNAL_STRUCTURED_FIELDS);
  if (
    fields.some((field) => !allowed.has(field)) ||
    [...required].some((field) => !fields.includes(field)) ||
    new Set(fields).size !== fields.length
  ) {
    throw unsupportedSchema();
  }
  return fields;
}

function unsupportedSchema(): LlmExtractionError {
  return new LlmExtractionError(
    "UNSUPPORTED_EXTRACTION_SCHEMA",
    "Phase 6 supports only the companyHiringSignal extraction schema",
    { retryable: false },
  );
}

function toPersistenceRecord(
  source: SourceDocument,
  fields: readonly string[],
  record: ProcessedHiringSignal,
): ExtractedRecordCreateInput {
  const available: Readonly<Record<string, JsonValue>> = {
    company: record.original.company,
    website: record.original.website,
    role: record.original.role,
    location: record.original.location,
    signal: record.original.signal,
    sourceUrl: record.original.sourceUrl,
    evidence: record.original.evidence,
    confidenceScore: record.original.confidenceScore,
  };
  const structuredData = Object.fromEntries(
    fields.map((field) => [field, available[field] ?? null]),
  );
  return {
    researchJobId: source.researchJobId,
    sourceDocumentId: source.id,
    recordType: HIRING_SIGNAL_RECORD_TYPE,
    structuredData,
    normalizedData: {
      company: record.normalized.company,
      role: record.normalized.role,
      domain: record.normalized.domain,
      sourceUrl: record.normalized.sourceUrl,
      location: record.normalized.location,
      signal: record.normalized.signal,
      originalVariants: {
        companies: record.normalized.originalVariants.companies,
        websites: record.normalized.originalVariants.websites,
        roles: record.normalized.originalVariants.roles,
        locations: record.normalized.originalVariants.locations,
        signals: record.normalized.originalVariants.signals,
      },
    },
    evidence: [{ quote: record.original.evidence }],
    sourceAttributions: record.attributions,
    confidenceScore: record.confidenceScore,
    relevanceScore: record.relevanceScore,
    scoreExplanation: record.scoreExplanation as unknown as JsonObject,
    deduplicationKey: record.deduplicationKey,
    reviewRequired: record.reviewRequired,
    conflictDetails: record.conflicts,
  };
}

function sourceScoringMetadata(metadata: unknown): {
  publishedAt?: Date;
  credibilityScore?: number;
} {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return {};
  }
  const candidate = metadata as Record<string, unknown>;
  const publishedAt =
    typeof candidate.publishedAt === "string"
      ? new Date(candidate.publishedAt)
      : undefined;
  const credibilityScore =
    typeof candidate.credibilityScore === "number" &&
    Number.isFinite(candidate.credibilityScore) &&
    candidate.credibilityScore >= 0 &&
    candidate.credibilityScore <= 1
      ? candidate.credibilityScore
      : undefined;
  return {
    ...(publishedAt !== undefined && !Number.isNaN(publishedAt.getTime())
      ? { publishedAt }
      : {}),
    ...(credibilityScore === undefined ? {} : { credibilityScore }),
  };
}

function toJsonObject(input: LlmUsage): JsonObject {
  return Object.fromEntries(
    Object.entries({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      costUsd: input.costUsd,
    }).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}
