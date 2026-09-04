/* ==========================================================================
   What the indexer watches — $BOX on Base.
   --------------------------------------------------------------------------
   Addresses come from thestonks.exchange's /api/coins entry for the token.
   The pool is corroborated by DexScreener, which resolves the same pair from
   a search by contract address alone, and START_BLOCK agrees with the entry's
   own created_at to within a block at Base's 2s cadence.

   ⚠ STILL INCOMPLETE — the schedule in .github/workflows/index-rewards.yml
   stays commented out until both of these are filled in:

     rewardsIndex   from /api/fee-routing?pairs=<token>:<feeLocker>. Every
                    stream below watches it, so on the placeholder the scan
                    sums nothing.
     HOLDER_SHARE   the split the token's Stockify panel publishes, or better,
                    PROTOCOL_ADDRESS so the cut is subtracted exactly.

   ⚠ And which on-chain flow is "fees collected" versus "distributed" is not
   self-evident: check /debug against what thestonks.exchange and
   stockify.finance publish for $BOX before trusting a number — the traps and
   their magnitudes are in worker/README.md.
   ========================================================================== */

export const CHAIN_ID = 8453;                    // Base

export const TOKENS = {
  // The token people buy — $BOX, 18 decimals
  STR: '0x4D2EfF441848E1C21a207fFbE90295e7Db801Fc2',
  // The reward token holders are paid in — $AMZN, the quote side of the pair
  KEX: '0xb200000000000000000000d9192b6B456483C2E8',
};

export const CONTRACTS = {
  // The trading pair
  pool: '0x795cd8715CC2C939b1A921327F43bEFA5F7FC2c4',
  // Where trading fees accrue. This locker is SHARED BY EVERY COIN on the
  // platform — the same address served the previous token — so no stream may
  // sum it: doing so reports the whole platform's fees as this token's.
  feeLocker: '0x71D1D363176723f85d98B8B430DF33cde89f0A7f',
  // The distributor holders are paid from, from /api/fee-routing, which
  // reports this token's routing as "rewards". Every stream below watches it.
  // Note it is per-token — a different address from the previous token's —
  // which is what makes summing it this token's flows rather than the
  // platform's.
  rewardsIndex: '0xa8516873A859F75c1C2A0EC904B52f9F78AF2629',
};

// The block $BOX launched at, from /api/coins. Nothing relevant happened
// before it, so the scan starts here rather than at genesis.
export const START_BLOCK = 50704292;

/* The three flows the totals are built from:

     `feesIn`   reward tokens ARRIVING at the distributor — "fees collected"
     `paidOut`  everything LEAVING it: holder payments plus the protocol's cut,
                so it is not the "distributed" figure on its own
     `holders`  every token transfer folded into a running balance per address;
                addresses left holding something are the holder count

   Verify these against the platform's own panel before trusting them. */
export const STREAMS = [
  { id: 'feesIn', kind: 'sum', token: TOKENS.KEX, to: CONTRACTS.rewardsIndex, decimals: 18 },
  { id: 'paidOut', kind: 'sum', token: TOKENS.KEX, from: CONTRACTS.rewardsIndex, decimals: 18 },
  { id: 'holders', kind: 'balances', token: TOKENS.STR, decimals: 18 },
];

/* Share of the outflow that reaches holders — the rest is the protocol's cut.
   TODO: 0.9 is the previous token's split, NOT $BOX's — read the real one off
   the token's Stockify panel ("TO HOLDERS 90% · 10% protocol · 0% creator").
   Better still, set PROTOCOL_ADDRESS below and the protocol's share is
   subtracted exactly instead, which survives any change to the percentage. */
export const HOLDER_SHARE = 0.9;
export const PROTOCOL_ADDRESS = null;

if (PROTOCOL_ADDRESS) {
  STREAMS.push({
    id: 'protocolOut', kind: 'sum', token: TOKENS.KEX,
    from: CONTRACTS.rewardsIndex, to: PROTOCOL_ADDRESS, decimals: 18,
  });
}

/** Tokens that actually reached holders. */
export function holderPayout(totals) {
  const paidOut = totals.paidOut ?? 0;
  if (PROTOCOL_ADDRESS) return Math.max(0, paidOut - (totals.protocolOut ?? 0));
  return paidOut * HOLDER_SHARE;
}

/* Addresses that hold supply but are not holders in the sense the tile means:
   the pool itself, the fee locker, the rewards contract. */
export const EXCLUDE_FROM_HOLDERS = [
  CONTRACTS.pool,
  CONTRACTS.feeLocker,
  CONTRACTS.rewardsIndex,
].map((a) => a.toLowerCase());

/* Scan pacing. A Worker run is short, so it takes bites and resumes. Raise
   MAX_CHUNKS_PER_RUN to backfill faster; lower CHUNK_SIZE if the RPC complains
   (it halves automatically anyway). */
export const CHUNK_SIZE = 2000;
export const MAX_CHUNKS_PER_RUN = 60;
export const CONFIRMATIONS = 5;

// Price the token totals in USD. Public, no key.
export const DEXSCREENER_PAIR =
  'https://api.dexscreener.com/latest/dex/pairs/base/' + CONTRACTS.pool;
export const DEXSCREENER_KEX_TOKEN =
  'https://api.dexscreener.com/latest/dex/tokens/' + TOKENS.KEX;
