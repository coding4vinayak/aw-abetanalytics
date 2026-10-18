// Unit test for the snapshot read guard's wiring: pure, no server, no DB.
// The boundary itself (at the cap vs. one past it) lives in
// `event-window.test.ts`, next to the guard it pins; this file only checks that
// `loadEvents` is actually wired to it, because the guard passing its own unit
// tests proves nothing if the query never lets it see the over-cap row.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("loadEvents read guard", () => {
  it("reads one past the bound and refuses a range that exceeds it", () => {
    const src = readFileSync(new URL("../../src/lib/snapshots.ts", import.meta.url), "utf8");
    assert.ok(
      src.includes("take: MAX_METRIC_EVENTS + 1"),
      "loadEvents must request MAX_METRIC_EVENTS + 1 rows so the guard can see an over-cap range",
    );
    assert.ok(
      src.includes("assertWindowComplete(rows.length)"),
      "loadEvents must hand the probe row to the shared guard instead of returning it",
    );
  });
});
