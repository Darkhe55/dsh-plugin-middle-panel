const { readSource } = require('./_source.cjs');
// 代码高亮的接线与外观：token 要真的渲染出来，配色与缩进导引要在。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— 接线 ——
const text = src.slice(src.indexOf('function TextDoc(props) {'), src.indexOf('function HtmlDoc(props) {'));
check(text.includes("const codeLang = doc.view === 'text' ? codeLangOf(doc.path) : '';"), '仅文本类文档做高亮');
check(text.includes('() => buildCodeLines(state.text, codeLang),'), '按语言生成 token');
check(text.includes('[state.text, codeLang],'), '随内容与语言重算');
check(text.includes("className: 'dshcv-text' + (codeLang ? ' dshcv-code' : '')"), '代码块带独立类名');
check(text.includes("'dshcv-tok dshcv-tok-' + cls"), 'token 落到类名');
check(text.includes(': highlight(line, deferredQuery),'), '非代码仍用搜索高亮');

// —— 文本完整性：token 拼回去必须等于原行 ——
const start = src.indexOf('    const CODE_LANG = {');
const end = src.indexOf('    const parseTime = (text) => {');
const api = new Function(src.slice(start, end) + '\nreturn { buildCodeLines };')();
const sample = 'const url = "http://a/b?c=1"; // note';
const rebuilt = api.buildCodeLines(sample, 'js')[0].map(([t]) => t).join('');
check(rebuilt === sample, '高亮不改动文本内容', rebuilt);

// —— 配色 ——
check(has("'.dshcv-tok-kw{color:#a626a4;font-weight:600}'"), '关键字有颜色与字重');
check(has("'.dshcv-tok-str{color:#50a14f}'"), '字符串有颜色');
check(has("'.dshcv-tok-num{color:#b76b01}'"), '数字有颜色');
check(has("'.dshcv-tok-com{color:#8b949e;font-style:italic}'"), '注释斜体灰');
check(has("'.dshcv-tok-fn{color:#3a7bd5}'"), '函数调用有颜色');
check(has("'.dshcv-tok-type{color:#c18401}'"), '类型有颜色');
check(has("'.dshcv-tok-tag{color:#e45649}'"), '标签有颜色');
check(has("'.dshcv-tok-attr{color:#986801}'"), '属性有颜色');

// —— 深色模式 ——
check(has('@media (prefers-color-scheme:dark)'), '提供深色配色');
check(has("'.dshcv-tok-kw{color:#c678dd}'"), '深色关键字换色');

// —— 颜色分块：缩进导引 ——
check(has('.dshcv-code{background-image:repeating-linear-gradient'), '缩进导引');
check(has('--dshcv-guide:'), '导引色单独定义，不覆盖文字色');
check(has('calc(2ch - 1px)'), '每两字符一条导引');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
