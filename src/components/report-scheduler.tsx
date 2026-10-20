"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import {
  createReportAction,
  deleteReportAction,
  sendReportNowAction,
} from "@/app/report-actions";

type Metric = { id: string; name: string };

export type ScheduledReport = {
  id: string;
  metricId: string;
  metricName: string | null;
  email: string;
  dayOfWeek: number;
  hour: number;
  timezone: string;
  windowDays: number;
  lastSentAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The zones offered by the picker. A short list, not a searchable database of
 * 400: the common ones cover the buyers, and the field is still a free-text
 * input underneath (the browser's own zone is added to the list automatically),
 * so nobody is locked out of a zone we did not think of.
 */
const ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Australia/Sydney",
];

/**
 * "Every Monday at 08:00 (Europe/Berlin)" — and the next run, printed in the
 * schedule's own zone, because that is the clock the promise was made in.
 */
function describe(report: ScheduledReport): string {
  const day = DAYS[report.dayOfWeek] ?? "—";
  const hour = String(report.hour).padStart(2, "0");
  return `Every ${day} at ${hour}:00 (${report.timezone})`;
}

function when(instant: string | null, timeZone: string): string {
  if (!instant) return "—";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * The weekly report panel: set a schedule, watch it fire, cancel it.
 *
 * It talks to the session-side actions, so the browser never holds an API key,
 * and the schedule is a row in the database rather than a job in Redis — which
 * is why cancelling is one click and takes effect immediately, even if the app
 * has been restarted since the schedule was made.
 */
export function ReportScheduler({
  metrics,
  reports,
}: {
  metrics: Metric[];
  reports: ScheduledReport[];
}) {
  const [metricId, setMetricId] = useState(metrics[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [hour, setHour] = useState("8");
  const [windowDays, setWindowDays] = useState("7");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // The browser's own zone is the one the customer means, so it is offered
  // first and pre-selected. It is the one value here that differs between the
  // server (which has no browser zone) and the client, and `useSyncExternalStore`
  // is how React reads such a value: it hydrates with the server snapshot and
  // re-renders with the browser's — no mismatch, and no effect that sets state.
  const browserZone = useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "UTC",
  );
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const timezone = chosenZone ?? browserZone;
  const zoneOptions = browserZone && !ZONES.includes(browserZone) ? [browserZone, ...ZONES] : ZONES;

  function schedule() {
    setMessage(null);
    startTransition(async () => {
      const res = await createReportAction({
        metricId,
        email,
        dayOfWeek,
        hour,
        timezone,
        windowDays,
      });
      setMessage(
        res.ok
          ? { tone: "ok", text: res.message }
          : { tone: "bad", text: res.error },
      );
      if (res.ok) setEmail("");
    });
  }

  function cancel(id: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await deleteReportAction(id);
      setMessage(res.ok ? { tone: "ok", text: res.message } : { tone: "bad", text: res.error });
    });
  }

  function sendNow(id: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await sendReportNowAction(id);
      setMessage(res.ok ? { tone: "ok", text: res.message } : { tone: "bad", text: res.error });
    });
  }

  return (
    <div>
      {metrics.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <label className="text-xs font-medium text-gray-600 lg:col-span-2">
              Metric
              <select
                value={metricId}
                onChange={(e) => setMetricId(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                {metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600 lg:col-span-2">
              Send to
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Day
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                {DAYS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Hour
              <select
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={String(h)}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Timezone
              <select
                value={timezone}
                onChange={(e) => setChosenZone(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                {zoneOptions.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Window
              <select
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900"
              >
                <option value="1">Last day</option>
                <option value="7">Last 7 days</option>
                <option value="14">Last 14 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={schedule}
              disabled={pending || !email || !metricId}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
            >
              {pending ? "Working…" : "Schedule report"}
            </button>
            <p className="text-xs text-gray-500">
              The number is frozen when the report is sent, with its definition and a read-only
              link.
            </p>
          </div>
        </div>
      )}

      {message && (
        <p className={`mt-3 text-sm ${message.tone === "ok" ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </p>
      )}

      {reports.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No weekly reports yet. Schedule one and the frozen number arrives on its own.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {reports.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 p-4 text-sm"
            >
              <div>
                <p className="font-medium text-gray-900">{r.metricName ?? "Metric"}</p>
                <p className="text-xs text-gray-500">
                  {describe(r)} · to {r.email} · last {r.windowDays} day
                  {r.windowDays === 1 ? "" : "s"}
                </p>
                <p className="text-xs text-gray-500">
                  Next: {when(r.nextRunAt, r.timezone)}
                  {r.lastSentAt ? ` · last sent ${when(r.lastSentAt, r.timezone)}` : " · never sent"}
                </p>
                {r.lastError && <p className="text-xs text-red-600">Last error: {r.lastError}</p>}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => sendNow(r.id)}
                  disabled={pending}
                  className="font-medium text-violet-600 hover:text-violet-700 disabled:opacity-50"
                >
                  Send now
                </button>
                <button
                  type="button"
                  onClick={() => cancel(r.id)}
                  disabled={pending}
                  className="font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
