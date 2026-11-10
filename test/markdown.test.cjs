// Extracts the markdown parser + hover painter from client.js and exercises them
// with a minimal element factory, so the refactor is verified rather than assumed.
const fs = require('fs');
const src = fs.readFileSync('client.js', 'utf8');

const start = src.indexOf('const parseMarkdown = (text) => {');
const end = src.indexOf('const MarkdownBody = (props) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

// The hover painter asks whether the browser supports CSS Highlights, so the
// harness supplies the capability instead of a real CSS object.
const supported = { value: false };
const supportsCssHighlights = () => supported.value;

const h = (type, props, ...children) => ({ type, props: props || {}, children });
const React = { cloneElement: (el, patch) => ({ ...el, props: { ...el.props, ...patch } }) };
const inlineMd = (text) => [String(text)];

const factory = new Function(
  'h',
  'React',
  'inlineMd',
  'supportsCssHighlights',
  body + '\nreturn { parseMarkdown, applyMarkdownHover };',
);
const { parseMarkdown, applyMarkdownHover } = factory(h, React, inlineMd, supportsCssHighlights);

let failures = 0;
const kids = (el) => (el && el.children && el.children.length === 1 && Array.isArray(el.children[0]) ? el.children[0] : (el.children || []));
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const sample = [
  '# 标题',
  '',
  '第一段第一行',
  '第一段第二行',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '> 引用行',
  '',
  '```js',
  'const a = 1;',
  '```',
].join('\n');

const blocks = parseMarkdown(sample);
const summary = blocks.map((b) => b.type + '@' + b.props['data-line']);
console.log('blocks:', summary.join(', '));
check(
  JSON.stringify(summary) === JSON.stringify(['h1@1', 'p@3', 'ul@6', 'blockquote@9', 'pre@11']),
  '结构与行号锚点正确',
  summary.join(', '),
);

const litems = kids(blocks[2]).map((li) => li.props['data-line']);
check(JSON.stringify(litems) === '[6,7]', '列表项逐行锚点正确', JSON.stringify(litems));

// Tables, task lists, and a trailing paragraph (the last block has no blank line
// after it, which used to be dropped entirely).
const rich = ['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 3 |', '| 梨 | 5 |', '', '- [x] 已完成', '- [ ] 未完成', '', '结尾段落'].join('\n');
const richBlocks = parseMarkdown(rich);
const richSummary = richBlocks.map((b) => b.type + '@' + b.props['data-line']);
console.log('rich:', richSummary.join(', '));
check(
  JSON.stringify(richSummary) === JSON.stringify(['table@1', 'ul@6', 'p@9']),
  '表格、任务列表与结尾段落都被保留',
  richSummary.join(', '),
);
const table = richBlocks[0];
const tableRows = table.children[1].children[0];
check(
  table.children.length === 2 && Array.isArray(tableRows) && tableRows.length === 2 && kids(tableRows[0]).length === 2,
  '表格有表头与两行两列',
  JSON.stringify(table.children.map((c) => c.type)) + ' / rows=' + (Array.isArray(tableRows) ? tableRows.length : 'n/a'),
);
check(
  kids(richBlocks[1]).every((li) => li.props.className === 'dshcv-task'),
  '任务列表项带勾选框样式',
  JSON.stringify(kids(richBlocks[1]).map((li) => li.props.className)),
);
check(
  JSON.stringify(kids(richBlocks[1]).map((li) => kids(li)[0].children[0])) === JSON.stringify(['☑', '☐']),
  '勾选状态正确',
  JSON.stringify(kids(richBlocks[1]).map((li) => kids(li)[0].children[0])),
);

// Code fence at the end of the file must not be swallowed either.
const tailFence = parseMarkdown(['段落', '', '```', 'x = 1', '```'].join('\n'));
check(
  JSON.stringify(tailFence.map((b) => b.type)) === JSON.stringify(['p', 'pre']),
  '结尾代码块被保留',
  JSON.stringify(tailFence.map((b) => b.type)),
);

const hovered = applyMarkdownHover(blocks, 3, 4);
const classes = hovered.map((b) => (b.props.className || '').trim());
check(
  JSON.stringify(classes) === JSON.stringify(['dshcv-dim', 'dshcv-spot', 'dshcv-dim', 'dshcv-dim', 'dshcv-dim']),
  '回退模式只高亮命中的块',
  JSON.stringify(classes),
);

supported.value = true;
const precise = applyMarkdownHover(blocks, 3, 4);
const preciseClasses = precise.map((b) => (b.props.className || '').trim());
check(
  JSON.stringify(preciseClasses) === JSON.stringify(['dshcv-dim', '', 'dshcv-dim', 'dshcv-dim', 'dshcv-dim']),
  '精确模式不给整块涂底色',
  JSON.stringify(preciseClasses),
);
supported.value = false;

check(applyMarkdownHover(blocks, 0, 0) === blocks, '无悬停时不做克隆');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}




