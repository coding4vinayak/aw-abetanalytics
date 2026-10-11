import { NextResponse } from "next/server";

/**
 * A wrong-typed scalar used to be the database's problem, and the database
 * answers in one of three unhelpful ways. The table below is what
 * abetanalytics' write routes did before this existed. Every row was recorded
 * by `n5-an-before.mts`: 99 cases sent over HTTP to this app's own dev server
 * on :3600, one wrong field per case in an otherwise-valid body, with a minted
 * key (output: `n5-an-before.txt`). The server's `DATABASE_URL` pointed at a
 * COPY of `prisma/dev.db`, so the rows this table describes were real rows in a
 * real database that was not the product's. The stored-data half of each row is
 * the read-back at the end of that file, which is un-collapsed; the answer
 * column is the HTTP status the probe recorded.
 *
 *   POST /api/metrics         body "prose"          500 — request.json() throws
 *   POST /api/metrics         body (nothing)        500, same throw
 *   POST /api/metrics         name absent           400 "name, kind required"
 *   POST /api/metrics         name: 42 / []         500 PrismaClientValidationError
 *   POST /api/metrics         name: "   "           201, and `"   "` stored — the
 *                                                   read-back found two metrics whose
 *                                                   name is nothing but spaces
 *   POST /api/metrics         description: 42       500
 *   POST /api/metrics         kind: 42              422 "kind must be count, sum, avg,
 *                                                   unique or funnel" — right answer,
 *                                                   422 rather than 400, and from
 *                                                   `validateMetric` rather than the
 *                                                   boundary, so the list of kinds
 *                                                   lives in that function and nowhere
 *                                                   else (which is why it stays there)
 *   POST /api/metrics         kind: "bogus"         422, same message and same reason
 *   POST /api/metrics         config: 42 / "prose"  422 "count needs an event" — said
 *                                                   to a caller who *did* send an
 *                                                   event-shaped config: `asRecord(42)`
 *                                                   returns `{}`, so the wrong type
 *                                                   became an empty object and the
 *                                                   per-kind check then blamed the kind
 *   POST /api/metrics         status: "BOGUS"       201, and stored
 *   POST /api/metrics         status: "archived"    201, stored lowercase: every
 *                                                   `status: "ACTIVE"` filter now skips
 *                                                   it while the UI still lists it
 *   POST /api/metrics         status: 42            500
 *   POST /api/metrics         status: ""            201, stored ACTIVE — the
 *                                                   `...(status ? { status } : {})`
 *                                                   spread read "" as "not sent"
 *   POST /api/metrics         workspaceId: 42       403
 *   PATCH /api/metrics/:id    body "prose"          500
 *   PATCH /api/metrics/:id    name: 42              500
 *   PATCH /api/metrics/:id    kind: 42              500 — the route validated with
 *                                                   `typeof kind === "string" ? kind :
 *                                                   current.kind` and then wrote
 *                                                   `kind` unconditionally
 *   PATCH /api/metrics/:id    status: "ARCHIVEDX"   200, and stored
 *   PATCH /api/metrics/:id    status: 42            500
 *   PATCH /api/metrics/:id    name: "  "            200, and stored
 *   PATCH /api/metrics/:id    config: []            422 "sum needs an event"
 *   PATCH /api/metrics/:id    {}                    200 — an UPDATE that changed nothing
 *   POST /api/dashboards      body "prose"          500
 *   POST /api/dashboards      name: 42              500
 *   POST /api/dashboards      description: 42       500
 *   POST /api/dashboards      name: "   "           201, and stored
 *   POST /api/dashboards      layout absent / 42    400 "name, layout[] required"
 *   POST /api/dashboards      layout: [{metricId:42}]
 *                                                   422 "each layout card needs a metricId"
 *   POST /api/dashboards      layout names a foreign metric
 *                                                   422 — correct, and a database question
 *   PATCH /api/dashboards/:id name: 42 / description: 42
 *                                                   500
 *   PATCH /api/dashboards/:id name: "  "            200, and stored
 *   PATCH /api/dashboards/:id layout: "x"           422 "layout must be an array"
 *   PATCH /api/dashboards/:id {}                    200
 *   POST /api/alerts          body "prose"          500
 *   POST /api/alerts          metricId: 42          400 "metricId and name must be
 *                                                   strings" — one check for two fields
 *   POST /api/alerts          name: 42              400, same message
 *   POST /api/alerts          operator: "between" / 42 / "GT"
 *                                                   422 — all three already refused
 *   POST /api/alerts          threshold: "10" / null
 *                                                   422 — already refused
 *   POST /api/alerts          webhookUrl: 42 / "ftp://x"
 *                                                   422
 *   POST /api/alerts          isActive: "no"        201, stored **true**
 *   POST /api/alerts          isActive: "false"     201, stored **true**
 *   POST /api/alerts          isActive: []          201, stored **true** — `Boolean(x)`
 *                                                   of all three; a user turning a rule
 *                                                   off gets a rule that fires
 *   POST /api/alerts          metricId foreign      404 "Metric not found in this workspace"
 *   PATCH /api/alerts/:id     name: 42              500
 *   PATCH /api/alerts/:id     isActive: "no"        200, stored **true**
 *   PATCH /api/alerts/:id     operator: null        422
 *   PATCH /api/alerts/:id     {}                    200
 *   POST /api/snapshots       body "prose"          500
 *   POST /api/snapshots       metricId: 42          400 "metricId required" — it is
 *                                                   present, it is a number
 *   POST /api/snapshots       rangeStart absent / 42
 *                                                   422 "rangeStart/rangeEnd must be ISO
 *                                                   dates with end after start"
 *   POST /api/snapshots       rangeEnd: "garbage"   422
 *   POST /api/snapshots       end before start      422
 *   POST /api/snapshots       sync: "no"            201 — computed **inline** and
 *                                                   answered as a finished snapshot,
 *                                                   because the route honoured only
 *                                                   `sync === false`
 *   POST /api/snapshots       sync: "yes"           201, same inline path
 *   POST /api/snapshots       sync: false           202 {"queued":true}
 *   POST /api/snapshots       metricId foreign      422 "Not found." — a 404's message
 *                                                   at a 422's status
 *   POST /api/events          body "prose"          500
 *   POST /api/events          {} / events: "prose" /
 *                             events: [{type: 42}]  422 "no valid events (need type;
 *                                                   occurredAt optional)" — one message
 *                                                   for three different mistakes
 *   POST /api/events          value: "5"            201 `ingested: 1`, stored **null**
 *   POST /api/events          value: NaN            201, stored **null**
 *   POST /api/events          occurredAt: 42        201, stored 2042-01-01 —
 *                                                   `new Date(String(42))` reads "42"
 *                                                   as a year, so the event is in the
 *                                                   future and in no window
 *   POST /api/events          occurredAt: "garbage" 422 — refused, but only because
 *                                                   the whole batch was invalid
 *   POST /api/events          type: "   "           201, stored a three-space type no
 *                                                   metric can ever match
 *   POST /api/events          dimensions: []        201 `ingested: 1`, dimensions dropped
 *   POST /api/events          1002 events           201 `{"ingested":1000,"skipped":0}` —
 *                                                   two events vanished and the answer
 *                                                   said none were skipped
 *   POST /api/ai/explain-metric  body "prose"       500
 *   POST /api/ai/explain-metric  metricId: 42       500 — `findFirst({ where: { id: 42 } })`
 *                                                   dies in Prisma's client, never in SQLite
 *   POST /api/ai/explain-metric  dimension: 42      200 — accepted, then ignored
 *   POST /api/ai/explain-metric  metricId absent    400 "metricId required"
 *
 * Six more rows, from `n5-an-len.mts` — a second pass on the same server and the
 * same copy, because the 99 cases above never tested a length and this file's
 * `TEXT_NAME_MAX` would otherwise be an unmeasured number:
 *
 *   POST /api/metrics         name 5000 chars       201, read back as a 5000-character
 *                                                   name (`5000:count`)
 *   POST /api/metrics         name 201 chars        201 — nothing here was ever near a
 *                                                   limit, so the cap is a decision, not
 *                                                   a column property
 *   PATCH /api/metrics/:id    name 5000 chars       200
 *   POST /api/dashboards      name 5000 chars       201, and stored
 *   POST /api/events          type 5000 chars       201 `ingested: 1`, and stored
 *   POST /api/alerts          name 5000 chars       400 "metricId, name, webhookUrl
 *                                                   required" — the request was missing
 *                                                   webhookUrl, which this route *does*
 *                                                   require, so the length went untested
 *                                                   there rather than passing
 *
 * The alerts gap closed on the after-run, which sent the same 5000-character name
 * with `webhookUrl` present: `400 name is 5000 characters; at most 200`.
 *
 * Twenty-one 500s. The other side is harder to total and worse to read: thirteen
 * cases where a wrong value reached a column and 2xx'd (`"BOGUS"`, `"   "`, a
 * three-space event `type`, an event dated 2042), five where the value the caller
 * sent was silently *not* stored (`status: ""`, `value: "5"`, `value: NaN`,
 * `dimensions: []`, `dimension: 42`), three empty PATCHes answered 200, two
 * `sync` strings answered as though they had said `false`, and one batch that
 * swallowed two of its events while reporting `"skipped":0`.
 *
 * Three rows came out right and are here because a boundary is only worth
 * replacing if you know what it already protected: `NO KEY` 401s on metrics and
 * on explain, a demo key on another workspace's metric/dashboard/rule 404s, and
 * `workspaceId: 42` 403s rather than 404s — which is the right direction, since
 * a workspace id that does not belong to your key is a statement about the key.
 *
 * abetanalytics' shape is not leadworks' (a wrong value stored) or abetflow's
 * (a word reaching a column the schema only describes), though it has both of
 * those too. It is dominated by the third: **the value that is not stored at
 * all.** `isActive: "no"` → `Boolean(...)` → true. `value: "5"` → the finite
 * number check → dropped, and the ingest answers 201. `dimensions: []` → the
 * object check → dropped. `status: ""` → the truthiness spread → the column
 * default. And on the ingestion route in particular a silently dropped field is
 * not a crash, it is a number on a dashboard that quietly stops counting, with
 * a 201 telling the caller everything arrived.
 *
 * So the check belongs at the boundary, against a declared table per route:
 *
 *  - No coercion. `Boolean(isActive)` and `new Date(String(e.occurredAt))` both
 *    *accept* by converting, which is the opposite of checking.
 *  - Nothing dropped in silence. A field the route declares must arrive in the
 *    shape the route reads, or the request is refused naming it.
 *  - An absent key means "not mentioned" and is omitted, so a PATCH cannot reset
 *    a column the caller never named. `null` means "clear it" and only works
 *    where the column is nullable.
 *  - Every problem is reported at once, named by field.
 *  - Text is trimmed. `name: "   "` passes a type check and becomes a row no one
 *    can find by name.
 *  - A field the route did not declare never reaches Prisma.
 *
 * This is `src/lib/validate.ts` in leadworks, leadgenius, abetagent and
 * abetflow — same engine, trimmed to what abetanalytics' tables use, and in
 * three places grown past what they have: `validateArray` (one table per element
 * of a batch, with the index in the field name), `asDate` (narrows what the
 * `date` kind already checked so a route does not re-parse it), and the
 * `objectOnly` flag below. So "the same file as the other apps" is not true of
 * this one, and a port between them is a diff rather than a copy.
 *
 * Dropped
 * rather than carried "for parity": `int` (no caller-facing column here is an
 * `Int`; `AuthThrottle.count` is the engine's own, and `Snapshot` counts live in
 * Json) and `strings` (no column here holds a list of names — `dimensions` is a
 * Json object and the metric engine reads its keys itself). Kept, because this
 * app's schema has the columns leadworks' had: `number` for the two `Float`s
 * (`AlertRule.threshold`, `Event.value`), `bool` for `AlertRule.isActive`, and
 * `date` for the three `DateTime`s a caller can name (`Event.occurredAt`,
 * `Snapshot.rangeStart`, `Snapshot.rangeEnd`).
 *
 * One column keeps its own validator rather than this one: `Metric.config`. Its
 * *shape* is checked here — an object under the byte cap — and its contents by
 * `validateMetric` in `./snapshots.ts`, which owns the per-kind rules (a count
 * needs an event, a funnel needs two steps, the kinds are `METRIC_KINDS`).
 * Repeating those here would give two sources that can disagree about what a
 * valid metric is, and the metrics engine is the one that has to run it.
 */

import { collect, collectBody, describe } from "./validation-engine";
import type { Schema, Validated, ValidationProblem } from "./validation-engine";

export type { FieldKind, Field, JsonObject, JsonArray, Schema, Validated, ValidationProblem } from "./validation-engine";
export { NO_FIELD_TO_UPDATE } from "./validation-engine";


export type Validation<S extends Schema> =
  | { ok: true; data: Validated<S>; error?: undefined }
  | { ok: false; data?: undefined; error: NextResponse };

/**
 * The engine's walk, projected into this app's envelope. Every rule — which kinds
 * exist, what a wrong value is called, what `null` and an absent key mean — is in
 * `./validation-engine`, one file for all six apps. This function is here because
 * what a problem *becomes* on the wire is this app's own decision, and the six
 * have never agreed about it: five answer 400 with `{ error, fields }`, abetapi
 * answers 422 with `{ error: { code, message }, fields }` because that envelope is
 * what its published OpenAPI document promises. Reunited rules, forked answer.
 */
export function validateBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Validation<S> {
  const result = collectBody(body, schema, opts);
  return result.ok ? result : fail(result.problems);
}

/**
 * Parse the body of a request that is required to carry one, and require that it
 * is a JSON *object*. Two failures, both measured as a 500 here on every one of
 * the seven write routes: `request.json()` throws — and a throw inside a handler
 * is Next's 500 — so a client sending `prose` or nothing at all was told the
 * server broke; and a body that parses as a scalar or an array reaches
 * `body.workspaceId` in the handler's very next line, which throws the same way.
 * Naming the shape here is also what lets every handler pass `body.workspaceId`
 * straight to `authedWorkspaceId` before validating anything else, so an
 * anonymous caller never gets a field-level answer to read.
 *
 * A well-shaped body is still checked field by field by `validateBody`, which
 * keeps its own copy of this rule because the unit tests call it directly.
 */
export async function readJson(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown>; error?: undefined } | { ok: false; body?: undefined; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: bad("request body is not valid JSON") };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: bad(`request body must be a JSON object, got ${describe(body)}`) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * A route-control flag that is not a column — here, `sync`, which decides whether
 * the snapshot computes in the request or goes on the queue. `sync === false` was
 * the only thing the route has ever honoured, and every other value was accepted
 * by the client and quietly reinterpreted by the server: measured, `sync: "no"`
 * answered 201 with a finished snapshot, which is the *opposite* of what the word
 * says, because the check was `if (sync === false)`. Refusing a non-boolean costs
 * the caller one round trip; honouring only one spelling of "false" costs them the
 * behaviour they asked for.
 */
export function boolFlag(
  value: unknown,
  name: string,
): { ok: true; value: boolean | undefined; error?: undefined } | { ok: false; value?: undefined; error: NextResponse } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "boolean") {
    return {
      ok: false,
      error: bad(`${name} must be true or false, got ${describe(value)}${typeof value === "string" ? " — send it unquoted" : ""}`),
    };
  }
  return { ok: true, value };
}

/**
 * Validate every element of a caller-supplied array against one table, with the
 * element's position in front of each field name (`events[3].value`,
 * `layout[0].metricId`).
 *
 * This exists because two of this app's bodies are arrays of records rather than
 * records of scalars, and both measured as losing information in the gap:
 * `POST /api/events` reported `{"ingested":1000,"skipped":0}` for a 1002-event
 * batch, and `POST /api/dashboards` answered one message — "each layout card
 * needs a metricId" — for a card that was `null`, an array, or a `metricId` that
 * was a number. Neither told the caller *which* entry, so a 500-event backfill
 * with one bad row is found by hand.
 *
 * `max` is enforced here rather than left to the caller: the events route used to
 * `slice(0, 1000)` and then subtract a different number, which is how the two
 * vanished events were counted as zero skipped. A batch that is too big is
 * refused whole, because a partial ingest the client believes succeeded is worse
 * than a rejected one.
 */
export function validateArray(
  value: unknown,
  schema: Schema,
  name: string,
  opts: { max?: number } = {},
): { ok: true; data: Record<string, unknown>[]; error?: undefined } | { ok: false; data?: undefined; error: NextResponse } {
  if (!Array.isArray(value)) {
    return fail([[name, `${name} must be an array, got ${describe(value)}`]]);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    return fail([[name, `${name} holds ${value.length} entries; at most ${opts.max}`]]);
  }
  const out: Record<string, unknown>[] = [];
  const problems: ValidationProblem[] = [];
  value.forEach((item, i) => {
    const at = `${name}[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      problems.push([at, `${at} must be a JSON object, got ${describe(item)}`]);
      return;
    }
    const filled: Record<string, unknown> = {};
    const found = collect(item as Record<string, unknown>, schema, filled, at);
    if (found.length) {
      problems.push(...found);
      return;
    }
    out.push(filled);
  });
  if (problems.length) return fail(problems);
  return { ok: true, data: out };
}

/**
 * The `date` kind hands back a `Date` at the type level, but a JSON body can
 * only ever hold text, so a route reading a validated range wants one expression
 * for both. `new Date()` on a `Date` is a copy and on a string is the same parse
 * the boundary already accepted, so neither branch can disagree with the 400.
 */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/* ---------- the per-field walk ---------- */

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * One message per field, plus a `fields` object keyed the same way as the body the
 * caller sent. The key is the point: the 21 500s above named an argument only
 * inside a Prisma stack line that never reached the client, and the two places
 * that did answer with a field name ("metricId and name must be strings") named
 * two fields for whichever one was wrong.
 */
function fail(problems: ValidationProblem[]): { ok: false; error: NextResponse } {
  const fields: Record<string, string> = {};
  for (const [name, message] of problems) fields[name] = message;
  return {
    ok: false,
    error: NextResponse.json({ error: problems.map(([, message]) => message).join("; "), fields }, { status: 400 }),
  };
}

/**
 * A refusal about one field that the schema walk cannot express, because it is
 * about where the value *points* rather than whether it is well-formed — the
 * address-shape rule in `egress.ts`. Same envelope and status as `fail`, so a
 * client cannot tell the two apart by shape, only by the message.
 */
export function fieldProblem(name: string, message: string): NextResponse {
  return fail([[name, message]]).error;
}
