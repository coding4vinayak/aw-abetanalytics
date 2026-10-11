// Guard-rail tests for AI metric explanations. No network, no key, no DB.
// The property under test: a model may only cite segments that exist in the
// breakdown it was given. An invented segment is dropped, not displayed.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  onlyKnownSegments,
  relativeChange,
  explainMetricChange,
} from "../../src/lib/ai-explain";

beforeEach(() => {
  delete process.env.LLM_API_KEY;
});

const rows = [
  { dimension: "plan", segment: "free", current: 80, previous: 100 },
  { dimension: "plan", segment: "pro", current: 120, previous: 100 },
];

describe("onlyKnownSegments", () => {
  it("keeps contributors grounded in the real breakdown", () => {
    const kept = onlyKnownSegments(
      [
        { dimension: "plan", segment: "pro", delta: "+20", note: "grew" },
        { dimension: "plan", segment: "free", delta: -20, note: "shrank" },
      ],
      rows,
    );
    assert.equal(kept.length, 2);
    assert.equal(kept[0].segment, "pro");
    assert.equal(kept[1].delta, "-20", "numeric deltas are stringified, not recomputed");
  });

  it("drops an invented segment even when everything else is well-formed", () => {
    // This is the failure mode the whole feature exists to prevent: a
    // confident paragraph about `plan=enterprise` when no such segment exists.
    const kept = onlyKnownSegments(
      [
        { dimension: "plan", segment: "pro", delta: "+20", note: "real" },
        { dimension: "plan", segment: "enterprise", delta: "+999", note: "invented" },
        { dimension: "channel", segment: "pro", delta: "+1", note: "wrong dimension" },
        { dimension: "plan", segment: "", delta: "x", note: "empty" },
      ],
      rows,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].segment, "pro");
  });

  it("returns [] for non-array input rather than throwing", () => {
    assert.deepEqual(onlyKnownSegments(undefined, rows), []);
  });
});

describe("relativeChange", () => {
  it("returns null when the previous value was 0 — no percentage is meaningful", () => {
    assert.equal(relativeChange(5, 0), null);
    assert.equal(relativeChange(0, 0), null);
    assert.equal(relativeChange(150, 100), 0.5);
  });
});

describe("explainMetricChange offline contract", () => {
  it("returns null when no model is configured", async () => {
    const explanation = await explainMetricChange({
      metric: { name: "signups", kind: "count" },
      current: { value: 200, from: "a", to: "b" },
      previous: { value: 200, from: "c", to: "d" },
      breakdown: rows,
    });
    assert.equal(explanation, null, "a metric is not a question until someone asks it");
  });
});
