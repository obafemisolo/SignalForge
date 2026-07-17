export const terminalStatuses = new Set(["COMPLETED", "PARTIAL", "FAILED"]);

export function isTerminalStatus(status: string): boolean {
  return terminalStatuses.has(status);
}

export function elapsedMilliseconds(
  startedAt: string | null,
  completedAt: string | null,
  now = Date.now(),
): number {
  if (startedAt === null) {
    return 0;
  }
  const end = completedAt === null ? now : Date.parse(completedAt);
  return Math.max(0, end - Date.parse(startedAt));
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function csvEscape(value: string): string {
  const safeValue = /^[\t \r]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\n\r]/u.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue;
}

export function recordsToCsv(
  records: readonly Record<string, string | number | null>[],
): string {
  const columns = [
    "company",
    "role",
    "location",
    "signal",
    "relevanceScore",
    "confidenceScore",
    "sourceUrl",
    "evidence",
  ];
  const rows = records.map((record) =>
    columns.map((column) => csvEscape(String(record[column] ?? ""))).join(","),
  );
  return [columns.join(","), ...rows].join("\n");
}
