#!/usr/bin/env node
/**
 * nightly-harvest.mjs — pull EVERY open posting from every resolved board, in
 * this process, for ZERO tokens.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `nightly-boards.mjs` already resolves each company to a vendor `api_url` and
 * writes them to data/board-queue.tsv. Until now the ONLY consumer of that
 * queue was the `job-scraper` LLM agent: every board it opened landed in its
 * context, so board coverage was capped by a token budget and the run had to
 * settle for a slice.
 *
 * But those api_urls are plain JSON endpoints that return the company's FULL
 * job list. Fetching them here costs nothing, so there is no reason to sample.
 * Her instruction, 2026-09-10: "scrape as many jobs as possible. do not leave a
 * single entry level job that opens."
 *
 * So: harvest everything, write it to the normal feed, and let the existing
 * zero-token gates (seen-jobs ledger, then the title/level/years gates in
 * nightly-shortlist.mjs) do the narrowing. The agent then only ever sees
 * postings that already survived every cheap filter.
 *
 * SCOPE: by default this reads the WHOLE universe, not the rotation slice. The
 * rotation exists to ration expensive work; this work is free, so rationing it
 * would only lose postings.
 *
 *   node nightly-harvest.mjs                   # every scannable company
 *   node nightly-harvest.mjs --queue           # only data/board-queue.tsv
 *   node nightly-harvest.mjs --out data/x.tsv
 *   node nightly-harvest.mjs --self-test
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const UNIVERSE = path.join(ROOT, 'data', 'company-universe.tsv');
const QUEUE = path.join(ROOT, 'data', 'board-queue.tsv');
const OUT_DEFAULT = path.join(ROOT, 'data', 'board-feed.tsv');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export const FEED_COLS = ['source', 'sources', 'company', 'title', 'location', 'url',
  'posted_ts', 'age_days', 'sponsorship_hint', 'salary', 'category'];

/* ------------------------------------------------------------------ helpers */

function loadYaml(p, fallback) {
  try { return existsSync(p) ? (yaml.load(readFileSync(p, 'utf8')) ?? fallback) : fallback; }
  catch { return fallback; }
}

export function readTsvRows(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => { o[h] = c[i] === undefined ? '' : c[i]; });
    return o;
  });
  return { header, rows };
}

function writeTsv(cols, rows) {
  const out = [cols.join('\t')];
  for (const r of rows) out.push(cols.map((c) => clean(r[c])).join('\t'));
  return out.join('\n') + '\n';
}

/** Tabs and newlines would corrupt the TSV; a stray one has done it before. */
export function clean(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function writeAtomic(p, text) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

export function isoDay(v) {
  if (v === '' || v === null || v === undefined) return '';
  // epoch seconds or millis
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    let n = Number(v);
    if (n < 1e12) n *= 1000;                     // seconds -> millis
    const d = new Date(n);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function ageDays(isoDate, now = new Date()) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const days = (now.getTime() - d.getTime()) / 86400000;
  return (Math.round(Math.max(0, days) * 10) / 10).toFixed(1);
}

/* ------------------------------------------------------------------ vendors */

/**
 * One parser per vendor. Each takes the decoded JSON and returns
 * {title, url, location, posted} rows. Shapes were confirmed live on
 * 2026-09-10 against real boards rather than taken from docs.
 */
export const PARSERS = {
  greenhouse: (j) => (Array.isArray(j && j.jobs) ? j.jobs : []).map((x) => ({
    title: x.title,
    url: x.absolute_url,
    location: x.location && x.location.name,
    posted: x.updated_at || x.first_published,
  })),

  ashby: (j) => (Array.isArray(j && j.jobs) ? j.jobs : [])
    .filter((x) => x.isListed !== false)
    .map((x) => ({
      title: x.title,
      url: x.jobUrl || x.applyUrl,
      location: x.location,
      posted: x.publishedAt,
    })),

  lever: (j) => (Array.isArray(j) ? j : []).map((x) => ({
    title: x.text,
    url: x.hostedUrl || x.applyUrl,
    location: (x.categories && x.categories.location) || '',
    posted: x.createdAt,
  })),

  smartrecruiters: (j) => (Array.isArray(j && j.content) ? j.content : []).map((x) => {
    const l = x.location || {};
    const loc = [l.city, l.region, l.country].filter(Boolean).join(', ');
    const slug = (x.company && x.company.identifier) || '';
    return {
      title: x.name,
      url: x.ref || (slug ? `https://jobs.smartrecruiters.com/${slug}/${x.id}` : ''),
      location: loc,
      posted: x.releasedDate || x.createdOn,
    };
  }),

  recruitee: (j) => (Array.isArray(j && j.offers) ? j.offers : []).map((x) => ({
    title: x.title,
    url: x.careers_url || x.url,
    location: [x.city, x.country].filter(Boolean).join(', '),
    posted: x.published_at || x.created_at,
  })),
};

/** api_url builders, used when the universe row has a board_url but no api_url. */
export const API_FOR = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
  recruitee: (s) => `https://${s}.recruitee.com/api/offers/`,
};

/** Pull the vendor slug back out of a board or api URL. */
export function slugFromUrl(ats, url) {
  const u = String(url || '');
  const pats = {
    // The embed form carries the slug in a query param (`?for=`) and the path
    // segment is `embed`, so the generic path pattern must come LAST.
    greenhouse: [/greenhouse\.io\/v1\/boards\/([^/?#]+)/i, /greenhouse\.io\/[^?#]*[?&]for=([^&/?#]+)/i, /greenhouse\.io\/([^/?#]+)/i],
    ashby: [/ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i, /ashbyhq\.com\/([^/?#]+)/i],
    lever: [/lever\.co\/v0\/postings\/([^/?#]+)/i, /lever\.co\/([^/?#]+)/i],
    smartrecruiters: [/smartrecruiters\.com\/v1\/companies\/([^/?#]+)/i, /smartrecruiters\.com\/([^/?#]+)/i],
    recruitee: [/https?:\/\/([^.]+)\.recruitee\.com/i],
  }[ats] || [];
  for (const re of pats) {
    const m = u.match(re);
    if (m && m[1] && m[1] !== 'embed') return m[1];
  }
  return '';
}

export function apiUrlForRow(row) {
  if (row.api_url) return row.api_url;
  const ats = row.ats;
  if (!API_FOR[ats]) return '';
  const slug = slugFromUrl(ats, row.board_url) || slugFromUrl(ats, row.careers_url);
  return slug ? API_FOR[ats](slug) : '';
}

/* --------------------------------------------------------------------- fetch */

async function getJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
    });
    if (!res.ok) return { err: 'HTTP ' + res.status };
    const text = await res.text();
    try { return { json: JSON.parse(text) }; } catch { return { err: 'non-json' }; }
  } catch (e) {
    return { err: String((e && e.name) || e) };
  } finally { clearTimeout(timer); }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* -------------------------------------------------------------------- harvest */

export function rowsFromBoard(row, json, now = new Date()) {
  const parse = PARSERS[row.ats];
  if (!parse) return [];
  let raw = [];
  try { raw = parse(json) || []; } catch { return []; }
  const out = [];
  for (const r of raw) {
    const title = clean(r.title);
    const url = clean(r.url);
    if (!title || !url) continue;                 // a row with no URL cannot be deduped or applied to
    const posted = isoDay(r.posted);
    out.push({
      source: 'board:' + row.ats,
      sources: 'board:' + row.ats,
      company: clean(row.company),
      title,
      location: clean(r.location),
      url,
      posted_ts: posted,
      age_days: ageDays(posted, now),
      sponsorship_hint: '',                        // boards never state this; the visa gate decides
      salary: '',
      category: '',                                // nightly-shortlist classifies from the title
    });
  }
  return out;
}

function parseArgs(argv) {
  const a = { queue: false, out: '', concurrency: 0, timeout: 0, selfTest: false, json: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--queue') a.queue = true;
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--concurrency') a.concurrency = parseInt(argv[++i], 10);
    else if (v === '--timeout') a.timeout = parseInt(argv[++i], 10);
    else if (v === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (v === '--self-test') a.selfTest = true;
    else if (v === '--json') a.json = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const cfg = loadYaml(path.join(ROOT, 'config', 'nightly.yml'), {});
  const hv = cfg.harvest || {};
  const concurrency = args.concurrency || Number(hv.concurrency) || 8;
  const timeoutMs = args.timeout || Number(hv.timeout_ms) || 12000;
  const outPath = args.out ? path.resolve(ROOT, args.out) : OUT_DEFAULT;

  const srcPath = args.queue ? QUEUE : UNIVERSE;
  if (!existsSync(srcPath)) { console.error('missing ' + path.relative(ROOT, srcPath)); return 1; }
  const { rows } = readTsvRows(readFileSync(srcPath, 'utf8'));

  // Every row we can actually call an API for.
  let targets = rows
    .map((r) => ({ row: r, api: apiUrlForRow(r) }))
    .filter((t) => t.api && PARSERS[t.row.ats]);
  if (args.limit > 0) targets = targets.slice(0, args.limit);

  const skipped = rows.length - targets.length;
  console.error(`harvest: ${targets.length} callable boards of ${rows.length} rows in ${path.relative(ROOT, srcPath)} (${skipped} not callable)`);

  const now = new Date();
  const feed = [];
  const perVendor = {};
  const failures = [];
  let okBoards = 0;

  await pool(targets, concurrency, async (t) => {
    const { json, err } = await getJson(t.api, timeoutMs);
    if (err) { failures.push({ company: t.row.company, ats: t.row.ats, err }); return; }
    const got = rowsFromBoard(t.row, json, now);
    okBoards++;
    perVendor[t.row.ats] = (perVendor[t.row.ats] || 0) + got.length;
    for (const g of got) feed.push(g);
  });

  // Dedupe on URL inside this harvest; merge-feeds handles cross-feed identity.
  const seen = new Set();
  const deduped = feed.filter((r) => {
    const k = r.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  writeAtomic(outPath, writeTsv(FEED_COLS, deduped));

  const summary = {
    source: path.relative(ROOT, srcPath),
    rows_in_source: rows.length,
    callable_boards: targets.length,
    boards_ok: okBoards,
    boards_failed: failures.length,
    postings_harvested: feed.length,
    postings_after_dedupe: deduped.length,
    by_vendor: perVendor,
    out: path.relative(ROOT, outPath),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) {
    const byErr = {};
    for (const f of failures) byErr[f.err] = (byErr[f.err] || 0) + 1;
    console.error('failures by reason: ' + JSON.stringify(byErr));
    console.error('first 10: ' + failures.slice(0, 10).map((f) => f.company + '(' + f.ats + ':' + f.err + ')').join(', '));
  }
  return 0;
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL ' + name); } };

  // clean()
  ok('clean strips tabs', clean('a\tb') === 'a b');
  ok('clean strips newlines', clean('a\nb') === 'a b');
  ok('clean collapses spaces', clean('a    b') === 'a b');
  ok('clean handles null', clean(null) === '');

  // isoDay()
  ok('isoDay ISO', isoDay('2026-09-04T14:04:34-04:00') === '2026-09-04');
  ok('isoDay epoch ms', isoDay(1789058869000) === isoDay('2026-09-10T00:00:00Z') || isoDay(1789058869000).length === 10);
  ok('isoDay epoch s', isoDay(1789058869).length === 10);
  ok('isoDay blank', isoDay('') === '');
  ok('isoDay garbage', isoDay('not-a-date') === '');

  // ageDays()
  const now = new Date('2026-09-10T12:00:00Z');
  ok('ageDays same day', ageDays('2026-09-10', now) === '0.5');
  ok('ageDays week', ageDays('2026-09-03', now) === '7.5');
  ok('ageDays blank', ageDays('', now) === '');
  ok('ageDays never negative', Number(ageDays('2026-12-01', now)) === 0);

  // parsers
  const gh = PARSERS.greenhouse({ jobs: [{ title: 'Data Analyst', absolute_url: 'https://x/1', location: { name: 'SF' }, updated_at: '2026-09-01T00:00:00Z' }] });
  ok('greenhouse parses', gh.length === 1 && gh[0].title === 'Data Analyst' && gh[0].location === 'SF');
  const ash = PARSERS.ashby({ jobs: [
    { title: 'A', jobUrl: 'https://a', location: 'NY', publishedAt: '2026-09-01', isListed: true },
    { title: 'Hidden', jobUrl: 'https://h', isListed: false },
  ] });
  ok('ashby parses listed only', ash.length === 1 && ash[0].title === 'A');
  const lev = PARSERS.lever([{ text: 'L', hostedUrl: 'https://l', categories: { location: 'Austin' }, createdAt: 1700000000000 }]);
  ok('lever parses', lev.length === 1 && lev[0].title === 'L' && lev[0].location === 'Austin');
  const sr = PARSERS.smartrecruiters({ content: [{ name: 'S', ref: 'https://s', location: { city: 'Santa Clara', region: 'CA', country: 'us' }, releasedDate: '2026-09-01' }] });
  ok('smartrecruiters parses', sr.length === 1 && sr[0].location === 'Santa Clara, CA, us');
  const rec = PARSERS.recruitee({ offers: [{ title: 'R', careers_url: 'https://r', city: 'Boston', country: 'US' }] });
  ok('recruitee parses', rec.length === 1 && rec[0].location === 'Boston, US');
  ok('parser tolerates empty', PARSERS.greenhouse({}).length === 0 && PARSERS.lever(null).length === 0);

  // slugFromUrl()
  ok('slug greenhouse api', slugFromUrl('greenhouse', 'https://boards-api.greenhouse.io/v1/boards/lyft/jobs') === 'lyft');
  ok('slug greenhouse board', slugFromUrl('greenhouse', 'https://boards.greenhouse.io/upstart') === 'upstart');
  ok('slug greenhouse embed', slugFromUrl('greenhouse', 'https://job-boards.greenhouse.io/embed/job_app?for=uniteus') === 'uniteus');
  ok('slug ashby api', slugFromUrl('ashby', 'https://api.ashbyhq.com/posting-api/job-board/unit?x=1') === 'unit');
  ok('slug ashby board', slugFromUrl('ashby', 'https://jobs.ashbyhq.com/solace') === 'solace');
  ok('slug lever', slugFromUrl('lever', 'https://jobs.lever.co/acme') === 'acme');
  ok('slug recruitee', slugFromUrl('recruitee', 'https://gong.recruitee.com/api/offers/') === 'gong');
  ok('slug unknown vendor', slugFromUrl('workday', 'https://x.wd5.myworkdayjobs.com/y') === '');

  // apiUrlForRow()
  ok('api_url passthrough', apiUrlForRow({ ats: 'greenhouse', api_url: 'https://given' }) === 'https://given');
  ok('api_url derived', apiUrlForRow({ ats: 'greenhouse', board_url: 'https://boards.greenhouse.io/zzz' })
    === 'https://boards-api.greenhouse.io/v1/boards/zzz/jobs');
  ok('api_url unsupported ats', apiUrlForRow({ ats: 'workday', board_url: 'https://x.wd5.myworkdayjobs.com/y' }) === '');
  ok('api_url no slug', apiUrlForRow({ ats: 'greenhouse' }) === '');

  // rowsFromBoard()
  const built = rowsFromBoard({ company: 'Acme', ats: 'greenhouse' },
    { jobs: [
      { title: 'Data Analyst', absolute_url: 'https://a/1', location: { name: 'SF' }, updated_at: '2026-09-03T00:00:00Z' },
      { title: 'No URL', absolute_url: '', location: { name: 'SF' } },
    ] }, now);
  ok('rowsFromBoard drops urlless', built.length === 1);
  ok('rowsFromBoard sets source', built[0].source === 'board:greenhouse');
  ok('rowsFromBoard company', built[0].company === 'Acme');
  ok('rowsFromBoard age', built[0].age_days === '7.5');
  ok('rowsFromBoard blank sponsorship', built[0].sponsorship_hint === '');
  ok('rowsFromBoard all cols', FEED_COLS.every((c) => c in built[0]));
  ok('rowsFromBoard unknown ats', rowsFromBoard({ company: 'X', ats: 'nope' }, {}).length === 0);

  // TSV integrity: a title containing a tab must not add a column
  const dirty = rowsFromBoard({ company: 'Acme', ats: 'greenhouse' },
    { jobs: [{ title: 'Data\tAnalyst\nII', absolute_url: 'https://a/2', location: { name: 'S\tF' } }] }, now);
  // No .trim() here: the last column is empty, so trimming would eat its
  // trailing tab and the row would read as 10 columns instead of 11.
  const line = writeTsv(FEED_COLS, dirty).split('\n')[1];
  ok('tsv column count safe', line.split('\t').length === FEED_COLS.length);
  ok('tsv title cleaned', dirty[0].title === 'Data Analyst II');

  // readTsvRows round-trip
  const rt = readTsvRows(writeTsv(FEED_COLS, built));
  ok('round-trip rows', rt.rows.length === 1 && rt.rows[0].title === 'Data Analyst');
  ok('round-trip header', rt.header.length === FEED_COLS.length);

  console.log((fail ? 'FAIL' : 'ok') + ' - nightly-harvest self-test: ' + pass + ' passed, ' + fail + ' failed');
  return fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
}
