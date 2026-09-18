#!/usr/bin/env node

/**
 * generate-applications-tracker.mjs
 *
 * Regenerates output/applications-tracker.csv from data/applications.md.
 *
 * - Reads applications.md as source of truth for: # / Company / Job Title / Date / Status
 * - Preserves user's manual edits to Contact Person and Contact Email columns from the existing CSV
 * - For new rows (in applications.md, not yet in CSV): seeds Contact Person and Contact Email by extracting
 *   recruiter / HM names from the tracker notes via regex; emails default to "(none surfaced)" unless an
 *   email address is found inline in the notes.
 *
 * Usage: node generate-applications-tracker.mjs
 *
 * The CSV uses a UTF-8 BOM so Excel renders symbols correctly. Match key is the # column (first column).
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const APPS_MD = 'data/applications.md';
const CSV_PATH = 'output/applications-tracker.csv';

const HEADER = ['#', 'Company', 'Job Title', 'Application Date', 'Status', 'Contact Person', 'Contact Email'];

// Canonical status mapping (templates/states.yml)
const STATUS_MAP = {
  'Evaluada': 'Evaluated',
  'Evaluated': 'Evaluated',
  'Aplicado': 'Applied',
  'Applied': 'Applied',
  'Re-applied': 'Applied',
  'Responded': 'Responded',
  'Interview': 'Interview',
  'Offer': 'Offer',
  'Rejected': 'Rejected',
  'Discarded': 'Discarded',
  'SKIP': 'SKIP',
  'NO APLICAR': 'SKIP'
};

function normalizeStatus(raw) {
  const trimmed = String(raw || '').replace(/\*+/g, '').trim();
  return STATUS_MAP[trimmed] || trimmed;
}

// Legacy placeholder strings ("(none)", "(none surfaced)") collapse to empty on regen.
// User asked for empty cells when contact info isn't yet known (2026-05-04).
function normalizeLegacyPlaceholder(s) {
  const t = String(s || '').trim();
  if (t === '(none)' || t === '(none surfaced)') return '';
  return t;
}

// Parse the markdown table in applications.md
function parseAppsMd(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    // separator row
    if (/^\|\s*-/.test(line)) continue;
    // header row (literal '#' as the first column header)
    if (/^\|\s*#\s*\|/.test(line)) continue;

    // Markdown row: |field1|field2|...|
    // Split, trim, drop the empty entries at start/end
    const parts = line.split('|').map((s) => s.trim());
    // Expected at least: '', #, date, company, role, score, status, pdf, report, notes, ''
    if (parts.length < 10) continue;
    const num = parts[1];
    if (!/^\d+$/.test(num)) continue;

    rows.push({
      num: parseInt(num, 10),
      date: parts[2] || '',
      company: parts[3] || '',
      role: parts[4] || '',
      score: parts[5] || '',
      status: parts[6] || '',
      pdf: parts[7] || '',
      report: parts[8] || '',
      notes: parts[9] || ''
    });
  }
  return rows;
}

// Extract a likely contact display string from the Notes cell
function extractContactPerson(notes) {
  if (!notes) return '';
  const found = [];

  // Pattern: Name (...recruiter...) or (...Recruiter...)
  const recRegex = /([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})\s*\(([^)]*[Rr]ecruiter[^)]*)\)/g;
  let m;
  while ((m = recRegex.exec(notes)) !== null) {
    found.push(`${m[1]} (${m[2]})`);
  }

  // Pattern: Name (... HM ...) or (... Hiring Manager ...)
  const hmRegex = /([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})\s*\(([^)]*\b(?:HM|Hiring Manager)\b[^)]*)\)/g;
  while ((m = hmRegex.exec(notes)) !== null) {
    found.push(`${m[1]} (${m[2]})`);
  }

  // De-duplicate while preserving order
  const seen = new Set();
  const out = [];
  for (const f of found) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }

  return out.join(' / ');
}

// Extract an email address from the Notes cell
function extractContactEmail(notes) {
  if (!notes) return '';
  const m = notes.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  return m ? m[0] : '';
}

// Pull a short job title (drop trailing parenthetical req-detail blocks if too long)
function shortenRole(role) {
  // Keep the role text close to as-is, just trim
  return role.trim();
}

// CSV parser that handles quoted fields with embedded commas / quotes / newlines (single line per row only)
function parseCsv(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.length) continue;
    const fields = [];
    let inQuote = false;
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQuote) {
        if (ch === '"') {
          if (raw[i + 1] === '"') { cur += '"'; i++; }
          else { inQuote = false; }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') { fields.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

function csvEscape(field) {
  if (field == null) return '';
  const s = String(field);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsvLine(fields) {
  return fields.map(csvEscape).join(',');
}

async function main() {
  const appsMdText = await readFile(APPS_MD, 'utf8');
  const appsRows = parseAppsMd(appsMdText);
  if (appsRows.length === 0) {
    console.error('No rows parsed from', APPS_MD);
    process.exit(1);
  }

  // Read existing CSV (if any) to capture user's manual edits to Contact Person / Contact Email
  // Match key is the # column (first column).
  const userEdits = new Map(); // num -> { person, email }
  if (existsSync(CSV_PATH)) {
    const csvText = await readFile(CSV_PATH, 'utf8');
    const parsed = parseCsv(csvText);
    if (parsed.length > 1) {
      const header = parsed[0];
      const numIdx = header.indexOf('#');
      const personIdx = header.indexOf('Contact Person');
      const emailIdx = header.indexOf('Contact Email');
      // Older CSVs without # column: fall back to (Company + Job Title) match
      if (numIdx === -1) {
        const companyIdx = header.indexOf('Company');
        const titleIdx = header.indexOf('Job Title');
        for (let i = 1; i < parsed.length; i++) {
          const r = parsed[i];
          if (companyIdx === -1 || titleIdx === -1) continue;
          const key = `${r[companyIdx]}||${r[titleIdx]}`;
          userEdits.set(key, {
            person: normalizeLegacyPlaceholder(r[personIdx] || ''),
            email: normalizeLegacyPlaceholder(r[emailIdx] || '')
          });
        }
      } else {
        for (let i = 1; i < parsed.length; i++) {
          const r = parsed[i];
          const num = parseInt(r[numIdx], 10);
          if (Number.isNaN(num)) continue;
          userEdits.set(num, {
            person: normalizeLegacyPlaceholder(r[personIdx] || ''),
            email: normalizeLegacyPlaceholder(r[emailIdx] || '')
          });
        }
      }
    }
  }

  // Sort applications.md rows: most recent # first (descending)
  appsRows.sort((a, b) => b.num - a.num);

  const out = [HEADER];
  for (const r of appsRows) {
    let person = '';
    let email = '';

    // Prefer user's existing CSV edits if present
    let existing = userEdits.get(r.num);
    if (!existing) {
      // Fallback: try Company + Job Title match (legacy CSV without # column)
      existing = userEdits.get(`${r.company}||${shortenRole(r.role)}`);
    }
    if (existing) {
      person = existing.person;
      email = existing.email;
    } else {
      // Seed from notes
      person = extractContactPerson(r.notes);
      email = extractContactEmail(r.notes);
    }

    out.push([
      String(r.num),
      r.company,
      shortenRole(r.role),
      r.date,
      normalizeStatus(r.status),
      person,
      email
    ]);
  }

  // Write CSV with UTF-8 BOM so Excel renders symbols correctly
  const csvText = '﻿' + out.map(writeCsvLine).join('\r\n') + '\r\n';
  try {
    await writeFile(CSV_PATH, csvText, 'utf8');
  } catch (err) {
    if (err.code === 'EBUSY') {
      console.error(`❌ ${CSV_PATH} is locked, likely open in Excel.`);
      console.error('   Close the CSV in Excel and re-run. (Excel locks the file while it is open on Windows.)');
      process.exit(2);
    }
    throw err;
  }

  console.log(`✅ Wrote ${out.length - 1} rows to ${CSV_PATH}`);
  if (userEdits.size > 0) {
    console.log(`   Preserved manual edits for ${userEdits.size} rows.`);
  }
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
