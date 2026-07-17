import { z } from "zod";

const postgresUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    "DATABASE_URL must use the postgres or postgresql protocol",
  );

const redisUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => ["redis:", "rediss:"].includes(new URL(value).protocol),
    "REDIS_URL must use the redis or rediss protocol",
  );

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "URL must use the http or https protocol",
  );

const booleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(10_000_000)
      .default(1_048_576),
    API_MAX_SOURCES: z.coerce.number().int().min(1).max(100).default(20),
    API_JOB_CREATION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    API_JOB_CREATION_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(60_000),
    WORKER_ORCHESTRATION_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(2),
    WORKER_SOURCE_FETCH_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(5),
    WORKER_CONTENT_EXTRACTION_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(4),
    WORKER_RECORD_PROCESSING_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(4),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(10_000),
    WORKER_HEARTBEAT_TTL_MS: z.coerce.number().int().min(5_000).default(30_000),
    WORKER_STALLED_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .default(30_000),
    WORKER_MAX_STALLED_COUNT: z.coerce.number().int().min(1).max(10).default(2),
    WORKER_LOCK_DURATION_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .default(120_000),
    WORKER_METRICS_HOST: z.string().min(1).default("0.0.0.0"),
    WORKER_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(9464),
    READINESS_WORKER_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(25_000),
    QUEUE_COMPLETED_RETENTION_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(86_400),
    QUEUE_COMPLETED_RETENTION_COUNT: z.coerce
      .number()
      .int()
      .min(100)
      .default(10_000),
    QUEUE_FAILED_RETENTION_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(604_800),
    QUEUE_FAILED_RETENTION_COUNT: z.coerce
      .number()
      .int()
      .min(100)
      .default(20_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
    QUEUE_ORCHESTRATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(30_000),
    QUEUE_SOURCE_FETCH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(30_000),
    QUEUE_CONTENT_EXTRACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(60_000),
    QUEUE_RECORD_PROCESSING_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(90_000),
    EXTRACTION_MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(20_000_000)
      .default(2_000_000),
    EXTRACTION_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
    EXTRACTION_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(250)
      .default(10_000),
    EXTRACTION_TOTAL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(30_000),
    EXTRACTION_GLOBAL_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    EXTRACTION_DOMAIN_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(2),
    EXTRACTION_DOMAIN_DELAY_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(500),
    EXTRACTION_MIN_CONTENT_CHARS: z.coerce.number().int().min(50).default(200),
    EXTRACTION_PLAYWRIGHT_ENABLED:
      booleanEnvironmentValueSchema.default("true"),
    EXTRACTION_USER_AGENT: z
      .string()
      .trim()
      .min(10)
      .max(300)
      .default(
        "SignalForgeBot/0.1 (controlled public web research; respects robots.txt)",
      ),
    LLM_BASE_URL: httpUrlSchema.default("https://api.openai.com/v1"),
    LLM_API_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().min(1).optional(),
    ),
    LLM_MODEL: z.string().trim().min(1).max(200).default("gpt-4.1-mini"),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
    LLM_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(100)
      .max(32_000)
      .default(2_000),
    LLM_MAX_CHUNK_CHARS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(100_000)
      .default(12_000),
    LLM_MAX_CHUNKS: z.coerce.number().int().min(1).max(100).default(25),
    LLM_INPUT_COST_PER_MILLION_TOKENS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().finite().nonnegative().optional(),
    ),
    LLM_OUTPUT_COST_PER_MILLION_TOKENS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().finite().nonnegative().optional(),
    ),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: postgresUrlSchema,
    REDIS_URL: redisUrlSchema,
  })
  .superRefine((environment, context) => {
    if (
      environment.WORKER_HEARTBEAT_TTL_MS <=
      environment.WORKER_HEARTBEAT_INTERVAL_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WORKER_HEARTBEAT_TTL_MS"],
        message: "must be greater than WORKER_HEARTBEAT_INTERVAL_MS",
      });
    }
    if (
      environment.READINESS_WORKER_MAX_AGE_MS >=
      environment.WORKER_HEARTBEAT_TTL_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["READINESS_WORKER_MAX_AGE_MS"],
        message: "must be less than WORKER_HEARTBEAT_TTL_MS",
      });
    }
  })
  .readonly();

export type Environment = z.infer<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: readonly z.ZodIssue[];

  public constructor(issues: readonly z.ZodIssue[]) {
    const details = issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");

    super(`Invalid environment configuration: ${details}`);
    this.name = "EnvironmentValidationError";
    this.issues = [...issues];
  }
}

export function loadEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return result.data;
}
