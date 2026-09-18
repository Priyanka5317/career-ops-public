#!/usr/bin/env node
/**
 * check-f-pattern.mjs — Audits a resume against F-pattern reading behaviour.
 *
 * Recruiters and hiring managers do not read a resume, they scan it in an F:
 * one horizontal sweep across the top, a shorter second sweep further down, then
 * a vertical run down the LEFT EDGE. Everything that matters therefore has to be
 * reachable in three places:
 *
 *   1. TOP BAR    the first line of the Summary
 *   2. LEFT RAIL  the first few words of every bullet, read vertically
 *   3. EARLY BOLD bold that lands inside the scanned zone, not mid-sentence
 *
 * A bullet that opens "Worked with stakeholders to..." spends the only words
 * that get scanned on nothing. A bullet whose only bold term sits at character
 * 120 is invisible to a vertical scan even though it reads well in full.
 *
 * This measures those three things. It is a style auditor, not a fit checker:
 * check-ats-score.mjs answers whether the machine can read it, this answers
 * whether a human skimming for six seconds will see the right words.
 *
 * Usage:
 *   node check-f-pattern.mjs <resume.html> [...]
 *   node check-f-pattern.mjs --all              every resume HTML under output/
 *   node check-f-pattern.mjs <file> --verbose   print the full left rail
 *   node check-f-pattern.mjs --self-test
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Openers that burn the scanned zone. These describe involvement rather than
// action, so the first two words of the left rail carry no information.
export const WEAK_OPENERS = new Set([
  'worked', 'responsible', 'helped', 'assisted', 'involved', 'participated',
  'tasked', 'utilized', 'leveraged', 'supported', 'contributed', 'aided',
  'collaborated', 'partnered', 'engaged', 'served', 'performed', 'handled',
  'managed', 'various', 'several', 'successfully', 'effectively', 'responsiblefor',
]);

// How far into a bullet bold can start and still land in the scanned zone.
export const EARLY_BOLD_CHARS = 60;

export function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character offset at which the first <strong> content begins, in visible text. */
export function firstBoldOffset(liHtml) {
  const i = String(liHtml).search(/<(strong|b)\b/i);
  if (i < 0) return null;
  return stripTags(String(liHtml).slice(0, i)).length;
}

export function firstWords(text, n = 4) {
  return stripTags(text).split(/\s+/).slice(0, n).join(' ');
}

export function auditBullet(liHtml) {
  const text = stripTags(liHtml);
  const words = text.split(/\s+/);
  const opener = (words[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  const bold = firstBoldOffset(liHtml);
  return {
    text,
    rail: firstWords(liHtml, 4),
    weakOpener: WEAK_OPENERS.has(opener) ? opener : null,
    boldOffset: bold,
    lateBold: bold === null ? 'none' : (bold > EARLY_BOLD_CHARS ? bold : null),
  };
}

export function auditResume(html) {
  const findings = [];

  // 1. TOP BAR — the first sentence of the Summary.
  const sumMatch = html.match(/class="sum"[^>]*>([\s\S]*?)<\/div>/i);
  const summary = sumMatch ? stripTags(sumMatch[1]) : '';
  const firstSentence = summary.split(/(?<=\.)\s/)[0] || '';
  const topBar = {
    firstSentence,
    words: firstSentence ? firstSentence.split(/\s+/).length : 0,
    boldOffset: sumMatch ? firstBoldOffset(sumMatch[1]) : null,
  };
  if (topBar.words > 22) {
    findings.push({ zone: 'top bar', issue: `opening sentence is ${topBar.words} words; a scan takes the first line only`, detail: firstSentence.slice(0, 90) });
  }
  if (topBar.boldOffset !== null && topBar.boldOffset > 110) {
    findings.push({ zone: 'top bar', issue: `first bold term starts ${topBar.boldOffset} chars in, past the opening line`, detail: '' });
  }

  // 2/3. LEFT RAIL + EARLY BOLD across every bullet.
  const bullets = [...html.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((m) => m[1]);
  const rail = [];
  for (const b of bullets) {
    const a = auditBullet(b);
    rail.push(a.rail);
    if (a.weakOpener) findings.push({ zone: 'left rail', issue: `bullet opens on "${a.weakOpener}", which carries no information in a vertical scan`, detail: a.rail });
    if (a.lateBold === 'none') findings.push({ zone: 'early bold', issue: 'bullet has no bold at all, so nothing anchors it in a scan', detail: a.rail });
    else if (a.lateBold) findings.push({ zone: 'early bold', issue: `first bold starts ${a.lateBold} chars in, outside the scanned zone`, detail: a.rail });
  }

  // Repetition down the rail reads as one grey block rather than distinct points.
  const openers = rail.map((r) => (r.split(/\s+/)[0] || '').toLowerCase());
  const counts = {};
  for (const o of openers) counts[o] = (counts[o] || 0) + 1;
  for (const [word, n] of Object.entries(counts)) {
    if (n >= 3 && word) findings.push({ zone: 'left rail', issue: `"${word}" opens ${n} bullets; the rail stops differentiating`, detail: '' });
  }

  return { topBar, bulletCount: bullets.length, rail, findings };
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) pass++; else { fail++; console.error(`FAIL ${n}\n  got  ${JSON.stringify(g)}\n  want ${JSON.stringify(w)}`); } };

  eq('strips tags', stripTags('<li>Built <strong>ETL</strong> pipelines</li>'), 'Built ETL pipelines');
  eq('bold at start is offset 0', firstBoldOffset('<strong>Built</strong> pipelines'), 0);
  // stripTags trims, so the trailing space before <strong> is not counted.
  eq('bold offset counts visible text only',
    firstBoldOffset('Designed and maintained <strong>ETL</strong>'), 'Designed and maintained'.length);
  eq('no bold returns null', firstBoldOffset('Plain bullet text'), null);

  eq('weak opener flagged', auditBullet('<li>Worked with stakeholders on <strong>SQL</strong></li>').weakOpener, 'worked');
  eq('strong opener not flagged', auditBullet('<li><strong>Built</strong> pipelines</li>').weakOpener, null);
  eq('rail is the first four words', auditBullet('<li>Designed and built robust data pipelines</li>').rail, 'Designed and built robust');

  const late = '<li>' + 'x'.repeat(80) + ' <strong>bold</strong></li>';
  eq('late bold detected', auditBullet(late).lateBold, 80);
  eq('early bold passes', auditBullet('<li>Built <strong>ETL</strong> pipelines</li>').lateBold, null);

  const r = auditResume('<div class="sum">Short opener here. More text.</div><li>Worked on things</li><li>Worked on more</li><li>Worked again</li>');
  const issues = r.findings.map((f) => f.issue);
  eq('repeated opener flagged', issues.some((i) => i.includes('opens 3 bullets')), true);
  eq('weak openers all flagged', issues.filter((i) => i.includes('carries no information')).length, 3);

  console.log(`${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const verbose = args.includes('--verbose');

  let files = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--all') || !files.length) {
    const out = path.join(ROOT, 'output');
    files = existsSync(out)
      ? readdirSync(out).flatMap((d) => {
          const dir = path.join(out, d);
          try { return readdirSync(dir).filter((f) => /Resume.*\.html$/i.test(f)).map((f) => path.join(dir, f)); }
          catch { return []; }
        })
      : [];
  }
  if (!files.length) { console.error('no resume HTML found'); return 1; }

  let worst = 0;
  for (const f of files) {
    const r = auditResume(readFileSync(f, 'utf8'));
    worst = Math.max(worst, r.findings.length);
    console.log(`\n${path.relative(ROOT, f)}`);
    console.log(`  top bar: ${r.topBar.words} words | ${r.bulletCount} bullets | ${r.findings.length} finding(s)`);
    if (verbose) {
      console.log('  left rail (what a vertical scan sees):');
      for (const x of r.rail) console.log(`    - ${x}`);
    }
    for (const fnd of r.findings) {
      console.log(`  [${fnd.zone}] ${fnd.issue}`);
      if (fnd.detail) console.log(`      ${fnd.detail}`);
    }
    if (!r.findings.length) console.log('  clean');
  }
  return worst > 0 ? 0 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
