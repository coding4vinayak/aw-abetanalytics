import { prisma } from "./db";
import { METRIC_KINDS } from "./enums";
import { asInputJson, asRecord } from "./json";
import { computeMetric, metricHeadline, type MetricConfig, type MetricEvent, type MetricKind } from "./metrics";
import { evaluateAlertRules } from "./alerts";

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
    orderBy: { occurredAt: "asc" },
    take: 50000,
  });
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
 */
export async function takeSnapshot(metricId: string, rangeStart: Date, rangeEnd: Date) {
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
  const alertsFired = await evaluateAlertRules(metric.workspaceId, metric.id, snapshot.id, headline);

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

  const all = [...currentEvents, ...previousEvents];

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

  const segments = new Set<string>();
  for (const e of all) {
    const v = scalarValue(e, dimension as string);
    if (v !== null) segments.add(v);
  }

  const inSegment = (events: MetricEvent[], segment: string) =>
    events.filter((e) => scalarValue(e, dimension as string) === segment);

  const headlineFor = (events: MetricEvent[], range: { start: Date; end: Date }): number => {
    if (events.length === 0) return 0;
    return metricHeadline(computeMetric(input.kind, input.config, events, range)) ?? 0;
  };

  return [...segments]
    .map((segment) => ({
      dimension: dimension as string,
      segment,
      current: headlineFor(inSegment(currentEvents, segment), input.current),
      previous: headlineFor(inSegment(previousEvents, segment), input.previous),
    }))
    // Ranked by how much each segment moved, biggest mover first.
    .sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous))
    .slice(0, 20);
}
