/**
 * Single source of truth for every chain the protocol recognises.
 * `SupportedChain` is derived from this tuple so all three consumers
 * (intents.types.ts, create-intent.dto.ts, tokens.data.ts) stay in sync
 * automatically — see issue #128.
 */
export const SUPPORTED_CHAINS = [
  "stellar",
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/**
 * A single entry in the append-only audit log for an intent.
 * Every state transition — cancel, expire, accept, fill — appends one entry.
 * Once persistence lands (issue #36) this will be written to an `intent_audit_log`
 * table; for now it lives in-memory alongside the intent map.
 */
export interface IntentAuditEntry {
  /** ISO-8601 UTC timestamp of the transition. */
  timestamp: string;
  /** State the intent moved INTO. */
  toState: IntentState;
  /** Actor who triggered the transition: a user address, solver address, or "system". */
  actor: string;
  /** Human-readable explanation, e.g. "user cancelled", "deadline passed". */
  reason: string;
  /** Optional extra data (fill amount, tx hash, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Single source of truth for every state an intent can be in.
 * `IntentState` is derived from this tuple so DTO validators (`@IsIn`),
 * Swagger `enum:` annotations, and type-checking all stay in sync
 * automatically — mirrors how `SUPPORTED_CHAINS` is defined above (issue #270).
 */
export const INTENT_STATES = [
  "open",
  "accepted",
  "filled",
  "cancelled",
  "expired",
  "slashed",
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  decimals: number;
  priceUSD?: number;
}

export interface Intent {
  intentId: string;
  user: string;
  srcChain: SupportedChain;
  srcToken: TokenInfo;
  srcAmount: string; // bigint as string
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string; // best quote from solvers
  solver?: string;
  state: IntentState;
  createdAt: number;
  deadline: number;
  filledAt?: number;
  fillAmount?: string;
  feeAmount?: string; // realized protocol fee in dst token base units
  txHash?: string; // fill tx on Stellar
  slashedAt?: number;
  slashReason?: string;
  /**
   * Optimistic-concurrency version (issue #405). Starts at 0 on creation and
   * is incremented by exactly one on every successful mutation. Exposed to
   * HTTP clients as the `ETag` of `GET /api/v1/intents/:id`.
   */
  version: number;
  /**
   * Whether the user's source-chain deposit has been verified (issue #403).
   * Intents stay `open` but are hidden from `GET /intents/open` and cannot be
   * accepted until this is true.
   */
  srcVerified: boolean;
  /** Source-chain transaction that performed the escrow deposit, if supplied. */
  srcTxHash?: string;
  /** Details of the most recent source-deposit verification attempt. */
  srcVerification?: SrcVerification;
}

/** Outcome of the source-chain deposit check for an intent (issue #403). */
export type SrcVerificationStatus =
  | "pending"
  | "verified"
  | "not_found"
  | "mismatch"
  | "reorged"
  | "skipped"
  | "grandfathered";

export interface SrcVerification {
  status: SrcVerificationStatus;
  /** Unix epoch seconds of the last check. */
  checkedAt: number;
  /** Block the matching `Deposited` log was found in. */
  blockNumber?: string;
  /** Hash of that block — compared on re-checks to detect reorgs. */
  blockHash?: string;
  /** Amount the escrow actually received (base units) — may be < srcAmount for fee-on-transfer tokens. */
  receivedAmount?: string;
  /** Human-readable reason for a non-verified status. */
  detail?: string;
}

export interface Quote {
  intentId: string;
  solver: string;
  dstAmount: string;
  fee: string; // protocol fee in dst token
  fillTime: number; // estimated seconds
  expiresAt: number;
}

export interface RouteStep {
  type: "bridge" | "swap" | "transfer";
  protocol: string;
  fromChain: string;
  toChain: string;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  estimatedTime: number;
  estimatedGas: string;
}

export interface Route {
  steps: RouteStep[];
  totalTime: number; // seconds
  totalFeesUSD: number;
  priceImpact: number;
}
