// 框选坐标与页面同处一个缩放容器：布局变化（标注列表展开）不得造成偏移。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfDoc(props) {');
const end = src.indexOf('// ---------------- design files ----------------');
const body = src.slice(start, end);

// —— 结构：捕获层在 FitStage 内部，与 iframe 共用同一个相对容器 ——
const fitIdx = body.indexOf('FitStage,');
const innerIdx = body.indexOf("position: 'relative', width: '100%', height: '100%'", fitIdx);
const iframeIdx = body.indexOf("title: 'canvas pdf preview'", innerIdx);
const layerIdx = body.indexOf('ref: layerRef', iframeIdx);
check(fitIdx > 0 && innerIdx > fitIdx && iframeIdx > innerIdx && layerIdx > iframeIdx, '捕获层嵌在舞台内、iframe 之后');

// —— 坐标：全部百分比，随容器一起缩放 ——
check(body.includes("left: hoverRegion[0] * 100 + '%',"), '高亮用百分比');
check(body.includes("top: hoverRegion[1] * 100 + '%',"), '高亮纵向也用百分比');
check(body.includes("left: Math.min(drag.from.x, drag.to.x) * 100 + '%',"), '拖拽框用百分比');
check(body.includes("inset: 0, width: '100%', height: '100%'"), 'iframe 铺满同一容器');

// —— 不再有一次性测量（这是"首次正常、之后全偏"的根源） ——
check(!body.includes('pageBox'), '没有 pageBox');
check(!body.includes('setBox('), '没有缓存测量值');
check(!body.includes('ResizeObserver'), '不再靠观察器补测');

// —— 比例仍以 iframe 的实际矩形为准，缩放不影响比值 ——
check(/const ratioOf = \(event\) => \{[\s\S]{0,260}getBoundingClientRect\(\)/.test(body), '比例按 iframe 实测');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
