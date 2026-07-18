"use client";

import { useState } from "react";

const hiringFields = [
  "company",
  "website",
  "role",
  "location",
  "signal",
  "sourceUrl",
  "evidence",
];

const exampleQuery =
  "Find Nigerian fintech companies currently hiring backend engineers";
const exampleSource = "https://example.com/jobs";

export default function NewResearchJobPage() {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const sourceList = sources
      .split(/\r?\n|,/u)
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      const response = await fetch("/api/research-jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key":
            globalThis.crypto?.randomUUID?.() ??
            `${Date.now()}-${Math.random()}`,
        },
        body: JSON.stringify({
          query,
          sources: sourceList,
          schema: { type: "companyHiringSignal", fields: hiringFields },
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(readError(body));
      }
      if (!isAcceptedResponse(body)) {
        throw new Error("The API returned an unexpected response.");
      }
      window.location.assign(`/research-jobs/${body.data.id}`);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not create the research job.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="hero">
        <span className="kicker">Public web research</span>
        <h1>
          Turn a question into a <em>sourced signal.</em>
        </h1>
        <p className="lede">
          Submit a focused research request and SignalForge will fetch only the
          public URLs you provide, validate every extracted record, and keep the
          evidence attached.
        </p>
      </section>

      <div className="grid">
        <form
          className="card form-card"
          onSubmit={submit}
          aria-busy={submitting}
        >
          <div className="card-heading">
            <span className="step-mark" aria-hidden="true">
              01
            </span>
            <div>
              <h2>New research job</h2>
              <p>Define a focused question and the sources we may inspect.</p>
            </div>
          </div>
          <label htmlFor="query">What should we research?</label>
          <textarea
            id="query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find Nigerian fintech companies currently hiring backend engineers"
            required
          />
          <label htmlFor="sources">Permitted source URLs</label>
          <textarea
            id="sources"
            value={sources}
            onChange={(event) => setSources(event.target.value)}
            placeholder={`https://example.com/careers
https://another.example/jobs`}
            required
          />
          <p className="help">
            One HTTP(S) URL per line. SignalForge does not crawl beyond these
            submitted pages.
          </p>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button disabled={submitting} type="submit">
              {submitting ? "Creating job…" : "Start research"}
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => {
                setQuery(exampleQuery);
                setSources(exampleSource);
              }}
            >
              Use example
            </button>
          </div>
        </form>

        <aside className="card guide-card">
          <span className="kicker">What you get</span>
          <h2>Research you can trace.</h2>
          <ul className="side-list">
            <li>Progress updates as each source completes.</li>
            <li>Partial success when one source fails.</li>
            <li>Evidence and source links for every record.</li>
            <li>Transparent confidence and relevance scores.</li>
          </ul>
        </aside>
      </div>
    </>
  );
}

function readError(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return "The research job could not be created.";
}

function isAcceptedResponse(body: unknown): body is { data: { id: string } } {
  return (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    typeof body.data === "object" &&
    body.data !== null &&
    "id" in body.data &&
    typeof body.data.id === "string"
  );
}
