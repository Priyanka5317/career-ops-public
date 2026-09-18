import { execSync } from 'child_process';
import { resolve, basename } from 'path';
import { readdirSync } from 'fs';

function extractDocx(filename) {
  const absPath = resolve(filename).split('\\').join('\\\\');
  const ps = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${absPath}')`,
    "$entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }",
    "$reader = [System.IO.StreamReader]::new($entry.Open())",
    "$content = $reader.ReadToEnd()",
    "$zip.Dispose()",
    "$content"
  ].join('; ');

  try {
    const result = execSync(`powershell -Command "${ps}"`, { maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' });
    return result.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 10000);
  } catch (e) {
    return 'ERROR: ' + (e.stderr || e.message).substring(0, 200);
  }
}

const args = process.argv.slice(2);
const files = args.length > 0 ? args : readdirSync('resumes').filter(f => f.endsWith('.docx')).map(f => `resumes/${f}`);

for (const f of files) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FILE: ${basename(f)}`);
  console.log('='.repeat(60));
  console.log(extractDocx(f));
}
