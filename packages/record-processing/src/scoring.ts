import type {
  ProcessedHiringSignal,
  RecordSourceContext,
  RelevanceScoreExplanation,
  ScoreComponent,
  ScoreComponentName,
  SourceAttribution,
} from "./types.js";

const weights: Record<ScoreComponentName, number> = {
  queryKeywordOverlap: 0.25,
  requiredFieldCompleteness: 0.15,
  confidence: 0.2,
  sourceFreshness: 0.1,
  sourceCredibility: 0.15,
  evidenceDirectness: 0.15,
};

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "currently",
  "find",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function scoreHiringSignal(
  record: Pick<
    ProcessedHiringSignal,
    "original" | "normalized" | "attributions" | "confidenceScore"
  >,
  query: string,
  now = new Date(),
): RelevanceScoreExplanation {
  const componentScores: Record<
    ScoreComponentName,
    { score: number; reason: string }
  > = {
    queryKeywordOverlap: keywordOverlap(record, query),
    requiredFieldCompleteness: completeness(record),
    confidence: {
      score: clamp(record.confidenceScore),
      reason: "Validated model confidence score.",
    },
    sourceFreshness: freshness(record.attributions, now),
    sourceCredibility: credibility(record),
    evidenceDirectness: evidenceDirectness(record),
  };
  const components = Object.fromEntries(
    Object.entries(componentScores).map(([name, component]) => {
      const key = name as ScoreComponentName;
      const weightedScore = round(component.score * weights[key]);
      return [
        key,
        {
          score: round(component.score),
          weight: weights[key],
          weightedScore,
          reason: component.reason,
        } satisfies ScoreComponent,
      ];
    }),
  ) as Record<ScoreComponentName, ScoreComponent>;
  const total = round(
    Object.values(components).reduce(
      (sum, component) => sum + component.weightedScore,
      0,
    ),
  );
  return { version: "v1", total, components };
}

export function sourceContextToAttribution(
  source: RecordSourceContext,
  evidence: string,
): SourceAttribution {
  return {
    sourceDocumentId: source.sourceDocumentId,
    sourceUrl: source.sourceUrl,
    evidence: [evidence],
    publishedAt: source.publishedAt?.toISOString() ?? null,
    credibilityScore:
      source.credibilityScore === undefined
        ? null
        : clamp(source.credibilityScore),
  };
}

function keywordOverlap(
  record: Pick<ProcessedHiringSignal, "original" | "attributions">,
  query: string,
): { score: number; reason: string } {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return { score: 0, reason: "The query contains no scorable keywords." };
  }
  const recordTokens = tokenize(
    [
      record.original.company,
      record.original.website ?? "",
      record.original.role ?? "",
      record.original.location ?? "",
      record.original.signal,
      ...record.attributions.flatMap((item) => item.evidence),
    ].join(" "),
  );
  const matched = [...queryTokens].filter((token) => recordTokens.has(token));
  return {
    score: matched.length / queryTokens.size,
    reason: `${matched.length} of ${queryTokens.size} query keywords matched: ${matched.join(", ") || "none"}.`,
  };
}

function completeness(record: Pick<ProcessedHiringSignal, "original">): {
  score: number;
  reason: string;
} {
  const fields = [
    record.original.company,
    record.original.website,
    record.original.role,
    record.original.location,
    record.original.signal,
    record.original.sourceUrl,
    record.original.evidence,
  ];
  const complete = fields.filter(
    (value) => value !== null && value.trim() !== "",
  ).length;
  return {
    score: complete / fields.length,
    reason: `${complete} of ${fields.length} supported fields are populated.`,
  };
}

function freshness(
  attributions: readonly SourceAttribution[],
  now: Date,
): { score: number; reason: string } {
  const dates = attributions
    .map((item) => item.publishedAt)
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
  if (dates.length === 0) {
    return {
      score: 0.5,
      reason:
        "No reliable publication timestamp was available; neutral freshness applied.",
    };
  }
  const newest = new Date(Math.max(...dates.map((date) => date.getTime())));
  const ageDays = Math.max(0, (now.getTime() - newest.getTime()) / 86_400_000);
  const score =
    ageDays <= 30
      ? 1
      : ageDays <= 90
        ? 0.8
        : ageDays <= 180
          ? 0.6
          : ageDays <= 365
            ? 0.4
            : 0.2;
  return {
    score,
    reason: `Newest source publication is approximately ${Math.floor(ageDays)} days old.`,
  };
}

function credibility(
  record: Pick<
    ProcessedHiringSignal,
    "normalized" | "attributions" | "original"
  >,
): { score: number; reason: string } {
  const explicit = record.attributions
    .map((item) => item.credibilityScore)
    .filter((value): value is number => value !== null);
  if (explicit.length > 0) {
    return {
      score: Math.max(...explicit),
      reason: "Used the highest explicit source credibility score.",
    };
  }
  const official = record.attributions.some((item) => {
    const sourceDomain = new URL(item.sourceUrl).hostname
      .toLocaleLowerCase()
      .replace(/^www\./u, "");
    return sourceDomain === record.normalized.domain;
  });
  if (official && record.original.website !== null) {
    return {
      score: 0.9,
      reason: "The hiring signal is published on the company website domain.",
    };
  }
  const secure = record.attributions.every(
    (item) => new URL(item.sourceUrl).protocol === "https:",
  );
  return {
    score: secure ? 0.7 : 0.5,
    reason: secure
      ? "No explicit credibility metadata; all supporting sources use HTTPS."
      : "No explicit credibility metadata; conservative default applied.",
  };
}

function evidenceDirectness(
  record: Pick<ProcessedHiringSignal, "original" | "attributions">,
): { score: number; reason: string } {
  const company = record.original.company.toLocaleLowerCase();
  const role = record.original.role?.toLocaleLowerCase();
  const evidence = record.attributions
    .flatMap((item) => item.evidence)
    .map((value) => value.toLocaleLowerCase());
  const mentionsCompany = evidence.some((value) => value.includes(company));
  const mentionsRole =
    role === undefined || evidence.some((value) => value.includes(role));
  const containsHiringVerb = evidence.some((value) =>
    /\b(hiring|hire|seeking|recruiting|opening|vacancy|apply)\b/u.test(value),
  );
  const score =
    (mentionsCompany ? 0.3 : 0) +
    (mentionsRole ? 0.25 : 0) +
    (containsHiringVerb ? 0.35 : 0) +
    (evidence.length > 0 ? 0.1 : 0);
  return {
    score,
    reason: `Evidence company=${mentionsCompany}, role=${mentionsRole}, hiring-language=${containsHiringVerb}.`,
  };
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}+#.]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !stopWords.has(token)),
  );
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
