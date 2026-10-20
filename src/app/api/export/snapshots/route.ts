import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, snapshotCsv } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/snapshots — the board pack, as CSV.
 *
 * One row per frozen snapshot, with the definition and result that produced it.
 * The homepage says metrics, snapshots and funnels all export for board packs;
 * this is the file that sentence promises. Funnels are snapshots whose `kind`
 * is `funnel`; their step counts and conversion rates are in `result_json`,
 * and the headline column is the overall conversion percentage.
 *
 * Owner/admin only for the same reason as the workspace export: this is every
 * number the workspace has ever frozen, not a single shared link.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!canManageRoles(session.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can export the workspace." },
      { status: 403 },
    );
  }

  try {
    const rows = await prisma.snapshot.findMany({
      where: { workspaceId: session.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        metricId: true,
        rangeStart: true,
        rangeEnd: true,
        definition: true,
        result: true,
        createdAt: true,
        shareCreatedAt: true,
        shareRevokedAt: true,
      },
    });
    const body = snapshotCsv(rows);
    return new NextResponse(body, {
      status: 200,
      headers: exportDownloadHeaders(
        exportFilename(session.workspaceSlug, "snapshots"),
        "text/csv; charset=utf-8",
      ),
    });
  } catch (err) {
    console.error("[export] board-pack export failed:", err);
    return NextResponse.json({ error: "Could not build the board pack." }, { status: 500 });
  }
}
