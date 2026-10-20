import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody } from "@/lib/validate";
import { REPORT_CREATE } from "@/lib/fields";
import { isValidTimeZone } from "@/lib/report-schedule";
import { reportPreview } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * The weekly reports of a workspace: when they are sent, where they go, and
 * when they last went.
 *
 * The list carries the next send time, computed on read from the schedule's
 * own timezone — so it stays right across a daylight-saving change without
 * anything having to be recalculated and stored.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const reports = await prisma.reportSchedule.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: { metric: { select: { name: true, kind: true } } },
  });

  return NextResponse.json({ reports: reports.map((r) => reportPreview(r)) });
}

/**
 * Create a weekly report.
 *
 * The metric must belong to the caller's workspace, and a metric from another
 * tenant answers "not found" rather than a 403 — the same answer a missing
 * metric gets, so the endpoint cannot be used to probe for other people's
 * metric ids.
 */
async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, REPORT_CREATE);
  if (checked.error) return checked.error;
  const { metricId, email, dayOfWeek, hour, timezone, windowDays } = checked.data;

  const metric = await prisma.metric.findUnique({
    where: { id: metricId },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!metric || metric.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Metric not found" }, { status: 404 });
  }
  if (metric.status !== "ACTIVE") {
    return NextResponse.json({ error: `Metric is ${metric.status}` }, { status: 409 });
  }

  const zone = timezone ?? "UTC";
  if (!isValidTimeZone(zone)) {
    return NextResponse.json({ error: `Unknown timezone: ${zone}` }, { status: 422 });
  }

  const report = await prisma.reportSchedule.create({
    data: {
      workspaceId,
      metricId,
      // Stored lowercase: the address is the identity of the destination, and
      // two spellings of the same mailbox must not be two schedules.
      email: email.toLowerCase(),
      dayOfWeek: dayOfWeek ?? 1,
      hour: hour ?? 8,
      timezone: zone,
      windowDays: windowDays ?? 7,
    },
    include: { metric: { select: { name: true, kind: true } } },
  });

  return NextResponse.json({ report: reportPreview(report) }, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
