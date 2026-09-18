#!/usr/bin/env node
// Resume page-fit auditor.
//
// Why this exists: verify-resume-density.mjs measures coverage only as far as the
// Patent section, but Education sits BELOW it. A resume whose Education runs off
// the bottom of the page therefore reports PASS while being visibly clipped in the
// PDF. This measures the DEEPEST DESCENDANT BOTTOM of the body instead, so nothing
// can hide under `overflow:hidden`, and it names the section that ends last.
//
// Usage:
//   node check-resume-fit.mjs                 audit every resume under output/
//   node check-resume-fit.mjs <path|glob>     audit specific file(s)
//   node check-resume-fit.mjs --ok-only       print only the failures
//
// Bands (letter page = 11in):
//   CLIPPED     > 11.00in   content runs off the page
//   TIGHT       10.96-11.00 fits, but no margin for font substitution
//   OK          10.80-10.95 target fill band
//   UNDERFILLED < 10.80     white space at the bottom of the page

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve, relative } from 'path';
import { globSync } from 'fs';

const PAGE_IN = 11;
const BAND_LO = 10.8;
const BAND_HI = 10.95;

const args = process.argv.slice(2);
const okOnly = args.includes('--ok-only');
const patterns = args.filter((a) => !a.startsWith('--'));

// Resolve targets. Default sweep covers packs plus any loose resumes in output/.
let files;
if (patterns.length) {
  files = patterns.flatMap((p) => globSync(p, { nodir: true }));
} else {
  files = globSync('output/**/*Resume*.html', { nodir: true });
}
files = [...new Set(files)].sort();

if (!files.length) {
  console.error('No resume HTML files matched.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });

const rows = [];
for (const f of files) {
  let html;
  try {
    html = readFileSync(resolve(f), 'utf-8');
  } catch {
    rows.push({ f, err: 'unreadable' });
    continue;
  }
  // Match the renderer's ATS normalization so measurement reflects the shipped PDF.
  html = html
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');

  await page.setContent(html, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });

  const m = await page.evaluate(() => {
    const body = document.body;
    const top = body.getBoundingClientRect().top;
    let deepest = 0;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      const rel = r.bottom - top;
      if (rel > deepest) deepest = rel;
    }
    // Name the section that ends last, for a readable report.
    const secs = [...document.querySelectorAll('body > .sec, body > .hdr')];
    let lastName = '', lastBottom = -1;
    for (const s of secs) {
      const b = s.getBoundingClientRect().bottom - top;
      if (b > lastBottom) {
        lastBottom = b;
        const t = s.querySelector('.st');
        lastName = t ? t.textContent.trim() : 'HEADER';
      }
    }
    return { deep: deepest / 96, lastName, lastBottom: lastBottom / 96 };
  });

  const deep = +m.deep.toFixed(2);
  let status;
  if (deep > PAGE_IN) status = 'CLIPPED';
  else if (deep > BAND_HI) status = 'TIGHT';
  else if (deep >= BAND_LO) status = 'OK';
  else status = 'UNDERFILLED';

  rows.push({ f: relative(process.cwd(), f), deep, status, last: m.lastName });
}
await browser.close();

const rank = { CLIPPED: 0, UNDERFILLED: 1, TIGHT: 2, OK: 3 };
rows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.deep - a.deep);

const shown = okOnly ? rows.filter((r) => r.status !== 'OK') : rows;
const pad = Math.min(78, Math.max(...shown.map((r) => r.f.length), 10));

console.log(`Resume page fit, ${rows.length} file(s), page = ${PAGE_IN}in, target ${BAND_LO}-${BAND_HI}in\n`);
for (const r of shown) {
  if (r.err) { console.log(`  ${r.f.padEnd(pad)}  ${r.err}`); continue; }
  const flag = r.status === 'CLIPPED' ? '  <-- content runs off the page' : '';
  console.log(`  ${String(r.status).padEnd(11)} ${String(r.deep).padStart(5)}in  ${r.f.padEnd(pad)}  last: ${r.last}${flag}`);
}

const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   '));
process.exit(counts.CLIPPED ? 1 : 0);
