import {
  persistenceIdSchema,
  researchJobCreateInputSchema,
  researchJobProgressInputSchema,
  type ResearchJobCreateInput,
  type ResearchJobProgressInput,
} from "@signalforge/schemas";

import type {
  Prisma,
  PrismaClient,
  ResearchJob,
} from "../generated/prisma/client.js";
import { EntityNotFoundError, PersistenceValidationError } from "../errors.js";
import { assertValidExtractionSchema } from "../validation/extraction-schema.js";

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

  public async findById(id: string): Promise<ResearchJob | null> {
    const validatedId = persistenceIdSchema.parse(id);
    return this.prisma.researchJob.findUnique({ where: { id: validatedId } });
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
}
