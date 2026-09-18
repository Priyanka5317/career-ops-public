#!/usr/bin/env node
// ATS score auditor for generated resume PDFs.
//
// Why this exists: check-resume-fit.mjs proves a resume FITS the page, and
// cv-sync-check.mjs proves its facts match cv.md. Neither answers the question an
// applicant actually loses on, which is whether the applicant tracking system can
// READ the PDF at all, and whether the text it reads contains the terms the
// requisition screens for.
//
// This reads the PDF's real text layer (what the ATS sees), not the HTML source.
// Those differ: CSS generated content, flex layouts and letter-spacing all survive
// into the PDF in ways that can scramble extraction.
//
// Two independent halves, reported separately because they fail for different reasons:
//   PARSE (50)  can a naive parser recover contact info, sections, dates, order
//   MATCH (50)  does the text carry the JD's own vocabulary (needs --jd)
// Without --jd only PARSE is scored and the total is out of 50.
//
// Requires pypdf (python -m pip install pypdf). Text extraction is delegated to
// Python because the repo has no Node PDF library and playwright cannot read a
// PDF text layer.
//
// Usage:
//   node check-ats-score.mjs <resume.pdf> --jd <jd.txt>
//   node check-ats-score.mjs <resume.pdf>
//   node check-ats-score.mjs --all                 every resume PDF under output/
//   node check-ats-score.mjs --all --brief         one line per resume

import { spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative, join } from 'path';

const args = process.argv.slice(2);
const jdIdx = args.indexOf('--jd');
const jdPath = jdIdx >= 0 ? args[jdIdx + 1] : null;
const ALL = args.includes('--all');
const BRIEF = args.includes('--brief');
const targets = args.filter((a, i) => !a.startsWith('--') && (jdIdx < 0 || i !== jdIdx + 1));

const PY = `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
pages = [p.extract_text() or '' for p in r.pages]
print(json.dumps({"pages": pages, "n": len(r.pages)}))
`;

function pdfText(file) {
  const res = spawnSync('python', ['-c', PY, resolve(file)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.status !== 0) return { error: (res.stderr || '').trim().split('\n').pop() };
  try { return JSON.parse(res.stdout); } catch { return { error: 'unparseable extractor output' }; }
}

// ---------- PARSE checks ----------
function scoreParse(text, nPages) {
  const checks = [];
  const add = (ok, pts, max, label, detail) => checks.push({ ok, pts: ok ? pts : 0, max, label, detail });
  const t = text;
  const flat = t.replace(/\s+/g, ' ');

  // 1. text layer at all (the fatal one)
  const chars = t.replace(/\s/g, '').length;
  add(chars > 800, 12, 12, 'Text layer present',
    `${chars} non-space chars extracted` + (chars <= 800 ? ' — an ATS would read almost nothing' : ''));

  // 2. contact
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(flat);
  add(!!email, 6, 6, 'Email recoverable', email ? email[0] : 'no email pattern found');

  const linkedin = /linkedin\.com\/in\/[\w-]+/i.test(flat);
  const github = /github\.com\/[\w-]+/i.test(flat);
  add(linkedin || github, 4, 4, 'Profile URL recoverable',
    [linkedin && 'LinkedIn', github && 'GitHub'].filter(Boolean).join(' + ') || 'neither LinkedIn nor GitHub URL survived');

  // 3. standard headings — ATS section segmentation depends on these
  const wanted = ['EXPERIENCE', 'EDUCATION', 'SKILL'];
  const found = wanted.filter(w => new RegExp(w, 'i').test(flat));
  add(found.length === wanted.length, 8, 8, 'Standard section headings',
    `found ${found.join(', ') || 'none'}${found.length < wanted.length ? ` — missing ${wanted.filter(w => !found.includes(w)).join(', ')}` : ''}`);

  // 4. parseable employment dates
  const MON = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
  const ranges = flat.match(new RegExp(`${MON}\\s*\\d{4}\\s*(?:-|–|—|to)\\s*(?:${MON}\\s*\\d{4}|Present|Current)`, 'gi')) || [];
  add(ranges.length >= 3, 6, 6, 'Employment date ranges parseable',
    `${ranges.length} range(s) recovered` + (ranges.length ? `: ${ranges.slice(0, 3).join(' | ')}` : ''));

  // 5. single page — multi-page resumes get truncated by some parsers
  add(nPages === 1, 3, 3, 'Single page', `${nPages} page(s)`);

  // 6. word integrity — letter-spacing and kerning can split words per glyph
  const words = flat.split(' ').filter(Boolean);
  const singles = words.filter(w => /^[A-Za-z]$/.test(w)).length;
  const ratio = words.length ? singles / words.length : 1;
  add(ratio < 0.04, 4, 4, 'Words not split into glyphs',
    `${(ratio * 100).toFixed(1)}% single-letter tokens${ratio >= 0.04 ? ' — letter-spacing is fragmenting words' : ''}`);

  // 7. LIGATURE SUBSTITUTION - the highest-value check in this file.
  // Chromium renders fi/fl/ff/ffi/ffl as single Unicode ligature glyphs (U+FB00-04).
  // A keyword-matching ATS then reads "Airflow" as "Airﬂow" and scores that skill
  // ABSENT even though it is printed on the page. Fix: font-variant-ligatures: none.
  const LIG = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' };
  const ligs = (t.match(/[ﬀ-ﬄ]/g) || []).length;
  const broken = [...new Set((t.match(/\S*[ﬀ-ﬄ]\S*/g) || [])
    .map(w => w.replace(/[ﬀ-ﬄ]/g, c => LIG[c]).replace(/^\W+|\W+$/g, '')))];
  add(ligs === 0, 5, 5, 'No ligature substitution',
    ligs === 0 ? 'clean' : `${ligs} glyph(s) breaking ${broken.length} word(s): ${broken.slice(0, 6).join(', ')}`);

  // 8. replacement characters - genuine mojibake, distinct from ordinary bullet glyphs
  const bad = (t.match(/�/g) || []).length;
  add(bad === 0, 2, 2, 'No replacement characters',
    bad === 0 ? 'clean' : `${bad} U+FFFD replacement char(s), an encoding fault`);

  const bullets = (t.match(/[▪■●•◦]/g) || []).length;
  if (bullets) checks.push({ ok: true, pts: 0, max: 0, label: 'note: bullet glyphs',
    detail: `${bullets} list-marker glyph(s) in the text layer (normal; most parsers strip these)` });

  return checks;
}

// ---------- MATCH checks ----------
const STOP = new Set((
  // grammar and filler
  'a an and are as at be by for from has have had in is it its of on or that the to with will you your our we us this those these was were been being do does did not no nor but if then than so such very much many few own same each every either neither both all any some most more less least other another' +
  // JD boilerplate that appears in almost every posting and says nothing about fit
  ' role position title team teams work working works experience experiences year years ability able skill skills strong excellent good great solid proven demonstrated across within their them they there here who what when which while also into out up down over under between during after before through' +
  ' including include includes included support supporting supported help helps helped new all can may might must should would could job company business career careers required require requires requirement requirements preferred prefer qualification qualifications responsibility responsibilities duties plus etc via per' +
  ' opportunity opportunities candidate candidates applicant applicants apply application employer employee employees staff people person individual member members join joining hiring hire' +
  ' basic advanced entry level senior junior general specific relevant applicable appropriate effective efficient successful successfully' +
  ' provide provides providing ensure ensures ensuring maintain maintains maintaining perform performs performing conduct conducts assist assists deliver delivers delivering contribute contributes create creates creating develop develops developing improve improves improving learn learns learning understand understanding' +
  ' environment culture mission vision values benefits compensation salary pay range annual full time part remote hybrid onsite office location locations united states us' +
  ' day days week weeks month months quarter quarterly annually daily weekly monthly' +
  ' other others including etc using use used uses utilize utilizing based upon about above below following follow follows'
).split(/\s+/).filter(Boolean));

function jdTerms(jd) {
  const raw = jd.replace(/[^\w+#./-]+/g, ' ').split(/\s+/).filter(Boolean);
  const counts = new Map();
  for (const w0 of raw) {
    const w = w0.replace(/^[./-]+|[./-]+$/g, '');
    if (w.length < 3 || /^\d+$/.test(w)) continue;
    const k = w.toLowerCase();
    if (STOP.has(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // keep terms that look like skills/nouns: capitalised in JD, or repeated, or known-tech shaped
  const TECH = /^(sql|python|r|java|scala|excel|tableau|power|powerbi|quicksight|looker|redshift|snowflake|databricks|airflow|dbt|glue|spark|hadoop|hive|kafka|etl|elt|bi|kpi|aws|azure|gcp|salesforce|mcp|llm|ml|ai|dax|vba|nosql|api|crm|erp|saas)$/;
  return [...counts.entries()]
    .filter(([k, c]) => c >= 2 || TECH.test(k) || k.length >= 6)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => ({ term: k, freq: c }));
}

function scoreMatch(text, jd) {
  const hay = text.toLowerCase().replace(/[^\w\s+#.-]/g, ' ');
  const terms = jdTerms(jd);
  const top = terms.slice(0, 60);
  const hit = [], miss = [];
  for (const t of top) {
    const stem = t.term.replace(/(ing|ed|es|s)$/, '');
    const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    (re.test(hay) ? hit : miss).push(t);
  }
  const pct = top.length ? hit.length / top.length : 0;
  return { pts: Math.round(pct * 50), hit, miss, total: top.length, pct };
}

function auditOne(file, jd) {
  const out = pdfText(file);
  if (out.error) return { file, error: out.error };
  const text = out.pages.join('\n');
  const parse = scoreParse(text, out.n);
  const parsePts = parse.reduce((s, c) => s + c.pts, 0);
  const parseMax = parse.reduce((s, c) => s + c.max, 0);
  const match = jd ? scoreMatch(text, jd) : null;
  const total = parsePts + (match ? match.pts : 0);
  const max = parseMax + (match ? 50 : 0);
  return { file, text, parse, parsePts, parseMax, match, total, max };
}

function band(pct) {
  return pct >= 0.9 ? 'STRONG' : pct >= 0.75 ? 'OK' : pct >= 0.6 ? 'WEAK' : 'POOR';
}

function report(r) {
  if (r.error) { console.log(`  ERROR  ${relative(process.cwd(), r.file)} — ${r.error}`); return; }
  const pct = r.total / r.max;
  if (BRIEF) {
    console.log(`  ${band(pct).padEnd(6)} ${String(r.total).padStart(3)}/${r.max}  ${relative(process.cwd(), r.file)}`);
    return;
  }
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${relative(process.cwd(), r.file)}`);
  console.log(`ATS SCORE: ${r.total}/${r.max}  [${band(pct)}]   parse ${r.parsePts}/${r.parseMax}${r.match ? `, match ${r.match.pts}/50` : ''}`);
  console.log(`${'-'.repeat(78)}\nPARSE`);
  for (const c of r.parse) console.log(`  ${(c.ok ? 'ok  ' : 'FAIL')}  ${c.label.padEnd(34)} ${c.detail}`);
  if (r.match) {
    console.log(`\nMATCH  ${r.match.hit.length}/${r.match.total} JD terms present (${(r.match.pct * 100).toFixed(0)}%)`);
    if (r.match.miss.length) {
      console.log(`  MISSING, highest JD frequency first:`);
      for (const m of r.match.miss.slice(0, 18)) console.log(`    - ${m.term}${m.freq > 1 ? `  (x${m.freq} in JD)` : ''}`);
    }
  }
}

// ---------- run ----------
let files = targets;
if (ALL) {
  files = [];
  const walk = d => { for (const e of readdirSync(d)) { const p = join(d, e); const s = statSync(p); if (s.isDirectory()) walk(p); else if (/Resume.*\.pdf$/i.test(e)) files.push(p); } };
  walk('output');
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
if (!files.length) { console.error('no resume PDF given; use a path or --all'); process.exit(1); }

const jd = jdPath && existsSync(jdPath) ? readFileSync(jdPath, 'utf8') : null;
if (jdPath && !jd) console.error(`WARNING: --jd ${jdPath} not found; scoring PARSE only\n`);

console.log(`ATS audit: ${files.length} resume PDF(s)${jd ? `, matched against ${jdPath}` : ', PARSE only (no --jd)'}`);
const results = files.map(f => auditOne(f, jd));
results.forEach(report);

const scored = results.filter(r => !r.error);
if (scored.length > 1) {
  const avg = scored.reduce((s, r) => s + r.total / r.max, 0) / scored.length;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${scored.length} scored, average ${(avg * 100).toFixed(0)}%`);
  const fails = new Map();
  for (const r of scored) for (const c of r.parse) if (!c.ok) fails.set(c.label, (fails.get(c.label) || 0) + 1);
  if (fails.size) {
    console.log('Most common PARSE failures:');
    [...fails.entries()].sort((a, b) => b[1] - a[1]).forEach(([l, n]) => console.log(`  ${String(n).padStart(4)}  ${l}`));
  }
}
