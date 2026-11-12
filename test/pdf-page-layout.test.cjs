const { readSource } = require('./_source.cjs');
// 页面盒子必须是不可压缩的 flex 项：否则有界高度里每页会被压成一条窄缝。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const ruleOf = (selector) => {
  const idx = src.indexOf("'" + selector + "{");
  if (idx < 0) return '';
  return src.slice(idx, src.indexOf("}'", idx) + 1);
};

const column = ruleOf('.dshcv-pdfcolumn');
const pageBox = ruleOf('.dshcv-pdfpagebox');
const pages = ruleOf('.dshcv-pdfpages');

check(column.includes('flex:0 0 auto'), '列容器不被压缩', column);
check(pageBox.includes('flex:0 0 auto'), '页面盒子不被压缩', pageBox);
check(pageBox.includes('position:relative'), '页面盒子仍是定位祖先');
check(pages.includes('overflow:auto'), '滚动区仍是滚动容器');
check(pages.includes('flex-direction: column') === false, '滚动区不再自己纵向排布（交给列容器）', pages);

// 尺寸由渲染结果驱动，不能是固定小值
check(
  src.includes("style: width ? { width: width + 'px', height: height + 'px' } : null,"),
  '页面尺寸同步算出（不等渲染）',
);
check(
  src.includes('const width = Math.max(0, (baseSize && baseSize.width ? baseSize.width : 612) * scale);'),
  '尺寸 = 页面基准 × 缩放',
);
check(src.includes('canvas.width = buffer.width;'), '位图另存于离屏缓冲');
check(src.includes('ctx.drawImage(buffer, 0, 0);'), '一次 drawImage 完成替换');

// 搜索与缩放的依赖没有被破坏
check(src.includes('const search = async () => {'), '搜索仍在');
check(src.includes('node.addEventListener("wheel", onWheel, { passive: false });'), '缩放仍在');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
