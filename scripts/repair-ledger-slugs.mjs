#!/usr/bin/env node
/**
 * repair-ledger-slugs.mjs — fix ledger rows whose company/title are folder slugs.
 *
 * WHAT WENT WRONG
 *
 * On 2026-09-09 the ledger was seeded in bulk from what was already on disk -
 * the notes on the affected rows still read "seeded 2026-09-09 from jds/ on
 * disk" and "pack complete on disk as of 2026-09-09". Whatever did it used the
 * DIRECTORY NAME as the data: company became the first token of the slug and
 * title became the whole slug. So Applied Materials' Data Scientist II req is
 * stored as:
 *
 *   company = "amat"
 *   title   = "amat-data-scientist-r2627532"
 *
 * 50 rows are affected, all dated 2026-09-09. No current script or agent prompt
 * does this - it was a one-off - so this is a data repair, not a code fix. It
 * surfaced because the Excel workbook renders the ledger verbatim and the rows
 * look like corrupted joins between unrelated jobs.
 *
 * RECOVERY ORDER, most authoritative first:
 *   1. data/applications.md, matched on the output/<slug>/ path  - her own tracker
 *   2. jds/<slug>.md          - the extracted JD's H1 and employer line
 *   3. data/applications.md, matched on the posting URL
 *   4. derive from the slug + URL host (last resort, marked in the note)
 *
 * A row is only rewritten when a better value is actually found. Rows that
 * cannot be resolved are listed and left ALONE rather than guessed at, because a
 * wrong employer on a row is worse than an ugly one.
 *
 * Usage:
 *   node scripts/repair-ledger-slugs.mjs            # dry run, prints the plan
 *   node scripts/repair-ledger-slugs.mjs --apply    # rewrite, keeps a .bak
 *   node scripts/repair-ledger-slugs.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'data', 'seen-jobs.tsv');

/** A title that is really a directory name: all lowercase, hyphenated, 3+ parts. */
export function isSlugTitle(t) {
  return /^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(String(t || ''));
}

/** Turn "data-scientist-r2627532" into "Data Scientist R2627532". */
export function prettify(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => (/^[a-z]\d|^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .trim();
}

/** Employer guess from an ATS host, e.g. amat.wd1.myworkdayjobs.com -> amat. */
export function hostToken(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?([^./]+)\./i);
  return m ? m[1] : '';
}

/** Parse the tracker into { byFolder, byUrl } -> { company, title }. */
export function parseTracker(md) {
  const byFolder = new Map(), byUrl = new Map();
  for (const line of String(md).split(/\r?\n/)) {
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 8 || !/^\d+$/.test(c[1] || '')) continue;
    const bold = (s) => { const m = String(s).match(/\*\*([^*]+)\*\*/); return m ? m[1].trim() : String(s).split('(')[0].trim(); };
    const rec = { company: bold(c[3]), title: bold(c[4]) };
    if (!rec.company || !rec.title) continue;
    const f = line.match(/output\/([A-Za-z0-9._-]+)\//);
    if (f) byFolder.set(f[1].toLowerCase(), rec);
    for (const u of line.matchAll(/https?:\/\/[^\s|`)\]]+/g)) {
      byUrl.set(normUrl(u[0]), rec);
    }
  }
  return { byFolder, byUrl };
}

export function normUrl(u) {
  return String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/[/?#].*$/, (m) => m).replace(/\/+$/, '').toLowerCase();
}

/**
 * Pull the real title and employer out of an extracted JD.
 * The H1 is the title; employers appear either as a bolded field or after an
 * en/em dash in the heading ("Kitware - Machine Learning Engineer").
 */
export function parseJd(text, slugToken = '') {
  const t = String(text || '');
  const h1 = ((t.match(/^#\s+(.+)$/m) || [])[1] || '').trim();
  // `.` does not match a newline in JS by default, so it ends the capture at the
  // end of the line without needing an escaped character class - which is what
  // kept getting mangled when this file was edited through a shell heredoc.
  const emp = ((t.match(/\*\*Employer(?:\s*\(as posted\))?:?\*\*\s*(.+)/i) || [])[1]
            || (t.match(/\*\*Legal entity:?\*\*\s*(.+)/i) || [])[1] || '')
            .split('|')[0].replace(/\*/g, '').trim();

  let title = h1, company = emp;

  // A heading like "Kitware - Machine Learning Engineer" is ambiguous: either
  // side could be the employer, and guessing produced exact inversions
  // ("3D Machine Learning Engineer - Field AI" became company="3D Machine
  // Learning Engine"). Only split when the SLUG tells us which side is the
  // company, and otherwise leave the employer unknown.
  const parts = title.split(/\s+[–—-]\s+/);
  if (parts.length === 2 && slugToken) {
    const key = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tok = key(slugToken);
    if (key(parts[0]).startsWith(tok)) { if (!company) company = parts[0].trim(); title = parts[1].trim(); }
    else if (key(parts[1]).startsWith(tok)) { if (!company) company = parts[1].trim(); title = parts[0].trim(); }
  }
  // Strip a leading "Comcast - " when we already know the employer. Done with
  // indexOf rather than a built regex: the company name can contain (), . and +,
  // and escaping those correctly through an edit kept corrupting the file.
  if (company) {
    const first = company.split(/[\s(,]/)[0].toLowerCase();
    if (first && title.toLowerCase().startsWith(first)) {
      const cut = title.search(/[\u2013\u2014-]/);
      if (cut > 0 && cut < first.length + 24) title = title.slice(cut + 1).trim();
    }
  }
  title = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { company: company.replace(/[.,;]$/, '').trim(), title };
}

function resolve(row, tracker) {
  const slug = String(row.title || '').toLowerCase();

  // 1. Her own tracker, matched on the pack folder. Most authoritative.
  const fromTracker = tracker.byFolder.get(slug);
  if (fromTracker) return { ...fromTracker, via: 'tracker:folder' };

  // 2. The extracted JD - but ONLY when it names the employer explicitly.
  const jd = path.join(ROOT, 'jds', slug + '.md');
  if (existsSync(jd)) {
    const p = parseJd(readFileSync(jd, 'utf8'), slug.split('-')[0]);
    if (p.title && p.company) return { company: p.company, title: p.title, via: 'jds/' };
  }

  // 3. The tracker again, matched on the posting URL.
  const byUrl = tracker.byUrl.get(normUrl(row.url));
  if (byUrl) return { ...byUrl, via: 'tracker:url' };

  // NO SLUG FALLBACK. Splitting "northwestern-mutual-data-scientist" on the
  // first hyphen yields company="northwestern", and the same happens to Capital
  // One, Walt Disney, Michael Kors and Blue Cross. An ugly row beats a wrong
  // employer, so these are reported and left untouched.
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const apply = args.includes('--apply');

  const raw = readFileSync(LEDGER, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split('\t');
  const iT = header.indexOf('title'), iC = header.indexOf('company'),
        iU = header.indexOf('url'), iN = header.indexOf('note');
  if (iT < 0 || iC < 0) { console.error('ledger missing company/title columns'); return 1; }

  const tracker = parseTracker(readFileSync(path.join(ROOT, 'data', 'applications.md'), 'utf8'));

  let fixed = 0, skipped = 0;
  const out = [lines[0]];
  const report = [], unresolved = [];

  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    if (!isSlugTitle(c[iT])) { out.push(line); continue; }

    const r = resolve({ company: c[iC], title: c[iT], url: c[iU] }, tracker);
    if (!r || (r.company === c[iC] && r.title === c[iT])) {
      unresolved.push([c[iC], c[iT]]); skipped++; out.push(line); continue;
    }
    report.push([c[iT], r.company, r.title, r.via]);
    c[iC] = r.company; c[iT] = r.title;
    if (iN >= 0) c[iN] = ((c[iN] || '') + ' | slug repaired 2026-09-14 via ' + r.via).trim().replace(/^\|\s*/, '');
    fixed++; out.push(c.join('\t'));
  }

  console.log(`slug-shaped rows: ${fixed + skipped}   repairable: ${fixed}   left alone: ${skipped}\n`);
  for (const [slug, co, ti, via] of report) {
    console.log(`  ${slug.slice(0, 44).padEnd(46)}-> ${co.slice(0, 26).padEnd(28)}${ti.slice(0, 38)}   [${via}]`);
  }
  if (unresolved.length) {
    console.log('\n  NOT resolved (left exactly as-is rather than guessed):');
    for (const [co, ti] of unresolved) console.log(`    ${co.padEnd(20)}${ti.slice(0, 54)}`);
  }

  if (!apply) { console.log('\nDRY RUN - nothing written. Re-run with --apply.'); return 0; }
  copyFileSync(LEDGER, LEDGER + '.bak');
  writeFileSync(LEDGER, out.join('\n') + '\n', 'utf8');
  console.log(`\nwrote ${out.length - 1} rows; backup at ${path.relative(ROOT, LEDGER)}.bak`);
  return 0;
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  eq('slug title detected', isSlugTitle('amat-data-scientist-r2627532'), true);
  eq('real title not a slug', isSlugTitle('Data Scientist II'), false);
  eq('two-part is not a slug', isSlugTitle('data-analyst'), false);
  eq('mixed case is not a slug', isSlugTitle('Amat-Data-Scientist'), false);

  eq('prettify', prettify('data-scientist-r2627532'), 'Data Scientist R2627532');
  eq('host token', hostToken('https://amat.wd1.myworkdayjobs.com/x'), 'amat');

  // JD with an explicit employer field.
  eq('jd employer field', parseJd('# Data Analytics Engineer\n\n**Employer (as posted):** Parafin\n'),
    { company: 'Parafin', title: 'Data Analytics Engineer' });
  // A dashed heading is only split when the SLUG says which side is the company.
  eq('dash heading, slug names the left side',
    parseJd('# Kitware — Machine Learning Engineer (Arlington, VA)\n', 'kitware'),
    { company: 'Kitware', title: 'Machine Learning Engineer' });
  eq('dash heading, slug names the RIGHT side',
    parseJd('# 3D Machine Learning Engineer — Field AI\n', 'field'),
    { company: 'Field AI', title: '3D Machine Learning Engineer' });
  // Without a slug token the direction is unknowable, so do NOT guess. Guessing
  // here is what produced company="3D Machine Learning Engine" on the first run.
  eq('dash heading, no token -> no employer claimed',
    parseJd('# Kitware — Machine Learning Engineer\n').company, '');

  // Tracker parsing by folder path.
  const md = '| 1 | 2026-09-09 | **Applied Materials, Inc.** (x) | **Data Scientist II** (y) | 4.0/5 | BUILT | output/amat-data-scientist-r2627532/ | - | n |';
  const t = parseTracker(md);
  eq('tracker by folder', t.byFolder.get('amat-data-scientist-r2627532'),
    { company: 'Applied Materials, Inc.', title: 'Data Scientist II' });

  // A row that cannot be resolved must return null, never a guess.
  eq('unresolvable returns null',
    resolve({ company: 'zzz', title: 'qqq-www-eee', url: 'https://nowhere.example/x' },
      { byFolder: new Map(), byUrl: new Map() }), null);

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

process.exit(main());
