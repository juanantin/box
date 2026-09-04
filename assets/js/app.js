/* ==========================================================================
   Site app
   Contract-address copy, live dashboard.

   Data flow: each source in CONFIG.sources returns the fields it knows about;
   they are merged in order, so a later source overrides an earlier one. Add
   ?debug=1 to the URL to log every raw source response to the console.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.SITE_CONFIG || {};
  var LINKS = CFG.links || {};
  var SRC = CFG.sources || {};
  var DEBUG = /[?&]debug=1\b/.test(location.search);

  var METRICS = ['fees', 'feesTokens', 'distributed', 'distributedUsd', 'holders',
                 'marketCap', 'liquidity', 'volume24h'];

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[site]'].concat([].slice.call(arguments)));
  }

  /* ---------------------------------------------------------------------
     Formatting
     --------------------------------------------------------------------- */

  /* Cents throughout on money, because the cards are read side by side and a
     rounded figure next to an exact one looks like a bug. Counts stay whole:
     there is no such thing as a third of a holder. */
  var nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  /* Token amounts are not money and do not share its two decimals: a reward
     token worth ~$258 a unit is paid out in fractions, and 0.2307 rounded to
     two places reads 0.23 — a fifth of the figure lost to formatting. Four
     places carry it, while a whole-number amount still reads as one. */
  var nfTok = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  function usd(n) { return '$' + nf2.format(n); }
  function amount(n) { return nfTok.format(n); }
  function count(n) { return nf0.format(Math.round(n)); }

  var FORMATTERS = {
    fees: usd,
    feesTokens: amount,
    distributed: amount,
    distributedUsd: amount,
    holders: count,
    marketCap: usd,
    liquidity: usd,
    volume24h: usd,
  };

  /* ---------------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------------- */

  function num(v) {
    if (typeof v === 'string') v = v.replace(/,/g, '').trim();
    var n = typeof v === 'number' ? v : parseFloat(v);
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  // Read a dot-path ('data.stats.fees', 'pairs.0.priceUsd') out of an object.
  function pick(obj, path) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // First path in the list that resolves to a usable number.
  function firstNumber(obj, paths) {
    var list = typeof paths === 'string' ? [paths] : (paths || []);
    for (var i = 0; i < list.length; i++) {
      var n = num(pick(obj, list[i]));
      if (n !== null) return n;
    }
    return null;
  }

  function fetchJson(url, headers) {
    var h = { accept: 'application/json' };
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    // no-store: a polling dashboard must not be served a cached total
    return fetch(url, { headers: h, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------------------------------------------------------------------
     Contract address + links
     --------------------------------------------------------------------- */

  var address = String(CFG.contractAddress || '').trim();

  function shorten(addr) {
    if (!addr) return '—';
    return addr.length <= 12 ? addr : addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  var caShort = document.getElementById('ca-short');
  if (caShort) caShort.textContent = shorten(address);

  var chartLink = document.getElementById('link-chart');
  if (chartLink) {
    chartLink.href = LINKS.chart ||
      ('https://dexscreener.com/' + (CFG.chain || 'base') + '/' + encodeURIComponent(address));
  }

  var xLink = document.getElementById('link-x');
  if (xLink && LINKS.x) xLink.href = LINKS.x;

  /* The two footer lockups, so every outbound link lives in config.js. */
  [['link-launched', LINKS.launchedIn], ['link-rewards', LINKS.rewardsBy]].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (el && pair[1]) el.href = pair[1];
  });

  /* Copy-to-clipboard, with a fallback for non-secure contexts. */
  var copyBtn = document.getElementById('copy-ca');
  var toast = document.getElementById('copy-toast');
  var toastText = document.getElementById('toast-text');
  var toastTimer = null;

  function flashToast(message, isError) {
    if (!toast) return;
    toastText.textContent = message;
    toast.classList.toggle('is-error', !!isError);
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-on'); }, 1800);
  }

  function legacyCopy(text) {
    var el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(el);
    return ok;
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      if (!address) { flashToast('No address set', true); return; }

      function fallback() {
        var ok = legacyCopy(address);
        flashToast(ok ? 'Copied!' : 'Copy failed', !ok);
      }

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(address).then(function () { flashToast('Copied!'); }, fallback);
      } else {
        fallback();
      }
    });
  }

  /* ---------------------------------------------------------------------
     Sources
     Each returns a partial stats object (or {}), and never rejects.
     --------------------------------------------------------------------- */

  /* Every source's outcome for the current load, so ?debug=1 can show which
     one came back empty rather than leaving you to guess at a row of dashes. */
  var sourceLog = [];

  function softly(name, promise) {
    return promise.then(
      function (v) {
        log(name, 'ok', v);
        sourceLog.push({ name: name, ok: true, empty: v === null || v === undefined, value: v });
        return v;
      },
      function (e) {
        var msg = (e && e.message) || 'failed';
        log(name, 'failed', msg);
        sourceLog.push({ name: name, ok: false, error: msg });
        return null;
      }
    );
  }

  /* Pick the deepest-liquidity pair for a token on the configured chain. */
  function bestPair(pairs, chain) {
    return (pairs || [])
      .filter(function (p) { return !chain || p.chainId === chain; })
      .sort(function (a, b) {
        return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
      })[0] || null;
  }

  // Overridable so the whole pipeline can be exercised against a stub.
  var DEX = CFG.dexBase || 'https://api.dexscreener.com/latest/dex/';

  /* Look a pair up by its own address. More dependable than the token search
     when a token trades against something other than the usual quotes — the
     search can come back empty while the pool is right there. */
  function dexByPair(pairAddress) {
    if (!pairAddress) return Promise.resolve(null);
    return softly('dexscreener:pair:' + pairAddress,
      fetchJson(DEX + 'pairs/' + encodeURIComponent(CFG.chain || 'base') + '/' + encodeURIComponent(pairAddress))
        .then(function (d) { return (d && d.pair) || bestPair(d && d.pairs, CFG.chain); }));
  }

  function dexByToken(addr) {
    if (!addr) return Promise.resolve(null);
    return softly('dexscreener:token:' + addr,
      fetchJson(DEX + 'tokens/' + encodeURIComponent(addr))
        .then(function (d) { return bestPair(d && d.pairs, CFG.chain); }));
  }

  /* Known pool first, token search as the fallback. */
  function dexPair(addr, pairAddress) {
    var cfg = SRC.dexscreener || {};
    if (cfg.enabled === false) return Promise.resolve(null);
    return dexByPair(pairAddress).then(function (pair) {
      return pair || dexByToken(addr);
    });
  }

  /* Market cap, liquidity, 24h volume. */
  function sourceDexScreener() {
    var pool = (SRC.dexscreener || {}).pairAddress || (CFG.contracts || {}).pool;
    return dexPair(address, pool).then(function (pair) {
      if (!pair) return null;
      var out = {};
      var mc = num(pair.marketCap);
      if (mc === null) mc = num(pair.fdv);
      if (mc !== null) out.marketCap = mc;
      if (pair.liquidity && num(pair.liquidity.usd) !== null) out.liquidity = num(pair.liquidity.usd);
      if (pair.volume && num(pair.volume.h24) !== null) out.volume24h = num(pair.volume.h24);

      /* A pair can resolve while carrying none of the three figures, which
         reads as "ok" above and as three em dashes on the page. Log what was
         actually extracted so the panel can tell those two cases apart. */
      sourceLog.push({
        name: 'dexscreener:fields (' + (pair.pairAddress || pair.dexId || 'pair') + ')',
        ok: true, empty: !Object.keys(out).length, value: out,
      });
      return out;
    });
  }

  /* Holder count — DexScreener doesn't report it, and no single explorer is
     reliable for a token this new, so try several and take the first real
     answer. A launched token with liquidity cannot have zero holders, so a
     zero means the explorer hasn't indexed it: treat it as no answer and move
     on rather than printing it. */
  function positive(n) {
    return (typeof n === 'number' && isFinite(n) && n > 0) ? n : null;
  }

  /* ---------------------------------------------------------------------
     Holders, counted from the chain
     No explorer has a dependable count for a token days old: Blockscout 500s
     or answers 0, GeckoTerminal knows only what it has indexed, Etherscan's
     count needs a paid plan. So the browser derives it the same way the
     indexer does — fold every Transfer of the token into a balance per
     address, and count the addresses left holding something.

     That is a lot of requests for one page load, so the scan is budgeted and
     its progress cached: a load spends at most `maxCallsPerLoad` requests,
     banks what it scanned, and the next load resumes from there. Until the
     scan reaches the head it reports nothing — a partial fold has seen sends
     whose matching receives are in blocks it has not read yet, so it
     UNDER-counts. A dash beats a wrong number.
     --------------------------------------------------------------------- */

  // keccak256("Transfer(address,address,uint256)"), the topic every ERC-20
  // emits. Filtering on it needs no ABI.
  var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  /* An indexed address parameter is stored as a 32-byte topic: 24 zeros then
     the 20-byte address. That padding is what lets a node filter by party. */
  function addressTopic(a) {
    return '0x' + '0'.repeat(24) + String(a).toLowerCase().replace(/^0x/, '');
  }

  function rpcCall(url, method, params) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] }),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    });
  }

  /* The first endpoint that answers wins, and is used for the whole scan.
     Public RPCs differ in how wide a getLogs range they allow, so mixing them
     mid-scan would make the chunk size meaningless. */
  function pickRpc(urls) {
    return urls.reduce(function (chain, url) {
      return chain.then(function (found) {
        if (found) return found;
        return rpcCall(url, 'eth_blockNumber').then(
          function (hex) { return { url: url, head: parseInt(hex, 16) }; },
          function (e) { log('holders:rpc', url, 'failed —', e.message); return null; }
        );
      });
    }, Promise.resolve(null));
  }

  var CACHE_KEY = 'box:holders:' + address.toLowerCase();

  function readCache(startBlock) {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      var c = raw ? JSON.parse(raw) : null;
      // A cache from a different start block describes a different history.
      if (c && c.startBlock === startBlock && c.balances) return c;
    } catch (e) { /* private mode, or a corrupt entry — rescan */ }
    return { startBlock: startBlock, cursor: startBlock, balances: {} };
  }

  function writeCache(c) {
    try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* quota, private mode */ }
  }

  // Written as a call, not the `0n` literal: the literal is parsed even on a
  // browser that has no BigInt, and a parse error here would cost every tile,
  // not just this one. scanHolders checks for support before any of this runs.
  var ZERO_BIG = typeof BigInt === 'function' ? BigInt(0) : null;

  function foldTransfers(balances, logs) {
    for (var i = 0; i < logs.length; i++) {
      var t = logs[i].topics || [];
      var data = logs[i].data;
      if (!data || data === '0x') continue;
      var value = BigInt(data);
      if (value === ZERO_BIG) continue;
      var from = t[1] ? '0x' + String(t[1]).slice(-40).toLowerCase() : null;
      var to = t[2] ? '0x' + String(t[2]).slice(-40).toLowerCase() : null;
      // The zero address is not a holder, so mints and burns fall out here.
      if (from && from !== ZERO_ADDRESS) balances[from] = (BigInt(balances[from] || '0') - value).toString();
      if (to && to !== ZERO_ADDRESS) balances[to] = (BigInt(balances[to] || '0') + value).toString();
    }
    // Wallets that round-tripped back to nothing would otherwise accumulate in
    // the cache forever, and every one of them is a byte of someone's quota.
    for (var addr in balances) if (balances[addr] === '0') delete balances[addr];
    return balances;
  }

  function countPositive(balances, exclude) {
    var n = 0;
    for (var addr in balances) {
      if (exclude.indexOf(addr) !== -1) continue;
      if (BigInt(balances[addr]) > ZERO_BIG) n++;
    }
    return n;
  }

  /* Base units are exact only as BigInt; convert once, here at the edge. */
  function toTokens(v, decimals) {
    var base = BigInt(10) ** BigInt(decimals || 18);
    return Number(v / base) + Number(v % base) / Number(base);
  }

  function sumTransfers(logs) {
    var total = ZERO_BIG;
    for (var i = 0; i < (logs || []).length; i++) {
      var d = logs[i].data;
      if (d && d !== '0x') total += BigInt(d);
    }
    return total;
  }

  /* One walk of the chain, three questions asked of every window:

       holders   every transfer of the token, folded into balances
       feesIn    the reward token arriving at the rewards index
       paidOut   the reward token leaving it

     They share a cursor because they share a scan — asking them separately
     would triple the walk. Within a window the three requests go out together,
     so three calls cost one round trip of latency.

     `feesIn` watches the REWARDS INDEX, never the fee locker: that locker is
     shared by every coin on the platform, and summing it reports the whole
     platform's fees as this token's. */
  function scanChain(cfg) {
    if (typeof BigInt !== 'function') {
      log('chain', 'no BigInt in this browser — skipping the scan');
      return Promise.resolve(null);
    }
    var oc = cfg.onchain || {};
    var urls = oc.rpcUrls || [];
    var startBlock = Number(oc.startBlock || CFG.launchBlock || 0);
    if (!urls.length || !startBlock) { log('chain', 'no rpcUrls or startBlock'); return Promise.resolve(null); }

    var c = CFG.contracts || {};
    var reward = CFG.rewardTokenAddress;
    var index = c.rewardsIndex;
    var holderShare = Number(CFG.holderShare);
    var wantFlows = !!(reward && index && isFinite(holderShare));

    // The pool, the fee locker and the distributor hold supply without being
    // holders in the sense the tile means.
    var exclude = (oc.exclude || [c.pool, c.feeLocker, c.rewardsIndex])
      .filter(Boolean).map(function (a) { return String(a).toLowerCase(); });

    var budget = Number(oc.maxCallsPerLoad || 120);
    var minSpan = Number(oc.minChunkSize || 1000);
    var span = Number(oc.chunkSize || 10000);

    return pickRpc(urls).then(function (node) {
      if (!node) throw new Error('no RPC answered');

      var head = node.head - Number(oc.confirmations || 5);   // a reorg must not bank totals
      var cache = readCache(startBlock);
      var cursor = Math.max(cache.cursor, startBlock);
      var balances = cache.balances;
      var feesIn = BigInt(cache.feesIn || '0');
      var paidOut = BigInt(cache.paidOut || '0');
      var calls = 0;

      function window_(from, to) {
        var range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
        var asks = [
          rpcCall(node.url, 'eth_getLogs', [{
            address: address, topics: [TRANSFER_TOPIC],
            fromBlock: range.fromBlock, toBlock: range.toBlock,
          }]),
        ];
        if (wantFlows) {
          asks.push(rpcCall(node.url, 'eth_getLogs', [{
            address: reward, topics: [TRANSFER_TOPIC, null, addressTopic(index)],
            fromBlock: range.fromBlock, toBlock: range.toBlock,
          }]));
          // A trailing null is dropped: some nodes reject a filter ending in one.
          asks.push(rpcCall(node.url, 'eth_getLogs', [{
            address: reward, topics: [TRANSFER_TOPIC, addressTopic(index)],
            fromBlock: range.fromBlock, toBlock: range.toBlock,
          }]));
        }
        calls += asks.length;
        return Promise.all(asks);
      }

      function step() {
        if (cursor > head) return Promise.resolve(true);
        if (calls >= budget) return Promise.resolve(false);

        var end = Math.min(cursor + span - 1, head);
        return window_(cursor, end).then(function (res) {
          foldTransfers(balances, res[0] || []);
          if (wantFlows) {
            feesIn += sumTransfers(res[1]);
            paidOut += sumTransfers(res[2]);
          }
          cursor = end + 1;
          return step();
        }, function (err) {
          // "range too large" is the node asking for smaller bites, not a failure.
          if (/too large|range|limit|exceed|more than|block range/i.test(err.message) && span > minSpan) {
            span = Math.max(minSpan, Math.floor(span / 2));
            log('chain', 'narrowing to', span, 'blocks');
            return step();
          }
          throw err;
        });
      }

      return step().then(function (complete) {
        writeCache({
          startBlock: startBlock, cursor: cursor, balances: balances,
          feesIn: feesIn.toString(), paidOut: paidOut.toString(),
        });
        var behind = Math.max(0, head - cursor + 1);
        log('chain', complete ? 'complete' : behind + ' blocks behind', 'in', calls, 'calls');

        // Nothing partial is published: a half-read history under-counts
        // holders and under-states every total.
        if (!complete) return null;

        var out = {};
        var holders = positive(countPositive(balances, exclude));
        if (holders !== null) out.holders = holders;
        if (wantFlows) {
          out.feesTokens = toTokens(feesIn, 18);
          // Not the whole outflow — that carries the protocol's cut.
          out.distributed = toTokens(paidOut, 18) * holderShare;
        }
        return Object.keys(out).length ? out : null;
      });
    });
  }

  var HOLDER_PROVIDERS = {

    /* The chain itself — the only source that is right by construction rather
       than by an indexer's luck, and the only one that moves in real time. */
    onchain: function (cfg) {
      return softly('chain:onchain', scanChain(cfg));
    },

    // Free, no key. Ships the field under different names across versions, and
    // on a fresh token it sometimes only appears on the counters route.
    blockscout: function (cfg) {
      var base = (cfg.blockscoutBase || 'https://base.blockscout.com').replace(/\/+$/, '');
      var token = base + '/api/v2/tokens/' + encodeURIComponent(address);
      return softly('holders:blockscout', fetchJson(token).then(function (d) {
        return positive(firstNumber(d, ['holders_count', 'holders']));
      })).then(function (n) {
        if (n) return n;
        return softly('holders:blockscout:counters', fetchJson(token + '/counters').then(function (d) {
          return positive(firstNumber(d, ['token_holders_count', 'holders_count', 'holders']));
        }));
      });
    },

    // GeckoTerminal's token info route. Free, no key, CORS-enabled. Reports a
    // holder count for tokens it has indexed; not every token has one.
    geckoterminal: function (cfg) {
      var base = (cfg.geckoterminalBase || 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');
      return softly('holders:geckoterminal',
        fetchJson(base + '/networks/' + (CFG.chain || 'base') + '/tokens/' +
          encodeURIComponent(address) + '/info').then(function (d) {
            return positive(firstNumber(d, [
              'data.attributes.holders.count',
              'data.attributes.holders',
              'data.attributes.holder_count',
            ]));
          }));
    },

    // Etherscan V2 multichain. The tokenholdercount action needs a paid plan.
    etherscan: function (cfg) {
      if (!cfg.etherscanApiKey) { log('holders:etherscan', 'skipped — no API key'); return Promise.resolve(null); }
      return softly('holders:etherscan', fetchJson('https://api.etherscan.io/v2/api?chainid=' +
        (CFG.chainId || 8453) + '&module=token&action=tokenholdercount&contractaddress=' +
        encodeURIComponent(address) + '&apikey=' + encodeURIComponent(cfg.etherscanApiKey)).then(function (d) {
          if (String(d && d.status) !== '1') throw new Error((d && (d.result || d.message)) || 'bad response');
          return positive(num(d.result));
        }));
    },

    // Moralis. Free tier, key required, sent as a header.
    moralis: function (cfg) {
      if (!cfg.moralisApiKey) { log('holders:moralis', 'skipped — no API key'); return Promise.resolve(null); }
      return softly('holders:moralis', fetchJson('https://deep-index.moralis.io/api/v2.2/erc20/' +
        encodeURIComponent(address) + '/holders?chain=' + (CFG.chain || 'base'),
        { 'X-API-Key': cfg.moralisApiKey }).then(function (d) {
          return positive(firstNumber(d, ['totalHolders', 'total_holders', 'total']));
        }));
    },
  };

  function sourceHolders() {
    var cfg = SRC.holders || {};
    if (cfg.enabled === false || cfg.mode === 'none' || !address) return Promise.resolve(null);

    var order = cfg.providers || ['blockscout', 'geckoterminal', 'etherscan', 'moralis'];

    // Sequential on purpose: stop at the first provider with a real answer
    // instead of hammering all four on every refresh.
    return order.reduce(function (chain, name) {
      return chain.then(function (found) {
        if (found) return found;
        var fn = HOLDER_PROVIDERS[name];
        if (!fn) { log('holders', 'unknown provider ' + name); return null; }
        return fn(cfg);
      });
    }, Promise.resolve(null)).then(function (found) {
      // `onchain` answers with holders AND the two flow totals; the explorer
      // providers answer with a bare count.
      if (!found) return null;
      return typeof found === 'number' ? { holders: found } : found;
    });
  }

  /* Project rewards API — fees collected, rewards distributed.
     Takes one URL or several; each is read through the same field map and the
     first to yield a number for a metric wins. */
  function sourceRewards() {
    var cfg = SRC.rewards || {};
    if (cfg.enabled === false || !cfg.url) return Promise.resolve(null);

    var urls = (typeof cfg.url === 'string' ? [cfg.url] : cfg.url) || [];

    return Promise.all(urls.map(function (url) {
      return softly('rewards:' + url, fetchJson(url).then(function (d) { return readRewards(cfg, d); }));
    })).then(function (parts) {
      var merged = null;
      parts.forEach(function (part) {
        if (!part) return;
        merged = merged || {};
        Object.keys(part).forEach(function (k) {
          if (merged[k] === undefined) merged[k] = part[k];   // first source wins
        });
      });
      return merged;
    });
  }

  function readRewards(cfg, d) {
    var fields = cfg.fields || {};
    var out = {};

    var map = {
      totalFeesCollected: 'fees',
      totalFeesTokens: 'feesTokens',
      totalDistributed: 'distributed',
      totalDistributedUsd: 'distributedUsd',
      holders: 'holders',
      marketCap: 'marketCap',
      liquidity: 'liquidity',
      volume24h: 'volume24h',
    };

    Object.keys(map).forEach(function (from) {
      var n = firstNumber(d, fields[from]);
      if (n !== null) out[map[from]] = n;
    });

    if (out.distributedUsd === undefined) {
      log('rewards', 'no USD figure for distributed — deriving from rewardTokenAddress price');
    }
    return out;
  }

  /* Price the reward token, to turn distributed tokens into USD. */
  /* What one reward token is worth, which is the only part of the two dollar
     figures that cannot come off the chain.

     The token's OWN pair is the fallback, not the first choice: a reward token
     that trades mainly as the quote side of this pool may not be the base of
     any pair DexScreener indexes, and then the search comes back empty. But
     this pool already prices it exactly — priceUsd is the token in dollars,
     priceNative the same token in the quote — so their ratio is the quote's
     dollar price, available whenever the pair itself resolves. */
  function sourceRewardPrice() {
    if (!CFG.rewardTokenAddress) return Promise.resolve(null);
    var pool = (SRC.dexscreener || {}).pairAddress || (CFG.contracts || {}).pool;

    return dexPair(address, pool).then(function (pair) {
      var usd = pair ? num(pair.priceUsd) : null;
      var native = pair ? num(pair.priceNative) : null;
      if (usd !== null && native !== null && native > 0) {
        var implied = usd / native;
        log('rewardPrice', 'from the pool:', usd, '/', native, '=', implied);
        return { _rewardPrice: implied };
      }
      return dexPair(CFG.rewardTokenAddress, (CFG.contracts || {}).rewardPool).then(function (own) {
        var price = own ? num(own.priceUsd) : null;
        return price === null ? null : { _rewardPrice: price };
      });
    });
  }

  /* ---------------------------------------------------------------------
     Values (with a count-up on change)
     --------------------------------------------------------------------- */

  var valueNodes = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-value]'), function (node) {
    valueNodes[node.dataset.value] = node;
  });

  var shown = {};
  var timers = {};
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setValue(key, target) {
    var node = valueNodes[key];
    if (!node) return;

    if (typeof target !== 'number' || !isFinite(target)) {
      node.textContent = '—';                       // no source for this one yet
      node.classList.add('is-empty');
      return;
    }
    node.classList.remove('is-empty');

    var fmt = FORMATTERS[key] || amount;
    var from = typeof shown[key] === 'number' ? shown[key] : 0;
    shown[key] = target;

    if (reduceMotion || from === target) {
      node.textContent = fmt(target);
      return;
    }

    cancelAnimationFrame(timers[key]);
    var start = performance.now();
    var dur = 900;

    (function step(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (target - from) * eased);
      if (p < 1) timers[key] = requestAnimationFrame(step);
    })(start);
  }

  var painted = false;
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-chip-for]'));

  function paint(stats) {
    painted = true;
    METRICS.forEach(function (key) { setValue(key, stats[key]); });
    // Each chip hides itself when the figure it exists to show is missing.
    chips.forEach(function (chip) {
      chip.hidden = typeof stats[chip.dataset.chipFor] !== 'number';
    });
  }

  /* ---------------------------------------------------------------------
     Load
     --------------------------------------------------------------------- */

  var note = document.getElementById('dash-note');
  var legendText = document.getElementById('legend-text');

  function clock(ms) {
    var d = new Date(ms || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* One line under the cards, saying where the figures came from and how
     current they are. `live` while something answered this load, `stale` while
     the tiles are showing what was last read. */
  function setLegend(state, text) {
    if (!note) return;
    note.className = 'legend is-' + state;
    if (legendText) legendText.textContent = text;
  }
  var lastStats = null;   // what the last load actually merged, for ?debug=1

  /* The last figures that were successfully read, kept per browser.

     A source that fails on this load — a rate-limited RPC, a phone that lost
     signal mid-scan — should not blank a tile that was showing a real number
     a minute ago. The remembered value stands in until something live
     replaces it, which it does at the first opportunity: these are seeded at
     a rank below every real source, so any answer at all outranks them. */
  var STATS_KEY = 'box:stats:' + String(address).toLowerCase();

  function readStats() {
    try {
      var raw = window.localStorage.getItem(STATS_KEY);
      var c = raw ? JSON.parse(raw) : null;
      return (c && c.values) ? c : null;
    } catch (e) { return null; }        // private mode, or a corrupt entry
  }

  function writeStats(stats) {
    var values = {};
    METRICS.forEach(function (k) {
      if (typeof stats[k] === 'number' && isFinite(stats[k])) values[k] = stats[k];
    });
    if (!Object.keys(values).length) return;
    try {
      window.localStorage.setItem(STATS_KEY, JSON.stringify({ at: Date.now(), values: values }));
    } catch (e) { /* quota, private mode */ }
  }

  function baseStats() {
    var s = CFG.stats || {};
    return {
      fees: num(s.totalFeesCollected),
      distributed: num(s.totalDistributed),
      distributedUsd: num(s.totalDistributedUsd),
      holders: num(s.holders),
      marketCap: num(s.marketCap),
      liquidity: num(s.liquidity),
      volume24h: num(s.volume24h),
    };
  }

  /* ?debug=1 — one line per source, so an empty tile is traceable to the
     request that produced it. "Failed to fetch" almost always means CORS or a
     blocked host; "HTTP 404" means the address or route is wrong; "ok, empty"
     means the request succeeded but the source has nothing for this token. */
  function renderDebug() {
    if (!DEBUG || !note) return;
    var box = document.getElementById('dash-debug');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'dash-debug';
      box.style.cssText = 'margin:14px auto 0;max-width:640px;padding:12px 14px;border:1px solid #e6ebf3;' +
        'border-radius:12px;background:#fbfcfe;color:#3d4655;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'text-align:left;white-space:pre-wrap;word-break:break-word;';
      note.parentNode.insertBefore(box, note.nextSibling);
    }
    var head = 'build ' + (CFG.version || 'unknown') +
      '  ·  ' + new Date().toLocaleTimeString() + '\n\n';

    var lines = sourceLog.map(function (s) {
      return (s.ok ? (s.empty ? '· empty  ' : '✓ ok     ') : '✗ failed ') +
        s.name + (s.ok ? '' : '  — ' + s.error);
    }).join('\n') || 'no sources ran';

    /* Then the merged result, metric by metric. A source can answer "ok" and
       still leave a card empty, so the panel has to show both ends. */
    var merged = METRICS.map(function (key) {
      var v = lastStats ? lastStats[key] : null;
      var shownAs = typeof v === 'number' && isFinite(v) ? (FORMATTERS[key] || amount)(v) : '—';
      return '  ' + (key + '                ').slice(0, 16) + shownAs;   // 'distributedUsd' is the longest
    }).join('\n');

    box.textContent = head + lines + '\n\nvalues\n' + merged;
  }

  /* Sources rank rather than queue. They used to be merged in array order at
     the end of one Promise.all, which meant nothing was painted until the
     slowest finished — and the holder scan can be tens of requests. On a
     phone that was a page of dashes for half a minute while the fees, read
     from a same-origin file in milliseconds, sat waiting behind it.

     So each source paints as it lands, and a rank keeps "later sources win"
     true regardless of arrival order: a value is only overwritten by a source
     at least as authoritative as the one already holding it. */
  var RANK = { remembered: -1, dexscreener: 0, rewards: 1, rewardPrice: 2, chain: 3 };

  function load() {
    sourceLog = [];

    var stats = baseStats();
    var owner = {};            // metric -> rank of the source that supplied it
    var rewardPrice = null;
    var live = 0;

    // Start from what was last read, so a failing source shows its previous
    // figure rather than an em dash. Anything live overwrites it immediately.
    var remembered = readStats();
    if (remembered) {
      Object.keys(remembered.values).forEach(function (k) {
        if (typeof stats[k] !== 'number') { stats[k] = remembered.values[k]; owner[k] = RANK.remembered; }
      });
      setLegend('stale', 'Last read ' + clock(remembered.at));
      paint(stats);
    }

    /* Both dollar figures, when a source gave the token amount but not its
       value. The scan can only ever report tokens — a price is not on chain. */
    function derive() {
      if (rewardPrice === null) return;
      if (typeof stats.distributed === 'number' && owner.distributedUsd === undefined) {
        stats.distributedUsd = stats.distributed * rewardPrice;
      }
      if (typeof stats.feesTokens === 'number' && owner.fees === undefined) {
        stats.fees = stats.feesTokens * rewardPrice;
      }
    }

    function absorb(rank, part) {
      if (part) {
        if (part._rewardPrice) {
          rewardPrice = part._rewardPrice;
        } else {
          var got = false;
          Object.keys(part).forEach(function (k) {
            var v = part[k];
            if (typeof v !== 'number' || !isFinite(v)) return;
            if (owner[k] !== undefined && owner[k] > rank) return;   // outranked
            stats[k] = v;
            owner[k] = rank;
            got = true;
          });
          if (got) live++;
        }
      }
      derive();
      lastStats = stats;
      writeStats(stats);
      paint(stats);
    }

    /* Rank, not order: data/rewards.json is a committed snapshot and goes
       stale between pushes, so a completed chain scan — the same arithmetic,
       read live — supersedes it. When no RPC answers, the snapshot is what
       remains, which is the right way round. */
    var jobs = [
      [RANK.dexscreener, sourceDexScreener()],
      [RANK.rewards, sourceRewards()],
      [RANK.rewardPrice, sourceRewardPrice()],
      [RANK.chain, sourceHolders()],
    ];

    jobs.forEach(function (job) {
      job[1].then(function (part) { absorb(job[0], part); });
    });

    return Promise.all(jobs.map(function (job) { return job[1]; })).then(function () {
      log('merged', stats);

      // Only worth saying something when the data ISN'T live — a timestamp on
      // a working dashboard is noise.
      if (live) setLegend('live', 'Live from Base · ' + clock(Date.now()));
      else if (remembered) setLegend('stale', 'Last read ' + clock(remembered.at) + ' · reconnecting');
      else setLegend('down', 'Live data unavailable · retrying');
      renderDebug();
    });
  }

  /* ---------------------------------------------------------------------
     Boot
     Tiles blink a "…" placeholder until the first load resolves. If the
     network is slow or dead, fall back rather than blinking forever.
     --------------------------------------------------------------------- */

  var fallbackTimer = setTimeout(function () {
    if (!painted) paint(baseStats());
  }, 6000);

  load()['catch'](function (e) { log('load failed', e && e.message); })
    .then(function () {
      clearTimeout(fallbackTimer);
      if (!painted) paint(baseStats());
    });

  var every = Number(CFG.refreshSeconds) || 0;
  if (every > 0) setInterval(function () { load()['catch'](function () {}); }, every * 1000);
})();
