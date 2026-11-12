// React #31 的结构性防线：h(type, props, ...children) 的第二个参数必须是 props。
// 若把提示条/表单插到 props 之前，真正的 props 对象就变成子节点，运行时报
// "Objects are not valid as a React child"。这里在源码层面把它找出来。
const fs = require('fs');
const path = require('path');

const bundlePath = process.env.DSH_CANVAS_BUNDLE || path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(bundlePath, 'utf8');

const splitTopLevel = (text) => {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] || '';
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
};

const argsOf = (openIndex) => {
  let depth = 0;
  let quote = '';
  let start = openIndex + 1;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return splitTopLevel(src.slice(start, i));
    }
  }
  return null;
};

const problems = [];
let calls = 0;

for (let i = 0; i < src.length - 2; i += 1) {
  if (src[i] !== 'h' || src[i + 1] !== '(') continue;
  const before = src[i - 1] || '';
  if (/[A-Za-z0-9_$.]/.test(before)) continue;
  const args = argsOf(i + 1);
  if (!args || args.length < 2) continue;
  calls += 1;
  const props = args[1].trim();
  if (props.startsWith('{') || props === 'null' || props === 'undefined') continue;
  if (props.startsWith('Object.assign(') || props.startsWith('Object.assign (')) continue;
  if (/^[A-Za-z_$][\w$]*$/.test(props)) continue; // 变量形式的 props
  const misplaced = args.slice(2).some((arg) => /^\{\s*(className|style)\s*:/.test(arg.trim()));
  if (misplaced) {
    const line = src.slice(0, i).split('\n').length;
    problems.push('第 ' + line + ' 行：h() 的第二个参数不是 props，而后面出现了 props 对象');
  }
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

check(calls > 100, '扫描到足够多的 h() 调用', String(calls));
check(problems.length === 0, '没有 props 被当作子节点', problems.slice(0, 4).join(' | '));

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
