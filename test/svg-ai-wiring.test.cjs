const { readSource } = require('./_source.cjs');
// SVG 点击标注的接线：iframe 放行后，父窗口不能再用 paused 拦一次。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— SvgDoc 与 HtmlDoc 必须同一套门控 ——
const svgStart = src.indexOf('function SvgDoc(props) {');
const svgEnd = src.indexOf('function HtmlDoc(props) {') > svgStart ? src.indexOf('function HtmlDoc(props) {') : svgStart + 12000;
const svgBody = src.slice(svgStart, svgEnd);

check(svgBody.includes("data.source !== 'dshcv-picker'"), 'SvgDoc 处理 picker 消息');
check(!svgBody.includes('if (!pausedRef.current) return;'), 'SvgDoc 不再用 paused 二次拦截');
check(svgBody.includes("kind: 'layer'"), 'SVG 标注落到图层');
check(svgBody.includes('addMark('), 'SVG 点击会生成标注');

const htmlStart = src.indexOf('function HtmlDoc(props) {');
const htmlBody = src.slice(htmlStart, htmlStart + 12000);
check(htmlBody.includes("data.source !== 'dshcv-picker'") && !htmlBody.includes('if (!pausedRef.current) return;'), 'HtmlDoc 同样的门控');

// iframe 侧：静止即可拾取（与父窗口一致）
check(has('function frozen(){if(paused)return true;'), 'iframe 用 frozen() 决定能否拾取');
check(has('if(!frozen())return;e.preventDefault()'), '静止时点击即拾取');

// —— AI：走完整 PDF 查看器 ——
check(has('// A PDF-compatible .ai gets the full PDF viewer'), 'AI 有专门的注释说明');
check(has("return h(PdfDoc, { doc, sessionId });"), 'AI 渲染 PdfDoc');
check(!/state\.mode === 'pdf'[\s\S]{0,400}canvas ai preview/.test(src), '不再用 iframe 裸嵌');
check(has("'标记此页'"), 'PDF 查看器有标记此页');
check(has("'标记整份文档'"), 'PDF 查看器有标记整份');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
