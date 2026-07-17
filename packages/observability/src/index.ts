import pino, { type Logger, type LoggerOptions } from "pino";

export interface LoggerConfiguration {
  level: string;
  service: string;
}

export function createLogger(configuration: LoggerConfiguration): Logger {
  const options: LoggerOptions = {
    level: configuration.level,
    base: { service: configuration.service },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "password",
        "token",
        "*.authorization",
        "*.cookie",
        "*.password",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  };
  return pino(options);
}

export type { Logger };
