#!/usr/bin/env node
/* ==========================================================================
   probe.mjs — everything the dashboard needs to know, asked of the real
   network and printed.

   The site's figures depend on facts nobody has been able to confirm from a
   sandbox with no outbound network: which token the fees are actually paid
   in, what it calls itself, how many decimals it has, and whether anything
   public will price it. This asks, and prints the answers.

   Run anywhere with network — locally, or via .github/workflows/probe.yml:

     RPC_URL=https://mainnet.base.org node scripts/probe.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* config.js is browser code — a window.SITE_CONFIG assignment — so it is read
   rather than imported, to keep this dependency-free. */
function siteConfig() {
  const src = readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window.SITE_CONFIG || {};
}

const CFG = siteConfig();
const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const START_BLOCK = Number(process.env.START_BLOCK || CFG.launchBlock || 0);
const CHUNK = Number(process.env.CHUNK_SIZE || 10000);
const CHAIN = CFG.chain || 'base';

const TOKEN = CFG.contractAddress;
const INDEX = (CFG.contracts || {}).rewardsIndex;
const POOL = (CFG.contracts || {}).pool;

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const asTopic = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().replace(/^0x/, '');

/* The same endpoints the page uses, for the same reason: a single public RPC
   has bad minutes. Without this the probe reported "no backend is currently
   healthy" and failed the build — a red run that says nothing about the site,
   which is its own kind of false alarm. */
const ENDPOINTS = [RPC_URL, ...(CFG.sources?.holders?.onchain?.rpcUrls || [])]
  .filter((u, i, a) => u && a.indexOf(u) === i);

const TRANSIENT = /HTTP (408|429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|socket|healthy|timeout/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcCalls = 0;
let endpoint = 0;

async function rpc(method, params = []) {
  let lastErr;
  for (let node = 0; node < ENDPOINTS.length; node++) {
    const url = ENDPOINTS[(endpoint + node) % ENDPOINTS.length];
    for (let attempt = 0; attempt < 3; attempt++) {
      rpcCalls++;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcCalls, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(j.error.message);
        endpoint = (endpoint + node) % ENDPOINTS.length;   // stay where it worked
        return j.result;
      } catch (err) {
        lastErr = err;
        /* A refusal about the REQUEST — a range too wide, a filter a node
           dislikes — must reach the caller, which knows how to shrink it.
           Only a refusal about the SERVER is worth waiting or moving for. */
        if (!TRANSIENT.test(err.message || '')) throw err;
        await sleep(400 * Math.pow(3, attempt));
      }
    }
  }
  throw lastErr;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---- 1. what moves in and out of the distributor ---------------------- */

async function flows(party, address, from, to) {
  const topics = party === 'to'
    ? [TRANSFER, null, asTopic(address)]
    : [TRANSFER, asTopic(address)];

  const totals = new Map();
  let cursor = from;
  let span = CHUNK;

  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    let logs;
    try {
      logs = await rpc('eth_getLogs', [{
        topics, fromBlock: '0x' + cursor.toString(16), toBlock: '0x' + end.toString(16),
      }]);
    } catch (err) {
      /* Narrow for anything that is not plainly about the node. Base's public
         RPC has started answering HTTP 413 for a window whose logs are too
         large to serialise — no message, nothing matching "too large" — and
         this test used to require the words, so the probe threw and failed
         the build for a reason that had nothing to do with the site. Third
         time this exact gap has bitten: app.js and worker/src/indexer.js both
         had it. */
      const aboutTheNode = /HTTP (40[1-5])|fetch failed|ECONN|ETIMEDOUT|unauthorized|forbidden|not supported/i
        .test(err.message || '');
      if (!aboutTheNode && span > 100) { span = Math.floor(span / 2); continue; }
      throw err;
    }
    for (const l of logs) {
      const t = String(l.address).toLowerCase();
      const v = (!l.data || l.data === '0x') ? 0n : BigInt(l.data);
      const e = totals.get(t) || { total: 0n, count: 0 };
      e.total += v; e.count++;
      totals.set(t, e);
    }
    cursor = end + 1;
  }
  return totals;
}

/* ---- 2. what each token says it is ------------------------------------ */

const printable = (hex) => {
  if (!hex || hex === '0x') return '';
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const c = parseInt(hex.substr(i, 2), 16);
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
  }
  return out.trim();
};

async function meta(token) {
  /* name() as well as symbol(). A ticker invites a guess about what the thing
     IS — "AMZNc" reads as tokenized Amazon stock whether or not it is backed
     by any — and that guess is exactly what a listing form should not be fed.
     The full name is the token's own account of itself. */
  /* Each failure carries its reason. The fallbacks used to be silent — a
     throttled call printed decimals() 18, indistinguishable from a token that
     really has 18, in output whose whole purpose is to be quoted as fact.
     A default that cannot be told from a reading is worse than no reading. */
  const ask = (data, decode) => rpc('eth_call', [{ to: token, data }, 'latest'])
    .then(decode, (e) => ({ failed: e.message }));

  const [symbol, name, decimals, supply] = await Promise.all([
    ask('0x95d89b41', printable),
    ask('0x06fdde03', printable),
    ask('0x313ce567', (h) => parseInt(h, 16)),
    ask('0x18160ddd', (h) => BigInt(h)),
  ]);
  const show = (v) => (v && v.failed ? `<unread: ${v.failed}>` : v);
  return {
    symbol: show(symbol), name: show(name),
    decimals: Number.isFinite(decimals) ? decimals : 18,
    decimalsRead: Number.isFinite(decimals),
    supply: typeof supply === 'bigint' ? supply : null,
  };
}

/* ---- 3. whether anything will price it -------------------------------- */

const DEX = 'https://api.dexscreener.com/latest/dex/';
const GECKO = (CFG.geckoterminalBase || 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');

function priceFromPair(pair, token) {
  const want = String(token).toLowerCase();
  const base = pair?.baseToken?.address?.toLowerCase();
  const quote = pair?.quoteToken?.address?.toLowerCase();
  const usd = parseFloat(pair?.priceUsd);
  const native = parseFloat(pair?.priceNative);
  if (base === want && usd > 0) return { price: usd, how: 'base side of ' + pair.pairAddress };
  if (quote === want && usd > 0 && native > 0) return { price: usd / native, how: 'quote side of ' + pair.pairAddress };
  return null;
}

async function priceReport(token) {
  const lines = [];

  try {
    const d = await getJson(DEX + 'pairs/' + CHAIN + '/' + POOL);
    const pair = d?.pair || d?.pairs?.[0];
    if (pair) {
      lines.push(`    pool venue: dexId=${pair.dexId} labels=${JSON.stringify(pair.labels || [])} pairAddress=${pair.pairAddress}`);
      lines.push(`    pool pair: base ${pair.baseToken?.symbol} ${pair.baseToken?.address}`);
      lines.push(`               quote ${pair.quoteToken?.symbol} ${pair.quoteToken?.address}`);
      lines.push(`               priceUsd ${pair.priceUsd}  priceNative ${pair.priceNative}`);
      const p = priceFromPair(pair, token);
      lines.push(p ? `    -> $${p.price} from the ${p.how}` : '    -> the pool does not name this token');
    } else lines.push('    pool pair: none returned');
  } catch (e) { lines.push(`    pool pair: FAILED ${e.message}`); }

  try {
    const d = await getJson(DEX + 'tokens/' + token);
    const pairs = (d?.pairs || []).filter((p) => p.chainId === CHAIN);
    lines.push(`    dexscreener token search: ${pairs.length} pair(s) on ${CHAIN}`);
    for (const pair of pairs.slice(0, 3)) {
      const p = priceFromPair(pair, token);
      lines.push(`      ${pair.baseToken?.symbol}/${pair.quoteToken?.symbol} liq $${pair.liquidity?.usd ?? '?'}` +
                 (p ? ` -> $${p.price}` : ' -> cannot price from this pair'));
    }
  } catch (e) { lines.push(`    dexscreener token search: FAILED ${e.message}`); }

  try {
    const d = await getJson(`${GECKO}/simple/networks/${CHAIN}/token_price/${token}`);
    const prices = d?.data?.attributes?.token_prices || {};
    const raw = prices[token] ?? prices[String(token).toLowerCase()];
    lines.push(`    geckoterminal: ${raw === undefined ? 'no price' : '$' + raw}`);
  } catch (e) { lines.push(`    geckoterminal: FAILED ${e.message}`); }

  return lines;
}

/* ---- report ------------------------------------------------------------ */

const asTokens = (v, dp) => {
  const base = 10n ** BigInt(dp);
  return (Number(v / base) + Number(v % base) / Number(base));
};

async function main() {
  const head = parseInt(await rpc('eth_blockNumber'), 16) - 5;
  console.log('=== probe ===============================================');
  console.log(`rpc          ${RPC_URL}`);
  console.log(`token        ${TOKEN}`);
  console.log(`rewardsIndex ${INDEX}`);
  console.log(`pool         ${POOL}`);
  console.log(`blocks       ${START_BLOCK} … ${head}  (${head - START_BLOCK + 1})`);
  console.log('');

  const [into, outOf] = [await flows('to', INDEX, START_BLOCK, head), await flows('from', INDEX, START_BLOCK, head)];
  const tokens = [...new Set([...into.keys(), ...outOf.keys()])];

  if (!tokens.length) {
    console.log('NOTHING moves in or out of the rewards index as an ERC-20 transfer.');
    console.log('The payouts are not plain transfers to that address, and no log filter');
    console.log('will ever find them — the distributor\'s own view functions are the');
    console.log('only remaining route.');
    return;
  }

  for (const t of tokens) {
    const m = await meta(t);
    const inAmt = into.get(t)?.total ?? 0n;
    const outAmt = outOf.get(t)?.total ?? 0n;
    console.log(`token ${m.symbol}  ${t}  (${m.decimals} decimals)`);
    console.log(`    name() "${m.name}"`);
    if (m.supply !== null) console.log(`    totalSupply ${asTokens(m.supply, m.decimals)}`);
    console.log(`    in  ${asTokens(inAmt, m.decimals)}   (${into.get(t)?.count ?? 0} transfers)`);
    console.log(`    out ${asTokens(outAmt, m.decimals)}   (${outOf.get(t)?.count ?? 0} transfers)`);
    console.log(`    x holderShare ${CFG.holderShare}: ${asTokens(outAmt, m.decimals) * Number(CFG.holderShare)}`);
    for (const line of await priceReport(t)) console.log(line);
    console.log('');
  }

  /* A summary, last, of the two tokens anyone actually asks about. The loop
     above reports every token that touched the distributor — which now
     includes spam airdropped at it — so the answers worth quoting need a
     fixed place to be, not a position in a list that grows. */
  console.log('--- summary ---------------------------------------------');
  for (const [label, addr] of [['token', TOKEN], ['reward', CFG.rewardTokenAddress]]) {
    if (!addr) continue;
    const m = await meta(addr);
    console.log(`${label}   ${addr}`);
    console.log(`         symbol() "${m.symbol}"   name() "${m.name}"   ` +
                `decimals() ${m.decimalsRead ? m.decimals : '<unread, assuming 18>'}`);
    if (m.supply !== null) console.log(`         totalSupply ${asTokens(m.supply, m.decimals)}`);
  }
  try {
    const d = await getJson(DEX + 'pairs/' + CHAIN + '/' + POOL);
    const pair = d?.pair || d?.pairs?.[0];
    if (pair) {
      console.log(`venue    ${pair.dexId} ${JSON.stringify(pair.labels || [])}  pool ${pair.pairAddress}`);
      console.log(`         ${pair.baseToken?.symbol}/${pair.quoteToken?.symbol}  priceUsd ${pair.priceUsd}  liq $${pair.liquidity?.usd ?? '?'}`);
    }
  } catch (e) { console.log(`venue    FAILED ${e.message}`); }

  console.log(`${rpcCalls} RPC calls`);
  console.log('=========================================================');
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
