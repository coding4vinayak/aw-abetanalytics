import { ALERT_OPERATORS, METRIC_KINDS, METRIC_STATUSES, TEXT_NAME_MAX } from "./enums";
import type { Schema } from "./validate";

/**
 * One table per write route, and the only place a caller's word is decided.
 *
 * Each comment's "Before:" lines are measurements, not reasoning: they are rows
 * of `n5-an-before.txt` (99 cases over HTTP against a dev server whose
 * `DATABASE_URL` was a copy of `prisma/dev.db`) and of `n5-an-len.mts` (6 more,
 * for length), with the stored half of each row coming from the read-back at the
 * end of the first file. Where a line describes what a column does rather than
 * what a request did, it cites `prisma/schema.prisma`.
 */

/**
 * POST /api/metrics
 *
 * Before:
 *   name: 42 / []        500 PrismaClientValidationError
 *   name: "   "          201, and `"   "` stored — the read-back found two
 *                        metrics whose entire name is spaces
 *   name 5000 chars      201, stored 5000 characters
 *   description: 42      500
 *   kind: 42             422 "kind must be count, sum, avg, unique or funnel",
 *                        from validateMetric rather than the boundary
 *   config: 42           422 "count needs an event" — said to a caller who had
 *                        sent a config: `asRecord(42)` is `{}`
 *   status: "BOGUS"      201, stored
 *   status: "archived"   201, stored lowercase, and every reader filters
 *                        `status: "ACTIVE"`, so it disappeared from the
 *                        dashboard while still resolving by id
 *   status: 42           500
 *   status: ""           201, stored ACTIVE — `...(status ? { status } : {})`
 *                        read "" as "not sent"
 *
 * `config` is declared `json` and nothing more: `validateMetric` owns what a
 * count or a funnel needs, and it is the code that has to run the result, so a
 * second opinion here would only be a second thing to keep in sync.
 */
export const METRIC_CREATE = {
  name: { kind: "text", required: true, max: TEXT_NAME_MAX },
  description: { kind: "text", nullable: true, max: 2000 },
  kind: { kind: "enum", values: METRIC_KINDS, required: true },
  config: { kind: "json" },
  status: { kind: "enum", values: METRIC_STATUSES },
} as const satisfies Schema;

/**
 * PATCH /api/metrics/[id]
 *
 * Before:
 *   name: 42             500
 *   name: "  "           200, and stored
 *   kind: 42             500 — the route validated `typeof kind === "string" ?
 *                        kind : current.kind` and then wrote `kind`
 *                        unconditionally, so the check and the write disagreed
 *   status: "ARCHIVEDX"  200, stored
 *   status: 42           500
 *   {}                   200 — an UPDATE whose data held nothing
 *
 * `status` is nullable-free on purpose: `Metric.status` is NOT NULL with a
 * default, so there is no state "no status" to move a row to.
 */
export const METRIC_UPDATE = {
  name: { kind: "text", max: TEXT_NAME_MAX },
  description: { kind: "text", nullable: true, max: 2000 },
  kind: { kind: "enum", values: METRIC_KINDS },
  config: { kind: "json" },
  status: { kind: "enum", values: METRIC_STATUSES },
} as const satisfies Schema;

/**
 * POST /api/dashboards
 *
 * Before:
 *   name: 42             500
 *   name: "   "          201, stored
 *   name 5000 chars      201, stored
 *   description: 42      500
 *   layout absent / 42   400 "name, layout[] required" — one message, two fields
 *   layout: "x"          422
 *
 * `layout` is `json` here and validated further by the route, which is the only
 * place that can ask the database whether each card names a metric of this
 * workspace. Measured, that check already worked (`layout names a foreign
 * metric` → 422) and is left exactly where it is.
 */
export const DASHBOARD_CREATE = {
  name: { kind: "text", required: true, max: TEXT_NAME_MAX },
  description: { kind: "text", nullable: true, max: 2000 },
  layout: { kind: "json", required: true },
} as const satisfies Schema;

/**
 * PATCH /api/dashboards/[id]
 *
 * Before:
 *   name: 42             500
 *   name: "  "           200, stored
 *   description: 42      500
 *   {}                   200
 */
export const DASHBOARD_UPDATE = {
  name: { kind: "text", max: TEXT_NAME_MAX },
  description: { kind: "text", nullable: true, max: 2000 },
  layout: { kind: "json" },
} as const satisfies Schema;

/**
 * POST /api/alerts
 *
 * Before:
 *   metricId: 42         400 "metricId and name must be strings" — one check
 *                        naming both fields for whichever was wrong
 *   name: 42             400, the same message
 *   name 5000 chars      untested: the probe request was refused earlier for a
 *                        missing `webhookUrl`, which this route requires
 *   operator: "GT"       422 (already refused, correctly)
 *   threshold: "10"      422 (already refused, correctly)
 *   isActive: "no"       201, stored **true**
 *   isActive: "false"    201, stored **true**
 *   isActive: []         201, stored **true** — all three through
 *                        `Boolean(isActive)`; the read-back shows `isActive:
 *                        true` for the rule the caller was trying to turn off
 *
 * `webhookUrl` is `required` because the route required it before this table
 * existed — measured as a 400 naming three fields at once when it was absent.
 * What it is *checked* for stays in the route: `new URL(...)` plus an http(s)
 * protocol test, which answered 422 for `42` and for `ftp://x`. A declared
 * `format: "url"` would move that decision here, but it would also still accept
 * `http://169.254.169.254/latest/meta-data/`, and the syntax was never the
 * problem with this field: the rules engine POSTs to it server-side, so any
 * http(s) URL a caller can name is a request this server will make from inside
 * whatever network it runs on. That is a larger question than a type table and
 * is recorded as such in the ledger rather than half-fixed here.
 */
export const ALERT_CREATE = {
  metricId: { kind: "text", required: true, max: 64 },
  name: { kind: "text", required: true, max: TEXT_NAME_MAX },
  operator: { kind: "enum", values: ALERT_OPERATORS, required: true },
  threshold: { kind: "number", required: true },
  webhookUrl: { kind: "text", required: true, max: 2000 },
  isActive: { kind: "bool" },
} as const satisfies Schema;

/**
 * PATCH /api/alerts/[id]
 *
 * Before:
 *   name: 42             500
 *   isActive: "no"       200, stored **true**
 *   operator: null       422 — `OPERATORS.includes(null)` is false, so a null
 *                        arrived as an illegal word rather than as a clear
 *   threshold: "10"      422
 *   {}                   200
 *
 * `AlertRule.lastFiredAt` is the engine's own column and no caller names it, so
 * it is not in this table: a field that is not declared never reaches Prisma.
 */
export const ALERT_UPDATE = {
  name: { kind: "text", max: TEXT_NAME_MAX },
  operator: { kind: "enum", values: ALERT_OPERATORS },
  threshold: { kind: "number" },
  webhookUrl: { kind: "text", max: 2000 },
  isActive: { kind: "bool" },
  // Not a column: `secret` is engine-generated and never caller-named. This
  // asks the route to mint a new one, and the PATCH response is the one place
  // the new secret appears.
  rotateSecret: { kind: "bool" },
} as const satisfies Schema;

/**
 * One entry of a dashboard's `layout`. Measured, `layout: [{metricId: 42}]` and
 * `layout: ["x"]` both answered 422 "each layout card needs a metricId", and
 * neither answer said which of the cards was the problem — for a board with a
 * dozen cards that is a search by hand.
 *
 * Whether the named metric exists in this workspace is the route's question, not
 * this table's, and it already answered correctly (`layout names a foreign
 * metric` → 422). That check stays where it is.
 */
export const LAYOUT_CARD = {
  metricId: { kind: "text", required: true, max: 64 },
} as const satisfies Schema;

/** How many cards one board may hold. Generous; the UI renders far fewer. */
export const LAYOUT_MAX = 100;

/**
 * POST /api/snapshots
 *
 * Before:
 *   metricId: 42         400 "metricId required" — present, and a number
 *   rangeStart absent    422 "rangeStart/rangeEnd must be ISO dates with end
 *                        after start" — correct, and the reason `min`/`max` on
 *                        the date kind is left to the route: only the route
 *                        knows that `end` must be after `start`
 *   rangeStart: 42       422
 *   rangeEnd: "garbage"  422
 *   end before start     422
 *   sync: "no"           201, computed **inline** and answered as a finished
 *                        snapshot — the route honours only `sync === false`, so
 *                        the one spelling of "no" it accepts means "yes"
 *   sync: "yes"          201, the same inline path
 *   sync: false          202 {"queued":true} — the only spelling with a choice
 *   metricId: foreign    422 "Not found." — `assertOwns` threw a 404 and the
 *                        handler's `catch` re-mapped the message to 422
 *
 * `sync` is not in this table: it is not a column, it is a route-control flag,
 * and it is read with `boolFlag` after the table, so that a caller who sends
 * `"no"` gets the answer `boolFlag` writes rather than a field error listing a
 * field they did send correctly.
 */
export const SNAPSHOT_CREATE = {
  metricId: { kind: "text", required: true, max: 64 },
  rangeStart: { kind: "date", required: true },
  rangeEnd: { kind: "date", required: true },
} as const satisfies Schema;

/**
 * One event, applied per element of the batch with the index in front of the
 * field name (`events[3].value`), so the caller can find the row.
 *
 * Before (each of these was a 201 `{"ingested":1,"skipped":0}`):
 *   value: "5"           stored **null** — `typeof e.value === "number"` failed
 *                        and the field was simply not included
 *   value: NaN           stored **null**, same route through
 *   occurredAt: 42       stored 2042-01-01T00:00:00.000Z — `new
 *                        Date(String(42))` reads "42" as a year, so the event is
 *                        in the future and in no window anyone queries
 *   occurredAt: "nope"   422 for the whole batch, because one bad event made
 *                        `rows.length === 0` the only reported state
 *   type: "   "          stored a three-space type, which no metric's
 *                        `config.event` can ever equal
 *   type 5000 chars      201, stored 5000 characters
 *   dimensions: []       dropped, stored null — `parseEvent` had
 *                        `typeof e.dimensions === "object" && !Array.isArray(…)`
 *                        and the key simply was not included
 *
 * `dimensions` is `objectOnly` because that is the shape every reader assumes:
 * `metrics.ts:38` spreads it into an object and `json.ts:16` `asRecord` answers an
 * array with `{}`. Without the flag this round's engine made it *worse* than the
 * route it replaced — measured on the first after-run, `dimensions: []` was a 201
 * that stored `[]`, so the value survived to the column and was dropped at every
 * read instead of at the write. `[1, 2]` would have become keys `"0"` and `"1"` in
 * each breakdown. Now both are a 400 that names the position.
 *
 * `value` is nullable-free: `Event.value` is `Float?` and "no measurement" is a
 * real state this column already holds, so the difference between `null` and
 * "absent" is not worth a caller's confusion. Both leave it null.
 */
export const EVENT_ITEM = {
  type: { kind: "text", required: true, max: 200 },
  occurredAt: { kind: "date" },
  value: { kind: "number" },
  dimensions: { kind: "json", objectOnly: true },
} as const satisfies Schema;

/** How many events one POST may carry. Measured: 1002 became 1000 + `skipped: 0`. */
export const EVENT_BATCH_MAX = 1000;

/**
 * POST /api/ai/explain-metric
 *
 * Before:
 *   metricId: 42         500 — `prisma.metric.findFirst({ where: { id: 42 } })`
 *                        throws in Prisma's client, so the type error never
 *                        reached SQLite at all
 *   metricId: "nope"     404 (correct: another tenant's metric is not found)
 *   dimension: 42        200, accepted and then ignored
 *
 * `model` is a model name handed to the LLM client; it was `body.model` with no
 * check of any kind. Declaring it as text bounds what a caller can push into a
 * request to an upstream service.
 */
export const EXPLAIN_METRIC = {
  metricId: { kind: "text", required: true, max: 64 },
  dimension: { kind: "text", max: 200 },
  model: { kind: "text", max: 200 },
} as const satisfies Schema;

/**
 * POST /api/metrics/[id]/breakdown
 *
 * Before: route did not exist.
 */
export const BREAKDOWN = {
  metricId: { kind: "text", required: true, max: 64 },
  currentStart: { kind: "date", required: true },
  currentEnd: { kind: "date", required: true },
  previousStart: { kind: "date", required: true },
  previousEnd: { kind: "date", required: true },
  dimension: { kind: "text", max: 200 },
} as const satisfies Schema;

/**
 * POST /api/webhooks, PATCH /api/webhooks/{id}
 *
 * `events` is deliberately absent from both tables — the column is a comma
 * string and the accepted spellings are "array or comma string", a distinction
 * a scalar table cannot see; the route checks every name against the closed set
 * in `lib/webhooks.ts` and refuses the typo before it is stored. `isActive` is
 * the boolean column a subscription can be silenced with.
 */
export const WEBHOOK_CREATE = {
  url: { kind: "text", required: true, format: "url", max: 2000 },
} satisfies Schema;

export const WEBHOOK_PATCH = {
  url: { kind: "text", format: "url", max: 2000 },
  isActive: { kind: "bool" },
} satisfies Schema;

/**
 * POST /api/reports
 *
 * A weekly report is a metric, an address, and a slot in the week. The slot is
 * three small fields rather than one cron string: `dayOfWeek` and `hour` are
 * read in `timezone`, because a schedule that names an hour without naming a
 * zone is the same bug as a link that points at whatever host the request
 * arrived on.
 *
 * `timezone` is deliberately not an enum. IANA zone names are a long, changing
 * list, and a hard-coded copy of it would refuse zones that exist and accept
 * ones that do not; it is checked against the runtime's own zone database
 * instead (see `isValidTimeZone` in `lib/report-schedule.ts`).
 *
 * `windowDays` is bounded because it is the width of the window the report
 * reads: a year of events is not a weekly report, and the metric engine
 * refuses windows that hold more than 50,000 events anyway.
 */
export const REPORT_CREATE = {
  metricId: { kind: "text", required: true, max: TEXT_NAME_MAX },
  email: { kind: "text", required: true, format: "email", max: 320 },
  dayOfWeek: { kind: "int", min: 0, max: 6 },
  hour: { kind: "int", min: 0, max: 23 },
  timezone: { kind: "text", max: 64 },
  windowDays: { kind: "int", min: 1, max: 90 },
} as const satisfies Schema;
