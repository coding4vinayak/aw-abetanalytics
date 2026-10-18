"use server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { newShareToken, shareUrl } from "@/lib/snapshot-share";

export type ShareResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * The snapshot the session's workspace is allowed to touch, or null.
 *
 * The workspace is read from the session, never from the browser, so a leaked
 * snapshot id from another tenant resolves to "not found" rather than a link.
 */
async function ownedSnapshot(snapshotId: string) {
  const session = await requireSession();
  const snapshot = await prisma.snapshot.findUnique({
    where: { id: snapshotId },
    select: { id: true, workspaceId: true, shareToken: true, shareRevokedAt: true },
  });
  if (!snapshot || snapshot.workspaceId !== session.workspaceId) return null;
  return snapshot;
}

/**
 * Mint — or return — the read-only link for a snapshot.
 *
 * Idempotent while a link is live: clicking Share twice must not silently kill
 * the URL the first click was pasted into a colleague's chat. Revoking and
 * sharing again is the rotation path, and it mints a fresh token.
 */
export async function shareSnapshotAction(snapshotId: string): Promise<ShareResult> {
  const snapshot = await ownedSnapshot(snapshotId);
  if (!snapshot) return { ok: false, error: "Snapshot not found." };

  if (snapshot.shareToken && !snapshot.shareRevokedAt) {
    return { ok: true, url: shareUrl(snapshot.shareToken) };
  }

  const token = newShareToken();
  await prisma.snapshot.update({
    where: { id: snapshot.id },
    data: { shareToken: token, shareCreatedAt: new Date(), shareRevokedAt: null },
  });
  return { ok: true, url: shareUrl(token) };
}

/**
 * Kill a live link. The token is left in place (with a revocation timestamp)
 * rather than nulled, so the same URL keeps resolving to nothing.
 */
export async function revokeSnapshotShareAction(snapshotId: string): Promise<ShareResult> {
  const snapshot = await ownedSnapshot(snapshotId);
  if (!snapshot) return { ok: false, error: "Snapshot not found." };

  if (snapshot.shareToken && !snapshot.shareRevokedAt) {
    await prisma.snapshot.update({
      where: { id: snapshot.id },
      data: { shareRevokedAt: new Date() },
    });
  }
  return { ok: true, url: "" };
}
