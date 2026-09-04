#!/usr/bin/env node
/* ==========================================================================
   Cache-buster stamp
   --------------------------------------------------------------------------
   index.html loads its stylesheet, config.js and app.js with a ?v= query, and
   config.js carries a matching `version` that the ?debug=1 panel prints. All
   of them have to move together: a CDN will otherwise keep serving the
   previous JS for hours after the HTML updates, which looks exactly like a
   push that never landed.

   Run before deploying:  node scripts/stamp.mjs        (next number)
                          node scripts/stamp.mjs 7      (a specific one)
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const CONFIG = path.join(ROOT, 'config.js');

const html = fs.readFileSync(HTML, 'utf8');
const config = fs.readFileSync(CONFIG, 'utf8');

const VERSION_RE = /(\bversion:\s*')(\d+)(')/;
const current = Number((config.match(VERSION_RE) || [])[2]);
if (!Number.isFinite(current)) {
  console.error("config.js has no numeric `version:` — can't stamp it");
  process.exit(1);
}

const asked = process.argv[2];
const next = asked === undefined ? current + 1 : Number(asked);
if (!Number.isInteger(next) || next < 1) {
  console.error(`not a build number: ${asked}`);
  process.exit(1);
}

// Every ?v= in the HTML, whatever it is attached to — the stylesheet and the
// icons are as cacheable as the scripts.
let stampedHtml = html;
let queries = 0;
stampedHtml = stampedHtml.replace(/\?v=\d+/g, () => (queries++, `?v=${next}`));

fs.writeFileSync(HTML, stampedHtml);
fs.writeFileSync(CONFIG, config.replace(VERSION_RE, `$1${next}$3`));

console.log(`stamped build ${current} → ${next}  (${queries} ?v= in index.html, 1 version in config.js)`);
