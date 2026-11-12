// PDF 框选标注：内置阅读器拦不住点击，就用一层自己的捕获层。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

const start = src.indexOf('function PdfDoc(props) {');
const end = src.indexOf('// ---------------- design files ----------------', start);
const body = src.slice(start, end);

// —— 捕获层 ——
check(body.includes('const [markMode, setMarkMode] = React.useState(false);'), '有框选模式开关');
check(body.includes('className: markMode ? \'dshcv-pdflayer dshcv-pdflayer-on\' : \'dshcv-pdflayer\''), '有覆盖阅读器的捕获层');
check(body.includes("style: { pointerEvents: markMode ? 'auto' : 'none' },"), '关闭时不挡滚动');
check(body.includes('onPointerDown: onLayerDown'), '按下开始框选');
check(body.includes('onPointerMove: onLayerMove'), '移动更新框');
check(body.includes('onPointerUp: onLayerUp'), '松手生成标注');
check(body.includes('setPointerCapture'), '拖动时不丢指针');

// —— 标注内容 ——
check(body.includes("kind: 'region',"), '生成区域标注');
check(body.includes('norm: true,'), '坐标归一化，缩放不漂移');
check(body.includes('page,'), '记录页码');
check(body.includes("quote: '第 ' + page + ' 页区域',"), '引用里写明页码');
check(body.includes('if (w * h < 0.0008) return;'), '误点不生成区域');

// —— 工具栏与提示 ——
check(body.includes("markMode ? '退出框选' : '框选标注'"), '工具栏有开关按钮');
check(body.includes("'aria-pressed': markMode,"), '开关状态可读');
check(body.includes('框选期间滚轮不可用'), '明确告知滚轮行为');
check(body.includes("markMode ? 'primary' : 'quiet'"), '开启时按钮高亮');

// —— 迷你标记 ——
check(body.includes("className: 'dshcv-pdfmarquee'"), '拖拽时显示框');
check(body.includes("className: 'dshcv-pdfregion'"), '悬停标注时显示位置');
check(has('.dshcv-pdflayer{position:absolute;inset:0'), '捕获层样式');
check(has('.dshcv-pdfmarquee{position:absolute'), '拖拽框样式');
check(has('.dshcv-pdfregion{position:absolute'), '标注高亮样式');

// —— 归一化坐标的文案与去重 ——
check(has("mark.norm && Array.isArray(mark.rect)"), '标注栏按百分比描述');
check(src.includes('Math.round(w * 100)'), '显示区域宽度占比');
check(has('const tolerance = left.norm ? 0.01 : 2;'), '归一化坐标用比例容差');
check(has('if (left.norm && Number(left.page || 0) !== Number(right.page || 0)) return false;'), '不同页不算同一区域');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
