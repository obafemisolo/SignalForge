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

export const extractedRecordCreateInputSchema = z
  .object({
    researchJobId: persistenceIdSchema,
    sourceDocumentId: persistenceIdSchema,
    recordType: z.string().trim().min(1).max(100),
    structuredData: jsonObjectSchema,
    evidence: z.array(evidenceItemSchema).min(1).max(50),
    confidenceScore: z.number().finite().min(0).max(1),
    relevanceScore: z.number().finite().min(0).max(1),
    deduplicationKey: z.string().trim().min(1).max(256),
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
export type ExtractedRecordCreateInput = z.infer<
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
