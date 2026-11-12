// 结构检查（局部匹配版）：模块级函数不能落在别的函数体范围里。
// parseTime 曾被插进 sameLocator 内部，运行时报 "parseTime is not defined"，
// 而所有基于文本匹配的测试都没发现——所以补这条。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');
const lines = src.split('\n');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const findDecl = (name) =>
  lines.findIndex((line) => line.startsWith(`    const ${name} = `) || line.startsWith(`    const ${name} =(`));

// 从声明行开始，按括号配平找出函数体的结束行（只处理代码，跳过字符串/注释）。
const spanEnd = (start) => {
  let depth = 0;
  let state = 'code';
  let opened = false;
  for (let index = start; index < Math.min(lines.length, start + 3000); index += 1) {
    const line = lines[index];
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      const next = line[i + 1];
      if (state === 'code') {
        if (char === '/' && next === '/') {
          state = 'line';
          i += 1;
        } else if (char === '/' && next === '*') {
          state = 'block';
          i += 1;
        } else if (char === "'") state = 'single';
        else if (char === '"') state = 'double';
        else if (char === '`') state = 'template';
        else if (char === '{') {
          depth += 1;
          opened = true;
        } else if (char === '}') {
          depth -= 1;
          if (opened && depth === 0) return index;
        }
      } else if (state === 'line') {
        if (char === '\\') i += 1;
      } else if (state === 'block') {
        if (char === '*' && next === '/') {
          state = 'code';
          i += 1;
        }
      } else if (state === 'single') {
        if (char === '\\') i += 1;
        else if (char === "'") state = 'code';
      } else if (state === 'double') {
        if (char === '\\') i += 1;
        else if (char === '"') state = 'code';
      } else if (state === 'template') {
        if (char === '\\') i += 1;
        else if (char === '`') state = 'code';
      }
    }
    if (state === 'line') state = 'code';
  }
  return start;
};

const NAMES = [
  'normalizePath',
  'sameFile',
  'mutate',
  'openDoc',
  'openDocs',
  'closeDoc',
  'focusDoc',
  'toggleSplit',
  'parseTime',
  'formatTime',
  'timeLabel',
  'markPlace',
  'markWhere',
  'sameLocator',
  'quantizeTime',
  'clipAction',
  'zoomWindow',
  'probeMp4FrameRate',
  'snapFrameRate',
  'viewerFor',
];

const spans = {};
for (const name of NAMES) {
  const start = findDecl(name);
  if (start < 0) {
    console.log('SKIP ' + name + '（未找到 4 空格缩进的声明）');
    continue;
  }
  spans[name] = { start, end: spanEnd(start) };
}

// 两两检查：任何声明都不能落在别人的函数体里（自己除外）
const names = Object.keys(spans);
for (const outer of names) {
  for (const inner of names) {
    if (outer === inner) continue;
    const a = spans[outer];
    const b = spans[inner];
    check(!(b.start > a.start && b.start <= a.end), inner + ' 不在 ' + outer + ' 内部', 'span ' + a.start + '-' + a.end);
  }
}

// parseTime 必须在使用它的 VideoDoc 之前
const videoDoc = lines.findIndex((line) => line.includes('function VideoDoc(props)'));
check(spans.parseTime.start < videoDoc, 'parseTime 在 VideoDoc 之前声明');

const uses = lines
  .map((line, index) => (line.includes('parseTime(') && !line.includes('const parseTime') ? index : -1))
  .filter((index) => index >= 0);
check(uses.length >= 1, '存在使用点', String(uses.length));
check(uses.every((index) => index > spans.parseTime.start), '使用点都在声明之后');
check(uses.every((index) => index > spans.parseTime.end), '使用点在 parseTime 函数体之外');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
