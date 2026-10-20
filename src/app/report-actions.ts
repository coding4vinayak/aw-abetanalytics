"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { REPORT_CREATE } from "@/lib/fields";
import { validateBody } from "@/lib/validate";
import { isValidTimeZone } from "@/lib/report-schedule";
import { sendReportNow } from "@/lib/reports";

export type ReportActionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * The weekly report, from the browser session.
 *
 * The API twin is `POST /api/reports`; this is the dashboard's door, and it
 * exists for the same reason the Breakdown action does — a signed-in visitor
 * does not carry an API key, and handing the browser one to create a report
 * would be handing out a machine credential to a page.
 *
 * The workspace comes from the session, never from the payload, and the metric
 * must belong to it: a tampered body cannot schedule someone else's number.
 * The rules themselves are the `REPORT_CREATE` table — the same table the API
 * route validates against, so the two doors cannot disagree about what a valid
 * report is.
 */
export async function createReportAction(input: {
  metricId: string;
  email: string;
  dayOfWeek: number | string;
  hour: number | string;
  timezone?: string;
  windowDays?: number | string;
}): Promise<ReportActionResult> {
  const session = await requireSession();

  const body = {
    metricId: input?.metricId,
    email: input?.email,
    dayOfWeek: input?.dayOfWeek === undefined || input?.dayOfWeek === "" ? undefined : Number(input.dayOfWeek),
    hour: input?.hour === undefined || input?.hour === "" ? undefined : Number(input.hour),
    timezone: input?.timezone,
    windowDays:
      input?.windowDays === undefined || input?.windowDays === "" ? undefined : Number(input.windowDays),
  };

  const checked = validateBody(body, REPORT_CREATE);
  if (!checked.ok) {
    const detail = (await checked.error.json()) as { error?: string };
    return { ok: false, error: detail.error ?? "That report is not valid." };
  }
  const { metricId, email, dayOfWeek, hour, timezone, windowDays } = checked.data;

  const metric = await prisma.metric.findUnique({
    where: { id: metricId },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!metric || metric.workspaceId !== session.workspaceId) {
    return { ok: false, error: "Metric not found." };
  }
  if (metric.status !== "ACTIVE") {
    return { ok: false, error: `Metric is ${metric.status} — archive it first.` };
  }

  const zone = timezone ?? "UTC";
  if (!isValidTimeZone(zone)) {
    return { ok: false, error: `Unknown timezone: ${zone}.` };
  }

  await prisma.reportSchedule.create({
    data: {
      workspaceId: session.workspaceId,
      metricId,
      email: email.toLowerCase(),
      dayOfWeek: dayOfWeek ?? 1,
      hour: hour ?? 8,
      timezone: zone,
      windowDays: windowDays ?? 7,
    },
  });

  revalidatePath("/dashboard");
  return { ok: true, message: "Report scheduled." };
}

/** Stop a report. Deleting the row is the whole unsubscribe. */
export async function deleteReportAction(reportId: string): Promise<ReportActionResult> {
  const session = await requireSession();
  const report = await prisma.reportSchedule.findUnique({
    where: { id: reportId },
    select: { id: true, workspaceId: true },
  });
  if (!report || report.workspaceId !== session.workspaceId) {
    return { ok: false, error: "Not found." };
  }

  await prisma.reportSchedule.delete({ where: { id: report.id } });
  revalidatePath("/dashboard");
  return { ok: true, message: "Report cancelled." };
}

/**
 * Send the report now, to check the address works.
 *
 * It does not consume the weekly slot: the occurrence is not touched, so the
 * real Monday still goes out.
 */
export async function sendReportNowAction(reportId: string): Promise<ReportActionResult> {
  const session = await requireSession();
  const report = await prisma.reportSchedule.findUnique({
    where: { id: reportId },
    select: { id: true, workspaceId: true },
  });
  if (!report || report.workspaceId !== session.workspaceId) {
    return { ok: false, error: "Not found." };
  }

  const sent = await sendReportNow(report.id);
  if (!sent.ok) return { ok: false, error: sent.error };

  revalidatePath("/dashboard");
  return {
    ok: true,
    message:
      sent.channel === "log"
        ? "Sent — but this deployment has no mail provider, so it was written to the server log."
        : "Sent.",
  };
}
