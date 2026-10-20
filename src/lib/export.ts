import { prisma } from "./db";
import { asRecord } from "./json";
import { metricHeadline, type MetricResult } from "./metrics";

/**
 * The export surface, which is what "Export anytime" and "for board packs"
 * have to mean.
 *
 * Three doors, each answering a different question:
 *
 *   - `buildWorkspaceExport` is the portable copy: team, invitations, metric
 *     definitions, frozen snapshots, dashboards, alert rules and deliveries,
 *     and webhook configuration, as one human-readable JSON document.
 *   - `snapshotCsv` is the board pack: one row per frozen snapshot, with the
 *     definition and result that produced it. A funnel is a snapshot like any
 *     other; its step counts and rates live in `result_json` and its headline
 *     is the conversion percentage.
 *   - `eventCsvHeader` / `eventCsvRow` are the raw event feed. The route streams
 *     these in batches, so a workspace with millions of events does not have to
 *     fit in memory to take its own data with it.
 *
 * Two rules decide the shape, and both are stricter than "dump the tables":
 *
 *   - **Content, not credentials.** Members, invitations, metrics, snapshots,
 *     dashboards, alert rules, deliveries, webhooks and events are the
 *     workspace's data. Password digests, session tokens, API-key hashes,
 *     invitation token hashes, alert/webhook signing secrets and Stripe ids are
 *     not — exporting them would turn a download into a credential leak. A
 *     share token is a capability too, so snapshots carry `shared: true` and
 *     the dates, never the URL.
 *   - **The workspace is the filter.** Every query is scoped by workspaceId.
 *     A bug in the caller cannot turn one buyer's export into another's.
 *
 * The JSON is built in memory on purpose: it is the copy a buyer reads, and
 * ids are preserved so rows can be rejoined. Raw events are deliberately not
 * embedded; they have their own streamed door, and `rawEvents.download` in the
 * document points at it rather than pretending a truncated array is everything.
 */
export const EXPORT_FORMAT = "abetanalytics.workspace";
export const EXPORT_VERSION = 1;

/**
 * A workspace slug is user-facing text, even though signup generates it. This
 * collapses everything outside `[a-z0-9-]`, which removes quotes, separators
 * and CR/LF before the value can reach Content-Disposition.
 */
function safeSlug(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

/** The download filename, kept pure so the header path can be proven without a database. */
export function exportFilename(
  slug: string,
  part: "workspace" | "snapshots" | "events",
  at: Date = new Date(),
): string {
  const extension = part === "workspace" ? "json" : "csv";
  return `abetanalytics-${safeSlug(slug)}-${part}-${at.toISOString().slice(0, 10)}.${extension}`;
}

/** The headers every export shares. `no-store` matters: a shared proxy must not keep a copy. */
export function exportDownloadHeaders(filename: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

export async function buildWorkspaceExport(workspaceId: string, exportedAt: Date = new Date()) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error("Workspace not found");

  const [
    members,
    invitations,
    metrics,
    snapshots,
    dashboards,
    alertRules,
    alertEvents,
    webhooks,
    rawEventCount,
  ] = await Promise.all([
    prisma.membership.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true, name: true, emailVerified: true } },
      },
    }),
    prisma.invite.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      // tokenHash is deliberately absent: it is a live credential's digest,
      // not content the buyer needs to take with them.
      select: {
        id: true,
        email: true,
        role: true,
        createdById: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
      },
    }),
    prisma.metric.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        kind: true,
        config: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.snapshot.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      // The token is a capability. The dates are enough to tell a reader
      // whether a frozen number was ever shared, without handing them a URL.
      select: {
        id: true,
        metricId: true,
        rangeStart: true,
        rangeEnd: true,
        definition: true,
        result: true,
        createdAt: true,
        shareCreatedAt: true,
        shareRevokedAt: true,
      },
    }),
    prisma.dashboard.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        layout: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.alertRule.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      // The signing secret is a credential. The rule, threshold and
      // destination are configuration the buyer can recognize in a new home.
      select: {
        id: true,
        metricId: true,
        name: true,
        operator: true,
        threshold: true,
        webhookUrl: true,
        isActive: true,
        lastFiredAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.alertEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        ruleId: true,
        snapshotId: true,
        value: true,
        delivered: true,
        error: true,
        createdAt: true,
      },
    }),
    prisma.webhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.event.count({ where: { workspaceId } }),
  ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    workspace,
    counts: {
      members: members.length,
      invitations: invitations.length,
      metrics: metrics.length,
      snapshots: snapshots.length,
      dashboards: dashboards.length,
      alertRules: alertRules.length,
      alertEvents: alertEvents.length,
      webhooks: webhooks.length,
      events: rawEventCount,
    },
    notes: [
      "Credentials are excluded: password digests, session tokens, API keys and their hashes, invitation token hashes, alert and webhook signing secrets, and Stripe billing ids.",
      "A snapshot's share token is excluded; shared tells you whether a link is live, not what the link is.",
      "Raw events are not embedded in this document. Download them from GET /api/export/events, which streams CSV in batches.",
    ],
    rawEvents: {
      count: rawEventCount,
      download: "/api/export/events",
      contentType: "text/csv; charset=utf-8",
    },
    members,
    invitations,
    metrics,
    snapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      shared: Boolean(snapshot.shareCreatedAt && !snapshot.shareRevokedAt),
    })),
    dashboards,
    alertRules,
    alertEvents,
    webhooks,
  };
}

export type WorkspaceExport = Awaited<ReturnType<typeof buildWorkspaceExport>>;

/* ------------------------------------------------------------------ board pack */

export interface SnapshotCsvRow {
  id: string;
  metricId: string;
  rangeStart: Date | string;
  rangeEnd: Date | string;
  definition: unknown;
  result: unknown;
  createdAt: Date | string;
  shareCreatedAt: Date | string | null;
  shareRevokedAt: Date | string | null;
}

/**
 * A cell that Excel would otherwise run as a formula. Metric names, event types
 * and dimension values are user text; a leading `=`, `+`, `-`, `@`, tab or CR is
 * the CSV injection shape, so it is prefixed with an apostrophe. Numbers are
 * written through `numberCell` and never touched.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function numberCell(value: number | null): string {
  return value !== null && Number.isFinite(value) ? String(value) : "";
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function snapshotHeadline(result: unknown): number | null {
  if (result === null || typeof result !== "object") return null;
  try {
    const headline = metricHeadline(result as MetricResult);
    return typeof headline === "number" && Number.isFinite(headline) ? headline : null;
  } catch {
    return null;
  }
}

function headlineDisplay(result: unknown): string {
  const headline = snapshotHeadline(result);
  if (headline === null) return "";
  if (asRecord(result).kind === "funnel") return `${(headline * 100).toFixed(1)}%`;
  if (Number.isInteger(headline)) return headline.toLocaleString("en-US");
  return headline.toFixed(1);
}

const SNAPSHOT_HEADER = [
  "snapshot_id",
  "metric_id",
  "metric_name",
  "kind",
  "range_start",
  "range_end",
  "taken_at",
  "headline",
  "headline_display",
  "shared",
  "definition_json",
  "result_json",
];

/**
 * One row per frozen answer. Names and kinds come from the snapshot's frozen
 * definition, not from the metric as it is today: a board pack that renamed
 * last quarter's metric would be the exact rewrite snapshots exist to prevent.
 */
export function snapshotCsv(rows: SnapshotCsvRow[]): string {
  const lines = [SNAPSHOT_HEADER.map(textCell).join(",")];
  for (const row of rows) {
    const definition = asRecord(row.definition);
    const name = typeof definition.name === "string" ? definition.name : "";
    const kind = typeof definition.kind === "string" ? definition.kind : "";
    lines.push(
      [
        textCell(row.id),
        textCell(row.metricId),
        textCell(name),
        textCell(kind),
        textCell(iso(row.rangeStart)),
        textCell(iso(row.rangeEnd)),
        textCell(iso(row.createdAt)),
        numberCell(snapshotHeadline(row.result)),
        textCell(headlineDisplay(row.result)),
        textCell(row.shareCreatedAt && !row.shareRevokedAt ? "yes" : "no"),
        textCell(jsonText(row.definition)),
        textCell(jsonText(row.result)),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ raw events */

export interface EventCsvRow {
  id: string;
  type: string;
  occurredAt: Date | string;
  dimensions: unknown;
  value: number | null;
  createdAt: Date | string;
}

const EVENT_HEADER = ["id", "type", "occurred_at", "value", "dimensions", "created_at"];

export function eventCsvHeader(): string {
  return `${EVENT_HEADER.map(textCell).join(",")}\r\n`;
}

export function eventCsvRow(row: EventCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.type),
      textCell(iso(row.occurredAt)),
      numberCell(row.value),
      textCell(jsonText(row.dimensions)),
      textCell(iso(row.createdAt)),
    ].join(",") + "\r\n"
  );
}
