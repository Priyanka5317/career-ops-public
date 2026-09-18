#!/usr/bin/env node
/**
 * nightly-boards.mjs — the board rotation. ZERO tokens.
 *
 * WHY THIS EXISTS
 *
 * `job-scraper.md` Step 2 used to say: "for companies in company-universe.tsv
 * that the repos did not cover, hit their boards directly." No ceiling. One
 * agent, up to 462 boards, every response landing in its context. Meanwhile
 * config/nightly.yml capped the CHEAP end of the funnel (10 postings to the
 * visa gate, 4 packs) and left the expensive end wide open. That is why the
 * 2026-09-08 run spent the whole session budget in 27 minutes.
 *
 * Now the agent is handed a fixed queue of already-resolved boards, with the
 * API URL precomputed, and may not fetch anything outside it.
 *
 * WHAT IT DOES
 *
 * 1. Orders the universe by industry `priority` (config/industries.yml), then
 *    first_seen, then company. Stable, so the rotation is reproducible.
 * 2. Takes the next `boards.per_run` slice from a persisted cursor, wrapping at
 *    the end and counting sweeps. Two runs a night at 80 each means a full
 *    462-company sweep every ~3 nights and NO run repeating the last one.
 * 3. Resolves each company's ATS. 339 of 462 rows were `ats: unknown` on
 *    2026-09-09 - 73% of her universe was unreachable, which is why the feed
 *    leaned entirely on the four public repos. Resolution is:
 *      a. infer the vendor from the careers_url (free, no network)
 *      b. probe greenhouse/ashby/lever job APIs by slug (plain HTTPS GET)
 *    Anything resolved is written back into company-universe.tsv, so the
 *    universe upgrades itself a little every night and stays upgraded.
 * 4. Writes data/board-queue.tsv - the ONLY boards the scraper may touch.
 *
 * Usage:
 *   node nightly-boards.mjs                 # take the next slice, probe, advance
 *   node nightly-boards.mjs --take 80
 *   node nightly-boards.mjs --peek          # show the next slice, change nothing
 *   node nightly-boards.mjs --no-probe      # rotation only, no network
 *   node nightly-boards.mjs --status        # cursor position and ATS coverage
 *   node nightly-boards.mjs --json
 *   node nightly-boards.mjs --reset
 *   node nightly-boards.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE = path.join(ROOT, 'data', 'company-universe.tsv');

/* ------------------------------------------------------------------ vendors */

/**
 * The three vendors with a public, unauthenticated, slug-addressable job API.
 * These are the only ones worth PROBING: everything else (Workday, iCIMS,
 * Dayforce, Oracle ORC, UltiPro, Taleo, Eightfold, Rippling) needs a tenant id
 * or a session that cannot be guessed from a company name. Those are resolved
 * by the mapper agent, not here.
 */
export const VENDORS = {
  greenhouse: {
    api: (s) => 'https://boards-api.greenhouse.io/v1/boards/' + s + '/jobs',
    board: (s) => 'https://boards.greenhouse.io/' + s,
    count: (j) => (Array.isArray(j && j.jobs) ? j.jobs.length : 0),
  },
  ashby: {
    api: (s) => 'https://api.ashbyhq.com/posting-api/job-board/' + s + '?includeCompensation=true',
    board: (s) => 'https://jobs.ashbyhq.com/' + s,
    count: (j) => (Array.isArray(j && j.jobs) ? j.jobs.length : 0),
  },
  lever: {
    api: (s) => 'https://api.lever.co/v0/postings/' + s + '?mode=json',
    board: (s) => 'https://jobs.lever.co/' + s,
    count: (j) => (Array.isArray(j) ? j.length : 0),
  },
};

/**
 * Vendors recognisable from the careers_url with no network call at all.
 * Only 2 of 339 unknown rows hit this on 2026-09-09 (the rest are vanity
 * pages), but it is free and it pays off as the mapper adds rows.
 */
export const URL_VENDOR = [
  [/boards\.greenhouse\.io|greenhouse\.io\/embed|job-boards\.greenhouse\.io/i, 'greenhouse'],
  [/jobs\.ashbyhq\.com|ashbyhq\.com/i, 'ashby'],
  [/jobs\.lever\.co|lever\.co/i, 'lever'],
  [/myworkdayjobs\.com|\.wd\d+\.myworkday/i, 'workday'],
  [/\.icims\.com/i, 'icims'],
  [/jobs\.smartrecruiters\.com|smartrecruiters\.com/i, 'smartrecruiters'],
  [/ats\.rippling\.com|rippling\.com\/.*jobs/i, 'rippling'],
  [/\.eightfold\.ai/i, 'eightfold'],
  [/dayforcehcm\.com/i, 'dayforce'],
  [/oraclecloud\.com|\/hcmUI\//i, 'oracle-orc'],
  [/\.ultipro\.com/i, 'ultipro'],
  [/\.taleo\.net/i, 'taleo'],
  [/apply\.workable\.com/i, 'workable'],
  [/\.bamboohr\.com/i, 'bamboohr'],
  [/jobs\.jobvite\.com/i, 'jobvite'],
];

/** ATS values the scraper can actually fetch a JD from. */
export const SCANNABLE = new Set([
  'greenhouse', 'ashby', 'lever', 'workday', 'icims', 'smartrecruiters',
  'rippling', 'eightfold', 'dayforce', 'oracle-orc', 'ultipro', 'taleo',
  'workable', 'bamboohr', 'jobvite',
]);

export function inferVendorFromUrl(url) {
  const u = String(url || '');
  if (!u) return null;
  for (const [re, vendor] of URL_VENDOR) if (re.test(u)) return vendor;
  return null;
}

/* -------------------------------------------------------------------- slugs */

const LEGAL_SUFFIX = /\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|pbc|lp|llp|gmbh|sa|s\.a|ag|nv|bv|holdings|group|technologies|technology|labs|systems)\b\.?/gi;

/**
 * Slug candidates to probe, best first. Capped at 3: each candidate costs one
 * GET per vendor, and the marginal hit rate past three is not worth the
 * wall-clock on 80 companies a run.
 *
 * The careers_url domain label is tried FIRST and it matters: the mapper's own
 * notes record that 10 of 29 rows tagged `ashby` on the seeding run carried a
 * vanity URL like https://vercel.com/careers, and "vercel" is exactly the slug.
 */
export function slugCandidates(company, careersUrl) {
  const out = [];
  const push = (s) => {
    const v = String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };

  // 1. domain label from the careers URL, unless the host IS an ATS host.
  const host = (String(careersUrl || '').match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
  if (host && !URL_VENDOR.some(([re]) => re.test(host))) {
    const parts = host.replace(/^www\./i, '').split('.');
    if (parts.length >= 2) push(parts[parts.length - 2]);
  }

  // 2. the company name, de-punctuated.
  const base = String(company || '')
    .replace(/&amp;/g, ' and ').replace(/&/g, ' and ')
    // Drop a parenthetical alias: "Cursor (Anysphere)" -> "Cursor".
    .replace(/\([^)]*\)/g, ' ');
  push(base.replace(/[^a-zA-Z0-9]/g, ''));

  // 3. the company name minus legal/filler suffixes.
  const stripped = base.replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  push(stripped.replace(/[^a-zA-Z0-9]/g, ''));

  return out.slice(0, 3);
}

/* ----------------------------------------------------------------- ordering */

/** industry name -> priority number, from config/industries.yml. */
export function industryPriorities(industriesYml) {
  const m = new Map();
  for (const e of (industriesYml && industriesYml.industries) || []) {
    const name = typeof e === 'string' ? e : e && e.name;
    if (!name) continue;
    const p = (typeof e === 'object' && Number(e.priority)) || 99;
    m.set(String(name), p);
  }
  return m;
}

/**
 * Stable rotation order: industry priority, then first_seen, then company.
 * Stability is the whole point - an unstable sort would make the cursor
 * meaningless and let a run repeat boards the previous run already did.
 */
export function orderUniverse(rows, priorities) {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = priorities.get(a.r.industry) ?? 99;
      const pb = priorities.get(b.r.industry) ?? 99;
      if (pa !== pb) return pa - pb;
      const fa = String(a.r.first_seen || '');
      const fb = String(b.r.first_seen || '');
      if (fa !== fb) return fa < fb ? -1 : 1;
      const ca = String(a.r.company || '').toLowerCase();
      const cb = String(b.r.company || '').toLowerCase();
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.i - b.i;              // original order breaks every remaining tie
    })
    .map((x) => x.r);
}

/**
 * `take` rows starting at `cursor`, wrapping around the end.
 * Returns the slice plus the next cursor and how many times it wrapped.
 */
export function sliceAt(ordered, cursor, take) {
  const n = ordered.length;
  if (!n) return { slice: [], next: 0, wrapped: 0 };
  const t = Math.min(take, n);
  const start = ((cursor % n) + n) % n;
  const slice = [];
  for (let k = 0; k < t; k++) slice.push(ordered[(start + k) % n]);
  const end = start + t;
  return { slice, next: end % n, wrapped: Math.floor(end / n) };
}

/* -------------------------------------------------------------------- tsv io */

export function readTsvRows(text) {
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

export function writeTsvRows(header, rows) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [header.join('\t'), ...rows.map((r) => header.map((h) => esc(r[h])).join('\t'))].join('\n') + '\n';
}

function loadYaml(p, fallback) {
  try { return existsSync(p) ? (yaml.load(readFileSync(p, 'utf8')) ?? fallback) : fallback; }
  catch { return fallback; }
}

/* ------------------------------------------------------------------ probing */

async function getJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        // A plain fetch with no UA gets 403d by several of these CDNs.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        accept: 'application/json,text/plain,*/*',
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    // A 200 is not success. Gem and ADP both return a content-free shell with
    // HTTP 200, so require parseable JSON before believing anything.
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * Resolve one company's ATS. Returns { ats, board_url, api_url, how } or null.
 * A vendor returning ZERO jobs means the wrong vendor, not that the company has
 * no openings - so keep trying the others (the mapper learned this the hard
 * way: 3 companies tagged `ashby` were actually on Greenhouse).
 */
export async function resolveBoard(row, opts) {
  const { vendors, timeoutMs } = opts;

  const fromUrl = inferVendorFromUrl(row.careers_url);
  if (fromUrl && SCANNABLE.has(fromUrl)) {
    return { ats: fromUrl, board_url: row.careers_url, api_url: '', how: 'url-pattern' };
  }

  const slugs = slugCandidates(row.company, row.careers_url);
  for (const slug of slugs) {
    for (const name of vendors) {
      const v = VENDORS[name];
      if (!v) continue;
      const j = await getJson(v.api(slug), timeoutMs);
      if (j && v.count(j) > 0) {
        return { ats: name, board_url: v.board(slug), api_url: v.api(slug), how: 'probe:' + slug, jobs: v.count(j) };
      }
    }
  }
  return null;
}

/** Bounded-concurrency map. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/** API URL for an already-known vendor, where the pattern is guessable. */
export function apiUrlFor(ats, boardUrl) {
  const slug = (String(boardUrl || '').match(/(?:greenhouse\.io|ashbyhq\.com|lever\.co)\/([^/?#]+)/i) || [])[1];
  if (!slug || !VENDORS[ats]) return '';
  return VENDORS[ats].api(slug);
}

/* ------------------------------------------------------------------- cursor */

function readCursor(p, universeRows) {
  if (!existsSync(p)) return { cursor: 0, sweep: 1, universe_rows: universeRows, runs: [] };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return {
      cursor: Number(j.cursor) || 0,
      sweep: Number(j.sweep) || 1,
      universe_rows: Number(j.universe_rows) || universeRows,
      runs: Array.isArray(j.runs) ? j.runs : [],
    };
  } catch { return { cursor: 0, sweep: 1, universe_rows: universeRows, runs: [] }; }
}

function writeJsonAtomic(p, obj) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, p);
}

function writeTextAtomic(p, text) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

/* ------------------------------------------------------------------- selftest */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  // --- slug candidates
  eq('slug from vanity careers url first',
    slugCandidates('Vercel', 'https://vercel.com/careers')[0], 'vercel');
  eq('slug ignores an ATS host as a domain label',
    slugCandidates('Scale AI', 'https://boards.greenhouse.io/scaleai'), ['scaleai']);
  eq('slug drops a parenthetical alias',
    slugCandidates('Cursor (Anysphere)', '')[0], 'cursor');
  eq('slug strips legal suffix as a second candidate',
    slugCandidates('Ramp Business Corporation', ''), ['rampbusinesscorporation', 'rampbusiness']);
  eq('slug handles ampersand', slugCandidates('Johnson & Johnson', '')[0], 'johnsonandjohnson');
  eq('slug caps at three', slugCandidates('A Very Long Company Name Inc', 'https://a.example.com/x').length <= 3, true);

  // --- url vendor inference
  eq('infer workable', inferVendorFromUrl('https://apply.workable.com/huggingface/'), 'workable');
  eq('infer workday', inferVendorFromUrl('https://cigna.wd5.myworkdayjobs.com/cignacareers'), 'workday');
  eq('infer greenhouse', inferVendorFromUrl('https://boards.greenhouse.io/scaleai'), 'greenhouse');
  eq('infer nothing from a vanity page', inferVendorFromUrl('https://www.epic.com/careers'), null);

  // --- ordering
  const prios = industryPriorities({ industries: [
    { name: 'AI-native software', priority: 1 },
    { name: 'Defense tech & aerospace', priority: 4 },
  ] });
  eq('priority map', [prios.get('AI-native software'), prios.get('Defense tech & aerospace')], [1, 4]);
  const ordered = orderUniverse([
    { company: 'Zeta', industry: 'Defense tech & aerospace', first_seen: '2026-09-07' },
    { company: 'Alpha', industry: 'AI-native software', first_seen: '2026-09-08' },
    { company: 'Beta', industry: 'AI-native software', first_seen: '2026-09-07' },
    { company: 'Gamma', industry: 'Unmapped industry', first_seen: '2026-09-07' },
  ], prios);
  eq('priority 1 sweeps first, then first_seen',
    ordered.map((r) => r.company), ['Beta', 'Alpha', 'Zeta', 'Gamma']);

  // --- rotation
  const u = Array.from({ length: 10 }, (_, i) => ({ company: 'c' + i }));
  const a = sliceAt(u, 0, 4);
  eq('first slice', a.slice.map((r) => r.company), ['c0', 'c1', 'c2', 'c3']);
  eq('cursor advances', a.next, 4);
  const b = sliceAt(u, a.next, 4);
  eq('second slice is DIFFERENT boards', b.slice.map((r) => r.company), ['c4', 'c5', 'c6', 'c7']);
  const c = sliceAt(u, b.next, 4);
  eq('third slice wraps', c.slice.map((r) => r.company), ['c8', 'c9', 'c0', 'c1']);
  eq('wrap counted', c.wrapped, 1);
  eq('take larger than universe is clamped', sliceAt(u, 0, 999).slice.length, 10);
  eq('empty universe is safe', sliceAt([], 0, 5), { slice: [], next: 0, wrapped: 0 });

  // A full sweep must cover every company exactly once, no gaps, no repeats.
  let cur = 0; const seen = [];
  for (let k = 0; k < 5; k++) { const s = sliceAt(u, cur, 2); seen.push(...s.slice.map((r) => r.company)); cur = s.next; }
  eq('a full sweep covers each company exactly once', seen.sort(), u.map((r) => r.company).sort());

  // --- tsv round trip preserves every column
  const rt = readTsvRows('company\tats\tnotes\nAcme\tunknown\thas, commas\n');
  eq('tsv parse', rt.rows[0], { company: 'Acme', ats: 'unknown', notes: 'has, commas' });
  rt.rows[0].ats = 'ashby';
  eq('tsv round trip', writeTsvRows(rt.header, rt.rows), 'company\tats\tnotes\nAcme\tashby\thas, commas\n');

  eq('api url for a known greenhouse board',
    apiUrlFor('greenhouse', 'https://boards.greenhouse.io/scaleai'),
    'https://boards-api.greenhouse.io/v1/boards/scaleai/jobs');

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/* ---------------------------------------------------------------------- main */

function parseArgs(argv) {
  const a = { take: 0, peek: false, probe: null, json: false, status: false, reset: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--self-test') a.selfTest = true;
    else if (v === '--peek') a.peek = true;
    else if (v === '--no-probe') a.probe = false;
    else if (v === '--probe') a.probe = true;
    else if (v === '--json') a.json = true;
    else if (v === '--status') a.status = true;
    else if (v === '--reset') a.reset = true;
    else if (v === '--take') a.take = parseInt(argv[++i], 10);
    else if (v.startsWith('--take=')) a.take = parseInt(v.slice(7), 10);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const cfg = loadYaml(path.join(ROOT, 'config', 'nightly.yml'), {});
  const boards = cfg.boards || {};
  const take = args.take > 0 ? args.take : (Number(boards.per_run) || 80);
  const cursorPath = path.join(ROOT, boards.cursor_file || 'data/board-cursor.json');
  const queuePath = path.join(ROOT, boards.queue_file || 'data/board-queue.tsv');
  const doProbe = args.probe === null ? boards.probe_unknown_ats !== false : args.probe;
  const vendors = Array.isArray(boards.probe_vendors) && boards.probe_vendors.length
    ? boards.probe_vendors : ['greenhouse', 'ashby', 'lever'];
  const timeoutMs = Number(boards.probe_timeout_ms) || 6000;
  const concurrency = Number(boards.probe_concurrency) || 6;
  const emitUnresolved = boards.emit_unresolved === true;

  if (!existsSync(UNIVERSE)) {
    console.error('missing data/company-universe.tsv - run the mapper first');
    return 1;
  }
  const { header, rows } = readTsvRows(readFileSync(UNIVERSE, 'utf8'));
  const priorities = industryPriorities(loadYaml(path.join(ROOT, 'config', 'industries.yml'), {}));
  const ordered = orderUniverse(rows, priorities);

  if (args.reset) {
    writeJsonAtomic(cursorPath, { cursor: 0, sweep: 1, universe_rows: rows.length, runs: [] });
    console.log('cursor reset to 0 of ' + rows.length);
    return 0;
  }

  const state = readCursor(cursorPath, rows.length);

  const coverage = {};
  for (const r of rows) coverage[r.ats || 'blank'] = (coverage[r.ats || 'blank'] || 0) + 1;
  const scannableNow = rows.filter((r) => SCANNABLE.has(r.ats)).length;

  if (args.status) {
    const out = {
      universe_rows: rows.length,
      cursor: state.cursor,
      sweep: state.sweep,
      pct_swept: Math.round((state.cursor / Math.max(1, rows.length)) * 1000) / 10,
      per_run: take,
      runs_per_full_sweep: Math.ceil(rows.length / take),
      scannable_now: scannableNow,
      ats_coverage: coverage,
      recent_runs: state.runs.slice(-6),
    };
    console.log(args.json ? JSON.stringify(out, null, 2) : JSON.stringify(out, null, 2));
    return 0;
  }

  const { slice, next, wrapped } = sliceAt(ordered, state.cursor, take);

  // Resolve. Already-scannable rows cost nothing; unknowns get one bounded
  // resolution attempt each.
  const needResolve = slice.filter((r) => !SCANNABLE.has(r.ats));
  const resolvedNow = new Map();
  let probed = 0;

  if (doProbe && !args.peek && needResolve.length) {
    const results = await pool(needResolve, concurrency, async (r) => {
      probed++;
      return { row: r, res: await resolveBoard(r, { vendors, timeoutMs }) };
    });
    for (const { row, res } of results) if (res) resolvedNow.set(row.company, res);
  }

  // Upgrade the universe in place so a resolution is never paid for twice.
  if (resolvedNow.size) {
    for (const r of rows) {
      const res = resolvedNow.get(r.company);
      if (!res) continue;
      r.ats = res.ats;
      r.careers_url = res.board_url || r.careers_url;
      const stamp = 'ats resolved ' + new Date().toISOString().slice(0, 10) + ' by nightly-boards (' + res.how + ')';
      r.notes = r.notes ? r.notes + ' | ' + stamp : stamp;
    }
    writeTextAtomic(UNIVERSE, writeTsvRows(header, rows));
  }

  // Build the queue the scraper is allowed to touch.
  const QUEUE_COLUMNS = ['company', 'legal_name', 'industry', 'ats', 'board_url', 'api_url', 'h1b_known', 'notes'];
  const queue = [];
  const unresolved = [];
  for (const r of slice) {
    const res = resolvedNow.get(r.company);
    const ats = res ? res.ats : r.ats;
    if (!SCANNABLE.has(ats)) { unresolved.push(r.company); if (!emitUnresolved) continue; }
    const boardUrl = res ? res.board_url : r.careers_url;
    queue.push({
      company: r.company,
      legal_name: r.legal_name,
      industry: r.industry,
      ats: SCANNABLE.has(ats) ? ats : 'needs_ats_discovery',
      board_url: boardUrl,
      api_url: (res && res.api_url) || apiUrlFor(ats, boardUrl),
      h1b_known: r.h1b_known,
      notes: res ? res.how : '',
    });
  }

  if (!args.peek) {
    writeTextAtomic(queuePath, writeTsvRows(QUEUE_COLUMNS, queue));
    state.runs.push({
      at: new Date().toISOString(),
      from: state.cursor, to: next, sweep: state.sweep,
      considered: slice.length, probed, resolved: resolvedNow.size, emitted: queue.length,
    });
    writeJsonAtomic(cursorPath, {
      cursor: next,
      sweep: state.sweep + wrapped,
      universe_rows: rows.length,
      runs: state.runs.slice(-20),
    });
  }

  const summary = {
    peek: args.peek,
    universe_rows: rows.length,
    slice: { from: state.cursor, to: next, size: slice.length, sweep: state.sweep, wrapped },
    industries_in_slice: [...new Set(slice.map((r) => r.industry))],
    probed,
    newly_resolved: resolvedNow.size,
    resolved_detail: [...resolvedNow.entries()].map(([c, v]) => c + ' -> ' + v.ats + ' (' + v.how + (v.jobs ? ', ' + v.jobs + ' jobs' : '') + ')'),
    emitted_boards: queue.length,
    unresolved_skipped: unresolved.length,
    scannable_universe_now: scannableNow + resolvedNow.size,
    queue_file: path.relative(ROOT, queuePath),
    runs_per_full_sweep: Math.ceil(rows.length / take),
  };

  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.error(JSON.stringify(summary, null, 2));
    console.error((args.peek ? 'PEEK (nothing written): ' : 'wrote ') + queue.length + ' boards -> ' + path.relative(ROOT, queuePath));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
