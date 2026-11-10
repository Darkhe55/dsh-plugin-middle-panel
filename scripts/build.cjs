// Build step: turns src/client.js into the shipped client.js.
//
// The transform is deliberately conservative — it only removes full-line comments,
// block comments that occupy whole lines, and leading indentation. Those are the
// three safe categories here: the file has no multi-line template literals, so no
// string content depends on leading whitespace.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'client.js');
const target = path.join(root, 'client.js');

const raw = fs.readFileSync(source, 'utf8');
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
const ratio = ((1 - after / before) * 100).toFixed(1);
console.log(
  'client.js  ' + before.toLocaleString() + ' B → ' + after.toLocaleString() + ' B  (-' + ratio + '%)',
);

// A quick sanity check: the output must still parse.
try {
  new Function(built);
} catch (error) {
  console.error('构建产物无法解析：' + error.message);
  fs.writeFileSync(target, raw);
  process.exit(1);
}
