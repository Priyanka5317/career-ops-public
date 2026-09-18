#!/usr/bin/env node

/**
 * strip-resume-locations.mjs — Remove Boston, MA / Pune, India location prefixes
 * from Experience and Education sections of resume HTML files. Per user preference
 * 2026-05-30: locations under Experience + Education should NOT appear.
 *
 * Header location (San Jose / Boston) stays — that's the candidate's residence,
 * different from job/school locations.
 *
 * Usage:
 *   node strip-resume-locations.mjs <file1.html> [file2.html ...]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node strip-resume-locations.mjs <file1.html> [file2.html ...]');
  process.exit(1);
}

const replacements = [
  // Education school names — drop the city suffix
  // One entry per school on your CV: match "<School>, <City>", keep the school.
  [/Example State University, Springfield/g, 'Example State University'],

  // Experience subtitle — drop "Boston, MA · " or "Pune, India · " prefix
  // (anywhere it appears inside a .sub line)
  [/Boston, MA &middot; /g, ''],
  [/Pune, India &middot; /g, ''],

  // If the sub line is ONLY the location (no separator), drop the location text
  [/<div class="sub">Boston, MA<\/div>/g, '<div class="sub"></div>'],
  [/<div class="sub">Pune, India<\/div>/g, '<div class="sub"></div>'],
];

let totalChanges = 0;

for (const file of files) {
  const path = resolve(file);
  const original = readFileSync(path, 'utf-8');
  let updated = original;
  let fileChanges = 0;

  for (const [pattern, replacement] of replacements) {
    const matches = updated.match(pattern);
    if (matches) {
      updated = updated.replace(pattern, replacement);
      fileChanges += matches.length;
    }
  }

  if (fileChanges > 0) {
    writeFileSync(path, updated, 'utf-8');
    console.log(`✅ ${file} — ${fileChanges} replacement(s)`);
    totalChanges += fileChanges;
  } else {
    console.log(`⏭️  ${file} — no matches (already stripped or different template)`);
  }
}

console.log(`\nTotal replacements: ${totalChanges} across ${files.length} file(s)`);
