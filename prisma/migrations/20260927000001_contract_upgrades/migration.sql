-- Migration: contract upgrade history (issue #402)
-- Append-only record of every detected WASM upgrade of the settlement and
-- solver-registry contracts, written by ContractVersionService.

CREATE TABLE "contract_upgrades" (
    "id"                 BIGSERIAL    PRIMARY KEY,
    "contract_name"      TEXT         NOT NULL,
    "contract_id"        TEXT         NOT NULL,
    "previous_wasm_hash" TEXT,
    "wasm_hash"          TEXT,
    "abi_version"        TEXT,
    "source"             TEXT         NOT NULL,
    "ledger"             INTEGER,
    "tx_hash"            TEXT,
    "detected_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "contract_upgrades_contract_idx"
    ON "contract_upgrades" ("contract_id", "detected_at");
