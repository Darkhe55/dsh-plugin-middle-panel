// 精确时间轴：四态按钮、入出点互斥、Alt+滚轮缩放窗口。
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('    const quantizeTime = (time, fps) => {');
const end = src.indexOf('    function VideoDoc(props) {');
if (start < 0 || end < 0) {
  console.log('FAIL 锚点缺失');
  process.exit(1);
}
const api = new Function(src.slice(start, end) + '\nreturn { quantizeTime, clipAction, zoomWindow };')();

// ---------------- 帧量化 ----------------
check(api.quantizeTime(0.51, 30) === 0.5, '0.51 量化到帧', String(api.quantizeTime(0.51, 30)));
check(api.quantizeTime(1.0, 25) === 1, '25fps 下整秒不变');
check(Math.abs(api.quantizeTime(0.484, 24) - 0.5) < 1e-9, '24fps 就近到 0.5', String(api.quantizeTime(0.484, 24)));
check(api.quantizeTime(0, 30) === 0, '0 保持 0');
check(api.quantizeTime(2.9999, 30) === 3, '接近整秒不会掉到上一帧');
check(api.quantizeTime(1, 0) === 1, '非法帧率退回 30');

// ---------------- 四态按钮 ----------------
let action = api.clipAction(null, null, 30);
check(action.kind === 'now' && action.label === '标记此刻', '无入无出 → 标记此刻', JSON.stringify(action));

action = api.clipAction(5, null, 30);
check(action.kind === 'point' && action.label === '标记入点' && action.start === 5, '只有入点 → 标记入点', JSON.stringify(action));

action = api.clipAction(null, 9, 30);
check(action.kind === 'point' && action.label === '标记出点' && action.start === 9, '只有出点 → 标记出点', JSON.stringify(action));

action = api.clipAction(5, 9, 30);
check(action.kind === 'range' && action.label === '标记区间' && action.start === 5 && action.end === 9, '入<出 → 标记区间', JSON.stringify(action));

action = api.clipAction(5, 5, 30);
check(action.kind === 'point' && action.label === '标记入点', '入==出 不算区间', JSON.stringify(action));

// 间距不足一帧也不能算区间
action = api.clipAction(5, 5 + 1 / 60, 30);
check(action.kind === 'point', '半帧间距不算区间', JSON.stringify(action));

action = api.clipAction(5, 5 + 1 / 30, 30);
check(action.kind === 'range', '正好一帧算区间', JSON.stringify(action));

// 逆序（理论上已被互斥清掉）不产出区间
action = api.clipAction(9, 5, 30);
check(action.kind === 'point' && action.label === '标记入点', '逆序不生成区间', JSON.stringify(action));

// ---------------- 缩放窗口 ----------------
const near = (a, b) => Math.abs(a - b) < 1e-6;

let win = api.zoomWindow(0, Infinity, 600, 300, 1 / 1.4, 1);
check(Number.isFinite(win.span) && near(win.span, 600 / 1.4), '从"全部"放大到 600/1.4', JSON.stringify(win));
check(near(win.start + win.span / 2, 300), '以指针时间为锚点', JSON.stringify(win));

// 指针在左侧放大：左端贴边不越界
win = api.zoomWindow(0, 600, 600, 0, 1 / 1.4, 1);
check(win.start === 0 && near(win.span, 600 / 1.4), '以左端为锚时窗口贴 0', JSON.stringify(win));

// 指针在右侧放大：右端贴边
win = api.zoomWindow(0, 600, 600, 600, 1 / 1.4, 1);
check(near(win.start + win.span, 600), '以右端为锚时窗口贴尾部', JSON.stringify(win));

// 最大深度夹到 minSpan
win = api.zoomWindow(100, 1.2, 600, 101, 1 / 1.4, 1);
check(near(win.span, 1), '缩到最小窗口（1 秒）即停', JSON.stringify(win));

// 继续缩小回到"全部"
win = api.zoomWindow(0, 300, 600, 300, 4, 1);
check(win.span === Infinity && win.start === 0, '缩放到超过片长即恢复全部', JSON.stringify(win));

// 超出片长的缩放直接恢复全部
win = api.zoomWindow(0, 600, 600, 300, 1.4, 1);
check(win.span === Infinity, '窗口超过片长即全部', JSON.stringify(win));

// 时长为 0 时安全
win = api.zoomWindow(0, Infinity, 0, 0, 1 / 1.4, 1);
check(win.span === Infinity, '时长为 0 安全', JSON.stringify(win));

// ---------------- 交互契约 ----------------
const has = (text) => src.includes(text);
check(has("addEventListener('wheel', handler, { passive: false })"), '滚轮用非被动原生监听');
check(has('if (!duration) return;') && has('if (event.altKey) {'), '只在有时长时处理滚轮，且 Alt 走缩放');
check(has('wheelRef.current = (event) => {'), '处理器持有最新闭包');
check(!src.includes('onWheel: onTrackWheel'), '不再用 React 的被动 onWheel');
check(has('event.deltaY < 0 ? 1 / 1.4 : 1.4'), '滚轮方向决定放大/收回');
check(has('const minSpan = Math.max(frame * 2, Math.min(1, fullSpan));'), '最小窗口 1 秒（帧级）');
check(has("'data-frame': zoomed && span <= 1.5 ? '1' : '0'"), '帧级窗口标记');
check(has('onContextMenu: onTrackMenu'), '时间轴有右键菜单');
check(has("'插入入点（' + formatTime(info.current) + '）'"), '菜单插入入点用滑块位置');
check(has("'插入出点（' + formatTime(info.current) + '）'"), '菜单插入出点用滑块位置');
check(has('disabled: !hasIn && !hasOut'), '无入出点时清除项置灰');
check(has('setInPoint(null);') && has('setOutPoint(null);'), '清除入出点是同一个动作');
check(has('if (hasOut && next >= outPoint) setOutPoint(null);'), '设入点晚于出点时删掉出点');
check(has('if (hasIn && next <= inPoint) setInPoint(null);'), '设出点早于入点时删掉入点');
check(has('addClip(action.start, action.end);'), '标记区间用入出点');
check(has("if (action.kind === 'now')"), '无点时按当前位置打点');
check(src.includes('hoverBase.current = target;'), '跳转后把新位置记为基准');
check(has('if (!moved) {'), '单击不生成区间');
check(has("event.key === 'i' || event.key === 'I'"), 'I 键插入入点');
check(has("event.key === 'o' || event.key === 'O'"), 'O 键插入出点');
check(has("const markLabel = action.label;"), '按钮文案来自四态判断');
check(has("'data-kind': hasRange ? 'primary' : 'default'"), '区间可用时按钮更醒目');

// 落定语义
check(has('setDrag(null);'), '松手时重置拖动状态');
check(has('pressRef.current = null;'), '松手时重置按下状态');
check(has('setHover(null);'), '落定时清除悬停态');
check(has('addClip(start, end);'), '拖动生成区间');
check(
  src.indexOf('addClip(start, end);') < src.indexOf('seekTo(time);', src.indexOf('addClip(start, end);')),
  '拖动结束后再跳到松手位置',
);

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
