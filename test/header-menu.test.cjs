const { readSource } = require('./_source.cjs');
// 头部「⋯」：窄面板折叠的次要操作入口，必须点得动且点了有内容。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// —— 触发方式 ——
check(/const \[menuOpen, setMenuOpen\] = React\.useState\(false\)/.test(src), '有菜单开关状态');
check(/className: 'dshcv-btn dshcv-more',\s*\n\s*title: '更多操作'/.test(src), '⋯ 按钮语义为"更多操作"');
check(/'aria-haspopup': 'menu'/.test(src), '按钮声明为菜单触发器');
check(/'aria-expanded': menuOpen \? 'true' : 'false'/.test(src), '按钮反映展开状态');
check(/onClick: \(\) => setMenuOpen\(\(value\) => !value\)/.test(src), '点击切换菜单');
check(!/head\.classList\.toggle\('dshcv-expanded'\)/.test(src), '不再用命令式 class 切换（会被 React 覆盖）');

// —— 菜单内容 ——
check(/className: 'dshcv-headmenu', role: 'menu'/.test(src), '渲染菜单容器');
check(/className: 'dshcv-menuitem'/.test(src), '条目有统一样式');
check(/'打开工作区文件'/.test(src), '含"打开工作区文件"');
check(/'发送标注 \(' \+ pendingMarks\(\)\.length \+ '\)'/.test(src), '含发送（有标注时）');
check(/'导出标注 JSON'/.test(src), '含导出');
check(/'导入标注 JSON'/.test(src), '含导入');
check(/'清空标注'/.test(src), '含清空');
check(/\(followHover\.on \? '关闭' : '开启'\) \+ '悬停跟随'/.test(src), '含悬停跟随开关');
check(/'帮助与键位'/.test(src), '含帮助');
check(/'回到对话'/.test(src), '含回到对话');

// —— 关闭行为 ——
check(/window\.addEventListener\('pointerdown', onDown, true\)/.test(src), '点外部关闭');
check(/target\.closest\('\.dshcv-headmenu, \.dshcv-more'\)/.test(src), '点在菜单或按钮上不关闭');
check(/if \(event\.key === 'Escape' && menuOpen\)/.test(src), 'Esc 关闭');
check(/setMenuOpen\(false\);\s*\n\s*closePanel\.current\(\);/.test(src), '"回到对话"后收起菜单');

// —— 各条目执行后都收起 ——
const closes = (src.match(/setMenuOpen\(false\);\s*\n\s*(setPickerOpen|send|exportMarks|importInputRef|setFollowHover|clearMarks|setHelpOpen|closePanel)/g) || []).length;
check(closes >= 6, '条目执行后统一收起菜单', String(closes));

// —— 样式 ——
check(/\.dshcv-headmenu\{position:absolute;top:calc\(100% - 4px\)/.test(src), '菜单绝对定位在头部下方');
check(/\.dshcv-head\{[^}]*position:relative/.test(src), '头部为定位容器');
check(/\.dshcv-more\{display:none\}/.test(src), '宽面板仍然隐藏 ⋯');
check(/@container \(max-width: 720px\)/.test(src), '窄面板才显示 ⋯');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
