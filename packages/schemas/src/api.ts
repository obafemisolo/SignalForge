import { z } from "zod";

import { evidenceItemSchema, persistenceIdSchema } from "./persistence.js";

export const researchJobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);

export const researchExtractionContractSchema = z
  .object({
    type: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u),
    fields: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u),
      )
      .min(1)
      .max(100)
      .refine(
        (fields) => new Set(fields).size === fields.length,
        "schema.fields must not contain duplicates",
      ),
  })
  .strict();

const submittedSourceSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source URL must use the http or https protocol",
      });
    }

    if (url.username !== "" || url.password !== "") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source URL must not contain credentials",
      });
    }
  });

export function createResearchJobRequestSchema(maxSources: number) {
  return z
    .object({
      query: z.string().trim().min(1).max(10_000),
      sources: z
        .array(submittedSourceSchema)
        .min(1)
        .max(maxSources)
        .refine(
          (sources) => new Set(sources).size === sources.length,
          "sources must not contain duplicates",
        ),
      schema: researchExtractionContractSchema,
    })
    .strict();
}

export const researchJobParamsSchema = z
  .object({ jobId: persistenceIdSchema })
  .strict();

export const resultsPaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const idempotencyHeadersSchema = z
  .object({
    "idempotency-key": z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7E]+$/u, "Idempotency-Key must contain visible ASCII"),
  })
  .partial()
  .passthrough();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().uuid(),
});

export const jobAcceptedDataSchema = z.object({
  id: persistenceIdSchema,
  status: researchJobStatusSchema,
  createdAt: z.string().datetime(),
  statusUrl: z.string(),
});

export const jobStatusDataSchema = z.object({
  id: persistenceIdSchema,
  query: z.string(),
  requestedSources: z.array(z.string().url()),
  extractionSchema: z.record(z.unknown()),
  status: researchJobStatusSchema,
  progress: z.object({
    totalSources: z.number().int().nonnegative(),
    successfulSources: z.number().int().nonnegative(),
    failedSources: z.number().int().nonnegative(),
    duplicatesRemoved: z.number().int().nonnegative(),
  }),
  errors: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        sourceUrl: z.string().url(),
        errorCode: z.string().nullable(),
        errorMessage: z.string().nullable(),
      }),
    ),
  }),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const resultItemSchema = z.object({
  id: persistenceIdSchema,
  recordType: z.string(),
  structuredData: z.record(z.unknown()),
  evidence: z.array(evidenceItemSchema),
  confidenceScore: z.number().min(0).max(1),
  relevanceScore: z.number().min(0).max(1),
  source: z.object({
    url: z.string().url(),
    normalizedUrl: z.string().url(),
    domain: z.string(),
    title: z.string().nullable(),
  }),
  createdAt: z.string().datetime(),
});

export const paginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type ResearchExtractionContract = z.infer<
  typeof researchExtractionContractSchema
>;
export type ResearchJobRequest = z.infer<
  ReturnType<typeof createResearchJobRequestSchema>
>;
export type ResultsPaginationQuery = z.infer<
  typeof resultsPaginationQuerySchema
>;
