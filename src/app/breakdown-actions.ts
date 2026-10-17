"use server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { readMetricConfig, breakdownByDimension } from "@/lib/snapshots";
import { asRecord } from "@/lib/json";
import { type MetricKind } from "@/lib/metrics";

/**
 * Split a metric's movement across a dimension, from the browser session.
 *
 * The POST /api/metrics/[id]/breakdown route authenticates with a bearer key,
 * which a signed-in dashboard visitor does not carry — this is the session-side
 * twin, exactly like createFirstKey is for key minting. The workspace comes
 * from the session, never from the payload, so a tampered body cannot read
 * another tenant's events. Read-only: nothing is written.
 */
export async function getMetricBreakdown(input: {
  metricId: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  dimension?: string;
}): Promise<
  | { ok: true; dimension: string | null; rows: { dimension: string; segment: string; current: number; previous: number }[] }
  | { ok: false; error: string }
> {
  const { metricId, currentStart, currentEnd, previousStart, previousEnd, dimension } = input ?? ({} as typeof input);
  if (!metricId || !currentStart || !currentEnd || !previousStart || !previousEnd) {
    return { ok: false, error: "Missing range or metric." };
  }
  const ranges = [currentStart, currentEnd, previousStart, previousEnd].map((s) => new Date(s));
  if (ranges.some((d) => Number.isNaN(d.getTime()))) {
    return { ok: false, error: "Malformed range." };
  }

  const session = await requireSession();
  const metric = await prisma.metric.findUnique({
    where: { id: metricId },
    select: { id: true, workspaceId: true, kind: true, config: true },
  });
  if (!metric || metric.workspaceId !== session.workspaceId) {
    return { ok: false, error: "Not found." };
  }

  // Same anchoring as the route: explain the frozen snapshot the board shows,
  // falling back to the live config only before the first snapshot exists.
  const latest = await prisma.snapshot.findFirst({
    where: { metricId },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const definition = latest ? asRecord(latest.definition) : null;
  const config = readMetricConfig(definition?.config ?? metric.config);

  const rows = await breakdownByDimension({
    workspaceId: metric.workspaceId,
    kind: (definition?.kind ?? metric.kind) as MetricKind,
    config,
    current: { start: ranges[0], end: ranges[1] },
    previous: { start: ranges[2], end: ranges[3] },
    dimension: dimension || undefined,
  });

  return { ok: true, dimension: rows[0]?.dimension ?? (dimension || null), rows };
}
