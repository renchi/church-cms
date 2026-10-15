-- CMS-22 code review: optimistic locking on Member.
-- Since the attendance consumer started writing to Member in the background,
-- an HTTP request and the consumer (or two consumer Pods) can load the same
-- member and overwrite each other's change. A version column turns that into a
-- conflict: the HTTP request gets 409, the consumer naks and retries.
-- A separate migration, not an edit of 20261015120000_messaging: that one is
-- already applied in the cluster, and Prisma rejects a changed applied migration.
-- DEFAULT 1, not 0: 0 means "never saved", and existing rows have been saved.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

