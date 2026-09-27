import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { logger } from "../common/logger";
import { MetricsService } from "../metrics/metrics.service";
import { isVersionConflict } from "./intents.repository";
import { Intent } from "./intents.types";

const SWEEP_INTERVAL_MS = 30_000;

/** Outcome of a single sweep cycle — returned so a manual trigger can log it. */
export interface SweepResult {
  expiredCount: number;
  slashedCount: number;
  durationMs: number;
}

@Injectable()
export class IntentsSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsSweeperService.name);
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
    private readonly solversService: SolversService,
    private readonly solverRegistryService: SolverRegistryService,
    private readonly metricsService: MetricsService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      this.sweep().catch((err) => {
        logger.error(`[sweeper] sweep failed: ${err instanceof Error ? err.message : err}`);
      });
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  async sweep(): Promise<SweepResult> {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);
    let expiredCount = 0;
    let slashedCount = 0;

    for (const intent of await this.intentsService.getByState("open")) {
      if (intent.deadline <= now) {
        // Optimistic concurrency (issue #405): expire only the version we
        // read. If another writer got there first, re-read and retry only
        // while the intent is still open and past its deadline — a
        // concurrent cancel()/accept() always wins.
        const expired = await this.intentsService.mutateWithRetry(intent.intentId, (current) =>
          current.state === "open" && current.deadline <= now
            ? this.intentsService.expireIfOpen(current.intentId, current.version)
            : undefined,
        );
        if (!expired || isVersionConflict(expired)) continue;
        // Audit trail (issue #62): system-driven expiration.
        this.intentsService.appendAuditEntry(
          intent.intentId,
          "expired",
          "system",
          "deadline passed",
          { deadline: intent.deadline, sweepedAt: now },
        );
        expiredCount++;
        await this.intentsGateway.broadcast({ type: "intent_expired", intentId: intent.intentId });
      }
    }

    const durationMs = Date.now() - startMs;

    // Record sweep metrics into the Prometheus-backed MetricsService (issue #259).
    // This replaces the retired MetricsRegistry from src/common/metrics.ts.
    this.metricsService.recordSweep(expiredCount, durationMs);

    this.logger.debug(`sweep complete: expired=${expiredCount} duration=${durationMs}ms`);

    if (expiredCount > 0) {
      this.logger.log(`[sweeper] Expired ${expiredCount} intent(s) in ${durationMs}ms`);
    }

    const missedFills = (await this.intentsService.getByState("accepted")).filter(
      (intent) => intent.deadline <= now,
    );

    for (const intent of missedFills) {
      if (await this.slashMissedFill(intent, now)) slashedCount++;
    }

    return { expiredCount, slashedCount, durationMs: Date.now() - startMs };
  }

  /**
   * Issue #269 — safe, auditable manual sweep trigger (operator break-glass).
   *
   * Runs exactly one sweep cycle on demand and logs the invocation loudly —
   * source, timestamp, and result — so a manual trigger is unmistakable in an
   * incident timeline. Wired to `SIGUSR2` in `main.ts`; there is deliberately
   * no HTTP surface, so it is not reachable by any API client.
   */
  async triggerManualSweep(source: string): Promise<SweepResult> {
    const invokedAt = new Date().toISOString();
    this.logger.warn(
      `[sweeper] MANUAL SWEEP TRIGGERED (source=${source}, invokedAt=${invokedAt}) — running one sweep cycle`,
    );

    try {
      const result = await this.sweep();
      this.logger.warn(
        `[sweeper] MANUAL SWEEP COMPLETE (source=${source}, invokedAt=${invokedAt}): ` +
          `expired=${result.expiredCount} slashed=${result.slashedCount} duration=${result.durationMs}ms`,
      );
      return result;
    } catch (err) {
      this.logger.error(
        `[sweeper] MANUAL SWEEP FAILED (source=${source}, invokedAt=${invokedAt}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  /** Returns true when this call slashed the intent. */
  private async slashMissedFill(intent: Intent, now: number): Promise<boolean> {
    const { intentId } = intent;
    const reason = "accepted intent not filled before deadline";

    // Optimistic concurrency (issue #405): slash only the version we read.
    // A fill that lands between our read and this write bumps the version,
    // so a late sweeper can never overwrite it and wrongly slash the solver.
    // On conflict, re-read and retry only while still accepted and overdue.
    const slashed = await this.intentsService.mutateWithRetry(intentId, (current) =>
      current.state === "accepted" && current.deadline <= now
        ? this.intentsService.slashIfAccepted(
            intentId,
            { slashedAt: now, slashReason: reason },
            current.version,
          )
        : undefined,
    );
    if (!slashed || isVersionConflict(slashed)) return false;
    const solver = slashed.solver;
    await this.intentsGateway.broadcast({ type: "intent_slashed", intentId, solver, reason });

    if (!solver) {
      // Shouldn't happen in practice — an "accepted" intent always has a
      // solver — but don't let a bad record throw the whole sweep cycle.
      logger.error(`[sweeper] intent ${intentId} was accepted with no solver on record`);
      return true;
    }

    await this.solversService.recordFailedFill(solver, intentId);
    const slashRecord = await this.solversService.recordSlash(solver, intentId, reason, now);

    const result = await this.solverRegistryService.slashSolver({
      solverAddress: solver,
      intentId,
      reason,
    });
    console.log(
      `[sweeper] slashed solver=${solver} for intent=${intentId}: ${result.detail} slashId=${slashRecord?.slashId ?? "unknown"}`,
    );
    return true;
  }
}
