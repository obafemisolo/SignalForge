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

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: postgresUrlSchema,
    REDIS_URL: redisUrlSchema,
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
