// P1: the split view is a view over two documents — state, focus, and the template.
const fs = require('fs');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('    const atLeastTwoDocs = () => store.docs.length > 1;');
const end = src.indexOf('    const closeDoc = (id) => {');
if (start < 0 || end < 0) {
  console.log('FAIL 锚点缺失');
  process.exit(1);
}

const factory = new Function(
  'store',
  'mutate',
  'notify',
  src.slice(start, end) + '\nreturn { splitState, secondDoc, setSplit, focusDoc, toggleSplit };',
);

const make = (docs, activeId, split, focus) => {
  const state = {
    store: {
      docs: docs.map((path, i) => ({ id: 'd' + i, path })),
      activeId,
      // 与真实 store 一致：并排状态总是存在
      split: split || { on: false, secondId: null, ratio: 0.5, dir: 'row' },
      splitFocus: focus || 'a',
      flash: '',
    },
  };
  const api = factory(state.store, (patch) => Object.assign(state.store, patch), () => {});
  return { state, api };
};

// —— 默认值 ——
{
  const { api } = make(['a.md'], 'd0');
  const state = api.splitState();
  check(state.on === false && state.ratio === 0.5 && state.dir === 'row', '默认关闭、50%、横排', JSON.stringify(state));
  check(api.secondDoc() === null, '没有第二个文档时为 null');
}

// —— 打开并排 ——
{
  const { state, api } = make(['a.md', 'b.html'], 'd0');
  api.toggleSplit();
  check(state.store.split.on === true, '两个文档时可以进入并排');
  check(state.store.split.secondId === 'd1', '第二个文档自动填入', String(state.store.split.secondId));
  check(state.store.splitFocus === 'a', '焦点留在第一窗格');
}

// —— 只有一个文档 ——
{
  const { state, api } = make(['a.md'], 'd0');
  api.toggleSplit();
  check(state.store.split.on === false, '只有一个文档时不进入并排');
  check(/再打开一个/.test(state.store.flash), '提示先打开第二个交付物', state.store.flash);
}

// —— 关闭并排 ——
{
  const { state, api } = make(['a.md', 'b.html'], 'd0', { on: true, secondId: 'd1', ratio: 0.4, dir: 'row' });
  api.toggleSplit();
  check(state.store.split.on === false, '再次点击收起并排');
  check(state.store.split.secondId === null, '收起后清空第二窗格');
  check(state.store.split.ratio === 0.4, '比例被记住');
}

// —— 焦点切换 ——
{
  const { state, api } = make(['a.md', 'b.html'], 'd0', { on: true, secondId: 'd1', ratio: 0.5, dir: 'row' });
  api.focusDoc(state.store.docs[1]);
  check(state.store.splitFocus === 'b', '点第二个文档 → 焦点到 b');
  check(state.store.activeId === 'd0', '第一窗格的内容不变');
  api.focusDoc(state.store.docs[0]);
  check(state.store.splitFocus === 'a', '点第一个文档 → 焦点回 a');
}

// —— 第三个标签替换未聚焦的一侧 ——
{
  const { state, api } = make(['a.md', 'b.html', 'c.svg'], 'd0', { on: true, secondId: 'd1', ratio: 0.5, dir: 'row' });
  api.focusDoc(state.store.docs[2]);
  check(state.store.split.secondId === 'd2', '焦点在 a 时，第三个标签替换 b 窗格');
  check(state.store.splitFocus === 'b', '焦点跟到新打开的一侧');

  const second = make(['a.md', 'b.html', 'c.svg'], 'd0', { on: true, secondId: 'd1', ratio: 0.5, dir: 'row' }, 'b');
  second.api.focusDoc(second.state.store.docs[2]);
  check(second.state.store.activeId === 'd2', '焦点在 b 时，第三个标签替换 a 窗格');
  check(second.state.store.splitFocus === 'a', '焦点回到 a');
}

// —— 未开启并排时点击标签 = 普通切换 ——
{
  const { state, api } = make(['a.md', 'b.html'], 'd0');
  api.focusDoc(state.store.docs[1]);
  check(state.store.activeId === 'd1', '并排关闭时点击标签直接切换');
  check(state.store.split.on === false, '不会偷偷打开并排');
}

// —— 模板契约 ——
check(/className: 'dshcv-slots'/.test(src), '渲染层有 slots 容器');
check(/'data-dir': splitState\(\)\.dir/.test(src), '排列方向来自状态');
check(/className: 'dshcv-slot'/.test(src), '渲染层有两个 slot');
check(/'data-active': splitState\(\)\.on && secondDoc\(\) && store\.splitFocus === 'b' \? '0' : '1'/.test(src), '激活态跟随焦点');
check(/function SplitDivider\(props\)/.test(src), '分隔条是独立组件');
check(/onDoubleClick: \(\) => setSplit\(\{ ratio: 0\.5 \}\)/.test(src), '双击分隔条复位 50/50');
check(/const snap = \(ratio\) =>/.test(src), '松手吸附到 30/40/50/60/70');
check(/'aria-pressed': splitState\(\)\.on \? 'true' : 'false'/.test(src), '并排开关有 aria-pressed');
check(/'data-second': splitState\(\)\.on/.test(src), '标签条标出第二窗格');
check(/if \(state\.on && state\.secondId === id\)/.test(src), '关闭第二窗格文档时收起并排');
check(/split: splitState\(\),\n\s+splitFocus: store\.splitFocus,/.test(src), '并排状态进持久化');
check(/store\.split = \{\n\s+on: Boolean\(data\.split\.on\)/.test(src), '恢复时校验并排状态');
check(/\.dshcv-divider\{flex:0 0 9px/.test(src), '分隔条有 9px 命中区');
check(/cursor:row-resize/.test(src), '上下排列时光标方向正确');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}

