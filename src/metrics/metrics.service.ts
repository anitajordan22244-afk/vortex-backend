import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

  /** Dual-write / consistency-verifier metrics (issue #404). */
  public readonly intentsDualWriteFailuresTotal: client.Counter<string>;
  public readonly intentsStoreMismatches: client.Gauge<string>;
  public readonly intentsStoreMismatchesTotal: client.Counter<string>;
  public readonly intentsStoreVerifierRunsTotal: client.Counter<string>;

  /** Contract version gating metrics (issue #402). */
  public readonly contractVersionSupported: client.Gauge<string>;
  public readonly contractUpgradesTotal: client.Counter<string>;
  public readonly contractWritesBlockedTotal: client.Counter<string>;

  /** Source-chain deposit verification (issue #403). */
  public readonly srcVerificationsTotal: client.Counter<string>;
  public readonly srcVerificationErrorsTotal: client.Counter<string>;
  public readonly srcVerificationQueueSize: client.Gauge<string>;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.register = new client.Registry();
    const prefix = "vortex_";

    this.httpRequestDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.httpRequestErrors = new client.Counter({
      name: `${prefix}http_request_errors_total`,
      help: "Total number of HTTP request errors (5xx)",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.intentStateTransitions = new client.Counter({
      name: `${prefix}intent_state_transitions_total`,
      help: "Total number of intent state transitions",
      labelNames: ["from_state", "to_state"],
      registers: [this.register],
    });

    this.wsConnections = new client.Gauge({
      name: `${prefix}ws_connections_active`,
      help: "Number of active WebSocket connections",
      registers: [this.register],
    });

    // ── Sweeper metrics (issue #259) ─────────────────────────────────────────
    // These replace the retired MetricsRegistry.sweeper namespace from
    // src/common/metrics.ts. They are Prometheus-backed so they appear in
    // GET /metrics and in any Prometheus/Grafana dashboards without further
    // adaptation.

    this.sweeperExpiredTotal = new client.Counter({
      name: `${prefix}sweeper_expired_total`,
      help: "Total number of intents expired across all sweeps",
      registers: [this.register],
    });

    this.sweeperSweepDurationMs = new client.Histogram({
      name: `${prefix}sweeper_sweep_duration_ms`,
      help: "Duration of each IntentsSweeperService.sweep() execution in milliseconds",
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.register],
    });

    // ── Intents store migration metrics (issue #404) ─────────────────────────
    this.intentsDualWriteFailuresTotal = new client.Counter({
      name: `${prefix}intents_dual_write_failures_total`,
      help: "Postgres mirror writes that failed while INTENTS_STORE=dual",
      labelNames: ["operation"],
      registers: [this.register],
    });

    this.intentsStoreMismatches = new client.Gauge({
      name: `${prefix}intents_store_mismatches`,
      help: "Mismatches between the memory and Postgres intent stores found by the last verifier run",
      labelNames: ["kind"],
      registers: [this.register],
    });

    this.intentsStoreMismatchesTotal = new client.Counter({
      name: `${prefix}intents_store_mismatches_total`,
      help: "Cumulative mismatches found by the dual-write consistency verifier",
      labelNames: ["kind"],
      registers: [this.register],
    });

    this.intentsStoreVerifierRunsTotal = new client.Counter({
      name: `${prefix}intents_store_verifier_runs_total`,
      help: "Completed dual-write consistency verifier runs",
      registers: [this.register],
    });

    // ── Contract version gating (issue #402) ─────────────────────────────────
    this.contractVersionSupported = new client.Gauge({
      name: `${prefix}contract_version_supported`,
      help: "1 when the deployed contract WASM maps to a supported ABI, 0 when writes are blocked",
      labelNames: ["contract"],
      registers: [this.register],
    });

    this.contractUpgradesTotal = new client.Counter({
      name: `${prefix}contract_upgrades_total`,
      help: "Contract WASM upgrades detected, by detection source (poll | event)",
      labelNames: ["contract", "source"],
      registers: [this.register],
    });

    // ── Source-chain deposit verification (issue #403) ──────────────────────
    this.srcVerificationsTotal = new client.Counter({
      name: `${prefix}src_verifications_total`,
      help: "Source-deposit verification outcomes, by chain and status",
      labelNames: ["chain", "status"],
      registers: [this.register],
    });

    this.srcVerificationErrorsTotal = new client.Counter({
      name: `${prefix}src_verification_errors_total`,
      help: "Source-deposit verification attempts that failed with an RPC error",
      labelNames: ["chain", "reason"],
      registers: [this.register],
    });

    this.srcVerificationQueueSize = new client.Gauge({
      name: `${prefix}src_verification_queue_size`,
      help: "Open intents awaiting (re-)verification of their source deposit",
      registers: [this.register],
    });

    this.contractWritesBlockedTotal = new client.Counter({
      name: `${prefix}contract_writes_blocked_total`,
      help: "On-chain writes refused because the contract version is unsupported",
      labelNames: ["contract"],
      registers: [this.register],
    });
  }

  onModuleInit() {
    const prefix = "vortex_";
    client.collectDefaultMetrics({ register: this.register, prefix });
  }

  async metrics(): Promise<string> {
    return this.register.metrics();
  }

  contentType(): string {
    return this.register.contentType;
  }

  incIntentStateTransition(from: string, to: string) {
    this.intentStateTransitions.inc({ from_state: from, to_state: to });
  }

  incWsConnection() {
    this.wsConnections.inc();
  }

  decWsConnection() {
    this.wsConnections.dec();
  }

  /**
   * Record one sweeper cycle's expired count and duration.
   * Called by IntentsSweeperService at the end of every sweep() invocation.
   */
  recordSweep(expiredCount: number, durationMs: number): void {
    this.sweeperExpiredTotal.inc(expiredCount);
    this.sweeperSweepDurationMs.observe(durationMs);
  }

  /** Count a Postgres mirror write that failed in dual-write mode. */
  recordDualWriteFailure(operation: string): void {
    this.intentsDualWriteFailuresTotal.inc({ operation });
  }

  /** Publish one consistency-verifier run's mismatch counts, keyed by kind. */
  recordStoreVerification(mismatches: Record<string, number>): void {
    this.intentsStoreVerifierRunsTotal.inc();
    for (const [kind, count] of Object.entries(mismatches)) {
      this.intentsStoreMismatches.set({ kind }, count);
      if (count > 0) this.intentsStoreMismatchesTotal.inc({ kind }, count);
    }
  }

  setContractVersionSupported(contract: string, supported: boolean): void {
    this.contractVersionSupported.set({ contract }, supported ? 1 : 0);
  }

  recordContractUpgrade(contract: string, source: "poll" | "event"): void {
    this.contractUpgradesTotal.inc({ contract, source });
  }

  recordContractWriteBlocked(contract: string): void {
    this.contractWritesBlockedTotal.inc({ contract });
  }

  recordSrcVerification(chain: string, status: string): void {
    this.srcVerificationsTotal.inc({ chain, status });
  }

  recordSrcVerificationError(chain: string, reason: "rate_limited" | "rpc_error"): void {
    this.srcVerificationErrorsTotal.inc({ chain, reason });
  }

  setSrcVerificationQueueSize(size: number): void {
    this.srcVerificationQueueSize.set(size);
  }
}
