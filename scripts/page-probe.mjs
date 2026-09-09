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

/* SITE_URL probes the DEPLOYED site instead of this working tree. Everything
   here had been verified against a local copy of the repo, which says nothing
   about what a visitor's browser is actually served: the repo is not on
   GitHub Pages at all (has_pages is false) — it deploys to Vercel. A local
   pass proves the code is right, not that the code is live. */
const SITE_URL = process.env.SITE_URL || '';
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

if (!SITE_URL) await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();

/* MOBILE reproduces the report that started this: a phone showing em dashes
   where a desktop shows figures. Nothing about the network differs here — what
   differs is that a phone arrives with an empty cache and rarely keeps the tab
   in front for the minute the chain scan needs, so the run reports how long
   the reward tiles take to fill from a cold start. */
const MOBILE = !!process.env.MOBILE;
const context = await browser.newContext(MOBILE ? {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
           + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
} : {});
const page = await context.newPage();
if (MOBILE) console.log('mobile: 390x844, cold cache');

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
const target = SITE_URL ? SITE_URL.replace(/\/$/, '') + '/?debug=1' : `http://localhost:${PORT}/?debug=1`;
console.log(`target ${target}`);
await page.goto(target, { waitUntil: 'commit' });

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

const served = await page.evaluate(() => (window.SITE_CONFIG || {}).version || '(none)');
console.log(`\nbuild served by this target: ${served}`);

if (SITE_URL) {
  try {
    const r = await fetch(SITE_URL.replace(/\/$/, '') + '/data/rewards.json', { cache: 'no-store' });
    const j = await r.json();
    console.log(`its data/rewards.json: updatedAt ${j.updatedAt} · distributed ${j.totalDistributed} · holders ${j.holders}`);
  } catch (e) { console.log(`its data/rewards.json: FAILED ${e.message}`); }
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

/* On mobile the question is not "is a zero showing" but "did anything arrive".
   A dash while data/rewards.json still holds nulls is correct — there is
   genuinely nothing to show yet. A dash while that file HAS figures is the
   fallback failing, which is the fault worth failing a build over. */
if (MOBILE) {
  const published = JSON.parse(await readFile(path.join(ROOT, 'data/rewards.json'), 'utf8'));
  const hasBaseline = ['totalDistributed', 'totalFeesTokens', 'holders']
    .some((k) => typeof published[k] === 'number');
  const empty = await page.$$eval('[data-value]', (ns) => ns
    .filter((n) => ['fees', 'distributed', 'holders'].includes(n.dataset.value))
    .filter((n) => /^[—-]?$/.test(n.textContent.trim()))
    .map((n) => n.dataset.value));

  if (!hasBaseline) {
    console.log(`mobile: data/rewards.json is still empty, so ${empty.length} dash(es) is honest;`
              + ' the scheduled indexer has not published yet');
  } else if (empty.length) {
    console.log(`FAIL: rewards.json has figures but ${empty.join(', ')} still show a dash`);
    await browser.close(); server.close();
    process.exit(1);
  } else {
    console.log('PASS: the published baseline filled every reward tile');
  }
}

console.log('=========================================================');
await browser.close();
if (!SITE_URL) server.close();
