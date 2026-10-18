import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { validateMetric, readMetricConfig, loadEvents } from "@/lib/snapshots";
import { computeMetric, type MetricKind } from "@/lib/metrics";
import { readJson, validateBody } from "@/lib/validate";
import { METRIC_UPDATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const metric = await prisma.metric.findUnique({
    where: { id },
    include: { snapshots: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!metric) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, metric.workspaceId);

  const { searchParams } = new URL(request.url);
  if (!searchParams.get("preview")) return NextResponse.json(metric);

  // Preview computes without persisting: ?preview=1&start=&end=
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "preview needs start and end" }, { status: 400 });
  const rangeStart = new Date(start);
  const rangeEnd = new Date(end);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
    return NextResponse.json({ error: "invalid range" }, { status: 422 });
  }
  // Same rule as POST /api/snapshots: a backwards or zero-length range has no
  // headline number, and preview must not be the place that pretends it does.
  if (rangeEnd <= rangeStart) {
    return NextResponse.json({ error: "rangeEnd must be after rangeStart" }, { status: 422 });
  }
  // Shared with snapshots so preview and a frozen number are computed from the
  // same bounded read — including the refusal when the range exceeds the bound.
  const events = await loadEvents(metric.workspaceId, rangeStart, rangeEnd);
  const result = computeMetric(
    metric.kind as MetricKind,
    readMetricConfig(metric.config),
    events,
    { start: rangeStart, end: rangeEnd },
  );
  return NextResponse.json({ metric, preview: result });
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const current = await prisma.metric.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, current.workspaceId);

  const checked = validateBody(body, METRIC_UPDATE, { requireWrite: true });
  if (checked.error) return checked.error;
  const { name, description, kind, config, status } = checked.data;

  // The kind and the config are one decision, not two: a count whose event
  // config is being replaced, or a config left alone while the kind changes,
  // both have to still validate against whatever the row will look like after
  // the write. Measured, the old route checked `typeof kind === "string" ? kind
  // : current.kind` and then wrote `kind` whatever it was, so `kind: 42` was
  // validated as the old kind and stored as a number — a 500 in Prisma's
  // client, which is the least harmful thing that could happen to it.
  const nextKind = kind ?? current.kind;
  const nextConfig = config !== undefined ? config : current.config;
  const problem = validateMetric(nextKind, readMetricConfig(nextConfig));
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });

  const metric = await prisma.metric.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(config !== undefined ? { config: asInputJson(config) } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  return NextResponse.json(metric);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.metric.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.metric.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
