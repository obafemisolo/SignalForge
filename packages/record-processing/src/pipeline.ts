import {
  createConflictDeduplicationKey,
  createDeduplicationKey,
  normalizeHiringSignal,
} from "./normalization.js";
import { scoreHiringSignal, sourceContextToAttribution } from "./scoring.js";
import type {
  DeterministicMatch,
  HiringSignalValue,
  OriginalVariants,
  ProcessedHiringSignal,
  RecordConflict,
  RecordProcessingOptions,
  RecordProcessingResult,
  RecordSourceContext,
  SourceAttribution,
} from "./types.js";

export async function processHiringSignals(
  records: readonly HiringSignalValue[],
  query: string,
  source: RecordSourceContext,
  options: RecordProcessingOptions = {},
): Promise<RecordProcessingResult> {
  const now = options.now ?? new Date();
  const candidates = records
    .map((record) => createProcessedRecord(record, query, source, now))
    .sort((left, right) =>
      [
        left.normalized.company,
        left.normalized.role,
        left.normalized.domain,
        left.normalized.sourceUrl,
        left.normalized.location,
        left.normalized.signal,
      ]
        .join("\u001f")
        .localeCompare(
          [
            right.normalized.company,
            right.normalized.role,
            right.normalized.domain,
            right.normalized.sourceUrl,
            right.normalized.location,
            right.normalized.signal,
          ].join("\u001f"),
        ),
    );
  const output: ProcessedHiringSignal[] = [];
  let duplicatesRemoved = 0;
  let conflictsDetected = 0;
  let semanticMatchingUsed = false;

  for (const candidate of candidates) {
    let handled = false;
    for (let index = 0; index < output.length; index += 1) {
      const existing = output[index];
      if (existing === undefined) {
        continue;
      }
      const match = classifyDeterministicMatch(existing, candidate);
      if (match.kind === "DUPLICATE") {
        output[index] = mergeDuplicateRecords(existing, candidate, query, now);
        duplicatesRemoved += 1;
        handled = true;
        break;
      }
      if (match.kind === "CONFLICT") {
        const conflictCandidate = applyConflict(
          existing,
          candidate,
          match.conflicts,
        );
        output[index] = conflictCandidate.existing;
        output.push(conflictCandidate.incoming);
        conflictsDetected += match.conflicts.length;
        handled = true;
        break;
      }
    }
    if (!handled && options.semanticMatchingEnabled === true) {
      const matcher = options.semanticMatcher;
      if (matcher === undefined) {
        throw new Error(
          "Semantic matching was enabled without a SemanticSimilarityMatcher",
        );
      }
      const threshold = options.semanticThreshold ?? 0.9;
      for (let index = 0; index < output.length; index += 1) {
        const existing = output[index];
        if (existing === undefined) {
          continue;
        }
        const similarity = await matcher.similarity(existing, candidate);
        semanticMatchingUsed = true;
        if (similarity >= threshold) {
          output[index] = mergeDuplicateRecords(
            existing,
            candidate,
            query,
            now,
          );
          duplicatesRemoved += 1;
          handled = true;
          break;
        }
      }
    }
    if (!handled) {
      output.push(candidate);
    }
  }

  return {
    records: output,
    duplicatesRemoved,
    conflictsDetected,
    semanticMatchingUsed,
  };
}

export function classifyDeterministicMatch(
  left: ProcessedHiringSignal,
  right: ProcessedHiringSignal,
): DeterministicMatch {
  if (
    left.normalized.company !== right.normalized.company ||
    left.normalized.role !== right.normalized.role
  ) {
    return { kind: "DISTINCT" };
  }
  const conflicts = detectConflicts(left, right);
  if (conflicts.length > 0) {
    return { kind: "CONFLICT", conflicts };
  }
  if (
    left.normalized.domain === right.normalized.domain &&
    (left.normalized.sourceUrl === right.normalized.sourceUrl ||
      tokenJaccard(left.normalized.signal, right.normalized.signal) >= 0.6)
  ) {
    return { kind: "DUPLICATE" };
  }
  return { kind: "DISTINCT" };
}

export function mergeDuplicateRecords(
  left: ProcessedHiringSignal,
  right: ProcessedHiringSignal,
  query: string,
  now = new Date(),
): ProcessedHiringSignal {
  const preferred = preferRecord(left, right);
  const other = preferred === left ? right : left;
  const attributions = mergeAttributions(left.attributions, right.attributions);
  const original = {
    ...preferred.original,
    website: preferred.original.website ?? other.original.website,
    role: preferred.original.role ?? other.original.role,
    location: preferred.original.location ?? other.original.location,
    confidenceScore: Math.max(left.confidenceScore, right.confidenceScore),
  };
  const normalized = {
    ...preferred.normalized,
    originalVariants: mergeVariants(
      left.normalized.originalVariants,
      right.normalized.originalVariants,
    ),
  };
  const merged: ProcessedHiringSignal = {
    original,
    normalized,
    attributions,
    confidenceScore: Math.max(left.confidenceScore, right.confidenceScore),
    relevanceScore: 0,
    scoreExplanation: preferred.scoreExplanation,
    deduplicationKey:
      left.deduplicationKey.localeCompare(right.deduplicationKey) <= 0
        ? left.deduplicationKey
        : right.deduplicationKey,
    reviewRequired: left.reviewRequired || right.reviewRequired,
    conflicts: mergeConflicts(left.conflicts, right.conflicts),
  };
  const score = scoreHiringSignal(merged, query, now);
  return { ...merged, relevanceScore: score.total, scoreExplanation: score };
}

export function applyConflict(
  existing: ProcessedHiringSignal,
  incoming: ProcessedHiringSignal,
  conflicts: readonly RecordConflict[],
): {
  existing: ProcessedHiringSignal;
  incoming: ProcessedHiringSignal;
} {
  const incomingDeduplicationKey = createConflictDeduplicationKey({
    deduplicationKey: incoming.deduplicationKey,
    location: incoming.normalized.location,
    signal: incoming.normalized.signal,
    sourceUrl: incoming.normalized.sourceUrl,
  });
  const existingConflicts = conflicts.map((conflict) => ({
    ...conflict,
    otherDeduplicationKey: incomingDeduplicationKey,
  }));
  const incomingConflicts = conflicts.map((conflict) => ({
    ...conflict,
    otherDeduplicationKey: existing.deduplicationKey,
  }));
  return {
    existing: {
      ...existing,
      reviewRequired: true,
      conflicts: mergeConflicts(existing.conflicts, existingConflicts),
    },
    incoming: {
      ...incoming,
      deduplicationKey: incomingDeduplicationKey,
      reviewRequired: true,
      conflicts: mergeConflicts(incoming.conflicts, incomingConflicts),
    },
  };
}

function createProcessedRecord(
  record: HiringSignalValue,
  query: string,
  source: RecordSourceContext,
  now: Date,
): ProcessedHiringSignal {
  const normalized = normalizeHiringSignal(record);
  const base: ProcessedHiringSignal = {
    original: record,
    normalized,
    attributions: [sourceContextToAttribution(source, record.evidence)],
    confidenceScore: record.confidenceScore,
    relevanceScore: 0,
    scoreExplanation: {
      version: "v1",
      total: 0,
      components: {
        queryKeywordOverlap: emptyComponent(),
        requiredFieldCompleteness: emptyComponent(),
        confidence: emptyComponent(),
        sourceFreshness: emptyComponent(),
        sourceCredibility: emptyComponent(),
        evidenceDirectness: emptyComponent(),
      },
    },
    deduplicationKey: createDeduplicationKey(normalized),
    reviewRequired: false,
    conflicts: [],
  };
  const score = scoreHiringSignal(base, query, now);
  return { ...base, relevanceScore: score.total, scoreExplanation: score };
}

function detectConflicts(
  left: ProcessedHiringSignal,
  right: ProcessedHiringSignal,
): RecordConflict[] {
  const conflicts: RecordConflict[] = [];
  if (
    left.normalized.domain !== "" &&
    right.normalized.domain !== "" &&
    left.normalized.domain !== right.normalized.domain
  ) {
    conflicts.push({
      type: "DOMAIN_MISMATCH",
      fields: ["website", "domain"],
      message: "Matching company and role have different normalized domains.",
      otherDeduplicationKey: "",
    });
  }
  if (
    left.normalized.location !== "" &&
    right.normalized.location !== "" &&
    left.normalized.location !== right.normalized.location
  ) {
    conflicts.push({
      type: "LOCATION_MISMATCH",
      fields: ["location"],
      message: "Matching company and role have different locations.",
      otherDeduplicationKey: "",
    });
  }
  if (
    isNegativeSignal(left.normalized.signal) !==
    isNegativeSignal(right.normalized.signal)
  ) {
    conflicts.push({
      type: "SIGNAL_POLARITY_MISMATCH",
      fields: ["signal"],
      message: "Matching company and role have conflicting hiring status.",
      otherDeduplicationKey: "",
    });
  }
  return conflicts;
}

function preferRecord(
  left: ProcessedHiringSignal,
  right: ProcessedHiringSignal,
): ProcessedHiringSignal {
  const leftCompleteness = nullableFieldCount(left);
  const rightCompleteness = nullableFieldCount(right);
  if (leftCompleteness !== rightCompleteness) {
    return leftCompleteness > rightCompleteness ? left : right;
  }
  if (left.confidenceScore !== right.confidenceScore) {
    return left.confidenceScore > right.confidenceScore ? left : right;
  }
  return left.deduplicationKey.localeCompare(right.deduplicationKey) <= 0
    ? left
    : right;
}

function nullableFieldCount(record: ProcessedHiringSignal): number {
  return [
    record.original.website,
    record.original.role,
    record.original.location,
  ].filter((value) => value !== null).length;
}

function mergeAttributions(
  left: readonly SourceAttribution[],
  right: readonly SourceAttribution[],
): SourceAttribution[] {
  const merged = new Map<string, SourceAttribution>();
  for (const attribution of [...left, ...right]) {
    const key = `${attribution.sourceDocumentId}\u001f${attribution.sourceUrl}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined
        ? { ...attribution, evidence: [...attribution.evidence] }
        : {
            ...existing,
            evidence: unique([...existing.evidence, ...attribution.evidence]),
            publishedAt: newestDate(
              existing.publishedAt,
              attribution.publishedAt,
            ),
            credibilityScore: maximumNullable(
              existing.credibilityScore,
              attribution.credibilityScore,
            ),
          },
    );
  }
  return [...merged.values()].sort((a, b) =>
    `${a.sourceUrl}\u001f${a.sourceDocumentId}`.localeCompare(
      `${b.sourceUrl}\u001f${b.sourceDocumentId}`,
    ),
  );
}

function mergeVariants(
  left: OriginalVariants,
  right: OriginalVariants,
): OriginalVariants {
  return {
    companies: unique([...left.companies, ...right.companies]),
    websites: unique([...left.websites, ...right.websites]),
    roles: unique([...left.roles, ...right.roles]),
    locations: unique([...left.locations, ...right.locations]),
    signals: unique([...left.signals, ...right.signals]),
  };
}

function mergeConflicts(
  left: readonly RecordConflict[],
  right: readonly RecordConflict[],
): RecordConflict[] {
  return [
    ...new Map(
      [...left, ...right].map((conflict) => [
        `${conflict.type}\u001f${conflict.otherDeduplicationKey}`,
        conflict,
      ]),
    ).values(),
  ];
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/u).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/u).filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) {
    return 1;
  }
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return intersection / union.size;
}

function isNegativeSignal(value: string): boolean {
  return /\b(not hiring|no longer hiring|position filled|applications closed|hiring freeze|hiring paused)\b/u.test(
    value,
  );
}

function newestDate(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function maximumNullable(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function emptyComponent() {
  return { score: 0, weight: 0, weightedScore: 0, reason: "" };
}
