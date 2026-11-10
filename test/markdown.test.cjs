// Extracts the markdown parser + hover painter from client.js and exercises them
// with a minimal element factory, so the refactor is verified rather than assumed.
const fs = require('fs');
const src = fs.readFileSync('client.js', 'utf8');

const start = src.indexOf('    const parseMarkdown = (text) => {');
const end = src.indexOf('    const MarkdownBody = (props) => {');
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

const expected = ['h1@1', 'p@3', 'ul@6', 'blockquote@9', 'pre@11'];
const ok = JSON.stringify(summary) === JSON.stringify(expected);
console.log(ok ? 'PASS 结构与行号锚点正确' : 'FAIL 期望 ' + expected.join(', '));

const litems = blocks[2].children[0].map((li) => li.props['data-line']);
console.log(JSON.stringify(litems) === '[6,7]' ? 'PASS 列表项逐行锚点正确' : 'FAIL 列表项锚点 ' + JSON.stringify(litems));

// Without CSS Highlights the block itself is washed, and only that block.
const hovered = applyMarkdownHover(blocks, 3, 4);
const classes = hovered.map((b) => (b.props.className || '').trim());
console.log(
  JSON.stringify(classes) === JSON.stringify(['dshcv-dim', 'dshcv-spot', 'dshcv-dim', 'dshcv-dim', 'dshcv-dim'])
    ? 'PASS 回退模式只高亮命中的块'
    : 'FAIL 回退结果 ' + JSON.stringify(classes),
);

// With CSS Highlights the block keeps its own class, because the exact characters
// are painted by the highlight registry instead of a background on the block.
supported.value = true;
const precise = applyMarkdownHover(blocks, 3, 4);
const preciseClasses = precise.map((b) => (b.props.className || '').trim());
console.log(
  JSON.stringify(preciseClasses) === JSON.stringify(['dshcv-dim', '', 'dshcv-dim', 'dshcv-dim', 'dshcv-dim'])
    ? 'PASS 精确模式不给整块涂底色'
    : 'FAIL 精确结果 ' + JSON.stringify(preciseClasses),
);
supported.value = false;

const untouched = applyMarkdownHover(blocks, 0, 0);
console.log(untouched === blocks ? 'PASS 无悬停时不做克隆' : 'FAIL 无悬停仍克隆');
