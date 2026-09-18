#!/usr/bin/env node
/**
 * merge-feeds.mjs — fold extra feed files into the primary one. ZERO tokens.
 *
 * The repo feed and the LinkedIn feed share scrape-job-repos.mjs's column set,
 * so merging is a concat plus a dedupe. Dedupe uses the SAME normalized-URL
 * identity as the seen-jobs ledger, so one req arriving from a repo and from
 * LinkedIn with different tracking params collapses to one row instead of being
 * gated and scored twice.
 *
 * First file wins on conflicts and keeps its column order; later files backfill
 * empty fields and merge the `sources` list, so a row confirmed by two feeds is
 * visibly corroborated rather than silently overwritten.
 *
 * Usage:
 *   node scripts/merge-feeds.mjs data/job-feed.tsv data/linkedin-feed.tsv
 *   node scripts/merge-feeds.mjs --out data/all.tsv a.tsv b.tsv
 *   node scripts/merge-feeds.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeUrl } from '../nightly-seen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BACKFILL = ['location', 'salary', 'sponsorship_hint', 'category', 'posted_ts', 'age_days', 'company', 'title'];

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

/** Key a feed row the same way the ledger does. */
export function feedKey(row) {
  const u = normalizeUrl(row && row.url);
  if (u) return u;
  const co = String((row && row.company) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ti = String((row && row.title) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return co + '::' + ti;
}

export function mergeFeeds(feeds) {
  const byKey = new Map();
  const order = [];
  let added = 0, merged = 0;

  for (const rows of feeds) {
    for (const r of rows) {
      const k = feedKey(r);
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, { ...r });
        order.push(k);
        added++;
        continue;
      }
      merged++;
      for (const f of BACKFILL) if (!prev[f] && r[f]) prev[f] = r[f];
      const srcs = new Set(
        [prev.sources, r.sources, prev.source, r.source]
          .filter(Boolean).join(',').split(',').map((s) => s.trim()).filter(Boolean)
      );
      prev.sources = [...srcs].join(',');
    }
  }
  return { rows: order.map((k) => byKey.get(k)), added, merged };
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error('FAIL ' + n + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  };

  const repo = [
    { source: 'simplify', sources: 'simplify', company: 'Acme', title: 'Data Analyst', url: 'https://x.com/j/1', location: '' },
    { source: 'simplify', sources: 'simplify', company: 'Beta', title: 'Data Engineer', url: 'https://y.com/j/2', location: 'NY' },
  ];
  const li = [
    // Same req, different tracking params - must collapse.
    { source: 'linkedin', sources: 'linkedin', company: 'Acme', title: 'Data Analyst', url: 'https://x.com/j/1?utm_source=li', location: 'Boston, MA' },
    { source: 'linkedin', sources: 'linkedin', company: 'Gamma', title: 'AI Engineer', url: 'https://z.com/j/3', location: 'SF' },
  ];

  const m = mergeFeeds([repo, li]);
  eq('three unique reqs', m.rows.length, 3);
  eq('one duplicate collapsed', m.merged, 1);
  eq('first feed keeps the row', m.rows[0].company, 'Acme');
  eq('later feed backfills the empty field', m.rows[0].location, 'Boston, MA');
  eq('both sources recorded', m.rows[0].sources.split(',').sort(), ['linkedin', 'simplify']);
  eq('linkedin-only row survives', m.rows[2].company, 'Gamma');

  // No url: fall back to company::title so two feeds still dedupe.
  const n = mergeFeeds([
    [{ company: 'Solo Co', title: 'Data Analyst', url: '' }],
    [{ company: 'Solo Co', title: 'Data Analyst', url: '', location: 'MA' }],
  ]);
  eq('urlless rows dedupe on company::title', n.rows.length, 1);
  eq('urlless row backfills', n.rows[0].location, 'MA');

  eq('empty input is safe', mergeFeeds([]).rows.length, 0);

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  let out = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i].startsWith('--out=')) out = argv[i].slice(6);
    else files.push(argv[i]);
  }
  if (files.length < 2) { console.error('need at least two feed files'); return 1; }

  const primary = path.resolve(ROOT, files[0]);
  if (!existsSync(primary)) { console.error('missing primary feed: ' + files[0]); return 1; }
  const first = readTsv(readFileSync(primary, 'utf8'));

  const feeds = [first.rows];
  const skipped = [];
  for (const f of files.slice(1)) {
    const p = path.resolve(ROOT, f);
    // A missing secondary feed is not an error: LinkedIn may have been blocked.
    if (!existsSync(p)) { skipped.push(f); continue; }
    feeds.push(readTsv(readFileSync(p, 'utf8')).rows);
  }

  const m = mergeFeeds(feeds);
  const outPath = path.resolve(ROOT, out || files[0]);
  const tmp = outPath + '.tmp';
  writeFileSync(tmp, writeTsv(first.header, m.rows));
  renameSync(tmp, outPath);

  console.error(JSON.stringify({
    primary: files[0],
    merged_in: files.slice(1).filter((f) => !skipped.includes(f)),
    skipped_missing: skipped,
    unique_rows: m.rows.length,
    duplicates_collapsed: m.merged,
    out: path.relative(ROOT, outPath),
  }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
