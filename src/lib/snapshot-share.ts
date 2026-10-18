import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { appBaseUrl } from "./tokens";

/**
 * How a frozen number leaves the building.
 *
 * A snapshot is the number the board agreed, and its whole reason to exist is
 * that someone else has to see it. This is that someone: a random capability
 * token, a read-only page under it, and a revoke that kills it.
 *
 * Three rules, all of them about not widening the blast radius:
 * 1. The token is 192 bits of CSPRNG, url-safe — guessing is not a threat model.
 * 2. The link is a capability, not an identity. The page reads exactly one
 *    snapshot (name, value, range, definition as-run) and nothing else in the
 *    workspace; there is no list behind it to walk.
 * 3. Revoked means gone. The read path filters `shareRevokedAt: null`, and
 *    sharing again overwrites the token, so a URL its holder already has cannot
 *    be revived by sharing once more.
 */

/** 24 bytes → 192 bits; base64url keeps the token URL- and copy-paste-safe. */
export const SHARE_TOKEN_BYTES = 24;

export function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/**
 * Whether a path segment could be a token we issued, checked before any query.
 *
 * `GET /s/<anything>` should be a cheap "no" rather than a database round trip,
 * and pinning the alphabet means a crafted segment cannot arrive as a path
 * traversal or a SQL/pattern wildcard.
 */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** The public URL for a share link. */
export function shareUrl(token: string): string {
  return `${appBaseUrl()}/s/${token}`;
}

/**
 * The one read on the public path.
 *
 * `shareRevokedAt: null` *is* the revocation, so it is stated here and only
 * here: every public render goes through this function, which is what lets the
 * test suite pin the rule to a single line.
 */
export function findLiveSharedSnapshot(token: string) {
  return prisma.snapshot.findFirst({
    where: { shareToken: token, shareRevokedAt: null },
    select: {
      id: true,
      definition: true,
      result: true,
      rangeStart: true,
      rangeEnd: true,
      createdAt: true,
    },
  });
}
