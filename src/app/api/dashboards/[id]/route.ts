import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody, validateArray } from "@/lib/validate";
import { DASHBOARD_UPDATE, LAYOUT_CARD, LAYOUT_MAX } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dashboard = await prisma.dashboard.findUnique({ where: { id } });
  if (!dashboard) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, dashboard.workspaceId);
  return NextResponse.json(dashboard);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  // Before the layout branch: this used to assert ownership only when `layout`
  // was present, so a PATCH carrying just {"name": …} renamed another tenant's
  // dashboard.
  const _owned = await prisma.dashboard.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const checked = validateBody(body, DASHBOARD_UPDATE, { requireWrite: true });
  if (checked.error) return checked.error;
  const { name, description, layout } = checked.data;

  let normalizedLayout: unknown[] | undefined;
  if (layout !== undefined) {
    if (!Array.isArray(layout)) {
      return NextResponse.json({ error: "layout must be an array of cards" }, { status: 422 });
    }
    const cards = validateArray(layout, LAYOUT_CARD, "layout", { max: LAYOUT_MAX });
    if (cards.error) return cards.error;
    const metricIds = [...new Set(cards.data.map((c) => c.metricId as string))];
    const found = await prisma.metric.count({ where: { workspaceId: _owned.workspaceId, id: { in: metricIds } } });
    if (found !== metricIds.length) {
      return NextResponse.json({ error: "layout names a metric outside this workspace" }, { status: 422 });
    }
    // The caller's card with the checked field over it, rather than the checked
    // card alone: a board may carry keys this table has never heard of, and a
    // route that stores only what it validates would quietly delete them.
    normalizedLayout = layout.map((card, i) => ({ ...(card as object), ...cards.data[i] }));
  }

  const updated = await prisma.dashboard.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(normalizedLayout !== undefined ? { layout: asInputJson(normalizedLayout) } : {}),
    },
  });
  return NextResponse.json(updated);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.dashboard.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.dashboard.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
