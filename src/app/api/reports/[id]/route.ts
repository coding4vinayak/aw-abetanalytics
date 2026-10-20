import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Delete a weekly report.
 *
 * Deleting the row is the whole unsubscribe: the tick reads schedules from the
 * database, so a row that is gone is a report that will not be sent, and there
 * is no scheduler in Redis left behind to clean up.
 */
async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const report = await prisma.reportSchedule.findUnique({
    where: { id },
    select: { id: true, workspaceId: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, report.workspaceId);

  await prisma.reportSchedule.delete({ where: { id: report.id } });
  return NextResponse.json({ deleted: true });
}

export const DELETE = withAuth(DELETE_impl);
