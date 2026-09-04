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
  version: '10',

  /* ---- Token ---------------------------------------------------------- */

  // The token people buy — $BOX. The CA button copies this, the chart button
  // links to it, and DexScreener is searched by it. Nothing on the dashboard
  // resolves without it.
  contractAddress: '0x4D2EfF441848E1C21a207fFbE90295e7Db801Fc2',

  // $AMZN, the token holders are paid in — the quote side of the pair, per
  // thestonks.exchange's /api/coins entry for $BOX. Used to price "total
  // distributed" in USD when the rewards source doesn't give a USD figure
  // itself, so the sub-line under that card depends on it.
  rewardTokenAddress: '0xb200000000000000000000d9192b6B456483C2E8',

  chain: 'base',    // DexScreener chain slug
  chainId: 8453,    // EVM chain id

  // The block $BOX launched at, from thestonks.exchange's /api/coins. The
  // chain scan starts here; nothing relevant happened before it.
  launchBlock: 50704292,

  /* Holders' share of what leaves the rewards index — the rest is the
     protocol's cut, so the outflow is NOT the distributed figure on its own.
     VERIFIED against $BOX's Stockify panel ("TO HOLDERS 90% · 10% protocol ·
     0% creator") and its published totals: fees 0.2978 AMZNc × 0.9 = 0.2680,
     which is exactly paid 0.2307 plus the 0.0373 still to be invested. */
  holderShare: 0.9,

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
    // From /api/coins. The pool is corroborated by DexScreener, which resolves
    // the same pair from a search by contract address alone.
    pool: '0x795cd8715CC2C939b1A921327F43bEFA5F7FC2c4',
    rewardPool: null,
    feeLocker: '0x71D1D363176723f85d98B8B430DF33cde89f0A7f',
    // From /api/fee-routing, which reports this token's routing as
    // "rewards". Read by the indexer, not by the page.
    rewardsIndex: '0xa8516873A859F75c1C2A0EC904B52f9F78AF2629',
  },

  /* ---- Links ---------------------------------------------------------- */

  links: {
    x: 'https://x.com/AmznBox',

    // Leave null to auto-build a DexScreener link from the contract address.
    chart: null,

    // The two lockups in the footer panel — both hrefs are written from here.
    launchedIn: 'https://www.thestonks.exchange/token/0x4D2EfF441848E1C21a207fFbE90295e7Db801Fc2',
    rewardsBy: 'https://www.stockify.finance/indices/0x185e51e2c41a2748234bffc0c5f3208a0ced456e',
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

      /* `onchain` ALONE, deliberately. It folds the token's own Transfer logs
         into balances, exactly as the indexer does, so it is right by
         construction rather than by an explorer's luck. The explorer providers
         below still work — add 'blockscout', 'geckoterminal', 'etherscan' or
         'moralis' here to chain them — but for $BOX they are worse than
         nothing: GeckoTerminal answered 21, which the project's own figures
         contradict (365 wallet payments across 5 rounds cannot come from 21
         holders), and Blockscout 500s on a token this new. If no RPC answers,
         the tile shows a dash, which beats a confident wrong number. */
      providers: ['onchain'],

      onchain: {
        /* Tried in order; the first to answer runs the whole scan, since
           public nodes differ in how wide a getLogs range they allow and
           swapping mid-scan would make the chunk size meaningless. All three
           are public, keyless and CORS-enabled. */
        rpcUrls: [
          'https://mainnet.base.org',
          'https://base-rpc.publicnode.com',
          'https://base.llamarpc.com',
        ],

        // Defaults to CFG.launchBlock; set it here to scan a shorter window.
        startBlock: null,

        chunkSize: 10000,      // halves itself if the node says the range is too wide
        minChunkSize: 1000,
        confirmations: 5,      // stay clear of a reorg

        /* A page load spends at most this many requests, banks what it
           scanned in localStorage, and the next load resumes. The count is
           published only once the scan reaches the head: a partial fold has
           seen sends whose receives are in unread blocks, so it under-counts.
           ~200k blocks at 10k a request is ~20, well inside this. */
        maxCallsPerLoad: 120,

        /* The cost of a first scan grows with the token's history — roughly
           43k blocks a day on Base, so ~20 requests a fortnight at the chunk
           size above. Cached per browser, so it is paid once and then only
           the new blocks are read. Each window asks three questions — the
           token's transfers, and the reward token in and out of the rewards
           index — so it spends three of these per window, but they go out
           together and cost one round trip. */

        // Defaults to contracts.pool, feeLocker and rewardsIndex — they hold
        // supply without being holders.
        exclude: null,
      },

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
      /* On, but the file is empty: the page reads these off the chain now, and
         this source is the fallback for when no RPC answers plus the channel
         scripts/index-rewards.mjs publishes through. A completed chain scan
         outranks it either way. */
      enabled: true,

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
