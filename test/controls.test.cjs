// A3: the control vocabulary is a contract, so a refactor that quietly turns a
// switch back into a button should fail here instead of in a screenshot.
const fs = require('fs');

const src = fs.readFileSync('src/client.js', 'utf8');
const built = fs.readFileSync('client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 取出每个 h('button', {...}) 的 props 对象
const pattern = /h\(\s*'button'\s*,\s*\{/g;
const buttonProps = () => {
  const blocks = [];
  let match;
  for (;;) {
    match = pattern.exec(src);
    if (!match) break;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let cursor = open;
    for (; cursor < src.length; cursor += 1) {
      const ch = src[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    blocks.push(src.slice(open, cursor));
    pattern.lastIndex = cursor;
  }
  return blocks;
};

const blocks = buttonProps();
check(blocks.length > 20, '扫描到足够多的按钮', String(blocks.length));

const toggles = blocks.filter((block) => block.includes('dshcv-toggle'));
const primary = blocks.filter((block) => block.includes("'data-kind': 'primary'"));
const quiet = blocks.filter((block) => block.includes("'data-kind': 'quiet'"));

check(toggles.length >= 10, '开关数量合理', String(toggles.length));
check(primary.length >= 3, '主按钮数量合理', String(primary.length));
check(quiet.length >= 8, '次要按钮数量合理', String(quiet.length));

const noPressed = toggles.filter((block) => !block.includes("'aria-pressed'"));
check(noPressed.length === 0, '每个开关都声明 aria-pressed', noPressed[0] ? noPressed[0].slice(0, 90) : '');

const wrongPressed = toggles.filter((block) => /'aria-pressed': (?![\s\S]*\?)/.test(block));
check(wrongPressed.length === 0, 'aria-pressed 由状态表达式驱动，而不是常量', wrongPressed[0] ? wrongPressed[0].slice(0, 90) : '');

const toggleWithKind = toggles.filter((block) => block.includes("'data-kind'"));
check(toggleWithKind.length === 0, '开关不使用 data-kind（语义不混用）', toggleWithKind[0] ? toggleWithKind[0].slice(0, 90) : '');

const primaryAsToggle = primary.filter((block) => block.includes('dshcv-toggle'));
check(primaryAsToggle.length === 0, '主按钮不是开关', primaryAsToggle[0] ? primaryAsToggle[0].slice(0, 90) : '');

check(!/['"]data-primary['"]/.test(src), '代码里没有遗留的 data-primary');
check(!/['"]data-quiet['"]/.test(src), '代码里没有遗留的 data-quiet');

// 样式契约：这四条是"开关可辨识"的基础
const required = [
  '.dshcv-toggle[aria-pressed="true"]',
  '.dshcv-toggle:focus-visible',
  '.dshcv-btn[data-kind="primary"]',
  '.dshcv-btn[data-kind="quiet"]',
  '.dshcv-seg',
  'prefers-reduced-motion: reduce',
];
for (const selector of required) {
  check(src.includes(selector), '样式包含 ' + selector);
  check(built.includes(selector), '构建产物保留 ' + selector);
}

// 开关必须有可见的两种形态：关闭与打开各自的规则都要在
check(/\.dshcv-toggle\{[^}]*radial-gradient/.test(src), '关闭态使用径向渐变');
check(/\.dshcv-toggle\[aria-pressed="true"\]\{[^}]*radial-gradient/.test(src), '打开态使用径向渐变');
check(/\.dshcv-toggle\[aria-pressed="true"\]\{[^}]*border-radius:14px/.test(src), '打开态圆角更大');

// A2：强调色必须走令牌，不能散落硬编码
const hardcoded = (src.match(/#4f8cff/g) || []).length;
check(hardcoded <= 1, '强调色只在令牌里出现一次', 'found ' + hardcoded);
check(src.includes('--dshcv-accent:'), '定义了 --dshcv-accent');
check(src.includes('var(--dshcv-accent)'), '主按钮使用 --dshcv-accent');

// 每个分段控件里的按钮都应有 aria-pressed
const segCount = (src.match(/className: 'dshcv-seg'/g) || []).length;
const segPressed = blocks.filter((block) => block.includes("'aria-pressed'")).length;
check(segCount >= 1, '存在分段控件', String(segCount));
check(segPressed >= segCount * 2, '分段控件里的按钮都有状态', segPressed + ' 个');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}

