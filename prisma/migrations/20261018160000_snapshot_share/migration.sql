-- AlterTable
ALTER TABLE "Snapshot" ADD COLUMN     "shareToken" TEXT,
ADD COLUMN     "shareCreatedAt" TIMESTAMP(3),
ADD COLUMN     "shareRevokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_shareToken_key" ON "Snapshot"("shareToken");
