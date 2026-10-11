import type { AlertOperator } from "./alerts";
import type { MetricKind } from "./metrics";

/**
 * The words a `String` column may hold.
 *
 * SQLite has no enum type, so each of these lists is the only thing standing
 * between a caller's typo and a stored row — `Metric.status` is `String
 * @default("ACTIVE")` with `// ACTIVE | ARCHIVED` living in a comment the
 * database never reads, and measured, `status: "BOGUS"` was a clean 201 insert.
 * The comment and the array are now the same thing in one place: the routes
 * validate against these, and `validateMetric` asks `METRIC_KINDS` instead of
 * carrying its own copy — which is the difference between one list deciding what
 * a metric kind is and two that can drift apart.
 */

/**
 * Metric.kind. The `satisfies` is the guard: each word here must be a member of
 * the `MetricKind` union ./metrics exports, which is the type the engine that
 * computes the metric is written against. A fifth kind named only at this
 * boundary stops compiling instead of storing a word `computeMetric` ignores.
 */
export const METRIC_KINDS = ["count", "sum", "avg", "unique", "funnel"] as const satisfies readonly MetricKind[];

/**
 * Metric.status. Case matters and is enforced here rather than in the route:
 * measured, `status: "archived"` stored lowercase, and every read in the app
 * filters `status: "ACTIVE"`, so the metric vanished from the dashboard while
 * still being listed by id — the worst of both.
 */
export const METRIC_STATUSES = ["ACTIVE", "ARCHIVED"] as const;

/**
 * AlertRule.operator. Was declared twice, as two identical `as const` arrays in
 * `api/alerts/route.ts` and `api/alerts/[id]/route.ts`, while `checkThreshold`
 * in ./alerts.ts is the code that actually reads the column. One list now; it is
 * pinned to the `AlertOperator` union that same file exports, so adding a word
 * here without teaching the switch to act on it stops being a silent mistake —
 * `checkThreshold`'s `default` returns false, which is a rule that never fires
 * and never says so.
 */
export const ALERT_OPERATORS = ["gt", "gte", "lt", "lte"] as const satisfies readonly AlertOperator[];

/**
 * How long a name can be before it stops being a name. The columns are plain
 * `String` with no length limit, and measured on the probe copy —
 * `n5-an-len.mts` — a 5000-character metric name was a 201 whose read-back came
 * back as `5000:count`, as was a 5000-character dashboard name and an event
 * `type` of the same length, and PATCHing one to 5000 characters was a 200.
 * 200 is the cap the three rounds before this one declared for a name
 * (`abetflow/src/lib/fields.ts:47`, `abetagent/src/lib/fields.ts:38`, and the
 * `max: 200` free-text columns in leadworks and leadgenius), and past it this
 * app's cards stop being readable rather than being refused.
 */
export const TEXT_NAME_MAX = 200;
