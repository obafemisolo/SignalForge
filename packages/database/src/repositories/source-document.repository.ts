import {
  persistenceIdSchema,
  sourceDocumentCreateInputSchema,
  sourceDocumentFailureInputSchema,
  sourceDocumentSuccessInputSchema,
  type SourceDocumentCreateInput,
  type SourceDocumentFailureInput,
  type SourceDocumentSuccessInput,
} from "@signalforge/schemas";

import {
  Prisma,
  SourceFetchStatus,
  type PrismaClient,
  type SourceDocument,
} from "../generated/prisma/client.js";
import { EntityNotFoundError } from "../errors.js";

export class SourceDocumentRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createOrGet(
    input: SourceDocumentCreateInput,
  ): Promise<SourceDocument> {
    const validated = sourceDocumentCreateInputSchema.parse(input);

    return this.prisma.sourceDocument.upsert({
      where: {
        researchJobId_normalizedUrl: {
          researchJobId: validated.researchJobId,
          normalizedUrl: validated.normalizedUrl,
        },
      },
      update: {},
      create: validated,
    });
  }

  public async markFetching(id: string): Promise<SourceDocument> {
    await this.assertExists(id);

    return this.prisma.sourceDocument.update({
      where: { id },
      data: {
        fetchStatus: SourceFetchStatus.FETCHING,
        processingStatus: "FETCHING",
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  public async markSucceeded(
    id: string,
    input: SourceDocumentSuccessInput,
  ): Promise<SourceDocument> {
    const validated = sourceDocumentSuccessInputSchema.parse(input);
    await this.assertExists(id);

    return this.prisma.sourceDocument.update({
      where: { id },
      data: {
        fetchStatus: SourceFetchStatus.SUCCEEDED,
        processingStatus: "SUCCEEDED",
        rawContent: validated.rawContent,
        contentHash: validated.contentHash,
        httpStatus: validated.httpStatus,
        canonicalUrl: validated.canonicalUrl,
        metadata: validated.metadata as Prisma.InputJsonObject,
        outboundLinks: validated.outboundLinks,
        fetchDurationMs: validated.fetchDurationMs,
        fetchMode: validated.fetchMode,
        fetchedAt: validated.fetchedAt,
        ...(validated.title !== undefined ? { title: validated.title } : {}),
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  public async markFailed(
    id: string,
    input: SourceDocumentFailureInput,
  ): Promise<SourceDocument> {
    const validated = sourceDocumentFailureInputSchema.parse(input);
    await this.assertExists(id);

    return this.prisma.sourceDocument.update({
      where: { id },
      data: {
        fetchStatus: validated.fetchStatus,
        processingStatus: "FAILED",
        fetchedAt: validated.fetchedAt,
        errorCode: validated.errorCode,
        errorMessage: validated.errorMessage,
        ...(validated.httpStatus !== undefined
          ? { httpStatus: validated.httpStatus }
          : {}),
        rawContent: null,
        contentHash: null,
      },
    });
  }

  private async assertExists(id: string): Promise<void> {
    const validatedId = persistenceIdSchema.parse(id);
    const source = await this.prisma.sourceDocument.findUnique({
      where: { id: validatedId },
      select: { id: true },
    });

    if (source === null) {
      throw new EntityNotFoundError("SourceDocument", id);
    }
  }
}
