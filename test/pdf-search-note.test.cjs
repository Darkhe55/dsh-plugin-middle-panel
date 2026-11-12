// 扫描件提示：搜不到时要说清是"没有这个词"还是"这份 PDF 没有文本层"。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfCanvasDoc(props) {');
const end = src.indexOf('function PdfDoc(props) {');
const view = src.slice(start, end);

check(view.includes('const [searchNote, setSearchNote] = React.useState("");'), '有提示状态');
check(view.includes('let textChars = 0;'), '累计可搜索字符数');
check(view.includes('textChars += joined.length;'), '按页累加');

// 两种原因的判定
check(view.includes('textChars === 0'), '判定无文本层');
check(view.includes('这个 PDF 没有可搜索的文本层（可能是扫描件），需要 OCR 才能检索'), '扫描件文案');
check(view.includes('"没有找到「" + term + "」"'), '未找到文案');

// 有结果时清空
check(view.includes('} else {'), '有结果分支');
const clearCount = view.split('setSearchNote("");').length - 1;
check(clearCount >= 2, '开始搜索与清空输入都会复位', String(clearCount));

// 渲染
check(view.includes("searchNote ? h('div', { className: 'dshcv-pdfnote' }, searchNote) : null,"), '提示条渲染');
check(src.includes("'.dshcv-pdfnote{"), '提示条有样式');

// 不干扰既有链路
check(view.includes('if (searchToken.current !== token) return;'), '过期搜索仍会退出');
check(view.includes('setHits(found);'), '结果照常写入');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
