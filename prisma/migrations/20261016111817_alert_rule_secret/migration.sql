/*
  Warnings:

  - Added the required column `secret` to the `AlertRule` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "secret" TEXT NOT NULL;
