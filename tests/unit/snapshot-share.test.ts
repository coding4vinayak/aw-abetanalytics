// The share token rules, pinned without a database. The read path's one
// security-relevant filter (`shareRevokedAt: null`) is pinned at the source,
// because a unit test cannot exercise the query and a revoked link that keeps
// resolving is the failure worth catching.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARE_TOKEN_BYTES,
  isShareToken,
  newShareToken,
  shareUrl,
} from "../../src/lib/snapshot-share";

describe("snapshot share tokens", () => {
  it("are url-safe, the documented size, and unique per call", () => {
    const a = newShareToken();
    const b = newShareToken();
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.equal(a.length, Math.ceil(SHARE_TOKEN_BYTES / 3) * 4);
    assert.notEqual(a, b);
    assert.ok(isShareToken(a));
  });

  it("rejects anything that is not a token we could have issued", () => {
    for (const bad of [undefined, null, "", "short", "../../etc/passwd", "a b", "x".repeat(65), 42, {}]) {
      assert.equal(isShareToken(bad), false, String(bad));
    }
  });

  it("only accepts tokens of an issuing alphabet and length", () => {
    assert.ok(isShareToken("a".repeat(16)));
    assert.ok(isShareToken("a".repeat(64)));
    assert.equal(isShareToken("a".repeat(15)), false);
    assert.equal(isShareToken("a".repeat(65)), false);
    assert.equal(isShareToken("has.dot"), false);
  });

  it("builds an absolute link under /s/", () => {
    assert.match(shareUrl("token123"), /\/s\/token123$/);
  });
});

describe("the public read enforces revocation in one place", () => {
  it("findLiveSharedSnapshot filters revoked links and reads only the frozen row", () => {
    const src = readFileSync(new URL("../../src/lib/snapshot-share.ts", import.meta.url), "utf8");
    assert.ok(src.includes("shareRevokedAt: null"), "the read must exclude revoked links");
    assert.ok(src.includes("shareToken: token"), "the read must key on the token");
    // Nothing workspace-wide leaks through the public path.
    assert.equal(/workspaceId/.test(src), false);
  });

  it("the share page is unlisted and never touches the live metric", () => {
    const page = readFileSync(
      new URL("../../src/app/s/[token]/page.tsx", import.meta.url),
      "utf8",
    );
    assert.ok(page.includes("index: false"), "a shared number must be noindex");
    assert.ok(page.includes("findLiveSharedSnapshot"), "the page must read via the guarded query");
    assert.equal(/prisma/.test(page), false, "the page must not reach the database directly");
  });
});
