-- Migration: optimistic concurrency + cross-replica idempotency for intents
-- (issues #404 / #405).
--
-- * version          — incremented by every UPDATE; mutations are guarded with
--                      `WHERE version = $expected` so concurrent writers can
--                      never silently overwrite one another.
-- * idempotency_key  — unique, so two replicas racing POST /intents with the
--                      same key collapse onto one row via
--                      `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`.
-- * slashed_at / slash_reason — previously dropped by the Prisma adapter,
--                      which made the dual-write consistency verifier report
--                      every slashed intent as a mismatch.
-- * fee_amount       — declared in schema.prisma but never created by an
--                      earlier migration; added defensively.
--
-- Rollback (manual, see docs/runbooks/intents-store-migration.md):
--   DROP INDEX IF EXISTS "intents_idempotency_key_key";
--   ALTER TABLE "intents" DROP COLUMN IF EXISTS "idempotency_key",
--     DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "slash_reason",
--     DROP COLUMN IF EXISTS "slashed_at";
-- fee_amount is intentionally left in place on rollback because the schema
-- has always declared it.

ALTER TABLE "intents"
    ADD COLUMN IF NOT EXISTS "fee_amount"      TEXT,
    ADD COLUMN IF NOT EXISTS "slashed_at"      INTEGER,
    ADD COLUMN IF NOT EXISTS "slash_reason"    TEXT,
    ADD COLUMN IF NOT EXISTS "version"         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "intents_idempotency_key_key"
    ON "intents" ("idempotency_key");
