// 无动画的 html/svg 不显示暂停条、可直接拾取；动图能播放也能暂停。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— 无动画即静止 ——
check(has('function frozen(){if(paused)return true;'), '注入脚本区分"手动暂停"与"本来就不动"');
check(has('if(!frozen()){hideBox();'), '悬停框在静止时可拾取');
check(has('if(!frozen())return;e.preventDefault()'), '点击拾取在静止时生效');
check(has('anim.count > 0'), '暂停条按动画数量显示');
const barUses = (src.match(/anim\.count > 0/g) || []).length;
check(barUses === 2, '两处动画条（html 与 svg）都已收敛', String(barUses));
check(has(': null,'), '无动画时不渲染工具条');

// —— 动图支持 ——
check(has("'apng'"), 'apng 归入图片');
check(has("if (ext === 'gif') return 'image/gif';"), 'gif 有正确 MIME');
check(has('const animatedImage = /\\.(gif|apng|webp)$/i.test(String(doc.path || \'\'));'), '识别动图格式');
check(has('const [frozenFrame, setFrozenFrame] = React.useState(null);'), '有冻结帧状态');
check(has('const freezeFrame = () => {'), '有冻结实现');
check(has("setFrozenFrame(canvas.toDataURL('image/png'));"), '冻结为位图');
check(has('src: frozenFrame || state.url,'), '冻结时显示静止帧');
check(has("frozenFrame ? '播放' : '暂停'"), '按钮可在暂停/播放间切换');
check(has("title: frozenFrame ? '继续播放动图' : '暂停动图（停在当前帧）'"), '按钮提示明确');
check(has('animatedImage && state.status === "ready"'), '仅动图显示该按钮');
check(has('image: 64'), '图片体积上限明确');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
