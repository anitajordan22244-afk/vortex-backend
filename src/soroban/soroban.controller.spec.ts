import { Test, TestingModule } from "@nestjs/testing";
import { Keypair } from "@stellar/stellar-sdk";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { ContractVersionService } from "./contract-version.service";

// ---------------------------------------------------------------------------
// Mock SorobanService — we only want to verify the controller wires correctly.
// ---------------------------------------------------------------------------

const mockSorobanService = {
  getHealth: jest.fn(),
  getLatestLedger: jest.fn(),
  getNetwork: jest.fn(),
  getAccount: jest.fn(),
};

const VERSION_SNAPSHOT = {
  readOnly: true,
  contracts: {
    settlement: { contract: "settlement", contractId: "C1", status: "unknown_hash", wasmHash: "ff" },
    solverRegistry: { contract: "solverRegistry", contractId: "", status: "unconfigured" },
  },
};
const mockContractVersions = { snapshot: jest.fn(() => VERSION_SNAPSHOT) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SorobanController", () => {
  let controller: SorobanController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SorobanController],
      providers: [
        { provide: SorobanService, useValue: mockSorobanService },
        { provide: ContractVersionService, useValue: mockContractVersions },
      ],
    }).compile();

    controller = module.get(SorobanController);
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getHealth
  // -------------------------------------------------------------------------

  describe("getHealth", () => {
    it("calls sorobanService.getHealth and returns its result", async () => {
      const mockResult = { status: "healthy" };
      mockSorobanService.getHealth.mockResolvedValueOnce(mockResult);

      const result = await controller.getHealth();

      expect(mockSorobanService.getHealth).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors from sorobanService.getHealth", async () => {
      mockSorobanService.getHealth.mockRejectedValueOnce(new Error("rpc down"));

      await expect(controller.getHealth()).rejects.toThrow("rpc down");
    });
  });

  // -------------------------------------------------------------------------
  // getLatestLedger
  // -------------------------------------------------------------------------

  describe("getLatestLedger", () => {
    it("calls sorobanService.getLatestLedger and returns its result", async () => {
      const mockResult = { id: "ledgerhash", sequence: 9999 };
      mockSorobanService.getLatestLedger.mockResolvedValueOnce(mockResult);

      const result = await controller.getLatestLedger();

      expect(mockSorobanService.getLatestLedger).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });

    it("propagates errors from sorobanService.getLatestLedger", async () => {
      mockSorobanService.getLatestLedger.mockRejectedValueOnce(new Error("ledger unavailable"));

      await expect(controller.getLatestLedger()).rejects.toThrow("ledger unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // getNetwork
  // -------------------------------------------------------------------------

  describe("getNetwork", () => {
    it("returns the RPC network info plus contract version state (#402)", async () => {
      const mockResult = { passphrase: "Test SDF Network ; September 2015" };
      mockSorobanService.getNetwork.mockResolvedValueOnce(mockResult);

      const result = await controller.getNetwork();

      expect(mockSorobanService.getNetwork).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ...mockResult, ...VERSION_SNAPSHOT });
    });

    it("propagates errors from sorobanService.getNetwork", async () => {
      mockSorobanService.getNetwork.mockRejectedValueOnce(new Error("network unreachable"));

      await expect(controller.getNetwork()).rejects.toThrow("network unreachable");
    });
  });

  // -------------------------------------------------------------------------
  // getAccount
  // -------------------------------------------------------------------------

  describe("getAccount", () => {
    const PUBLIC_KEY = Keypair.random().publicKey();

    it("passes the publicKey path param through to sorobanService.getAccount", async () => {
      const mockAccount = { id: PUBLIC_KEY, sequence: "98765" };
      mockSorobanService.getAccount.mockResolvedValueOnce(mockAccount);

      const result = await controller.getAccount(PUBLIC_KEY);

      expect(mockSorobanService.getAccount).toHaveBeenCalledTimes(1);
      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(result).toEqual(mockAccount);
    });

    it("passes a different publicKey correctly", async () => {
      const anotherKey = Keypair.random().publicKey();
      mockSorobanService.getAccount.mockResolvedValueOnce({ id: anotherKey });

      await controller.getAccount(anotherKey);

      expect(mockSorobanService.getAccount).toHaveBeenCalledWith(anotherKey);
    });

    it("propagates errors from sorobanService.getAccount", async () => {
      mockSorobanService.getAccount.mockRejectedValueOnce(new Error("account not found"));

      await expect(controller.getAccount(PUBLIC_KEY)).rejects.toThrow("account not found");
    });
  });
});
