import { createHash } from "node:crypto";

import { splitIntoBoundedChunks } from "./chunking.js";
import { LlmExtractionError } from "./errors.js";
import { buildExtractionMessages, buildRepairMessages } from "./prompts.js";
import { hiringSignalEnvelopeSchema, type HiringSignal } from "./schema.js";
import type {
  LlmCompletionResponse,
  LlmMetadataValue,
  LlmProvider,
  LlmUsage,
} from "./types.js";

export interface HiringSignalExtractorConfiguration {
  model: string;
  maxOutputTokens: number;
  maxChunkCharacters: number;
  maxChunks: number;
}

export interface HiringSignalExtractionInput {
  query: string;
  sourceUrl: string;
  sourceText: string;
  signal: AbortSignal;
}

export interface HiringSignalExtractionResult {
  records: HiringSignal[];
  provider: string;
  model: string;
  chunkCount: number;
  repairedChunks: number;
  usage: LlmUsage;
  responseMetadata: Array<Readonly<Record<string, LlmMetadataValue>>>;
}

interface ValidationResult {
  success: boolean;
  records: HiringSignal[];
  issues: string[];
}

export class HiringSignalExtractor {
  public constructor(
    private readonly provider: LlmProvider,
    private readonly configuration: HiringSignalExtractorConfiguration,
  ) {}

  public async extract(
    input: HiringSignalExtractionInput,
  ): Promise<HiringSignalExtractionResult> {
    const chunks = splitIntoBoundedChunks(input.sourceText, {
      maxChunkCharacters: this.configuration.maxChunkCharacters,
      maxChunks: this.configuration.maxChunks,
    });
    const records = new Map<string, HiringSignal>();
    const usage: LlmUsage = {};
    const responseMetadata: Array<Readonly<Record<string, LlmMetadataValue>>> =
      [];
    let repairedChunks = 0;
    let responseModel = this.configuration.model;

    for (const [index, sourceText] of chunks.entries()) {
      const promptInput = {
        query: input.query,
        sourceUrl: input.sourceUrl,
        sourceText,
        chunkIndex: index + 1,
        chunkCount: chunks.length,
      };
      const initial = await this.provider.complete({
        model: this.configuration.model,
        messages: buildExtractionMessages(promptInput),
        maxOutputTokens: this.configuration.maxOutputTokens,
        signal: input.signal,
      });
      responseModel = initial.model;
      mergeUsage(usage, initial.usage);
      collectMetadata(responseMetadata, initial);

      let validated = validateCompletion(
        initial.content,
        input.sourceUrl,
        sourceText,
      );
      if (!validated.success) {
        repairedChunks += 1;
        const repaired = await this.provider.complete({
          model: this.configuration.model,
          messages: buildRepairMessages(
            promptInput,
            initial.content,
            validated.issues,
          ),
          maxOutputTokens: this.configuration.maxOutputTokens,
          signal: input.signal,
        });
        responseModel = repaired.model;
        mergeUsage(usage, repaired.usage);
        collectMetadata(responseMetadata, repaired);
        validated = validateCompletion(
          repaired.content,
          input.sourceUrl,
          sourceText,
        );
      }
      if (!validated.success) {
        throw new LlmExtractionError(
          "LLM_RESPONSE_INVALID",
          "LLM output remained invalid after one repair attempt",
          {
            retryable: false,
            issues: validated.issues,
          },
        );
      }
      for (const record of validated.records) {
        records.set(deduplicationKey(record), record);
      }
    }

    return {
      records: [...records.values()],
      provider: this.provider.name,
      model: responseModel,
      chunkCount: chunks.length,
      repairedChunks,
      usage,
      responseMetadata,
    };
  }
}

function validateCompletion(
  content: string,
  sourceUrl: string,
  sourceChunk: string,
): ValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return {
      success: false,
      records: [],
      issues: ["Response is not valid JSON"],
    };
  }
  const parsed = hiringSignalEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return {
      success: false,
      records: [],
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "/"}: ${issue.message}`,
      ),
    };
  }
  const issues: string[] = [];
  const normalizedChunk = sourceChunk.toLocaleLowerCase();
  for (const [index, record] of parsed.data.records.entries()) {
    if (record.sourceUrl !== sourceUrl) {
      issues.push(`records.${index}.sourceUrl must equal the supplied URL`);
    }
    if (!sourceChunk.includes(record.evidence)) {
      issues.push(
        `records.${index}.evidence must occur verbatim in the source chunk`,
      );
    }
    assertMentioned(
      issues,
      normalizedChunk,
      record.company,
      `records.${index}.company`,
    );
    if (record.role !== null) {
      assertMentioned(
        issues,
        normalizedChunk,
        record.role,
        `records.${index}.role`,
      );
    }
    if (record.location !== null) {
      assertMentioned(
        issues,
        normalizedChunk,
        record.location,
        `records.${index}.location`,
      );
    }
    if (record.website !== null) {
      const website = new URL(record.website);
      if (
        !normalizedChunk.includes(record.website.toLocaleLowerCase()) &&
        !normalizedChunk.includes(website.hostname.toLocaleLowerCase())
      ) {
        issues.push(
          `records.${index}.website must occur in the source chunk or be null`,
        );
      }
    }
  }
  return {
    success: issues.length === 0,
    records: issues.length === 0 ? parsed.data.records : [],
    issues,
  };
}

function assertMentioned(
  issues: string[],
  normalizedChunk: string,
  value: string,
  path: string,
): void {
  if (!normalizedChunk.includes(value.toLocaleLowerCase())) {
    issues.push(`${path} must occur in the source chunk`);
  }
}

function deduplicationKey(record: HiringSignal): string {
  return createHash("sha256")
    .update(
      [
        record.company,
        record.website ?? "",
        record.role ?? "",
        record.location ?? "",
        record.signal,
      ]
        .map((value) => value.trim().toLocaleLowerCase())
        .join("\u001f"),
    )
    .digest("hex");
}

function mergeUsage(target: LlmUsage, usage: LlmUsage | undefined): void {
  if (usage === undefined) {
    return;
  }
  addUsageField(target, "inputTokens", usage.inputTokens);
  addUsageField(target, "outputTokens", usage.outputTokens);
  addUsageField(target, "totalTokens", usage.totalTokens);
  addUsageField(target, "costUsd", usage.costUsd);
}

function addUsageField(
  target: LlmUsage,
  key: keyof LlmUsage,
  value: number | undefined,
): void {
  if (value !== undefined) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function collectMetadata(
  target: Array<Readonly<Record<string, LlmMetadataValue>>>,
  response: LlmCompletionResponse,
): void {
  if (
    response.metadata !== undefined &&
    Object.keys(response.metadata).length > 0
  ) {
    target.push(response.metadata);
  }
}

export function createHiringSignalDeduplicationKey(
  record: HiringSignal,
): string {
  return deduplicationKey(record);
}
