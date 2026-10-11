// The list routes used to hand the query string straight to Prisma, so a page
// of 0 became a negative `skip` and a page of "abc" became NaN — both throw,
// which is a 500 for a mistyped URL. These pin the clamp instead.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intParam, pageParams } from "../../src/lib/pagination";

const params = (query: Record<string, string>) => new URLSearchParams(query);

describe("list pagination bounds come from the server", () => {
  it("defaults to the first page at the route's own page size", () => {
    assert.deepEqual(pageParams(new URLSearchParams(""), 50), { page: 1, limit: 50 });
  });

  it("honours a sane page and limit", () => {
    assert.deepEqual(pageParams(params({ page: "3", limit: "10" }), 50), { page: 3, limit: 10 });
  });

  it("refuses to ask for the whole table", () => {
    assert.equal(pageParams(params({ limit: "999999999" }), 50).limit, 100);
    assert.equal(pageParams(params({ limit: "999999999" }), 50, 500).limit, 500);
  });

  it("treats a zero or negative page as the first page, not as a negative skip", () => {
    for (const page of ["0", "-4"]) assert.equal(pageParams(params({ page }), 20).page, 1, page);
  });

  it("treats a non-numeric or zero limit as the default, never as NaN or take:0", () => {
    for (const limit of ["abc", "", "0", "-1", "  "]) {
      assert.equal(pageParams(params({ limit }), 20).limit, 20, JSON.stringify(limit));
    }
  });

  it("degrades an exponential limit to its leading digit rather than to NaN", () => {
    // parseInt stops at "e", so 1e9 reads as 1. Small is the safe direction for
    // a page size; pinning it keeps the parser honest about what it accepts.
    assert.equal(pageParams(params({ limit: "1e9" }), 20).limit, 1);
  });

  it("truncates toward the page rather than around it", () => {
    const { page, limit } = pageParams(params({ page: "2", limit: "20" }), 20);
    assert.equal((page - 1) * limit, 20);
  });
});

// /api/events and /api/snapshots capped their limit but not their NaN:
// Math.min(parseInt("abc"), 500) is Math.min(NaN, 500), which is NaN, and
// take: NaN throws. Same hole, opposite direction — the cap only protected the
// numbers that were already fine.
describe("a capped limit is still a number", () => {
  it("falls back to the route's default instead of passing NaN to take", () => {
    assert.equal(intParam(params({ limit: "abc" }), "limit", 50, 1, 500), 50);
    assert.equal(intParam(params({ limit: "-3" }), "limit", 50, 1, 500), 50);
    assert.equal(intParam(params({ limit: "0" }), "limit", 20, 1, 100), 20);
  });

  it("keeps the cap it already had", () => {
    assert.equal(intParam(params({ limit: "99999" }), "limit", 50, 1, 500), 500);
    assert.equal(intParam(params({ limit: "99999" }), "limit", 20, 1, 100), 100);
  });
});
