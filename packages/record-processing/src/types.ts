export interface HiringSignalValue {
  company: string;
  website: string | null;
  role: string | null;
  location: string | null;
  signal: string;
  sourceUrl: string;
  evidence: string;
  confidenceScore: number;
}

export interface RecordSourceContext {
  sourceDocumentId: string;
  sourceUrl: string;
  publishedAt?: Date;
  credibilityScore?: number;
}

export interface SourceAttribution {
  sourceDocumentId: string;
  sourceUrl: string;
  evidence: string[];
  publishedAt: string | null;
  credibilityScore: number | null;
}

export interface OriginalVariants {
  companies: string[];
  websites: string[];
  roles: string[];
  locations: string[];
  signals: string[];
}

export interface NormalizedHiringSignal {
  company: string;
  role: string;
  domain: string;
  sourceUrl: string;
  location: string;
  signal: string;
  originalVariants: OriginalVariants;
}

export type ScoreComponentName =
  | "queryKeywordOverlap"
  | "requiredFieldCompleteness"
  | "confidence"
  | "sourceFreshness"
  | "sourceCredibility"
  | "evidenceDirectness";

export interface ScoreComponent {
  score: number;
  weight: number;
  weightedScore: number;
  reason: string;
}

export interface RelevanceScoreExplanation {
  version: "v1";
  total: number;
  components: Record<ScoreComponentName, ScoreComponent>;
}

export type ConflictType =
  | "DOMAIN_MISMATCH"
  | "LOCATION_MISMATCH"
  | "SIGNAL_POLARITY_MISMATCH";

export interface RecordConflict {
  type: ConflictType;
  fields: string[];
  message: string;
  otherDeduplicationKey: string;
}

export interface ProcessedHiringSignal {
  original: HiringSignalValue;
  normalized: NormalizedHiringSignal;
  attributions: SourceAttribution[];
  confidenceScore: number;
  relevanceScore: number;
  scoreExplanation: RelevanceScoreExplanation;
  deduplicationKey: string;
  reviewRequired: boolean;
  conflicts: RecordConflict[];
}

export interface RecordProcessingResult {
  records: ProcessedHiringSignal[];
  duplicatesRemoved: number;
  conflictsDetected: number;
  semanticMatchingUsed: boolean;
}

export interface SemanticSimilarityMatcher {
  similarity(
    left: ProcessedHiringSignal,
    right: ProcessedHiringSignal,
  ): Promise<number>;
}

export interface RecordProcessingOptions {
  semanticMatcher?: SemanticSimilarityMatcher;
  semanticMatchingEnabled?: boolean;
  semanticThreshold?: number;
  now?: Date;
}

export type DeterministicMatch =
  | { kind: "DUPLICATE" }
  | { kind: "CONFLICT"; conflicts: RecordConflict[] }
  | { kind: "DISTINCT" };
