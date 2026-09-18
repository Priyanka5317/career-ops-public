#!/usr/bin/env node
// Outreach rule linter.
//
// Audits every outreach artifact (emails, DMs, referral notes, cover letters,
// letters of interest, decks) against the standing cross-channel rules. Resumes
// are checked too, but the degree rule is skipped for them because the Education
// section legitimately belongs at the bottom of a resume.
//
// Usage:
//   node check-outreach-rules.mjs            audit everything under output/
//   node check-outreach-rules.mjs <glob>     audit specific files
//   node check-outreach-rules.mjs --rule=degree   only one rule
//   node check-outreach-rules.mjs --pdf      also scan PDF text layers
//   node check-outreach-rules.mjs --fix      strip invisible chars (.bak kept)
//
// Exit code is the number of distinct files with findings (0 = clean).

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'fs';
import { relative, resolve } from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--rule=')) || '').split('=')[1];
const patterns = args.filter((a) => !a.startsWith('--'));
const wantPdf = args.includes('--pdf');
const wantFix = args.includes('--fix');
let pdfScanned = 0;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GitHub handle for the mandatory signature check. Read from config/profile.yml
// (candidate.github) so the linter is not tied to one person's account; the
// env var wins when set, and an unset handle disables the check.
const GITHUB_HANDLE = (() => {
  if (process.env.CAREER_OPS_GITHUB_HANDLE) return process.env.CAREER_OPS_GITHUB_HANDLE.trim();
  try {
    const yml = readFileSync('config/profile.yml', 'utf8');
    const m = yml.match(/^\s*github:\s*(.+)$/m);
    if (m) {
      return m[1].trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+#.*$/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^github\.com\//i, '')
        .replace(/\/+$/, '');
    }
  } catch { /* no profile yet */ }
  return '';
})();

const files = [
  ...new Set(
    (patterns.length
      ? patterns.flatMap((p) => globSync(p, { nodir: true }))
      : globSync('output/**/*.{txt,html}', { nodir: true })
    ).filter((f) => !/\.(pdf|png|svg)$/i.test(f))
  ),
].sort();

const isResume = (f) => /resume/i.test(f);
// Routing/among-notes lines are guidance to the candidate, not sent copy.
const isNoteLine = (l) =>
  /^(To|Channel|Role|LinkedIn|Subject line|---|\(|NOTE|If .* raises|Second-degree|Do not volunteer)/i.test(l.trim());

// Strip HTML tags so prose rules do not fire on markup/attributes.
const textOf = (raw, f) =>
  /\.html$/i.test(f)
    ? raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ')
    : raw;

// ---------------------------------------------------------------------------
// Invisible-character audit (Layer A).
//
// These codepoints render as nothing but survive into the PDF text layer, where
// they split words an ATS is trying to match: a zero-width space inside
// "Snowflake" leaves two fragments that match nothing, the same failure mode as
// the ligature bug. They arrive invisibly through copy-paste from chat UIs and
// web pages, so a file that looks clean is not evidence that it is clean.
//
// Two severities. "invisible" has no legitimate place in these artifacts and is
// safe to strip. "exotic-space" is reported but never auto-stripped, because a
// literal NBSP in a template is often deliberate line-break control.
// ---------------------------------------------------------------------------
const INVIS_RE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
const SPACE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

const CHAR_NAMES = {
  0x00ad: 'SOFT HYPHEN', 0x061c: 'ARABIC LETTER MARK', 0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x200b: 'ZERO WIDTH SPACE', 0x200c: 'ZERO WIDTH NON-JOINER', 0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK', 0x200f: 'RIGHT-TO-LEFT MARK', 0x2060: 'WORD JOINER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE (BOM)', 0x00a0: 'NO-BREAK SPACE',
  0x202f: 'NARROW NO-BREAK SPACE', 0x205f: 'MEDIUM MATHEMATICAL SPACE', 0x3000: 'IDEOGRAPHIC SPACE',
};

function charName(cp) {
  if (CHAR_NAMES[cp]) return CHAR_NAMES[cp];
  if (cp >= 0x2000 && cp <= 0x200a) return 'EXOTIC SPACE';
  if (cp >= 0x202a && cp <= 0x202e) return 'BIDI OVERRIDE';
  if (cp >= 0x2061 && cp <= 0x2064) return 'INVISIBLE MATH OPERATOR';
  if (cp >= 0x2066 && cp <= 0x2069) return 'BIDI ISOLATE';
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 'VARIATION SELECTOR';
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'TAG CHARACTER (watermark class)';
  return 'INVISIBLE';
}

const hex = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

// Render a line with the offending codepoints made visible, so the report is
// readable. Without this the snippet looks identical to clean text.
function markUp(line, re) {
  return line.replace(new RegExp(re.source, re.flags), (m) => `«${hex(m.codePointAt(0))}»`);
}

// Scan raw text (never the tag-stripped body): a literal invisible char in
// markup still reaches the rendered PDF, while an `&nbsp;` entity is plain
// ASCII here and correctly does not fire.
function scanInvisible(raw, id, re) {
  const out = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const hits = [...line.matchAll(re)];
    if (!hits.length) return;
    const counts = {};
    for (const h of hits) {
      const n = `${hex(h[0].codePointAt(0))} ${charName(h[0].codePointAt(0))}`;
      counts[n] = (counts[n] || 0) + 1;
    }
    const what = Object.entries(counts).map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ');
    out.push({ line: i + 1, id, what, snip: markUp(line.trim(), re).replace(/\s+/g, ' ').slice(0, 105) });
  });
  return out;
}

const RULES = [
  { id: 'em-dash',    re: /[—–]/,                         msg: 'em or en dash (banned cross-channel)' },
  { id: 'dbl-hyphen', re: /(^|\s)--(\s|$)/,               msg: 'double hyphen used as a dash' },
  { id: 'percent',    re: /\bpercent\b/i,                 msg: 'spelled-out "percent", use %' },
  { id: 'in-person',  re: /\b(?:I|my|me)\b[^.]{0,70}\bin[- ]person\b|\bin[- ]person\b[^.]{0,40}\b(?:works|suits|fine|ready|easy|no problem)\b|willing to travel|happy to travel|travel for (?:an? |the )?(?:interview|team|summit)|onsite schedule works|office-first/i,
                      msg: 'offers in-person availability or interview travel' },
  { id: 'degree',     re: /\b(?:master'?s|bachelor'?s|M\.?S\.?\s+(?:in\s+)?Information Systems|graduating (?:in )?(?:May|Dec|December)|MS Information Systems)\b/i,
                      msg: 'names her degree in outreach', skipResume: true },
  { id: 'years-exp',  re: /\b\d+\+?\s*(?:years?|yrs?)\s+of\s+(?:experience|professional)/i,
                      msg: 'states years of experience' },
  { id: 'gap-talk',   re: /\b(?:career gap|employment gap|the gaps?|would be new to me|straight about the gap)\b/i,
                      msg: 'names a gap or weakness' },
  { id: 'visa-talk',  re: /\b(?:sponsorship|visa|H-?1B|work authoriz|green card|OPT)\b/i,
                      msg: 'raises sponsorship or work authorization unprompted' },
  { id: 'url-punct',  re: /vercel\.app\/ref\/[a-z0-9-]+[,.;)]/i,
                      msg: 'punctuation touching a portfolio URL (breaks auto-link)' },
];

const active = RULES.filter((r) => !only || r.id === only);

let findings = [];
for (const f of files) {
  let raw;
  try { raw = readFileSync(f, 'utf-8'); } catch { continue; }
  const body = textOf(raw, f);
  const lines = body.split(/\r?\n/);

  // Invisible characters are matched on the raw bytes, not the prose body, and
  // are never suppressed by isNoteLine: a watermark in a routing note still
  // ends up in the file she ships.
  if (!only || only === 'invisible') {
    for (const h of scanInvisible(raw, 'invisible', INVIS_RE))
      findings.push({ f: relative(process.cwd(), f), ...h, msg: 'invisible character in shipped text' });
  }
  if (!only || only === 'exotic-space') {
    for (const h of scanInvisible(raw, 'exotic-space', SPACE_RE))
      findings.push({ f: relative(process.cwd(), f), ...h, msg: 'non-ASCII space (review, not auto-stripped)' });
  }

  for (const r of active) {
    if (r.skipResume && isResume(f)) continue;
    lines.forEach((line, i) => {
      if (isNoteLine(line)) return;
      if (!r.re.test(line)) return;
      const snip = line.trim().replace(/\s+/g, ' ').slice(0, 105);
      findings.push({ f: relative(process.cwd(), f), line: i + 1, id: r.id, msg: r.msg, snip });
    });
  }

  // Signature check: emails only (not DMs, not decks, not resumes, not answer sheets).
  if ((!only || only === 'signature') && /\.txt$/i.test(f) && /email/i.test(f) && !/dm|linkedin/i.test(f)) {
    const sigRe = GITHUB_HANDLE
      ? new RegExp('github\\.com/' + escapeRe(GITHUB_HANDLE), 'i')
      : null;
    if (sigRe && !sigRe.test(raw)) {
      findings.push({ f: relative(process.cwd(), f), line: 0, id: 'signature', msg: 'email missing the mandatory signature block', snip: '' });
    }
  }
  // DM length check.
  if ((!only || only === 'dm-length') && /dm|linkedin|connect-|referral-/i.test(f) && /\.txt$/i.test(f)) {
    for (const line of lines) {
      const t = line.trim();
      if (/^Hi /.test(t) && t.length > 300) {
        findings.push({ f: relative(process.cwd(), f), line: 0, id: 'dm-length', msg: `short-form message is ${t.length} chars, limit 300`, snip: t.slice(0, 80) });
      }
    }
  }
}

// --- PDF text layer (--pdf) ------------------------------------------------
// Detection only: PDFs are binary containers and are never rewritten in place.
// Extraction is delegated to pypdf in one batched call, not one process per file.
//
// MEASURED 2026-09-11, AND THE RESULT IS COUNTERINTUITIVE: for anything rendered
// through Chromium (which is the whole pack pipeline), this scan will essentially
// always come back clean, and that is NOT evidence the source was clean. Chromium
// converts every invisible codepoint into a VISIBLE space when it writes the text
// layer. Tested ZWSP, ZWNJ, ZWJ, word joiner, soft hyphen, BOM, NBSP and a tag
// character: all nine rendered "Snow<char>flake" as "Snow flake". Only U+202F
// leaves a trace, as U+2009 THIN SPACE.
//
// So the damage is worse than a surviving watermark and leaves nothing invisible
// to find: the keyword silently splits in two and the ATS matches neither half,
// the same failure mode as the ligature bug. The only place it is detectable is
// the HTML/txt source BEFORE rendering, which is what the default scan covers.
// Word-splitting in a finished PDF is already caught by check-ats-score.mjs,
// whose MATCH half compares the extracted text against the JD's vocabulary.
//
// Keep --pdf for PDFs that did not come from this pipeline; do not read a clean
// result here as a clean bill of health for the pack.
if (wantPdf) {
  const pdfs = (patterns.length
    ? patterns.flatMap((p) => globSync(p, { nodir: true }))
    : globSync('output/**/*.pdf', { nodir: true })
  ).filter((f) => /\.pdf$/i.test(f)).sort();

  if (pdfs.length) {
    const PY = `
import sys, json, re
from pypdf import PdfReader
pat = re.compile('[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufe00-\\ufe0f\\ufeff]|[\\U000E0000-\\U000E007F]')
out = {}
for p in sys.argv[1:]:
    try:
        t = '\\n'.join((pg.extract_text() or '') for pg in PdfReader(p).pages)
    except Exception as e:
        out[p] = {'error': str(e)}; continue
    c = {}
    for m in pat.finditer(t):
        c['U+%04X' % ord(m.group())] = c.get('U+%04X' % ord(m.group()), 0) + 1
    if c: out[p] = {'counts': c}
print(json.dumps(out))
`;
    // Chunked so the argv line stays under the Windows command-length limit.
    for (let i = 0; i < pdfs.length; i += 60) {
      const batch = pdfs.slice(i, i + 60);
      const res = spawnSync('python', ['-c', PY, ...batch.map((p) => resolve(p))],
        { encoding: 'utf8', maxBuffer: 1 << 28 });
      let parsed;
      try { parsed = JSON.parse(res.stdout); } catch {
        console.error(`  ! pdf extraction failed for batch ${i / 60 + 1}: ${(res.stderr || '').trim().split('\n').pop()}`);
        continue;
      }
      for (const [p, v] of Object.entries(parsed)) {
        const rel = relative(process.cwd(), p);
        if (v.error) { console.error(`  ! ${rel}: ${v.error}`); continue; }
        const what = Object.entries(v.counts)
          .map(([cp, n]) => `${cp} ${charName(parseInt(cp.slice(2), 16))}${n > 1 ? ` x${n}` : ''}`).join(', ');
        findings.push({ f: rel, line: 0, id: 'invisible-pdf', what, snip: '',
          msg: 'invisible character in the PDF text layer (what the ATS reads)' });
      }
    }
    pdfScanned = pdfs.length;
  }
}

// --- Fixer (--fix) ---------------------------------------------------------
// Strips the "invisible" class only, from .txt/.html sources, with a .bak
// alongside each file it touches. Exotic spaces are left alone (a literal NBSP
// in a template is often deliberate) and PDFs are never rewritten: the fix for
// a dirty PDF is to clean its HTML source and re-render.
if (wantFix) {
  const dirty = [...new Set(findings.filter((x) => x.id === 'invisible').map((x) => x.f))];
  if (!dirty.length) {
    console.log('--fix: nothing to strip, no invisible characters found.\n');
  } else {
    console.log(`--fix: stripping invisible characters from ${dirty.length} file(s)\n`);
    for (const f of dirty) {
      const raw = readFileSync(f, 'utf-8');
      const cleaned = raw.replace(new RegExp(INVIS_RE.source, 'gu'), '');
      if (cleaned === raw) continue;
      writeFileSync(f + '.bak', raw, 'utf-8');
      writeFileSync(f, cleaned, 'utf-8');
      console.log(`   fixed  ${f}  (-${raw.length - cleaned.length} chars, backup at ${f}.bak)`);
    }
    console.log('');
    findings = findings.filter((x) => x.id !== 'invisible');
  }
}

const byFile = findings.reduce((a, x) => ((a[x.f] = a[x.f] || []).push(x), a), {});
const fileCount = Object.keys(byFile).length;

console.log(`Outreach rule audit: ${files.length} source file(s)` + (pdfScanned ? ` + ${pdfScanned} PDF(s)` : (wantPdf ? ' + 0 PDF(s) found' : ' (PDFs skipped, pass --pdf)')) + `, ${findings.length} finding(s) across ${fileCount} file(s)
`);

const order = ['invisible', 'invisible-pdf', 'degree', 'years-exp', 'gap-talk', 'visa-talk', 'in-person', 'signature', 'url-punct', 'em-dash', 'dbl-hyphen', 'percent', 'dm-length', 'exotic-space'];
for (const id of order) {
  const hits = findings.filter((x) => x.id === id);
  if (!hits.length) continue;
  console.log(`## ${id}  (${hits.length})  ${hits[0].msg}`);
  for (const h of hits) {
    console.log(`   ${h.f}:${h.line}${h.what ? `  [${h.what}]` : ''}`);
    if (h.snip) console.log(`     ${h.snip}`);
  }
  console.log('');
}

if (!findings.length) console.log('Clean. No rule violations found.');
process.exit(fileCount);
