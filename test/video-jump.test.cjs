// 时间跳转（含宽容解析与"跳到"按钮）、菜单不越界、标注悬停高亮。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// ---- 解析：宽容缺项 ----
const start = src.indexOf('    const parseTime = (text) => {');
// parseTime 现在紧挨着 markWhere，用它当结束锚点（旧的注释锚点已随重构消失）
const end = src.indexOf('    const markWhere = (mark) =>');
const parse = new Function(src.slice(start, end) + '\nreturn parseTime;')();
check(parse('1:') === 60, '"1:" 视为 1 分钟', String(parse('1:')));
check(parse(':30') === 30, '":30" 视为 30 秒', String(parse(':30')));
check(parse('1:2') === 62, '"1:2" 视为 1 分 2 秒', String(parse('1:2')));
check(parse('01:02:03.5') === 3723.5, '完整写法不受影响', String(parse('01:02:03.5')));
check(parse(' 12.4 ') === 12.4, '容忍空格', String(parse(' 12.4 ')));
check(Number.isNaN(parse('abc')), '非数字仍然无效');
check(Number.isNaN(parse('1:2:3:4')), '四段无效');

// ---- 跳转要能在未就绪时排队，且不被 NaN 时长夹成 0 ----
check(has('const applySeek = (node, time) => {'), '定位集中在 applySeek');
check(has('if (!node.readyState) {'), '未就绪时排队');
check(has("node.addEventListener('loadedmetadata', once, { once: true });"), '元数据就绪后再定位');
check(has('Number.isFinite(total) && total > 0 ? Math.min(total, requested) : requested'), '时长不可用时不做夹取');
check(has('hoverBase.current = target;'), '落定位置同步到基准');

// ---- "跳到"按钮 ----
check(has('const typed = parseTime(timeDraft);'), '按钮用解析结果');
check(has('if (Math.abs(typed - info.current) <= frame / 2) return null;'), '与当前位置相同则不显示');
check(has('if (duration && typed > duration + 0.05) return null;'), '超出片长不显示');
check(has("'跳转',"), '按钮只写「跳转」，不重复时间');
check(has('seekTo(typed);'), '点击按钮跳转');

// ---- 菜单不越界 ----
check(has('const width = 220;'), '按菜单宽度夹取');
check(has('Math.min(rect.width - width - 8, localX - 24)'), '右侧不越界');
check(has('localY + height + 12 > rect.height ? Math.max(8, localY - height) : localY + 6'), '下方不够时翻到上方');
check(has("style: { left: menuAt.x + 'px', top: menuAt.y + 'px' }"), '直接使用已夹取的坐标');

// ---- 标注悬停高亮 ----
check(has('hovered && hovered.kind === \'video\''), '悬停标注时取时间');
check(has("className: 'dshcv-markband'"), '高亮区间');
check(has("className: 'dshcv-markhead'"), '高亮时间点');
check(has('.dshcv-markband{position:absolute'), '区间有样式');
check(has('box-shadow:0 0 10px rgba(79,140,255,.55)'), '区间带蓝色荧光');
check(has('box-shadow:0 0 8px rgba(79,140,255,.85)'), '时间点带蓝色荧光');
check(has('hovered.end > hovered.start'), '单点标注只画一条线');


// —— 位置：在总时长右侧 ——
const durationIdx = src.indexOf("'/ ' + formatTime(duration)");
const jumpIdx = src.indexOf("              '跳转',");
check(durationIdx > 0 && jumpIdx > durationIdx, '跳转按钮排在总时长之后');
check(has("title: '跳转到 ' + formatTime(typed)"), '目标时间放进 title，方便悬停确认');
check(has("'aria-label': '跳转到 ' + formatTime(typed)"), '无障碍名称带上目标时间');

// —— 右键只弹菜单，不动播放头 ——
check(has('if (event.button !== 0) return;'), '按下只认左键');
const downIdx = src.indexOf('const onTrackDown = (event) => {');
const downBody = src.slice(downIdx, src.indexOf('const onTrackMove', downIdx));
check(downBody.indexOf('event.button !== 0') >= 0 && downBody.indexOf('event.button !== 0') < downBody.indexOf('seekTo('), '左键检查在 seek 之前');
const upIdx = src.indexOf('const onTrackUp = (event) => {');
const upBody = src.slice(upIdx, src.indexOf('const onTrackLeave', upIdx));
check(upBody.indexOf('event.button !== 0') >= 0, '松开也只认左键');
check(has('if (menuAt) return;'), '菜单打开时不预览，右键抖动不改画面');
const menuIdx = src.indexOf('const onTrackMenu = (event) => {');
const menuBody = src.slice(menuIdx, src.indexOf('const ferry', menuIdx) > 0 ? src.indexOf('const ferry', menuIdx) : menuIdx + 600);
check(menuBody.indexOf('seekTo(') < 0, '右键菜单处理里没有 seek');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
