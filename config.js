/* ==========================================================================
   SITE CONFIGURATION
   --------------------------------------------------------------------------
   This is the only file you need to edit to point the site at a token.
   Everything marked TODO has to be filled in; the rest has sane defaults.
   ========================================================================== */

window.SITE_CONFIG = {
  /* Build stamp. Shown in the ?debug=1 panel, so you can confirm which version
     a browser actually has rather than guessing at a cache. Bump it together
     with the ?v= on the script tags in index.html whenever you deploy. */
  version: '2',

  /* ---- Token ---------------------------------------------------------- */

  // The token people buy — $BOX. The CA button copies this, the chart button
  // links to it, and DexScreener is searched by it. Nothing on the dashboard
  // resolves without it.
  contractAddress: '0x4D2EfF441848E1C21a207fFbE90295e7Db801Fc2',

  // TODO — $AMZN, the token holders are paid in. Used to price "total
  // distributed" in USD when the rewards source doesn't give a USD figure
  // itself, so the sub-line under that card stays blank until it is set.
  rewardTokenAddress: null,

  chain: 'base',    // DexScreener chain slug
  chainId: 8453,    // EVM chain id

  /* Related contracts.
       pool         the trading pair — DexScreener is asked about THIS pool
                    first, and only falls back to searching by token address
       rewardPool   the reward token's own pair, used to price it
       feeLocker    where trading fees accrue
       rewardsIndex the distributor holders are paid from

     All optional. `pool` is read on every load and DexScreener is asked about
     it BEFORE it searches by token address — so a wrong pool here silently
     reports another token's market cap, liquidity and volume. Leave them null
     and the search by contract address is used instead: correct, if slower. */
  contracts: {
    pool: null,
    rewardPool: null,
    feeLocker: null,
    rewardsIndex: null,
  },

  /* ---- Links ---------------------------------------------------------- */

  links: {
    x: 'https://x.com/AmznBox',

    // Leave null to auto-build a DexScreener link from the contract address.
    chart: null,

    // The two lockups in the footer panel — both hrefs are written from here.
    launchedIn: 'https://www.thestonks.exchange/token/0x4D2EfF441848E1C21a207fFbE90295e7Db801Fc2',
    rewardsBy: 'https://www.stockify.finance/',
  },

  /* ======================================================================
     DATA SOURCES
     Each source fills in the fields it knows about. Later sources win, so
     `rewards` can override anything. Whatever no source provides falls back
     to `stats` below, and anything still missing renders as "—".
     ====================================================================== */

  sources: {

    /* Market cap, liquidity, 24h volume, and the token price.
       Public API, no key, CORS-enabled. */
    dexscreener: {
      enabled: true,
    },

    /* Holder count. DexScreener does not report holders, and no single
       explorer is reliable for a freshly launched token — a zero usually means
       "not indexed yet" rather than "no holders".

       So the providers below are tried IN ORDER and the first one to return a
       count above zero wins. A zero is treated as "no answer" and falls through
       to the next provider: a launched token with liquidity cannot have none.
       Run the page with ?debug=1 to see which provider answered.

         blockscout     — base.blockscout.com. Free, no key. Often has not
                          indexed a token in its first days.
         geckoterminal  — free, no key. Only has a count for tokens it indexes.
         etherscan      — Etherscan V2 multichain. Needs `etherscanApiKey`, and
                          its tokenholdercount action requires a PAID plan.
         moralis        — needs `moralisApiKey`; the free tier is enough.

       Providers without a key are skipped, so the key-free ones are tried first
       and the rest only engage once you fill a key in.

       ▸ The reliable answer is the indexer in worker/: it counts holders from
         the token's own transfer history, so it needs no explorer at all. Once
         it is deployed and synced it supplies `holders` through sources.rewards
         and this whole chain becomes a fallback.

       Set `enabled: false` to stop fetching holders here entirely. */
    holders: {
      enabled: true,
      providers: ['blockscout', 'geckoterminal', 'etherscan', 'moralis'],

      blockscoutBase: 'https://base.blockscout.com',
      geckoterminalBase: 'https://api.geckoterminal.com/api/v2',
      etherscanApiKey: '',
      moralisApiKey: '',
    },

    /* Rewards figures — total fees collected and total rewards distributed.
       These are protocol numbers, so no explorer has them.

       Three ways to feed them, in rising order of effort:
         1. edit data/rewards.json by hand
         2. run the "Index rewards" workflow (scripts/index-rewards.mjs), which
            sums transfers on Base and rewrites that file on a schedule
         3. deploy worker/ (a Cloudflare Worker serving the same shape) and put
            its URL first in `url`, with the committed file as the fallback

       `fields` maps our metric names onto whatever shape the response has.
       Values are dot-paths, so 'data.stats.totalFeesUsd' works; the first path
       that resolves to a number wins, so usually you just add yours to the
       front of a list.

       A remote endpoint must send permissive CORS headers, since the browser
       calls it directly. If it doesn't, proxy it from your own domain.

       NOTE: this source is merged LAST, so anything it returns overrides
       DexScreener. Leaving stale figures in data/rewards.json while this is
       enabled will quietly override the live market cap, liquidity and volume.
    */
    rewards: {
      // Off until data/rewards.json actually holds this token's numbers.
      enabled: false,

      // A string, or an array of them — the first source with a number for a
      // metric wins, so put live endpoints in front of the committed file:
      //   url: ['https://<your-worker>.workers.dev', 'data/rewards.json'],
      url: 'data/rewards.json',

      fields: {
        totalFeesCollected: [
          'totalFeesCollected', 'totalFeesUsd', 'feesCollectedUsd', 'fees.totalUsd',
          'data.totalFeesCollected', 'stats.totalFeesCollected',
        ],
        totalFeesTokens: ['totalFeesTokens', 'feesTokens', 'data.totalFeesTokens'],
        totalDistributed: [
          'totalDistributed', 'totalRewardsDistributed', 'rewardsDistributed',
          'data.totalDistributed', 'stats.totalDistributed',
        ],
        totalDistributedUsd: [
          'totalDistributedUsd', 'totalRewardsDistributedUsd', 'rewardsDistributedUsd',
          'data.totalDistributedUsd', 'stats.totalDistributedUsd',
        ],
        holders: [
          'holders', 'holderCount', 'totalHolders', 'data.holders', 'stats.holders',
        ],
        marketCap: ['marketCap', 'marketCapUsd', 'data.marketCap'],
        liquidity: ['liquidity', 'liquidityUsd', 'data.liquidity'],
        volume24h: ['volume24h', 'volume24hUsd', 'volumeUsd24h', 'data.volume24h'],
      },
    },
  },

  // How often to refresh, in seconds. 0 disables auto-refresh.
  refreshSeconds: 60,

  /* ---- Fallbacks ------------------------------------------------------ */
  // Used only where no source supplies a value. Leave a field null and the
  // tile shows "—" rather than a number that isn't real.

  stats: {
    totalFeesCollected: null,
    totalFeesTokens: null,
    totalDistributed: null,
    totalDistributedUsd: null,
    holders: null,
    marketCap: null,
    liquidity: null,
    volume24h: null,
  },

};
