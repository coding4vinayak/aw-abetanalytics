// The schedule arithmetic, pinned without a database.
//
// These are the promises the product makes in words — "every Monday at 08:00,
// in my timezone" — and a promise that drifts by an hour twice a year is a
// broken promise. The interesting cases are the ones a quick implementation
// gets wrong: a zone with a half-hour offset, the hour a daylight-saving
// change moves, a schedule created after its own slot, and an occurrence that
// has already been delivered.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_REPORT_ATTEMPTS,
  dueOccurrence,
  instantForLocal,
  isValidTimeZone,
  lastOccurrenceAtOrBefore,
  nextRunAt,
  periodKey,
  reportWindow,
  zoneOffsetMs,
  zoneParts,
  type ScheduleShape,
} from "../../src/lib/report-schedule";

const EARLY = new Date("2020-01-01T00:00:00.000Z");

function shape(over: Partial<ScheduleShape> = {}): ScheduleShape {
  return {
    dayOfWeek: 1, // Monday
    hour: 8,
    timezone: "UTC",
    windowDays: 7,
    isEnabled: true,
    lastPeriod: null,
    lastAttemptPeriod: null,
    attempts: 0,
    createdAt: EARLY,
    ...over,
  };
}

describe("the local hour is what stays fixed", () => {
  it("finds the next Monday at 08:00 in UTC", () => {
    // Monday 19 Oct 2026, 09:00 UTC → the next slot is Monday the 26th.
    const now = new Date("2026-10-19T09:00:00.000Z");
    const next = nextRunAt(shape(), now);
    assert.equal(next.toISOString(), "2026-10-26T08:00:00.000Z");
    assert.equal(zoneParts(next, "UTC").weekday, 1);
    assert.equal(zoneParts(next, "UTC").hour, 8);
  });

  it("keeps 08:00 local across a daylight-saving change", () => {
    // Berlin leaves summer time on 25 Oct 2026, so the same 08:00 local is
    // 06:00Z before the change and 07:00Z after it. The instant moves; the
    // promise does not.
    const before = instantForLocal(2026, 10, 19, 8, 0, "Europe/Berlin");
    const after = instantForLocal(2026, 10, 26, 8, 0, "Europe/Berlin");
    assert.equal(before.toISOString(), "2026-10-19T06:00:00.000Z");
    assert.equal(after.toISOString(), "2026-10-26T07:00:00.000Z");
    assert.equal(zoneParts(before, "Europe/Berlin").hour, 8);
    assert.equal(zoneParts(after, "Europe/Berlin").hour, 8);

    // And the scheduler picks the post-change occurrence, still at 08:00 local.
    const next = nextRunAt(
      shape({ timezone: "Europe/Berlin" }),
      new Date("2026-10-19T09:00:00.000Z"),
    );
    assert.equal(next.toISOString(), "2026-10-26T07:00:00.000Z");
    assert.equal(zoneParts(next, "Europe/Berlin").hour, 8);
  });

  it("handles a zone with a half-hour offset", () => {
    const next = nextRunAt(
      shape({ timezone: "Asia/Kolkata" }),
      new Date("2026-10-19T00:00:00.000Z"),
    );
    // 08:00 in Kolkata (UTC+5:30) is 02:30Z.
    assert.equal(next.toISOString(), "2026-10-19T02:30:00.000Z");
    assert.equal(zoneParts(next, "Asia/Kolkata").hour, 8);
  });

  it("reads the zone's offset at an instant", () => {
    assert.equal(zoneOffsetMs(new Date("2026-07-01T00:00:00.000Z"), "Europe/Berlin"), 2 * 3600_000);
    assert.equal(zoneOffsetMs(new Date("2026-12-01T00:00:00.000Z"), "Europe/Berlin"), 3600_000);
    assert.equal(zoneOffsetMs(new Date("2026-07-01T00:00:00.000Z"), "UTC"), 0);
  });

  it("maps a local wall-clock time back to an instant", () => {
    const instant = instantForLocal(2026, 10, 19, 8, 0, "Europe/Berlin");
    assert.equal(instant.toISOString(), "2026-10-19T06:00:00.000Z");
  });
});

describe("the most recent occurrence", () => {
  it("is today when the hour has passed", () => {
    const occurrence = lastOccurrenceAtOrBefore(
      shape(),
      new Date("2026-10-19T09:00:00.000Z"),
    );
    assert.equal(occurrence?.toISOString(), "2026-10-19T08:00:00.000Z");
  });

  it("is last week when the hour has not come round yet", () => {
    const occurrence = lastOccurrenceAtOrBefore(
      shape(),
      new Date("2026-10-19T06:00:00.000Z"),
    );
    assert.equal(occurrence?.toISOString(), "2026-10-12T08:00:00.000Z");
  });

  it("does not claim occurrences that predate the schedule", () => {
    const occurrence = lastOccurrenceAtOrBefore(
      shape({ createdAt: new Date("2026-10-19T09:00:00.000Z") }),
      new Date("2026-10-19T10:00:00.000Z"),
    );
    assert.equal(occurrence, null);
  });
});

describe("what a schedule owes", () => {
  const now = new Date("2026-10-19T09:00:00.000Z");

  it("owes the occurrence it has not delivered", () => {
    const due = dueOccurrence(shape(), now);
    assert.equal(due?.period, "2026-10-19T08:00:00.000Z");
    assert.equal(due?.occurrence.toISOString(), "2026-10-19T08:00:00.000Z");
  });

  it("owes nothing twice: the same occurrence is not due again", () => {
    const delivered = shape({ lastPeriod: "2026-10-19T08:00:00.000Z" });
    assert.equal(dueOccurrence(delivered, now), null);
  });

  it("owes nothing when it is switched off", () => {
    assert.equal(dueOccurrence(shape({ isEnabled: false }), now), null);
  });

  it("retries a failed attempt, then gives up on that occurrence", () => {
    const failed = shape({ lastAttemptPeriod: "2026-10-19T08:00:00.000Z", attempts: 1 });
    assert.ok(dueOccurrence(failed, now), "a failed send is retried");

    const givenUp = shape({
      lastAttemptPeriod: "2026-10-19T08:00:00.000Z",
      attempts: MAX_REPORT_ATTEMPTS,
    });
    assert.equal(dueOccurrence(givenUp, now), null, "and then that occurrence is given up on");
  });

  it("gives the same period to every tick until it is delivered", () => {
    const first = dueOccurrence(shape(), now);
    const second = dueOccurrence(shape(), now);
    assert.equal(first?.period, second?.period);
    assert.equal(periodKey(first!.occurrence), first?.period);
  });
});

describe("the window a report covers", () => {
  it("reaches back the requested number of days and ends at the occurrence", () => {
    const occurrence = new Date("2026-10-19T08:00:00.000Z");
    const { start, end } = reportWindow(occurrence, 7);
    assert.equal(end.toISOString(), "2026-10-19T08:00:00.000Z");
    assert.equal(start.toISOString(), "2026-10-12T08:00:00.000Z");
  });
});

describe("timezones the runtime knows", () => {
  it("accepts real zone names and refuses nonsense", () => {
    assert.equal(isValidTimeZone("Europe/Berlin"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone(42), false);
  });
});

describe("the report path keeps its promises in code", () => {
  it("a report never re-evaluates the alert rules", () => {
    const src = readFileSync(new URL("../../src/lib/reports.ts", import.meta.url), "utf8");
    assert.ok(
      src.includes("fireAlerts: false"),
      "a report must not page the customer a second time for a number they already have",
    );
  });

  it("the emailed number is frozen and shared, not computed live", () => {
    const src = readFileSync(new URL("../../src/lib/reports.ts", import.meta.url), "utf8");
    assert.ok(src.includes("takeSnapshot("), "the report must freeze a snapshot");
    assert.ok(src.includes("mintSnapshotShare("), "the report must share the frozen number");
  });

  it("the tick is scheduled, not left to a restart", () => {
    const src = readFileSync(new URL("../../src/lib/queue.ts", import.meta.url), "utf8");
    assert.ok(src.includes("upsertJobScheduler"), "the hourly tick must be registered on boot");
    assert.ok(src.includes("REPORT_TICK_SCHEDULER_ID"), "and under a stable id, so restarts do not add a second one");
  });

  it("the email carries the number, the definition and the link", () => {
    const src = readFileSync(new URL("../../src/lib/email.ts", import.meta.url), "utf8");
    const start = src.indexOf("export function renderWeeklyReportEmail");
    assert.ok(start > 0, "the weekly report template must exist");
    const body = src.slice(start);
    assert.ok(body.includes("data.headline"), "the number");
    assert.ok(body.includes("data.definition"), "the definition");
    assert.ok(body.includes("data.shareUrl"), "the link");
  });
});
