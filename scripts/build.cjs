// Build step: assembles src/parts/*.js into the shipped client.js.
//
// The body lives in src/parts and is concatenated in filename order; the transform is
// deliberately conservative — it only removes full-line comments, block comments that
// occupy whole lines, and leading indentation. Those are the three safe categories here:
// the file has no multi-line template literals, so no string content depends on leading
// whitespace.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const shell = path.join(root, 'src', 'client.js');
const partsDir = path.join(root, 'src', 'parts');
const target = path.join(root, 'client.js');
const MARK = '//@@PARTS@@';

const parts = fs
  .readdirSync(partsDir)
  .filter((name) => name.endsWith('.js'))
  .sort();

if (!parts.length) {
  console.error('build: src/parts is empty');
  process.exit(1);
}

const body = parts
  .map((name) => fs.readFileSync(path.join(partsDir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, ''))
  .join('\n');

const shellText = fs.readFileSync(shell, 'utf8').replace(/\r\n/g, '\n');
if (!shellText.includes(MARK)) {
  console.error('build: src/client.js is missing the ' + MARK + ' marker');
  process.exit(1);
}
const raw = shellText.replace(MARK, () => body);

const lines = raw.split('\n');
const out = [];
let inBlock = false;

for (const line of lines) {
  const trimmed = line.trim();

  if (inBlock) {
    if (trimmed.includes('*/')) inBlock = false;
    continue;
  }
  if (trimmed.startsWith('/*')) {
    if (!trimmed.includes('*/')) inBlock = true;
    continue;
  }
  if (!trimmed) continue;
  if (trimmed.startsWith('//')) continue;

  out.push(line.replace(/^[ \t]+/, ''));
}

const built = out.join('\n') + '\n';
fs.writeFileSync(target, built);

const before = Buffer.byteLength(raw);
const after = Buffer.byteLength(built);
console.log('build: ' + parts.length + ' parts, ' + before + ' → ' + after + ' bytes');
