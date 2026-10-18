// The event-window guard is the difference between "this range's count" and
// "the count of the first 50,000 rows in this range". These tests pin the
// boundary: exactly at the cap is answerable, one row past it is not.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_METRIC_EVENTS,
  EventWindowTooLargeError,
  assertWindowComplete,
} from "../../src/lib/event-window";

describe("event window bound", () => {
  it("accepts an empty window", () => {
    assert.doesNotThrow(() => assertWindowComplete(0));
  });

  it("accepts a window exactly at the bound", () => {
    assert.doesNotThrow(() => assertWindowComplete(MAX_METRIC_EVENTS));
  });

  it("refuses the row past the bound, and says what to do", () => {
    assert.throws(
      () => assertWindowComplete(MAX_METRIC_EVENTS + 1),
      (error: unknown) => {
        assert.ok(error instanceof EventWindowTooLargeError);
        assert.equal(error.max, MAX_METRIC_EVENTS);
        assert.match(error.message, /more than 50,000 events/);
        assert.match(error.message, /Narrow the range/);
        return true;
      },
    );
  });

  it("takes an explicit bound for a smaller caller", () => {
    assert.doesNotThrow(() => assertWindowComplete(3, 3));
    assert.throws(() => assertWindowComplete(4, 3), EventWindowTooLargeError);
  });
});
