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
}
