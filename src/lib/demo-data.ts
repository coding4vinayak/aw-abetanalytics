/**
 * The demo dataset — the rows behind the public demo workspace.
 *
 * It lives here, in one place, because two surfaces depend on it: the seed
 * that writes the rows, and the landing page that *counts* them. The page used
 * to say "the demo workspace has 102 events waiting" as a literal, which was
 * true on the day it was written and would have quietly become a lie the next
 * time the dataset changed. Deriving the number from the dataset that produces
 * it means the promise and the product cannot drift apart.
 *
 * Pure: no database, no clock, no side effects. The March window is part of
 * the dataset's identity — re-seeding must not double the funnel's counts — so
 * the range is exported with it.
 */

export interface DemoEvent {
  type: string;
  occurredAt: Date;
  dimensions: Record<string, unknown>;
  value: number | null;
}

/** The demo window. The seed's identity, and the range its snapshot covers. */
export const DEMO_RANGE = {
  start: "2026-03-01T00:00:00Z",
  end: "2026-04-01T00:00:00Z",
};

/**
 * Thirty days of funnel traffic: 60 visits, 30 signups, 12 payments.
 *
 * The event types are the ones the demo metrics read — `visit`, `signup`,
 * `payment` — and the `user` dimension is what the funnel's identity field
 * groups by, so a signup belongs to the visit that produced it.
 */
export function buildDemoEvents(): DemoEvent[] {
  const events: DemoEvent[] = [];
  for (let i = 0; i < 60; i++) {
    const day = 1 + (i % 28);
    const user = `user-${i}`;
    const at = (hour: string) => new Date(`2026-03-${String(day).padStart(2, "0")}T${hour}:00:00Z`);
    events.push({
      type: "visit",
      occurredAt: at("10"),
      dimensions: { user, channel: i % 2 === 0 ? "organic" : "paid" },
      value: null,
    });
    if (i % 2 === 0) {
      events.push({
        type: "signup",
        occurredAt: at("11"),
        dimensions: { user, plan: i % 4 === 0 ? "team" : "pro" },
        value: null,
      });
    }
    if (i % 5 === 0) {
      events.push({
        type: "payment",
        occurredAt: at("12"),
        dimensions: { user, plan: "pro" },
        value: 49 + (i % 3) * 50,
      });
    }
  }
  return events;
}

/** The demo's metrics — the same three the seed creates, in one place. */
export const DEMO_METRICS = [
  {
    name: "Trial to paid",
    description: "Visit → signup → payment by user id.",
    kind: "funnel",
    config: {
      identityField: "user",
      steps: [{ event: "visit" }, { event: "signup" }, { event: "payment" }],
    },
  },
  {
    name: "Payment volume",
    description: "Sum of payment values in range.",
    kind: "sum",
    config: { event: "payment", field: "value" },
  },
  {
    name: "Signups",
    description: "Signup events in range.",
    kind: "count",
    config: { event: "signup" },
  },
] as const;

/** How many events the demo workspace holds — the number the landing page states. */
export const DEMO_EVENT_COUNT = buildDemoEvents().length;
