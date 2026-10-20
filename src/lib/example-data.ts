import { prisma } from "./db";
import { takeSnapshot } from "./snapshots";

/**
 * Example data: a week of revenue a new workspace can look at.
 *
 * The reason this file exists is a number nobody measured but everybody can
 * feel: a trial that starts on an empty dashboard ends on a cancelled
 * subscription. Sign up, pay attention to "No metrics yet. Create one via
 * `POST /api/metrics`", and the honest answer is that a prospect who cannot
 * code an API integration will never see the product work. The card-up trial
 * then charges them for it.
 *
 * So: one click loads a real week — real events, a real metric, a real frozen
 * snapshot — and the whole product (the number, the breakdown, the share
 * link, the weekly report) works on it. The rules that keep this honest:
 *
 * 1. **It is unmistakably example data.** The metric is named "Example: …",
 *    the event types are `example_*`, and the card says so. Nothing here can
 *    be mistaken for the customer's revenue.
 * 2. **It is removable in one click**, and the removal is surgical: the two
 *    example event types and the two example metrics, by id. A customer's own
 *    events are never touched, and their workspace is empty again afterwards.
 * 3. **It never touches the live metric path.** The events are written through
 *    the same table the API writes, with the same shape, so the number on the
 *    screen is computed by the same engine that computes a customer's number.
 */

/** The example metrics' names. A customer's own metrics never look like this. */
export const EXAMPLE_REVENUE_METRIC = "Example: Weekly Revenue";
export const EXAMPLE_CART_METRIC = "Example: Cart Adds";

/** The event types the example data uses — namespaced so removal is exact. */
export const EXAMPLE_REVENUE_EVENT = "example_purchase";
export const EXAMPLE_CART_EVENT = "example_cart_add";

/** The dimension the example data carries, so the breakdown has something to rank. */
export const EXAMPLE_DIMENSION = "source";

/** One week of D2C revenue: 9 purchases worth 3,820, spread across three channels. */
const PURCHASES: { value: number; source: string; hoursAgo: number }[] = [
  { value: 420, source: "instagram", hoursAgo: 6 },
  { value: 380, source: "google", hoursAgo: 12 },
  { value: 650, source: "instagram", hoursAgo: 18 },
  { value: 300, source: "email", hoursAgo: 24 },
  { value: 510, source: "google", hoursAgo: 30 },
  { value: 280, source: "email", hoursAgo: 36 },
  { value: 460, source: "google", hoursAgo: 42 },
  { value: 240, source: "email", hoursAgo: 48 },
  { value: 580, source: "instagram", hoursAgo: 54 },
];

/** 214 cart adds — the healthy metric that stays quiet next to the revenue one. */
const CART_ADDS = 214;

/**
 * The example week, as plain data.
 *
 * Pure: it takes the current time and returns the events and the two windows
 * they belong to, so the shape of the data is testable without a database and
 * the same input always gives the same week.
 */
export function buildExampleWeek(now: Date) {
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const revenueEvents = PURCHASES.map((p) => ({
    type: EXAMPLE_REVENUE_EVENT,
    value: p.value,
    occurredAt: new Date(now.getTime() - p.hoursAgo * hour),
    dimensions: { [EXAMPLE_DIMENSION]: p.source },
  }));

  const cartEvents = Array.from({ length: CART_ADDS }, (_, i) => ({
    type: EXAMPLE_CART_EVENT,
    occurredAt: new Date(now.getTime() - ((i % 48) * 3 * hour + 60_000)),
  }));

  return {
    revenueEvents,
    cartEvents,
    // This week ends now and reaches back seven days; last week is the seven
    // days before that, so the "what changed?" panel has two real answers.
    thisWeek: { start: new Date(now.getTime() - 7 * day), end: now },
    lastWeek: { start: new Date(now.getTime() - 14 * day), end: new Date(now.getTime() - 7 * day) },
  };
}

/** The example metrics, as the rows that describe them. */
export function exampleMetrics() {
  return [
    {
      name: EXAMPLE_REVENUE_METRIC,
      description: "Example data — nine orders over a week, from three channels.",
      kind: "sum",
      config: { event: EXAMPLE_REVENUE_EVENT, field: "value" },
    },
    {
      name: EXAMPLE_CART_METRIC,
      description: "Example data — 214 cart adds, the healthy metric next to revenue.",
      kind: "count",
      config: { event: EXAMPLE_CART_EVENT },
    },
  ];
}

/** True when a metric is one of the example ones. */
export function isExampleMetric(name: string): boolean {
  return name === EXAMPLE_REVENUE_METRIC || name === EXAMPLE_CART_METRIC;
}

/**
 * Load the example week into a workspace.
 *
 * Idempotent: a second call finds the example metrics already there and
 * changes nothing, so a double-click (or a retried request) cannot double the
 * events. The removal path is the way back to an empty workspace.
 */
export async function loadExampleData(workspaceId: string, now: Date = new Date()) {
  const existing = await prisma.metric.findFirst({
    where: { workspaceId, name: EXAMPLE_REVENUE_METRIC },
    select: { id: true },
  });
  if (existing) {
    return { created: false, metricId: existing.id, headline: null };
  }

  const week = buildExampleWeek(now);

  const revenue = await prisma.metric.create({
    data: {
      workspaceId,
      name: EXAMPLE_REVENUE_METRIC,
      description: "Example data — nine orders over a week, from three channels.",
      kind: "sum",
      config: { event: EXAMPLE_REVENUE_EVENT, field: "value" },
    },
  });
  const cart = await prisma.metric.create({
    data: {
      workspaceId,
      name: EXAMPLE_CART_METRIC,
      description: "Example data — 214 cart adds, the healthy metric next to revenue.",
      kind: "count",
      config: { event: EXAMPLE_CART_EVENT },
    },
  });

  await prisma.event.createMany({
    data: [
      ...week.revenueEvents.map((e) => ({
        workspaceId,
        type: e.type,
        value: e.value,
        occurredAt: e.occurredAt,
        dimensions: e.dimensions,
      })),
      ...week.cartEvents.map((e) => ({
        workspaceId,
        type: e.type,
        occurredAt: e.occurredAt,
      })),
    ],
  });

  // Snapshots of the revenue metric — this week and last — so the "what
  // changed?" panel has two frozen answers to compare, and one of the cart
  // metric so every example row shows a number.
  //
  // The order matters: the dashboard shows a metric's *latest* snapshot, and
  // "latest" means the most recently frozen one. Last week is frozen first so
  // that this week is the newest — the other order leaves the dashboard
  // showing an empty week, which is the one number this feature must never
  // show.
  await takeSnapshot(revenue.id, week.lastWeek.start, week.lastWeek.end);
  const thisWeek = await takeSnapshot(revenue.id, week.thisWeek.start, week.thisWeek.end);
  await takeSnapshot(cart.id, week.thisWeek.start, week.thisWeek.end);

  return {
    created: true,
    metricId: revenue.id,
    headline: thisWeek.headline,
    events: week.revenueEvents.length + week.cartEvents.length,
  };
}

/**
 * Remove the example data, and only the example data.
 *
 * The events go by their namespaced types and the metrics by their ids, so a
 * customer's own events and metrics are untouched. Deleting the metrics
 * cascades to their snapshots.
 */
export async function removeExampleData(workspaceId: string) {
  const metrics = await prisma.metric.findMany({
    where: { workspaceId, name: { in: [EXAMPLE_REVENUE_METRIC, EXAMPLE_CART_METRIC] } },
    select: { id: true },
  });

  const events = await prisma.event.deleteMany({
    where: { workspaceId, type: { in: [EXAMPLE_REVENUE_EVENT, EXAMPLE_CART_EVENT] } },
  });
  const deleted = await prisma.metric.deleteMany({
    where: { id: { in: metrics.map((m) => m.id) } },
  });

  return { events: events.count, metrics: deleted.count };
}
