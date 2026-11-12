const { readSource } = require('./_source.cjs');
// 静止判定与选择器握手：SVG 的时间轴不能当作"在动"。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— frozen 判据 ——
check(!has('getCurrentTime()>0)return false'), '不再用 SVG 时间轴判断是否在动');
check(has('function smilCount(){'), '用 SMIL 元素数量判断');
check(
  has('"animate,animateMotion,animateTransform,animateColor,set"'),
  '覆盖 SMIL 全部动画标签',
);
check(has('if(smilCount())return false;'), '有 SMIL 才算在动');
check(has('if(anims().length)return false;'), 'CSS/WAAPI 动画仍然算在动');

// —— 握手诊断 ——
check(has("const [picker, setPicker] = React.useState('waiting');"), '记录选择器是否握手');
check(has("setPicker('ready');"), '收到上报即就绪');
check(has("now === 'waiting' ? 'missing' : now"), '1.5 秒无上报即为缺失');
check(has("picker === 'missing'"), '缺失时给出提示');
check(has('「注入脚本」开关是关闭状态'), '提示直接指向开关');

// —— Hooks 顺序：不能出现在 early return 之后 ——
const svgStart = src.indexOf('function SvgDoc(props) {');
const svgBody = src.slice(svgStart, src.indexOf('function HtmlDoc(props) {', svgStart));
const firstReturn = svgBody.indexOf("if (state.status === 'failed') {");
const hookAt = svgBody.indexOf('setPicker((now)');
check(firstReturn > 0 && hookAt > 0 && hookAt < firstReturn, '握手 hook 在 early return 之前');

// —— PDF 提示改写 ——
check(!has('阅读器在进程外，点击位置无法拦截'), '去掉费解的"进程外"原话');
check(!has('阅读器在进程外') && !has('内置阅读器在独立进程'), '工具栏不再出现进程说明');
check(has('在页面上拖出一块区域并标注'), '能力由框选按钮自己说明');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
