// 帮助面板必须有可点击的关闭入口，并且背景遮罩也能关闭。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf("className: 'dshcv-help',");
const end = src.indexOf('let ctxRef;');
if (start < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const block = src.slice(start - 700, start + 2200);

check(/className: 'dshcv-help'/.test(block), '帮助面板仍然渲染');
check(/role: 'dialog'/.test(block), '带 dialog 语义');
check(/'aria-label': helpTab === 'settings' \?/.test(block), '无障碍标签跟随当前页');

// 关闭按钮
check(/'aria-label': '关闭帮助'/.test(block), '关闭按钮有无障碍标签');
check(/onClick: \(\) => setHelpOpen\(false\)/.test(block), '按钮真的关闭帮助');
check(/'关闭',/.test(block), '按钮有可见文字');

// 遮罩
check(/className: 'dshcv-helpbackdrop'/.test(block), '有背景遮罩');
check(/onClick: \(\) => setHelpOpen\(false\)/.test(block), '点击遮罩也能关闭');

// 样式：头部固定、面板不超出可视区
check(/\.dshcv-helphead\{[^}]*position:sticky/.test(src), '标题栏在滚动时保持可见');
check(/\.dshcv-help\{[^}]*max-height:calc\(100% - 32px\)/.test(src), '面板高度受限于容器');
check(/\.dshcv-help\{[^}]*overflow:auto/.test(src), '内容过多时可滚动');
check(/\.dshcv-helpbackdrop\{[^}]*position:absolute/.test(src), '遮罩铺满面板');

// 仍然保留键盘关闭
check(/event\.key === 'Escape' && helpOpen/.test(src), 'Esc 仍可关闭');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
