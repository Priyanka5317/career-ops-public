#!/usr/bin/env node
/**
 * nightly-seen.mjs — the seen-jobs ledger. ZERO tokens.
 *
 * WHY THIS EXISTS
 *
 * Her instruction, 2026-09-09: "when running the job boards or github repos,
 * remember the jobs already read, don't waste in reading the job id again."
 *
 * The old pipeline had no memory of individual POSTINGS. It remembered
 * employers (data/visa-cache.tsv, 90 days) and finished packs (a folder in
 * output/), and nothing else. So every run re-pulled the same 1,133 feed rows
 * and re-extracted JDs it had already extracted. The 2026-09-09 run spent its
 * entire budget re-doing the 2026-09-08 run's work.
 *
 * WHAT IS EXPENSIVE TO REPEAT
 *
 * Not the feed pull - that is four raw.githubusercontent fetches and costs no
 * tokens. What costs real budget, in order:
 *   1. JD extraction  - an agent fetching and reading a posting page
 *   2. the visa gate  - an agent plus up to 4 web lookups
 *   3. scoring        - the A-G evaluation, on the orchestrator
 * So the ledger's job is to make sure a posting that already reached any of
 * those stages, or that already got a terminal verdict, is never sent through
 * them twice.
 *
 * TERMINAL vs OPEN
 *
 * A TERMINAL verdict means the answer cannot change tonight: it was dropped by
 * a gate, walled by the visa check, or fully built. Those are never reprocessed.
 * An OPEN row (seen in the feed, not yet ruled on) stays a live candidate - it
 * is still eligible, it just does not need re-extracting if the JD is on disk.
 *
 * Identity is the normalized posting URL, falling back to company::title when a
 * source gives no usable URL. Query strings are dropped EXCEPT the params that
 * actually carry the job id (gh_jid, jobId, pid, ...), because stripping those
 * would collapse every req on a shared board into one key.
 *
 * Usage:
 *   node nightly-seen.mjs --filter data/job-feed.tsv --out data/job-feed.new.tsv
 *   node nightly-seen.mjs --filter data/shortlist.tsv --json
 *   node nightly-seen.mjs --record data/shortlist.tsv --stage jd_extracted
 *   node nightly-seen.mjs --record data/x.tsv --stage scored --verdict "DROP:below-3.0"
 *   node nightly-seen.mjs --record data/terminal-drops.tsv --stage dropped \
 *        --verdict-from drop_reason --verdict-prefix "DROP:"   # per-row reason
 *   node nightly-seen.mjs --stats
 *   node nightly-seen.mjs --prune --days 45
 *   node nightly-seen.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(ROOT, 'data', 'seen-jobs.tsv');

export const COLUMNS = ['job_key', 'company', 'title', 'url', 'stage', 'verdict',
  'first_seen', 'last_seen', 'times_seen', 'note'];

/**
 * How far a posting got. Ordered: a later stage never regresses to an earlier
 * one, so a re-seen row keeps the best stage it ever reached.
 */
export const STAGES = ['feed', 'shortlisted', 'jd_extracted', 'visa_gated', 'scored', 'queued', 'built', 'dropped'];

export function stageRank(s) {
  const i = STAGES.indexOf(String(s || '').trim());
  return i < 0 ? 0 : i;
}

/**
 * Query params that ARE the job id. Everything else in the query string is
 * tracking noise and gets dropped, so the same req arriving from two sources
 * with different utm tags resolves to one key.
 */
const ID_PARAMS = new Set(['gh_jid', 'gh_src_id', 'jobid', 'job_id', 'id', 'pid', 'jid',
  'req', 'reqid', 'requisitionid', 'jobpostingid', 'postingid', 'currentjobid', 'jobreqid']);

/** Canonical posting identity. */
export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/[)\]>,.;]+$/, '');            // trailing punctuation from markdown tables
  let u;
  try { u = new URL(s); } catch { return s.toLowerCase(); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let pathname = u.pathname.replace(/\/+$/, '');
  const keep = [];
  for (const [k, v] of u.searchParams) {
    if (ID_PARAMS.has(k.toLowerCase()) && v) keep.push(k.toLowerCase() + '=' + v.toLowerCase());
  }
  keep.sort();
  return host + pathname.toLowerCase() + (keep.length ? '?' + keep.join('&') : '');
}

export function jobKey(row) {
  const u = normalizeUrl(row && row.url);
  if (u) return u;
  const co = String((row && row.company) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ti = String((row && row.title) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return co && ti ? co + '::' + ti : '';
}

/**
 * A verdict is TERMINAL when tonight's run cannot change it. `DROP:`, `SKIP:`
 * and `BUILT` are terminal; a bare stage with no verdict is not.
 *
 * NOTE deliberately excluded: `QUEUED`. A posting queued for the 9am build must
 * still be visible to the build phase, so it is never filtered out.
 */
export function isTerminal(verdict) {
  const v = String(verdict || '').trim().toUpperCase();
  if (!v) return false;
  return v.startsWith('DROP:') || v.startsWith('SKIP:') || v === 'BUILT' || v === 'DROP' || v === 'SKIP';
}

/* -------------------------------------------------------------------- io */

export function parseLedger(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return map;
  const header = lines[0].split('\t');
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i] ?? ''; });
    if (o.job_key) map.set(o.job_key, o);
  }
  return map;
}

export function serializeLedger(map) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const rows = [...map.values()].sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  return [COLUMNS.join('\t'), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join('\t'))].join('\n') + '\n';
}

export function loadLedger(p = LEDGER) {
  return existsSync(p) ? parseLedger(readFileSync(p, 'utf8')) : new Map();
}

/**
 * Atomic write, with a retry loop around the rename.
 *
 * On Windows the rename step fails with EPERM whenever anything else holds a
 * transient handle on the target - Defender's real-time scan of the freshly
 * written .tmp is the usual culprit, and a second process touching the ledger
 * will do it too. It is a race, not a permissions problem: the identical call
 * succeeds moments later.
 *
 * Observed 2026-09-12 15:09 - "Record terminal drops in ledger" died with
 * `EPERM: operation not permitted, rename data/seen-jobs.tsv.tmp ->
 * data/seen-jobs.tsv` and lost that run's 20 drop records. Re-running by hand
 * immediately afterwards worked first time.
 *
 * Retries are synchronous by design: this is called from CLI paths that are not
 * async, and the whole budget is under a second.
 */
function writeAtomic(p, text, attempts = 8) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp.' + process.pid;   // pid-scoped: two runs cannot collide on one temp name
  writeFileSync(tmp, text);

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { renameSync(tmp, p); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') break;
      // Busy-wait briefly. Atomics.wait needs a shared buffer; this is simpler
      // and the total worst case is ~1.8s.
      const until = Date.now() + Math.min(50 * (i + 1), 400);
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Last resort: a non-atomic overwrite still beats losing the run's records.
  try {
    writeFileSync(p, text);
    try { unlinkSync(tmp); } catch { /* leave the temp behind rather than fail */ }
    return;
  } catch { /* fall through to the original error */ }
  throw lastErr;
}

export function saveLedger(map, p = LEDGER) {
  writeAtomic(p, serializeLedger(map));
}

/* ---------------------------------------------------------------- operations */

/**
 * Record that a posting reached a stage. Never regresses the stage, never
 * overwrites a terminal verdict with a weaker one, and counts repeat sightings
 * so a posting that keeps reappearing is visible in --stats.
 */
export function record(map, row, { stage = 'feed', verdict = '', note = '', today = null } = {}) {
  const key = jobKey(row);
  if (!key) return null;
  const day = today || new Date().toISOString().slice(0, 10);
  const prev = map.get(key);

  if (!prev) {
    const entry = {
      job_key: key,
      company: row.company || '',
      title: row.title || '',
      url: row.url || '',
      stage,
      verdict,
      first_seen: day,
      last_seen: day,
      times_seen: '1',
      note,
    };
    map.set(key, entry);
    return entry;
  }

  prev.last_seen = day;
  prev.times_seen = String((parseInt(prev.times_seen, 10) || 0) + 1);
  if (stageRank(stage) > stageRank(prev.stage)) prev.stage = stage;
  // A terminal verdict is sticky: a later loose sighting must not clear it.
  if (verdict && !isTerminal(prev.verdict)) prev.verdict = verdict;
  if (note) prev.note = note;
  if (!prev.company && row.company) prev.company = row.company;
  if (!prev.title && row.title) prev.title = row.title;
  if (!prev.url && row.url) prev.url = row.url;
  return prev;
}

/** Should this row be skipped as already-answered? */
export function isAnswered(map, row) {
  const e = map.get(jobKey(row));
  return !!(e && isTerminal(e.verdict));
}

/**
 * Split rows into the ones still worth spending budget on and the ones the
 * ledger has already answered.
 */
export function filterUnseen(map, rows) {
  const fresh = [];
  const skipped = [];
  for (const r of rows) {
    const e = map.get(jobKey(r));
    if (e && isTerminal(e.verdict)) skipped.push({ ...r, seen_verdict: e.verdict, seen_on: e.last_seen });
    else fresh.push(r);
  }
  return { fresh, skipped };
}

/** Drop rows not seen for `days`, so the ledger cannot grow without bound. */
export function prune(map, days, today = null) {
  const now = today ? new Date(today) : new Date();
  let removed = 0;
  for (const [k, e] of [...map]) {
    // A BUILT row is permanent: she applied, and it must never resurface.
    if (String(e.verdict).toUpperCase() === 'BUILT') continue;
    const last = new Date(e.last_seen || e.first_seen || 0);
    if (!Number.isFinite(last.getTime())) continue;
    if ((now - last) / 86400000 > days) { map.delete(k); removed++; }
  }
  return removed;
}

/* ------------------------------------------------------------------ tsv help */

function readTsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i] ?? ''; });
    return o;
  });
  return { header, rows };
}

function writeTsv(header, rows) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return [header.join('\t'), ...rows.map((r) => header.map((h) => esc(r[h])).join('\t'))].join('\n') + '\n';
}

/* ------------------------------------------------------------------- selftest */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  // --- url normalization
  eq('strips utm noise',
    normalizeUrl('https://jobs.lever.co/acme/123?utm_source=x&utm_medium=y'), 'jobs.lever.co/acme/123');
  eq('keeps the greenhouse job id',
    normalizeUrl('https://boards.greenhouse.io/acme/jobs/1?gh_jid=99&utm_source=z'), 'boards.greenhouse.io/acme/jobs/1?gh_jid=99');
  eq('www and trailing slash and case collapse',
    normalizeUrl('https://WWW.Example.com/Jobs/42/'), 'example.com/jobs/42');
  eq('two sources, same req, one key',
    normalizeUrl('https://x.com/j/1?utm_source=simplify') === normalizeUrl('https://x.com/j/1?utm_source=zapply'), true);
  eq('different reqs on one board stay distinct',
    normalizeUrl('https://x.com/j?jobId=1') === normalizeUrl('https://x.com/j?jobId=2'), false);
  eq('markdown trailing paren stripped',
    normalizeUrl('https://x.com/j/1)'), 'x.com/j/1');
  eq('falls back to company::title with no url',
    jobKey({ company: 'Acme Corp', title: 'Data Analyst' }), 'acmecorp::dataanalyst');

  // --- record / stage monotonicity
  const m = new Map();
  record(m, { company: 'A', title: 'Data Analyst', url: 'https://a.com/1' }, { stage: 'feed', today: '2026-09-09' });
  eq('first sighting counted', m.get('a.com/1').times_seen, '1');
  record(m, { company: 'A', title: 'Data Analyst', url: 'https://a.com/1?utm_source=q' }, { stage: 'jd_extracted', today: '2026-09-10' });
  eq('re-sighting increments', m.get('a.com/1').times_seen, '2');
  eq('stage advances', m.get('a.com/1').stage, 'jd_extracted');
  record(m, { url: 'https://a.com/1' }, { stage: 'feed', today: '2026-09-11' });
  eq('stage never regresses', m.get('a.com/1').stage, 'jd_extracted');
  eq('last_seen updates', m.get('a.com/1').last_seen, '2026-09-11');
  eq('first_seen is stable', m.get('a.com/1').first_seen, '2026-09-09');

  // --- terminal verdicts
  eq('DROP is terminal', isTerminal('DROP:over-2-years-experience'), true);
  eq('SKIP is terminal', isTerminal('SKIP:no-sponsorship'), true);
  eq('BUILT is terminal', isTerminal('BUILT'), true);
  eq('QUEUED is NOT terminal', isTerminal('QUEUED'), false);
  eq('blank is not terminal', isTerminal(''), false);

  record(m, { url: 'https://a.com/1' }, { verdict: 'SKIP:no-sponsorship', today: '2026-09-11' });
  eq('terminal verdict recorded', m.get('a.com/1').verdict, 'SKIP:no-sponsorship');
  record(m, { url: 'https://a.com/1' }, { verdict: 'QUEUED', today: '2026-09-12' });
  eq('terminal verdict is sticky', m.get('a.com/1').verdict, 'SKIP:no-sponsorship');

  // --- filtering is the whole point
  const feed = [
    { company: 'A', title: 'Data Analyst', url: 'https://a.com/1' },              // terminal SKIP
    { company: 'B', title: 'Data Engineer', url: 'https://b.com/2' },             // never seen
    { company: 'C', title: 'AI Engineer', url: 'https://c.com/3?utm_campaign=x' },// seen, still open
  ];
  record(m, { url: 'https://c.com/3' }, { stage: 'feed', today: '2026-09-11' });
  const f = filterUnseen(m, feed);
  eq('answered rows filtered out', f.fresh.map((r) => r.company), ['B', 'C']);
  eq('skipped row carries its verdict', f.skipped[0].seen_verdict, 'SKIP:no-sponsorship');
  eq('an OPEN sighting is still a live candidate', f.fresh.some((r) => r.company === 'C'), true);

  // --- round trip
  const rt = parseLedger(serializeLedger(m));
  eq('ledger round trips', rt.get('a.com/1').verdict, 'SKIP:no-sponsorship');
  eq('ledger keeps every row', rt.size, m.size);

  // --- prune
  const p = new Map();
  record(p, { url: 'https://old.com/1' }, { stage: 'feed', today: '2026-07-01' });
  record(p, { url: 'https://new.com/2' }, { stage: 'feed', today: '2026-09-08' });
  record(p, { url: 'https://built.com/3' }, { verdict: 'BUILT', today: '2026-06-01' });
  eq('prune drops the stale row', prune(p, 45, '2026-09-09'), 1);
  eq('prune keeps the recent row', p.has('new.com/2'), true);
  eq('prune NEVER drops a BUILT row', p.has('built.com/3'), true);

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/* ---------------------------------------------------------------------- main */

function parseArgs(argv) {
  const a = { filter: null, record: null, out: null, stage: 'feed', verdict: '', note: '',
    stats: false, prune: false, days: 45, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--self-test') a.selfTest = true;
    else if (v === '--stats') a.stats = true;
    else if (v === '--prune') a.prune = true;
    else if (v === '--json') a.json = true;
    else if (v === '--filter') a.filter = argv[++i];
    else if (v.startsWith('--filter=')) a.filter = v.slice(9);
    else if (v === '--record') a.record = argv[++i];
    else if (v.startsWith('--record=')) a.record = v.slice(9);
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
    else if (v === '--stage') a.stage = argv[++i];
    else if (v.startsWith('--stage=')) a.stage = v.slice(8);
    else if (v === '--verdict-from') a.verdictFrom = argv[++i];
    else if (v.startsWith('--verdict-from=')) a.verdictFrom = v.slice(15);
    else if (v === '--verdict-prefix') a.verdictPrefix = argv[++i];
    else if (v.startsWith('--verdict-prefix=')) a.verdictPrefix = v.slice(17);
    else if (v === '--verdict') a.verdict = argv[++i];
    else if (v.startsWith('--verdict=')) a.verdict = v.slice(10);
    else if (v === '--note') a.note = argv[++i];
    else if (v === '--days') a.days = parseInt(argv[++i], 10);
    else if (v.startsWith('--days=')) a.days = parseInt(v.slice(7), 10);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const map = loadLedger();

  if (args.stats) {
    const byStage = {}, byVerdict = {};
    let terminal = 0, repeats = 0;
    for (const e of map.values()) {
      byStage[e.stage || 'feed'] = (byStage[e.stage || 'feed'] || 0) + 1;
      const v = e.verdict ? String(e.verdict).split(':')[0].toUpperCase() : 'open';
      byVerdict[v] = (byVerdict[v] || 0) + 1;
      if (isTerminal(e.verdict)) terminal++;
      if ((parseInt(e.times_seen, 10) || 0) > 1) repeats++;
    }
    console.log(JSON.stringify({
      ledger: path.relative(ROOT, LEDGER),
      postings_tracked: map.size,
      terminal_never_reprocessed: terminal,
      seen_more_than_once: repeats,
      by_stage: byStage,
      by_verdict: byVerdict,
    }, null, 2));
    return 0;
  }

  if (args.prune) {
    const removed = prune(map, args.days);
    saveLedger(map);
    console.log('pruned ' + removed + ' rows not seen in ' + args.days + ' days; ' + map.size + ' remain');
    return 0;
  }

  if (args.filter) {
    const p = path.resolve(ROOT, args.filter);
    if (!existsSync(p)) { console.error('missing ' + args.filter); return 1; }
    const { header, rows } = readTsv(readFileSync(p, 'utf8'));
    const { fresh, skipped } = filterUnseen(map, rows);
    const summary = {
      input: args.filter,
      rows_in: rows.length,
      already_answered_skipped: skipped.length,
      rows_out: fresh.length,
      tokens_saved_on: [...new Set(skipped.map((s) => String(s.seen_verdict).split(':')[0]))],
    };
    const outPath = args.out ? path.resolve(ROOT, args.out) : p;
    writeAtomic(outPath, writeTsv(header, fresh));
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.error(JSON.stringify(summary, null, 2));
      console.error('wrote ' + fresh.length + ' unanswered rows -> ' + path.relative(ROOT, outPath));
    }
    return 0;
  }

  if (args.record) {
    const p = path.resolve(ROOT, args.record);
    if (!existsSync(p)) { console.error('missing ' + args.record); return 1; }
    const { rows } = readTsv(readFileSync(p, 'utf8'));
    let n = 0;
    // --verdict-from takes the verdict from a COLUMN, so one call can record
    // many different reasons. Without it every structural drop collapsed to a
    // single flat string: on 2026-09-12 the ledger held 22,028 rows all reading
    // "DROP:structural", and the actual reason (seniority-out-of-band,
    // non-us-location, ...) was thrown away at the point of writing.
    for (const r of rows) {
      let verdict = args.verdict;
      if (args.verdictFrom) {
        const cell = String(r[args.verdictFrom] ?? '').trim();
        if (cell) verdict = (args.verdictPrefix || '') + cell;
      }
      if (record(map, r, { stage: args.stage, verdict, note: args.note })) n++;
    }
    saveLedger(map);
    console.log('recorded ' + n + ' rows at stage=' + args.stage + (args.verdict ? ' verdict=' + args.verdict : '') + '; ledger now ' + map.size);
    return 0;
  }

  console.error('nothing to do - pass --filter, --record, --stats, --prune or --self-test');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
