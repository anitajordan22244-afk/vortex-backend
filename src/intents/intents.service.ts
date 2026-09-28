import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentAuditEntry, IntentState } from "./intents.types";
import {
  INTENTS_REPOSITORY,
  IIntentsRepository,
  IntentPatch,
  isVersionConflict,
  MutationResult,
} from "./intents.repository";
import { AppConfig } from "../config/configuration";
import {
  CHAIN_DEADLINE_DEFAULTS,
  DEFAULT_DEADLINE_SECONDS,
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";
import { SettlementContractClient } from "../soroban/contracts/settlement.client";
import { isEvmSourceChain } from "../chains/evm/evm-chains";
import { ContractVersionUnsupportedException } from "../soroban/contract-version.service";
import { PrismaService } from "../prisma/prisma.service";

const STORE_SIZE_LOG_INTERVAL_MS = 60_000;
const TERMINAL_STATES: IntentState[] = ["filled", "cancelled", "expired", "slashed"];

/** How long a completed idempotency-key result stays replayable. */
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

/**
 * Upper bound on re-read-and-retry attempts after a VersionConflict
 * (issue #405). Keeps retry loops bounded even under sustained contention.
 */
export const MAX_VERSION_RETRIES = 3;

/** Caller-supplied fields for a new intent; everything else is assigned by the service. */
export type NewIntentData = Omit<
  Intent,
  "intentId" | "createdAt" | "state" | "version" | "srcVerified" | "srcVerification"
>;

/**
 * Maximum number of simultaneously open (state = "open" | "accepted") intents
 * allowed per user address.
 *
 * Rationale: the per-user rate limit (UserThrottlerGuard) bounds the *rate* of
 * creation but not the standing *count* — a user could steadily accumulate
 * thousands of open intents over time, which is exactly the scenario the
 * on-call runbook flags as a sweeper-performance risk.  This constant is the
 * authoritative cap; it is enforced in IntentsController.create() before the
 * intent is persisted.
 *
 * Kept as a named constant (rather than a config value) so the cap is visible
 * at the call site and testable without ConfigService.  Raise or lower it with
 * a code change + review rather than a silent env-var override.
 */
export const MAX_OPEN_INTENTS_PER_USER = 50;

/**
 * Orchestration layer for intents.
 *
 * Business logic (ID generation, default state, deadline defaulting,
 * idempotency cache, audit log) lives here. All persistence is delegated
 * to the injected IIntentsRepository so the storage adapter can be swapped
 * (in-memory ↔ Prisma) without touching this service or anything above it.
 */
@Injectable()
export class IntentsService implements OnModuleDestroy {
  private readonly logger = new Logger(IntentsService.name);

  /**
   * Keys whose creation is currently in flight in *this* process → the
   * in-flight creation promise. Claimed synchronously in {@link create} so
   * concurrent requests carrying the same idempotency key collapse onto a
   * single on-chain registration (issue #274). Cross-replica uniqueness is
   * enforced by the repository's unique idempotency-key index (issue #404).
   */
  private readonly idempotencyInFlight = new Map<string, Promise<Intent>>();

  /**
   * In-memory audit log used as a fast read path and fallback when the DB is
   * unavailable. The canonical source of truth is the intent_audit_log table
   * (issue #217 / #62). Writes are fire-and-forget against PrismaService so a
   * DB write failure never blocks or rolls back the underlying state transition.
   */
  private readonly auditLog = new Map<string, IntentAuditEntry[]>();

  private readonly sizeLogTimer: ReturnType<typeof setInterval>;

  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly settlement: SettlementContractClient,
    private readonly prisma: PrismaService,
  ) {
    const sweepMs = Number(this.configService.get("intentRetentionSweepMs", { infer: true }) ?? STORE_SIZE_LOG_INTERVAL_MS);
    this.sizeLogTimer = setInterval(() => this.logStoreSize(), sweepMs || STORE_SIZE_LOG_INTERVAL_MS);
    // Allow the process to exit even if the timer is still active.
    this.sizeLogTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sizeLogTimer);
  }

  /**
   * Logs the store size and evicts stale terminal intents from the in-memory
   * adapter when it is the active backend. This keeps the memory footprint
   * bounded without affecting on-chain or durable storage paths.
   */
  async logStoreSize(): Promise<void> {
    const evicted = await this.evictTerminalIntents();
    const remaining = await this.repo.findAll();
    this.logger.log(`[store-monitor] intents store size: ${remaining.length} (evicted=${evicted})`);
  }

  private async evictTerminalIntents(): Promise<number> {
    const store = this.configService.get("intentsStore", { infer: true }) ?? "memory";
    const onchainEnabled = this.configService.get("onchainIntentsEnabled", { infer: true });
    if (store !== "memory" || onchainEnabled) {
      return 0;
    }

    const retentionDays = Number(this.configService.get("intentRetentionDays", { infer: true }) ?? 30);
    const retentionSeconds = Math.max(0, Number.isFinite(retentionDays) ? retentionDays * 86400 : 30 * 86400);
    const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;

    const all = await this.repo.findAll();
    const stale = all.filter((intent) => {
      if (!TERMINAL_STATES.includes(intent.state)) return false;
      const lastTerminalTs = intent.filledAt ?? intent.createdAt;
      return lastTerminalTs <= cutoff;
    });

    let evicted = 0;
    for (const intent of stale) {
      const removed = await this.repo.delete(intent.intentId);
      if (removed) evicted += 1;
      this.logger.warn(
        `[retention] evicted terminal intent ${intent.intentId} from in-memory store (state=${intent.state}, createdAt=${intent.createdAt})`,
      );
    }

    return evicted;
  }

  /**
   * Create an intent. With an `idempotencyKey`, repeat and concurrent calls
   * within {@link IDEMPOTENCY_TTL_SECONDS} return the first intent — within
   * one process via the in-flight map, and across replicas via the
   * repository's atomic `createIdempotent` (issue #404).
   */
  async create(data: NewIntentData, idempotencyKey?: string): Promise<Intent> {
    if (!idempotencyKey) {
      const intent = await this.buildNewIntent(data);
      return this.repo.save(intent);
    }

    // Race-safe claim: no `await` between this `get` and the `set` below, so
    // two concurrent callers in this process can never both proceed — the
    // loser awaits the winner's promise. The claim precedes the conditional
    // registerOnChain() await inside buildNewIntent().
    const inFlight = this.idempotencyInFlight.get(idempotencyKey);
    if (inFlight) {
      return inFlight;
    }

    const creation = this.createIdempotent(data, idempotencyKey).finally(() => {
      this.idempotencyInFlight.delete(idempotencyKey);
    });
    this.idempotencyInFlight.set(idempotencyKey, creation);
    return creation;
  }

  private async createIdempotent(data: NewIntentData, idempotencyKey: string): Promise<Intent> {
    const minCreatedAt = Math.floor(Date.now() / 1000) - IDEMPOTENCY_TTL_SECONDS;

    const existing = await this.repo.findByIdempotencyKey(idempotencyKey, minCreatedAt);
    if (existing) return existing;

    const intent = await this.buildNewIntent(data);
    const result = await this.repo.createIdempotent(intent, idempotencyKey, minCreatedAt);
    if (!result.created) {
      // Another replica won the INSERT race between our lookup and insert.
      this.logger.warn(
        `[idempotency] key collision resolved to intent ${result.intent.intentId}; ` +
          `discarded candidate ${intent.intentId}`,
      );
    }
    return result.intent;
  }

  /**
   * Build and optionally register on-chain a brand-new intent. Contains no
   * persistence or idempotency logic — those are the caller's concern.
   */
  private async buildNewIntent(data: NewIntentData): Promise<Intent> {
    const now = Math.floor(Date.now() / 1000);

    const intent: Intent = {
      ...data,
      intentId: uuidv4(),
      state: "open",
      createdAt: now,
      deadline:
        data.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[data.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
      version: 0,
      ...this.initialSrcVerification(data.srcChain, now),
    };

    if (this.configService.get("onchainIntentsEnabled", { infer: true })) {
      await this.registerOnChain(intent);
    }

    return intent;
  }

  /**
   * Issue #403: with EVM_DEPOSIT_VERIFICATION_ENABLED, intents from EVM
   * chains start unverified — hidden from GET /intents/open and not
   * acceptable — until SourceDepositVerificationService confirms the escrow
   * deposit. Stellar-source intents, and every intent while the flag is off,
   * are marked verified with status "skipped".
   */
  private initialSrcVerification(srcChain: Intent["srcChain"], now: number): Pick<Intent, "srcVerified" | "srcVerification"> {
    const enabled = this.configService.get("evm", { infer: true })?.depositVerificationEnabled === true;
    if (enabled && isEvmSourceChain(srcChain)) {
      return { srcVerified: false, srcVerification: { status: "pending", checkedAt: now } };
    }
    return {
      srcVerified: true,
      srcVerification: {
        status: "skipped",
        checkedAt: now,
        detail: enabled ? "non-EVM source chain" : "deposit verification disabled",
      },
    };
  }

  /**
   * Registers `intent` with the settlement contract. Only called when
   * ONCHAIN_INTENTS_ENABLED is on; while that flag is off, create() never
   * touches the chain (the rollout fallback). The settlement client gates the
   * call on the deployed contract version (issue #402).
   */
  private async registerOnChain(intent: Intent): Promise<void> {
    if (!this.settlement.contractId) {
      throw new ServiceUnavailableException(
        "On-chain intent registration is enabled but SETTLEMENT_CONTRACT_ID is not configured",
      );
    }

    try {
      const result = await this.settlement.createIntent(intent);
      this.logger.log(`Registered intent ${intent.intentId} on-chain (tx ${result.hash})`);
    } catch (err) {
      // Read-only mode: surface the version details rather than a generic error.
      if (err instanceof ContractVersionUnsupportedException) throw err;
      this.logger.error(
        `Failed to register intent ${intent.intentId} on-chain: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "Failed to register intent with the settlement contract",
      );
    }
  }

  async get(id: string): Promise<Intent | undefined> {
    return this.repo.findById(id);
  }

  async getAll(): Promise<Intent[]> {
    return this.repo.findAll();
  }

  async getByState(state: IntentState): Promise<Intent[]> {
    return this.repo.findByState(state);
  }

  async getByUser(user: string): Promise<Intent[]> {
    return this.repo.findByUser(user);
  }

  /**
   * Batch-fetch the current record for each of `ids` (issue #275).
   *
   * IDs are de-duplicated; IDs with no matching record are simply omitted from
   * the result (callers get "missing" by comparing lengths, not a 404 per ID).
   * Backed by a single `WHERE intent_id IN (...)` query in Postgres.
   */
  async getMany(ids: string[]): Promise<Intent[]> {
    return this.repo.findManyByIds(ids);
  }

  async getAcceptedCountBySolver(solver: string): Promise<number> {
    return this.repo.countAcceptedBySolver(solver);
  }

  /**
   * Count the number of intents in "open" or "accepted" state for a user.
   * Used by IntentsController.create() to enforce MAX_OPEN_INTENTS_PER_USER;
   * a single COUNT(*) in Postgres.
   */
  async countOpenByUser(user: string): Promise<number> {
    return this.repo.countActiveByUser(user);
  }

  /**
   * Apply `patch` only if the intent is still at `expectedVersion`
   * (issue #405). Returns a VersionConflict otherwise — callers decide
   * whether to retry or surface a 409/412.
   */
  async update(id: string, patch: IntentPatch, expectedVersion: number): Promise<MutationResult> {
    return this.repo.update(id, patch, expectedVersion);
  }

  /**
   * Re-read → mutate loop for writers for whom retrying is semantically safe
   * (the sweeper, quote persistence, deposit verification). `mutate` receives
   * the freshly-read intent and returns the versioned mutation to attempt, or
   * `undefined` when the intent no longer needs changing — which ends the loop
   * with `null`. Bounded by {@link MAX_VERSION_RETRIES}; if every attempt
   * conflicts, the last VersionConflict is returned.
   */
  async mutateWithRetry(
    id: string,
    mutate: (current: Intent) => Promise<MutationResult> | MutationResult | undefined,
    maxAttempts = MAX_VERSION_RETRIES,
  ): Promise<MutationResult> {
    let last: MutationResult = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await this.repo.findById(id);
      if (!current) return null;
      const pending = mutate(current);
      if (pending === undefined) return null;
      last = await pending;
      if (!isVersionConflict(last)) return last;
    }
    this.logger.warn(`[occ] gave up on intent ${id} after ${maxAttempts} version conflicts`);
    return last;
  }

  /**
   * Atomically accept an intent only if it is currently "open" (and, when
   * given, still at `expectedVersion`).
   *
   * The new deadline is set to now + CHAIN_FILL_WINDOW_DEFAULTS[srcChain]
   * so solvers on slower-settling chains get a proportionally longer window
   * and are not unfairly slashed for a deadline that was never realistic.
   * Returns null when the intent is not found or is not in the "open" state.
   */
  async acceptIfOpen(id: string, solver: string, expectedVersion?: number): Promise<MutationResult> {
    const intent = await this.repo.findById(id);
    if (!intent) return null;
    const now = Math.floor(Date.now() / 1000);
    const fillWindow =
      CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    return this.repo.acceptIfOpen(id, solver, now + fillWindow, expectedVersion);
  }

  /**
   * Atomically fill an intent only if it is currently "accepted" by the given solver.
   * Returns null when the intent is not found, not accepted, or assigned to a
   * different solver.
   */
  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.repo.fillIfAccepted(id, solver, patch, expectedVersion);
  }

  /**
   * Atomically cancel an intent only if it is currently "open".
   * Returns null when the intent is not found or is not in the "open" state
   * (e.g. a concurrent accept() or sweeper expiry already transitioned it).
   */
  async cancelIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.repo.cancelIfOpen(id, expectedVersion);
  }

  /**
   * Atomically expire an intent only if it is currently "open".
   * Used by the sweeper so a concurrent user cancel() or solver accept()
   * always wins the race.
   */
  async expireIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.repo.expireIfOpen(id, expectedVersion);
  }

  /**
   * Atomically slash an intent only if it is currently "accepted".
   * Used by the sweeper so a concurrent solver fill() always wins the race.
   */
  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.repo.slashIfAccepted(id, patch, expectedVersion);
  }

  // ---------------------------------------------------------------------------
  // Audit trail (issue #217 / #62)
  // ---------------------------------------------------------------------------

  /**
   * Append a new audit entry for the given intent.
   *
   * Writes to both the in-memory log (fast read path / restart fallback) and
   * the persistent `intent_audit_log` table via PrismaService.
   *
   * Per issue #217: the DB write is non-blocking relative to the state
   * transition — a write failure is logged loudly but never rolls back or
   * blocks the caller.
   */
  appendAuditEntry(
    intentId: string,
    toState: IntentState,
    actor: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: IntentAuditEntry = {
      timestamp: new Date().toISOString(),
      toState,
      actor,
      reason,
      ...(metadata ? { metadata } : {}),
    };

    // 1. In-memory write (synchronous, always succeeds)
    const entries = this.auditLog.get(intentId) ?? [];
    entries.push(entry);
    this.auditLog.set(intentId, entries);

    // 2. Persistent DB write (fire-and-forget, failures are logged loudly)
    // NOTE: intentAuditLog is added to the Prisma client by the migration in
    // prisma/migrations/20260828000002_intent_audit_log/migration.sql.
    // The type assertion is needed until `npm run db:generate` runs in CI
    // against the updated schema.prisma.
    (this.prisma as unknown as {
      intentAuditLog: {
        create: (args: {
          data: {
            intentId: string;
            toState: string;
            actor: string;
            reason: string;
            metadata?: Record<string, unknown>;
            timestamp: Date;
          };
        }) => Promise<unknown>;
      };
    }).intentAuditLog
      .create({
        data: {
          intentId,
          toState,
          actor,
          reason,
          metadata: metadata ?? undefined,
          timestamp: new Date(entry.timestamp),
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `[audit] FAILED to persist audit entry for intent ${intentId} ` +
            `(toState=${toState}, actor=${actor}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      });
  }

  /**
   * Return the full audit trail for a given intent, oldest-first.
   *
   * Reads from the in-memory log as the fast path. Once the in-memory store is
   * replaced with a real DB (issue #36), this should read directly from the
   * `intent_audit_log` table ordered by timestamp ASC.
   *
   * Returns an empty array if the intent has no recorded transitions.
   */
  getAuditLog(intentId: string, limit?: number, offset?: number): IntentAuditEntry[] {
    const entries = this.auditLog.get(intentId) ?? [];
    if (limit === undefined && offset === undefined) return entries;

    const safeLimit = Math.min(limit ?? 20, 100);
    const safeOffset = Math.max(0, offset ?? 0);
    return entries.slice(safeOffset, safeOffset + safeLimit);
  }
}
