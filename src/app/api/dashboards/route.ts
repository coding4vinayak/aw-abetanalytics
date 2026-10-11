import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody, validateArray } from "@/lib/validate";
import { DASHBOARD_CREATE, LAYOUT_CARD, LAYOUT_MAX } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const dashboards = await prisma.dashboard.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ dashboards });
}

async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, DASHBOARD_CREATE);
  if (checked.error) return checked.error;
  const { name, description, layout } = checked.data;

  if (!Array.isArray(layout)) {
    return NextResponse.json({ error: "layout must be an array of cards" }, { status: 422 });
  }
  const cards = validateArray(layout, LAYOUT_CARD, "layout", { max: LAYOUT_MAX });
  if (cards.error) return cards.error;

  const metricIds = [...new Set(cards.data.map((c) => c.metricId as string))];
  const found = await prisma.metric.count({ where: { workspaceId, id: { in: metricIds } } });
  if (found !== metricIds.length) {
    return NextResponse.json({ error: "layout names a metric outside this workspace" }, { status: 422 });
  }

  const dashboard = await prisma.dashboard.create({
    data: {
      workspaceId,
      name,
      ...(description !== undefined ? { description } : {}),
      // Checked fields over the caller's own card, rather than the checked card
      // alone: a board may carry keys this table has never heard of, and a route
      // that stores what it validates would quietly delete them.
      layout: asInputJson(layout.map((card, i) => ({ ...card as object, ...cards.data[i] }))),
    },
  });
  return NextResponse.json(dashboard, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
