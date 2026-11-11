// Guard against the two regressions this round: a React element concatenated with `+`
// (renders "[object Object]") and a primary button that loses its fill.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 逐个配平 h(...) 的括号，看右括号后是否紧跟 `+`
const concatenated = [];
let cursor = 0;
for (;;) {
  const at = src.indexOf('h(', cursor);
  if (at < 0) break;
  cursor = at + 2;
  // 只认 `h(` 前面不是标识符字符的调用
  const before = at > 0 ? src[at - 1] : '';
  if (before && /[A-Za-z0-9_$.]/.test(before)) continue;
  let depth = 0;
  let index = at + 1;
  for (; index < src.length; index += 1) {
    const ch = src[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (index >= src.length) break;
  const rest = src.slice(index + 1, index + 8);
  if (/^\s*\+/.test(rest)) {
    const line = src.slice(0, at).split('\n').length;
    concatenated.push(line + ': ' + src.slice(at, at + 60).replace(/\s+/g, ' '));
  }
  cursor = index + 1;
}
check(concatenated.length === 0, '没有用 + 拼接 React 元素', concatenated.slice(0, 3).join(' | '));

// 2) 标注行的路径与位置必须是并列子节点
check(/key: 'path', className: 'dshcv-mpath'/.test(src), '标注行路径是独立子节点');
check(/shortenPath\(mark\.path\)/.test(src), '标注行使用路径而不是文件名');

// 3) 主按钮必须有可见底色与可见波纹
const lines = src.split('\n');
const primaryRule = lines.find((line) => line.includes('data-kind="primary"]{height:30px'));
check(Boolean(primaryRule), '存在主按钮规则');
check(primaryRule && /background:color-mix\(/.test(primaryRule), '主按钮底色是混合色（不是裸的层色，避免透明）');
check(!/background:var\(--dsw-alias-bg-layer-1\)/.test(primaryRule || ''), '主按钮不再直接用层色作底');

const wave = (src.match(/--dshcv-primary-wave:color-mix\(in srgb,var\(--dshcv-accent\) (\d+)%/) || [])[1];
check(Number(wave) >= 40, '波纹颜色足够显眼', wave + '%');
check(
  lines.some((line) => line.includes('data-kind="primary"]::before{background-image:repeating-radial-gradient')),
  '波纹层仍然存在',
);

// 4) 分组标题用子节点而不是拼接
check(
  /h\('span', \{ key: 'path', className: 'dshcv-mpath' \}, shortenPath\(group\.path, 40\)\)/.test(src),
  '分组标题路径是独立子节点',
);

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
