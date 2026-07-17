import { createHash } from "node:crypto";

import type {
  HiringSignalValue,
  NormalizedHiringSignal,
  OriginalVariants,
} from "./types.js";

const legalSuffixes =
  /\b(?:limited|ltd|incorporated|inc|llc|plc|corporation|corp|company|co)\b\.?$/iu;
const trackingParameters = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
]);

export function collapseWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeCompanyName(value: string): string {
  let normalized = normalizeMatchingText(value)
    .replace(/\s+(?:and|&)\s+company$/u, "")
    .trim();
  while (legalSuffixes.test(normalized)) {
    normalized = normalized.replace(legalSuffixes, "").trim();
  }
  return normalized;
}

export function normalizeRoleName(value: string | null): string {
  if (value === null) {
    return "";
  }
  let normalized = normalizeMatchingText(value)
    .replace(/\b(sr|snr)\b/gu, "senior")
    .replace(/\b(jr)\b/gu, "junior")
    .replace(/\bback end\b/gu, "backend");
  if (
    /\bbackend\b/u.test(normalized) &&
    /\b(developer|software engineer|engineer)\b/u.test(normalized)
  ) {
    const seniority = normalized.match(/\b(senior|junior|lead|principal)\b/u);
    normalized = `${seniority?.[1] ?? ""} backend engineer`.trim();
  }
  return normalized;
}

export function normalizeUrl(value: string): string {
  const url = new URL(collapseWhitespace(value));
  url.hostname = url.hostname.toLocaleLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase();
    if (
      normalizedKey.startsWith("utm_") ||
      trackingParameters.has(normalizedKey)
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

export function normalizeDomain(
  website: string | null,
  sourceUrl: string,
): string {
  const hostname = new URL(website ?? sourceUrl).hostname.toLocaleLowerCase();
  return hostname.replace(/^www\./u, "");
}

export function normalizeLocation(value: string | null): string {
  return value === null ? "" : normalizeMatchingText(value);
}

export function normalizeSignal(value: string): string {
  return normalizeMatchingText(value);
}

export function normalizeHiringSignal(
  record: HiringSignalValue,
): NormalizedHiringSignal {
  const normalizedSourceUrl = normalizeUrl(record.sourceUrl);
  return {
    company: normalizeCompanyName(record.company),
    role: normalizeRoleName(record.role),
    domain: normalizeDomain(record.website, normalizedSourceUrl),
    sourceUrl: normalizedSourceUrl,
    location: normalizeLocation(record.location),
    signal: normalizeSignal(record.signal),
    originalVariants: createOriginalVariants(record),
  };
}

export function createDeduplicationKey(
  normalized: Pick<
    NormalizedHiringSignal,
    "company" | "role" | "domain" | "sourceUrl"
  >,
): string {
  return createHash("sha256")
    .update(
      [
        normalized.company,
        normalized.role,
        normalized.domain,
        normalized.sourceUrl,
      ].join("\u001f"),
    )
    .digest("hex");
}

export function createConflictDeduplicationKey(
  record: ProcessedConflictKeyInput,
): string {
  return createHash("sha256")
    .update(
      [
        record.deduplicationKey,
        record.location,
        record.signal,
        record.sourceUrl,
      ].join("\u001f"),
    )
    .digest("hex");
}

interface ProcessedConflictKeyInput {
  deduplicationKey: string;
  location: string;
  signal: string;
  sourceUrl: string;
}

function createOriginalVariants(record: HiringSignalValue): OriginalVariants {
  return {
    companies: [collapseWhitespace(record.company)],
    websites:
      record.website === null ? [] : [collapseWhitespace(record.website)],
    roles: record.role === null ? [] : [collapseWhitespace(record.role)],
    locations:
      record.location === null ? [] : [collapseWhitespace(record.location)],
    signals: [collapseWhitespace(record.signal)],
  };
}

function normalizeMatchingText(value: string): string {
  return collapseWhitespace(value)
    .toLocaleLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
