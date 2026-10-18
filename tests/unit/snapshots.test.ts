// Unit tests for the snapshot read guard: pure, no server, no DB.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertWithinReadLimit, EVENT_READ_LIMIT } from "../../src/lib/snapshots";

describe("assertWithinReadLimit", () => {
  it("passes a set at the cap through unchanged", () => {
    const rows = new Array<number>(EVENT_READ_LIMIT).fill(0);
    assert.equal(assertWithinReadLimit(rows).length, EVENT_READ_LIMIT);
  });

  it("refuses one row past the cap, naming the fix", () => {
    assert.throws(
      () => assertWithinReadLimit(new Array<number>(EVENT_READ_LIMIT + 1).fill(0)),
      /range holds more than 50000 events — narrow the range or shard by workspace/,
    );
  });

  it("loadEvents reads one past the cap — the probe row is what makes the refusal possible", () => {
    // The pure-function coverage above would pass even if the query still
    // asked for exactly 50000 rows, because the guard would never see the
    // 50,001st one. Pin the query itself.
    const src = readFileSync(new URL("../../src/lib/snapshots.ts", import.meta.url), "utf8");
    assert.ok(
      src.includes("take: EVENT_READ_LIMIT + 1"),
      "loadEvents must request EVENT_READ_LIMIT + 1 rows so the guard can see an over-cap range",
    );
  });
});
