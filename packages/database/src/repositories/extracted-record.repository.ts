import { isDeepStrictEqual } from "node:util";

import {
  extractedRecordCreateInputSchema,
  recordConflictSchema,
  sourceAttributionSchema,
  type EvidenceItem,
  type ExtractedRecordCreateInput,
  type JsonObject,
  type ValidatedExtractedRecordCreateInput,
} from "@signalforge/schemas";
import {
  applyConflict,
  classifyDeterministicMatch,
  mergeDuplicateRecords,
  normalizeHiringSignal,
  type HiringSignalValue,
  type NormalizedHiringSignal,
  type ProcessedHiringSignal,
  type RecordConflict,
  type RelevanceScoreExplanation,
  type SourceAttribution,
} from "@signalforge/record-processing";

import type {
  Prisma,
  ExtractedRecord,
  PrismaClient,
} from "../generated/prisma/client.js";
import {
  EntityNotFoundError,
  PersistenceConflictError,
  PersistenceValidationError,
} from "../errors.js";
import { assertStructuredDataMatchesSchema } from "../validation/extraction-schema.js";

export interface LlmExtractionTracking {
  provider: string;
  model: string;
  usage: JsonObject;
  metadata: JsonObject;
  duplicatesRemoved?: number;
}

export interface RecordProcessingPersistenceResult {
  canonicalRecordCount: number;
  duplicatesRemoved: number;
}

interface CanonicalRecord {
  id?: string;
  primarySourceDocumentId: string;
  recordType: string;
  structuredKeys: string[];
  record: ProcessedHiringSignal;
}

interface CanonicalPersistenceData {
  recordType: string;
  structuredData: Prisma.InputJsonObject;
  normalizedData: Prisma.InputJsonObject;
  evidence: Prisma.InputJsonArray;
  sourceAttributions: Prisma.InputJsonArray;
  confidenceScore: number;
  relevanceScore: number;
  scoreExplanation: Prisma.InputJsonObject;
  deduplicationKey: string;
  reviewRequired: boolean;
  conflictDetails: Prisma.InputJsonArray;
}

function assertEvidenceMatchesContent(
  evidence: readonly EvidenceItem[],
  rawContent: string,
): void {
  for (const item of evidence) {
    if (
      item.startOffset !== undefined &&
      item.endOffset !== undefined &&
      rawContent.slice(item.startOffset, item.endOffset) !== item.quote
    ) {
      throw new PersistenceValidationError(
        "Evidence offsets do not match the source document content",
      );
    }

    if (
      item.startOffset === undefined &&
      item.endOffset === undefined &&
      !rawContent.includes(item.quote)
    ) {
      throw new PersistenceValidationError(
        "Evidence quote does not occur in the source document content",
      );
    }
  }
}

export class ExtractedRecordRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createValidated(
    input: ExtractedRecordCreateInput,
  ): Promise<ExtractedRecord> {
    const validated = extractedRecordCreateInputSchema.parse(input);

    return this.prisma.$transaction(async (transaction) => {
      const [researchJob, sourceDocument] = await Promise.all([
        transaction.researchJob.findUnique({
          where: { id: validated.researchJobId },
          select: { extractionSchema: true },
        }),
        transaction.sourceDocument.findUnique({
          where: { id: validated.sourceDocumentId },
          select: { researchJobId: true, rawContent: true },
        }),
      ]);

      if (researchJob === null) {
        throw new EntityNotFoundError("ResearchJob", validated.researchJobId);
      }

      if (sourceDocument === null) {
        throw new EntityNotFoundError(
          "SourceDocument",
          validated.sourceDocumentId,
        );
      }

      if (sourceDocument.researchJobId !== validated.researchJobId) {
        throw new PersistenceConflictError(
          "SourceDocument does not belong to the supplied ResearchJob",
        );
      }

      if (sourceDocument.rawContent === null) {
        throw new PersistenceValidationError(
          "SourceDocument must contain fetched content before extraction",
        );
      }

      const extractionSchema =
        researchJob.extractionSchema as unknown as JsonObject;
      assertStructuredDataMatchesSchema(
        extractionSchema,
        validated.structuredData,
      );
      assertEvidenceMatchesContent(
        validated.evidence,
        sourceDocument.rawContent,
      );

      return transaction.extractedRecord.create({
        data: {
          researchJobId: validated.researchJobId,
          sourceDocumentId: validated.sourceDocumentId,
          recordType: validated.recordType,
          structuredData: validated.structuredData as Prisma.InputJsonObject,
          normalizedData: validated.normalizedData as Prisma.InputJsonObject,
          evidence: validated.evidence as Prisma.InputJsonArray,
          sourceAttributions:
            validated.sourceAttributions as Prisma.InputJsonArray,
          confidenceScore: validated.confidenceScore,
          relevanceScore: validated.relevanceScore,
          scoreExplanation:
            validated.scoreExplanation as Prisma.InputJsonObject,
          deduplicationKey: validated.deduplicationKey,
          reviewRequired: validated.reviewRequired,
          conflictDetails: validated.conflictDetails as Prisma.InputJsonArray,
        },
      });
    });
  }

  public async mergeValidatedForSource(
    researchJobId: string,
    sourceDocumentId: string,
    pipelineAttempt: number,
    inputs: readonly ExtractedRecordCreateInput[],
    tracking: LlmExtractionTracking,
  ): Promise<RecordProcessingPersistenceResult> {
    const validatedInputs = inputs.map((input) =>
      extractedRecordCreateInputSchema.parse(input),
    );

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id
        FROM research_jobs
        WHERE id = ${researchJobId}::uuid
        FOR UPDATE
      `;
      const researchJob = await transaction.researchJob.findUnique({
        where: { id: researchJobId },
        select: { extractionSchema: true, query: true },
      });
      const sourceDocument = await transaction.sourceDocument.findUnique({
        where: { id: sourceDocumentId },
        select: {
          researchJobId: true,
          sourceUrl: true,
          rawContent: true,
          processingStatus: true,
          processingAttempt: true,
          recordDuplicatesRemoved: true,
        },
      });

      if (researchJob === null) {
        throw new EntityNotFoundError("ResearchJob", researchJobId);
      }
      if (sourceDocument === null) {
        throw new EntityNotFoundError("SourceDocument", sourceDocumentId);
      }
      if (sourceDocument.researchJobId !== researchJobId) {
        throw new PersistenceConflictError(
          "SourceDocument does not belong to the supplied ResearchJob",
        );
      }
      if (
        sourceDocument.processingStatus !== "PROCESSING" ||
        sourceDocument.processingAttempt !== pipelineAttempt
      ) {
        throw new PersistenceConflictError(
          "SourceDocument is not in the expected record-processing generation",
        );
      }
      if (sourceDocument.rawContent === null) {
        throw new PersistenceValidationError(
          "SourceDocument must contain fetched content before extraction",
        );
      }

      const extractionSchema =
        researchJob.extractionSchema as unknown as JsonObject;
      for (const input of validatedInputs) {
        if (
          input.researchJobId !== researchJobId ||
          input.sourceDocumentId !== sourceDocumentId
        ) {
          throw new PersistenceConflictError(
            "Every extracted record must belong to the supplied source and research job",
          );
        }
        assertStructuredDataMatchesSchema(
          extractionSchema,
          input.structuredData,
        );
        assertEvidenceMatchesContent(input.evidence, sourceDocument.rawContent);
        const processed = fromValidatedInput(input);
        const expectedNormalized = normalizeHiringSignal(processed.original);
        if (!isDeepStrictEqual(expectedNormalized, processed.normalized)) {
          throw new PersistenceValidationError(
            "normalizedData does not match the validated structured record",
          );
        }
        if (
          input.sourceAttributions.some(
            (attribution) =>
              attribution.sourceDocumentId !== sourceDocumentId ||
              attribution.sourceUrl !== sourceDocument.sourceUrl ||
              attribution.evidence.some(
                (quote) => !sourceDocument.rawContent?.includes(quote),
              ),
          )
        ) {
          throw new PersistenceValidationError(
            "Source attributions must reference evidence from the supplied source",
          );
        }
        if (
          !("total" in input.scoreExplanation) ||
          input.scoreExplanation.total !== input.relevanceScore
        ) {
          throw new PersistenceValidationError(
            "The persisted relevance score must match its explanation",
          );
        }
      }

      const storedRecords = await transaction.extractedRecord.findMany({
        where: { researchJobId },
      });
      const canonicalRecords = storedRecords.map((record) =>
        fromStoredRecord(record),
      );
      let crossSourceDuplicates = 0;
      let conflictsDetected = 0;

      for (const input of validatedInputs) {
        let incoming = fromValidatedInput(input);
        let handled = false;
        for (const canonical of canonicalRecords) {
          const match = classifyDeterministicMatch(canonical.record, incoming);
          if (match.kind === "DUPLICATE") {
            const addsSource = !canonical.record.attributions.some(
              (attribution) =>
                attribution.sourceDocumentId === sourceDocumentId,
            );
            canonical.record = mergeDuplicateRecords(
              canonical.record,
              incoming,
              researchJob.query,
            );
            if (addsSource) {
              crossSourceDuplicates += 1;
            }
            handled = true;
            break;
          }
          if (match.kind === "CONFLICT") {
            const flagged = applyConflict(
              canonical.record,
              incoming,
              match.conflicts,
            );
            canonical.record = flagged.existing;
            incoming = flagged.incoming;
            conflictsDetected += match.conflicts.length;
            break;
          }
        }
        if (!handled) {
          canonicalRecords.push({
            primarySourceDocumentId: sourceDocumentId,
            recordType: input.recordType,
            structuredKeys: Object.keys(input.structuredData),
            record: incoming,
          });
        }
      }

      for (const canonical of canonicalRecords) {
        const data = toPersistenceData(canonical);
        if (canonical.id === undefined) {
          await transaction.extractedRecord.create({
            data: {
              researchJobId,
              sourceDocumentId: canonical.primarySourceDocumentId,
              ...data,
            },
          });
        } else {
          await transaction.extractedRecord.update({
            where: { id: canonical.id },
            data,
          });
        }
      }

      const duplicateContribution =
        (tracking.duplicatesRemoved ?? 0) + crossSourceDuplicates;
      const duplicateDelta =
        duplicateContribution - sourceDocument.recordDuplicatesRemoved;
      await transaction.sourceDocument.update({
        where: { id: sourceDocumentId },
        data: {
          llmProvider: tracking.provider,
          llmModel: tracking.model,
          llmUsage: tracking.usage as Prisma.InputJsonObject,
          llmMetadata: tracking.metadata as Prisma.InputJsonObject,
          llmProcessedAt: new Date(),
          recordDuplicatesRemoved: duplicateContribution,
        },
      });
      if (duplicateDelta !== 0) {
        await transaction.researchJob.update({
          where: { id: researchJobId },
          data: { duplicatesRemoved: { increment: duplicateDelta } },
        });
      }
      await transaction.jobEvent.create({
        data: {
          researchJobId,
          eventType: "records.processed",
          payload: {
            sourceDocumentId,
            recordsReceived: validatedInputs.length,
            duplicatesRemoved: duplicateContribution,
            conflictsDetected,
          },
        },
      });
      return {
        canonicalRecordCount: canonicalRecords.length,
        duplicatesRemoved: Math.max(duplicateDelta, 0),
      };
    });
  }

  /**
   * Compatibility path for non-hiring schemas created before canonical record
   * processing. New hiring-signal workers use mergeValidatedForSource.
   */
  public async replaceValidatedForSource(
    researchJobId: string,
    sourceDocumentId: string,
    pipelineAttempt: number,
    inputs: readonly ExtractedRecordCreateInput[],
    tracking: LlmExtractionTracking,
  ): Promise<number> {
    const validatedInputs = inputs.map((input) =>
      extractedRecordCreateInputSchema.parse(input),
    );
    return this.prisma.$transaction(async (transaction) => {
      const [researchJob, source] = await Promise.all([
        transaction.researchJob.findUnique({
          where: { id: researchJobId },
          select: { extractionSchema: true },
        }),
        transaction.sourceDocument.findUnique({
          where: { id: sourceDocumentId },
          select: {
            researchJobId: true,
            rawContent: true,
            processingStatus: true,
            processingAttempt: true,
          },
        }),
      ]);
      if (researchJob === null) {
        throw new EntityNotFoundError("ResearchJob", researchJobId);
      }
      if (source === null) {
        throw new EntityNotFoundError("SourceDocument", sourceDocumentId);
      }
      if (
        source.researchJobId !== researchJobId ||
        source.processingStatus !== "PROCESSING" ||
        source.processingAttempt !== pipelineAttempt
      ) {
        throw new PersistenceConflictError(
          "SourceDocument is not in the expected record-processing generation",
        );
      }
      if (source.rawContent === null) {
        throw new PersistenceValidationError(
          "SourceDocument must contain fetched content before extraction",
        );
      }
      const extractionSchema =
        researchJob.extractionSchema as unknown as JsonObject;
      for (const input of validatedInputs) {
        if (
          input.researchJobId !== researchJobId ||
          input.sourceDocumentId !== sourceDocumentId
        ) {
          throw new PersistenceConflictError(
            "Every extracted record must belong to the supplied source and research job",
          );
        }
        assertStructuredDataMatchesSchema(
          extractionSchema,
          input.structuredData,
        );
        assertEvidenceMatchesContent(input.evidence, source.rawContent);
      }
      await transaction.extractedRecord.deleteMany({
        where: { sourceDocumentId },
      });
      if (validatedInputs.length > 0) {
        await transaction.extractedRecord.createMany({
          data: validatedInputs.map((input) => ({
            researchJobId,
            sourceDocumentId,
            recordType: input.recordType,
            structuredData: input.structuredData as Prisma.InputJsonObject,
            normalizedData: input.normalizedData as Prisma.InputJsonObject,
            evidence: input.evidence as Prisma.InputJsonArray,
            sourceAttributions:
              input.sourceAttributions as Prisma.InputJsonArray,
            confidenceScore: input.confidenceScore,
            relevanceScore: input.relevanceScore,
            scoreExplanation: input.scoreExplanation as Prisma.InputJsonObject,
            deduplicationKey: input.deduplicationKey,
            reviewRequired: input.reviewRequired,
            conflictDetails: input.conflictDetails as Prisma.InputJsonArray,
          })),
        });
      }
      await transaction.sourceDocument.update({
        where: { id: sourceDocumentId },
        data: {
          llmProvider: tracking.provider,
          llmModel: tracking.model,
          llmUsage: tracking.usage as Prisma.InputJsonObject,
          llmMetadata: tracking.metadata as Prisma.InputJsonObject,
          llmProcessedAt: new Date(),
        },
      });
      return validatedInputs.length;
    });
  }
}

function fromValidatedInput(
  input: ValidatedExtractedRecordCreateInput,
): ProcessedHiringSignal {
  return {
    original: parseHiringSignal(input.structuredData, input.confidenceScore),
    normalized: parseNormalizedData(input.normalizedData),
    attributions: input.sourceAttributions,
    confidenceScore: input.confidenceScore,
    relevanceScore: input.relevanceScore,
    scoreExplanation:
      input.scoreExplanation as unknown as RelevanceScoreExplanation,
    deduplicationKey: input.deduplicationKey,
    reviewRequired: input.reviewRequired,
    conflicts: input.conflictDetails,
  };
}

function fromStoredRecord(record: ExtractedRecord): CanonicalRecord {
  const structuredData = record.structuredData as JsonObject;
  return {
    id: record.id,
    primarySourceDocumentId: record.sourceDocumentId,
    recordType: record.recordType,
    structuredKeys: Object.keys(structuredData),
    record: {
      original: parseHiringSignal(structuredData, record.confidenceScore),
      normalized: parseNormalizedData(record.normalizedData as JsonObject),
      attributions: sourceAttributionSchema
        .array()
        .parse(record.sourceAttributions) as SourceAttribution[],
      confidenceScore: record.confidenceScore,
      relevanceScore: record.relevanceScore,
      scoreExplanation:
        record.scoreExplanation as unknown as RelevanceScoreExplanation,
      deduplicationKey: record.deduplicationKey,
      reviewRequired: record.reviewRequired,
      conflicts: recordConflictSchema
        .array()
        .parse(record.conflictDetails ?? []) as RecordConflict[],
    },
  };
}

function parseHiringSignal(
  data: JsonObject,
  confidenceScore: number,
): HiringSignalValue {
  return {
    company: requiredString(data, "company"),
    website: nullableString(data, "website"),
    role: nullableString(data, "role"),
    location: nullableString(data, "location"),
    signal: requiredString(data, "signal"),
    sourceUrl: requiredString(data, "sourceUrl"),
    evidence: requiredString(data, "evidence"),
    confidenceScore,
  };
}

function parseNormalizedData(data: JsonObject): NormalizedHiringSignal {
  const variants = data.originalVariants;
  if (
    typeof variants !== "object" ||
    variants === null ||
    Array.isArray(variants)
  ) {
    throw new PersistenceValidationError(
      "normalizedData.originalVariants must be an object",
    );
  }
  return {
    company: requiredString(data, "company"),
    role: requiredString(data, "role"),
    domain: requiredString(data, "domain"),
    sourceUrl: requiredString(data, "sourceUrl"),
    location: requiredString(data, "location"),
    signal: requiredString(data, "signal"),
    originalVariants: {
      companies: stringArray(variants, "companies"),
      websites: stringArray(variants, "websites"),
      roles: stringArray(variants, "roles"),
      locations: stringArray(variants, "locations"),
      signals: stringArray(variants, "signals"),
    },
  };
}

function toPersistenceData(
  canonical: CanonicalRecord,
): CanonicalPersistenceData {
  const { record } = canonical;
  return {
    recordType: canonical.recordType,
    structuredData: structuredDataForKeys(
      canonical.structuredKeys,
      record.original,
    ) as Prisma.InputJsonObject,
    normalizedData: record.normalized as unknown as Prisma.InputJsonObject,
    evidence: record.attributions.flatMap((attribution) =>
      attribution.evidence.map((quote) => ({ quote })),
    ) as Prisma.InputJsonArray,
    sourceAttributions: record.attributions as unknown as Prisma.InputJsonArray,
    confidenceScore: record.confidenceScore,
    relevanceScore: record.relevanceScore,
    scoreExplanation:
      record.scoreExplanation as unknown as Prisma.InputJsonObject,
    deduplicationKey: record.deduplicationKey,
    reviewRequired: record.reviewRequired,
    conflictDetails: record.conflicts as unknown as Prisma.InputJsonArray,
  };
}

function structuredDataForKeys(
  keys: readonly string[],
  record: HiringSignalValue,
): JsonObject {
  const values: JsonObject = {
    company: record.company,
    website: record.website,
    role: record.role,
    location: record.location,
    signal: record.signal,
    sourceUrl: record.sourceUrl,
    evidence: record.evidence,
    confidenceScore: record.confidenceScore,
  };
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = values[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function requiredString(data: JsonObject, key: string): string {
  const value = data[key];
  if (typeof value !== "string") {
    throw new PersistenceValidationError(`${key} must be a string`);
  }
  return value;
}

function nullableString(data: JsonObject, key: string): string | null {
  const value = data[key];
  if (value !== null && typeof value !== "string") {
    throw new PersistenceValidationError(`${key} must be a string or null`);
  }
  return value;
}

function stringArray(data: JsonObject, key: string): string[] {
  const value = data[key];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new PersistenceValidationError(`${key} must be an array of strings`);
  }
  return value as string[];
}
