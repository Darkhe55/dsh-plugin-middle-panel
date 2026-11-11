// Guard against the regressions seen this round: a React element concatenated with
// `+` (renders "[object Object]"), and a primary button whose styling depends on
// anything that can fail to resolve.
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
  if (/^\s*\+/.test(src.slice(index + 1, index + 8))) {
    const line = src.slice(0, at).split('\n').length;
    concatenated.push(line + ': ' + src.slice(at, at + 60).replace(/\s+/g, ' '));
  }
  cursor = index + 1;
}
check(concatenated.length === 0, '没有用 + 拼接 React 元素', concatenated.slice(0, 3).join(' | '));

// 2) 标注行的路径与位置必须是并列子节点
check(/key: 'path', className: 'dshcv-mpath'/.test(src), '标注行路径是独立子节点');
check(/shortenPath\(mark\.path\)/.test(src), '标注行使用路径而不是文件名');

// 3) 主按钮必须自包含：字面量颜色，波纹在按钮自身，不用伪元素与自定义属性
const lines = src.split('\n');
const primaryRule = (src.match(/\.dshcv-btn\[data-kind="primary"\]\{[^}]*\}/) || [''])[0];
check(Boolean(primaryRule), '存在主按钮规则');
check(primaryRule.includes('background-color:rgba('), '底色是字面量 rgba');
check(!primaryRule.includes('background-image:radial-gradient('), '波纹已移出按钮本体（由模糊层绘制）');
check(!primaryRule.includes('animation:dshcv-ripple'), '动画在模糊层而不是按钮本体');
check(!/var\(--dshcv-primary/.test(primaryRule || ''), '主按钮不依赖自定义属性');
check(!/::before|::after/.test(primaryRule || ''), '主按钮本体不含伪元素');

// 柔光层可以放在伪元素里，但按钮本体的底色/描边必须自足：
// 伪元素失效时按钮仍然可见。
const glowRule = lines.find((line) => line.includes('data-kind="primary"]::before{'));
check(Boolean(glowRule), '存在模糊波纹层');
check(glowRule.includes('filter:blur('), '波纹层带高斯模糊');
check(/blur\(\s*[1-9]/.test(glowRule), '模糊半径大于 0', (glowRule.match(/blur\(([^)]+)\)/) || [])[1]);
check(glowRule.includes('animation:dshcv-ripple'), '波纹层带动画');
check(src.includes('backdrop-filter:blur('), '按钮使用背景模糊');
check(
  src.includes('prefers-reduced-motion: reduce){.dshcv-btn[data-kind="primary"]::before{animation:none}}'),
  '减少动态效果时关闭波纹动画',
);
check(src.includes('@keyframes dshcv-ripple'), '定义了波纹动画');
check(
  src.includes('prefers-reduced-motion: reduce){.dshcv-btn[data-kind="primary"]'),
  '减少动态效果时关闭动画',
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

