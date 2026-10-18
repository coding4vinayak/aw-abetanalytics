import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { mintSnapshotShare, revokeSnapshotShare, shareUrl } from "@/lib/snapshot-share";

export const dynamic = "force-dynamic";

/**
 * The API twin of the dashboard's Share button: mint a read-only link for a
 * frozen snapshot, or revoke it.
 *
 * Same lib as the session action — `mintSnapshotShare` / `revokeSnapshotShare`
 * — so the idempotence rule ("a second Share returns the same URL") and the
 * revocation rule ("a revoked link stays dead") hold on both doors. Ownership is
 * this route's job: the snapshot's workspace must match the calling key, so
 * `assertOwns` is called in each handler next to the row it guards.
 */
function findSnapshot(id: string) {
  return prisma.snapshot.findUnique({
    where: { id },
    select: {
      id: true,
      workspaceId: true,
      shareToken: true,
      shareCreatedAt: true,
      shareRevokedAt: true,
    },
  });
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await findSnapshot(id);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, snapshot.workspaceId);

  const { token, createdAt, created } = await mintSnapshotShare(snapshot);
  return NextResponse.json(
    { token, url: shareUrl(token), sharedAt: createdAt, created },
    { status: created ? 201 : 200 },
  );
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await findSnapshot(id);
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, snapshot.workspaceId);

  const revoked = await revokeSnapshotShare(snapshot);
  return NextResponse.json({ revoked });
}

export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
