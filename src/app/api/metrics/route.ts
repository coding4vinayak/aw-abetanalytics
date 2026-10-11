import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { pageParams } from "@/lib/pagination";
import { validateMetric, readMetricConfig } from "@/lib/snapshots";
import { readJson, validateBody } from "@/lib/validate";
import { METRIC_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 50);

  const where: { workspaceId: string; status?: string } = { workspaceId };
  if (status) where.status = status;

  const [metrics, total] = await Promise.all([
    prisma.metric.findMany({
      where,
      include: { _count: { select: { snapshots: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.metric.count({ where }),
  ]);
  return NextResponse.json({ metrics, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  // Scope first: a caller who is not this workspace's key holder does not get a
  // field-by-field description of what a valid metric looks like.
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, METRIC_CREATE);
  if (checked.error) return checked.error;
  const { name, description, kind, config, status } = checked.data;

  // Validate before the insert. This used to create the row, check it, and
  // delete it again — which left a broken definition in the table if the
  // process died between the two writes, and made the caller's error depend
  // on a delete succeeding.
  const inputConfig = asInputJson(config ?? {});
  const problem = validateMetric(kind, readMetricConfig(inputConfig));
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });

  const metric = await prisma.metric.create({
    data: {
      workspaceId,
      name,
      ...(description !== undefined ? { description } : {}),
      kind,
      config: inputConfig,
      ...(status !== undefined ? { status } : {}),
    },
  });

  return NextResponse.json(metric, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
