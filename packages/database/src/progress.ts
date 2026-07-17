export type PipelineTerminalStatus = "FAILED" | "SUCCEEDED";
export type SourcePipelineStatus =
  | "PENDING"
  | "FETCHING"
  | "EXTRACTING"
  | "PROCESSING"
  | PipelineTerminalStatus;

export interface ResearchProgressCalculation {
  successfulSources: number;
  failedSources: number;
  terminalSources: number;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  isTerminal: boolean;
}

export function calculateResearchProgress(
  totalSources: number,
  statuses: readonly SourcePipelineStatus[],
): ResearchProgressCalculation {
  const successfulSources = statuses.filter(
    (status) => status === "SUCCEEDED",
  ).length;
  const failedSources = statuses.filter((status) => status === "FAILED").length;
  const terminalSources = successfulSources + failedSources;
  const isTerminal = totalSources > 0 && terminalSources === totalSources;

  let status: ResearchProgressCalculation["status"] = "RUNNING";
  if (isTerminal) {
    status =
      successfulSources === totalSources
        ? "COMPLETED"
        : failedSources === totalSources
          ? "FAILED"
          : "PARTIAL";
  }

  return {
    successfulSources,
    failedSources,
    terminalSources,
    status,
    isTerminal,
  };
}
