#!/usr/bin/env node
/**
 * make-google-alerts.mjs — build Google Alerts queries from the company universe.
 *
 * Format requested 2026-09-10:  ("Job Title") site:CompanyCareerPageURL
 *
 * The `site:` operator needs a domain or a domain+path PREFIX, not a full URL
 * with a trailing slash or query string. Two cases matter:
 *
 *   Shared ATS host   boards.greenhouse.io/scaleai   keep the company slug, or
 *                                                    the alert fires for every
 *                                                    company on Greenhouse
 *   Own domain        groq.com/careers/              the bare domain is enough
 *                                                    and catches the whole site
 *
 * Usage:
 *   node make-google-alerts.mjs                    # writes output/google-alerts.txt
 *   node make-google-alerts.mjs --out path.txt
 *   node make-google-alerts.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Hosts shared by many employers: the first path segment is the company. */
export const SHARED_ATS_HOSTS = [
  'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.ashbyhq.com',
  'jobs.lever.co', 'apply.workable.com', 'jobs.smartrecruiters.com',
  'jobs.jobvite.com', 'apply.wingspan.app', 'jobs.gem.com',
  'ats.rippling.com', 'jobs.eightfold.ai', 'careers.smartrecruiters.com',
];

export const TITLES = [
  'Data Analyst',
  'Junior Data Analyst',
  'Business Analyst',
  'Business Intelligence Analyst',
  'Data Scientist',
  'Data Engineer',
  'GTM Engineer',
  'Early Career',
  'New College Grad',
  'New Grad',
];

/**
 * Turn a careers URL into a `site:` target.
 * Returns null when the URL cannot be parsed.
 */
export function siteTarget(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  if (SHARED_ATS_HOSTS.includes(host)) {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? host + '/' + seg.toLowerCase() : host;
  }
  // Workday tenants are per-employer already, so the host alone is correct.
  return host;
}

function readTsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length);
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    const o = {};
    head.forEach((h, i) => { o[h] = c[i] ?? ''; });
    return o;
  });
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (got === want) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + got + '\n  want ' + want); }
  };
  eq('greenhouse keeps the slug', siteTarget('https://boards.greenhouse.io/scaleai'), 'boards.greenhouse.io/scaleai');
  eq('new greenhouse host keeps slug', siteTarget('https://job-boards.greenhouse.io/airtable'), 'job-boards.greenhouse.io/airtable');
  eq('ashby keeps the slug', siteTarget('https://jobs.ashbyhq.com/perplexity'), 'jobs.ashbyhq.com/perplexity');
  eq('lever keeps the slug', siteTarget('https://jobs.lever.co/kitware/abc'), 'jobs.lever.co/kitware');
  eq('workable trailing slash', siteTarget('https://apply.workable.com/huggingface/'), 'apply.workable.com/huggingface');
  eq('own domain drops path', siteTarget('https://groq.com/careers/'), 'groq.com');
  eq('own domain strips www', siteTarget('https://www.clarifai.com/careers'), 'clarifai.com');
  eq('workday tenant host only', siteTarget('https://workday.wd5.myworkdayjobs.com/careers'), 'workday.wd5.myworkdayjobs.com');
  eq('query string ignored', siteTarget('https://x.com/careers?src=a'), 'x.com');
  eq('garbage returns null', siteTarget('not a url'), null);
  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/**
 * Pack site: terms into as few alerts as possible.
 *
 * Google truncates a query somewhere around 2,048 characters and gets flaky on
 * very long operator chains well before that, so this keeps each alert under a
 * conservative budget rather than betting on the real ceiling. Every alert
 * carries the full title block, so each one is self-contained.
 */
export function packAlerts(titleBlock, sites, budget = 1500) {
  const out = [];
  let cur = [];
  const len = (arr) => titleBlock.length + 2 + arr.reduce((a, s) => a + s.length + 10, 0);
  for (const s of sites) {
    if (cur.length && len([...cur, s]) > budget) { out.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out.map((group) => titleBlock + ' (' + group.map((s) => 'site:' + s).join(' OR ') + ')');
}

function packedMode(argv) {
  const uni = path.join(ROOT, 'data', 'company-universe.tsv');
  const rows = readTsv(readFileSync(uni, 'utf8'));
  const targets = [...new Set(rows.map((r) => siteTarget(r.careers_url)).filter(Boolean))];
  const isAts = (t) => SHARED_ATS_HOSTS.some((h) => t === h || t.startsWith(h + '/'));
  const onAts = targets.filter(isAts);
  const own = targets.filter((t) => !isAts(t)).sort();

  const titleBlock = '(' + TITLES.map((s) => '"' + s + '"').join(' OR ') + ')';

  // The 163 companies on shared ATS hosts collapse into 12 host terms, and
  // those also catch companies that are not in the universe at all.
  const atsAlerts = packAlerts(titleBlock, SHARED_ATS_HOSTS);
  const ownAlerts = packAlerts(titleBlock, own);
  const all = [...atsAlerts, ...ownAlerts];

  const L = [];
  L.push('GOOGLE ALERTS - PACKED INTO AS FEW ALERTS AS POSSIBLE');
  L.push('Generated ' + new Date().toISOString().slice(0, 10));
  L.push('');
  L.push('A single alert covering all ' + targets.length + ' companies is not possible: that would');
  L.push('need ~' + own.reduce((a, t) => a + t.length + 10, 0).toLocaleString() + ' characters of site: terms and Google truncates a query around');
  L.push('2,048. This is the minimum that still works, ' + all.length + ' alerts total.');
  L.push('');
  L.push('  Alerts 1-' + atsAlerts.length + ': the ' + SHARED_ATS_HOSTS.length + ' shared ATS hosts. These cover all ' + onAts.length + ' of your');
  L.push('  companies that post on Greenhouse, Ashby, Lever, Workable, SmartRecruiters,');
  L.push('  Jobvite, Rippling, Eightfold and Gem, PLUS every other company on those');
  L.push('  boards. Highest value per alert by a wide margin. Set these first.');
  L.push('');
  L.push('  Alerts ' + (atsAlerts.length + 1) + '-' + all.length + ': the ' + own.length + ' companies on their own domains, packed to');
  L.push('  stay under the query limit.');
  L.push('');
  L.push('Settings for each: How often = At most once a day, Sources = Automatic,');
  L.push('Language = English, Region = United States, How many = All results.');
  L.push('');
  all.forEach((q, i) => {
    L.push('='.repeat(78));
    L.push('ALERT ' + (i + 1) + ' of ' + all.length + '   (' + q.length + ' chars)');
    L.push('='.repeat(78));
    L.push(q);
    L.push('');
  });

  const out = path.resolve(ROOT, 'output/google-alerts-packed.txt');
  writeFileSync(out, L.join('\n') + '\n');
  console.log('wrote ' + path.relative(ROOT, out));
  console.log('  total alerts: ' + all.length + '  (' + atsAlerts.length + ' ATS-host + ' + ownAlerts.length + ' own-domain)');
  console.log('  companies covered: ' + targets.length + '  (' + onAts.length + ' via ATS hosts, ' + own.length + ' by domain)');
  console.log('  longest alert: ' + Math.max(...all.map((q) => q.length)) + ' chars');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--packed')) return packedMode(argv);
  let out = 'output/google-alerts.txt';
  const i = argv.indexOf('--out');
  if (i >= 0 && argv[i + 1]) out = argv[i + 1];

  const uni = path.join(ROOT, 'data', 'company-universe.tsv');
  if (!existsSync(uni)) { console.error('missing data/company-universe.tsv'); return 1; }
  const rows = readTsv(readFileSync(uni, 'utf8'));

  // Dedupe by site target, keeping the first company name seen for it.
  const byTarget = new Map();
  let skipped = 0;
  for (const r of rows) {
    const t = siteTarget(r.careers_url);
    if (!t) { skipped++; continue; }
    if (!byTarget.has(t)) byTarget.set(t, { company: r.company || t, industry: r.industry || '' });
  }
  const targets = [...byTarget.entries()].sort((a, b) => a[1].company.toLowerCase().localeCompare(b[1].company.toLowerCase()));

  const q = (s) => '"' + s + '"';
  const orAll = '(' + TITLES.map(q).join(' OR ') + ')';

  const L = [];
  L.push('GOOGLE ALERTS QUERIES');
  L.push('Generated ' + new Date().toISOString().slice(0, 10) + ' from data/company-universe.tsv');
  L.push('');
  L.push('Companies with a usable careers URL: ' + targets.length + '   (skipped ' + skipped + ')');
  L.push('Titles tracked: ' + TITLES.length);
  L.push('');
  L.push('HOW TO USE');
  L.push('  1. Go to google.com/alerts');
  L.push('  2. Paste one line into the search box');
  L.push('  3. Set: How often = At most once a day, Sources = Automatic,');
  L.push('     Language = English, Region = United States, How many = All results');
  L.push('');
  L.push('IMPORTANT, READ THIS FIRST');
  L.push('  A Google Alerts account holds about 1,000 alerts. Section B below is');
  L.push('  ' + (TITLES.length * targets.length).toLocaleString() + ' lines, which is far past that ceiling and not realistically');
  L.push('  manageable. Start with SECTION A: one alert per company, all titles');
  L.push('  OR-ed together, which is ' + targets.length + ' alerts and fits. SECTION C is only');
  L.push('  ' + SHARED_ATS_HOSTS.length + ' alerts and covers every company on those shared job boards,');
  L.push('  including ones not in this list, so it is the best value per alert.');
  L.push('');
  L.push('  Google Alerts is also weak on job boards that render client-side.');
  L.push('  It works best on company career pages that server-render their');
  L.push('  postings. Treat it as a supplement to the nightly pipeline, not a');
  L.push('  replacement for it.');
  L.push('');

  L.push('='.repeat(78));
  L.push('SECTION C  -  BROAD ATS SWEEPS  (' + SHARED_ATS_HOSTS.length + ' alerts, highest value, set these first)');
  L.push('='.repeat(78));
  L.push('');
  for (const h of SHARED_ATS_HOSTS) L.push(orAll + ' site:' + h);
  L.push('');

  L.push('='.repeat(78));
  L.push('SECTION A  -  ONE ALERT PER COMPANY  (' + targets.length + ' alerts, recommended)');
  L.push('='.repeat(78));
  L.push('');
  for (const [t, meta] of targets) L.push(orAll + ' site:' + t + '        # ' + meta.company);
  L.push('');

  L.push('='.repeat(78));
  L.push('SECTION B  -  ONE ALERT PER TITLE PER COMPANY  (' + (TITLES.length * targets.length).toLocaleString() + ' lines)');
  L.push('Exact requested format. Pick the titles and companies you actually want.');
  L.push('='.repeat(78));
  for (const title of TITLES) {
    L.push('');
    L.push('-'.repeat(78));
    L.push('## ' + title + '  (' + targets.length + ' companies)');
    L.push('-'.repeat(78));
    for (const [t, meta] of targets) L.push('(' + q(title) + ') site:' + t + '        # ' + meta.company);
  }
  L.push('');

  const outPath = path.resolve(ROOT, out);
  if (!existsSync(path.dirname(outPath))) mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, L.join('\n') + '\n');

  console.log('wrote ' + path.relative(ROOT, outPath));
  console.log('  companies: ' + targets.length + '  (skipped ' + skipped + ')');
  console.log('  Section C: ' + SHARED_ATS_HOSTS.length + ' broad ATS alerts');
  console.log('  Section A: ' + targets.length + ' combined-title alerts');
  console.log('  Section B: ' + (TITLES.length * targets.length) + ' single-title alerts');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
