import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../../config/configuration";
import { Intent } from "../../intents/intents.types";
import { ContractVersionService } from "../contract-version.service";
import { InvokeContractResult, StellarTxService } from "../stellar-tx.service";
import { SettlementAbiVersion } from "./contract-versions";

/** Encodes settlement-contract calls for one ABI version. */
export interface SettlementCodec {
  createIntent(intent: Intent): { method: string; args: xdr.ScVal[] };
}

/**
 * One codec per supported settlement ABI (issue #402). A new ABI gets a new
 * entry here plus hash mappings in SUPPORTED_CONTRACT_VERSIONS — existing
 * codecs are never edited in place, so a rollback keeps working.
 */
export const SETTLEMENT_CODECS: Record<SettlementAbiVersion, SettlementCodec> = {
  "settlement-v1": {
    createIntent: (intent) => ({
      method: "create_intent",
      args: [
        nativeToScVal(intent.intentId, { type: "string" }),
        new Address(intent.user).toScVal(),
        nativeToScVal(intent.srcChain, { type: "symbol" }),
        nativeToScVal(intent.srcToken.address, { type: "string" }),
        nativeToScVal(BigInt(intent.srcAmount), { type: "i128" }),
        new Address(intent.dstToken.contract).toScVal(),
        nativeToScVal(BigInt(intent.minDstAmount), { type: "i128" }),
        nativeToScVal(intent.deadline, { type: "u64" }),
      ],
    }),
  },
};

/**
 * Version-aware client for the settlement contract.
 *
 * Every write first asks ContractVersionService for the deployed ABI (which
 * re-reads the WASM hash when the cached one is older than 60 s) and encodes
 * with that version's codec. Unknown or unreadable versions throw a 503
 * before anything is built or submitted.
 */
@Injectable()
export class SettlementContractClient {
  constructor(
    private readonly stellarTx: StellarTxService,
    private readonly versions: ContractVersionService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  get contractId(): string {
    return this.configService.get("stellar.settlementContractId", { infer: true });
  }

  /** Register `intent` with the settlement contract via `create_intent`. */
  async createIntent(intent: Intent): Promise<InvokeContractResult> {
    const { abiVersion } = await this.versions.assertWritable("settlement");
    const { method, args } = SETTLEMENT_CODECS[abiVersion].createIntent(intent);
    return this.stellarTx.invokeContract({ contractId: this.contractId, method, args });
  }
}
