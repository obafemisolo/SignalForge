"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  elapsedMilliseconds,
  formatDuration,
  isTerminalStatus,
  recordsToCsv,
} from "./helpers";

type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

interface JobView {
  id: string;
  query: string;
  status: JobStatus;
  progress: {
    totalSources: number;
    successfulSources: number;
    failedSources: number;
    duplicatesRemoved: number;
  };
  errors: {
    total: number;
    items: Array<{
      sourceUrl: string;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  };
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResultView {
  id: string;
  structuredData: Record<string, unknown>;
  evidence: Array<{ quote: string }>;
  confidenceScore: number;
  relevanceScore: number;
  source: { url: string; title: string | null };
}

interface ApiJobResponse {
  data: JobView;
}
interface ApiResultsResponse {
  data: { records: ResultView[] };
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export default function ResearchJobDetails({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [records, setRecords] = useState<ResultView[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal): Promise<JobStatus | null> => {
      const statusResponse = await fetch(
        `/api/research-jobs/${encodeURIComponent(jobId)}`,
        { signal, cache: "no-store" },
      );
      const statusBody = await readJson<ApiJobResponse>(statusResponse);
      setJob(statusBody.data);
      const resultsResponse = await fetch(
        `/api/research-jobs/${encodeURIComponent(jobId)}/results?limit=100`,
        { signal, cache: "no-store" },
      );
      const resultsBody = await readJson<ApiResultsResponse>(resultsResponse);
      setRecords(resultsBody.data.records);
      setTotalRecords(resultsBody.meta.total);
      return statusBody.data.status;
    },
    [jobId],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const status = await load(controller.signal);
        if (!cancelled && status !== null && !isTerminalStatus(status)) {
          timer = setTimeout(() => void poll(), 5_000);
        }
      } catch (caught: unknown) {
        if (
          !cancelled &&
          !(caught instanceof DOMException && caught.name === "AbortError")
        ) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load this research job.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, refresh]);

  const csv = useMemo(
    () =>
      recordsToCsv(
        records.map((record) => ({
          company: text(record, "company"),
          role: text(record, "role"),
          location: text(record, "location"),
          signal: text(record, "signal"),
          relevanceScore: record.relevanceScore,
          confidenceScore: record.confidenceScore,
          sourceUrl: record.source.url,
          evidence: record.evidence.map((item) => item.quote).join(" | "),
        })),
      ),
    [records],
  );

  async function retry(): Promise<void> {
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/research-jobs/${encodeURIComponent(jobId)}`,
        { method: "POST" },
      );
      await readJson(response);
      setRefresh((value) => value + 1);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not retry failed sources.",
      );
    } finally {
      setRetrying(false);
    }
  }

  function downloadCsv(): void {
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `signalforge-${jobId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (loading && job === null)
    return (
      <p className="loading" role="status">
        Loading research job…
      </p>
    );
  if (error !== null && job === null)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (job === null)
    return (
      <p className="error" role="alert">
        Research job not found.
      </p>
    );

  const percentage =
    job.progress.totalSources === 0
      ? 0
      : Math.round(
          ((job.progress.successfulSources + job.progress.failedSources) /
            job.progress.totalSources) *
            100,
        );
  const elapsed = elapsedMilliseconds(job.startedAt, job.completedAt);
  const canRetry = job.progress.failedSources > 0 && job.status !== "RUNNING";

  return (
    <>
      <div className="job-header">
        <div>
          <span className="kicker">Research job</span>
          <h1>{job.query}</h1>
          <p className="job-id">{job.id}</p>
        </div>
        <div className="actions">
          {canRetry && (
            <button disabled={retrying} onClick={() => void retry()}>
              {retrying ? "Retrying…" : "Retry failed sources"}
            </button>
          )}
          <a className="button button-secondary" href="/">
            New job
          </a>
        </div>
      </div>

      <div className="card" style={{ marginTop: 28 }}>
        <div className="status-row">
          <span className={`status status-${job.status.toLowerCase()}`}>
            {job.status}
          </span>
          <span className="muted">Elapsed {formatDuration(elapsed)}</span>
        </div>
        <div style={{ marginTop: 20 }}>
          <div className="status-row">
            <span className="muted">Source progress</span>
            <strong>{percentage}%</strong>
          </div>
          <div
            className="progress-track"
            aria-label={`${percentage}% of sources terminal`}
            role="progressbar"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percentage}
            style={{ marginTop: 9 }}
          >
            <div className="progress-bar" style={{ width: `${percentage}%` }} />
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Total sources</span>
          <span className="stat-value">{job.progress.totalSources}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Successful</span>
          <span className="stat-value">{job.progress.successfulSources}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Failed</span>
          <span className="stat-value">{job.progress.failedSources}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Duplicates removed</span>
          <span className="stat-value">{job.progress.duplicatesRemoved}</span>
        </div>
      </div>

      {job.status === "PARTIAL" && (
        <p className="notice" role="status">
          This job partially completed. Successful sources and validated results
          are available below; failed sources can be retried.
        </p>
      )}
      {job.status === "FAILED" && (
        <p className="error" role="alert">
          All submitted sources failed. Review the source errors and retry when
          the underlying issue is resolved.
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="section-heading">
        <div>
          <span className="kicker">Validated output</span>
          <h2>
            Results <span className="muted">({totalRecords})</span>
          </h2>
        </div>
        <button
          className="button-secondary"
          disabled={records.length === 0}
          onClick={downloadCsv}
        >
          Export CSV
        </button>
      </div>
      <div className="card table-wrap">
        {records.length === 0 ? (
          <p className="empty">
            {isTerminalStatus(job.status)
              ? "No matching records were found."
              : "Results will appear as sources finish processing."}
          </p>
        ) : (
          <table>
            <caption
              className="muted"
              style={{ textAlign: "left", padding: 12 }}
            >
              Source-attributed hiring signals
            </caption>
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Location</th>
                <th>Signal</th>
                <th>Relevance</th>
                <th>Confidence</th>
                <th>Source</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{text(record, "company")}</td>
                  <td>{text(record, "role") || "—"}</td>
                  <td>{text(record, "location") || "—"}</td>
                  <td>{text(record, "signal")}</td>
                  <td className="score">
                    {Math.round(record.relevanceScore * 100)}%
                  </td>
                  <td>{Math.round(record.confidenceScore * 100)}%</td>
                  <td>
                    <a
                      className="source-link"
                      href={record.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {record.source.title ?? record.source.url}
                    </a>
                  </td>
                  <td>
                    <details>
                      <summary>Show evidence</summary>
                      <div className="evidence">
                        {record.evidence.map((item, index) => (
                          <p key={`${record.id}-${index}`}>{item.quote}</p>
                        ))}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : "The request failed.";
    throw new Error(message);
  }
  return body as T;
}

function text(record: ResultView, field: string): string {
  const value = record.structuredData[field];
  return typeof value === "string" ? value : "";
}
