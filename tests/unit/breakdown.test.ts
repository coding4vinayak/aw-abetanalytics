// The breakdown's grouping rules, tested without a database. Live verification
// proves the endpoint; these pin the parts a live run can miss: the coverage
// bucket, auto-selection, ranking, and the 20-segment cap.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMetric, metricHeadline, type MetricConfig, type MetricEvent } from "../../src/lib/metrics";
import { segmentBreakdown, UNSET_SEGMENT } from "../../src/lib/snapshots";

function ev(
  type: string,
  at: string,
  dimensions: Record<string, unknown> = {},
  value: number | null = null,
): MetricEvent {
  return { type, occurredAt: new Date(at), dimensions, value };
}

const currentRange = { start: new Date("2026-03-08T00:00:00Z"), end: new Date("2026-03-15T00:00:00Z") };
const previousRange = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-03-08T00:00:00Z") };

function rowsFor(
  currentEvents: MetricEvent[],
  previousEvents: MetricEvent[] = [],
  dimension?: string,
  kind: "count" | "sum" | "avg" = "count",
  config: MetricConfig = { event: "signup" },
) {
  return segmentBreakdown({
    kind,
    config,
    currentEvents,
    previousEvents,
    currentRange,
    previousRange,
    dimension,
  });
}

const headlineOf = (kind: "count" | "sum" | "avg", config: MetricConfig, events: MetricEvent[]) =>
  metricHeadline(computeMetric(kind, config, events, currentRange)) ?? 0;

describe("segmentBreakdown", () => {
  it("splits a count by an explicit dimension", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { source: "instagram" }),
      ev("signup", "2026-03-10T10:00:00Z", { source: "instagram" }),
      ev("signup", "2026-03-11T10:00:00Z", { source: "google" }),
    ];
    const rows = rowsFor(current, [], "source");
    assert.deepEqual(
      rows.map((r) => [r.segment, r.current, r.previous]),
      [
        ["instagram", 2, 0],
        ["google", 1, 0],
      ],
    );
  });

  it("segments add back to the headline when every event carries the dimension", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { source: "instagram" }),
      ev("signup", "2026-03-10T10:00:00Z", { source: "instagram" }),
      ev("signup", "2026-03-11T10:00:00Z", { source: "google" }),
      ev("signup", "2026-03-12T10:00:00Z", { source: "email" }),
    ];
    const rows = rowsFor(current, [], "source");
    const total = rows.reduce((sum, r) => sum + r.current, 0);
    assert.equal(total, headlineOf("count", { event: "signup" }, current));
    assert.equal(total, 4);
  });

  it("keeps events that lack the dimension in a (not set) bucket, so the sum stays exact", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { source: "instagram" }),
      ev("signup", "2026-03-10T10:00:00Z", { source: "google" }),
      ev("signup", "2026-03-11T10:00:00Z"),
    ];
    const rows = rowsFor(current, [], "source");
    assert.equal(rows.find((r) => r.segment === UNSET_SEGMENT)?.current, 1);
    assert.equal(
      rows.reduce((sum, r) => sum + r.current, 0),
      3,
    );
  });

  it("adds up for a sum as well as a count", () => {
    const current = [
      ev("payment", "2026-03-09T10:00:00Z", { source: "instagram" }, 100),
      ev("payment", "2026-03-10T10:00:00Z", { source: "google" }, 250),
    ];
    const config = { event: "payment", field: "value" };
    const rows = rowsFor(current, [], "source", "sum", config);
    assert.equal(
      rows.reduce((sum, r) => sum + r.current, 0),
      headlineOf("sum", config, current),
    );
  });

  it("computes an average with the metric engine, not a count", () => {
    const current = [
      ev("payment", "2026-03-09T10:00:00Z", { source: "instagram" }, 100),
      ev("payment", "2026-03-10T10:00:00Z", { source: "instagram" }, 300),
      ev("payment", "2026-03-11T10:00:00Z", { source: "google" }, 50),
    ];
    const rows = rowsFor(current, [], "source", "avg", { event: "payment", field: "value" });
    assert.equal(rows.find((r) => r.segment === "instagram")?.current, 200);
    assert.equal(rows.find((r) => r.segment === "google")?.current, 50);
  });

  it("picks the dimension with the highest coverage when none is named", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { source: "instagram", plan: "pro" }),
      ev("signup", "2026-03-10T10:00:00Z", { source: "google" }),
      ev("signup", "2026-03-11T10:00:00Z", { source: "email", plan: "team" }),
    ];
    const rows = rowsFor(current);
    assert.equal(rows[0]?.dimension, "source");
  });

  it("breaks a coverage tie alphabetically", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { plan: "pro" }),
      ev("signup", "2026-03-10T10:00:00Z", { source: "google" }),
    ];
    assert.equal(rowsFor(current)[0]?.dimension, "plan");
  });

  it("returns nothing when no event carries a usable dimension", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", {}),
      ev("signup", "2026-03-10T10:00:00Z", { nested: { a: 1 } }),
    ];
    assert.deepEqual(rowsFor(current), []);
  });

  it("treats numbers and booleans as labels and objects as absent", () => {
    const current = [
      ev("signup", "2026-03-09T10:00:00Z", { channel: 7 }),
      ev("signup", "2026-03-10T10:00:00Z", { channel: true }),
      ev("signup", "2026-03-11T10:00:00Z", { channel: { nested: 1 } }),
      ev("signup", "2026-03-12T10:00:00Z", { channel: ["a"] }),
    ];
    const rows = rowsFor(current, [], "channel");
    assert.equal(rows.find((r) => r.segment === "7")?.current, 1);
    assert.equal(rows.find((r) => r.segment === "true")?.current, 1);
    assert.equal(rows.find((r) => r.segment === UNSET_SEGMENT)?.current, 2);
  });

  it("ranks by absolute movement, biggest mover first", () => {
    const current = [
      ...Array.from({ length: 3 }, () => ev("signup", "2026-03-09T10:00:00Z", { source: "instagram" })),
      ev("signup", "2026-03-10T10:00:00Z", { source: "google" }),
    ];
    const previous = [
      ...Array.from({ length: 4 }, () => ev("signup", "2026-03-02T10:00:00Z", { source: "email" })),
    ];
    const rows = rowsFor(current, previous, "source");
    assert.deepEqual(
      rows.map((r) => r.segment),
      ["email", "instagram", "google"],
    );
  });

  it("caps at 20 segments but keeps the biggest mover", () => {
    const current = [
      ...Array.from({ length: 5 }, () => ev("signup", "2026-03-09T10:00:00Z", { bucket: "b00" })),
      ...Array.from({ length: 24 }, (_, i) =>
        ev("signup", "2026-03-10T10:00:00Z", { bucket: `b${String(i + 1).padStart(2, "0")}` }),
      ),
    ];
    const rows = rowsFor(current, [], "bucket");
    assert.equal(rows.length, 20);
    assert.equal(rows[0]?.segment, "b00");
    assert.equal(
      rows.some((r) => r.segment === "b24"),
      false,
    );
  });

  it("ignores event types the metric does not read", () => {
    const current = [
      ev("purchase", "2026-03-09T10:00:00Z", { source: "instagram" }, 100),
      ev("cart_add", "2026-03-10T10:00:00Z"),
    ];
    const rows = rowsFor(current, [], "source", "sum", { event: "purchase", field: "value" });
    assert.deepEqual(
      rows.map((r) => r.segment),
      ["instagram"],
    );
    assert.equal(rows[0]?.current, 100);
  });

  it("ignores events the metric's filters reject", () => {
    const current = [
      ev("purchase", "2026-03-09T10:00:00Z", { source: "instagram", status: "paid" }, 100),
      ev("purchase", "2026-03-10T10:00:00Z", { status: "refunded" }, 90),
    ];
    const rows = rowsFor(current, [], "source", "sum", {
      event: "purchase",
      field: "value",
      filters: { status: "paid" },
    });
    assert.deepEqual(
      rows.map((r) => r.segment),
      ["instagram"],
    );
    assert.equal(rows[0]?.current, 100);
  });
});
