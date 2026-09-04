#!/usr/bin/env node
/* ==========================================================================
   token-stats.mjs — holders, fees collected and rewards distributed, computed
   from nothing but Base RPC transfer logs.

   A SECOND, INDEPENDENT implementation of what worker/src/indexer.js does. It
   deliberately shares no maths with it: agreeing totals are then evidence,
   where a shared helper would only prove both copies of one bug. The
   addresses, though, are imported rather than retyped — those must not drift.

   Adapted from juanantin/circle's tokenstats.mjs, which is where the
   technique and both of its traps were first written down.

   Run it, read the three numbers, and reconcile them against the token's own
   page before any of them is committed:

     RPC_URL=https://mainnet.base.org node scripts/token-stats.mjs

   Every value can be overridden from the environment — TOKEN, REWARD_TOKEN,
   REWARDS_INDEX, START_BLOCK, EXCLUDE, HOLDER_SHARE, CHUNK_SIZE — which is
   how you test a hypothesis without touching the config.
   ========================================================================== */

import {
  TOKENS, CONTRACTS, START_BLOCK as CONFIG_START_BLOCK,
  EXCLUDE_FROM_HOLDERS, HOLDER_SHARE as CONFIG_HOLDER_SHARE, PROTOCOL_ADDRESS,
} from '../worker/src/config.js';

const RPC_URL       = process.env.RPC_URL       || 'https://mainnet.base.org';
const TOKEN         = process.env.TOKEN         || TOKENS.STR;
const REWARD_TOKEN  = process.env.REWARD_TOKEN  || TOKENS.KEX;
const REWARDS_INDEX = process.env.REWARDS_INDEX || CONTRACTS.rewardsIndex;
const START_BLOCK   = Number(process.env.START_BLOCK || CONFIG_START_BLOCK);
const HOLDER_SHARE  = Number(process.env.HOLDER_SHARE || CONFIG_HOLDER_SHARE);
const EXCLUDE = (process.env.EXCLUDE
  ? process.env.EXCLUDE.split(',').map((s) => s.trim())
  : EXCLUDE_FROM_HOLDERS).map((s) => s.toLowerCase()).filter(Boolean);

const CHUNK = Number(process.env.CHUNK_SIZE || 2000);
const CONFIRMATIONS = 5;
const DECIMALS = 18n;

/* keccak256("Transfer(address,address,uint256)"). Every ERC-20 emits this as
   topic0, so filtering on it needs no ABI and no contract knowledge. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

/* An indexed address parameter is a 32-byte topic: 24 zeros, then the
   20 bytes. That padding is what lets the node filter by party server-side. */
const asTopic = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().replace(/^0x/, '');
const fromTopic = (t) => '0x' + String(t).slice(-40).toLowerCase();

let rpcCalls = 0;
async function rpc(method, params = []) {
  rpcCalls++;
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcCalls, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/* No public RPC returns a whole history in one call. Walk fixed windows, and
   halve the window rather than give up when the node says it is too large. */
async function getLogs({ address, topics, from, to }) {
  const out = [];
  let cursor = from;
  let span = CHUNK;
  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    try {
      const logs = await rpc('eth_getLogs', [{
        address,
        topics,
        fromBlock: '0x' + cursor.toString(16),
        toBlock: '0x' + end.toString(16),
      }]);
      out.push(...logs);
      cursor = end + 1;
      process.stderr.write(`\r  ${address.slice(0, 8)}… block ${cursor} (${to - cursor + 1} to go, ${out.length} logs)   `);
    } catch (err) {
      if (/too large|range|limit|exceed/i.test(err.message) && span > 100) { span = Math.floor(span / 2); continue; }
      throw err;
    }
  }
  process.stderr.write('\n');
  return out;
}

/* `value` is Transfer's only non-indexed parameter, so it is the whole data
   word — BigInt(log.data) is the amount, with no decoding. */
const decode = (log) => ({
  from: log.topics?.[1] ? fromTopic(log.topics[1]) : null,
  to: log.topics?.[2] ? fromTopic(log.topics[2]) : null,
  value: (!log.data || log.data === '0x') ? 0n : BigInt(log.data),
});

const sum = (logs) => logs.reduce((a, l) => a + decode(l).value, 0n);

/* Base units are exact only as BigInt; convert once, here at the edge. */
function toNumber(v, decimals = DECIMALS) {
  const base = 10n ** decimals;
  return Number(v / base) + Number(v % base) / Number(base);
}

async function main() {
  for (const [name, value] of Object.entries({ TOKEN, REWARD_TOKEN, REWARDS_INDEX })) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(value))) throw new Error(`${name} is not an address: ${value}`);
    if (/^0x(a{40}|b{40}|c{40}|d{40}|e{40})$/i.test(String(value))) {
      throw new Error(`${name} is still the ${value.slice(0, 4)}… placeholder — it matches nothing on chain`);
    }
  }
  if (!Number.isFinite(START_BLOCK) || START_BLOCK <= 0) throw new Error(`START_BLOCK is ${START_BLOCK}`);

  const head = parseInt(await rpc('eth_blockNumber'), 16) - CONFIRMATIONS;
  console.log(`RPC ${RPC_URL}`);
  console.log(`token ${TOKEN}\nreward ${REWARD_TOKEN}\nindex ${REWARDS_INDEX}`);
  console.log(`scanning blocks ${START_BLOCK} … ${head}  (${head - START_BLOCK + 1} blocks)\n`);

  /* FEES COLLECTED — reward-token transfers whose RECIPIENT is the rewards
     index. Never the fee locker: that one is shared by every coin on the
     platform, and summing it reports the platform's fees as this token's. */
  console.log('fees in  → transfers of REWARD_TOKEN to REWARDS_INDEX');
  const feeLogs = await getLogs({
    address: REWARD_TOKEN,
    topics: [TRANSFER, null, asTopic(REWARDS_INDEX)],
    from: START_BLOCK, to: head,
  });
  const feesIn = sum(feeLogs);

  /* PAID OUT — the same token leaving the same contract. Trailing nulls are
     omitted because some RPCs reject a filter that ends in one. */
  console.log('paid out → transfers of REWARD_TOKEN from REWARDS_INDEX');
  const outLogs = await getLogs({
    address: REWARD_TOKEN,
    topics: [TRANSFER, asTopic(REWARDS_INDEX)],
    from: START_BLOCK, to: head,
  });
  const paidOut = sum(outLogs);

  /* PROTOCOL CUT — only when the address is known. Subtracting it exactly
     beats a percentage, which goes stale the day the split changes. */
  let protocolOut = 0n;
  if (PROTOCOL_ADDRESS) {
    console.log('protocol → transfers of REWARD_TOKEN from REWARDS_INDEX to PROTOCOL_ADDRESS');
    protocolOut = sum(await getLogs({
      address: REWARD_TOKEN,
      topics: [TRANSFER, asTopic(REWARDS_INDEX), asTopic(PROTOCOL_ADDRESS)],
      from: START_BLOCK, to: head,
    }));
  }

  /* HOLDERS — every transfer of the bought token folded into a balance per
     address. The zero address is skipped on both sides, so mints and burns
     fall out for free. */
  console.log('holders  → every transfer of TOKEN, folded into balances');
  const xferLogs = await getLogs({
    address: TOKEN, topics: [TRANSFER], from: START_BLOCK, to: head,
  });

  const bal = new Map();
  for (const log of xferLogs) {
    const { from, to, value } = decode(log);
    if (value === 0n) continue;
    if (from && from !== ZERO) bal.set(from, (bal.get(from) || 0n) - value);
    if (to && to !== ZERO) bal.set(to, (bal.get(to) || 0n) + value);
  }
  const touched = bal.size;
  for (const a of EXCLUDE) bal.delete(a);      // pool, fee locker, rewards index
  let holders = 0;
  for (const [, v] of bal) if (v > 0n) holders++;

  /* DISTRIBUTED — not the whole outflow: that carries the protocol's cut. */
  const distributed = PROTOCOL_ADDRESS
    ? toNumber(paidOut - protocolOut)
    : toNumber(paidOut) * HOLDER_SHARE;

  const basis = PROTOCOL_ADDRESS
    ? `paidOut − protocol cut (${toNumber(protocolOut).toFixed(2)}), exact`
    : `paidOut × ${HOLDER_SHARE}`;

  console.log('\n──────────────────────────────────────────────');
  console.log('fees collected  ', toNumber(feesIn).toFixed(2), ' (raw', feesIn.toString() + ')');
  console.log('paid out total  ', toNumber(paidOut).toFixed(2), ' (raw', paidOut.toString() + ')');
  console.log(`distributed      ${distributed.toFixed(2)}  = ${basis}`);
  console.log('holders         ', holders, `(${touched} addresses touched the token, ${EXCLUDE.length} excluded)`);
  console.log('──────────────────────────────────────────────');
  console.log(`${rpcCalls} RPC calls, ${feeLogs.length + outLogs.length + xferLogs.length} logs\n`);

  if (feesIn === paidOut) {
    console.log('⚠ fees in equals paid out exactly. Check the two are not reading the same stream.\n');
  }
  console.log("NOW VERIFY: these must match the token's own page on");
  console.log('thestonks.exchange / stockify.finance to the cent. If they do');
  console.log('not, the addresses are wrong — do not publish them.');
}

main().catch((e) => { console.error('\nfailed:', e.message); process.exit(1); });
