import { prisma } from "./db";
import { METRIC_KINDS } from "./enums";
import { asInputJson, asRecord } from "./json";
import { computeMetric, metricHeadline, matchesMetric, type MetricConfig, type MetricEvent, type MetricKind } from "./metrics";
import { evaluateAlertRules } from "./alerts";
import { triggerWebhooks } from "./webhooks";
import { MAX_METRIC_EVENTS, assertWindowComplete } from "./event-window";

export function readMetricConfig(raw: unknown): MetricConfig {
  return asRecord(raw) as unknown as MetricConfig;
}

export async function loadEvents(
  workspaceId: string,
  start: Date,
  end: Date,
): Promise<MetricEvent[]> {
  const rows = await prisma.event.findMany({
    where: { workspaceId, occurredAt: { gte: start, lt: end } },
    // One past the bound: the extra row is what distinguishes "exactly at the
    // cap" from "there were more", and the latter must not be answered.
    orderBy: { occurredAt: "asc" },
    take: MAX_METRIC_EVENTS + 1,
  });
  assertWindowComplete(rows.length);
  return rows.map((r) => ({
    type: r.type,
    occurredAt: r.occurredAt,
    dimensions: asRecord(r.dimensions),
    value: r.value,
  }));
}

export function validateMetric(kind: string, config: MetricConfig): string | null {
  if (!METRIC_KINDS.includes(kind as (typeof METRIC_KINDS)[number])) {
    return `kind must be ${METRIC_KINDS.slice(0, -1).join(", ")} or ${METRIC_KINDS[METRIC_KINDS.length - 1]}`;
  }
  if (kind === "funnel") {
    if (!Array.isArray(config.steps) || config.steps.length === 0) return "funnel needs steps[]";
    if (!config.identityField) return "funnel needs identityField";
    return null;
  }
  if (!config.event) return `${kind} needs an event`;
  return null;
}

/**
 * Compute a metric now (preview, no persistence) or freeze it as a snapshot.
 * Snapshots store the definition as-run: renaming the metric or changing its
 * config next week cannot rewrite what the board agreed this week.
 *
 * `fireAlerts: false` freezes the number without evaluating the alert rules.
 * The weekly report uses it, and the reason is a duplicate page: the report
 * re-freezes a window the customer may already have snapshotted, and
 * re-evaluating the same rules against the same number would page them a
 * second time for a number they have already been told about.
 */
export async function takeSnapshot(
  metricId: string,
  rangeStart: Date,
  rangeEnd: Date,
  options: { fireAlerts?: boolean } = {},
) {
  const metric = await prisma.metric.findUnique({ where: { id: metricId } });
  if (!metric) throw new Error("Metric not found");
  if (metric.status !== "ACTIVE") throw new Error(`Metric is ${metric.status}`);

  const config = readMetricConfig(metric.config);
  const events = await loadEvents(metric.workspaceId, rangeStart, rangeEnd);
  const result = computeMetric(metric.kind as MetricKind, config, events, { start: rangeStart, end: rangeEnd });

  const definition = {
    metricId: metric.id,
    name: metric.name,
    kind: metric.kind,
    config,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
  };

  const snapshot = await prisma.snapshot.create({
    data: {
      workspaceId: metric.workspaceId,
      metricId: metric.id,
      rangeStart,
      rangeEnd,
      definition: asInputJson(definition),
      result: asInputJson(result),
    },
  });

  const headline = metricHeadline(result);

  // The event a subscriber wires to for "a board number exists now": the row
  // above is committed with the definition as-run, and the headline is what
  // the dashboard shows. Emitted before alert evaluation so a receiver sees
  // the snapshot and then whatever fired on it, in that order.
  await triggerWebhooks(metric.workspaceId, "snapshot.created", {
    snapshot: {
      id: snapshot.id,
      metricId: metric.id,
      name: metric.name,
      kind: metric.kind,
      rangeStart: definition.rangeStart,
      rangeEnd: definition.rangeEnd,
    },
    headline,
  });

  const alertsFired = options.fireAlerts === false
    ? []
    : await evaluateAlertRules(metric.workspaceId, metric.id, snapshot.id, headline);

  return { snapshot, result, headline, alertsFired };
}

/**
 * Split a metric's movement across the values of one dimension.
 *
 * This lives next to `takeSnapshot` on purpose: the per-segment numbers are
 * produced by running `computeMetric` itself on the filtered events, not by a
 * second, hand-rolled counting rule. If the metric is a funnel, a segment's
 * "count" is that funnel's headline; if it is an average, it is that average.
 * Any other implementation would eventually disagree with the snapshot, and a
 * breakdown that disagrees with the headline is worse than no breakdown.
 *
 * Dimensions live in a JSON column, so this cannot be done in SQL — the
 * grouping is in JS over the same bounded event set the snapshot used.
 */
export async function breakdownByDimension(input: {
  workspaceId: string;
  kind: MetricKind;
  config: MetricConfig;
  current: { start: Date; end: Date };
  previous: { start: Date; end: Date };
  /** Explicit dimension key, e.g. "plan". Defaults to the most common one. */
  dimension?: string;
}): Promise<{ dimension: string; segment: string; current: number; previous: number }[]> {
  const [currentEvents, previousEvents] = await Promise.all([
    loadEvents(input.workspaceId, input.current.start, input.current.end),
    loadEvents(input.workspaceId, input.previous.start, input.previous.end),
  ]);
  return segmentBreakdown({
    kind: input.kind,
    config: input.config,
    currentEvents,
    previousEvents,
    currentRange: input.current,
    previousRange: input.previous,
    dimension: input.dimension,
  });
}

/**
 * The grouping rules, separated from the read so they can be tested without a
 * database: which dimension is chosen when none is named, how missing values
 * are counted, and how the result is ranked and capped.
 */
export const UNSET_SEGMENT = "(not set)";

export function segmentBreakdown(input: {
  kind: MetricKind;
  config: MetricConfig;
  currentEvents: MetricEvent[];
  previousEvents: MetricEvent[];
  currentRange: { start: Date; end: Date };
  previousRange: { start: Date; end: Date };
  dimension?: string;
}): { dimension: string; segment: string; current: number; previous: number }[] {
  // Only events the metric actually reads can own a segment. The window also
  // holds the workspace's other event types, and a segment set built from
  // those would show a "(not set)" row that is always zero.
  const currentRelevant = input.currentEvents.filter((e) => matchesMetric(input.kind, input.config, e));
  const previousRelevant = input.previousEvents.filter((e) => matchesMetric(input.kind, input.config, e));
  const all = [...currentRelevant, ...previousRelevant];

  // A dimension is only usable if it is a plain scalar value on the event view;
  // objects and arrays would make the segment labels meaningless.
  const scalarValue = (e: MetricEvent, key: string): string | null => {
    const view: Record<string, unknown> = {
      type: e.type,
      value: e.value,
      ...(e.dimensions ?? {}),
    };
    const v = view[key];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "boolean") return String(v);
    return null;
  };

  let dimension = input.dimension;
  if (!dimension) {
    const counts = new Map<string, number>();
    for (const e of all) {
      for (const key of Object.keys(e.dimensions ?? {})) {
        if (scalarValue(e, key) !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // Highest coverage wins; ties broken alphabetically for determinism.
    dimension = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  }
  if (!dimension) return [];

  // Events that do not carry the dimension still belong to the number the
  // breakdown is explaining. Dropping them would make the segments sum to
  // less than the headline with nothing saying so; they share "(not set)".
  // A literal value with that text lands in the same bucket by construction.
  const bucketOf = (e: MetricEvent): string => scalarValue(e, dimension as string) ?? UNSET_SEGMENT;
  const segments = new Set<string>(all.map(bucketOf));

  const inSegment = (events: MetricEvent[], segment: string) =>
    events.filter((e) => bucketOf(e) === segment);

  const headlineFor = (events: MetricEvent[], range: { start: Date; end: Date }): number => {
    if (events.length === 0) return 0;
    return metricHeadline(computeMetric(input.kind, input.config, events, range)) ?? 0;
  };

  return [...segments]
    .map((segment) => ({
      dimension: dimension as string,
      segment,
      current: headlineFor(inSegment(currentRelevant, segment), input.currentRange),
      previous: headlineFor(inSegment(previousRelevant, segment), input.previousRange),
    }))
    // Ranked by how much each segment moved, biggest mover first.
    .sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous))
    .slice(0, 20);
}
