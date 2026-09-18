#!/usr/bin/env node
/**
 * scrape-job-repos.mjs — Zero-token aggregator for the four public new-grad job repos.
 *
 * Feeds Agent 2 (job-scraper) of the nightly pipeline. Pure HTTP + parsing, no
 * LLM tokens. Fetches, normalizes and merges:
 *
 *   simplify      SimplifyJobs/New-Grad-Positions       listings.json (structured)
 *   zapply-ng     zapplyjobs/New-Grad-Jobs-2027         README.md markdown table
 *   zapply-ds     zapplyjobs/New-Grad-Data-Science-...  README.md markdown table
 *   speedyapply   speedyapply/2027-AI-College-Jobs      README.md markdown table
 *
 * Every row is normalized to one shape so downstream stages never branch on source:
 *   { source, company, title, location, url, posted_ts, age_days, sponsorship_hint, category }
 *
 * sponsorship_hint is a HINT ONLY and never decides the visa gate. Repo visa
 * badges are aggregator blanket tags, not the employer speaking (the Jobright
 * b2b_ lesson). Agent 3 always runs the real H1B/E-Verify check. The one thing
 * this field IS trusted for is hard NEGATIVES that Simplify sources from the
 * posting itself ("U.S. Citizenship is Required", "Does Not Offer Sponsorship"),
 * which drop the row before it ever costs a token.
 *
 * Responses are cached under data/cache/ so repeated nightly runs and reruns
 * during a debug loop do not re-pull ~14MB from GitHub.
 *
 * Usage:
 *   node scrape-job-repos.mjs                 # all sources, postings from last 7 days
 *   node scrape-job-repos.mjs --since 3       # last 3 days only
 *   node scrape-job-repos.mjs --sources simplify,zapply-ds
 *   node scrape-job-repos.mjs --json          # raw JSON to stdout instead of TSV
 *   node scrape-job-repos.mjs --out data/job-feed.tsv
 *   node scrape-job-repos.mjs --no-cache      # force refetch
 *   node scrape-job-repos.mjs --self-test     # parser unit tests, no network
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a nightly run always gets a fresh pull

export const SOURCES = {
  simplify: {
    id: 'simplify',
    kind: 'json',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  },
  'zapply-ng': {
    id: 'zapply-ng',
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/zapplyjobs/New-Grad-Jobs-2027/main/README.md',
    category: 'New Grad',
  },
  'zapply-ds': {
    id: 'zapply-ds',
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/zapplyjobs/New-Grad-Data-Science-Jobs-2027/main/README.md',
    category: 'AI/ML/Data',
  },
  speedyapply: {
    id: 'speedyapply',
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/README.md',
    category: 'AI/ML/Data',
  },
};

// Simplify sponsorship values sourced from the posting itself, and therefore
// trustworthy as hard negatives. "Other" (99% of rows) means unknown.
export const HARD_NEGATIVE_SPONSORSHIP = new Set([
  'U.S. Citizenship is Required',
  'Does Not Offer Sponsorship',
]);

/* ------------------------------------------------------------------ fetching */

function cachePath(id) {
  return path.join(CACHE_DIR, 'job-repo-' + id + '.cache');
}

async function fetchSource(src, { useCache = true } = {}) {
  const cp = cachePath(src.id);
  if (useCache && existsSync(cp)) {
    const age = Date.now() - statSync(cp).mtimeMs;
    if (age < CACHE_TTL_MS) return readFileSync(cp, 'utf8');
  }
  const res = await fetch(src.url, {
    headers: { 'user-agent': 'career-ops-nightly/1.0', accept: 'text/plain,application/json' },
  });
  if (!res.ok) throw new Error(src.id + ': HTTP ' + res.status);
  const body = await res.text();
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cp, body);
  return body;
}

/* ------------------------------------------------------------------ parsing */

/** "13m" | "3d" | "7h" | "2w" -> age in days. Unknown -> null. */
export function parseAge(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'm': return n / (60 * 24);
    case 'h': return n / 24;
    case 'd': return n;
    case 'w': return n * 7;
    default: return null;
  }
}

/** Pull display text out of a markdown/HTML table cell. */
export function cellText(cell) {
  if (cell == null) return '';
  return String(cell)
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')                 // strip <a>, <strong>, ...
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // markdown links -> label
    .replace(/\*\*/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First real apply URL in a cell — the href, not the image src. */
export function cellUrl(cell) {
  if (cell == null) return '';
  const s = String(cell);
  const href = s.match(/href=["']([^"']+)["']/i);
  if (href) return href[1].trim();
  const md = s.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (md) return md[1].trim();
  const bare = s.match(/https?:\/\/[^\s)"'<>]+/);
  return bare ? bare[0].trim() : '';
}

/** Split a markdown table row into cells. */
export function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

function isSeparator(line) {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');
}

/**
 * Parse every markdown table in a README into normalized rows. Column roles are
 * resolved from the header text, so a repo reordering or renaming its columns
 * does not silently shift company into location.
 */
export function parseMarkdownTables(md, { source, category }) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let header = null;

  for (const line of lines) {
    if (!line.trim().startsWith('|')) { header = null; continue; }
    if (isSeparator(line)) continue;

    const cells = splitRow(line);
    const lower = cells.map((c) => cellText(c).toLowerCase());

    if (!header && lower.some((c) => /company/.test(c))) {
      header = {
        company: lower.findIndex((c) => /company/.test(c)),
        title: lower.findIndex((c) => /role|position|job|title/.test(c)),
        location: lower.findIndex((c) => /location/.test(c)),
        age: lower.findIndex((c) => /posted|age/.test(c)),
        visa: lower.findIndex((c) => /visa|sponsor/.test(c)),
        // Anchored: a bare /comp/ matches "Company" and would file the employer
        // name as the salary on every row.
        salary: lower.findIndex((c) => /salary|compensation|\bpay\b/.test(c)),
        apply: lower.findIndex((c) => /apply|link|posting/.test(c)),
      };
      continue;
    }
    if (!header || header.company < 0) continue;

    const company = cellText(cells[header.company]);
    const title = header.title >= 0 ? cellText(cells[header.title]) : '';
    if (!company || !title) continue;

    // The apply URL is usually in the apply column, but fall back to scanning
    // the whole row: some repos put it on the title instead.
    let url = header.apply >= 0 ? cellUrl(cells[header.apply]) : '';
    if (!url) for (const c of cells) { url = cellUrl(c); if (url) break; }
    if (!url) continue;

    const ageDays = header.age >= 0 ? parseAge(cellText(cells[header.age])) : null;
    const visa = header.visa >= 0 ? cellText(cells[header.visa]) : '';

    out.push({
      source,
      company,
      title,
      location: header.location >= 0 ? cellText(cells[header.location]) : '',
      url,
      posted_ts: ageDays == null ? null : Math.round(Date.now() / 1000 - ageDays * 86400),
      age_days: ageDays,
      // Repo badge, hint only. Never the visa gate.
      sponsorship_hint: /sponsor/i.test(visa) && !/\bno\b|\bnot\b/i.test(visa) ? 'repo-badge:sponsor' : '',
      salary: header.salary >= 0 ? cellText(cells[header.salary]) : '',
      category: category || '',
    });
  }
  return out;
}

/** Normalize SimplifyJobs listings.json. */
export function parseSimplify(json) {
  const rows = typeof json === 'string' ? JSON.parse(json) : json;
  const now = Date.now() / 1000;
  const out = [];
  for (const j of rows) {
    if (!j || j.active !== true || j.is_visible === false) continue;
    if (!j.company_name || !j.title || !j.url) continue;
    const ts = j.date_posted || j.date_updated || null;
    out.push({
      source: 'simplify',
      company: j.company_name,
      title: j.title,
      location: Array.isArray(j.locations) ? j.locations.join('; ') : (j.locations || ''),
      url: j.url,
      posted_ts: ts,
      age_days: ts ? (now - ts) / 86400 : null,
      sponsorship_hint: j.sponsorship && j.sponsorship !== 'Other' ? j.sponsorship : '',
      salary: '',
      category: j.category || '',
      degrees: Array.isArray(j.degrees) ? j.degrees.join('; ') : '',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ merging */

export function dedupeKey(row) {
  const co = String(row.company).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ti = String(row.title).toLowerCase().replace(/[^a-z0-9]/g, '');
  return co + '::' + ti;
}

/**
 * Merge sources, preferring the row that carries the most signal. Simplify wins
 * ties because it is the only source with a posting-sourced sponsorship field
 * and a real timestamp rather than a rounded age string.
 */
export function mergeRows(all) {
  const rank = { simplify: 3, 'zapply-ds': 2, 'zapply-ng': 2, speedyapply: 1 };
  const byKey = new Map();
  for (const r of all) {
    const k = dedupeKey(r);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...r, sources: [r.source] }); continue; }
    const sources = prev.sources.includes(r.source) ? prev.sources : [...prev.sources, r.source];
    if ((rank[r.source] || 0) > (rank[prev.source] || 0)) {
      const next = { ...r, sources };
      // Backfill from the loser rather than dropping fields it alone carried.
      for (const f of ['location', 'salary', 'sponsorship_hint', 'category']) {
        if (!next[f] && prev[f]) next[f] = prev[f];
      }
      byKey.set(k, next);
    } else {
      prev.sources = sources;
      for (const f of ['location', 'salary', 'sponsorship_hint', 'category']) {
        if (!prev[f] && r[f]) prev[f] = r[f];
      }
    }
  }
  return [...byKey.values()];
}

export function applyHardNegatives(rows) {
  const kept = [];
  const dropped = [];
  for (const r of rows) {
    if (HARD_NEGATIVE_SPONSORSHIP.has(r.sponsorship_hint)) {
      dropped.push({ ...r, drop_reason: r.sponsorship_hint });
    } else kept.push(r);
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ output */

const COLUMNS = ['source', 'sources', 'company', 'title', 'location', 'url',
  'posted_ts', 'age_days', 'sponsorship_hint', 'salary', 'category'];

function toTsv(rows) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const lines = [COLUMNS.join('\t')];
  for (const r of rows) {
    lines.push(COLUMNS.map((c) => {
      if (c === 'sources') return esc((r.sources || [r.source]).join(','));
      if (c === 'age_days') return r.age_days == null ? '' : r.age_days.toFixed(2);
      return esc(r[c]);
    }).join('\t'));
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) pass++;
    else { fail++; console.error('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
  };

  eq('parseAge minutes', Math.round(parseAge('60m') * 24), 1);
  eq('parseAge days', parseAge('3d'), 3);
  eq('parseAge weeks', parseAge('2w'), 14);
  eq('parseAge junk', parseAge('yesterday'), null);

  eq('cellText strips html', cellText('<a href="x"><strong>Microsoft</strong></a>'), 'Microsoft');
  eq('cellText strips bold', cellText('**Wellmark, Inc.**'), 'Wellmark, Inc.');
  eq('cellUrl prefers href over img src',
    cellUrl('[<img src="images/apply.png" width="80">](https://jobs.smartrecruiters.com/X/1)'),
    'https://jobs.smartrecruiters.com/X/1');
  eq('cellUrl reads html anchor',
    cellUrl('<a href="https://adobe.wd5.myworkdayjobs.com/j"><img src="https://i.imgur.com/a.png"/></a>'),
    'https://adobe.wd5.myworkdayjobs.com/j');

  const zapply = [
    '| Company | Role | Location | Posted | Visa | **Apply** |',
    '|---------|------|----------|--------|------|----------|',
    '| **Wellmark, Inc.** | Data Science Associate | Des Moines, IA | 13m | Sponsor | [<img src="images/apply.png">](https://jobs.smartrecruiters.com/WellmarkInc/744) |',
  ].join('\n');
  const zr = parseMarkdownTables(zapply, { source: 'zapply-ds', category: 'AI/ML/Data' });
  eq('zapply row count', zr.length, 1);
  eq('zapply company', zr[0].company, 'Wellmark, Inc.');
  eq('zapply title', zr[0].title, 'Data Science Associate');
  eq('zapply url', zr[0].url, 'https://jobs.smartrecruiters.com/WellmarkInc/744');
  eq('zapply visa hint', zr[0].sponsorship_hint, 'repo-badge:sponsor');

  const speedy = [
    '| Company | Position | Location | Salary | Posting | Age |',
    '|---|---|---|---|---|---|',
    '| <a href="https://www.microsoft.com"><strong>Microsoft</strong></a> | Data Scientist | Redmond, WA | $52/hr | <a href="https://apply.careers.microsoft.com/careers/job/197"><img src="https://i.imgur.com/JpkfjIq.png"/></a> | 3d |',
  ].join('\n');
  const sr = parseMarkdownTables(speedy, { source: 'speedyapply', category: 'AI/ML/Data' });
  eq('speedy company', sr[0].company, 'Microsoft');
  eq('speedy salary', sr[0].salary, '$52/hr');
  eq('speedy age', sr[0].age_days, 3);
  // The apply column must beat the company anchor, or every row links to a homepage.
  eq('speedy url is apply not homepage', sr[0].url, 'https://apply.careers.microsoft.com/careers/job/197');

  const simp = parseSimplify(JSON.stringify([
    { company_name: 'A', title: 'Data Analyst', url: 'https://a/1', active: true, is_visible: true,
      date_posted: 1700000000, locations: ['NYC'], sponsorship: 'Other', category: 'AI/ML/Data' },
    { company_name: 'B', title: 'X', url: 'https://b/1', active: false, is_visible: true, sponsorship: 'Other' },
    { company_name: 'C', title: 'Y', url: 'https://c/1', active: true, is_visible: true,
      sponsorship: 'U.S. Citizenship is Required' },
  ]));
  eq('simplify drops inactive', simp.length, 2);
  eq('simplify blanks Other hint', simp[0].sponsorship_hint, '');
  eq('simplify keeps real hint', simp[1].sponsorship_hint, 'U.S. Citizenship is Required');

  const { kept, dropped } = applyHardNegatives(simp);
  eq('hard negative dropped', dropped.length, 1);
  eq('hard negative kept', kept.length, 1);

  const merged = mergeRows([
    { source: 'zapply-ds', company: 'Acme', title: 'Data Analyst', location: 'NY', url: 'u1', salary: '$100k' },
    { source: 'simplify', company: 'ACME', title: 'data analyst', location: '', url: 'u2', salary: '' },
  ]);
  eq('merge collapses to one', merged.length, 1);
  eq('merge prefers simplify', merged[0].url, 'u2');
  eq('merge backfills from loser', merged[0].salary, '$100k');
  eq('merge records both sources', merged[0].sources.sort(), ['simplify', 'zapply-ds']);

  // --- source rotation across the two nightly runs
  const ids = ['simplify', 'zapply-ng', 'zapply-ds', 'speedyapply'];
  const r1 = rotateSources(ids, 0, 2);
  eq('run 1 takes the first two repos', r1.slice, ['simplify', 'zapply-ng']);
  const r2 = rotateSources(ids, r1.next, 2);
  eq('run 2 takes DIFFERENT repos', r2.slice, ['zapply-ds', 'speedyapply']);
  const r3 = rotateSources(ids, r2.next, 2);
  eq('night 2 wraps back to the start', r3.slice, ['simplify', 'zapply-ng']);
  eq('all four repos covered in one night', [...r1.slice, ...r2.slice].sort(), ids.slice().sort());
  eq('rotate beyond length is clamped', rotateSources(ids, 0, 99).slice.length, 4);
  eq('rotate zero still returns one', rotateSources(ids, 0, 0).slice.length, 1);
  eq('empty source list is safe', rotateSources([], 0, 2), { slice: [], next: 0 });

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ main */

/**
 * Rotate the repo sources across runs, so two runs a night do not both pull
 * all four. Cursor persists in data/repo-cursor.json.
 *
 * BE HONEST ABOUT THE SAVING: a source is one raw.githubusercontent GET behind
 * a 6h cache, so this costs no tokens either way. What it buys is less
 * duplicate feed churn per run and a shorter run; the real token saving from
 * "don't read the same job twice" comes from nightly-seen.mjs.
 */
export function rotateSources(ids, cursor, take) {
  const n = ids.length;
  if (!n) return { slice: [], next: 0 };
  const t = Math.min(Math.max(1, take), n);
  const start = ((cursor % n) + n) % n;
  const slice = [];
  for (let k = 0; k < t; k++) slice.push(ids[(start + k) % n]);
  return { slice, next: (start + t) % n };
}

const REPO_CURSOR = path.join(ROOT, 'data', 'repo-cursor.json');

function nextSourceSlice(take) {
  const ids = Object.keys(SOURCES);
  let cursor = 0;
  try { if (existsSync(REPO_CURSOR)) cursor = Number(JSON.parse(readFileSync(REPO_CURSOR, 'utf8')).cursor) || 0; }
  catch { cursor = 0; }
  const { slice, next } = rotateSources(ids, cursor, take);
  try {
    if (!existsSync(path.dirname(REPO_CURSOR))) mkdirSync(path.dirname(REPO_CURSOR), { recursive: true });
    writeFileSync(REPO_CURSOR, JSON.stringify({ cursor: next, last: slice, at: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* a cursor we cannot persist just means no rotation, not a failure */ }
  return slice;
}

function parseArgs(argv) {
  const a = { since: 7, sources: Object.keys(SOURCES), json: false, cache: true, out: null, rotate: 0, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--self-test') a.selfTest = true;
    else if (v === '--json') a.json = true;
    else if (v === '--no-cache') a.cache = false;
    else if (v === '--rotate') a.rotate = parseInt(argv[++i], 10);
    else if (v.startsWith('--rotate=')) a.rotate = parseInt(v.slice(9), 10);
    else if (v === '--since') a.since = parseFloat(argv[++i]);
    else if (v.startsWith('--since=')) a.since = parseFloat(v.slice(8));
    else if (v === '--sources') a.sources = argv[++i].split(',').map((s) => s.trim());
    else if (v.startsWith('--sources=')) a.sources = v.slice(10).split(',').map((s) => s.trim());
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
    else if (v === '--help' || v === '-h') a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  if (args.selfTest) return selfTest();

  // --rotate N overrides --sources with the next N in the rotation.
  if (args.rotate > 0) args.sources = nextSourceSlice(args.rotate);

  const all = [];
  const errors = [];
  const stats = {};

  await Promise.all(args.sources.map(async (id) => {
    const src = SOURCES[id];
    if (!src) { errors.push('unknown source: ' + id); return; }
    try {
      const body = await fetchSource(src, { useCache: args.cache });
      const rows = src.kind === 'json'
        ? parseSimplify(body)
        : parseMarkdownTables(body, { source: src.id, category: src.category });
      stats[id] = rows.length;
      all.push(...rows);
    } catch (e) {
      errors.push(id + ': ' + e.message);
      stats[id] = 'ERROR';
    }
  }));

  const fresh = all.filter((r) => r.age_days == null || r.age_days <= args.since);
  const merged = mergeRows(fresh);
  const { kept, dropped } = applyHardNegatives(merged);
  kept.sort((a, b) => (a.age_days ?? 999) - (b.age_days ?? 999));

  const summary = {
    generated_at: new Date().toISOString(),
    since_days: args.since,
    per_source: stats,
    raw: all.length,
    fresh: fresh.length,
    after_merge: merged.length,
    dropped_hard_negative: dropped.length,
    kept: kept.length,
    errors,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, rows: kept, dropped }, null, 2));
  } else {
    const tsv = toTsv(kept);
    if (args.out) {
      const outPath = path.resolve(ROOT, args.out);
      const dir = path.dirname(outPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outPath, tsv);
      console.error(JSON.stringify(summary, null, 2));
      console.error('wrote ' + kept.length + ' rows -> ' + args.out);
    } else {
      process.stdout.write(tsv);
      console.error(JSON.stringify(summary, null, 2));
    }
  }
  return errors.length && !kept.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
