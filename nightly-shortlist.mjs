#!/usr/bin/env node
/**
 * nightly-shortlist.mjs — Zero-token filter + rank stage of the nightly pipeline.
 *
 * Sits between scrape-job-repos.mjs (raw feed) and the LLM agents. Its whole job
 * is to make sure no token is ever spent on a posting that is already applied
 * to, already built, structurally out of scope, or a known hard wall.
 *
 * Inputs:
 *   data/job-feed.tsv         from scrape-job-repos.mjs
 *   data/applications.md      the tracker — the authority on "already seen"
 *   output/                   built packs — a pack on disk counts as seen even
 *                             when the tracker row was never written (packs have
 *                             gone half-built and unlogged before)
 *   config/nightly.yml        role families, caps, thresholds
 *   config/industries.yml     the candidate's target industries (optional)
 *   data/skip-list.tsv        employers/reqs the visa gate already ruled out
 *
 * Output: a ranked TSV shortlist. The heuristic score RANKS candidates for the
 * agents to evaluate; it never decides fit. Only the LLM evaluation assigns the
 * real /5 score, and only Agent 3 decides the visa question.
 *
 * Usage:
 *   node nightly-shortlist.mjs                       # rank, print summary
 *   node nightly-shortlist.mjs --out data/shortlist.tsv
 *   node nightly-shortlist.mjs --limit 40
 *   node nightly-shortlist.mjs --json
 *   node nightly-shortlist.mjs --explain             # show why rows were dropped
 *   node nightly-shortlist.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
// The ledger's own key function. Reimplementing it drifted immediately (see the
// note by the ledgerKey re-export), so the rotation shares the real one.
import { normalizeUrl as ledgerKey } from './nightly-seen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ normalize */

/** Company-name key for cross-source matching. Drops legal suffixes and punctuation. */
export function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    // A leading "The" defeats prefix matching: "The University of Texas at
    // Austin" and "University of Texas at Austin" are the same employer.
    .replace(/^\s*the\s+/, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|pbc|lp|llp|gmbh|sa|nv|ag|holdings|group|technologies|technology|labs|systems)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ------------------------------------------------------------------ seen set */

/**
 * Company names already in the tracker. The Company cell is heavily annotated
 * prose, but the employer is always the leading bold span, so read that and
 * ignore the commentary after it.
 */
export function parseTrackerCompanies(md) {
  const out = new Set();
  const rows = new Set();
  for (const line of String(md).split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | # | Date | Company | Role | ...  -> leading empty cell from the split
    const companyCell = cells[3] || '';
    const roleCell = cells[4] || '';
    const bold = companyCell.match(/\*\*([^*]+)\*\*/);
    const company = bold ? bold[1] : companyCell.split(/[-(]/)[0];
    const key = companyKey(company);
    if (!key) continue;
    out.add(key);
    const roleBold = roleCell.match(/\*\*([^*]+)\*\*/);
    const role = roleBold ? roleBold[1] : roleCell.split(/[-(]/)[0];
    rows.add(key + '::' + titleKey(role));
  }
  return { companies: out, roles: rows };
}

/**
 * Parse data/skip-list.tsv — employers/reqs already ruled out by the visa gate.
 *
 * Without this, a confirmed hard wall gets a full LCA + E-Verify evaluation
 * again every single night until the posting ages out of the feed. Wellmark's
 * Data Science Associate was the first: the company genuinely sponsors, but that
 * req names F1-OPT and F1-CPT among its excluded categories.
 *
 * A `*` (or empty) title skips the whole employer. A specific title skips only
 * that req, which is the common case — a carve-out on one posting says nothing
 * about the rest of the company's openings.
 */
/**
 * Every company key a skip-list entry should answer to.
 *
 * The visa agent records the FULL legal entity ("Lawrence Livermore National
 * Security, LLC (LLNL)") while the feed carries a short brand ("LLNL"), so a
 * single exact key misses and the employer gets re-evaluated every night. This
 * indexes the full string, the part before any bracket or semicolon, and each
 * parenthesised alias.
 */
export function companyAliasKeys(name) {
  const raw = String(name || '');
  const keys = new Set();
  const add = (v) => { const k = companyKey(v); if (k && k.length >= 3) keys.add(k); };
  add(raw);
  add(raw.split(/[(;:]/)[0]);                       // "Veolia (US filer: ...)" -> "Veolia"
  for (const m of raw.matchAll(/\(([^)]+)\)/g)) {   // "(LLNL)" -> "LLNL"
    add(m[1]);
    add(m[1].split(/[;:,]/)[0]);
  }
  return keys;
}

export function parseSkipList(tsv) {
  const exact = new Set();
  const wholeCompany = new Set();
  const lines = String(tsv).split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const [company, title] = line.split('\t');
    const keys = companyAliasKeys(company);
    if (!keys.size) continue;
    const t = (title || '').trim();
    for (const k of keys) {
      if (!t || t === '*') wholeCompany.add(k);
      else exact.add(k + '::' + titleKey(t));
    }
  }
  return { exact, wholeCompany };
}

// A legal name usually EXTENDS the brand ("Comcast" -> "Comcast Cable
// Communications, LLC"), which no alias split recovers, so fall back to prefix
// matching. The 6-character floor is the safety valve: it keeps "Comcast" and
// "Veolia" working while refusing to match on a 3-letter stub. It is not
// perfect ("General" would prefix both General Motors and General Electric),
// but feeds supply the full brand, so that collision needs a bare first word.
const SKIP_PREFIX_MIN = 6;

function prefixHit(keys, candidate) {
  for (const k of keys) {
    if (k === candidate) return true;
    const [shortK, longK] = k.length <= candidate.length ? [k, candidate] : [candidate, k];
    if (shortK.length >= SKIP_PREFIX_MIN && longK.startsWith(shortK)) return true;
  }
  return false;
}

export function isSkipListed(skip, company, title) {
  const tk = titleKey(title);
  for (const k of companyAliasKeys(company)) {
    if (skip.wholeCompany.has(k) || skip.exact.has(k + '::' + tk)) return true;
    if (prefixHit(skip.wholeCompany, k)) return true;
    // Title-scoped entries: compare only the company half of the composite key.
    for (const e of skip.exact) {
      const idx = e.lastIndexOf('::');
      if (idx < 0) continue;
      if (e.slice(idx + 2) !== tk) continue;
      if (prefixHit([e.slice(0, idx)], k)) return true;
    }
  }
  return false;
}

/**
 * Pack directories in output/, mapped to whether they are actually FINISHED.
 *
 * A directory's existence is not evidence of a built pack. The run on 2026-09-08
 * died mid-fan-out and left seven folders holding a single resume HTML and no
 * PDF. Treating those as "built" would have silently suppressed ServiceNow,
 * Zoox, Spotify, Cox, Pivotal Aero and Sandisk from every future shortlist,
 * turning an interrupted run into six permanently lost employers.
 *
 * A PDF is the completeness signal: it is the artifact she actually sends, and
 * nothing writes one until the render step succeeds.
 *
 * @param names  directory entry names
 * @param pdfCountFor  (name) => number of PDFs inside; omit to assume complete
 * @returns Map name -> { complete: boolean }
 */
export function parseOutputDirs(names, pdfCountFor) {
  const out = new Map();
  for (const n of names) {
    if (!n || n.includes('.')) continue; // skip files like applications-tracker.csv
    const key = n.toLowerCase();
    const pdfs = pdfCountFor ? pdfCountFor(n) : 1;
    out.set(key, { complete: pdfs > 0 });
  }
  return out;
}

/** URL-style slug, the same shape pack directories use. */
export function companySlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A pack dir is named {company-slug}-{role-slug}. Match at the SLUG BOUNDARY,
 * never on a bare character prefix: "meta" prefix-matches "metabase-data-analyst"
 * and would silently suppress every Meta role because an unrelated Metabase pack
 * exists. Requiring the dir to be the slug, or the slug followed by "-", makes
 * that impossible.
 *
 * Legal suffixes vary between the feed and the pack name ("Wellmark, Inc." vs
 * wellmark-data-analyst), so try the suffix-stripped slug too.
 */
export function packState(outputDirs, company) {
  const candidates = new Set();
  const full = companySlug(company);
  if (full) candidates.add(full);
  const stripped = companySlug(
    String(company || '').replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|pbc|lp|llp)\b\.?/gi, ' ')
  );
  if (stripped) candidates.add(stripped);

  let sawIncomplete = false;
  for (const slug of candidates) {
    if (slug.length < 3) continue;
    for (const [d, meta] of outputDirs) {
      if (d === slug || d.startsWith(slug + '-')) {
        if (meta.complete) return 'complete';
        sawIncomplete = true;
      }
    }
  }
  return sawIncomplete ? 'incomplete' : 'none';
}

/** Back-compat boolean: only a FINISHED pack counts as built. */
export function hasBuiltPack(outputDirs, company) {
  return packState(outputDirs, company) === 'complete';
}

/* ------------------------------------------------------------------ filters */

// Titles that are structurally wrong for an entry-level candidate. Applied to
// the title only, never to the JD body.
export const SENIORITY_BLOCK = [
  /\bsenior\b/i, /\bsr\.?\b/i, /\bstaff\b/i, /\bprincipal\b/i, /\bdirector\b/i,
  /\bvp\b/i, /\bvice president\b/i, /\bhead of\b/i, /\blead\b/i,
  /\bfellow\b/i, /\barchitect\b/i, /\bexecutive\b/i, /\bchief\b/i,
];

// Entry level only. Her rule, TIGHTENED 2026-09-09: "less than 2 years of work
// experience". A req demanding MORE than 2 years is out; 2 or fewer is fine.
// The ceiling itself lives in config/nightly.yml -> experience.max_years.

// Level markers, gated on config experience.block_level_markers.
//
// These catch the case no years parser can: "Data Scientist II" states no
// requirement anywhere in the title, and often none in the JD body either, but
// a II is never an entry-level req. Roman I is deliberately ALLOWED — "Data
// Engineer I" is entry level and one was correctly built on 2026-09-08.
//
// Deliberately does NOT include bare L2/T2 ladder codes. They collide with
// unrelated title tokens and a false skip costs an opportunity, which is the
// standing tradeoff everywhere else in this file.
export const LEVEL_MARKER_BLOCK = [
  /\b(ii|iii|iv)\b/i,
  /\bmid[-\s]?level\b/i,
  /\bmid[-\s]?senior\b/i,
  /\blevel\s*[2-9]\b/i,
  /\bexperienced\b/i,
  // "Data Engineer (Intermediate)" reached the shortlist on the first run of
  // the new pipeline. Intermediate is the rung ABOVE entry at every employer
  // that uses the word.
  /\bintermediate\b/i,
  // A bare grade digit after the role noun. "Data Analyst 2 - 276" is a NY
  // State civil-service grade and reached the shortlist on 2026-09-09; a
  // Comcast "Data Engineer 3" is the same shape. Anchored to the role noun so
  // it cannot eat a req id, a team number or a location code, and "Analyst 1"
  // still passes because grade 1 IS entry level.
  // The lookahead keeps a YEARS phrase out of this rule: "Data Analyst, 5+
  // years" is a requirement, not a grade, and belongs to the years gate so it
  // reports the honest reason.
  /\b(analyst|engineer|scientist|developer|specialist|associate)\s*[-,]?\s*[2-9]\b(?!\s*\+)(?!\s*(years?|yrs?)\b)/i,
  // "Advance Business Analyst expertise in AI" reached the 2026-09-11
  // shortlist. Advance/Advanced in front of the role noun is a rung, not a
  // topic. Anchored to the role noun so "Advanced Analytics" - a team name,
  // not a level - still passes.
  /\badvance[d]?\s+(business|data|bi)\b/i,
  // Trailing ", Specialist" is a grade at Vanguard and its peers ("Data
  // Engineer, Specialist"). The COMMA is what distinguishes it from the real
  // target titles "BI Specialist" and "Business Intelligence Specialist",
  // which must keep passing.
  /,\s*specialist\b/i,
];

// People management.
//
// This was a QUALIFIER LIST until 2026-09-11, and it leaked. The list carried
// "data" but not "science", so "Data Science Manager - Fraud" reached the
// 2026-09-11 shortlist: the token before Manager is "Science", and the
// /manager,\s/ form did not fire either because the title uses a hyphen.
//
// The list existed only to spare "Product Manager" and "Program Manager", which
// were target titles. The whole product family was deleted from
// config/nightly.yml on 2026-09-09, so nothing needs sparing any more and the
// block is now blanket. "Product Management Specialist" still passes: that is
// "Management", not "Manager".
export const MANAGER_BLOCK = [
  /\bmanagers?\b/i,
];

// Specialization suffixes that make a req neither entry level nor data work,
// whatever the role noun in front of them says.
//
// ADDED 2026-09-11. There was no domain filter at all before this, so a title
// only had to contain a family substring to pass: "Applied AI Engineer, Kernel
// Performance" got in on "applied ai" alone. Five of the 120 rows shortlisted
// that night were robotics, silicon, kernel or embedded reqs.
//
// Note the optional s on robotics: /\brobotic\b/ does NOT match "Robotics", and
// that exact slip let "Robotics AI Engineer, Sensor Calibration" through a
// draft of this rule.
export const SPECIALIZATION_BLOCK = [
  /\brobotics?\b/i, /\bsilicon\b/i, /\bkernel\b/i, /\bembedded\b/i,
  /\bcompilers?\b/i, /\bfirmware\b/i, /\bautonomy\b/i, /\bperception\b/i,
  /\bsensor\b/i, /\bcalibration\b/i, /\blocalization\b/i, /\bmultimodal\b/i,
  /\bfoundation models?\b/i, /\bworld models?\b/i, /\bai safety\b/i,
  // Research and ML-as-the-role-noun. Removing these from role_families was not
  // enough on its own: "Machine Learning Research Scientist, Agent Data
  // Foundation - Enterprise GenAI" still matched the ai family on `genai`, and
  // "ML Engineer, Applied AI" matched on `applied ai`. Four such reqs survived
  // the 2026-09-11 config narrowing and had to be caught here instead.
  //
  // Anchored to the ROLE NOUN on purpose. A bare /machine learning/ would also
  // delete "Data Scientist, Machine Learning", which IS a target: the topic is
  // fine, the job family is not.
  /\bml\s+(engineer|scientist|researcher)\b/i,
  /\bmachine learning\s+(engineer|scientist|research)/i,
  /\bresearch\s+(scientist|engineer)\b/i,
  // SOFTWARE ENGINEER is not a target and never has been, but a data qualifier
  // in the title sneaks it past the family match: "Software Engineer, I - Data
  // Engineering" (Torc) and "Software Engineer-Data Engineering, Machine
  // Learning" (AAMVA) both matched on the `data engineer` substring and both got
  // packs built on 2026-09-14, which she then marked as not relevant.
  //
  // Anchored to the role noun so it cannot eat a real target: "Data Engineer"
  // and "Analytics Engineer" contain no "software engineer" span at all.
  /\bsoftware\s+engineer\b/i,
  /\bswe\b/i,
  // ...and the two GTM shapes she rejected, which must not return via another
  // family's substring the way the ML titles did through `genai`.
  //
  // The lookbehind is load-bearing: she KEPT Zscaler's "AI Solutions Engineer"
  // while rejecting 20 plain Solutions Engineer roles, so a bare
  // /solutions? engineer/ would delete the one example she wanted.
  /\bforward[- ]deployed\b/i,
  /(?<!\bai\s)(?<!\bai\/)\bsolutions?\s+engineer(ing)?\b/i,
];

// She is not a student and not a PhD candidate. Intern and co-op reqs are a
// standing auto-skip, and PhD-gated reqs name a degree she does not hold.
export const STUDENT_BLOCK = [
  /\bintern\b/i, /\binternship\b/i, /\bco-?op\b/i, /\bphd\b/i, /\bdoctora/i,
  /\bsummer 20\d\d\b/i, /\bapprentice/i, /\bstudent\b/i, /\bundergrad/i,
  /\bcampus\b/i,
];

// Workday and friends expose restricted boards by path. These are never
// applicable to an external candidate.
export const PRIVATE_URL_BLOCK = [
  /Private_Postings/i, /Intern_Conversion/i, /Internal_ONLY/i, /Restricted_Postings/i,
  /_Internal_/i,
];

// A non-US seat is useless on OPT. Locale segments give it away.
export const NON_US_LOCALE = [
  /\/en_GB\b/i, /\/en_IN\b/i, /\/en_CA\b/i, /\/en_AU\b/i, /\/en_SG\b/i, /\/en_IE\b/i,
];

export const NON_US_LOCATION = [
  /\b(india|canada|united kingdom|england|scotland|ireland|germany|france|netherlands|poland|spain|portugal|switzerland|sweden|norway|denmark|israel|japan|korea|china|taiwan|singapore|australia|new zealand|brazil|mexico|argentina|chile|colombia|costa rica|philippines|indonesia|thailand|vietnam|malaysia|nigeria|kenya|south africa|egypt|turkey|romania|hungary|czech|bulgaria|ukraine|serbia|croatia|greece)\b/i,
  /\b(london|toronto|montreal|ottawa|calgary|vancouver|winnipeg|bangalore|bengaluru|hyderabad|pune|gurgaon|gurugram|noida|chennai|mumbai|delhi|kolkata|ahmedabad|kochi|coimbatore|dublin|singapore|sydney|melbourne|brisbane|perth|auckland|berlin|munich|hamburg|frankfurt|paris|lyon|amsterdam|rotterdam|brussels|tokyo|osaka|seoul|shanghai|beijing|shenzhen|hangzhou|taipei|hong kong|manila|jakarta|bangkok|hanoi|ho chi minh|kuala lumpur|tel aviv|haifa|zurich|geneva|vienna austria|warsaw|krakow|wroclaw|prague|budapest|bucharest|barcelona|madrid|valencia spain|lisbon|porto|milan|rome italy|stockholm|oslo|copenhagen|helsinki|dubai|abu dhabi|riyadh|doha|cairo|johannesburg|cape town|nairobi|lagos|sao paulo|rio de janeiro|buenos aires|santiago|bogota|lima peru|guadalajara|monterrey|mexico city)\b/i,
  /\bremote\s*[-–,]?\s*(emea|apac|latam|eu|uk|india|canada|europe)\b/i,
  /\b(emea|apac|latam)\b/i,
];

// An explicit US marker overrides every entry above. Without this, "Melbourne,
// FL", "Paris, TX", "Berlin, NH" and "Manchester, NH" all read as foreign - the
// city list is unavoidably full of names the US reuses.
export const US_POSITIVE = new RegExp(
  '\\b(united states|usa|u\\.s\\.a?\\.|us[- ]remote|remote[- ,]+us|us only|nationwide)\\b'
  + '|[,(]\\s*(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]'
  + '|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|DC)\\b', 'i');

export function isRemote(loc) {
  return /\bremote\b|\banywhere\b|\bus - remote\b/i.test(String(loc || ''));
}

/**
 * Reads the TITLE as well as the location field.
 *
 * "Associate Solutions Engineer - Beijing" reached the 2026-09-11 shortlist with
 * an empty location: the city was only ever in the title, and this function was
 * looking at the wrong string. Employers put the office in the title far more
 * often than the feed carries a clean location.
 *
 * A blank location still passes - dropping every posting whose feed row lacks a
 * location would delete far more good US roles than foreign ones - but it can no
 * longer pass on a title that names a foreign city.
 */
export function looksUS(loc, title) {
  const s = (String(loc || '') + ' ' + String(title || '')).trim();
  if (!s) return true;                        // nothing to judge on, let it through
  if (US_POSITIVE.test(s)) return true;       // an explicit US marker always wins
  if (NON_US_LOCATION.some((r) => r.test(s))) return false;
  return true;
}

/**
 * Lowest number of years of experience a piece of text demands, or null when it
 * names none. Ranges resolve to their LOW end ("2-4 years" -> 2), because that is
 * the real minimum a candidate must clear; taking the high end would reject reqs
 * she qualifies for.
 *
 * Deliberately lenient: returns the MINIMUM across every year figure in the text,
 * so a req requiring "2+ years" that also mentions "5 years preferred" reads as 2.
 * A false skip costs an opportunity; a false pass costs one cheap scoring pass.
 */
export function minYearsRequired(text) {
  const str = String(text || '');
  let min = null;
  const re = /(\d{1,2})\s*(?:\+|-|\u2013|to)?\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    const low = parseInt(m[1], 10);
    if (!Number.isFinite(low) || low > 40) continue;
    if (min === null || low < min) min = low;
  }
  return min;
}

/** True when the text demands MORE years than the configured ceiling. */
export function exceedsExperienceCap(text, maxYears) {
  const y = minYearsRequired(text);
  return y !== null && y > maxYears;
}

/* ------------------------------------------------------------------ role match */

/**
 * Score a title against the configured role families. Returns the best family
 * and its weight, or null when nothing matches.
 */
export function matchRoleFamily(title, families) {
  const t = String(title || '').toLowerCase();
  let best = null;
  for (const [family, def] of Object.entries(families)) {
    for (const kw of def.titles || []) {
      if (t.includes(String(kw).toLowerCase())) {
        const w = def.weight ?? 1;
        if (!best || w > best.weight) best = { family, weight: w, matched: kw };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ scoring */

/**
 * Heuristic rank score, 0-100. This orders the queue for the agents; it is not
 * the /5 fit score and carries no authority over whether to build.
 */
export function rankScore(row, ctx) {
  let s = 0;
  const notes = [];

  const fam = matchRoleFamily(row.title, ctx.families);
  if (fam) { s += 40 * fam.weight; notes.push('role:' + fam.family); }

  // Freshness — a posting seen on day 0 beats the same posting on day 6.
  const age = row.age_days == null ? 3 : row.age_days;
  s += Math.max(0, 20 - age * 3);

  if (row.sponsorship_hint === 'Offers Sponsorship') { s += 15; notes.push('simplify:offers-sponsorship'); }
  else if (row.sponsorship_hint === 'repo-badge:sponsor') { s += 5; notes.push('repo-badge'); }

  // Corroboration across independent sources is weak but real signal.
  const nSources = (row.sources || '').split(',').filter(Boolean).length;
  if (nSources > 1) { s += 5; notes.push('multi-source'); }

  if (ctx.industryKeys.size) {
    const hay = (row.company + ' ' + row.category + ' ' + row.title).toLowerCase();
    for (const [ind, kws] of ctx.industryKeys) {
      if (kws.some((k) => hay.includes(k))) { s += 10; notes.push('industry:' + ind); break; }
    }
  }

  if (isRemote(row.location)) { s += 3; notes.push('remote'); }

  return { score: Math.round(s * 10) / 10, notes, family: fam ? fam.family : '' };
}

/* ------------------------------------------------------------------ pipeline */

export function shortlist(rows, ctx) {
  const kept = [];
  const dropped = [];
  const drop = (row, reason) => dropped.push({ ...row, drop_reason: reason });

  for (const row of rows) {
    if (PRIVATE_URL_BLOCK.some((r) => r.test(row.url))) { drop(row, 'private-or-internal-board'); continue; }
    if (NON_US_LOCALE.some((r) => r.test(row.url))) { drop(row, 'non-us-locale-url'); continue; }
    if (STUDENT_BLOCK.some((r) => r.test(row.title))) { drop(row, 'intern-coop-phd'); continue; }
    if (SENIORITY_BLOCK.some((r) => r.test(row.title))) { drop(row, 'seniority-out-of-band'); continue; }
    if (MANAGER_BLOCK.some((r) => r.test(row.title))) { drop(row, 'people-management-role'); continue; }
    if (SPECIALIZATION_BLOCK.some((r) => r.test(row.title))) { drop(row, 'specialization-not-entry-data'); continue; }
    // Years BEFORE level markers: a title stating a real requirement should be
    // reported as over-cap, not as a grade marker, or the drop log lies about why.
    if (exceedsExperienceCap(row.title, ctx.maxYears)) { drop(row, 'over-' + ctx.maxYears + '-years-experience'); continue; }
    if (ctx.blockLevelMarkers && LEVEL_MARKER_BLOCK.some((r) => r.test(row.title))) { drop(row, 'level-marker-not-entry-level'); continue; }
    if (!looksUS(row.location, row.title)) { drop(row, 'non-us-location'); continue; }
    if (ctx.skip && isSkipListed(ctx.skip, row.company, row.title)) { drop(row, 'known-skip (visa gate ruled it out)'); continue; }

    const ck = companyKey(row.company);
    if (ctx.seen.roles.has(ck + '::' + titleKey(row.title))) { drop(row, 'already-in-tracker (same role)'); continue; }
    const pack = packState(ctx.outputDirs, row.company);
    if (pack === 'complete') { drop(row, 'pack-already-on-disk'); continue; }

    const r = rankScore(row, ctx);
    if (!r.family) { drop(row, 'no-target-role-match'); continue; }

    // A DIFFERENT role at a company already in the tracker is a legitimate new
    // application, so flag it rather than dropping it. The agent still has to
    // open the existing row first and must never write a second row for a role
    // that is already there.
    const seenCompany = ctx.seen.companies.has(ck);

    kept.push({
      ...row,
      rank_score: r.score,
      role_family: r.family,
      seen_company: seenCompany ? 'yes-check-tracker-row-first' : '',
      // An unfinished folder means AUDIT AND FINISH it, never regenerate.
      pack_incomplete: pack === 'incomplete' ? 'yes-audit-and-finish-do-not-regenerate' : '',
      rank_notes: r.notes.join(','),
    });
  }

  kept.sort((a, b) => b.rank_score - a.rank_score);
  return { kept, dropped };
}

/* -------------------------------------------------------------- rotation */

/**
 * Put postings that have NEVER reached the visa gate first, so a large
 * qualifying pool is swept over successive runs instead of the same top slice
 * being re-examined forever.
 *
 * Reads data/seen-jobs.tsv directly rather than importing nightly-seen.mjs, so
 * a missing or malformed ledger degrades to "treat everything as unexamined"
 * rather than throwing in the middle of a run.
 *
 * Ordering: unexamined (by rank_score desc), then examined (oldest last_seen
 * first, then rank_score desc).
 */
export function rotateUnexaminedFirst(kept, ledgerText) {
  const text = ledgerText !== undefined ? ledgerText : safeRead(path.join(ROOT, 'data', 'seen-jobs.tsv'));
  const lastSeen = new Map();
  if (text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.length);
    if (lines.length > 1) {
      const head = lines[0].split('\t');
      const iKey = head.indexOf('job_key');
      const iStage = head.indexOf('stage');
      const iLast = head.indexOf('last_seen');
      if (iKey >= 0) {
        for (const l of lines.slice(1)) {
          const c = l.split('\t');
          const stage = iStage >= 0 ? c[iStage] : '';
          // Any stage at or beyond shortlisted means it has already had its turn.
          if (stage && stage !== 'feed') lastSeen.set(c[iKey], iLast >= 0 ? (c[iLast] || '') : '');
        }
      }
    }
  }

  const keyOf = (r) => ledgerKey(r.url);
  const examined = [];
  const unexamined = [];
  for (const r of kept) (lastSeen.has(keyOf(r)) ? examined : unexamined).push(r);

  unexamined.sort((a, b) => b.rank_score - a.rank_score);
  examined.sort((a, b) => {
    const la = lastSeen.get(keyOf(a)) || '';
    const lb = lastSeen.get(keyOf(b)) || '';
    if (la !== lb) return la < lb ? -1 : 1;       // oldest turn first
    return b.rank_score - a.rank_score;
  });

  return { rows: unexamined.concat(examined), unexamined: unexamined.length, examined: examined.length };
}

function safeRead(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

/**
 * The ledger's own key function, imported rather than reimplemented.
 *
 * A hand-written mirror was tried first and drifted immediately: it kept
 * `token` as a job id (the Greenhouse embed form puts the job id there) while
 * nightly-seen.mjs strips it as tracking. That one disagreement made a row look
 * unexamined forever, so it was re-emitted every run. Importing removes the
 * whole class of bug. No cycle: nightly-seen.mjs imports only fs/path/url.
 */
export { ledgerKey };

/* ------------------------------------------------------------------ io */

export function readTsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i] ?? ''; });
    o.age_days = o.age_days === '' ? null : parseFloat(o.age_days);
    return o;
  });
}

const OUT_COLUMNS = ['rank_score', 'role_family', 'company', 'title', 'location',
  'url', 'age_days', 'sponsorship_hint', 'salary', 'sources', 'seen_company', 'pack_incomplete', 'rank_notes'];

function toTsv(rows, columns) {
  const esc = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return [columns.join('\t'), ...rows.map((r) => columns.map((c) => esc(r[c])).join('\t'))].join('\n') + '\n';
}

function loadYaml(p, fallback) {
  try {
    if (!existsSync(p)) return fallback;
    return yaml.load(readFileSync(p, 'utf8')) ?? fallback;
  } catch { return fallback; }
}

function buildContext() {
  const cfg = loadYaml(path.join(ROOT, 'config', 'nightly.yml'), {});
  const families = cfg.role_families || {};

  const ind = loadYaml(path.join(ROOT, 'config', 'industries.yml'), {});
  const industryKeys = new Map();
  for (const entry of ind.industries || []) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const kws = (typeof entry === 'object' && entry.keywords) ? entry.keywords : [name];
    if (name) industryKeys.set(name, kws.map((k) => String(k).toLowerCase()));
  }

  const trackerPath = path.join(ROOT, 'data', 'applications.md');
  const seen = existsSync(trackerPath)
    ? parseTrackerCompanies(readFileSync(trackerPath, 'utf8'))
    : { companies: new Set(), roles: new Set() };

  const outDir = path.join(ROOT, 'output');
  const outputDirs = existsSync(outDir)
    ? parseOutputDirs(readdirSync(outDir), (name) => {
        try {
          return readdirSync(path.join(outDir, name)).filter((f) => /\.pdf$/i.test(f)).length;
        } catch { return 0; }   // not a directory, or unreadable
      })
    : new Map();

  const skipPath = path.join(ROOT, 'data', 'skip-list.tsv');
  const skip = existsSync(skipPath)
    ? parseSkipList(readFileSync(skipPath, 'utf8'))
    : { exact: new Set(), wholeCompany: new Set() };

  const maxYears = (cfg.experience && cfg.experience.max_years) || 2;
  // Default ON: her 2026-09-09 instruction was to be "very accurate in being
  // entry level roles", so a missing key must not silently loosen the gate.
  const blockLevelMarkers = !(cfg.experience && cfg.experience.block_level_markers === false);
  return { cfg, families, industryKeys, seen, outputDirs, skip, maxYears, blockLevelMarkers };
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) pass++; else { fail++; console.error('FAIL ' + n + '\n  got  ' + g + '\n  want ' + w); }
  };

  eq('companyKey drops suffix', companyKey('Wellmark, Inc.'), 'wellmark');
  eq('companyKey case+punct', companyKey('ACME  Technologies!'), 'acme');
  eq('companyKey matches across forms', companyKey('Osiris Ratings, Inc.'), companyKey('osiris ratings'));
  eq('companyKey ignores leading The', companyKey('The University of Texas at Austin'), companyKey('University of Texas at Austin'));

  const tracker = [
    '| # | Date | Company | Role | Score |',
    '|---|---|---|---|---|',
    '| 523 | 2026-09-03 | **Baselayer** - THE LEGAL ENTITY IS **OSIRIS RATINGS, INC.** | **Data Engineer** (greenhouse) | 4.5/5 |',
    '| 522 | 2026-09-03 | **BlackRock** (files as BlackRock Financial) | **2027 Analyst Program** | 4.0/5 |',
    'not a row',
  ].join('\n');
  const t = parseTrackerCompanies(tracker);
  eq('tracker reads leading bold company', t.companies.has('baselayer'), true);
  eq('tracker ignores annotation entity', t.companies.has('blackrock'), true);
  eq('tracker company count', t.companies.size, 2);
  eq('tracker role key', t.roles.has('baselayer::dataengineer'), true);

  const dirs = parseOutputDirs(['baselayer-data-engineer', 'applications-tracker.csv', 'gotion-data-analyst-2026-08-27']);
  eq('output dirs skip files', dirs.size, 2);
  // A folder with no PDF is an INTERRUPTED build, not a finished pack.
  const halfBuilt = parseOutputDirs(['servicenow-ml-engineer-x'], () => 0);
  eq('no pdf => incomplete', packState(halfBuilt, 'ServiceNow'), 'incomplete');
  eq('no pdf => not built', hasBuiltPack(halfBuilt, 'ServiceNow'), false);
  const finished = parseOutputDirs(['servicenow-ml-engineer-x'], () => 3);
  eq('pdf present => complete', packState(finished, 'ServiceNow'), 'complete');
  eq('unrelated company => none', packState(finished, 'Stripe'), 'none');
  eq('built pack match', hasBuiltPack(dirs, 'Baselayer'), true);
  eq('built pack no false hit', hasBuiltPack(dirs, 'Stripe'), false);
  // Slug-boundary matching: a Metabase pack must never suppress Meta.
  eq('built pack respects slug boundary', hasBuiltPack(parseOutputDirs(['metabase-data-analyst']), 'Meta'), false);
  eq('built pack matches legal suffix form', hasBuiltPack(parseOutputDirs(['wellmark-data-analyst']), 'Wellmark, Inc.'), true);

  const families = {
    data: { titles: ['data analyst', 'data engineer'], weight: 1 },
    gtm: { titles: ['gtm engineer', 'forward deployed'], weight: 1 },
  };
  eq('role match data', matchRoleFamily('Junior Data Analyst', families).family, 'data');
  eq('role match gtm', matchRoleFamily('Forward Deployed Engineer', families).family, 'gtm');
  eq('role no match', matchRoleFamily('Chef de Partie', families), null);

  const ctx = {
    families,
    industryKeys: new Map([['fintech', ['fintech', 'payments']]]),
    seen: { companies: new Set(['acme']), roles: new Set() },
    outputDirs: new Map(),
    maxYears: 2,
    blockLevelMarkers: true,
    skip: parseSkipList([
      'company	title	reason',
      'Walled Co	Data Analyst	OPT/CPT wall',
      'Blocked Corp	*	citizenship',
    ].join(String.fromCharCode(10))),
  };

  const rows = [
    { company: 'Fresh', title: 'Data Analyst', location: 'Boston, MA', url: 'https://a/1', age_days: 0, sources: 'simplify', sponsorship_hint: 'Offers Sponsorship', category: '' },
    { company: 'Acme', title: 'Data Analyst', location: 'NY', url: 'https://a/2', age_days: 1, sources: 'simplify', sponsorship_hint: '', category: '' },
    { company: 'Sen', title: 'Senior Data Analyst', location: 'NY', url: 'https://a/3', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Int', title: 'Data Analyst Intern', location: 'NY', url: 'https://a/4', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Priv', title: 'Data Analyst', location: 'NY', url: 'https://x.myworkdayjobs.com/Private_Postings/job/1', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Intl', title: 'Data Analyst', location: 'Bengaluru, India', url: 'https://a/6', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Off', title: 'Chef de Partie', location: 'NY', url: 'https://a/7', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Dup', title: 'Data Engineer', location: 'NY', url: 'https://a/8', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
  ];
  ctx.seen.roles.add('dup::dataengineer');
  const { kept, dropped } = shortlist(rows, ctx);
  eq('shortlist keeps the in-scope rows', kept.map((k) => k.company).sort(), ['Acme', 'Fresh']);
  const reasons = Object.fromEntries(dropped.map((d) => [d.company, d.drop_reason]));
  // A company already in the tracker is NOT dropped when the role differs; it is
  // kept and flagged so the agent opens the existing row before writing anything.
  const acme = kept.find((k) => k.company === 'Acme');
  eq('same-company different-role kept', !!acme, true);
  eq('same-company flagged', acme.seen_company, 'yes-check-tracker-row-first');
  eq('new company not flagged', kept.find((k) => k.company === 'Fresh').seen_company, '');
  eq('drop senior', reasons.Sen, 'seniority-out-of-band');
  // Cox's "Business Intelligence Manager" reached scoring on the first real run.
  eq('drop BI manager', shortlist([{ company: 'C', title: 'Business Intelligence Manager - Manheim', location: 'GA', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' }], ctx).dropped[0].drop_reason, 'people-management-role');
  eq('drop intern', reasons.Int, 'intern-coop-phd');

  // Entry-level accuracy, her instruction 2026-09-09: "less than 2 years".
  const lvl = (title) => {
    const r = shortlist([{ company: 'L', title, location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' }], ctx);
    return r.kept.length ? 'KEPT' : r.dropped[0].drop_reason;
  };
  eq('level II is not entry level', lvl('Data Scientist II'), 'level-marker-not-entry-level');
  eq('level III is not entry level', lvl('Data Engineer III'), 'level-marker-not-entry-level');
  eq('level IV is not entry level', lvl('Data Analyst IV'), 'level-marker-not-entry-level');
  eq('mid-level is not entry level', lvl('Mid-Level Data Engineer'), 'level-marker-not-entry-level');
  eq('intermediate is not entry level', lvl('Data Engineer (Intermediate)'), 'level-marker-not-entry-level');
  eq('Level 3 is not entry level', lvl('Data Analyst, Level 3'), 'level-marker-not-entry-level');
  // Bare civil-service / ladder grades, seen live from LinkedIn 2026-09-09.
  eq('bare grade digit blocked', lvl('Data Analyst 2 - 276'), 'level-marker-not-entry-level');
  eq('bare grade digit with dash blocked', lvl('Data Engineer 3-1595'), 'level-marker-not-entry-level');
  eq('grade 1 stays entry level', lvl('Data Analyst 1'), 'KEPT');
  // A req id or team number after the noun must NOT read as a grade.
  eq('req id in parens is not a grade', lvl('Business Data Analyst (32706)'), 'KEPT');
  eq('req id after a comma is not a grade', lvl('Data Analyst, Job 0014605'), 'KEPT');
  // Roman I IS entry level - Zappos "Data Engineer I" was correctly built.
  eq('level I stays entry level', lvl('Data Engineer I'), 'KEPT');
  eq('unmarked title stays', lvl('Data Analyst'), 'KEPT');
  // The 2-year ceiling, read off the title.
  eq('2 years in title passes at cap 2', lvl('Data Analyst (2+ years)'), 'KEPT');
  eq('3 years in title busts cap 2', lvl('Data Analyst (3+ years)'), 'over-2-years-experience');
  // Titles she removed from role_families on 2026-09-09 must no longer match.
  // Product Manager is still rejected, but since MANAGER_BLOCK went blanket on
  // 2026-09-11 it is now caught as people management BEFORE the family match
  // is consulted. The verdict is unchanged; only the attributed reason moved,
  // and "Product Manager is a people-management role" is the truer reason.
  eq('product manager no longer a target', lvl('Product Manager'), 'people-management-role');
  eq('financial analyst no longer a target', lvl('Financial Analyst'), 'no-target-role-match');

  // --- rules added 2026-09-11, each from a title that actually got through ---
  eq('science manager blocked', lvl('Data Science Manager - Fraud'), 'people-management-role');
  eq('trailing Specialist grade blocked', lvl('Data Engineer, Specialist'), 'level-marker-not-entry-level');
  eq('Advance rung blocked', lvl('Advance Business Analyst expertise in AI'), 'level-marker-not-entry-level');
  eq('robotics blocked', lvl('Robotics AI Engineer, Sensor Calibration'), 'specialization-not-entry-data');
  eq('silicon blocked', lvl('Applied AI Engineer, Silicon Engineering'), 'specialization-not-entry-data');
  eq('kernel blocked', lvl('Applied AI Engineer, Kernel Performance'), 'specialization-not-entry-data');
  eq('embedded blocked', lvl('Embedded AI Engineer, On-Device Models'), 'specialization-not-entry-data');
  // ...and the near-miss these rules must NOT eat. ("Business Intelligence
  // Specialist" is the other one; it is asserted against the REAL config in the
  // named-target loop below, which is where a family question belongs.)
  eq('Advanced Analytics is a team, not a rung', lvl('Data Analyst, Advanced Analytics'), 'KEPT');
  // Titles she named must match — checked against the REAL config, not the
  // fixture above, because the point is that config/nightly.yml actually
  // targets what she asked for on 2026-09-09.
  const realFamilies = buildContext().families;
  const realCtx = { ...ctx, families: realFamilies };
  const lvlReal = (title) => {
    const r = shortlist([{ company: 'L', title, location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' }], realCtx);
    return r.kept.length ? 'KEPT' : r.dropped[0].drop_reason;
  };
  for (const t of ['Data Analyst', 'Data Scientist', 'Data Engineer', 'AI Engineer',
                   'GTM Engineer', 'Business Analyst', 'Business Intelligence Analyst',
                   'Business Intelligence Specialist']) {
    eq('named target matches: ' + t, lvlReal(t), 'KEPT');
  }
  // ...and the removed families must not, in the real config either.
  for (const t of ['Financial Analyst', 'Risk Analyst', 'Marketing Analyst', 'Sales Engineer',
                   // Removed from the ai family 2026-09-11.
                   'MLOps Engineer', 'Applied Scientist', 'NLP Engineer', 'AI Analyst',
                   // Removed from the gtm family the same day.
                   'Customer Engineer', 'Implementation Engineer', 'Growth Engineer']) {
    eq('removed target rejected: ' + t, lvlReal(t), 'no-target-role-match');
  }
  // These three are rejected one gate EARLIER, by SPECIALIZATION_BLOCK. Dropping
  // them from role_families was not sufficient on its own: real titles like
  // "ML Engineer, Applied AI" and "Machine Learning Research Scientist ...
  // Enterprise GenAI" re-enter through the `applied ai` and `genai` substrings,
  // so the role-noun block is what actually holds them out.
  for (const t of ['Machine Learning Engineer', 'ML Engineer', 'Research Engineer']) {
    eq('removed target rejected: ' + t, lvlReal(t), 'specialization-not-entry-data');
  }
  // The two manager titles are rejected one gate earlier, by MANAGER_BLOCK.
  for (const t of ['Product Manager', 'Program Manager']) {
    eq('removed target rejected: ' + t, lvlReal(t), 'people-management-role');
  }

  // --- 2026-09-14: her red-marking of 20 of 23 GTM packs in the workbook ------
  // Rejected: Forward Deployed Engineer and generic Solutions/Solution Engineer.
  for (const t of ['Forward Deployed Engineer', 'Forward Deployed Software Engineer',
                   'Solutions Engineer', 'Solution Engineer (Pre-Sales) - DataFoundation',
                   'Solutions Engineering Associate']) {
    eq('gtm shape rejected: ' + t, lvlReal(t), 'specialization-not-entry-data');
  }
  // Software Engineer titles that slipped in on a `data engineer` substring.
  eq('SWE with data qualifier blocked', lvlReal('Software Engineer, I - Data Engineering'),
    'specialization-not-entry-data');
  eq('SWE-Data Engineering blocked', lvlReal('Software Engineer-Data Engineering, Machine Learning'),
    'specialization-not-entry-data');
  // ...and the three she deliberately LEFT unmarked must still pass. The Zscaler
  // one is why the solutions-engineer block carries an `ai` lookbehind.
  eq('AI Solutions Engineer KEPT', lvlReal('AI Solutions Engineer, People & Culture'), 'KEPT');
  eq('BI + AI Solutions Specialist KEPT', lvlReal('Business Intelligence & AI Solutions Specialist'), 'KEPT');
  eq('GTM-flavoured Data Analyst KEPT', lvlReal('Data Analyst, Go-To-Market Sales Insights'), 'KEPT');
  eq('drop private board', reasons.Priv, 'private-or-internal-board');
  eq('drop non-us', reasons.Intl, 'non-us-location');
  eq('drop off-target role', reasons.Off, 'no-target-role-match');
  eq('drop exact same role already tracked', reasons.Dup, 'already-in-tracker (same role)');

  // Legal-name vs brand-name: the visa agent writes the full entity, the feed
  // writes the short brand. Both must hit the same skip entry.
  const aliasSkip = parseSkipList([
    'company\ttitle\treason',
    'Lawrence Livermore National Security, LLC (LLNL)\t*\tcitizenship',
    'Comcast Cable Communications, LLC\t*\tno sponsorship',
  ].join(String.fromCharCode(10)));
  eq('skip matches short brand from legal name', isSkipListed(aliasSkip, 'LLNL', 'Data Science Engineer'), true);
  eq('skip matches legal name itself', isSkipListed(aliasSkip, 'Lawrence Livermore National Security, LLC', 'X'), true);
  eq('skip matches Comcast short form', isSkipListed(aliasSkip, 'Comcast', 'Data Engineer 3-1595'), true);
  eq('skip does not over-match', isSkipListed(aliasSkip, 'Stripe', 'Data Engineer'), false);

  // Skip list: a per-req wall must not blanket the employer's other openings.
  const sl = shortlist([
    { company: 'Walled Co', title: 'Data Analyst', location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Walled Co', title: 'Data Engineer', location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
    { company: 'Blocked Corp', title: 'Data Engineer', location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' },
  ], ctx);
  eq('skip-list drops the walled req', sl.dropped.find((d) => d.title === 'Data Analyst').drop_reason, 'known-skip (visa gate ruled it out)');
  eq('skip-list keeps sibling req at same employer', sl.kept.map((k) => k.title), ['Data Engineer']);
  eq('skip-list wildcard blocks whole employer', sl.dropped.some((d) => d.company === 'Blocked Corp'), true);

  // Sponsorship signal must outrank a bare match of the same freshness.
  const ranked = shortlist([
    { company: 'Plain', title: 'Data Analyst', location: 'NY', url: 'u1', age_days: 0, sources: 'simplify', sponsorship_hint: '', category: '' },
    { company: 'Spons', title: 'Data Analyst', location: 'NY', url: 'u2', age_days: 0, sources: 'simplify', sponsorship_hint: 'Offers Sponsorship', category: '' },
  ], ctx).kept;
  eq('sponsorship ranks first', ranked[0].company, 'Spons');

  // The interrupted folder must NOT suppress the company from the shortlist.
  const halfCtx = { ...ctx, outputDirs: halfBuilt };
  const hs = shortlist([{ company: 'ServiceNow', title: 'Data Analyst', location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' }], halfCtx);
  eq('incomplete pack kept', hs.kept.length, 1);
  eq('incomplete pack flagged', hs.kept[0].pack_incomplete, 'yes-audit-and-finish-do-not-regenerate');

  eq('years: 3+ reads as 3', minYearsRequired('3+ years of experience'), 3);
  eq('years: range takes low end', minYearsRequired('2-4 years'), 2);
  eq('years: none named', minYearsRequired('Data Analyst'), null);
  eq('years: minimum across phrases', minYearsRequired('2+ years required, 5 years preferred'), 2);
  eq('cap: 3 allowed', exceedsExperienceCap('3+ years', 3), false);
  eq('cap: 4 is out', exceedsExperienceCap('4+ years', 3), true);
  eq('cap: 7-10 is out', exceedsExperienceCap('7-10 years', 3), true);
  eq('cap: silence allowed', exceedsExperienceCap('Data Analyst', 3), false);
  eq('shortlist drops over-cap title',
    shortlist([{ company: 'Z', title: 'Data Analyst, 5+ years', location: 'NY', url: 'u', age_days: 1, sources: '', sponsorship_hint: '', category: '' }], ctx)
      .dropped[0].drop_reason, 'over-2-years-experience');

  // ---- rotation, so a 575-row qualifying pool is swept instead of the same
  // top slice being re-examined every run.
  eq('ledgerKey strips scheme+www', ledgerKey('https://www.Example.com/jobs/1'), 'example.com/jobs/1');
  eq('ledgerKey strips trailing slash', ledgerKey('https://a.com/x/'), 'a.com/x');
  eq('ledgerKey keeps gh_jid', ledgerKey('https://a.com/j?gh_jid=99&utm_source=x'), 'a.com/j?gh_jid=99');
  eq('ledgerKey drops tracking only', ledgerKey('https://a.com/j?utm_source=x&src=y'), 'a.com/j');
  eq('ledgerKey blank', ledgerKey(''), '');
  // KNOWN LIMITATION, pinned deliberately: the ledger strips `token`, which is
  // where the Greenhouse EMBED form carries the job id. So two different embed
  // postings at one company collapse to the same key. This test exists so the
  // behaviour is a decision rather than a surprise; the rotation depends on
  // matching the ledger exactly, whatever the ledger does.
  eq('ledgerKey strips greenhouse embed token (known limitation)',
    ledgerKey('https://boards.greenhouse.io/embed/job_app?token=8171272'),
    'boards.greenhouse.io/embed/job_app');

  const mk = (u, s) => ({ url: u, rank_score: s });
  const ledger = [
    'job_key\tcompany\ttitle\turl\tstage\tverdict\tfirst_seen\tlast_seen\ttimes_seen\tnote',
    'a.com/1\tA\tt\thttps://a.com/1\tshortlisted\t\t2026-09-01\t2026-09-08\t2\t',
    'a.com/2\tA\tt\thttps://a.com/2\tshortlisted\t\t2026-09-01\t2026-09-05\t1\t',
  ].join('\n');
  const rot = rotateUnexaminedFirst(
    [mk('https://a.com/1', 100), mk('https://a.com/2', 90), mk('https://a.com/3', 10), mk('https://a.com/4', 50)],
    ledger);
  eq('rotation counts unexamined', rot.unexamined, 2);
  eq('rotation counts examined', rot.examined, 2);
  // 3 and 4 never had a turn, so they come first despite lower scores.
  eq('rotation unexamined first', rot.rows.slice(0, 2).map((r) => r.url),
    ['https://a.com/4', 'https://a.com/3']);
  // Among examined, the one waiting longest (older last_seen) goes first.
  eq('rotation oldest turn first', rot.rows[2].url, 'https://a.com/2');
  eq('rotation loses nothing', rot.rows.length, 4);
  // A missing or unreadable ledger must not starve the run.
  eq('rotation with no ledger treats all as new', rotateUnexaminedFirst([mk('https://a.com/1', 1)], '').unexamined, 1);
  eq('rotation with header-only ledger', rotateUnexaminedFirst([mk('https://a.com/1', 1)], 'job_key\tstage').unexamined, 1);
  // A row still at stage `feed` has not had its turn.
  eq('rotation ignores stage=feed',
    rotateUnexaminedFirst([mk('https://a.com/9', 1)],
      'job_key\tstage\tlast_seen\na.com/9\tfeed\t2026-09-01').unexamined, 1);

  console.log(pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ main */

function parseArgs(argv) {
  const a = { limit: 0, out: null, droppedOut: null, json: false, explain: false, feed: 'data/job-feed.tsv', selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--self-test') a.selfTest = true;
    else if (v === '--json') a.json = true;
    else if (v === '--explain') a.explain = true;
    else if (v === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (v.startsWith('--limit=')) a.limit = parseInt(v.slice(8), 10);
    else if (v === '--dropped-out') a.droppedOut = argv[++i];
    else if (v.startsWith('--dropped-out=')) a.droppedOut = v.slice(14);
    else if (v === '--out') a.out = argv[++i];
    else if (v.startsWith('--out=')) a.out = v.slice(6);
    else if (v === '--feed') a.feed = argv[++i];
    else if (v.startsWith('--feed=')) a.feed = v.slice(7);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();

  const feedPath = path.resolve(ROOT, args.feed);
  if (!existsSync(feedPath)) {
    console.error('missing feed: ' + args.feed + ' — run scrape-job-repos.mjs first');
    return 1;
  }

  const ctx = buildContext();
  if (!Object.keys(ctx.families).length) {
    console.error('config/nightly.yml has no role_families — nothing can match');
    return 1;
  }

  const rows = readTsv(readFileSync(feedPath, 'utf8'));
  let { kept, dropped } = shortlist(rows, ctx);
  const total = kept.length;

  // ROTATION, added 2026-09-10. Her instruction: "do not leave a single entry
  // level job that opens."
  //
  // `shortlist()` sorts by rank_score and main() took the top `limit`. Once the
  // zero-token harvest raised the qualifying pool from 20 to ~575, that meant
  // the SAME top 120 were examined every run and the remaining ~455 were never
  // looked at at all - a permanent blind spot that no cap increase fixes.
  //
  // The ledger already records every emitted row at stage `shortlisted`, and
  // that stage is deliberately NON-terminal. So prefer rows never shortlisted
  // before, then the longest-waiting ones. Nothing is dropped and nothing is
  // starved: at 2 discover runs a night this sweeps the whole pool in ~2-3
  // nights, and rank_score still orders within each group.
  const rotation = rotateUnexaminedFirst(kept);
  kept = rotation.rows;

  if (args.limit > 0) kept = kept.slice(0, args.limit);

  const byReason = {};
  for (const d of dropped) byReason[d.drop_reason] = (byReason[d.drop_reason] || 0) + 1;

  const summary = {
    generated_at: new Date().toISOString(),
    feed_rows: rows.length,
    tracker_companies: ctx.seen.companies.size,
    built_packs: ctx.outputDirs.size,
    industries_configured: ctx.industryKeys.size,
    skip_list_entries: ctx.skip.exact.size + ctx.skip.wholeCompany.size,
    shortlisted: total,
    emitted: kept.length,
    // Rotation visibility: `never_examined` is the backlog still waiting for a
    // turn at the visa gate. If it stays flat across runs the rotation is stuck.
    never_examined: rotation.unexamined,
    already_examined: rotation.examined,
    backlog_after_this_run: Math.max(0, total - kept.length),
    dropped: byReason,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, rows: kept, ...(args.explain ? { dropped } : {}) }, null, 2));
    return 0;
  }

  // --- terminal drops -------------------------------------------------------
  //
  // ADDED 2026-09-11 for token cost, not correctness. On 2026-09-11 the ledger
  // held 1,013 rows of which **802 carried a blank verdict**, i.e. they were
  // still OPEN and were re-shortlisted, re-ranked and re-offered to the agents
  // every single run - 386 rows had been seen 2+ times and one had been seen 8.
  //
  // Rows the zero-token gates drop for a STRUCTURAL reason can never become
  // eligible later: the title will not change role family, the req will not
  // move to the US, the level marker will not disappear. Those are terminal and
  // belong in the ledger as such. Reasons that are merely "not yet" - the
  // rotation backlog, an unexamined row - are deliberately NOT listed here.
  if (args.droppedOut) {
    const TAB = String.fromCharCode(9), NL = String.fromCharCode(10);
    const TERMINAL_DROPS = new Set([
      'no-target-role-match', 'specialization-not-entry-data', 'seniority-out-of-band',
      'people-management-role', 'level-marker-not-entry-level', 'non-us-location',
      'private-or-internal-board', 'intern-coop-phd',
      'known-skip (visa gate ruled it out)',
    ]);
    const term = dropped.filter((d) => TERMINAL_DROPS.has(d.drop_reason)
      || /^over-\d+-years-experience$/.test(d.drop_reason || ''));
    const cols = ['company', 'title', 'url', 'drop_reason'];
    const p2 = path.resolve(ROOT, args.droppedOut);
    if (!existsSync(path.dirname(p2))) mkdirSync(path.dirname(p2), { recursive: true });
    writeFileSync(p2, [cols.join(TAB),
      ...term.map((d) => cols.map((c) => String(d[c] ?? '').replace(/\s+/g, ' ')).join(TAB)),
    ].join(NL) + NL);
    console.error('wrote ' + term.length + ' terminal drop(s) -> ' + args.droppedOut);
  }

  const tsv = toTsv(kept, OUT_COLUMNS);
  if (args.out) {
    const outPath = path.resolve(ROOT, args.out);
    if (!existsSync(path.dirname(outPath))) mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, tsv);
    console.error(JSON.stringify(summary, null, 2));
    console.error('wrote ' + kept.length + ' rows -> ' + args.out);
  } else {
    process.stdout.write(tsv);
    console.error(JSON.stringify(summary, null, 2));
  }
  if (args.explain) {
    console.error('\n--- dropped sample ---');
    for (const d of dropped.slice(0, 30)) console.error(d.drop_reason + '\t' + d.company + '\t' + d.title);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
