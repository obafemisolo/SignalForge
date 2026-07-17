import {
  persistenceIdSchema,
  sourceDocumentSuccessInputSchema,
  type JsonObject,
  type SourceDocumentSuccessInput,
} from "@signalforge/schemas";

import {
  Prisma,
  type PrismaClient,
  type ResearchJob,
  type SourceDocument,
  type SourceProcessingStatus,
} from "../generated/prisma/client.js";
import { EntityNotFoundError } from "../errors.js";
import {
  calculateResearchProgress,
  type ResearchProgressCalculation,
} from "../progress.js";

const sourceIdsSchema = persistenceIdSchema.array().min(1);

export interface OrchestrationSource {
  id: string;
  normalizedUrl: string;
  processingAttempt: number;
  processingStatus: SourceProcessingStatus;
}

export interface OrchestrationWork {
  job: ResearchJob;
  sources: OrchestrationSource[];
}

export interface PipelineFailureInput {
  queueName: string;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  fetchFailed: boolean;
  httpStatus?: number;
  fetchDurationMs?: number;
  fetchMode?: "HTTP" | "PLAYWRIGHT";
  fetchStatus?: "FAILED" | "BLOCKED" | "SKIPPED";
  errorDetails?: JsonObject;
}

export class PipelineRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async startOrchestration(
    researchJobId: string,
    sourceDocumentIds?: readonly string[],
  ): Promise<OrchestrationWork> {
    const jobId = persistenceIdSchema.parse(researchJobId);
    const validatedSourceIds =
      sourceDocumentIds === undefined
        ? undefined
        : sourceIdsSchema.parse(sourceDocumentIds);

    return this.prisma.$transaction(async (transaction) => {
      const job = await this.lockResearchJob(transaction, jobId);
      const sources = await transaction.sourceDocument.findMany({
        where: {
          researchJobId: jobId,
          ...(validatedSourceIds === undefined
            ? {}
            : { id: { in: validatedSourceIds } }),
          processingStatus: { in: ["PENDING", "FETCHING"] },
        },
        select: {
          id: true,
          normalizedUrl: true,
          processingAttempt: true,
          processingStatus: true,
        },
        orderBy: { createdAt: "asc" },
      });

      if (
        sources.length === 0 &&
        ["COMPLETED", "PARTIAL", "FAILED"].includes(job.status)
      ) {
        return { job, sources };
      }

      const updatedJob = await transaction.researchJob.update({
        where: { id: jobId },
        data: {
          status: "RUNNING",
          startedAt: job.startedAt ?? new Date(),
          completedAt: null,
        },
      });
      await transaction.jobEvent.create({
        data: {
          researchJobId: jobId,
          eventType: "research_job.orchestration_started",
          payload: {
            sourceDocumentIds: sources.map((source) => source.id),
            sourceCount: sources.length,
          },
        },
      });

      return { job: updatedJob, sources };
    });
  }

  public async findSource(id: string): Promise<SourceDocument | null> {
    const sourceId = persistenceIdSchema.parse(id);
    return this.prisma.sourceDocument.findUnique({ where: { id: sourceId } });
  }

  public async markFetchStarted(
    sourceDocumentId: string,
    pipelineAttempt: number,
  ): Promise<boolean> {
    return this.transitionSource(
      sourceDocumentId,
      pipelineAttempt,
      ["PENDING", "FETCHING"],
      "FETCHING",
      "source.fetch_started",
      { fetchStatus: "FETCHING", errorCode: null, errorMessage: null },
    );
  }

  public async markFetchSucceeded(
    sourceDocumentId: string,
    pipelineAttempt: number,
    input: SourceDocumentSuccessInput,
  ): Promise<boolean> {
    const sourceId = persistenceIdSchema.parse(sourceDocumentId);
    const validated = sourceDocumentSuccessInputSchema.parse(input);
    const result = await this.prisma.sourceDocument.updateMany({
      where: {
        id: sourceId,
        processingAttempt: pipelineAttempt,
        processingStatus: "FETCHING",
      },
      data: {
        processingStatus: "EXTRACTING",
        fetchStatus: "SUCCEEDED",
        rawContent: validated.rawContent,
        contentHash: validated.contentHash,
        httpStatus: validated.httpStatus,
        ...(validated.canonicalUrl === undefined
          ? {}
          : { canonicalUrl: validated.canonicalUrl }),
        metadata: validated.metadata as Prisma.InputJsonObject,
        outboundLinks: validated.outboundLinks,
        fetchDurationMs: validated.fetchDurationMs,
        fetchMode: validated.fetchMode,
        fetchedAt: validated.fetchedAt,
        ...(validated.title === undefined ? {} : { title: validated.title }),
        errorCode: null,
        errorMessage: null,
      },
    });

    if (result.count > 0) {
      await this.appendSourceEvent(
        sourceId,
        "source.fetch_succeeded",
        pipelineAttempt,
      );
    }
    return result.count > 0;
  }

  public async markExtractionSucceeded(
    sourceDocumentId: string,
    pipelineAttempt: number,
  ): Promise<boolean> {
    return this.transitionSource(
      sourceDocumentId,
      pipelineAttempt,
      ["EXTRACTING"],
      "PROCESSING",
      "content.extraction_succeeded",
    );
  }

  public async completeSource(
    sourceDocumentId: string,
    pipelineAttempt: number,
  ): Promise<ResearchProgressCalculation | null> {
    const sourceId = persistenceIdSchema.parse(sourceDocumentId);
    return this.prisma.$transaction(async (transaction) => {
      const source = await transaction.sourceDocument.findUnique({
        where: { id: sourceId },
      });
      if (source === null) {
        throw new EntityNotFoundError("SourceDocument", sourceId);
      }

      await this.lockResearchJob(transaction, source.researchJobId);
      const updated = await transaction.sourceDocument.updateMany({
        where: {
          id: sourceId,
          processingAttempt: pipelineAttempt,
          processingStatus: "PROCESSING",
        },
        data: {
          processingStatus: "SUCCEEDED",
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count === 0) {
        return null;
      }

      await transaction.jobEvent.create({
        data: {
          researchJobId: source.researchJobId,
          eventType: "source.processing_succeeded",
          payload: { sourceDocumentId: sourceId, pipelineAttempt },
        },
      });
      return this.recalculateProgress(transaction, source.researchJobId);
    });
  }

  public async failSource(
    sourceDocumentId: string,
    pipelineAttempt: number,
    input: PipelineFailureInput,
  ): Promise<ResearchProgressCalculation | null> {
    const sourceId = persistenceIdSchema.parse(sourceDocumentId);
    return this.prisma.$transaction(async (transaction) => {
      const source = await transaction.sourceDocument.findUnique({
        where: { id: sourceId },
      });
      if (source === null) {
        throw new EntityNotFoundError("SourceDocument", sourceId);
      }

      await this.lockResearchJob(transaction, source.researchJobId);
      const updated = await transaction.sourceDocument.updateMany({
        where: {
          id: sourceId,
          processingAttempt: pipelineAttempt,
          processingStatus: {
            notIn: ["SUCCEEDED", "FAILED"],
          },
        },
        data: {
          processingStatus: "FAILED",
          ...(input.fetchFailed
            ? { fetchStatus: input.fetchStatus ?? ("FAILED" as const) }
            : {}),
          ...(input.httpStatus === undefined
            ? {}
            : { httpStatus: input.httpStatus }),
          ...(input.fetchDurationMs === undefined
            ? {}
            : { fetchDurationMs: input.fetchDurationMs }),
          ...(input.fetchMode === undefined
            ? {}
            : { fetchMode: input.fetchMode }),
          fetchedAt: new Date(),
          errorCode: input.errorCode.slice(0, 100),
          errorMessage: input.errorMessage.slice(0, 10_000),
        },
      });
      if (updated.count === 0) {
        return null;
      }

      await transaction.jobEvent.create({
        data: {
          researchJobId: source.researchJobId,
          eventType: "source.processing_failed",
          payload: {
            sourceDocumentId: sourceId,
            pipelineAttempt,
            queueName: input.queueName,
            jobId: input.jobId,
            errorCode: input.errorCode,
            ...(input.errorDetails === undefined
              ? {}
              : { details: input.errorDetails }),
          },
        },
      });
      return this.recalculateProgress(transaction, source.researchJobId);
    });
  }

  public async failOrchestration(
    researchJobId: string,
    jobId: string,
    errorMessage: string,
  ): Promise<ResearchProgressCalculation> {
    const validatedId = persistenceIdSchema.parse(researchJobId);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockResearchJob(transaction, validatedId);
      await transaction.sourceDocument.updateMany({
        where: {
          researchJobId: validatedId,
          processingStatus: { notIn: ["SUCCEEDED", "FAILED"] },
        },
        data: {
          processingStatus: "FAILED",
          fetchStatus: "FAILED",
          fetchedAt: new Date(),
          errorCode: "ORCHESTRATION_FAILED",
          errorMessage: errorMessage.slice(0, 10_000),
        },
      });
      await transaction.jobEvent.create({
        data: {
          researchJobId: validatedId,
          eventType: "research_job.orchestration_failed",
          payload: { jobId },
        },
      });
      return this.recalculateProgress(transaction, validatedId);
    });
  }

  private async transitionSource(
    sourceDocumentId: string,
    pipelineAttempt: number,
    from: SourceProcessingStatus[],
    to: SourceProcessingStatus,
    eventType: string,
    additionalData: Prisma.SourceDocumentUpdateManyMutationInput = {},
  ): Promise<boolean> {
    const sourceId = persistenceIdSchema.parse(sourceDocumentId);
    const result = await this.prisma.sourceDocument.updateMany({
      where: {
        id: sourceId,
        processingAttempt: pipelineAttempt,
        processingStatus: { in: from },
      },
      data: { ...additionalData, processingStatus: to },
    });

    if (result.count > 0) {
      await this.appendSourceEvent(sourceId, eventType, pipelineAttempt);
    }
    return result.count > 0;
  }

  private async appendSourceEvent(
    sourceDocumentId: string,
    eventType: string,
    pipelineAttempt: number,
  ): Promise<void> {
    const source = await this.prisma.sourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: { researchJobId: true },
    });
    if (source === null) {
      throw new EntityNotFoundError("SourceDocument", sourceDocumentId);
    }
    await this.prisma.jobEvent.create({
      data: {
        researchJobId: source.researchJobId,
        eventType,
        payload: { sourceDocumentId, pipelineAttempt },
      },
    });
  }

  private async recalculateProgress(
    transaction: Prisma.TransactionClient,
    researchJobId: string,
  ): Promise<ResearchProgressCalculation> {
    const [job, sources] = await Promise.all([
      transaction.researchJob.findUniqueOrThrow({
        where: { id: researchJobId },
      }),
      transaction.sourceDocument.findMany({
        where: { researchJobId },
        select: { processingStatus: true },
      }),
    ]);
    const progress = calculateResearchProgress(
      job.totalSources,
      sources.map((source) => source.processingStatus),
    );
    const completedAt = progress.isTerminal ? new Date() : null;

    await transaction.researchJob.update({
      where: { id: researchJobId },
      data: {
        status: progress.status,
        successfulSources: progress.successfulSources,
        failedSources: progress.failedSources,
        completedAt,
      },
    });
    await transaction.jobEvent.create({
      data: {
        researchJobId,
        eventType: progress.isTerminal
          ? "research_job.completed"
          : "research_job.progress_recalculated",
        payload: {
          successfulSources: progress.successfulSources,
          failedSources: progress.failedSources,
          terminalSources: progress.terminalSources,
          totalSources: job.totalSources,
          status: progress.status,
        },
      },
    });

    return progress;
  }

  private async lockResearchJob(
    transaction: Prisma.TransactionClient,
    researchJobId: string,
  ): Promise<ResearchJob> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "research_jobs" WHERE "id" = ${researchJobId}::uuid FOR UPDATE`,
    );
    if (rows.length === 0) {
      throw new EntityNotFoundError("ResearchJob", researchJobId);
    }
    return transaction.researchJob.findUniqueOrThrow({
      where: { id: researchJobId },
    });
  }
}
