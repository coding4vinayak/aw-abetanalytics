"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The example-data panel: a week of revenue a new workspace can look at, and
 * the one click that takes it away again.
 *
 * It talks to `/api/example-data` over the session (the browser never holds an
 * API key) and then asks the server to re-render, so the number on the screen
 * is the one the server computed — not a number this component invented.
 */
export function ExampleDataCard({
  loaded,
  metricName,
}: {
  loaded: boolean;
  metricName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function call(method: "POST" | "DELETE") {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/example-data", { method });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || "Could not reach the server.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error — try again.");
      }
    });
  }

  if (loaded) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900">
          Example data is loaded — “{metricName}” is not your revenue.
        </p>
        <p className="mt-1 text-xs text-amber-800">
          It is a sample week: two metrics, 223 events and a frozen number you can break down,
          share and schedule. Remove it and your workspace is empty again — nothing of yours is
          touched.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => call("DELETE")}
            disabled={pending}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? "Working…" : "Remove the example data"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-gray-900">
        See it with a real number — one click, no setup.
      </p>
      <p className="mt-1 text-xs text-gray-600">
        Loads a sample week: two metrics, 223 events, and a frozen number you can break down by
        channel, share as a read-only link, and schedule as a weekly report. It is example data,
        it is labelled as such, and one click removes it again.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => call("POST")}
          disabled={pending}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
        >
          {pending ? "Loading…" : "Load example data"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
