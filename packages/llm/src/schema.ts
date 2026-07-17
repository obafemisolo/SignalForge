import { z } from "zod";
import { supportedHiringSignalFields } from "@signalforge/schemas";

const publicHttpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use HTTP or HTTPS");

export const hiringSignalSchema = z
  .object({
    company: z.string().trim().min(1).max(300),
    website: publicHttpUrlSchema.nullable(),
    role: z.string().trim().min(1).max(500).nullable(),
    location: z.string().trim().min(1).max(500).nullable(),
    signal: z.string().trim().min(1).max(2_000),
    sourceUrl: publicHttpUrlSchema,
    evidence: z.string().trim().min(1).max(1_000),
    confidenceScore: z.number().finite().min(0).max(1),
  })
  .strict();

export const hiringSignalEnvelopeSchema = z
  .object({
    records: z.array(hiringSignalSchema).max(100),
  })
  .strict();

export type HiringSignal = z.infer<typeof hiringSignalSchema>;
export type HiringSignalEnvelope = z.infer<typeof hiringSignalEnvelopeSchema>;

export const HIRING_SIGNAL_RECORD_TYPE = "companyHiringSignal";
export const HIRING_SIGNAL_STRUCTURED_FIELDS = supportedHiringSignalFields;
