-- Migration: source-chain deposit verification for intents (issue #403)
--
-- * src_verified      — false until the escrow Deposited log is confirmed;
--                       GET /intents/open hides unverified intents and
--                       accept() rejects them.
-- * src_tx_hash       — optional EVM deposit tx supplied at creation.
-- * src_verification  — last verification result (status, block, amount).
--
-- Existing rows predate verification and are grandfathered as verified so a
-- deploy does not suddenly hide every live intent from solvers.
--
-- Rollback (manual, see docs/runbooks/evm-deposit-verification.md):
--   DROP INDEX IF EXISTS "intents_open_verified_idx";
--   ALTER TABLE "intents" DROP COLUMN IF EXISTS "src_verification",
--     DROP COLUMN IF EXISTS "src_tx_hash", DROP COLUMN IF EXISTS "src_verified";

ALTER TABLE "intents"
    ADD COLUMN IF NOT EXISTS "src_verified"     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "src_tx_hash"      TEXT,
    ADD COLUMN IF NOT EXISTS "src_verification" JSONB;

UPDATE "intents"
SET "src_verified" = true,
    "src_verification" = jsonb_build_object(
        'status', 'grandfathered',
        'checkedAt', EXTRACT(EPOCH FROM NOW())::bigint,
        'detail', 'created before source-deposit verification (issue #403)'
    )
WHERE "src_verification" IS NULL;

-- GET /intents/open and the solver WS snapshot read exactly this slice.
CREATE INDEX IF NOT EXISTS "intents_open_verified_idx"
    ON "intents" ("created_at" DESC)
    WHERE "state" = 'open' AND "src_verified";
