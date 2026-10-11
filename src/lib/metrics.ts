export interface MetricEvent {
  type: string;
  occurredAt: Date;
  dimensions: Record<string, unknown>;
  value: number | null;
}

export type MetricKind = "count" | "sum" | "avg" | "unique" | "funnel";

export interface MetricConfig {
  event?: string;
  /** Dot path into the event: "value" or "dimensions.plan". */
  field?: string;
  /** Dimension equality filters; an array value means any-of. */
  filters?: Record<string, unknown>;
  /** Dimension key identifying one subject across funnel steps. */
  identityField?: string;
  steps?: { event: string; filters?: Record<string, unknown> }[];
}

export type MetricResult =
  | { kind: "count"; value: number; events: number }
  | { kind: "sum"; value: number; events: number }
  | { kind: "avg"; value: number | null; events: number }
  | { kind: "unique"; value: number; events: number; field: string }
  | { kind: "funnel"; steps: { event: string; count: number; rateFromFirst: number; rateFromPrev: number }[]; subjects: number };

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === "object" && key in obj) {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

function eventView(e: MetricEvent): Record<string, unknown> {
  return { type: e.type, value: e.value, ...(e.dimensions ?? {}) };
}

function matchesFilters(e: MetricEvent, filters?: Record<string, unknown>): boolean {
  if (!filters) return true;
  const view = eventView(e);
  for (const [key, wanted] of Object.entries(filters)) {
    const actual = getPath(view, key);
    if (Array.isArray(wanted)) {
      if (!wanted.some((w) => w === actual)) return false;
    } else if (actual !== wanted) {
      return false;
    }
  }
  return true;
}

function inRange(e: MetricEvent, start: Date, end: Date): boolean {
  const t = e.occurredAt.getTime();
  return t >= start.getTime() && t < end.getTime();
}

function numericField(e: MetricEvent, field: string): number | null {
  const v = getPath({ value: e.value, ...e.dimensions }, field);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Compute a metric over in-memory events. Pure: no database, no clock, no
 * network — which is why the same numbers come out of unit tests, the API
 * and the scheduled snapshots.
 */
export function computeMetric(
  kind: MetricKind,
  config: MetricConfig,
  events: MetricEvent[],
  range: { start: Date; end: Date },
): MetricResult {
  if (kind === "funnel") return computeFunnel(config, events, range);

  if (!config.event) throw new Error(`${kind} needs an event`);
  const rows = events.filter((e) => e.type === config.event && inRange(e, range.start, range.end) && matchesFilters(e, config.filters));

  switch (kind) {
    case "count":
      return { kind, value: rows.length, events: rows.length };
    case "sum": {
      const field = config.field ?? "value";
      const value = rows.reduce((sum, e) => sum + (numericField(e, field) ?? 0), 0);
      return { kind, value, events: rows.length };
    }
    case "avg": {
      const field = config.field ?? "value";
      const nums = rows.map((e) => numericField(e, field)).filter((n): n is number => n !== null);
      return { kind, value: nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null, events: rows.length };
    }
    case "unique": {
      const field = config.field ?? "value";
      const seen = new Set<string>();
      for (const e of rows) {
        const v = getPath({ value: e.value, ...e.dimensions }, field);
        if (v !== null && v !== undefined) seen.add(JSON.stringify(v));
      }
      return { kind, value: seen.size, events: rows.length, field };
    }
  }
}

function computeFunnel(config: MetricConfig, events: MetricEvent[], range: { start: Date; end: Date }): MetricResult {
  const steps = config.steps ?? [];
  if (steps.length === 0) throw new Error("funnel needs at least one step");
  if (!config.identityField) throw new Error("funnel needs an identityField");

  const byIdentity = new Map<string, MetricEvent[]>();
  for (const e of events) {
    if (!inRange(e, range.start, range.end)) continue;
    const id = getPath(e.dimensions, config.identityField);
    if (id === null || id === undefined) continue;
    const key = JSON.stringify(id);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key)!.push(e);
  }
  for (const list of byIdentity.values()) list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  // Ordered walk: each step must occur after the previous match.
  const reached = new Array(steps.length).fill(0);
  for (const list of byIdentity.values()) {
    let cursor = 0;
    for (const e of list) {
      if (cursor >= steps.length) break;
      const step = steps[cursor];
      if (e.type === step.event && matchesFilters(e, step.filters)) cursor++;
    }
    for (let i = 0; i < cursor; i++) reached[i]++;
  }

  const first = reached[0] || 0;
  return {
    kind: "funnel",
    subjects: byIdentity.size,
    steps: steps.map((s, i) => ({
      event: s.event,
      count: reached[i],
      rateFromFirst: first > 0 ? reached[i] / first : 0,
      rateFromPrev: i === 0 ? 1 : reached[i - 1] > 0 ? reached[i] / reached[i - 1] : 0,
    })),
  };
}

/** The single number an alert rule compares. Null means "no data, stay quiet". */
export function metricHeadline(result: MetricResult): number | null {
  switch (result.kind) {
    case "count":
    case "sum":
    case "unique":
      return result.value;
    case "avg":
      return result.value;
    case "funnel": {
      const last = result.steps[result.steps.length - 1];
      return last ? last.rateFromFirst : null;
    }
  }
}
