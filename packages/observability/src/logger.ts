import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export interface LoggerConfiguration {
  level: string;
  service: string;
}

export const sensitiveLogPaths = [
  "authorization",
  "cookie",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "LLM_API_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "databaseUrl",
  "redisUrl",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "headers.x-api-key",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  "req.headers.x-api-key",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.api_key",
  "*.LLM_API_KEY",
  "*.DATABASE_URL",
  "*.REDIS_URL",
  "*.databaseUrl",
  "*.redisUrl",
] as const;

export function createLogger(
  configuration: LoggerConfiguration,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: configuration.level,
    base: { service: configuration.service },
    redact: {
      paths: [...sensitiveLogPaths],
      censor: "[REDACTED]",
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export type { Logger };
