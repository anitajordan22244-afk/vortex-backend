import { Controller, Get, Param, BadRequestException, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiParam,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { StrKey } from "@stellar/stellar-sdk";
import { SorobanService } from "./soroban.service";
import { AccountRateLimitGuard } from "./account-rate-limit.guard";
import { ContractVersionService } from "./contract-version.service";

@ApiTags("chain")
@Controller("api/v1/chain")
export class SorobanController {
  constructor(
    private readonly sorobanService: SorobanService,
    private readonly contractVersions: ContractVersionService,
  ) {}

  @Get("health")
  @ApiOkResponse({
    description: "Soroban RPC node health status (pass-through of the RPC `getHealth` result).",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "healthy" },
        latestLedger: { type: "number" },
        oldestLedger: { type: "number" },
        ledgerRetentionWindow: { type: "number" },
      },
      required: ["status"],
    },
  })
  getHealth() {
    return this.sorobanService.getHealth();
  }

  @Get("ledger")
  @ApiOkResponse({
    description: "Latest closed ledger as reported by the Soroban RPC node.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        sequence: { type: "number", example: 12345678 },
        protocolVersion: { type: "number" },
      },
      required: ["id", "sequence"],
    },
  })
  getLatestLedger() {
    return this.sorobanService.getLatestLedger();
  }

  @Get("network")
  @ApiOkResponse({
    description: "Network passphrase and protocol metadata for the configured RPC node.",
    schema: {
      type: "object",
      properties: {
        friendbotUrl: { type: "string", nullable: true },
        passphrase: { type: "string", example: "Test SDF Network ; September 2015" },
        protocolVersion: { type: "number" },
        readOnly: {
          type: "boolean",
          description: "True when a configured contract runs an unsupported WASM version and writes are disabled",
        },
        contracts: {
          type: "object",
          description: "Per-contract version state (settlement, solverRegistry): status, wasmHash, abiVersion, checkedAt",
        },
      },
      required: ["passphrase", "readOnly", "contracts"],
    },
  })
  async getNetwork() {
    const network = await this.sorobanService.getNetwork();
    return { ...network, ...this.contractVersions.snapshot() };
  }

  @Get("account/:publicKey")
  @UseGuards(AccountRateLimitGuard)
  @ApiParam({
    name: "publicKey",
    description: "Stellar Ed25519 account public key (starts with `G`, 56 characters).",
    example: "GABC1234567890TESTPUBLICKEY000000000000000000000000000000",
  })
  @ApiOkResponse({
    description: "On-chain account record (id, sequence number, and balances).",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        sequence: { type: "string", example: "987654321" },
        balances: {
          type: "array",
          items: {
            type: "object",
            properties: {
              balance: { type: "string" },
              asset_type: { type: "string" },
            },
          },
        },
      },
      required: ["id", "sequence"],
    },
  })
  @ApiBadRequestResponse({ description: "Invalid Stellar public key format" })
  @ApiTooManyRequestsResponse({
    description: "Per-account rate limit exceeded (AccountRateLimitGuard)",
  })
  getAccount(@Param("publicKey") publicKey: string) {
    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      !(StrKey?.isValidEd25519PublicKey ? StrKey.isValidEd25519PublicKey(publicKey) : /^G[A-Z2-7]{55}$/.test(publicKey))
    ) {
      throw new BadRequestException("Invalid Stellar public key format");
    }
    return this.sorobanService.getAccount(publicKey);
  }
}
