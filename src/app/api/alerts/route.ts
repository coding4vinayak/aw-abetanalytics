import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { readJson, validateBody } from "@/lib/validate";
import { ALERT_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const metricId = searchParams.get("metricId");
  if (!metricId) {
    return NextResponse.json({ error: "workspaceId or metricId required" }, { status: 400 });
  }

  const rules = await prisma.alertRule.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), ...(metricId ? { metricId } : {}) },
    include: { _count: { select: { events: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ rules });
}

async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, ALERT_CREATE);
  if (checked.error) return checked.error;
  const { metricId, name, operator, threshold, webhookUrl, isActive } = checked.data;

  // The URL is checked here rather than declared, because what matters about it
  // is not its shape: `evaluateAlertRules` POSTs to this value from the server
  // (alerts.ts:43), so any host a caller can name — including one only reachable
  // from inside this network — becomes a request this server makes. `egress.ts`
  // owns that policy; this is its write boundary, and the same check runs again on
  // the way out, because a rule can outlive the name its address pointed at.
  const target = await classifyTarget(webhookUrl, "webhookUrl");
  if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 422 });

  const metric = await prisma.metric.findUnique({ where: { id: metricId }, select: { id: true, workspaceId: true } });
  if (!metric || metric.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Metric not found in this workspace" }, { status: 404 });
  }

  const rule = await prisma.alertRule.create({
    data: {
      workspaceId,
      metricId,
      name,
      operator,
      threshold,
      webhookUrl,
      // `isActive: Boolean(isActive)` measured as storing **true** for `"no"`,
      // for `"false"` and for `[]`. The column's default is already true, so an
      // absent field needs no spread at all — and a present one is now a boolean.
      ...(isActive !== undefined ? { isActive } : {}),
    },
  });
  return NextResponse.json(rule, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
