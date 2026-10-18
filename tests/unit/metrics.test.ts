// Unit tests for the metrics engine: pure computation, no server, no DB.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMetric, metricHeadline, type MetricEvent } from "../../src/lib/metrics";
import { checkThreshold } from "../../src/lib/alerts";

function ev(type: string, day: number, dimensions: Record<string, unknown> = {}, value: number | null = null): MetricEvent {
  return { type, occurredAt: new Date(`2026-03-${String(day).padStart(2, "0")}T10:00:00Z`), dimensions, value };
}

const range = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-04-01T00:00:00Z") };

describe("count / sum / avg / unique", () => {
  const events = [
    ev("signup", 1, { plan: "pro" }),
    ev("signup", 2, { plan: "team" }),
    ev("signup", 3, { plan: "pro" }),
    ev("payment", 5, {}, 100),
    ev("payment", 6, {}, 200),
    ev("payment", 7, {}),
  ];

  it("counts with dimension filters", () => {
    const r = computeMetric("count", { event: "signup", filters: { plan: "pro" } }, events, range);
    assert.equal(r.kind, "count");
    if (r.kind === "count") assert.equal(r.value, 2);
  });

  it("sums a field, ignoring missing values", () => {
    const r = computeMetric("sum", { event: "payment", field: "value" }, events, range);
    if (r.kind === "sum") assert.equal(r.value, 300);
    else assert.fail("wrong kind");
  });

  it("averages only the present values", () => {
    const r = computeMetric("avg", { event: "payment", field: "value" }, events, range);
    if (r.kind === "avg") assert.equal(r.value, 150);
    else assert.fail("wrong kind");
  });

  it("averages to null on no data, never NaN", () => {
    const r = computeMetric("avg", { event: "payment", field: "value" }, [], range);
    if (r.kind === "avg") assert.equal(r.value, null);
    else assert.fail("wrong kind");
  });

  it("counts distinct field values", () => {
    const r = computeMetric("unique", { event: "signup", field: "plan" }, events, range);
    if (r.kind === "unique") assert.equal(r.value, 2);
    else assert.fail("wrong kind");
  });

  it("respects the range window", () => {
    const narrow = { start: new Date("2026-03-02T00:00:00Z"), end: new Date("2026-03-03T00:00:00Z") };
    const r = computeMetric("count", { event: "signup" }, events, narrow);
    if (r.kind === "count") assert.equal(r.value, 1);
    else assert.fail("wrong kind");
  });

  it("rejects configs missing their event", () => {
    assert.throws(() => computeMetric("count", {}, events, range), /needs an event/);
  });
});

describe("funnel", () => {
  const events = [
    ev("visit", 1, { user: "a" }),
    ev("signup", 2, { user: "a" }),
    ev("pay", 3, { user: "a" }),
    ev("visit", 1, { user: "b" }),
    ev("signup", 4, { user: "b" }),
    ev("visit", 1, { user: "c" }),
    // Array order means nothing: the walk follows timestamps.
    ev("pay", 3, { user: "d" }),
    ev("visit", 1, { user: "d" }),
    ev("signup", 2, { user: "d" }),
  ];
  const config = {
    identityField: "user",
    steps: [{ event: "visit" }, { event: "signup" }, { event: "pay" }],
  };

  it("walks each subject through ordered steps", () => {
    const r = computeMetric("funnel", config, events, range);
    if (r.kind !== "funnel") return assert.fail("wrong kind");
    assert.deepEqual(r.steps.map((s) => s.count), [4, 3, 2]);
    assert.equal(r.subjects, 4);
  });

  it("reports per-step conversion", () => {
    const r = computeMetric("funnel", config, events, range);
    if (r.kind !== "funnel") return assert.fail("wrong kind");
    assert.equal(r.steps[2].rateFromFirst, 0.5);
    assert.equal(r.steps[0].rateFromPrev, 1);
  });

  it("requires steps and an identity", () => {
    assert.throws(() => computeMetric("funnel", {}, events, range), /step/);
    assert.throws(() => computeMetric("funnel", { steps: [{ event: "x" }] }, events, range), /identity/);
  });
});

describe("metricHeadline", () => {
  it("picks the comparable number per kind", () => {
    assert.equal(metricHeadline({ kind: "count", value: 7, events: 7 }), 7);
    assert.equal(metricHeadline({ kind: "avg", value: null, events: 0 }), null);
    assert.equal(
      metricHeadline({ kind: "funnel", subjects: 4, steps: [{ event: "a", count: 4, rateFromFirst: 1, rateFromPrev: 1 }] }),
      1,
    );
  });

  it("keeps a no-data funnel quiet — an empty window is not \"0% converted\"", () => {
    // Nobody entered step one. Returning 0 here made every `lt` rule fire on
    // nothing, the opposite of the README's "a null headline (no data) stays
    // quiet rather than firing on nothing".
    assert.equal(
      metricHeadline({
        kind: "funnel",
        subjects: 0,
        steps: [
          { event: "visit", count: 0, rateFromFirst: 0, rateFromPrev: 1 },
          { event: "pay", count: 0, rateFromFirst: 0, rateFromPrev: 0 },
        ],
      }),
      null,
    );
  });

  it("still reports a real collapse — entrants who never convert stay 0", () => {
    // Four people entered; nobody paid. That is a 0 worth waking someone for.
    assert.equal(
      metricHeadline({
        kind: "funnel",
        subjects: 4,
        steps: [
          { event: "visit", count: 4, rateFromFirst: 1, rateFromPrev: 1 },
          { event: "pay", count: 0, rateFromFirst: 0, rateFromPrev: 0 },
        ],
      }),
      0,
    );
  });
});

describe("checkThreshold", () => {
  it("compares all four operators and rejects junk", () => {
    assert.equal(checkThreshold("gt", 5, 4), true);
    assert.equal(checkThreshold("gte", 4, 4), true);
    assert.equal(checkThreshold("lt", 3, 4), true);
    assert.equal(checkThreshold("lte", 4, 4), true);
    assert.equal(checkThreshold("gt", 4, 4), false);
    assert.equal(checkThreshold("bogus", 9, 1), false);
  });
});
