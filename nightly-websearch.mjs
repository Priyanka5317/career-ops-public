#!/usr/bin/env node
/**
 * nightly-websearch.mjs — Boolean job discovery across ATS domains. ZERO tokens.
 *
 * WHY THIS EXISTS
 *
 * Every other discovery source in the pipeline is bounded by a list we maintain:
 * nightly-harvest.mjs can only read boards belonging to the 486 companies in
 * data/company-universe.tsv, and scrape-job-repos.mjs can only see what four
 * public new-grad repos happen to list. A qualifying entry-level Data Analyst
 * req at a company nobody added to the universe is invisible to all of them.
 *
 * A boolean site: search is the one source that finds employers we have never
 * heard of, because the query describes the ROLE, not the company.
 *
 * BACKENDS
 *
 * PRIMARY: DuckDuckGo LITE (lite.duckduckgo.com). No key, no account, no budget.
 * Note LITE specifically - html.duckduckgo.com answers an unattended client with
 * HTTP 202 and an anomaly page, while lite returns real results. It wraps every
 * hit in a PROTOCOL-RELATIVE //duckduckgo.com/l/?uddg= redirect, so a parser
 * looking for an anchor class or a leading-slash href finds nothing.
 *
 * DDG blocks by IP after a burst. Two mitigations, both measured on 2026-09-12
 * when repeated testing left the address returning 202 to every user-agent for
 * hours: a 5s gap between queries, and an immediate abort of the remaining
 * slice on the first hard block, because hammering a blocked address extends
 * the block. Six queries twice a night sits well inside tolerance.
 *
 * OPTIONAL: Google Programmable Search, used only when GOOGLE_CSE_KEY and
 * GOOGLE_CSE_CX are set. NOT enabled here, and the reason is worth recording:
 * the Custom Search JSON API requires a BILLING ACCOUNT on the Cloud project
 * even for its free 100-queries/day tier. Without one every call returns
 * 403 "This project does not have the access to Custom Search JSON API" - which
 * reads like a key problem and is not. Enabling the API, checking the key
 * format and clearing its restrictions all change nothing.
 *
 * Scraping google.com directly is not an option either: it CAPTCHAs unattended
 * clients within a handful of queries.
 *
 * THE 7-DAY WINDOW
 *
 * Only the Google backend could filter by date at the query, so on DuckDuckGo
 * the window is enforced downstream: every URL is normalized through the
 * ledger's key and anything already terminal in data/seen-jobs.tsv is dropped
 * before it reaches the feed. With 22,000+ terminal rows that is doing the real
 * work anyway, which is why losing Google's dateRestrict costs little.
 *
 * Usage:
 *   node nightly-websearch.mjs                       # one rotation slice
 *   node nightly-websearch.mjs --queries 8
 *   node nightly-websearch.mjs --out data/websearch-feed.tsv
 *   node nightly-websearch.mjs --peek                # show the queries, fetch nothing
 *   node nightly-websearch.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { normalizeUrl } from './nightly-seen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load .env ourselves rather than depending on dotenv being importable.
 *
 * Two traps this survives, both hit for real on 2026-09-12:
 *
 *  1. MIXED ENCODING. A line appended from PowerShell lands as UTF-16LE (a NUL
 *     between every character) while a line written from bash is UTF-8, so the
 *     file is half one and half the other and a naive utf-8 read turns the key
 *     into "G\0O\0O\0G\0L\0E\0...". Each line is decoded on its own merits.
 *  2. THE PLACEHOLDER. Copying the example command verbatim writes the literal
 *     string "paste_your_key_here". That is a perfectly valid-looking env var
 *     and would fail later as an opaque HTTP 400, so it is rejected up front.
 */
function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  let raw;
  try { raw = readFileSync(p); } catch { return; }
  const found = {};
  for (const chunk of raw.toString('binary').replace(/\r\n/g, '\n').split('\n')) {
    const buf = Buffer.from(chunk, 'binary');
    let line = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
    line = line.replace(/﻿/g, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // LAST occurrence wins. Appending a corrected line to .env is the obvious
    // way to fix a bad value, and first-wins would silently keep the bad one.
    if (k) found[k] = v;
  }
  // A variable already set in the real environment still beats the file.
  for (const [k, v] of Object.entries(found)) if (!process.env[k]) process.env[k] = v;
}
loadEnvFile();

/** A value that is obviously still a placeholder, not a real secret. */
export function isPlaceholder(v) {
  return !v || /^(paste|your|xxx|todo|changeme|<)/i.test(v) || /_key_here|_here$/i.test(v);
}

/* ------------------------------------------------------------------ ATS shapes */

/**
 * Each entry knows how to recognise its own job-DETAIL urls and pull the
 * employer slug out. Board/listing pages are deliberately not matched: a link to
 * boards.greenhouse.io/acme is a company index, not a posting, and letting it
 * into the feed produces a row with no title and no req.
 */
export const ATS_SITES = [
  {
    site: 'boards.greenhouse.io',
    detail: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i,
    company: (m) => m[1],
  },
  {
    site: 'job-boards.greenhouse.io',
    detail: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i,
    company: (m) => m[1],
  },
  {
    site: 'jobs.ashbyhq.com',
    detail: /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{16,})/i,
    company: (m) => m[1],
  },
  {
    site: 'jobs.lever.co',
    detail: /^https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{16,})/i,
    company: (m) => m[1],
  },
  {
    site: 'jobs.smartrecruiters.com',
    detail: /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/i,
    company: (m) => m[1],
  },
];

/** Turn an ATS slug into a readable employer name. */
export function slugToCompany(slug) {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (s) => s.toUpperCase())
    .trim();
}

/** Match a result URL to an ATS job-detail shape. Returns null for listing pages. */
export function parseAtsUrl(url) {
  for (const a of ATS_SITES) {
    const m = String(url || '').match(a.detail);
    // Return m[0], not the raw url: DDG surfaces /confirmation and /apply
    // variants of the same req, and keeping the full match collapses them.
    if (m) return { site: a.site, company: slugToCompany(a.company(m)), url: m[0] };
  }
  return null;
}

/* -------------------------------------------------------------------- queries */

/**
 * Build one boolean query per (site x role-title group).
 *
 * Titles are quoted so the engine matches the phrase rather than the words, and
 * OR-ed in small groups: a single query naming all 27 titles is longer than most
 * engines will honour and quietly degrades to a bag-of-words match.
 */
export function buildQueries(families, { sites = ATS_SITES, groupSize = 4, entryHint = true } = {}) {
  const titles = [];
  for (const fam of Object.values(families || {})) {
    for (const t of (fam.titles || [])) titles.push(t);
  }
  const uniq = [...new Set(titles)];
  const groups = [];
  for (let i = 0; i < uniq.length; i += groupSize) groups.push(uniq.slice(i, i + groupSize));

  const hint = entryHint ? ' ("entry level" OR "new grad" OR "early career" OR associate)' : '';
  const out = [];
  const seenSites = new Set();
  for (const a of sites) {
    if (seenSites.has(a.site)) continue;   // greenhouse appears twice in ATS_SITES
    seenSites.add(a.site);
    for (const g of groups) {
      out.push(`site:${a.site} (${g.map((t) => `"${t}"`).join(' OR ')})${hint}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- backends */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/**
 * Pull result URLs out of a DuckDuckGo Lite page.
 *
 * Lite wraps every result in a PROTOCOL-RELATIVE redirect,
 * `//duckduckgo.com/l/?uddg=<urlencoded>&rut=...`, so an anchor-class or
 * leading-slash regex misses all of them. Matching the uddg parameter wherever
 * it appears is both simpler and markup-independent.
 */
export function parseDdgHtml(html) {
  const urls = [];
  const re = /[?&]uddg=([^"&'\s]+)/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try {
      const u = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(u)) urls.push(u);
    } catch { /* skip an undecodable redirect rather than fail the page */ }
  }
  return [...new Set(urls)];
}

async function ddg(query, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
    });
    const html = await r.text();
    // MEASURED 2026-09-11: DuckDuckGo answers an unattended client with HTTP
    // **202** and an anomaly/challenge page, NOT 4xx. `r.ok` is true for 202, so
    // the obvious `if (!r.ok)` check passes it through and the run reports a
    // cheerful "0 results" - exactly the silent-negative trap this pipeline has
    // been bitten by before. Status is pinned to 200 and the body is inspected.
    if (r.status !== 200) return { ok: false, status: 'HTTP ' + r.status + ' (challenge/block)', urls: [] };
    if (/anomaly|captcha|unusual traffic/i.test(html)) return { ok: false, status: 'challenge page', urls: [] };
    const urls = parseDdgHtml(html);
    return { ok: true, status: 200, urls, suspect: urls.length === 0 };
  } catch (e) {
    return { ok: false, status: String(e.name === 'AbortError' ? 'timeout' : e.message), urls: [] };
  } finally { clearTimeout(t); }
}

async function googleCse(query, timeoutMs, sinceDays) {
  const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_CX;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const u = new URL('https://www.googleapis.com/customsearch/v1');
    u.searchParams.set('key', key);
    u.searchParams.set('cx', cx);
    u.searchParams.set('q', query);
    u.searchParams.set('num', '10');
    if (sinceDays) u.searchParams.set('dateRestrict', 'd' + sinceDays);
    const r = await fetch(u, { signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status, urls: [] };
    const j = await r.json();
    return { ok: true, status: 200, urls: (j.items || []).map((i) => i.link).filter(Boolean) };
  } catch (e) {
    return { ok: false, status: String(e.name === 'AbortError' ? 'timeout' : e.message), urls: [] };
  } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------------------ main */

const COLUMNS = ['source', 'sources', 'company', 'title', 'location', 'url',
  'posted_ts', 'age_days', 'sponsorship_hint', 'salary', 'category'];

function loadCfg() {
  try { return yaml.load(readFileSync(path.join(ROOT, 'config', 'nightly.yml'), 'utf8')) || {}; }
  catch { return {}; }
}

function loadCursor(file, total) {
  try {
    const j = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
    return Number.isFinite(j.at) ? j.at % Math.max(total, 1) : 0;
  } catch { return 0; }
}

function saveCursor(file, at, total) {
  const p = path.join(ROOT, file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ at, total, updated_at: new Date().toISOString() }, null, 2) + '\n');
}

/** Terminal keys from the ledger. A posting already judged is never re-emitted. */
function terminalKeys() {
  const p = path.join(ROOT, 'data', 'seen-jobs.tsv');
  const out = new Set();
  if (!existsSync(p)) return out;
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  const cols = (lines[0] || '').split('\t');
  const iKey = cols.indexOf('job_key'), iVer = cols.indexOf('verdict');
  if (iKey < 0) return out;
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const c = l.split('\t');
    const v = (iVer >= 0 ? c[iVer] : '') || '';
    if (/^(DROP:|SKIP:|BUILT)/i.test(v)) out.add(c[iKey]);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const cfg = loadCfg();
  const ws = cfg.websearch || {};
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

  const outFile = arg('--out', ws.out_file || 'data/websearch-feed.tsv');
  const cursorFile = ws.cursor_file || 'data/websearch-cursor.json';
  const perRun = parseInt(arg('--queries', ws.queries_per_run || 6), 10);
  const timeoutMs = ws.timeout_ms || 12000;
  const gapMs = ws.gap_ms || 1500;
  const sinceDays = (cfg.caps || {}).feed_since_days || 7;

  const cseKey = process.env.GOOGLE_CSE_KEY, cseCx = process.env.GOOGLE_CSE_CX;
  const useGoogle = !isPlaceholder(cseKey) && !isPlaceholder(cseCx);

  const queries = buildQueries(cfg.role_families, { groupSize: ws.titles_per_query || 4 });
  const start = loadCursor(cursorFile, queries.length);
  const slice = [];
  for (let i = 0; i < Math.min(perRun, queries.length); i++) slice.push(queries[(start + i) % queries.length]);


  if (!useGoogle && (cseKey || cseCx)) {
    console.error('NOTE: GOOGLE_CSE_* present but not usable'
      + (isPlaceholder(cseKey) ? ' - GOOGLE_CSE_KEY is still a placeholder' : '')
      + (isPlaceholder(cseCx) ? ' - GOOGLE_CSE_CX is still a placeholder' : '')
      + '. Falling back to DuckDuckGo, which blocks unattended clients.');
  }
  const backend = useGoogle ? 'google-cse' : 'duckduckgo';

  // --check-key: validate the Google credentials and say pass/fail WITHOUT ever
  // printing the key. Added 2026-09-12 after two failed hand-offs - one wrote
  // the literal placeholder text, one wrote a bare key with no variable name -
  // and after the key itself leaked into a transcript while debugging.
  if (args.includes('--check-key')) {
    const mask = (v) => (!v ? '(missing)' : v.length + ' chars, ' + v.slice(0, 4) + '...');
    console.log('GOOGLE_CSE_CX   ' + mask(cseCx) + (isPlaceholder(cseCx) ? '  <-- PLACEHOLDER' : ''));
    console.log('GOOGLE_CSE_KEY  ' + mask(cseKey) + (isPlaceholder(cseKey) ? '  <-- PLACEHOLDER' : ''));
    if (isPlaceholder(cseKey) || isPlaceholder(cseCx)) {
      console.log('Not usable yet. Both must be real values in .env.');
      return 1;
    }
    if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(cseKey)) {
      console.log('That does not look like a Google API key (they start AIza, about 39 chars).');
      return 1;
    }
    const probe = await googleCse('site:boards.greenhouse.io "data analyst"', 12000, 7);
    if (probe.ok) {
      console.log('WORKING - Google returned ' + probe.urls.length + ' result(s).');
      return 0;
    }
    console.log('STILL FAILING: ' + probe.status);
    console.log('  403 = key is restricted, or Custom Search API is not enabled on the project.');
    return 1;
  }

  if (args.includes('--peek')) {
    console.log(JSON.stringify({ backend, total_queries: queries.length, cursor: start, slice }, null, 2));
    return 0;
  }

  const terminal = terminalKeys();
  const rows = new Map();
  const report = [];
  let blocked = 0;

  // Google is PREFERRED, not exclusive. It is the only backend that can filter
  // by date at the query, but a misconfigured project answers every call with
  // 403 - and picking a backend up front meant one broken key silently disabled
  // the whole source. So: try Google, and on the first hard failure fall back to
  // DDG Lite for the rest of the run and say so.
  let googleLive = useGoogle;
  let executed = 0;
  for (const q of slice) {
    executed++;
    let r = null;
    if (googleLive) {
      r = await googleCse(q, timeoutMs, sinceDays);
      if (!r.ok) {
        console.error('google-cse failed (' + r.status + ') - falling back to DuckDuckGo Lite for this run');
        googleLive = false;
        r = null;
      }
    }
    if (!r) r = await ddg(q, timeoutMs);
    let kept = 0, skippedTerminal = 0;
    for (const u of r.urls) {
      const hit = parseAtsUrl(u);
      if (!hit) continue;                                  // listing page or unknown host
      const key = normalizeUrl(hit.url);
      if (terminal.has(key)) { skippedTerminal++; continue; }
      if (rows.has(key)) continue;
      rows.set(key, {
        source: 'websearch', sources: 'websearch', company: hit.company,
        title: '', location: '', url: hit.url, posted_ts: '', age_days: '',
        sponsorship_hint: '', salary: '', category: '',
      });
      kept++;
    }
    if (r.suspect || (!r.ok)) blocked++;

    // ABORT THE RUN on a hard block instead of firing the rest of the slice.
    // DuckDuckGo blocks by IP, and hammering it while blocked only extends the
    // block - measured 2026-09-12, when repeated testing left the address
    // returning 202 to every user-agent for hours. One refusal is enough
    // information; the remaining queries can wait for the next run.
    if (!r.ok && /challenge|block|202/i.test(String(r.status))) {
      report.push({ query: '(remaining queries skipped)', status: 'ABORTED after a hard block',
        results: 0, kept: 0, skippedTerminal: 0 });
      break;
    }
    report.push({ query: q.slice(0, 90), status: r.ok ? (r.suspect ? 'SUSPECT (empty 200 - likely rate limited)' : 'ok') : 'FAIL ' + r.status, results: r.urls.length, kept, skippedTerminal });
    if (gapMs) await new Promise((s) => setTimeout(s, gapMs));
  }

  const p = path.join(ROOT, outFile);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, [COLUMNS.join('\t'), ...[...rows.values()].map((r) => COLUMNS.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n');
  // Advance only past queries we ACTUALLY ran. Skipping the cursor over
  // aborted queries would silently drop them from the rotation for good.
  saveCursor(cursorFile, (start + executed) % Math.max(queries.length, 1), queries.length);

  console.error(JSON.stringify({
    backend: googleLive ? 'google-cse' : (useGoogle ? 'duckduckgo-lite (google-cse failed)' : 'duckduckgo-lite'),
    total_queries: queries.length, ran: executed, planned: slice.length,
    cursor_from: start, cursor_to: (start + executed) % Math.max(queries.length, 1),
    rows: rows.size, blocked_or_suspect: blocked, out: outFile, per_query: report,
  }, null, 2));

  // A run where every query came back empty is a BLOCK, not an absence of jobs.
  //
  // TIGHTENED 2026-09-13. The 23:01 run reported the STEP as `ok` while
  // producing 0 rows, because DuckDuckGo had shifted from an honest HTTP 202 to
  // a soft block: HTTP 200 with an empty result list. That satisfied r.ok, so
  // only `blocked === slice.length` could catch it, and the early-abort meant
  // slice.length (6) never equalled blocked (1). The step passed and the digest
  // said "ok 12s" over nothing at all - exactly the silent negative this file
  // exists to avoid. Now: zero rows plus ANY block or suspect is a failure.
  if (rows.size === 0 && blocked > 0) {
    console.error('\nEVERY query was empty or failed. Treat this as BLOCKED, not as "no jobs".');
    return 1;
  }
  return 0;
}

/* -------------------------------------------------------------------- selftest */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  // Detail urls are recognised and the employer comes out of the slug.
  eq('greenhouse detail', parseAtsUrl('https://boards.greenhouse.io/acme-corp/jobs/4512345')?.company, 'Acme Corp');
  eq('greenhouse new host', parseAtsUrl('https://job-boards.greenhouse.io/scaleai/jobs/999')?.company, 'Scaleai');
  eq('ashby detail', parseAtsUrl('https://jobs.ashbyhq.com/parafin/b6fbdb8d-aa25-4216-a0bb-9af06607bd96')?.company, 'Parafin');
  eq('lever detail', parseAtsUrl('https://jobs.lever.co/anchorage/0a1b2c3d-4e5f-6789-abcd-ef0123456789')?.company, 'Anchorage');
  // Existing internal caps survive: "ServiceNow" must not become "Servicenow".
  eq('smartrecruiters detail', parseAtsUrl('https://jobs.smartrecruiters.com/ServiceNow/744000123456789')?.company, 'ServiceNow');
  // Listing pages must NOT become feed rows - they have no req behind them.
  eq('greenhouse listing rejected', parseAtsUrl('https://boards.greenhouse.io/acme-corp'), null);
  eq('ashby listing rejected', parseAtsUrl('https://jobs.ashbyhq.com/parafin'), null);
  eq('unrelated host rejected', parseAtsUrl('https://example.com/jobs/123'), null);

  // Query construction.
  const fams = { data: { titles: ['data analyst', 'data engineer'] }, ai: { titles: ['ai engineer'] } };
  const qs = buildQueries(fams, { sites: [ATS_SITES[0]], groupSize: 2 });
  eq('one query per title group', qs.length, 2);
  eq('query is site-scoped', qs[0].startsWith('site:boards.greenhouse.io '), true);
  eq('titles are phrase-quoted and OR-ed', qs[0].includes('"data analyst" OR "data engineer"'), true);
  eq('entry-level hint present', qs[0].includes('"new grad"'), true);
  // greenhouse is listed twice in ATS_SITES; it must not produce duplicate queries.
  const all = buildQueries(fams, { groupSize: 99 });
  eq('no duplicate site queries', all.length, new Set(all).size);

  // DDG parsing, both markups.
  // DDG Lite: protocol-relative redirect, which is the only shape it emits.
  eq('lite protocol-relative redirect',
    parseDdgHtml('<a rel="nofollow" href="//duckduckgo.com/l/?uddg='
      + encodeURIComponent('https://boards.greenhouse.io/manychat/jobs/7038782002') + '&amp;rut=abc">t</a>'),
    ['https://boards.greenhouse.io/manychat/jobs/7038782002']);
  eq('leading-slash redirect still works',
    parseDdgHtml('<a href="/l/?uddg=' + encodeURIComponent('https://jobs.ashbyhq.com/y/z') + '&rut=1">t</a>'),
    ['https://jobs.ashbyhq.com/y/z']);
  // /confirmation and /apply variants must collapse to one canonical req url.
  eq('confirmation suffix stripped',
    parseAtsUrl('https://boards.greenhouse.io/pitchbookdata/jobs/4352505006/confirmation')?.url,
    'https://boards.greenhouse.io/pitchbookdata/jobs/4352505006');

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // Set exitCode instead of calling process.exit(). Forcing an exit while a
  // fetch/AbortController handle is still tearing down trips a libuv assertion
  // on Windows - "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
  // src\winsync.c" - which aborts the process with 127 and masks the real
  // exit code the driver reads. Letting the loop drain reports it honestly.
  main().then((c) => { process.exitCode = c; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
