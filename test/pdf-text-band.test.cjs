// 文字标注按行高亮，不画外框；区域标注仍画框。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const pageStart = src.indexOf('function PdfPage(props) {');
const pageEnd = src.indexOf('function PdfThumb(props) {');
const page = src.slice(pageStart, pageEnd);
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(pageEnd, docEnd);

// —— 逐行记录 ——
check(page.includes('Array.from(range.getClientRects())'), '取每一行的矩形');
check(page.includes('const bands = fragments'), '生成带子数组');
check(page.includes('.sort((a, b) => a[1] - b[1] || a[0] - b[0]);'), '按从上到下排序');
check(page.includes('bands.map((item) => item.map((value) => Math.round(value * 10000) / 10000)),'), '带子按页面归一化');

// —— 渲染：文字用带子、区域用框 ——
check(page.includes('mark.text') && page.includes('? null'), '文字标注不再常驻渲染');
check(page.includes('dshcv-pdftexthit'), '带子有独立类名');
check(page.includes('dshcv-pdfregion'), '区域标注仍画框');
check(page.includes('hoverBands && hoverBands.length'), '悬停文字也按带子高亮');
check(page.includes('dshcv-pdftexthit dshcv-pdftexthit-hot'), '悬停带子更亮');

// —— 样式：无边框 ——
const css = src.slice(src.indexOf("'.dshcv-pdftexthit{"), src.indexOf("'.dshcv-pdftexthit{") + 400);
check(!/border:/.test(css.split('}')[0]), '带子不画外框', css.split('}')[0]);
check(css.includes('background:rgba(79,140,255,.10)'), '带子为极淡蓝底');
const hotIdx = src.indexOf("'.dshcv-pdftexthit-hot{");
const hotRule = src.slice(hotIdx, hotIdx + 200).split('}')[0];
check(hotRule.includes('rgba(79,140,255,.12)'), '悬停底色同样很淡', hotRule);
check(hotRule.includes('inset 0 -1px 0'), '用 1px 底部细线表示标注', hotRule);
check(!hotRule.includes('0 0 8px'), '去掉外发光，避免盖住文字');
check(src.includes("'.dshcv-pdfregion{"), '区域框样式保留');

// —— 数据链路 ——
check(view.includes('bands: selection.bands,'), '标注保存带子');
check(view.includes('const onSelect = (pageNumber, rect, bands, text) => {'), '回传带子');
check(view.includes('hoverBands:'), '悬停传带子');
check(src.includes("? '第 ' + (mark.page || 1) + ' 页 · 引用文字（' + mark.bands.length + ' 行）'"), '标注栏说明是引用文字');


// —— 只在悬停时显示 ——
check(page.includes('pageMarks.map((mark, index) =>') && page.includes('mark.text'), '标记层区分文字与区域');
check(page.includes('hoverBands && hoverBands.length'), '悬停时才画带子');
check(page.includes("className: 'dshcv-pdftexthit'" ) || page.includes('dshcv-pdftexthit'), '带子样式仍存在');
check(!page.includes('mark.bands.map('), '常驻分支已移除');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}