import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> =
  z.record(jsonValueSchema);
export const persistenceIdSchema = z.string().uuid();

const publicHttpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use the http or https protocol");

export const researchJobCreateInputSchema = z
  .object({
    query: z.string().trim().min(1).max(10_000),
    requestedSources: z
      .array(publicHttpUrlSchema)
      .min(1)
      .max(100)
      .refine(
        (sources) => new Set(sources).size === sources.length,
        "requestedSources must not contain duplicates",
      ),
    extractionSchema: jsonObjectSchema,
  })
  .strict();

export const sourceDocumentCreateInputSchema = z
  .object({
    researchJobId: persistenceIdSchema,
    sourceUrl: publicHttpUrlSchema,
    normalizedUrl: publicHttpUrlSchema,
    domain: z.string().trim().min(1).max(253),
  })
  .strict();

export const evidenceItemSchema = z
  .object({
    quote: z.string().trim().min(1).max(4_000),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (evidence) =>
      (evidence.startOffset === undefined &&
        evidence.endOffset === undefined) ||
      (evidence.startOffset !== undefined &&
        evidence.endOffset !== undefined &&
        evidence.endOffset > evidence.startOffset),
    "startOffset and endOffset must be provided together and form a valid range",
  );

export const sourceAttributionSchema = z
  .object({
    sourceDocumentId: persistenceIdSchema,
    sourceUrl: publicHttpUrlSchema,
    evidence: z.array(z.string().trim().min(1).max(4_000)).min(1).max(50),
    publishedAt: z.string().datetime().nullable(),
    credibilityScore: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

export const recordConflictSchema = z
  .object({
    type: z.enum([
      "DOMAIN_MISMATCH",
      "LOCATION_MISMATCH",
      "SIGNAL_POLARITY_MISMATCH",
    ]),
    fields: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
    message: z.string().trim().min(1).max(1_000),
    otherDeduplicationKey: z.string().trim().min(1).max(256),
  })
  .strict();

const scoreComponentSchema = z
  .object({
    score: z.number().finite().min(0).max(1),
    weight: z.number().finite().min(0).max(1),
    weightedScore: z.number().finite().min(0).max(1),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const relevanceScoreExplanationSchema = z.union([
  z
    .object({
      version: z.literal("v1"),
      total: z.number().finite().min(0).max(1),
      components: z
        .object({
          queryKeywordOverlap: scoreComponentSchema,
          requiredFieldCompleteness: scoreComponentSchema,
          confidence: scoreComponentSchema,
          sourceFreshness: scoreComponentSchema,
          sourceCredibility: scoreComponentSchema,
          evidenceDirectness: scoreComponentSchema,
        })
        .strict(),
    })
    .strict(),
  z.object({}).strict(),
]);

export const extractedRecordCreateInputSchema = z
  .object({
    researchJobId: persistenceIdSchema,
    sourceDocumentId: persistenceIdSchema,
    recordType: z.string().trim().min(1).max(100),
    structuredData: jsonObjectSchema,
    normalizedData: jsonObjectSchema.default({}),
    evidence: z.array(evidenceItemSchema).min(1).max(50),
    sourceAttributions: z
      .array(sourceAttributionSchema)
      .min(1)
      .max(100)
      .default([]),
    confidenceScore: z.number().finite().min(0).max(1),
    relevanceScore: z.number().finite().min(0).max(1),
    scoreExplanation: relevanceScoreExplanationSchema.default({}),
    deduplicationKey: z.string().trim().min(1).max(256),
    reviewRequired: z.boolean().default(false),
    conflictDetails: z.array(recordConflictSchema).max(100).default([]),
  })
  .strict();

export const jobEventCreateInputSchema = z
  .object({
    researchJobId: persistenceIdSchema,
    eventType: z.string().trim().min(1).max(100),
    payload: jsonObjectSchema,
  })
  .strict();

export const sourceDocumentSuccessInputSchema = z
  .object({
    title: z.string().trim().min(1).max(10_000).optional(),
    rawContent: z.string().min(1).max(5_000_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    httpStatus: z.number().int().min(100).max(599),
    canonicalUrl: publicHttpUrlSchema.optional(),
    metadata: jsonObjectSchema.default({}),
    outboundLinks: z.array(publicHttpUrlSchema).max(200).default([]),
    fetchDurationMs: z.number().int().nonnegative().default(0),
    fetchMode: z.enum(["HTTP", "PLAYWRIGHT"]).default("HTTP"),
    fetchedAt: z.date().default(() => new Date()),
  })
  .strict();

export const sourceDocumentFailureInputSchema = z
  .object({
    fetchStatus: z.enum(["FAILED", "BLOCKED", "SKIPPED"]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    fetchDurationMs: z.number().int().nonnegative().optional(),
    fetchMode: z.enum(["HTTP", "PLAYWRIGHT"]).optional(),
    fetchedAt: z.date().default(() => new Date()),
    errorCode: z.string().trim().min(1).max(100),
    errorMessage: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const researchJobProgressInputSchema = z
  .object({
    status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED"]),
    successfulSources: z.number().int().nonnegative(),
    failedSources: z.number().int().nonnegative(),
    duplicatesRemoved: z.number().int().nonnegative(),
    startedAt: z.date().nullable().optional(),
    completedAt: z.date().nullable().optional(),
  })
  .strict();

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type ExtractedRecordCreateInput = z.input<
  typeof extractedRecordCreateInputSchema
>;
export type ValidatedExtractedRecordCreateInput = z.output<
  typeof extractedRecordCreateInputSchema
>;
export type JobEventCreateInput = z.infer<typeof jobEventCreateInputSchema>;
export type ResearchJobCreateInput = z.infer<
  typeof researchJobCreateInputSchema
>;
export type ResearchJobProgressInput = z.infer<
  typeof researchJobProgressInputSchema
>;
export type SourceDocumentFailureInput = z.input<
  typeof sourceDocumentFailureInputSchema
>;
export type SourceDocumentCreateInput = z.infer<
  typeof sourceDocumentCreateInputSchema
>;
export type SourceDocumentSuccessInput = z.input<
  typeof sourceDocumentSuccessInputSchema
>;
