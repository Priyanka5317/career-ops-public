#!/usr/bin/env node
/**
 * nightly-linkedin.mjs — LinkedIn as a feed source. ZERO tokens.
 *
 * Her instruction, 2026-09-09: "let's add linkedin searches in. for the roles
 * specified, entry level and visa sponsorship done as well."
 *
 * The four public new-grad repos only cover companies that opted into a
 * community list. LinkedIn covers everything else, and the guest search
 * endpoint needs no login:
 *
 *   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&f_E=&f_TPR=
 *
 * It returns an HTML fragment of job cards carrying
 * `data-entity-urn="urn:li:jobPosting:{id}"`, which gives a stable canonical
 * URL (linkedin.com/jobs/view/{id}) - exactly the stable identity the seen-jobs
 * ledger needs, so a req found tonight is never re-read tomorrow.
 *
 * ENTRY LEVEL
 *
 * f_E is LinkedIn's own experience filter (2=Entry, 3=Associate). Its tagging
 * is noisy in both directions, so it is used only to narrow the candidate set.
 * The ACCURACY comes from our own zero-token gates, which run afterwards on
 * every row exactly as they do for repo rows:
 *   nightly-shortlist.mjs  - level markers (II/III/IV), senior/staff/lead,
 *                            people-manager shapes, years stated in the title
 *   check-jd-experience.mjs - the years requirement in the JD body
 *
 * VISA
 *
 * LinkedIn has no sponsorship filter and the guest card carries no sponsorship
 * text, so nothing here is a visa verdict. Every row is emitted with
 * sponsorship_hint blank and goes through the normal visa gate (Agent 3,
 * employer-deduped, cached 90 days in data/visa-cache.tsv). This file must
 * never mark a row as sponsored.
 *
 * A BLANK RESULT IS NOT A NEGATIVE. LinkedIn rate-limits and returns an empty
 * fragment rather than an error. So: every run reports HTTP status and parse
 * counts per query, and if every query returns zero the summary says BLOCKED,
 * not "no jobs found" - the same discipline the E-Verify Tableau needed.
 *
 * Usage:
 *   node nightly-linkedin.mjs                     # next rotation slice
 *   node nightly-linkedin.mjs --terms 4
 *   node nightly-linkedin.mjs --hours 24
 *   node nightly-linkedin.mjs --all-terms         # every term, ignore rotation
 *   node nightly-linkedin.mjs --out data/linkedin-feed.tsv
 *   node nightly-linkedin.mjs --dry-run           # show the queries, fetch nothing
 *   node nightly-linkedin.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/** Feed columns, identical to scrape-job-repos.mjs so the shortlist just works. */
export const COLUMNS = ['source', 'sources', 'company', 'title', 'location', 'url',
  'posted_ts', 'age_days', 'sponsorship_hint', 'salary', 'category'];

/**
 * Default search terms: exactly the titles she named on 2026-09-09.
 * Overridable via config/nightly.yml -> linkedin.search_terms.
 */
export const DEFAULT_TERMS = [
  'Data Analyst',
  'Data Scientist',
  'Data Engineer',
  'AI Engineer',
  'GTM Engineer',
  'Business Analyst',
  'Business Intelligence Analyst',
  'Analytics Engineer',
  'Machine Learning Engineer',
  'Forward Deployed Engineer',
  'AI Solutions Engineer',
  'Solutions Engineer',
];

export function buildQuery({ term, location, expLevels, hours, start = 0 }) {
  const p = new URLSearchParams();
  p.set('keywords', term);
  p.set('location', location || 'United States');
  if (expLevels) p.set('f_E', expLevels);
  if (hours) p.set('f_TPR', 'r' + Math.round(hours * 3600));
  p.set('start', String(start));
  p.set('sortBy', 'DD');            // date descending - a nightly run wants newest
  return SEARCH + '?' + p.toString();
}

/* -------------------------------------------------------------------- parsing */

const dec = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Parse the guest search fragment into feed rows.
 *
 * Deliberately regex-driven and defensive: LinkedIn reshuffles class names, so
 * the job id (the entity urn) is the only thing treated as required. A card
 * whose id cannot be found is counted as a parse miss and reported, never
 * silently dropped.
 */
export function parseCards(html, { today = null } = {}) {
  const rows = [];
  let misses = 0;
  const text = String(html || '');
  if (!text.trim()) return { rows, misses, cards: 0 };

  // Cards are <li> blocks; split on the opening tag and drop the preamble.
  const blocks = text.split(/<li[\s>]/i).slice(1);
  for (const b of blocks) {
    const id = (b.match(/urn:li:jobPosting:(\d+)/) || [])[1]
      || (b.match(/jobs\/view\/[^"'?]*?-(\d{6,})/) || [])[1];
    if (!id) { misses++; continue; }

    const title = dec((b.match(/class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1]
      || (b.match(/class="[^"]*sr-only[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1]);
    const company = dec((b.match(/class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i) || [])[1]);
    const location = dec((b.match(/class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1]);
    const dt = (b.match(/datetime="([\d-]+)"/i) || [])[1] || '';

    if (!title && !company) { misses++; continue; }

    const now = today ? new Date(today) : new Date();
    const posted = dt ? new Date(dt) : null;
    const age = posted && Number.isFinite(posted.getTime())
      ? Math.max(0, Math.round(((now - posted) / 86400000) * 100) / 100)
      : '';

    rows.push({
      source: 'linkedin',
      sources: 'linkedin',
      company,
      title,
      location,
      url: 'https://www.linkedin.com/jobs/view/' + id,
      posted_ts: dt,
      age_days: age,
      sponsorship_hint: '',        // NEVER inferred here; the visa gate rules
      salary: '',
      category: '',
    });
  }
  return { rows, misses, cards: blocks.length };
}

/** Same-run dedupe: one req can appear under several search terms. */
export function dedupeRows(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.url;
    if (!seen.has(k)) { seen.set(k, r); continue; }
    const prev = seen.get(k);
    for (const f of ['company', 'title', 'location', 'posted_ts']) if (!prev[f] && r[f]) prev[f] = r[f];
  }
  return [...seen.values()];
}

/* ---------------------------------------------------------------------- io */

function loadYaml(p, fallback) {
  try { return existsSync(p) ? (yaml.load(readFileSync(p, 'utf8')) ?? fallback) : fallback; }
  catch { return fallback; }
}

function writeAtomic(p, text) {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

function toTsv(rows) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return [COLUMNS.join('\t'), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join('\t'))].join('\n') + '\n';
}

/** Rotation cursor over the search terms, so runs do not repeat queries. */
function readCursor(p) {
  if (!existsSync(p)) return { cursor: 0, runs: [] };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { cursor: Number(j.cursor) || 0, runs: Array.isArray(j.runs) ? j.runs : [] };
  } catch { return { cursor: 0, runs: [] }; }
}

export function sliceTerms(terms, cursor, take) {
  const n = terms.length;
  if (!n) return { slice: [], next: 0 };
  const t = Math.min(take, n);
  const start = ((cursor % n) + n) % n;
  const slice = [];
  for (let k = 0; k < t; k++) slice.push(terms[(start + k) % n]);
  return { slice, next: (start + t) % n };
}

async function fetchFragment(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = res.ok ? await res.text() : '';
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: '', error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- selftest */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  // --- query building
  const q = buildQuery({ term: 'Data Analyst', location: 'United States', expLevels: '2,3', hours: 24 });
  eq('query encodes the term', q.includes('keywords=Data+Analyst'), true);
  eq('query carries the entry-level filter', q.includes('f_E=2%2C3'), true);
  eq('query carries a 24h window', q.includes('f_TPR=r86400'), true);
  eq('query sorts newest first', q.includes('sortBy=DD'), true);

  // --- card parsing
  const html = `
  <li><div class="base-card" data-entity-urn="urn:li:jobPosting:4012345678">
    <h3 class="base-search-card__title"> Data Analyst </h3>
    <h4 class="base-search-card__subtitle"><a href="/company/acme">Acme &amp; Co</a></h4>
    <span class="job-search-card__location">Boston, MA</span>
    <time class="job-search-card__listdate" datetime="2026-09-08"></time>
  </div></li>
  <li><div class="base-card" data-entity-urn="urn:li:jobPosting:4099999999">
    <h3 class="base-search-card__title">Data Engineer II</h3>
    <h4 class="base-search-card__subtitle"><a href="/company/b">Beta Inc</a></h4>
    <span class="job-search-card__location">Remote</span>
    <time datetime="2026-09-09"></time>
  </div></li>`;
  const p = parseCards(html, { today: '2026-09-09' });
  eq('parses both cards', p.rows.length, 2);
  eq('title decoded', p.rows[0].title, 'Data Analyst');
  eq('company entity-decoded', p.rows[0].company, 'Acme & Co');
  eq('location kept', p.rows[0].location, 'Boston, MA');
  eq('canonical stable url from the urn', p.rows[0].url, 'https://www.linkedin.com/jobs/view/4012345678');
  eq('age computed from datetime', p.rows[0].age_days, 1);
  eq('same-day posting is age 0', p.rows[1].age_days, 0);
  // The hard rule: this file never asserts sponsorship.
  eq('sponsorship is never inferred here', p.rows.every((r) => r.sponsorship_hint === ''), true);
  eq('source tagged', p.rows[0].source, 'linkedin');

  // A blank body must read as zero cards, never as an error state.
  eq('empty fragment parses to nothing', parseCards('').rows.length, 0);
  // A card with no id is a MISS and must be counted, not silently dropped.
  const miss = parseCards('<li><div class="base-card"><h3 class="base-search-card__title">X</h3></div></li>');
  eq('idless card counted as a parse miss', miss.misses, 1);
  eq('idless card not emitted', miss.rows.length, 0);

  // --- dedupe across terms
  const d = dedupeRows([
    { url: 'https://www.linkedin.com/jobs/view/1', company: 'A', title: 'Data Analyst', location: '' },
    { url: 'https://www.linkedin.com/jobs/view/1', company: 'A', title: 'Data Analyst', location: 'NY' },
    { url: 'https://www.linkedin.com/jobs/view/2', company: 'B', title: 'Data Engineer', location: 'MA' },
  ]);
  eq('dedupes one req seen under two terms', d.length, 2);
  eq('dedupe backfills the missing field', d[0].location, 'NY');

  // --- term rotation
  const terms = ['a', 'b', 'c', 'd', 'e'];
  const s1 = sliceTerms(terms, 0, 2);
  eq('first slice', s1.slice, ['a', 'b']);
  const s2 = sliceTerms(terms, s1.next, 2);
  eq('second run uses DIFFERENT terms', s2.slice, ['c', 'd']);
  const s3 = sliceTerms(terms, s2.next, 2);
  eq('third run wraps', s3.slice, ['e', 'a']);
  eq('take beyond length is clamped', sliceTerms(terms, 0, 99).slice.length, 5);
  eq('empty terms is safe', sliceTerms([], 0, 3), { slice: [], next: 0 });

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/* ---------------------------------------------------------------------- main */

function parseArgs(argv) {
  const a = { terms: 0, hours: 0, out: null, json: false, dryRun: false, allTerms: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--self-test') a.selfTest = true;
    else if (v === '--json') a.json = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--all-terms') a.allTerms = true;
    else if (v === '--terms') a.terms = parseInt(argv[++i], 10);
    else if (v.startsWith('--terms=')) a.terms = parseInt(v.slice(8), 10);
    else if (v === '--hours') a.hours = parseFloat(argv[++i]);
    else if (v.startsWith('--hours=')) a.hours = parseFloat(v.slice(8));
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const cfg = loadYaml(path.join(ROOT, 'config', 'nightly.yml'), {});
  const li = cfg.linkedin || {};
  if (li.enabled === false) { console.error('linkedin disabled in config/nightly.yml'); return 0; }

  const terms = Array.isArray(li.search_terms) && li.search_terms.length ? li.search_terms : DEFAULT_TERMS;
  const take = args.terms > 0 ? args.terms : (Number(li.terms_per_run) || 4);
  const hours = args.hours > 0 ? args.hours : (Number(li.since_hours) || 24);
  const locations = Array.isArray(li.locations) && li.locations.length ? li.locations : ['United States'];
  const expLevels = li.experience_levels || '2,3';
  const pages = Number(li.pages_per_query) || 2;
  const timeoutMs = Number(li.timeout_ms) || 10000;
  const gapMs = Number(li.gap_ms) || 1200;
  const outPath = path.resolve(ROOT, args.out || li.out_file || 'data/linkedin-feed.tsv');
  const cursorPath = path.join(ROOT, li.cursor_file || 'data/linkedin-cursor.json');

  const state = readCursor(cursorPath);
  const { slice, next } = args.allTerms
    ? { slice: terms, next: state.cursor }
    : sliceTerms(terms, state.cursor, take);

  const queries = [];
  for (const term of slice) {
    for (const location of locations) {
      for (let pg = 0; pg < pages; pg++) {
        queries.push({ term, location, url: buildQuery({ term, location, expLevels, hours, start: pg * 25 }) });
      }
    }
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      dry_run: true, terms_this_run: slice, all_terms: terms.length,
      locations, experience_levels: expLevels, since_hours: hours,
      queries: queries.map((q) => q.url),
    }, null, 2));
    return 0;
  }

  const all = [];
  const perQuery = [];
  for (const q of queries) {
    const { status, body, error } = await fetchFragment(q.url, timeoutMs);
    const parsed = status === 200 ? parseCards(body) : { rows: [], misses: 0, cards: 0 };
    perQuery.push({
      term: q.term, location: q.location, status,
      bytes: body.length, cards: parsed.cards, rows: parsed.rows.length, misses: parsed.misses,
      ...(error ? { error } : {}),
    });
    all.push(...parsed.rows);
    await sleep(gapMs);            // be a polite guest
  }

  const rows = dedupeRows(all);
  const ok = perQuery.filter((q) => q.status === 200).length;
  const got = perQuery.filter((q) => q.rows > 0).length;

  // A blank result is NOT a negative. Say so plainly.
  let health = 'ok';
  if (!perQuery.length) health = 'no-queries';
  else if (ok === 0) health = 'BLOCKED: no query returned HTTP 200 - treat as UNKNOWN, not as zero jobs';
  else if (got === 0) health = 'SUSPECT: every query returned 200 with zero cards - likely rate-limited or the card markup changed';
  else if (perQuery.some((q) => q.misses > 0 && q.rows === 0)) health = 'SUSPECT: cards present but unparsed - markup may have changed';

  writeAtomic(outPath, toTsv(rows));
  state.runs.push({ at: new Date().toISOString(), terms: slice, queries: queries.length, rows: rows.length, health });
  writeAtomic(cursorPath, JSON.stringify({ cursor: next, runs: state.runs.slice(-20) }, null, 2) + '\n');

  const summary = {
    terms_this_run: slice,
    next_run_starts_at_term: terms[next] || terms[0],
    queries: queries.length,
    http_200: ok,
    rows_raw: all.length,
    rows_deduped: rows.length,
    health,
    note: 'sponsorship_hint is intentionally blank on every row - the visa gate rules, not this script',
    out_file: path.relative(ROOT, outPath),
    per_query: perQuery,
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.error(JSON.stringify(summary, null, 2));
    console.error('wrote ' + rows.length + ' LinkedIn rows -> ' + path.relative(ROOT, outPath));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
