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

  /* The reward token carries two decimals: a unit worth ~$258 is paid out in
     fractions, so whole numbers would erase the figure. */
  var nfTok = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // …with more places only where two would round a real amount away to 0.00.
  var nfTokFine = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

  /* Money and counts are whole — cents on a market cap are noise — but a sum
     under a dollar keeps them, since "$0" would report a real amount as none. */
  function usd(n) {
    if (n !== 0 && Math.abs(n) < 1) return '$' + nfTok.format(n);
    return '$' + nf0.format(Math.round(n));
  }

  function amount(n) {
    var two = nfTok.format(n);
    return (n !== 0 && Number(two.replace(/,/g, '')) === 0) ? nfTokFine.format(n) : two;
  }
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

  var poolPair = null;   // the pool's own pair, kept for pricing either side

  /* What one unit of `token` is worth, according to this pair.

     A pair prices its BASE token: priceUsd is the base in dollars, priceNative
     the base in units of the quote. Reading priceUsd for a token that is the
     QUOTE side reports the other token's price — which is how a correct $AMZN
     amount came to be multiplied by the price of $BOX. For the quote side the
     answer is the ratio: dollars per base ÷ quote per base = dollars per
     quote. */
  function priceFromPair(pair, token) {
    if (!pair || !token) return null;
    var want = String(token).toLowerCase();
    var base = pair.baseToken && String(pair.baseToken.address || '').toLowerCase();
    var quote = pair.quoteToken && String(pair.quoteToken.address || '').toLowerCase();
    var usd = num(pair.priceUsd);
    var native = num(pair.priceNative);

    if (base === want) return usd !== null && usd > 0 ? usd : null;
    if (quote === want && usd !== null && native !== null && native > 0 && usd > 0) return usd / native;

    /* A pair that names neither side is not evidence about this token. Older
       responses omit the token objects entirely; rather than guess, say so. */
    if (!base && !quote) { log('price', 'pair does not name its tokens — cannot price', token); return null; }
    return null;
  }

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
      poolPair = pair;               // reused for pricing the reward token
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
  var CACHE_VERSION = 2;    // bump when the cached shape changes

  function readCache(startBlock) {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      var c = raw ? JSON.parse(raw) : null;
      // A cache from a different start block describes a different history,
      // and one from an older shape would hand a string where the flow totals
      // are now a map of token -> amount. Either way: rescan.
      if (c && c.v === CACHE_VERSION && c.startBlock === startBlock && c.balances) return c;
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

  /* Sum by the token that emitted each log. The distributor may see more than
     one token — a stray airdrop, a wrapped leg — so they are kept apart and
     the dominant one is picked at the end rather than added together. */
  function sumByToken(into, logs) {
    for (var i = 0; i < (logs || []).length; i++) {
      var d = logs[i].data;
      if (!d || d === '0x') continue;
      var token = String(logs[i].address || '').toLowerCase();
      into[token] = (BigInt(into[token] || '0') + BigInt(d)).toString();
    }
    return into;
  }

  /* ERC-20 metadata, read straight off the token. Two eth_calls, no ABI
     needed beyond the selectors, so this works on unverified contracts. */
  var SEL_SYMBOL = '0x95d89b41';
  var SEL_DECIMALS = '0x313ce567';

  function decodeString(hex) {
    if (!hex || hex === '0x') return '';
    var body = hex.slice(2);
    var bytes = [];
    // A well-behaved token returns an ABI string: offset, length, then data.
    // An old one returns a bare bytes32. Both decode as "the printable run".
    for (var i = 0; i < body.length; i += 2) {
      var c = parseInt(body.substr(i, 2), 16);
      if (c >= 32 && c < 127) bytes.push(String.fromCharCode(c));
    }
    return bytes.join('').trim();
  }

  function tokenMeta(url, token) {
    return Promise.all([
      rpcCall(url, 'eth_call', [{ to: token, data: SEL_SYMBOL }, 'latest']).then(decodeString, function () { return ''; }),
      rpcCall(url, 'eth_call', [{ to: token, data: SEL_DECIMALS }, 'latest']).then(
        function (h) { var d = parseInt(h, 16); return isFinite(d) && d >= 0 && d <= 36 ? d : 18; },
        function () { return 18; }
      ),
    ]).then(function (r) { return { address: token, symbol: r[0], decimals: r[1] }; });
  }

  /* Which of the tokens that touched the distributor is the reward token.

     NOT the one with the largest raw total, which is what this used to do and
     what put 7,205,199 on a tile whose true figure was a fraction of one:
     base units are not comparable across tokens, and a distributor sees the
     trading token's large flows beside the reward token's small ones. The
     reward token is the one that says it is — matched on the symbol the page
     is built around — with configuration and then size as fallbacks. */
  function pickRewardToken(metas, totals, configured) {
    var want = String(CFG.rewardTokenSymbol || 'AMZN').toLowerCase();

    var bySymbol = metas.filter(function (m) {
      return m.symbol && m.symbol.toLowerCase().indexOf(want) !== -1;
    });
    if (bySymbol.length === 1) return bySymbol[0];
    if (bySymbol.length > 1) {
      // More than one match: the largest of those, now that decimals are known.
      return bySymbol.sort(function (a, b) {
        return toTokens(BigInt(totals[b.address] || '0'), b.decimals) -
               toTokens(BigInt(totals[a.address] || '0'), a.decimals);
      })[0];
    }

    var cfg = configured && metas.filter(function (m) { return m.address === String(configured).toLowerCase(); })[0];
    if (cfg) return cfg;

    return metas.slice().sort(function (a, b) {
      return toTokens(BigInt(totals[b.address] || '0'), b.decimals) -
             toTokens(BigInt(totals[a.address] || '0'), a.decimals);
    })[0] || null;
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
      var feesIn = cache.feesIn || {};      // token -> base units, as strings
      var paidOut = cache.paidOut || {};
      var calls = 0;

      /* Which filter shape the node will accept for the flow queries, decided
         once by probe rather than assumed. Topic-only is the right question —
         it finds the reward token instead of asserting one — but plenty of
         public nodes refuse eth_getLogs without an `address`, so each named
         candidate is a fallback. */
      var strategies = [{ id: 'any token', address: null }];
      [reward].concat(oc.feeTokenCandidates || []).forEach(function (a) {
        if (a) strategies.push({ id: String(a).toLowerCase(), address: a });
      });
      var strategy = null;
      var flowNote = '';

      function flowFilter(strat, party, range) {
        var f = {
          topics: party === 'to'
            ? [TRANSFER_TOPIC, null, addressTopic(index)]
            : [TRANSFER_TOPIC, addressTopic(index)],   // trailing null dropped: some nodes reject it
          fromBlock: range.fromBlock, toBlock: range.toBlock,
        };
        if (strat.address) f.address = strat.address;
        return f;
      }

      /* One narrow window, tried against each shape until a node answers
         without complaining. Two calls at worst per candidate, once per load. */
      function pickStrategy() {
        if (!wantFlows) return Promise.resolve(null);
        var probeFrom = Math.max(startBlock, head - 1000);
        var range = { fromBlock: '0x' + probeFrom.toString(16), toBlock: '0x' + head.toString(16) };

        return strategies.reduce(function (chain, strat) {
          return chain.then(function (found) {
            if (found) return found;
            calls++;
            return rpcCall(node.url, 'eth_getLogs', [flowFilter(strat, 'to', range)]).then(
              function () { log('chain', 'flow filter accepted:', strat.id); return strat; },
              function (e) {
                log('chain', 'flow filter rejected (' + strat.id + '):', e.message);
                flowNote = e.message;
                return null;
              }
            );
          });
        }, Promise.resolve(null));
      }

      function window_(from, to) {
        var range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };

        // The holder scan is the one that must succeed; its failure is the
        // scan's failure.
        var holderAsk = rpcCall(node.url, 'eth_getLogs', [{
          address: address, topics: [TRANSFER_TOPIC],
          fromBlock: range.fromBlock, toBlock: range.toBlock,
        }]);
        calls++;

        if (!strategy) return holderAsk.then(function (logs) { return [logs, null, null]; });

        /* The flow queries are best-effort. They used to share a Promise.all
           with the holder query, so one node complaining about one filter took
           down the whole scan — and with it the holder count, which had
           nothing to do with the complaint. */
        var soft = function (filter) {
          calls++;
          return rpcCall(node.url, 'eth_getLogs', [filter]).then(null, function (e) {
            flowNote = e.message;
            strategy = null;              // stop paying for a filter this node refuses
            log('chain', 'flow query failed, dropping flows:', e.message);
            return null;
          });
        };

        return Promise.all([
          holderAsk,
          soft(flowFilter(strategy, 'to', range)),
          soft(flowFilter(strategy, 'from', range)),
        ]);
      }

      function step() {
        if (cursor > head) return Promise.resolve(true);
        if (calls >= budget) return Promise.resolve(false);

        var end = Math.min(cursor + span - 1, head);
        return window_(cursor, end).then(function (res) {
          foldTransfers(balances, res[0] || []);
          if (res[1]) sumByToken(feesIn, res[1]);
          if (res[2]) sumByToken(paidOut, res[2]);
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

      return pickStrategy().then(function (chosen) {
        strategy = chosen;
        if (wantFlows && !chosen) log('chain', 'no flow filter accepted — holders only');
        return step();
      }).then(function (complete) {
        writeCache({
          v: CACHE_VERSION, startBlock: startBlock, cursor: cursor,
          balances: balances, feesIn: feesIn, paidOut: paidOut,
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
          // Every token that touched the distributor, in or out.
          var seen = {};
          Object.keys(feesIn).concat(Object.keys(paidOut)).forEach(function (t) { seen[t] = true; });
          var tokens = Object.keys(seen);
          if (!tokens.length) return finish(null, null);

          calls += tokens.length * 2;
          return Promise.all(tokens.map(function (t) { return tokenMeta(node.url, t); }))
            .then(function (metas) {
              log('chain', 'tokens at the distributor:', metas.map(function (m) {
                return m.symbol + ' (' + m.decimals + 'dp) ' + m.address;
              }).join(', '));
              return finish(pickRewardToken(metas, feesIn, reward), metas);
            }, function () { return finish(null, null); });
        }
        return finish(null, null);

        function finish(meta, metas) {
          if (meta) {
            var token = meta.address;
            out._rewardToken = token;
            out._rewardSymbol = meta.symbol;
            // Decimals from the token, not assumed: an 18 that is really a 6
            // is a millionfold error, silently.
            out.feesTokens = toTokens(BigInt(feesIn[token] || '0'), meta.decimals);
            // Not the whole outflow — that carries the protocol's cut.
            out.distributed = toTokens(BigInt(paidOut[token] || '0'), meta.decimals) * holderShare;
            log('chain', 'reward token', meta.symbol, token, meta.decimals + 'dp',
                '| in', out.feesTokens, '| to holders', out.distributed);
            if (String(reward).toLowerCase() !== token) {
              log('chain', 'NOTE: config rewardTokenAddress is', reward, 'but the chain says', token);
              /* Price the token that actually moved. Without this the dollar
                 figures wait on a config change, and the tiles carry a token
                 amount nobody can size. */
              /* Price the token that actually moved, through every source. */
              return priceForToken(token).then(function (p) {
                if (p !== null) { out._rewardPrice = p; out._priceToken = token; }
                else log('chain', 'nothing prices', token, '— dollar figures withheld');
                return out;
              }, function () { return out; });
            }
          } else {
            /* Nothing reached the distributor, or no filter was accepted.
               Either way that is silence, not a zero, and a zero on the tile
               would be a confident wrong answer — so it is left unset and the
               previous figure or a dash stands. */
            out._flowNote = strategy
              ? 'no transfers found in or out of ' + index
              : ('no flow filter this node accepts' + (flowNote ? ' — ' + flowNote : ''));
            log('chain', out._flowNote);
          }
          return Object.keys(out).length ? out : null;
        }
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
  /* What one unit of `token` is worth, asked of everything that might know.

     Three sources, because two were not enough: a reward token that is an
     index rather than a traded pair can be absent from DexScreener entirely,
     and then the dollar figures vanish while the token amounts are perfectly
     right — which is exactly what happened.

       1. this pool, which prices either of its own sides exactly
       2. the token's own deepest pair, if it has one
       3. GeckoTerminal's price endpoint, which covers tokens DexScreener
          does not index

     A zero is never a price: it means "no answer" and is treated as one, so a
     tile shows its token amount or a dash rather than $0. */
  function priceForToken(token) {
    if (!token) return Promise.resolve(null);
    var want = String(token).toLowerCase();
    var pool = (SRC.dexscreener || {}).pairAddress || (CFG.contracts || {}).pool;

    function good(p, where) {
      if (typeof p !== 'number' || !isFinite(p) || p <= 0) return null;
      log('price', want, '=', p, 'via', where);
      return p;
    }

    return dexPair(address, pool).then(function (pair) {
      poolPair = pair || poolPair;
      var p = good(priceFromPair(pair, want), 'the pool');
      if (p !== null) return p;

      return dexByToken(want).then(function (own) {
        var q = good(priceFromPair(own, want), 'its own pair');
        if (q !== null) return q;
        return geckoPrice(want);
      }, function () { return geckoPrice(want); });
    }, function () { return geckoPrice(want); });

    function geckoPrice(addr) {
      var base = (CFG.geckoterminalBase || 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');
      var url = base + '/simple/networks/' + (CFG.chain || 'base') + '/token_price/' + encodeURIComponent(addr);
      return softly('price:geckoterminal', fetchJson(url).then(function (d) {
        var prices = d && d.data && d.data.attributes && d.data.attributes.token_prices;
        var raw = prices && (prices[addr] || prices[String(addr).toLowerCase()]);
        return good(num(raw), 'GeckoTerminal');
      })).then(function (v) { return v === undefined ? null : v; });
    }
  }

  function sourceRewardPrice() {
    var token = CFG.rewardTokenAddress;
    if (!token) return Promise.resolve(null);
    return priceForToken(token).then(function (p) {
      return p === null ? null : { _rewardPrice: p, _priceToken: String(token).toLowerCase() };
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
  var feesAsTokens = false;     // the fees tile is showing tokens, not dollars
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

    var fmt = (key === 'fees' && feesAsTokens) ? amount : (FORMATTERS[key] || amount);
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
  var units = Array.prototype.slice.call(document.querySelectorAll('[data-unit-for]'));

  function paint(stats) {
    painted = true;

    /* The fees tile is a dollar figure when the reward token can be priced.
       When it cannot — an index token need not trade anywhere — it shows what
       is actually known, the token amount, rather than a dash beside a
       payout tile that has one. */
    var feesInTokens = typeof stats.fees !== 'number' && typeof stats.feesTokens === 'number';
    feesAsTokens = feesInTokens;
    if (feesInTokens) stats = Object.assign({}, stats, { fees: stats.feesTokens });

    METRICS.forEach(function (key) { setValue(key, stats[key]); });
    units.forEach(function (u) {
      u.hidden = !(u.dataset.unitFor === 'fees' && feesInTokens);
    });
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

  /* Which build is actually running. Small, but it turns "did the deploy
     land?" from a guess into something the page answers. */
  function build() { return CFG.version ? '  ·  b' + CFG.version : ''; }

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
  /* Versioned, and bumped whenever a build shipped a figure that was wrong
     rather than merely stale — those get remembered too, and a remembered
     wrong number outlives the bug that made it. v2 dropped the zeros; v3
     drops the 7,205,199 that came of picking the loudest token. */
  var STATS_KEY = 'box:stats:v3:' + String(address).toLowerCase();

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
    var token = lastStats && lastStats._rewardToken;
    var flowNote = lastStats && lastStats._flowNote;
    var symbol = (lastStats && lastStats._rewardSymbol) || '';
    var tokenLine = flowNote ? '\n\nfees/distributed\n  ' + flowNote : token
      ? '\n\nfees are paid in\n  ' + (symbol ? symbol + '  ' : '') + token +
        (CFG.rewardTokenAddress && token !== String(CFG.rewardTokenAddress).toLowerCase()
          ? '\n  config says ' + CFG.rewardTokenAddress + '  <- MISMATCH' : '  (matches config)')
      : '';

    var merged = METRICS.map(function (key) {
      var v = lastStats ? lastStats[key] : null;
      var shownAs = typeof v === 'number' && isFinite(v) ? (FORMATTERS[key] || amount)(v) : '—';
      return '  ' + (key + '                ').slice(0, 16) + shownAs;   // 'distributedUsd' is the longest
    }).join('\n');

    box.textContent = head + lines + tokenLine + '\n\nvalues\n' + merged;
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
    var detectedToken = null;   // what the chain says the fees are paid in
    var priceToken = null;      // which token the price in hand belongs to
    var live = 0;

    // Start from what was last read, so a failing source shows its previous
    // figure rather than an em dash. Anything live overwrites it immediately.
    var remembered = readStats();
    if (remembered) {
      Object.keys(remembered.values).forEach(function (k) {
        if (typeof stats[k] !== 'number') { stats[k] = remembered.values[k]; owner[k] = RANK.remembered; }
      });
      setLegend('stale', 'Last read ' + clock(remembered.at) + build());
      paint(stats);
    }

    /* Both dollar figures, when a source gave the token amount but not its
       value. The scan can only ever report tokens — a price is not on chain. */
    function derive() {
      if (rewardPrice === null) return;
      /* Only a price for the very token the figures are denominated in will
         do. The pool's ratio prices the pair's quote, so if the chain says the
         fees arrive in something else, that ratio is the wrong number — and a
         wrong dollar figure is worse than none. */
      var want = detectedToken || (CFG.rewardTokenAddress ? String(CFG.rewardTokenAddress).toLowerCase() : null);
      if (want && priceToken && priceToken !== want) return;
      if (typeof stats.distributed === 'number' && owner.distributedUsd === undefined) {
        stats.distributedUsd = stats.distributed * rewardPrice;
      }
      if (typeof stats.feesTokens === 'number' && owner.fees === undefined) {
        stats.fees = stats.feesTokens * rewardPrice;
      }
    }

    function absorb(rank, part) {
      if (part) {
        if (part._rewardToken) {
          detectedToken = part._rewardToken;
          stats._rewardToken = part._rewardToken;
          stats._rewardSymbol = part._rewardSymbol;
        }
        if (part._flowNote) stats._flowNote = part._flowNote;
        if (part._rewardPrice) {
          rewardPrice = part._rewardPrice;
          priceToken = part._priceToken || null;
        }
        if (!part._rewardPrice || part.feesTokens !== undefined) {
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
      if (live) setLegend('live', 'Live from Base · ' + clock(Date.now()) + build());
      else if (remembered) setLegend('stale', 'Last read ' + clock(remembered.at) + ' · reconnecting' + build());
      else setLegend('down', 'Live data unavailable · retrying' + build());
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
