import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { PrismaService } from "../prisma/prisma.service";
import {
  IdempotentCreateResult,
  IIntentsRepository,
  IntentPatch,
  MutationResult,
  VersionConflict,
} from "./intents.repository";
import { Intent, IntentState, SrcVerification, StellarToken, TokenInfo } from "./intents.types";

/** Raw `intents` row as returned by `SELECT *` / `RETURNING *`. */
interface IntentRow {
  intent_id: string;
  user: string;
  src_chain: string;
  src_token: unknown;
  src_amount: string;
  dst_token: unknown;
  min_dst_amount: string;
  quoted_dst_amount: string | null;
  solver: string | null;
  state: string;
  created_at: number;
  deadline: number;
  filled_at: number | null;
  fill_amount: string | null;
  fee_amount: string | null;
  tx_hash: string | null;
  slashed_at: number | null;
  slash_reason: string | null;
  version: number;
  src_verified?: boolean | null;
  src_tx_hash?: string | null;
  src_verification?: unknown;
}

/**
 * Column for each patchable Intent field, with the SQL cast needed to bind it.
 * Keeping this list explicit means a new Intent field is ignored by `update()`
 * until someone deliberately maps it here.
 */
const PATCH_COLUMNS: Partial<Record<keyof IntentPatch, { column: string; cast?: string; json?: boolean }>> = {
  user: { column: "user" },
  srcChain: { column: "src_chain", cast: '"SupportedChain"' },
  srcToken: { column: "src_token", cast: "jsonb", json: true },
  srcAmount: { column: "src_amount" },
  dstToken: { column: "dst_token", cast: "jsonb", json: true },
  minDstAmount: { column: "min_dst_amount" },
  quotedDstAmount: { column: "quoted_dst_amount" },
  solver: { column: "solver" },
  state: { column: "state", cast: '"IntentState"' },
  deadline: { column: "deadline" },
  filledAt: { column: "filled_at" },
  fillAmount: { column: "fill_amount" },
  feeAmount: { column: "fee_amount" },
  txHash: { column: "tx_hash" },
  slashedAt: { column: "slashed_at" },
  slashReason: { column: "slash_reason" },
  srcVerified: { column: "src_verified" },
  srcTxHash: { column: "src_tx_hash" },
  srcVerification: { column: "src_verification", cast: "jsonb", json: true },
};

/**
 * Prisma-backed implementation of IIntentsRepository (issue #404).
 *
 * Every mutation is a single `UPDATE … WHERE … RETURNING *` statement, so the
 * state guard, the optimistic version check (issue #405) and the write are
 * applied atomically by Postgres — there is no read-then-write window. When a
 * conditional update matches zero rows, a follow-up read only *classifies* the
 * failure (not found / version conflict / state guard); it never writes.
 *
 * Bigint amounts are stored as strings per the project's bigint-as-string
 * convention (see CONTRIBUTING.md); JSON columns are cast back on the way out.
 */
@Injectable()
export class PrismaIntentsRepository implements IIntentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(intent: Intent): Promise<Intent> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      INSERT INTO intents (${this.insertColumns()})
      VALUES (${this.insertValues(intent, null)})
      ON CONFLICT (intent_id) DO UPDATE SET ${this.upsertAssignments()}
      RETURNING *`;
    return this.fromRow(rows[0]);
  }

  /**
   * Upsert `intent` only when it is newer than the stored copy. Used by the
   * dual-write adapter so mirrored writes that arrive out of order can never
   * regress Postgres to an older version.
   */
  async saveIfNewer(intent: Intent): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO intents (${this.insertColumns()})
      VALUES (${this.insertValues(intent, null)})
      ON CONFLICT (intent_id) DO UPDATE SET ${this.upsertAssignments()}
      WHERE intents.version < EXCLUDED.version`;
  }

  async createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): Promise<IdempotentCreateResult> {
    return this.prisma.$transaction(async (tx) => {
      // Release a key held by an intent older than the replay window so the
      // unique index does not block its legitimate reuse.
      await tx.$executeRaw`
        UPDATE intents SET idempotency_key = NULL
        WHERE idempotency_key = ${idempotencyKey} AND created_at < ${minCreatedAt}`;

      const inserted = await tx.$queryRaw<IntentRow[]>`
        INSERT INTO intents (${this.insertColumns()})
        VALUES (${this.insertValues(intent, idempotencyKey)})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *`;
      if (inserted.length > 0) return { intent: this.fromRow(inserted[0]), created: true };

      const existing = await tx.$queryRaw<IntentRow[]>`
        SELECT * FROM intents WHERE idempotency_key = ${idempotencyKey}`;
      return { intent: this.fromRow(existing[0]), created: false };
    });
  }

  async findByIdempotencyKey(idempotencyKey: string, minCreatedAt: number): Promise<Intent | undefined> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      SELECT * FROM intents
      WHERE idempotency_key = ${idempotencyKey} AND created_at >= ${minCreatedAt}`;
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async findById(id: string): Promise<Intent | undefined> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>`SELECT * FROM intents WHERE intent_id = ${id}`;
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async findManyByIds(ids: string[]): Promise<Intent[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      SELECT * FROM intents WHERE intent_id IN (${Prisma.join(unique)})`;
    return rows.map((r) => this.fromRow(r));
  }

  async findAll(): Promise<Intent[]> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>`SELECT * FROM intents ORDER BY created_at DESC`;
    return rows.map((r) => this.fromRow(r));
  }

  async findByState(state: IntentState): Promise<Intent[]> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      SELECT * FROM intents WHERE state = ${state}::"IntentState" ORDER BY created_at DESC`;
    return rows.map((r) => this.fromRow(r));
  }

  async findByUser(user: string): Promise<Intent[]> {
    // Postgres is case-sensitive; normalise the address comparison in-query.
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      SELECT * FROM intents WHERE lower("user") = lower(${user}) ORDER BY created_at DESC`;
    return rows.map((r) => this.fromRow(r));
  }

  async countAcceptedBySolver(solver: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM intents WHERE state = 'accepted' AND solver = ${solver}`;
    return Number(rows[0]?.count ?? 0);
  }

  async countActiveByUser(user: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM intents
      WHERE state IN ('open', 'accepted') AND lower("user") = lower(${user})`;
    return Number(rows[0]?.count ?? 0);
  }

  async update(id: string, patch: IntentPatch, expectedVersion: number): Promise<MutationResult> {
    return this.conditionalUpdate(id, this.patchAssignments(patch), Prisma.sql`TRUE`, expectedVersion);
  }

  async delete(id: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`DELETE FROM intents WHERE intent_id = ${id}`;
    return count > 0;
  }

  async acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.conditionalUpdate(
      id,
      [Prisma.sql`state = 'accepted'`, Prisma.sql`solver = ${solver}`, Prisma.sql`deadline = ${newDeadline}`],
      Prisma.sql`state = 'open'`,
      expectedVersion,
    );
  }

  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.conditionalUpdate(
      id,
      [Prisma.sql`state = 'filled'`, ...this.patchAssignments(patch)],
      Prisma.sql`state = 'accepted' AND solver = ${solver}`,
      expectedVersion,
    );
  }

  async cancelIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.conditionalUpdate(id, [Prisma.sql`state = 'cancelled'`], Prisma.sql`state = 'open'`, expectedVersion);
  }

  async expireIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.conditionalUpdate(id, [Prisma.sql`state = 'expired'`], Prisma.sql`state = 'open'`, expectedVersion);
  }

  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.conditionalUpdate(
      id,
      [Prisma.sql`state = 'slashed'`, ...this.patchAssignments(patch)],
      Prisma.sql`state = 'accepted'`,
      expectedVersion,
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * `UPDATE intents SET …, version = version + 1 WHERE intent_id = $id AND
   * <guard> [AND version = $expected] RETURNING *` — one atomic statement.
   * On zero rows, re-read to classify as not-found, version conflict, or a
   * failed state guard.
   */
  private async conditionalUpdate(
    id: string,
    assignments: Prisma.Sql[],
    guard: Prisma.Sql,
    expectedVersion: number | undefined,
  ): Promise<MutationResult> {
    const versionClause =
      expectedVersion === undefined ? Prisma.empty : Prisma.sql`AND version = ${expectedVersion}`;
    const rows = await this.prisma.$queryRaw<IntentRow[]>`
      UPDATE intents
      SET ${Prisma.join([...assignments, Prisma.sql`version = version + 1`], ", ")}
      WHERE intent_id = ${id} AND (${guard}) ${versionClause}
      RETURNING *`;
    if (rows.length > 0) return this.fromRow(rows[0]);

    const current = await this.prisma.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM intents WHERE intent_id = ${id}`;
    if (current.length === 0) return null;
    if (expectedVersion !== undefined && current[0].version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, current[0].version);
    }
    return null;
  }

  private patchAssignments(patch: Partial<Intent>): Prisma.Sql[] {
    const assignments: Prisma.Sql[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const mapping = PATCH_COLUMNS[field as keyof IntentPatch];
      if (!mapping || value === undefined) continue;
      assignments.push(Prisma.sql`${Prisma.raw(`"${mapping.column}"`)} = ${this.bind(value, mapping)}`);
    }
    return assignments;
  }

  private bind(value: unknown, mapping: { cast?: string; json?: boolean }): Prisma.Sql {
    const param = mapping.json && value !== null ? JSON.stringify(value) : value;
    return mapping.cast ? Prisma.sql`${param}::${Prisma.raw(mapping.cast)}` : Prisma.sql`${param}`;
  }

  private static readonly INSERT_COLUMNS = [
    "id", "intent_id", "user", "src_chain", "src_token", "src_amount", "dst_token",
    "min_dst_amount", "quoted_dst_amount", "solver", "state", "created_at", "deadline",
    "filled_at", "fill_amount", "fee_amount", "tx_hash", "slashed_at", "slash_reason",
    "version", "idempotency_key",
  ];

  private insertColumns(): Prisma.Sql {
    return Prisma.raw(PrismaIntentsRepository.INSERT_COLUMNS.map((c) => `"${c}"`).join(", "));
  }

  private insertValues(intent: Intent, idempotencyKey: string | null): Prisma.Sql {
    return Prisma.join([
      uuidv4(),
      intent.intentId,
      intent.user,
      Prisma.sql`${intent.srcChain}::"SupportedChain"`,
      Prisma.sql`${JSON.stringify(intent.srcToken)}::jsonb`,
      intent.srcAmount,
      Prisma.sql`${JSON.stringify(intent.dstToken)}::jsonb`,
      intent.minDstAmount,
      intent.quotedDstAmount ?? null,
      intent.solver ?? null,
      Prisma.sql`${intent.state}::"IntentState"`,
      intent.createdAt,
      intent.deadline,
      intent.filledAt ?? null,
      intent.fillAmount ?? null,
      intent.feeAmount ?? null,
      intent.txHash ?? null,
      intent.slashedAt ?? null,
      intent.slashReason ?? null,
      intent.version,
      idempotencyKey,
    ]);
  }

  /** `SET col = EXCLUDED.col` for every mutable column (never id/intent_id/idempotency_key). */
  private upsertAssignments(): Prisma.Sql {
    const mutable = PrismaIntentsRepository.INSERT_COLUMNS.filter(
      (c) => !["id", "intent_id", "idempotency_key"].includes(c),
    );
    return Prisma.raw(mutable.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", "));
  }

  /** Map a raw `intents` row → domain Intent, omitting null optionals. */
  private fromRow(row: IntentRow): Intent {
    const intent: Intent = {
      intentId: row.intent_id,
      user: row.user,
      srcChain: row.src_chain as Intent["srcChain"],
      srcToken: row.src_token as TokenInfo,
      srcAmount: row.src_amount,
      dstToken: row.dst_token as StellarToken,
      minDstAmount: row.min_dst_amount,
      state: row.state as IntentState,
      createdAt: row.created_at,
      deadline: row.deadline,
      version: row.version,
      srcVerified: row.src_verified ?? true,
    };
    if (row.quoted_dst_amount !== null) intent.quotedDstAmount = row.quoted_dst_amount;
    if (row.solver !== null) intent.solver = row.solver;
    if (row.filled_at !== null) intent.filledAt = row.filled_at;
    if (row.fill_amount !== null) intent.fillAmount = row.fill_amount;
    if (row.fee_amount !== null) intent.feeAmount = row.fee_amount;
    if (row.tx_hash !== null) intent.txHash = row.tx_hash;
    if (row.slashed_at !== null) intent.slashedAt = row.slashed_at;
    if (row.slash_reason !== null) intent.slashReason = row.slash_reason;
    if (row.src_tx_hash) intent.srcTxHash = row.src_tx_hash;
    if (row.src_verification) intent.srcVerification = row.src_verification as SrcVerification;
    return intent;
  }
}
