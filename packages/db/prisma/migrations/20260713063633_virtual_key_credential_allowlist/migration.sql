-- AlterTable
-- (The generated "DROP INDEX usage_event_occurredAt_brin" was removed: that
-- BRIN index was added by hand as a companion statement in 0_init because
-- Prisma's schema DSL can't express BRIN indexes, so migrate dev sees it as
-- drift on every future migration. It is intentional — do not drop it.)
ALTER TABLE "virtual_key" ADD COLUMN     "credentialAllowlist" UUID[] DEFAULT ARRAY[]::UUID[];
