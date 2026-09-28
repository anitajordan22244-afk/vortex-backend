import { ContractVersionService, ContractVersionUnsupportedException } from "./contract-version.service";
import { SOLVER_REGISTRY_CODECS } from "./contracts/solver-registry.client";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { SolverRegistryService } from "./solver-registry.service";
import { AppConfig } from "../config/configuration";

function makeConfigService(
  overrides: Partial<AppConfig["stellar"]> = {},
  appOverrides: Partial<Pick<AppConfig, "onchainDryRun">> = {},
) {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    settlementContractId: "",
    solverRegistryContractId: "",
    signerSecretKey: "",
    signingKey: "",
    feePercentile: "p50",
    ...overrides,
  };
  const config: AppConfig = {
    nodeEnv: "test",
    port: 4000,
    databaseUrl: "postgresql://vortex:vortex@localhost:5432/vortex?schema=public",
    stellar,
    onchainIntentsEnabled: false,
    intentsStore: "memory",
    intentsVerifyIntervalMs: 60000,
    intentRetentionDays: 30,
    intentRetentionSweepMs: 60000,
    evm: {
      depositVerificationEnabled: false,
      rpcUrls: {},
      escrowAddresses: {},
      transferFeeToleranceBps: 0,
      logLookbackBlocks: 10000,
    },
    // Default to dry-run true for tests (safe default)
    onchainDryRun: appOverrides.onchainDryRun ?? true,
    corsOrigin: "*",
    wsMaxConnections: 1000,
    wsBackplane: "memory",
    redisUrl: "redis://localhost:6379",
    // Resource-exhaustion limits (issue #476) — test defaults
    jsonMaxDepth: 10,
    wsMaxFilterChains: 20,
    wsMaxSubscriptions: 10,
    dbQueryTimeoutMs: 5000,
    dbBatchQueryTimeoutMs: 10000,
    dbStatsQueryTimeoutMs: 15000,
    // Emergency kill-switch (issue #477) — no operator token in unit tests, so
    // the control plane stays disabled.
    killswitch: {
      operatorToken: "",
      redisUrl: "",
      pollMs: 2000,
    governance: {
      paramsContractId: "",
      paramsPollIntervalMs: 30_000,
    leaderElection: {
      enabled: false,
      heartbeatMs: 5000,
    },
    processRole: "all",
    jobs: { driver: "memory", shutdownTimeoutMs: 25000 },
    flags: { pubsub: "memory", refreshMs: 30000, overrides: "" },
    adminApiKeys: "",
    guardianContractId: "",
    canaryAddresses: [],
  };
  return {
    get: (key: string) => {
      if (key === "onchainDryRun") return config.onchainDryRun;
      const parts = key.split(".");
      return (config as unknown as Record<string, unknown>)[parts[0]] && parts[0] === "stellar"
        ? (stellar as unknown as Record<string, unknown>)[parts[1]]
        : undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

describe("SolverRegistryService", () => {
  it("is not configured when the contract id and signing key are both empty (default)", () => {
    const service = new SolverRegistryService(makeConfigService());
    expect(service.isConfigured).toBe(false);
  });

  it("is not configured when only the contract id is set", () => {
    const service = new SolverRegistryService(
      makeConfigService({ solverRegistryContractId: "CABCDEF" }),
    );
    expect(service.isConfigured).toBe(false);
  });

  it("no-ops without contacting the network when unconfigured (dry-run=true)", async () => {
    const service = new SolverRegistryService(makeConfigService());
    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.simulated).toBe(false);
    // In dry-run mode, dryRun flag is true
    expect(result.dryRun).toBe(true);
  });
});

// ── #260: dry-run flag behaviour ─────────────────────────────────────────────

describe("SolverRegistryService — dry-run flag (#260)", () => {
  it("returns dryRun:true without simulating when ONCHAIN_DRY_RUN=true", async () => {
    const service = new SolverRegistryService(
      makeConfigService(
        { solverRegistryContractId: "CTEST123", signingKey: "S" + "A".repeat(55) },
        { onchainDryRun: true },
      ),
    );

    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.detail).toMatch(/ONCHAIN_DRY_RUN=true/);
  });

  it("returns dryRun:false when ONCHAIN_DRY_RUN=false and service is not fully configured", async () => {
    // With dryRun=false but contract not configured → falls through to no-op
    const service = new SolverRegistryService(
      makeConfigService({}, { onchainDryRun: false }),
    );

    const result = await service.slashSolver({
      solverAddress: "GSOLVER",
      intentId: "intent-1",
      reason: "missed deadline",
    });

    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.detail).toMatch(/not configured/i);
  });
});

// ── #402: contract version gating ────────────────────────────────────────────

describe("SolverRegistryService — contract version gating (#402)", () => {
  const live = () =>
    makeConfigService(
      { solverRegistryContractId: "CTEST123", signingKey: Keypair.random().secret() },
      { onchainDryRun: false },
    );

  it("refuses to slash — without touching the network — when the registry version is unsupported", async () => {
    const state = { contract: "solverRegistry", contractId: "CTEST123", status: "unknown_hash", wasmHash: "ff".repeat(32) };
    const versions = {
      assertWritable: jest.fn().mockRejectedValue(new ContractVersionUnsupportedException(state as never)),
    } as unknown as ContractVersionService;
    const service = new SolverRegistryService(live(), undefined, undefined, undefined, versions);
    const getAccount = jest.spyOn((service as unknown as { server: { getAccount: () => unknown } }).server, "getAccount");

    const result = await service.slashSolver({ solverAddress: Keypair.random().publicKey(), intentId: "i-1", reason: "r" });

    expect(result).toMatchObject({ submitted: false, simulated: false, dryRun: false });
    expect(result.detail).toMatch(/version not supported \(unknown_hash, wasmHash=f{64}\)/);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("does not consult the version in dry-run mode", async () => {
    const versions = { assertWritable: jest.fn() } as unknown as ContractVersionService;
    const service = new SolverRegistryService(
      makeConfigService({ solverRegistryContractId: "CTEST123", signingKey: "S" + "A".repeat(55) }, { onchainDryRun: true }),
      undefined, // signer
      undefined, // kill switch
      undefined, // feature flags
      versions,
    );
    await service.slashSolver({ solverAddress: "G", intentId: "i", reason: "r" });
    expect(versions.assertWritable).not.toHaveBeenCalled();
  });

  it("encodes the slash call with the codec for the deployed ABI", () => {
    const solver = Keypair.random().publicKey();
    const { method, args } = SOLVER_REGISTRY_CODECS["solver-registry-v1"].slash(solver, "intent-9");
    expect(method).toBe("slash");
    expect(scValToNative(args[0])).toBe(solver);
    expect(scValToNative(args[1])).toBe("intent-9");
  });
});
