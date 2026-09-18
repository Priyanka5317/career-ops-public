#!/usr/bin/env node

/**
 * verify-resume-density.mjs — Mandatory pre-finalize check for resume packing.
 *
 * Counts bullets per section, verifies every project has >= 2 bullets,
 * confirms Patent has >= 2 sentences, and renders the HTML with Playwright
 * to measure content height vs. page height. FAILS if the resume has any
 * sparse-looking property.
 *
 * Usage:
 *   node verify-resume-density.mjs <input.html>
 *
 * Exit codes:
 *   0  All checks pass (resume is packed)
 *   1  One or more checks fail (resume is sparse — fix before shipping)
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node verify-resume-density.mjs <input.html>');
  process.exit(2);
}

const html = readFileSync(resolve(file), 'utf-8');

const fails = [];
const warns = [];

// 1. Experience bullets
const expMatch = html.match(/<div class="st">Experience<\/div>([\s\S]*?)<\/div>\s*<div class="sec">/);
const expSection = expMatch ? expMatch[1] : html;
const expEntries = expSection.match(/<div class="ent">/g) || [];
const expBullets = (expSection.match(/<li>/g) || []).length;
console.log(`  Experience: ${expEntries.length} entries, ${expBullets} bullets`);
if (expBullets < 7) fails.push(`Experience bullets = ${expBullets}, expected >= 7`);

// 2. Project bullets per section
const projMatch = html.match(/<div class="st">Projects<\/div>([\s\S]*?)<\/div>\s*<div class="sec pat">/);
const projSection = projMatch ? projMatch[1] : '';
if (!projSection) {
  fails.push('Could not find Projects section in HTML.');
} else {
  const projEntries = projSection.split('<div class="ent">').slice(1);
  console.log(`  Projects: ${projEntries.length} entries`);
  if (projEntries.length < 5) fails.push(`Projects count = ${projEntries.length}, expected >= 5`);

  let totalProjBullets = 0;
  projEntries.forEach((entry, i) => {
    const bullets = (entry.match(/<li>/g) || []).length;
    totalProjBullets += bullets;
    const titleMatch = entry.match(/<span class="ttl">([^<]+)<\/span>/);
    const title = titleMatch ? titleMatch[1] : `project ${i + 1}`;
    if (bullets < 2) {
      fails.push(`Project "${title.slice(0, 50)}" has only ${bullets} bullet(s). MUST have >= 2.`);
    }
  });
  console.log(`  Project bullets total: ${totalProjBullets}`);
  if (totalProjBullets < 10) fails.push(`Project bullets total = ${totalProjBullets}, expected >= 10`);
}

// 3. Patent length
const patMatch = html.match(/<div class="sec pat">([\s\S]*?)<\/div>\s*<\/body>/);
const patBody = patMatch ? patMatch[1] : '';
const patSentences = (patBody.match(/\. /g) || []).length + (patBody.match(/\.$/g) || []).length;
console.log(`  Patent: ~${patSentences} sentences`);
if (patSentences < 2) warns.push(`Patent has ~${patSentences} sentences — should be 2-3 with metric + stack + JD applicability.`);

// 4. Render with Playwright + measure content height vs page height
console.log(`\n  Rendering with Playwright to measure content height...`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.emulateMedia({ media: 'print' });

const measurement = await page.evaluate(() => {
  const body = document.body;
  const lastEl = body.querySelector('.pat') || body.lastElementChild;
  const bodyRect = body.getBoundingClientRect();
  const lastRect = lastEl.getBoundingClientRect();
  return {
    bodyHeight: bodyRect.height,
    contentBottom: lastRect.bottom,
    bodyBottom: bodyRect.bottom,
    pageHeightInches: 11,
  };
});
await browser.close();

// Convert px (96dpi) to inches
const contentBottomInches = measurement.contentBottom / 96;
const pageHeightInches = 11;
const coverage = (contentBottomInches / pageHeightInches) * 100;
console.log(`  Content extends to ${contentBottomInches.toFixed(2)}in of ${pageHeightInches}in page (${coverage.toFixed(1)}% coverage)`);

if (coverage < 90) {
  fails.push(`Content covers only ${coverage.toFixed(1)}% of page. MUST be >= 90% (packed). Expand bullets or add a project.`);
} else if (coverage < 95) {
  warns.push(`Content covers ${coverage.toFixed(1)}% of page. Aim for >= 95% for ideal density.`);
}

// 5. Report
console.log(`\n${'='.repeat(60)}`);
if (fails.length === 0) {
  console.log(`✅ PASS — Resume is packed (${coverage.toFixed(1)}% coverage)`);
  if (warns.length) {
    console.log(`\n⚠️  Warnings (consider addressing):`);
    warns.forEach(w => console.log(`   - ${w}`));
  }
  process.exit(0);
} else {
  console.log(`❌ FAIL — Resume is sparse. Fix before shipping.\n`);
  fails.forEach(f => console.log(`   ❌ ${f}`));
  if (warns.length) {
    console.log(`\n⚠️  Warnings:`);
    warns.forEach(w => console.log(`   - ${w}`));
  }
  process.exit(1);
}
