"use client";

import { useState } from "react";
import { getMetricBreakdown } from "@/app/breakdown-actions";

type Row = { dimension: string; segment: string; current: number; previous: number };

/**
 * "Breakdown" link plus its modal, one per metric row.
 *
 * The ranges come from the metric's latest snapshot (passed as ISO strings by
 * the server page — Dates do not cross the boundary). The previous range is
 * the same window immediately before it, so the modal answers "what moved,
 * and where". Numbers are produced by breakdownByDimension — the metric engine
 * itself per segment — never a second counting rule.
 */
export function BreakdownButton({
  metricId,
  name,
  kind,
  rangeStart,
  rangeEnd,
}: {
  metricId: string;
  name: string;
  kind: string;
  rangeStart: string;
  rangeEnd: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [detected, setDetected] = useState<string | null>(null);
  const [override, setOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (dimension?: string) => {
    const span = new Date(rangeEnd).getTime() - new Date(rangeStart).getTime();
    const previousEnd = new Date(new Date(rangeStart).getTime() - 1).toISOString();
    const previousStart = new Date(new Date(previousEnd).getTime() - span).toISOString();
    setLoading(true);
    setError(null);
    try {
      const res = await getMetricBreakdown({
        metricId,
        currentStart: rangeStart,
        currentEnd: rangeEnd,
        previousStart,
        previousEnd,
        dimension: dimension || undefined,
      });
      if (res.ok) {
        setRows(res.rows);
        setDetected(res.dimension);
      } else {
        setError(res.error);
      }
    } catch {
      setError("Failed to load breakdown.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          void load();
        }}
        className="text-xs text-violet-600 hover:text-violet-800 underline"
      >
        Breakdown
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">
                Breakdown: {name} ({kind})
              </h3>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-700 text-xl leading-none" aria-label="Close">
                ×
              </button>
            </div>
            <div className="flex items-center gap-2 p-4 border-b border-gray-100 text-sm">
              <span className="text-gray-600">
                Dimension: <b className="text-gray-900">{detected ?? "auto"}</b>
              </span>
              <input
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                placeholder="override (e.g. channel)"
                className="ml-2 rounded border border-gray-300 px-2 py-1 text-xs"
              />
              <button
                onClick={() => void load(override)}
                className="rounded bg-gray-900 px-3 py-1 text-xs font-semibold text-white hover:bg-gray-700"
              >
                Apply
              </button>
              {loading && <span className="text-gray-500 animate-pulse">Loading…</span>}
              {error && <span className="text-red-600">{error}</span>}
            </div>
            <div className="p-4">
              {rows.length === 0 && !loading ? (
                <p className="text-sm text-gray-500">No segments found for these ranges.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="pb-2 pr-4 font-medium">Segment</th>
                        <th className="pb-2 pr-4 font-medium text-right">Current</th>
                        <th className="pb-2 pr-4 font-medium text-right">Previous</th>
                        <th className="pb-2 pr-4 font-medium text-right">Delta</th>
                        <th className="pb-2 font-medium text-right">Change %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const delta = r.current - r.previous;
                        const pct = r.previous === 0 ? null : (delta / r.previous) * 100;
                        return (
                          <tr key={`${i}-${r.segment}`} className="border-t border-gray-100">
                            <td className="py-3 pr-4 font-medium text-gray-900">{r.segment}</td>
                            <td className="py-3 pr-4 text-right text-gray-900">{r.current.toLocaleString()}</td>
                            <td className="py-3 pr-4 text-right text-gray-600">{r.previous.toLocaleString()}</td>
                            <td className="py-3 pr-4 text-right font-semibold text-gray-900">
                              {delta >= 0 ? "+" : ""}
                              {delta.toLocaleString()}
                            </td>
                            <td className={`py-3 text-right font-semibold ${pct === null ? "text-gray-400" : delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                              {pct === null ? "new" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="px-4 pb-4 text-xs text-gray-400">
              Segments are computed by the metric engine itself over the snapshot&apos;s frozen definition — the breakdown cannot
              disagree with the headline.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
