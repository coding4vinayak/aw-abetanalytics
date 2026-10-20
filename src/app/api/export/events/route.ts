import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { eventCsvHeader, eventCsvRow, exportDownloadHeaders, exportFilename } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * How many event rows are read and encoded at a time. Small enough that a
 * million-event workspace never holds the feed in memory, large enough that the
 * database is not asked for one row per round trip.
 */
const EVENT_BATCH = 500;

/**
 * GET /api/export/events — every raw event, streamed as CSV.
 *
 * This is the half of "export everything" that cannot honestly fit in the JSON
 * document: a workspace's event table has no useful upper bound, and loading it
 * all into one `JSON.stringify` would turn a data-rights door into an out-of-
 * memory error. The stream pages by primary key (`id > cursor`) and writes each
 * batch as it arrives, so the response starts before the table has been read.
 *
 * Authentication is checked before the stream is constructed. The stream itself
 * only reads the workspaceId captured from that session; a caller cannot change
 * the scope after the headers are sent.
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

  const workspaceId = session.workspaceId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | undefined;
      try {
        controller.enqueue(encoder.encode(eventCsvHeader()));
        for (;;) {
          const rows = await prisma.event.findMany({
            where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: EVENT_BATCH,
            select: {
              id: true,
              type: true,
              occurredAt: true,
              dimensions: true,
              value: true,
              createdAt: true,
            },
          });
          if (rows.length === 0) break;

          let chunk = "";
          for (const row of rows) chunk += eventCsvRow(row);
          controller.enqueue(encoder.encode(chunk));

          cursor = rows[rows.length - 1].id;
          if (rows.length < EVENT_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] event stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "events"),
      "text/csv; charset=utf-8",
    ),
  });
}
