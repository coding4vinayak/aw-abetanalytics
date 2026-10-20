import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { sendReportNow } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * Send the report now.
 *
 * The button a customer clicks to find out whether the address works, and the
 * one a demo uses to show the email arriving. It freezes the current window,
 * shares the frozen number, and sends the same email the schedule would send
 * — the weekly occurrence is not consumed, so the real Monday still goes out.
 */
async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const report = await prisma.reportSchedule.findUnique({
    where: { id },
    select: { id: true, workspaceId: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, report.workspaceId);

  const sent = await sendReportNow(report.id);
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 502 });
  return NextResponse.json({ sent: true, url: sent.url, channel: sent.channel, subject: sent.subject });
}

export const POST = withAuth(POST_impl);
