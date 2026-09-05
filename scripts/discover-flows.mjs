#!/usr/bin/env node
/* ==========================================================================
   discover-flows.mjs — what actually moves in and out of the contracts?

   Written because two rounds of guessing which token the fees are paid in
   produced, in turn, a confident zero and then nothing at all. This asks the
   chain instead: for the rewards index, the fee locker and the pool, it lists
   EVERY ERC-20 that has moved in or out, with totals and counts.

   Whatever it prints is the truth about where the numbers live. If it prints
   nothing for the rewards index, then the payouts are not plain transfers to
   that address, and no amount of filtering will find them — which is itself
   the answer, and points at reading the distributor's own view functions.

     RPC_URL=https://mainnet.base.org node scripts/discover-flows.mjs

   Optional: START_BLOCK, CHUNK_SIZE, ADDRESSES (comma-separated, to look at
   something other than the three from config.js).
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* config.js is browser code — a window.SITE_CONFIG assignment — so it is read
   rather than imported, to keep this script dependency-free. */
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

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const asTopic = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().replace(/^0x/, '');

const WATCH = process.env.ADDRESSES
  ? process.env.ADDRESSES.split(',').map((a) => ({ label: 'given', address: a.trim() }))
  : [
      { label: 'rewardsIndex', address: (CFG.contracts || {}).rewardsIndex },
      { label: 'feeLocker', address: (CFG.contracts || {}).feeLocker },
      { label: 'pool', address: (CFG.contracts || {}).pool },
    ].filter((w) => w.address);

let calls = 0;
async function rpc(method, params = []) {
  calls++;
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/* Topic-only, so the logs report their own token. A node that refuses an
   unfiltered getLogs says so here rather than silently returning nothing —
   which is exactly the failure this script exists to make visible. */
async function scan(topics, from, to) {
  const found = new Map();     // token -> { total, count }
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
      if (/too large|range|limit|exceed|more than/i.test(err.message) && span > 500) {
        span = Math.floor(span / 2);
        continue;
      }
      throw err;
    }
    for (const l of logs) {
      const token = String(l.address).toLowerCase();
      const value = (!l.data || l.data === '0x') ? 0n : BigInt(l.data);
      const e = found.get(token) || { total: 0n, count: 0 };
      e.total += value; e.count++;
      found.set(token, e);
    }
    cursor = end + 1;
    process.stderr.write(`\r  scanned to ${cursor} (${to - cursor + 1} to go)   `);
  }
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  return found;
}

const asTokens = (v) => {
  const base = 10n ** 18n;
  return (Number(v / base) + Number(v % base) / Number(base)).toLocaleString('en-US', { maximumFractionDigits: 6 });
};

function report(title, found) {
  if (!found.size) { console.log(`  ${title}: nothing`); return; }
  console.log(`  ${title}:`);
  for (const [token, e] of [...found].sort((a, b) => (b[1].total > a[1].total ? 1 : -1))) {
    console.log(`    ${token}  ${asTokens(e.total).padStart(18)}  (${e.count} transfers, assuming 18 decimals)`);
  }
}

async function main() {
  const head = parseInt(await rpc('eth_blockNumber'), 16) - 5;
  console.log(`RPC ${RPC_URL}`);
  console.log(`blocks ${START_BLOCK} … ${head}  (${head - START_BLOCK + 1})\n`);

  for (const w of WATCH) {
    console.log(`${w.label}  ${w.address}`);
    try {
      report('received', await scan([TRANSFER, null, asTopic(w.address)], START_BLOCK, head));
      report('sent', await scan([TRANSFER, asTopic(w.address)], START_BLOCK, head));
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      console.log('  (a node that refuses an unfiltered getLogs cannot answer this — try another RPC_URL)');
    }
    console.log('');
  }
  console.log(`${calls} RPC calls\n`);
  console.log('The token with the largest inflow to rewardsIndex is what the fee and');
  console.log('payout figures are denominated in. Put it in config.js as');
  console.log('rewardTokenAddress and the page stops having to discover it.');
}

main().catch((e) => { console.error('\nfailed:', e.message); process.exit(1); });
