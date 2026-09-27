/**
 * e2e stand-in for @stellar/stellar-sdk.
 *
 * Re-exports the real SDK (Keypair, Networks, xdr, … are pure and needed for
 * signing and module wiring) and replaces only the network-facing Soroban RPC
 * server so the suite never talks to a live node. The relative path bypasses
 * the moduleNameMapper entry that points "@stellar/stellar-sdk" here.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const actual = jest.requireActual("../../../node_modules/@stellar/stellar-sdk");

const mockServer = {
  getHealth: jest.fn().mockResolvedValue({ status: "ok" }),
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
  getNetwork: jest.fn().mockResolvedValue({ passphrase: "test" }),
  getAccount: jest.fn().mockResolvedValue({ id: "test", sequence: "0" }),
  getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 1 }),
  getLedgerEntries: jest.fn().mockResolvedValue({ entries: [], latestLedger: 1 }),
};

module.exports = {
  ...actual,
  SorobanRpc: {
    ...actual.SorobanRpc,
    Server: jest.fn().mockImplementation(() => mockServer),
  },
};
