"use server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { mintSnapshotShare, revokeSnapshotShare, shareUrl } from "@/lib/snapshot-share";

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
    select: {
      id: true,
      workspaceId: true,
      shareToken: true,
      shareCreatedAt: true,
      shareRevokedAt: true,
    },
  });
  if (!snapshot || snapshot.workspaceId !== session.workspaceId) return null;
  return snapshot;
}

/** Mint — or return — the read-only link for a snapshot, from the browser session. */
export async function shareSnapshotAction(snapshotId: string): Promise<ShareResult> {
  const snapshot = await ownedSnapshot(snapshotId);
  if (!snapshot) return { ok: false, error: "Snapshot not found." };

  const { token } = await mintSnapshotShare(snapshot);
  return { ok: true, url: shareUrl(token) };
}

/** Kill a live link. The token is kept so the same URL keeps resolving to nothing. */
export async function revokeSnapshotShareAction(snapshotId: string): Promise<ShareResult> {
  const snapshot = await ownedSnapshot(snapshotId);
  if (!snapshot) return { ok: false, error: "Snapshot not found." };

  await revokeSnapshotShare(snapshot);
  return { ok: true, url: "" };
}
