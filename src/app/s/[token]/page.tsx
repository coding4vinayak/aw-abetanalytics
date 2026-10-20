import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { findLiveSharedSnapshot, isShareToken } from "@/lib/snapshot-share";
import { formatMetricHeadline, type MetricResult } from "@/lib/metrics";

export const dynamic = "force-dynamic";

// A shared number is *unlisted*, not public: the link is the capability, so it
// must not end up in a search index.
export const metadata: Metadata = {
  title: "Shared snapshot — AbetAnalytics",
  robots: { index: false, follow: false },
};

type ShareDefinition = {
  name?: string;
  kind?: string;
  config?: {
    event?: string;
    field?: string;
    identityField?: string;
    filters?: Record<string, unknown>;
    steps?: { event?: string }[];
  };
};

function day(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * The public, read-only view of one frozen snapshot.
 *
 * Everything shown comes from the snapshot row (definition as-run + frozen
 * result); the live metric is never consulted, which is the point — renaming or
 * reconfiguring the metric afterwards cannot change what this page says. A
 * missing or revoked token is a 404, and the 404 does not distinguish the two.
 */
export default async function SharedSnapshotPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isShareToken(token)) notFound();

  const snapshot = await findLiveSharedSnapshot(token);
  if (!snapshot) notFound();

  const definition = (snapshot.definition ?? {}) as ShareDefinition;
  const result = snapshot.result as unknown as MetricResult;
  const config = definition.config ?? {};

  const facts: [string, string][] = [
    ["Kind", definition.kind ?? result.kind],
    ["Range", `${day(snapshot.rangeStart)} → ${day(snapshot.rangeEnd)}`],
  ];
  if (typeof config.event === "string") facts.push(["Event", config.event]);
  if (typeof config.field === "string") facts.push(["Field", config.field]);
  if (typeof config.identityField === "string") facts.push(["Identity", config.identityField]);
  if (Array.isArray(config.steps)) {
    facts.push(["Steps", config.steps.map((step) => step?.event ?? "?").join(" → ")]);
  }
  if (config.filters && Object.keys(config.filters).length > 0) {
    facts.push(["Filters", JSON.stringify(config.filters)]);
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <header className="mb-8 flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight text-gray-900">
          Abet<span className="text-blue-600">Analytics</span>
        </span>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
          Shared snapshot
        </span>
      </header>

      <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {definition.name ?? "Metric"}
        </p>
        <p className="mt-2 text-5xl font-bold text-gray-900">{formatMetricHeadline(result)}</p>
        <p className="mt-2 text-sm text-gray-500">
          Frozen {day(snapshot.createdAt)} · {facts[1][1]}
        </p>

        {result.kind === "funnel" && (
          <table className="mt-6 w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pb-2 font-medium">Step</th>
                <th className="pb-2 text-right font-medium">Count</th>
                <th className="pb-2 text-right font-medium">From previous</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((step) => (
                <tr key={step.event} className="border-t border-gray-100">
                  <td className="py-2 text-gray-900">{step.event}</td>
                  <td className="py-2 text-right text-gray-900">{step.count.toLocaleString()}</td>
                  <td className="py-2 text-right text-gray-600">
                    {(step.rateFromPrev * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2 className="mt-8 text-sm font-semibold text-gray-900">Definition, as run</h2>
        <p className="mt-1 text-xs text-gray-500">
          Stored with the number. Renaming or reconfiguring the metric later does not change it.
        </p>
        <dl className="mt-3 divide-y divide-gray-100 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-6 py-2">
              <dt className="text-gray-500">{label}</dt>
              <dd className="text-right font-medium text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-6 text-center text-sm text-gray-500">
        Read-only. Define a metric once and freeze the number your team agreed —{" "}
        <Link href="/" className="font-medium text-blue-600 hover:text-blue-700">
          try AbetAnalytics
        </Link>
        .
      </p>
    </main>
  );
}
