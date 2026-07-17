import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export type ResearchJobMetricStatus =
  | "created"
  | "completed"
  | "partial"
  | "failed";

export interface MetricsConfiguration {
  service: string;
  collectProcessMetrics?: boolean;
}

export interface LlmMetricObservation {
  provider: string;
  model: string;
  status: "success" | "failure";
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export class SignalForgeMetrics {
  public readonly registry = new Registry();

  private readonly apiRequests: Counter<string>;
  private readonly apiRequestDuration: Histogram<string>;
  private readonly researchJobs: Counter<string>;
  private readonly queueDepth: Gauge<string>;
  private readonly queueProcessingDuration: Histogram<string>;
  private readonly fetches: Counter<string>;
  private readonly extractions: Counter<string>;
  private readonly retries: Counter<string>;
  private readonly llmRequests: Counter<string>;
  private readonly llmLatency: Histogram<string>;
  private readonly llmTokens: Counter<string>;
  private readonly llmCost: Counter<string>;
  private readonly duplicatesRemoved: Counter<string>;
  private readonly heartbeatTimestamp: Gauge<string>;
  private readonly service: string;

  public constructor(configuration: MetricsConfiguration) {
    this.service = configuration.service;
    this.registry.setDefaultLabels({ service: this.service });
    if (configuration.collectProcessMetrics !== false) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: "signalforge_process_",
      });
    }

    this.apiRequests = new Counter({
      name: "signalforge_api_requests_total",
      help: "Total API requests.",
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry],
    });
    this.apiRequestDuration = new Histogram({
      name: "signalforge_api_request_duration_seconds",
      help: "API request duration in seconds.",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.researchJobs = new Counter({
      name: "signalforge_research_jobs_total",
      help: "Research job lifecycle outcomes.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "signalforge_queue_depth",
      help: "Current BullMQ job count by queue and state.",
      labelNames: ["queue_name", "state"],
      registers: [this.registry],
    });
    this.queueProcessingDuration = new Histogram({
      name: "signalforge_queue_processing_duration_seconds",
      help: "BullMQ processing duration.",
      labelNames: ["queue_name", "status"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300],
      registers: [this.registry],
    });
    this.fetches = new Counter({
      name: "signalforge_fetch_total",
      help: "Source fetch outcomes.",
      labelNames: ["status", "error_code"],
      registers: [this.registry],
    });
    this.extractions = new Counter({
      name: "signalforge_extraction_total",
      help: "LLM extraction outcomes.",
      labelNames: ["status", "error_code"],
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: "signalforge_queue_retries_total",
      help: "Queue retry events.",
      labelNames: ["queue_name", "reason"],
      registers: [this.registry],
    });
    this.llmRequests = new Counter({
      name: "signalforge_llm_requests_total",
      help: "LLM provider request outcomes.",
      labelNames: ["provider", "model", "status"],
      registers: [this.registry],
    });
    this.llmLatency = new Histogram({
      name: "signalforge_llm_request_duration_seconds",
      help: "LLM provider request latency.",
      labelNames: ["provider", "model", "status"],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
      registers: [this.registry],
    });
    this.llmTokens = new Counter({
      name: "signalforge_llm_tokens_total",
      help: "LLM token usage when reported by the provider.",
      labelNames: ["provider", "model", "token_type"],
      registers: [this.registry],
    });
    this.llmCost = new Counter({
      name: "signalforge_llm_estimated_cost_usd_total",
      help: "Reported or locally estimated LLM cost in US dollars.",
      labelNames: ["provider", "model"],
      registers: [this.registry],
    });
    this.duplicatesRemoved = new Counter({
      name: "signalforge_duplicate_records_removed_total",
      help: "Duplicate records removed from canonical result sets.",
      registers: [this.registry],
    });
    this.heartbeatTimestamp = new Gauge({
      name: "signalforge_worker_heartbeat_timestamp_seconds",
      help: "Unix timestamp of the most recent local worker heartbeat.",
      registers: [this.registry],
    });
  }

  public observeApiRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const labels = {
      method,
      route,
      status_code: String(statusCode),
    };
    this.apiRequests.inc(labels);
    this.apiRequestDuration.observe(labels, durationMs / 1_000);
  }

  public observeResearchJob(status: ResearchJobMetricStatus): void {
    this.researchJobs.inc({ status });
  }

  public setQueueDepth(queueName: string, state: string, count: number): void {
    this.queueDepth.set({ queue_name: queueName, state }, count);
  }

  public observeQueueJob(
    queueName: string,
    status: "success" | "failure",
    durationMs: number,
  ): void {
    this.queueProcessingDuration.observe(
      { queue_name: queueName, status },
      durationMs / 1_000,
    );
  }

  public observeFetch(status: "success" | "failure", errorCode = "none"): void {
    this.fetches.inc({ status, error_code: errorCode });
  }

  public observeExtraction(
    status: "success" | "validation_failure" | "failure",
    errorCode = "none",
  ): void {
    this.extractions.inc({ status, error_code: errorCode });
  }

  public observeRetry(queueName: string, reason: string): void {
    this.retries.inc({ queue_name: queueName, reason });
  }

  public observeLlmRequest(observation: LlmMetricObservation): void {
    const labels = {
      provider: observation.provider,
      model: observation.model,
      status: observation.status,
    };
    this.llmRequests.inc(labels);
    this.llmLatency.observe(labels, observation.durationMs / 1_000);
    if (observation.inputTokens !== undefined) {
      this.llmTokens.inc(
        {
          provider: observation.provider,
          model: observation.model,
          token_type: "input",
        },
        observation.inputTokens,
      );
    }
    if (observation.outputTokens !== undefined) {
      this.llmTokens.inc(
        {
          provider: observation.provider,
          model: observation.model,
          token_type: "output",
        },
        observation.outputTokens,
      );
    }
    if (observation.totalTokens !== undefined) {
      this.llmTokens.inc(
        {
          provider: observation.provider,
          model: observation.model,
          token_type: "total",
        },
        observation.totalTokens,
      );
    }
    if (observation.costUsd !== undefined) {
      this.llmCost.inc(
        {
          provider: observation.provider,
          model: observation.model,
        },
        observation.costUsd,
      );
    }
  }

  public observeDuplicatesRemoved(count: number): void {
    if (count > 0) {
      this.duplicatesRemoved.inc(count);
    }
  }

  public recordHeartbeat(timestamp = new Date()): void {
    this.heartbeatTimestamp.set(timestamp.getTime() / 1_000);
  }

  public get contentType(): string {
    return this.registry.contentType;
  }

  public async render(): Promise<string> {
    return this.registry.metrics();
  }
}

export function createMetrics(
  configuration: MetricsConfiguration,
): SignalForgeMetrics {
  return new SignalForgeMetrics(configuration);
}
