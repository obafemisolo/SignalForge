import {
  persistenceIdSchema,
  researchJobCreateInputSchema,
  researchJobProgressInputSchema,
  type ResearchJobCreateInput,
  type ResearchJobProgressInput,
} from "@signalforge/schemas";

import type {
  ExtractedRecord,
  Prisma,
  PrismaClient,
  ResearchJob,
  SourceDocument,
} from "../generated/prisma/client.js";
import {
  EntityNotFoundError,
  PersistenceConflictError,
  PersistenceValidationError,
} from "../errors.js";
import { assertValidExtractionSchema } from "../validation/extraction-schema.js";

export interface ResearchSourceInput {
  sourceUrl: string;
  normalizedUrl: string;
  domain: string;
}

export interface IdempotentResearchJobInput {
  idempotencyKeyHash: string;
  requestFingerprint: string;
}

export interface ResearchJobCreationResult {
  job: ResearchJob;
  reused: boolean;
}

export interface ResearchJobErrorSummary {
  total: number;
  items: Array<{
    sourceUrl: string;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

export interface ResearchJobStatusView {
  job: ResearchJob;
  errors: ResearchJobErrorSummary;
}

export interface ResearchResultView extends ExtractedRecord {
  sourceDocument: Pick<
    SourceDocument,
    "sourceUrl" | "normalizedUrl" | "domain" | "title"
  >;
}

export interface ResearchResultsPage {
  records: ResearchResultView[];
  total: number;
}

export class ResearchJobRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(input: ResearchJobCreateInput): Promise<ResearchJob> {
    const validated = researchJobCreateInputSchema.parse(input);
    assertValidExtractionSchema(validated.extractionSchema);

    return this.prisma.researchJob.create({
      data: {
        query: validated.query,
        requestedSources: validated.requestedSources,
        extractionSchema: validated.extractionSchema as Prisma.InputJsonObject,
        totalSources: validated.requestedSources.length,
      },
    });
  }

  public async createWithSources(
    input: ResearchJobCreateInput,
    sources: readonly ResearchSourceInput[],
    idempotency?: IdempotentResearchJobInput,
  ): Promise<ResearchJobCreationResult> {
    const validated = researchJobCreateInputSchema.parse(input);
    assertValidExtractionSchema(validated.extractionSchema);

    if (sources.length !== validated.requestedSources.length) {
      throw new PersistenceValidationError(
        "Every requested source must have normalized source metadata",
      );
    }

    const createData = {
      query: validated.query,
      requestedSources: validated.requestedSources,
      extractionSchema: validated.extractionSchema as Prisma.InputJsonObject,
      totalSources: validated.requestedSources.length,
      ...(idempotency === undefined
        ? {}
        : {
            idempotencyKeyHash: idempotency.idempotencyKeyHash,
            requestFingerprint: idempotency.requestFingerprint,
          }),
      sourceDocuments: {
        create: sources.map((source) => ({
          sourceUrl: source.sourceUrl,
          normalizedUrl: source.normalizedUrl,
          domain: source.domain,
        })),
      },
      events: {
        create: {
          eventType: "research_job.created",
          payload: {
            totalSources: validated.requestedSources.length,
          },
        },
      },
    } satisfies Prisma.ResearchJobCreateInput;

    if (idempotency === undefined) {
      const job = await this.prisma.researchJob.create({ data: createData });
      return { job, reused: false };
    }

    const existing = await this.prisma.researchJob.findUnique({
      where: { idempotencyKeyHash: idempotency.idempotencyKeyHash },
    });

    if (existing !== null) {
      this.assertMatchingFingerprint(existing, idempotency.requestFingerprint);
      return { job: existing, reused: true };
    }

    const job = await this.prisma.researchJob.upsert({
      where: { idempotencyKeyHash: idempotency.idempotencyKeyHash },
      update: {},
      create: createData,
    });

    this.assertMatchingFingerprint(job, idempotency.requestFingerprint);

    return {
      job,
      reused: job.createdAt.getTime() !== job.updatedAt.getTime(),
    };
  }

  public async findById(id: string): Promise<ResearchJob | null> {
    const validatedId = persistenceIdSchema.parse(id);
    return this.prisma.researchJob.findUnique({ where: { id: validatedId } });
  }

  public async findStatus(id: string): Promise<ResearchJobStatusView | null> {
    const validatedId = persistenceIdSchema.parse(id);
    const [job, totalErrors, errors] = await this.prisma.$transaction([
      this.prisma.researchJob.findUnique({ where: { id: validatedId } }),
      this.prisma.sourceDocument.count({
        where: {
          researchJobId: validatedId,
          processingStatus: "FAILED",
        },
      }),
      this.prisma.sourceDocument.findMany({
        where: {
          researchJobId: validatedId,
          processingStatus: "FAILED",
        },
        select: {
          sourceUrl: true,
          errorCode: true,
          errorMessage: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
    ]);

    return job === null
      ? null
      : { job, errors: { total: totalErrors, items: errors } };
  }

  public async findResults(
    id: string,
    page: number,
    limit: number,
  ): Promise<ResearchResultsPage | null> {
    const validatedId = persistenceIdSchema.parse(id);
    const job = await this.prisma.researchJob.findUnique({
      where: { id: validatedId },
      select: { id: true },
    });

    if (job === null) {
      return null;
    }

    const [records, total] = await this.prisma.$transaction([
      this.prisma.extractedRecord.findMany({
        where: { researchJobId: validatedId },
        include: {
          sourceDocument: {
            select: {
              sourceUrl: true,
              normalizedUrl: true,
              domain: true,
              title: true,
            },
          },
        },
        orderBy: [{ relevanceScore: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.extractedRecord.count({
        where: { researchJobId: validatedId },
      }),
    ]);

    return { records, total };
  }

  public async prepareFailedSourcesForRetry(id: string): Promise<string[]> {
    const validatedId = persistenceIdSchema.parse(id);

    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.researchJob.findUnique({
        where: { id: validatedId },
      });

      if (job === null) {
        throw new EntityNotFoundError("ResearchJob", validatedId);
      }

      const failedSources = await transaction.sourceDocument.findMany({
        where: { researchJobId: validatedId, processingStatus: "FAILED" },
        select: { id: true },
      });

      if (failedSources.length === 0) {
        throw new PersistenceConflictError(
          "The research job has no failed sources to retry",
        );
      }

      const sourceDocumentIds = failedSources.map((source) => source.id);

      await transaction.sourceDocument.updateMany({
        where: { id: { in: sourceDocumentIds }, processingStatus: "FAILED" },
        data: {
          fetchStatus: "PENDING",
          processingStatus: "PENDING",
          processingAttempt: { increment: 1 },
          httpStatus: null,
          fetchedAt: null,
          errorCode: null,
          errorMessage: null,
          rawContent: null,
          contentHash: null,
        },
      });

      await transaction.researchJob.update({
        where: { id: validatedId },
        data: {
          status: "QUEUED",
          failedSources: Math.max(0, job.failedSources - failedSources.length),
          completedAt: null,
        },
      });

      await transaction.jobEvent.create({
        data: {
          researchJobId: validatedId,
          eventType: "research_job.retry_requested",
          payload: { sourceDocumentIds },
        },
      });

      return sourceDocumentIds;
    });
  }

  public async updateProgress(
    id: string,
    input: ResearchJobProgressInput,
  ): Promise<ResearchJob> {
    const validated = researchJobProgressInputSchema.parse(input);
    const existing = await this.findById(id);

    if (existing === null) {
      throw new EntityNotFoundError("ResearchJob", id);
    }

    if (
      validated.successfulSources + validated.failedSources >
      existing.totalSources
    ) {
      throw new PersistenceValidationError(
        "Successful and failed source counts cannot exceed totalSources",
      );
    }

    return this.prisma.researchJob.update({
      where: { id },
      data: {
        status: validated.status,
        successfulSources: validated.successfulSources,
        failedSources: validated.failedSources,
        duplicatesRemoved: validated.duplicatesRemoved,
        ...(validated.startedAt !== undefined
          ? { startedAt: validated.startedAt }
          : {}),
        ...(validated.completedAt !== undefined
          ? { completedAt: validated.completedAt }
          : {}),
      },
    });
  }

  private assertMatchingFingerprint(
    job: ResearchJob,
    requestFingerprint: string,
  ): void {
    if (job.requestFingerprint !== requestFingerprint) {
      throw new PersistenceConflictError(
        "The Idempotency-Key has already been used for a different request",
      );
    }
  }
}
