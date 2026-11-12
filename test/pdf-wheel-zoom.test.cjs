const { readSource } = require('./_source.cjs');
// Ctrl（Cmd）+ 滚轮缩放页面，并保持光标下的内容不动。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const docEnd = src.indexOf('function PdfDoc(props) {');
const view = src.slice(docStart, docEnd);

check(view.includes('const zoomAnchor = React.useRef(null);'), '记录缩放锚点');
check(view.includes('node.addEventListener("wheel", onWheel, { passive: false });'), '原生非被动监听');
check(view.includes('if (!event.ctrlKey && !event.metaKey) return;'), '只在 Ctrl/Cmd 按下时缩放');
check(view.includes('event.preventDefault();'), '阻止浏览器整体缩放');
check(view.includes('pendingFactor *= event.deltaY < 0 ? 1.1 : 1 / 1.1;'), '按滚动方向累积缩放系数');
check(view.includes('setZoom((z) => Math.min(4, Math.max(0.4, Math.round(z * factor * 100) / 100)));'), '夹在 0.4–4 并取两位小数');
check(view.includes('ratio: (event.clientY - rect.top + node.scrollTop) / Math.max(1, node.scrollHeight),'), '记录光标处的相对位置');
check(view.includes('const until = Date.now() + 240;'), '锚点在一小段时间内保持');
check(view.includes('target.scrollTop = Math.max(0, anchor.ratio * target.scrollHeight - anchor.offset);'), '缩放后回到同一处');
check(view.includes('window.requestAnimationFrame(tick);'), '逐帧校正，避免抖动');
check(view.includes('if (!frame) frame = window.requestAnimationFrame(applyZoom);'), '一帧只应用一次缩放');
check(view.includes('if (mine !== token) return;'), '新的滚动事件会取消旧的校正循环');
check(!view.includes('}, [zoom]);'), '不再用单次 effect 校正（会被异步重排打乱）');

// 与工具栏按钮共用同一个 zoom 状态
check(view.includes('setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 100) / 100))'), '缩小按钮仍在');
check(view.includes('setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100))'), '放大按钮仍在');
check(view.includes('scale: zoom,'), '页面按 zoom 重绘');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
