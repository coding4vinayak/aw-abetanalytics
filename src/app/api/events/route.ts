import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { intParam } from "@/lib/pagination";
import { asDate, readJson, validateArray } from "@/lib/validate";
import { EVENT_BATCH_MAX, EVENT_ITEM } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const type = searchParams.get("type");
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  const limit = intParam(searchParams, "limit", 50, 1, 500);

  const events = await prisma.event.findMany({
    where: {
      workspaceId,
      ...(type ? { type } : {}),
      ...(since || until
        ? {
            occurredAt: {
              ...(since ? { gte: new Date(since) } : {}),
              ...(until ? { lt: new Date(until) } : {}),
            },
          }
        : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ events });
}

/**
 * POST /api/events — the ingestion boundary.
 *
 * Every failure mode measured here was a 201. `parseEvent` returned `null` for a
 * malformed event and the route counted the survivors, so a batch of typed
 * mistakes was reported as a successful ingest of whatever happened to be left;
 * and `rawList.slice(0, 1000)` then `skipped: Math.min(rawList.length, 1000) -
 * rows.length` measured as answering `{"ingested":1000,"skipped":0}` to a 1002-event
 * batch, because the cap and the subtraction used different totals.
 *
 * So this route does not skip. One table (`EVENT_ITEM`) applied to every element
 * with its position in the field name, and a whole-batch refusal if any element
 * is wrong: a caller who is told `events[7].value must be a finite number, got
 * "5" as text` can fix seven-indexed-of-one and resend, whereas a caller told
 * `ingested: 999` has to diff their own batch against the database to find the
 * row that never arrived. That trade — no partial writes, one round trip to fix —
 * is deliberate for a metrics feed, where a silently missing event is invisible
 * in the number it should have moved.
 */
async function POST_impl(request: Request) {
  const read = await readJson(request);
  if (read.error) return read.error;
  const { body } = read;

  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  // One event or a batch: the route has always accepted `{"type": …}` directly,
  // so the array is built here rather than demanded of the caller. The field is
  // named `events` whenever the key is present — `events: "prose"` is a mistake
  // about `events`, and calling it `body` sends the caller to the wrong line.
  const batch = body.events !== undefined;
  const list = batch ? body.events : [body];

  const checked = validateArray(list, EVENT_ITEM, batch ? "events" : "body", {
    max: EVENT_BATCH_MAX,
  });
  if (checked.error) return checked.error;

  const rows = checked.data.map((event) => ({
    workspaceId,
    type: event.type as string,
    occurredAt: event.occurredAt === undefined ? new Date() : asDate(event.occurredAt as Date | string),
    ...(event.value !== undefined ? { value: event.value as number } : {}),
    ...(event.dimensions !== undefined ? { dimensions: event.dimensions as object } : {}),
  }));

  await prisma.event.createMany({ data: rows });
  return NextResponse.json({ ingested: rows.length }, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
