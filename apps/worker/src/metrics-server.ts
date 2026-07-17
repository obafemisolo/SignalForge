import { createServer, type Server, type ServerResponse } from "node:http";

import type { SignalForgeMetrics } from "@signalforge/observability";

export interface WorkerOperationalServerOptions {
  host: string;
  port: number;
  metrics: SignalForgeMetrics;
  checkDatabase: () => Promise<boolean>;
  checkRedis: () => Promise<boolean>;
}

export interface WorkerOperationalServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createWorkerOperationalServer(
  options: WorkerOperationalServerOptions,
): WorkerOperationalServer {
  let server: Server | undefined;
  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server = createServer((request, response) => {
          void handleRequest(request.url, response, options).catch(() => {
            response.statusCode = 500;
            response.end("internal error");
          });
        });
        server.once("error", reject);
        server.listen(options.port, options.host, () => resolve());
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (server === undefined) {
          resolve();
          return;
        }
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}

async function handleRequest(
  requestUrl: string | undefined,
  response: ServerResponse,
  options: WorkerOperationalServerOptions,
): Promise<void> {
  const pathname =
    requestUrl === undefined
      ? "/"
      : new URL(requestUrl, "http://localhost").pathname;
  if (pathname === "/metrics") {
    response.statusCode = 200;
    response.setHeader("content-type", options.metrics.contentType);
    response.end(await options.metrics.render());
    return;
  }
  if (pathname === "/health/live") {
    sendJson(response, 200, { data: { status: "ok" } });
    return;
  }
  if (pathname === "/health/ready") {
    const [database, redis] = await Promise.all([
      options.checkDatabase().catch(() => false),
      options.checkRedis().catch(() => false),
    ]);
    sendJson(response, database && redis ? 200 : 503, {
      data: {
        status: database && redis ? "ready" : "not_ready",
        checks: { database, redis, worker: true },
      },
    });
    return;
  }
  sendJson(response, 404, { error: { code: "NOT_FOUND" } });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
