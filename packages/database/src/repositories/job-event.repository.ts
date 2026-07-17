import {
  jobEventCreateInputSchema,
  persistenceIdSchema,
  type JobEventCreateInput,
} from "@signalforge/schemas";

import type {
  Prisma,
  JobEvent,
  PrismaClient,
} from "../generated/prisma/client.js";
import { PersistenceValidationError } from "../errors.js";

export class JobEventRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async append(input: JobEventCreateInput): Promise<JobEvent> {
    const validated = jobEventCreateInputSchema.parse(input);

    return this.prisma.jobEvent.create({
      data: {
        researchJobId: validated.researchJobId,
        eventType: validated.eventType,
        payload: validated.payload as Prisma.InputJsonObject,
      },
    });
  }

  public async listForJob(
    researchJobId: string,
    limit = 100,
  ): Promise<JobEvent[]> {
    const validatedResearchJobId = persistenceIdSchema.parse(researchJobId);

    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new PersistenceValidationError(
        "Job event list limit must be an integer between 1 and 1000",
      );
    }

    return this.prisma.jobEvent.findMany({
      where: { researchJobId: validatedResearchJobId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
