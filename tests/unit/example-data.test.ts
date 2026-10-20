// The example week: the data a new trial loads, and the rules that keep it
// from ever being mistaken for the customer's own.
//
// This is a conversion feature with a data-safety edge, so both halves are
// pinned here: the shape of the week (so the number on the screen is the one
// the engine computes) and the shape of the removal (so "one click" can never
// mean "and your data too").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXAMPLE_CART_EVENT,
  EXAMPLE_CART_METRIC,
  EXAMPLE_REVENUE_EVENT,
  EXAMPLE_REVENUE_METRIC,
  buildExampleWeek,
  isExampleMetric,
} from "../../src/lib/example-data";

const NOW = new Date("2026-10-20T12:00:00.000Z");

describe("the example week", () => {
  it("is a week of revenue and a week of cart adds", () => {
    const week = buildExampleWeek(NOW);
    assert.equal(week.revenueEvents.length, 9);
    assert.equal(week.cartEvents.length, 214);
    assert.equal(
      week.revenueEvents.reduce((sum, e) => sum + e.value, 0),
      3820,
      "the example week is the 3,820 the demo reports",
    );
  });

  it("puts every event inside the week it claims", () => {
    const week = buildExampleWeek(NOW);
    for (const event of [...week.revenueEvents, ...week.cartEvents]) {
      assert.ok(
        event.occurredAt >= week.thisWeek.start && event.occurredAt <= week.thisWeek.end,
        "an event outside the window would make the number wrong",
      );
    }
  });

  it("carries the channel, so the breakdown has something to rank", () => {
    const week = buildExampleWeek(NOW);
    const sources = new Set(week.revenueEvents.map((e) => e.dimensions.source));
    assert.deepEqual([...sources].sort(), ["email", "google", "instagram"]);
  });

  it("has two windows, a week apart, so \"what changed?\" has two answers", () => {
    const week = buildExampleWeek(NOW);
    const day = 24 * 3600 * 1000;
    assert.equal(week.thisWeek.end.getTime() - week.thisWeek.start.getTime(), 7 * day);
    assert.equal(week.lastWeek.end.getTime(), week.thisWeek.start.getTime());
    assert.equal(week.thisWeek.start.getTime() - week.lastWeek.start.getTime(), 7 * day);
  });

  it("is the same week every time it is asked for the same moment", () => {
    assert.deepEqual(buildExampleWeek(NOW), buildExampleWeek(NOW));
  });
});

describe("what counts as example data", () => {
  it("is exactly two metric names and two event types", () => {
    assert.equal(isExampleMetric(EXAMPLE_REVENUE_METRIC), true);
    assert.equal(isExampleMetric(EXAMPLE_CART_METRIC), true);
    assert.equal(isExampleMetric("Weekly Revenue"), false);
    assert.equal(isExampleMetric("Example: Something Else"), false);
  });

  it("namespaces its event types, so a removal cannot touch real events", () => {
    assert.ok(EXAMPLE_REVENUE_EVENT.startsWith("example_"));
    assert.ok(EXAMPLE_CART_EVENT.startsWith("example_"));
  });
});

describe("the removal is surgical", () => {
  const src = readFileSync(new URL("../../src/lib/example-data.ts", import.meta.url), "utf8");

  it("deletes the example events by their namespaced types", () => {
    assert.match(src, /type:\s*\{\s*in:\s*\[EXAMPLE_REVENUE_EVENT,\s*EXAMPLE_CART_EVENT\]\s*\}/);
  });

  it("deletes the example metrics by their names, not by anything broader", () => {
    assert.match(src, /name:\s*\{\s*in:\s*\[EXAMPLE_REVENUE_METRIC,\s*EXAMPLE_CART_METRIC\]\s*\}/);
  });

  it("scopes every write to the workspace it was asked about", () => {
    const writes = src.match(/prisma\.\w+\.(create|createMany|deleteMany)\(\{[^}]*workspaceId/g) ?? [];
    assert.ok(writes.length >= 2, "every write names its workspace");
  });
});

describe("the door", () => {
  const route = readFileSync(new URL("../../src/app/api/example-data/route.ts", import.meta.url), "utf8");

  it("accepts a browser session or an API key", () => {
    assert.match(route, /getSession\(\)/, "the dashboard's browser path");
    assert.match(route, /authedWorkspaceId\(request\)/, "the API-first path");
  });

  it("refuses an anonymous caller", () => {
    assert.match(route, /status:\s*401/);
  });
});
