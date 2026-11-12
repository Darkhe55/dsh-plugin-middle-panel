// Reads the full source body the same way the build assembles it.
// Tests grep this instead of src/client.js, which is now only a shell.
const fs = require('fs');
const path = require('path');

const partsDir = path.join(__dirname, '..', 'src', 'parts');

const readSource = () =>
  fs
    .readdirSync(partsDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => fs.readFileSync(path.join(partsDir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, ''))
    .join('\n');

module.exports = { readSource };
