#!/usr/bin/env node
/* ==========================================================================
   page-probe.mjs — load the real page in a real browser and print what the
   tiles say.

   scripts/probe.mjs answers what the chain holds. This answers the different
   question that kept being guessed at: what the page DOES with it. It serves
   this working tree, opens it with ?debug=1, waits for the dashboard to
   settle, and prints every [site] console line plus the rendered text of
   every tile — so a wrong figure can be traced to the line that produced it
   instead of reasoned about from a sandbox that cannot reach Base.

     node scripts/page-probe.mjs
   ========================================================================== */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8123);
const WAIT = Number(process.env.WAIT_MS || 150000);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});

await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();

/* SEED_ZEROS reproduces the state a returning visitor is actually in: a
   browser that banked zeros while the scan was dying, and then showed them on
   every later visit because the remembered value owned the field and the
   derivation only filled fields nobody owned. A fresh browser never sees this,
   which is why it passed here while it was still broken on real screens. */
if (process.env.SEED_ZEROS) {
  const cfgSrc = await readFile(path.join(ROOT, 'config.js'), 'utf8');
  const token = /contractAddress:\s*'([^']+)'/.exec(cfgSrc)[1].toLowerCase();
  const version = /'box:stats:(v\d+):'/.exec(await readFile(path.join(ROOT, 'assets/js/app.js'), 'utf8'))[1];
  const key = `box:stats:${version}:${token}`;
  await page.addInitScript(([k, poison]) => {
    try { localStorage.setItem(k, poison); } catch { /* ignore */ }
  }, [key, JSON.stringify({ at: Date.now(), values: { fees: 0, distributedUsd: 0, distributed: 0, holders: 0 } })]);
  console.log(`seeded ${key} with zeros`);
}

page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[site]') || m.type() === 'error') console.log('  ' + t);
});
page.on('pageerror', (e) => console.log('  PAGE ERROR: ' + e.message));

console.log('=== page probe ==========================================');
await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'commit' });

/* Settle on the dashboard rather than on a timer: the legend goes live the
   moment something answered, and the chain scan is the slowest of them. */
const started = Date.now();
try {
  /* Not the legend: it goes live the moment ANY source answers, and
     DexScreener answers in half a second while the chain scan — the one
     carrying holders, fees and payouts — takes half a minute. Waiting on the
     legend is how a run reports "live" over three empty tiles. Wait for the
     figure that only the scan can produce. */
  await page.waitForFunction(
    () => {
      const t = document.querySelector('[data-value="holders"]')?.textContent.trim();
      // A zero is not a landed figure — it is the thing being tested for.
      return t && t !== '—' && t !== '' && t !== '0';
    },
    null, { timeout: WAIT },
  );
  console.log(`\nthe chain scan landed after ${Date.now() - started}ms`);
} catch {
  console.log(`\nthe chain scan produced nothing within ${WAIT}ms`);
}
await page.waitForTimeout(5000);

const tiles = await page.$$eval('.stat', (nodes) => nodes.map((n) => ({
  label: n.querySelector('.stat__label')?.textContent.trim(),
  value: n.querySelector('.stat__value')?.textContent.trim().replace(/\s+/g, ' '),
  sub: n.querySelector('.stat__sub')?.textContent.trim(),
  subHidden: n.querySelector('.stat__sub')?.hidden ?? null,
})));

console.log('\n--- tiles as rendered -----------------------------------');
for (const t of tiles) {
  console.log(`  ${String(t.label).padEnd(22)} ${t.value}`);
  if (t.sub !== undefined) console.log(`  ${' '.repeat(22)} sub: ${JSON.stringify(t.sub)}${t.subHidden ? '  (HIDDEN)' : ''}`);
}

console.log('\n--- legend ----------------------------------------------');
console.log('  ' + (await page.$eval('#dash-note', (n) => n.textContent.trim().replace(/\s+/g, ' ')).catch(() => 'no legend')));

console.log('\n--- debug panel -----------------------------------------');
console.log((await page.$eval('#dash-debug', (n) => n.textContent).catch(() => '  (none)')));

if (process.env.SEED_ZEROS) {
  const bad = await page.$$eval('[data-value]', (ns) => ns
    .filter((n) => ['fees', 'distributedUsd', 'distributed', 'holders'].includes(n.dataset.value))
    .filter((n) => /^\$?0$|^0\.00$/.test(n.textContent.trim()))
    .map((n) => n.dataset.value));
  if (bad.length) {
    console.log(`FAIL: seeded zeros survived on ${bad.join(', ')}`);
    await browser.close(); server.close();
    process.exit(1);
  }
  /* Says only what was checked. The scan does not always land inside the
     window on a loaded runner, and when it does not the tiles read "—" —
     which passes, correctly, because a waiting tile is the intended
     behaviour. Claiming "replaced by a live figure" would overstate it. */
  console.log('PASS: no seeded zero is on screen (tiles show a live figure or wait)');
}

console.log('=========================================================');
await browser.close();
server.close();
