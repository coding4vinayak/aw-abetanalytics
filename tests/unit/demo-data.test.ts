// The demo dataset, and the promise the landing page makes about it.
//
// The page used to say "the demo workspace has 102 events waiting" and "the
// demo ships three working metrics" as literals. They were true on the day
// they were written, and nothing would have told anyone if the seed changed
// underneath them — so the numbers are now derived from the dataset that
// produces them, and this test holds the two together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEMO_EVENT_COUNT, DEMO_METRICS, DEMO_RANGE, buildDemoEvents } from "../../src/lib/demo-data";

test("the demo dataset is the funnel it claims to be", () => {
  const events = buildDemoEvents();
  const byType = (t: string) => events.filter((e) => e.type === t).length;
  assert.equal(events.length, DEMO_EVENT_COUNT, "the count and the events must agree");
  assert.equal(byType("visit"), 60);
  assert.equal(byType("signup"), 30);
  assert.equal(byType("payment"), 12);
  // The funnel groups by the `user` dimension, so a signup must belong to the
  // visit that produced it.
  const visitUsers = new Set(events.filter((e) => e.type === "visit").map((e) => e.dimensions.user));
  for (const e of events.filter((x) => x.type === "signup")) {
    assert.ok(visitUsers.has(e.dimensions.user), "every signup belongs to a visit");
  }
});

test("every event falls inside the demo window", () => {
  const start = new Date(DEMO_RANGE.start).getTime();
  const end = new Date(DEMO_RANGE.end).getTime();
  for (const e of buildDemoEvents()) {
    assert.ok(e.occurredAt.getTime() >= start && e.occurredAt.getTime() < end, "an event outside the window would not be in the snapshot");
  }
});

test("the demo ships three metrics, and the funnel can read the events", () => {
  assert.equal(DEMO_METRICS.length, 3);
  const funnel = DEMO_METRICS.find((m) => m.kind === "funnel");
  assert.ok(funnel, "the demo needs a funnel");
  assert.equal(funnel.config.identityField, "user");
  const steps = (funnel.config as unknown as { steps: { event: string }[] }).steps.map((s) => s.event);
  const types = new Set(buildDemoEvents().map((e) => e.type));
  for (const step of steps) {
    assert.ok(types.has(step), `the funnel's ${step} step has no events`);
  }
});

test("the landing page derives the demo's size instead of claiming it", () => {
  const page = readFileSync(new URL("../../src/app/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("{DEMO_EVENT_COUNT}"), "the event count must be derived");
  assert.ok(page.includes("{DEMO_METRICS.length}"), "the metric count must be derived");
  assert.ok(!/has 102 events/.test(page), "a hard-coded number is how a promise becomes a lie");
});

test("the seed writes the dataset the page describes", () => {
  const seed = readFileSync(new URL("../../prisma/seed.ts", import.meta.url), "utf8");
  assert.ok(seed.includes("buildDemoEvents()"), "the seed must write the shared dataset");
  assert.ok(seed.includes("DEMO_METRICS"), "and the shared metrics");
  assert.ok(!/for \(let i = 0; i < 60/.test(seed), "the dataset lives in one place now");
});
