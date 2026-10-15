-- CMS-22 (ADR-0010): async messaging over NATS.
--   Member.attendanceCount / lastAttendedAt — the attendance summary copied from Events
--   OutboxMessage    — events waiting to be published (the transactional outbox)
--   ProcessedMessage — message ids already handled (idempotent consumer)
-- Existing members start at 0 attendances: Events never published anything before this.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "attendanceCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttendedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "id" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxMessage_publishedAt_createdAt_idx" ON "OutboxMessage"("publishedAt", "createdAt");

