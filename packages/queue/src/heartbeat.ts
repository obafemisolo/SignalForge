import type { Redis } from "ioredis";

export const WORKER_HEARTBEAT_KEY = "signalforge:worker:heartbeats";

export interface WorkerHeartbeatOptions {
  workerId: string;
  intervalMs: number;
  ttlMs: number;
  onHeartbeat?: (timestamp: Date) => void;
  onError?: (error: Error) => void;
}

export class WorkerHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  public constructor(
    private readonly redis: Redis,
    private readonly options: WorkerHeartbeatOptions,
  ) {}

  public async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat().catch((error: unknown) => {
        this.options.onError?.(toError(error));
      });
    }, this.options.intervalMs);
    this.timer.unref();
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.redis
      .zrem(WORKER_HEARTBEAT_KEY, this.options.workerId)
      .catch(() => undefined);
  }

  private async beat(): Promise<void> {
    if (this.closed) {
      return;
    }
    const timestamp = new Date();
    const oldestAllowed = timestamp.getTime() - this.options.ttlMs;
    await this.redis
      .multi()
      .zadd(WORKER_HEARTBEAT_KEY, timestamp.getTime(), this.options.workerId)
      .zremrangebyscore(WORKER_HEARTBEAT_KEY, 0, oldestAllowed)
      .exec();
    this.options.onHeartbeat?.(timestamp);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
