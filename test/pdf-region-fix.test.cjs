// 框选坐标以 iframe 为准、标注文案带位置、工具栏不再出现进程说明。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— 坐标基准 ——
check(has('const pdfRef = React.useRef(null);'), 'iframe 有 ref');
check(has("h(\n            FitStage,") || has('FitStage,'), '舞台仍在');
check(/FitStage,[\s\S]{0,120}position: 'relative', width: '100%', height: '100%'/.test(src), '捕获层与页面同处一个缩放容器');
check(has('const rect = frame.getBoundingClientRect();'), '按 iframe 的真实矩形测量');
check(
  /const ratioOf = \(event\) => \{[\s\S]{0,300}const frame = pdfRef\.current;/.test(src),
  '比例也以 iframe 为基准',
);
const pdfBody = src.slice(src.indexOf('function PdfDoc(props) {'), src.indexOf('// ---------------- design files ----------------'));
check(!pdfBody.includes('pageBox') && !pdfBody.includes('setBox('), 'PdfDoc 不再做一次性测量');
check(has("left: hoverRegion[0] * 100 + '%',"), '高亮用百分比（随容器一起缩放）');
check(has("left: Math.min(drag.from.x, drag.to.x) * 100 + '%',"), '拖拽框用百分比');
check(has("inset: 0, width: '100%', height: '100%'"), 'iframe 铺满同一容器，坐标天然对齐');

// —— 文案 ——
check(has('const regionWhere = (rect) => {'), '有位置描述函数');
check(has("const column = centerX < 0.34 ? '左' : centerX > 0.66 ? '右' : '中';"), '左右锚点');
check(has("const row = centerY < 0.34 ? '上' : centerY > 0.66 ? '下' : '中';"), '上下锚点');
check(has("' · 距左 ' +"), '给出横向偏移');
check(has("'%、距上 ' +"), '给出纵向偏移');
check(has("'第 ' + (mark.page || 1) + ' 页 · ' + regionWhere(mark.rect)"), '标注行使用位置描述');

// 真实求值
const start = src.indexOf('    const regionWhere = (rect) => {');
const end = src.indexOf('    const markWhere = (mark) =>');
const api = new Function(src.slice(start, end) + '\nreturn { regionWhere };')();
check(api.regionWhere([0.04, 0.12, 0.37, 0.15]).startsWith('上左'), '左上区域', api.regionWhere([0.04, 0.12, 0.37, 0.15]));
check(api.regionWhere([0.5, 0.5, 0.1, 0.1]).startsWith('中部'), '居中区域');
check(api.regionWhere([0.8, 0.8, 0.15, 0.1]).startsWith('下右'), '右下区域');
check(api.regionWhere([0.04, 0.12, 0.37, 0.15]).includes('距左 4%'), '包含横向偏移数值');

// —— 提示移除 ——
check(!has('内置阅读器在独立进程'), '工具栏不再有进程说明');
check(!has('阅读器在进程外'), '旧说法彻底删除');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
