import {
  extractedRecordCreateInputSchema,
  type EvidenceItem,
  type ExtractedRecordCreateInput,
  type JsonObject,
} from "@signalforge/schemas";

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
          evidence: validated.evidence as Prisma.InputJsonArray,
          confidenceScore: validated.confidenceScore,
          relevanceScore: validated.relevanceScore,
          deduplicationKey: validated.deduplicationKey,
        },
      });
    });
  }
}
