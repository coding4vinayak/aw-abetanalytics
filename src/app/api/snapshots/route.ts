import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId, assertOwns, ApiKeyError } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { takeSnapshot } from "@/lib/snapshots";
import { intParam } from "@/lib/pagination";
import { asDate, boolFlag, readJson, validateBody } from "@/lib/validate";
import { SNAPSHOT_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const metricId = searchParams.get("metricId");
  const limit = intParam(searchParams, "limit", 20, 1, 100);

  if (!workspaceId && !metricId) {
    return NextResponse.json({ error: "workspaceId or metricId required" }, { status: 400 });
  }

  const snapshots = await prisma.snapshot.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), ...(metricId ? { metricId } : {}) },
    include: { metric: { select: { id: true, name: true, kind: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ snapshots });
}

async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const checked = validateBody(body, SNAPSHOT_CREATE);
  if (checked.error) return checked.error;
  const { metricId } = checked.data;
  const rangeStart = asDate(checked.data.rangeStart);
  const rangeEnd = asDate(checked.data.rangeEnd);

  // The table can say both ends are dates; only this route can say which comes
  // first, and a zero-length or backwards range produces a snapshot whose result
  // has no headline number — the state /api/ai/explain-metric later answers 422
  // for. Measured, this check already existed and already answered 422.
  if (rangeEnd <= rangeStart) {
    return NextResponse.json({ error: "rangeEnd must be after rangeStart" }, { status: 422 });
  }

  // `sync` is a route-control flag, not a column, so it is read after the table
  // rather than declared in it. Before, the only value the route honoured was
  // `sync === false`: measured, `sync: "no"` — the word for "do not do this
  // inline" — took the *inline* branch and answered 201 with a finished
  // snapshot, because everything that is not exactly `false` was the default.
  const sync = boolFlag(body.sync, "sync");
  if (sync.error) return sync.error;

  const metric = await prisma.metric.findUnique({ where: { id: metricId }, select: { id: true, workspaceId: true } });
  if (!metric) return NextResponse.json({ error: "Metric not found" }, { status: 404 });
  await assertOwns(request, metric.workspaceId);

  if (sync.value === false) {
    try {
      await enqueue(queues.snapshots, "take-snapshot", {
        metricId,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
      });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ queued: true }, { status: 202 });
  }

  try {
    const { snapshot, result, headline, alertsFired } = await takeSnapshot(metricId, rangeStart, rangeEnd);
    return NextResponse.json({ snapshot, result, headline, alertsFired }, { status: 201 });
  } catch (error) {
    // An ownership refusal is a 401/403/404 with a status already chosen by
    // `withAuth`, and this catch used to run it through the message comparison
    // below: measured, `assertOwns` refusing another workspace's metric answered
    // 422 "Not found." — the right words at the wrong status, which is how a
    // client learns to retry an authorization failure as a bad request.
    if (error instanceof ApiKeyError) throw error;
    const message = error instanceof Error ? error.message : "compute failed";
    const status = message === "Metric not found" ? 404 : message.startsWith("Metric is") ? 409 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
