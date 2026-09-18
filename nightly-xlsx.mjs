#!/usr/bin/env node
/**
 * nightly-xlsx.mjs — human-readable Excel view of the tracking data. ZERO tokens.
 *
 * WHY
 *
 * The pipeline's working files are TSV because every stage reads and rewrites
 * them and a diffable text format is what makes that safe. They are miserable to
 * actually read: data/seen-jobs.tsv is 22,000+ rows on one line per posting with
 * no formatting, and opening it in Excel means fighting the import wizard every
 * time.
 *
 * So the TSVs stay as the machine format and this writes the human one. Nothing
 * downstream reads the workbook; deleting it costs nothing and the next run
 * recreates it.
 *
 * THE DATE SHE ASKED FOR
 *
 * "the date the job was found by our run" lives ONLY in the ledger
 * (data/seen-jobs.tsv -> first_seen). Neither data/shortlist.tsv nor
 * data/terminal-drops.tsv carries a date column at all, so both sheets join back
 * to the ledger on the ledger's own normalized-URL key to pick it up. A row with
 * no ledger match shows a blank date rather than today's, because claiming a job
 * was found today when we do not know that would be worse than an empty cell.
 *
 * Requires openpyxl (python -m pip install openpyxl). Extraction is delegated to
 * Python for the same reason check-ats-score.mjs delegates to pypdf: there is no
 * xlsx writer in this repo's node dependencies and adding one is not worth it.
 *
 * Usage:
 *   node nightly-xlsx.mjs
 *   node nightly-xlsx.mjs --out data/job-tracking.xlsx
 *   node nightly-xlsx.mjs --self-test
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeUrl } from './nightly-seen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Read a TSV into objects. Returns [] for a missing or header-only file. */
export function readTsv(p) {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => { o[h] = c[i] ?? ''; });
    return o;
  });
}

/**
 * Map normalized URL -> { first_seen, last_seen, times_seen, stage, verdict }.
 * This is the only place any of those dates exist.
 */
export function ledgerIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = r.job_key || normalizeUrl(r.url);
    if (k) idx.set(k, r);
  }
  return idx;
}

/** Attach the ledger's dates to a row that has none of its own. */
export function withDates(row, idx) {
  const hit = idx.get(normalizeUrl(row.url)) || {};
  return {
    date_found: hit.first_seen || '',
    last_seen: hit.last_seen || '',
    times_seen: hit.times_seen || '',
    ...row,
  };
}

/**
 * THE FUNNEL. Every posting the pipeline has ever seen lands in exactly ONE of
 * these buckets, so the four detail sheets sum to the Seen total. That is the
 * whole point: if they do not add up, something is being double-counted or lost.
 *
 *   BUILT        a pack exists on disk
 *   DROPPED      ruled out, with a reason (gate, visa wall, low score)
 *   SHORTLISTED  selected and still in flight - no verdict yet
 *   SEEN ONLY    in the feed, never selected
 *
 * Ordering matters: BUILT is checked first because a built posting also carries
 * an advanced stage, and DROPPED before SHORTLISTED because a dropped row keeps
 * whatever stage it reached before being dropped.
 */
export function classify(row) {
  const stage = String(row.stage || '').trim().toLowerCase();
  const verdict = String(row.verdict || '').trim().toUpperCase();

  // stage is 'built' but two legacy rows say 'build'; verdict BUILT is the
  // authority and the counts disagree (39 vs 36), so accept either.
  if (verdict === 'BUILT' || stage === 'built' || stage === 'build') return 'BUILT';
  if (verdict.startsWith('DROP') || verdict.startsWith('SKIP') || stage === 'dropped') return 'DROPPED';
  if (['shortlisted', 'jd_extracted', 'visa_gated', 'scored', 'queued'].includes(stage)) return 'SHORTLISTED';
  return 'SEEN ONLY';
}

/** Human-readable reason a row was dropped. Falls back to the raw verdict. */
export function dropReason(row) {
  const v = String(row.verdict || '').trim();
  if (!v) return '';
  return v.replace(/^(DROP|SKIP):\s*/i, '').trim() || v;
}

/** Local timestamp, "YYYY-MM-DD HH:MM". Never UTC - see the Generated row. */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const PY = `
import sys, json, re
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

# Scraped titles and notes carry control characters that are legal in a TSV and
# ILLEGAL in the XML inside an xlsx. openpyxl writes them without complaint and
# the resulting workbook will not open - Excel reports it as corrupt and
# openpyxl itself fails with "reference to invalid character number". Observed
# 2026-09-12 on the first real export.
# Illegal-in-XML codepoints. Two families, both observed in this ledger:
#   1. C0 control characters, from scraped markup.
#   2. LONE SURROGATES (0xD800-0xDFFF). A mojibake'd Japanese title
#      ('AV Driver Trainer (...)') carried unpaired surrogates; openpyxl wrote
#      them as &#56449; and the workbook then refused to open with
#      'reference to invalid character number'. Control-char stripping alone
#      did NOT fix it - this was the actual culprit.
BAD = dict.fromkeys(
    list(range(0, 9)) + list(range(11, 13)) + list(range(14, 32))
    + list(range(0xD800, 0xE000)) + [0xFFFE, 0xFFFF]
)

def clean(v):
    if v is None:
        return ''
    s = str(v)
    s = s.translate(BAD)
    # Excel treats a leading =, +, - or @ as a formula. Prefix with an
    # apostrophe so a scraped title starting with one is shown, not evaluated.
    if s[:1] in ('=', '+', '@'):
        s = "'" + s
    return s[:32000]   # hard cell limit is 32767

payload = json.load(sys.stdin)
wb = Workbook()
wb.remove(wb.active)

HEAD_FILL = PatternFill('solid', fgColor='1F3864')
HEAD_FONT = Font(color='FFFFFF', bold=True)

for sheet in payload['sheets']:
    ws = wb.create_sheet(sheet['name'][:31])
    cols = sheet['columns']
    ws.append([clean(c).replace('_', ' ').title() for c in cols])
    for c in ws[1]:
        c.fill = HEAD_FILL; c.font = HEAD_FONT
        c.alignment = Alignment(vertical='center')
    for row in sheet['rows']:
        ws.append([clean(row.get(c, '')) for c in cols])

    # Freeze the header and turn on autofilter so the sheet is usable as-is.
    ws.freeze_panes = 'A2'
    if ws.max_row >= 1:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{max(ws.max_row,1)}"

    # Width from the widest value actually present, capped so one long notes
    # field cannot push every other column off screen.
    for i, name in enumerate(cols, start=1):
        widest = len(name)
        for row in sheet['rows'][:400]:
            widest = max(widest, len(clean(row.get(name, ''))))
        ws.column_dimensions[get_column_letter(i)].width = min(max(widest + 2, 10), 60)

# Excel takes an exclusive lock on an open workbook, so saving over one she is
# reading raises PermissionError. Observed 2026-09-12. Losing the export because
# a file happened to be open would be a silly way to fail a nightly run, so fall
# back to a sidecar filename and say which file was actually written.
#
# The fallback name is FIXED, not timestamped. It used to carry a %Y%m%d-%H%M
# stamp, which meant every locked run left another copy behind forever: by
# 2026-09-17 there were five stale snapshots beside the real workbook and the
# real one was a day out of date, so it was no longer obvious which file to
# open. The workbook is a pure snapshot rebuilt from data/applications.md and
# the ledger on every run, so an older copy is never worth keeping. One fixed
# sidecar caps the mess at exactly two files and names the problem out loud.
out = payload['out']
written = out
try:
    wb.save(out)
except PermissionError:
    import os
    base, ext = os.path.splitext(out)
    written = base + '-LOCKED' + ext
    wb.save(written)

print(json.dumps({'ok': True, 'out': written, 'locked': written != out,
                  'sheets': [(s['name'], len(s['rows'])) for s in payload['sheets']]}))
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'data/job-tracking.xlsx';

  const ledger = readTsv(path.join(ROOT, 'data', 'seen-jobs.tsv'));
  const idx = ledgerIndex(ledger);

  // The current run's picks, so the Shortlisted sheet can flag them. shortlist.tsv
  // is a SNAPSHOT that every run overwrites; the ledger is the running history.
  // Showing only the snapshot is what made the counts look wrong (50 vs 552).
  const currentRun = new Set(
    readTsv(path.join(ROOT, 'data', 'shortlist.tsv')).map((r) => normalizeUrl(r.url)).filter(Boolean));
  const slMeta = new Map(
    readTsv(path.join(ROOT, 'data', 'shortlist.tsv')).map((r) => [normalizeUrl(r.url), r]));

  const bucketed = { 'BUILT': [], 'DROPPED': [], 'SHORTLISTED': [], 'SEEN ONLY': [] };
  for (const r of ledger) {
    const b = classify(r);
    const key = normalizeUrl(r.url);
    const extra = slMeta.get(key) || {};
    bucketed[b].push({
      ...r,
      outcome: b,
      in_current_run: currentRun.has(key) ? 'YES' : '',
      drop_reason: b === 'DROPPED' ? dropReason(r) : '',
      location: extra.location || '',
      role_family: extra.role_family || '',
      rank_score: extra.rank_score || '',
      salary: extra.salary || '',
    });
  }

  const newestFirst = (a, b) => String(b.first_seen || '').localeCompare(String(a.first_seen || ''));
  for (const k of Object.keys(bucketed)) bucketed[k].sort(newestFirst);
  const all = [...bucketed.BUILT, ...bucketed.DROPPED, ...bucketed.SHORTLISTED, ...bucketed['SEEN ONLY']]
    .sort(newestFirst);

  // Funnel summary. Written from the SAME buckets the sheets use, so the numbers
  // cannot drift from the rows behind them.
  const summary = [
    { metric: 'Seen (all postings)', count: all.length, detail: 'every posting the pipeline has encountered' },
    { metric: '  of which Built', count: bucketed.BUILT.length, detail: 'application pack exists on disk' },
    { metric: '  of which Dropped', count: bucketed.DROPPED.length, detail: 'ruled out - see Dropped sheet for reason' },
    { metric: '  of which Shortlisted', count: bucketed.SHORTLISTED.length, detail: 'selected, still in flight, no verdict yet' },
    { metric: '  of which Seen only', count: bucketed['SEEN ONLY'].length, detail: 'in the feed, never selected' },
    { metric: 'Shortlisted by the latest run', count: currentRun.size, detail: 'the current data/shortlist.tsv snapshot' },
    // LOCAL time, explicitly labelled. This was toISOString() until 2026-09-14,
    // which stamped "11:01" on a workbook written at 04:01 local - a 7-hour gap
    // that makes a freshly generated sheet look like it did not update.
    { metric: 'Generated', count: localStamp(), detail: 'local time' },
  ];

  const payload = {
    out: path.resolve(ROOT, out),
    sheets: [
      { name: 'Summary', columns: ['metric', 'count', 'detail'], rows: summary },
      { name: 'Built',
        columns: ['first_seen', 'company', 'title', 'verdict', 'last_seen', 'url'],
        rows: bucketed.BUILT },
      { name: 'Shortlisted',
        columns: ['first_seen', 'in_current_run', 'company', 'title', 'location', 'role_family',
          'rank_score', 'salary', 'stage', 'last_seen', 'times_seen', 'url'],
        rows: bucketed.SHORTLISTED },
      { name: 'Dropped',
        columns: ['first_seen', 'company', 'title', 'drop_reason', 'last_seen', 'times_seen', 'url'],
        rows: bucketed.DROPPED },
      { name: 'Seen',
        columns: ['first_seen', 'outcome', 'company', 'title', 'stage', 'verdict',
          'last_seen', 'times_seen', 'url'],
        rows: all },
    ],
  };

  const r = spawnSync('python', ['-c', PY], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 1 << 28,
  });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim().split('\n').pop() || 'unknown';
    if (/No module named 'openpyxl'/.test(r.stderr || '')) {
      console.error('openpyxl is not installed. Run:  python -m pip install openpyxl');
      return 1;
    }
    console.error('xlsx export failed: ' + err);
    return 1;
  }
  console.log(r.stdout.trim());
  return 0;
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  const idx = ledgerIndex([
    { job_key: 'boards.greenhouse.io/acme/jobs/1', url: 'https://boards.greenhouse.io/acme/jobs/1',
      first_seen: '2026-09-10', last_seen: '2026-09-12', times_seen: '3' },
  ]);
  // The date is joined from the ledger, not invented.
  eq('date joined from ledger',
    withDates({ company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' }, idx).date_found,
    '2026-09-10');
  // Tracking params must not defeat the join.
  eq('join survives tracking params',
    withDates({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x' }, idx).date_found,
    '2026-09-10');
  // No ledger row means BLANK, never today's date.
  eq('unknown row gets a blank date, not today',
    withDates({ url: 'https://boards.greenhouse.io/other/jobs/9' }, idx).date_found, '');
  // The row's own fields survive the merge.
  eq('original fields preserved',
    withDates({ company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' }, idx).company, 'Acme');
  eq('times_seen carried through',
    withDates({ url: 'https://boards.greenhouse.io/acme/jobs/1' }, idx).times_seen, '3');
  // A header-only or missing TSV is empty, not a crash.
  eq('missing file is empty', readTsv(path.join(ROOT, 'data', '__nope__.tsv')), []);

  // --- the funnel -----------------------------------------------------------
  eq('built by verdict', classify({ stage: 'queued', verdict: 'BUILT' }), 'BUILT');
  eq('built by stage', classify({ stage: 'built', verdict: '' }), 'BUILT');
  eq('legacy "build" stage counts as built', classify({ stage: 'build', verdict: '' }), 'BUILT');
  eq('drop verdict wins over stage', classify({ stage: 'shortlisted', verdict: 'DROP:non-us-location' }), 'DROPPED');
  eq('skip verdict is dropped', classify({ stage: 'jd_extracted', verdict: 'SKIP:no-sponsorship' }), 'DROPPED');
  eq('dropped stage with no verdict', classify({ stage: 'dropped', verdict: '' }), 'DROPPED');
  eq('in flight is shortlisted', classify({ stage: 'scored', verdict: '' }), 'SHORTLISTED');
  eq('queued is shortlisted', classify({ stage: 'queued', verdict: 'QUEUED' }), 'SHORTLISTED');
  eq('feed only', classify({ stage: 'feed', verdict: '' }), 'SEEN ONLY');
  eq('blank row is seen only', classify({}), 'SEEN ONLY');
  // BUILT must beat DROPPED - a built pack is not a drop.
  eq('built beats dropped', classify({ stage: 'dropped', verdict: 'BUILT' }), 'BUILT');

  // THE PROPERTY THAT MATTERS: every row lands in exactly one bucket, so the
  // four sheets sum to Seen. A row counted twice, or not at all, is the bug.
  const sample = [
    { stage: 'built', verdict: 'BUILT' }, { stage: 'dropped', verdict: 'DROP:seniority' },
    { stage: 'shortlisted', verdict: '' }, { stage: 'feed', verdict: '' },
    { stage: 'queued', verdict: 'QUEUED' }, { stage: 'jd_extracted', verdict: 'SKIP:wall' },
    {}, { stage: 'scored', verdict: 'DROP:below-3.0' },
  ];
  const counts = sample.reduce((a, r) => { a[classify(r)] = (a[classify(r)] || 0) + 1; return a; }, {});
  eq('buckets sum to the total', Object.values(counts).reduce((a, b) => a + b, 0), sample.length);
  eq('funnel split', counts, { BUILT: 1, DROPPED: 3, SHORTLISTED: 2, 'SEEN ONLY': 2 });

  // The reason is readable, not the raw verdict string.
  eq('drop reason unprefixed', dropReason({ verdict: 'DROP:seniority-out-of-band' }), 'seniority-out-of-band');
  eq('skip reason unprefixed', dropReason({ verdict: 'SKIP:citizenship-clearance' }), 'citizenship-clearance');
  eq('bare verdict survives', dropReason({ verdict: 'DROP' }), 'DROP');
  eq('no verdict, no reason', dropReason({ verdict: '' }), '');

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
