// 文件列表的类型图标：每个 fileKind 都要有对应图形，目录用文件夹图形，
// 行里必须真的插入图标，且样式约束住尺寸（14px、跟随主题色）。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 从源码里取出 ICON_SHAPES 的键名。 */
const shapeBlock = /const ICON_SHAPES = \{([\s\S]*?)\n    \};/.exec(src);
check(Boolean(shapeBlock), '找到 ICON_SHAPES 表');
const keys = shapeBlock ? [...shapeBlock[1].matchAll(/^\s{6}([a-z]+):/gm)].map((m) => m[1]) : [];
check(keys.length >= 11, '图标数量足够', String(keys.length));

/** fileKind 会返回的全部种类。 */
const kinds = [...src.matchAll(/return '([a-z]+)';/g)].map((m) => m[1]);
const expected = ['html', 'markdown', 'image', 'video', 'pdf', 'model', 'cad', 'design', 'unsupported', 'office', 'sheet', 'text'];
for (const kind of expected) {
  check(keys.includes(kind), '有 ' + kind + ' 的图标');
}
check(keys.includes('folder'), '有文件夹图标');

// 每个图形的标签必须是 SVG 基本元素，且都有几何参数
const validTags = ['path', 'rect', 'circle'];
const body = shapeBlock ? shapeBlock[1] : '';
const tags = [...body.matchAll(/\['(path|rect|circle)'/g)].map((m) => m[1]);
check(tags.length > 20, '图标由 SVG 基本元素组成', String(tags.length));
check(tags.every((tag) => validTags.includes(tag)), '没有非法标签');

// 渲染入口
check(/const fileIcon = \(kind, isDir\) =>/.test(src), '存在 fileIcon(kind, isDir)');
check(/ICON_SHAPES\[isDir \? 'folder' : kind\]/.test(src), '目录优先用文件夹图标');
check(/h\(\s*'svg'/.test(src), 'fileIcon 输出 svg 元素');
check(/className: 'dshcv-rowicon'/.test(src), 'svg 带 dshcv-rowicon 类名');
check(/stroke: 'currentColor'/.test(src), '颜色跟随主题（currentColor）');
check(/'aria-hidden': 'true'/.test(src), '对读屏隐藏（纯装饰）');

// 行渲染里真的用上了
check(/fileIcon\(fileKind\(joinPath\(state\.path, entry\.name\)\), entry\.dir\)/.test(src), '文件行插入了类型图标');

// 尺寸约束
const css = /'\.dshcv-rowicon\{([^}]*)\}'/.exec(src);
check(Boolean(css), '定义了 .dshcv-rowicon 样式');
if (css) {
  check(/width:14px/.test(css[1]) && /height:14px/.test(css[1]), '图标尺寸 14px', css[1]);
  check(/flex:0 0 auto/.test(css[1]), '不参与伸缩，避免挤压文件名');
}

// 不使用 emoji 冒充图标
check(!/[\u{1F300}-\u{1FAFF}]/u.test(body), '图标不是 emoji');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
