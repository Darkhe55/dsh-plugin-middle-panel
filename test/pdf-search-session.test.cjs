// 搜索会话：新搜索取消旧搜索，长文档定期让帧，结果只由最后一次写入。
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

check(view.includes('const searchToken = React.useRef(0);'), '有搜索 token');
check(view.includes('const token = searchToken.current + 1;'), '每次搜索取新 token');
check(view.includes('if (searchToken.current !== token) return;'), '过期搜索提前退出');

const guards = view.split('if (searchToken.current !== token) return;').length - 1;
check(guards >= 2, '循环内与写结果前都检查', String(guards));

check(
  view.includes('if (pageNumber % 20 === 0) await new Promise((done) => setTimeout(done, 0));'),
  '每 20 页让帧',
);
check(view.includes('if (searchToken.current === token) setSearching(false);'), '只有最新搜索关闭 spinner');
check(view.includes('setHits(found);'), '仍然写入结果');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
