// 连续滚动、缩略图侧栏、全文搜索三项能力。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

const pageStart = src.indexOf('function PdfPage(props) {');
const pageEnd = src.indexOf('function PdfThumb(props) {');
const page = src.slice(pageStart, pageEnd);
const thumbEnd = src.indexOf('function PdfCanvasDoc(props) {');
const thumb = src.slice(pageEnd, thumbEnd);
const docStart = thumbEnd;
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

// —— 连续滚动 ——
check(view.includes('Array.from({ length: pages }'), '所有页面一次性排在滚动区里');
check(view.includes("className: 'dshcv-pdfpages'"), '有滚动容器');
check(page.includes('new IntersectionObserver('), '页面按可见性懒渲染');
check(page.includes("rootMargin: '600px 0px'"), '预渲染附近页面');
check(view.includes('const scrollToPage = (pageNumber) => {'), '可滚动到指定页');
check(page.includes('onVisible(pageNumber, entry.intersectionRatio)'), '可见页上报');
check(view.includes('if (ratio > 0.35) setCurrent'), '当前页跟随滚动');

// —— 缩略图侧栏 ——
check(view.includes("className: 'dshcv-pdfthumbs'"), '有侧栏容器');
check(view.includes('h(PdfThumb, {'), '逐页缩略图');
check(thumb.includes('page.render({ canvasContext: context, viewport }).promise'), '缩略图真实渲染');
check(thumb.includes('onClick: () => onPick(pageNumber)'), '点击缩略图跳页');
check(has("'.dshcv-pdfthumb-on canvas{box-shadow:0 0 0 2px rgba(79,140,255,.95)"), '当前页高亮');

// —— 全文搜索 ——
check(view.includes('const search = async () => {'), '有搜索实现');
check(view.includes('await textContentOf(pdf, pageNumber)'), '按页读取文本（带缓存）');
check(view.includes('item.str.toLowerCase().includes(needle)'), '大小写不敏感匹配');
check(view.includes('const gotoHit = (next) => {'), '可跳转命中');
check(view.includes("'上一个'") && view.includes("'下一个'"), '有前后切换按钮');
check(view.includes('hits.length + \' 处 · 第 \''), '显示命中数');
check(page.includes("className: 'dshcv-pdfhit'"), '页面高亮命中');
check(has("'.dshcv-pdfhit[data-active=\"1\"]"), '当前命中更醒目');
check(src.includes('const textContentOf = async (pdf, pageNumber) => {'), '文本内容有缓存');

// —— 原有能力仍在 ——
check(page.includes("kind: 'region'") || view.includes("kind: 'region'"), '区域标注仍在');
check(view.includes('markSelection'), '选中文字标注仍在');
check(view.includes('setMarkMode'), '框选模式仍在');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
