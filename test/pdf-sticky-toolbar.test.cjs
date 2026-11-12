const { readSource } = require('./_source.cjs');
// 工具栏必须常驻：多页滚动时仍能点到标注按钮。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 根容器使用专用类
check(src.includes("className: 'dshcv-docwrap dshcv-pdfdocwrap'"), 'PDF 视图使用专用根类');

// 外层不再滚动
const wrapIdx = src.indexOf("'.dshcv-pdfdocwrap{");
check(wrapIdx > 0, '有专用根样式');
const wrapRule = src.slice(wrapIdx, wrapIdx + 200).split('}')[0];
check(wrapRule.includes('overflow:hidden'), '外层不滚动', wrapRule);
check(wrapRule.includes('flex-direction:column'), '纵向布局');

// 工具栏吸顶
const toolsIdx = src.indexOf("'.dshcv-pdfdocwrap .dshcv-tools{");
check(toolsIdx > 0, '工具栏有专属规则');
const toolsRule = src.slice(toolsIdx, toolsIdx + 260).split('}')[0];
check(toolsRule.includes('position:sticky'), '工具栏吸顶', toolsRule);
check(toolsRule.includes('flex:0 0 auto'), '工具栏不被压缩');
check(toolsRule.includes('z-index'), '工具栏在内容之上');
check(toolsRule.includes('background'), '吸顶时有不透明底色');

// 中间层不滚，页面列自己滚
const mainIdx = src.indexOf("'.dshcv-pdfmain{");
const mainRule = src.slice(mainIdx, mainIdx + 200).split('}')[0];
check(mainRule.includes('overflow:hidden'), '中间层不滚动', mainRule);
const pagesIdx = src.indexOf("'.dshcv-pdfpages{");
const pagesRule = src.slice(pagesIdx, pagesIdx + 220).split('}')[0];
check(pagesRule.includes('overflow:auto'), '页面列承担滚动', pagesRule);
check(src.includes("className: 'dshcv-pdfthumbs'"), '侧栏仍在');

// 工具栏里的按钮都在吸顶区内（结构检查）
const docStart = src.indexOf('function PdfCanvasDoc(props) {');
const toolIdx = src.indexOf("className: 'dshcv-tools'", docStart);
const mainStart = src.indexOf("className: 'dshcv-pdfmain'", docStart);
check(toolIdx > 0 && mainStart > toolIdx, '工具栏在滚动区之前');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
