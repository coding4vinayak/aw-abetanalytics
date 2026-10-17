import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readMetricConfig, breakdownByDimension } from "@/lib/snapshots";
import { type MetricKind } from "@/lib/metrics";
import { asRecord } from "@/lib/json";
import { readJson, validateBody } from "@/lib/validate";
import { BREAKDOWN } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * POST /api/metrics/[id]/breakdown
 *
 * Split a metric's movement across the values of one dimension between
 * two adjacent ranges. The metric's kind and frozen config are read from
 * the most recent snapshot so the breakdown cannot disagree with the
 * headline it is explaining.
 *
 * Read-only: no snapshot, metric, or event is written.
 */
async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  // Side-effect only: validates the key and its workspace claim. The workspace
  // actually queried comes from the owned metric below, never from this value.
  await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, BREAKDOWN);
  if (checked.error) return checked.error;
  const { metricId, currentStart, currentEnd, previousStart, previousEnd, dimension } = checked.data;

  if (metricId !== id) {
    return NextResponse.json({ error: "metricId mismatch" }, { status: 400 });
  }

  const metric = await prisma.metric.findUnique({ where: { id: metricId }, select: { id: true, workspaceId: true, kind: true, config: true } });
  if (!metric) return NextResponse.json({ error: "Metric not found" }, { status: 404 });
  await assertOwns(request, metric.workspaceId);

  // Anchor to the latest snapshot's frozen definition so the breakdown
  // explains the same number the board saw — not a metric that may have
  // been edited since. If no snapshot exists yet, fall back to the live
  // metric config (the only way a caller can get a breakdown before the
  // first snapshot is taken).
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
    current: { start: new Date(currentStart), end: new Date(currentEnd) },
    previous: { start: new Date(previousStart), end: new Date(previousEnd) },
    dimension,
  });

  return NextResponse.json({
    metricId,
    dimension: rows[0]?.dimension ?? dimension ?? null,
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: previousEnd },
    breakdown: rows,
  });
}

export const POST = withAuth(POST_impl);