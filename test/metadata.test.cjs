// 展示元数据：详情页文档、图标、本地化与打包清单。DSH 详情页只渲染 meta 与一张图，
// 不渲染插件运行时的开关，所以描述必须自己说清开关在哪。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
const en = readJson('locale/en.json').meta;
const zh = readJson('locale/zh.json').meta;

// 1) 两套语言都声明了标题、描述与详情文档
for (const [label, meta] of [['en', en], ['zh', zh]]) {
  check(typeof meta.title === 'string' && meta.title.length > 0, label + '：有标题');
  check(typeof meta.description === 'string' && meta.description.length > 40, label + '：有描述');
  check(typeof meta.detail === 'string' && meta.detail.endsWith('.md'), label + '：声明了详情文档', String(meta.detail));
}

// 2) 详情文档存在、在包内、以 / 分隔
for (const [label, meta] of [['en', en], ['zh', zh]]) {
  const target = path.join(root, meta.detail);
  check(fs.existsSync(target), label + '：详情文档存在', meta.detail);
  check(!meta.detail.includes('\\') && !meta.detail.startsWith('/') && !meta.detail.includes('..'), label + '：路径合法', meta.detail);
}

// 3) 详情文档只含一行图片，不含标题或说明文字
for (const [label, meta] of [['en', en], ['zh', zh]]) {
  const lines = fs.readFileSync(path.join(root, meta.detail), 'utf8').split('\n').filter((line) => line.trim());
  check(lines.length === 1, label + '：只有一行内容', String(lines.length));
  check(/^!\[[^\]]+\]\([^)]+\.svg\)$/.test(lines[0] || ''), label + '：那一行是图片引用', String(lines[0]).slice(0, 60));
  check(!/^#/m.test(lines[0] || ''), label + '：没有标题');
}

// 4) 图片存在且符合约束：640×300、无脚本、无字体、无文字
{
  const svgPath = path.join(root, 'docs/preview.svg');
  check(fs.existsSync(svgPath), '预览图存在');
  const svg = fs.readFileSync(svgPath, 'utf8');
  check(/width="640"/.test(svg) && /height="300"/.test(svg), '预览图尺寸 640×300');
  check(!/<script|<foreignObject|<style|on\w+=/i.test(svg), '预览图没有脚本或样式表');
  check(!/<text|<font|@font-face/i.test(svg), '预览图没有文字');
  // xmlns 只是命名空间标识，不算远程引用；要排除的是 href/src/url() 里的远程地址
  const remote = /(?:href|src|url)\(?['"]?https?:\/\//i.test(svg);
  check(!remote, '预览图不引用远程资源');
  check(Buffer.byteLength(svg) < 1024 * 1024, '预览图小于 1 MiB', String(Buffer.byteLength(svg)));
}

// 5) 描述必须说清「在哪打开」与「开关在哪」，这是详情页唯一的说明渠道
{
  const mentionsButton = /画布/.test(zh.description) && /canvas/i.test(en.description);
  const mentionsSettings = /设置/.test(zh.description) && /settings/i.test(en.description);
  const mentionsSwitch = /新产物自动打开/.test(zh.description) && /new/i.test(en.description);
  check(mentionsButton, '描述说明了打开入口');
  check(mentionsSettings, '描述说明了设置在哪');
  check(mentionsSwitch, '描述提到了自动打开开关');
  check(/192/.test(zh.description) && /192/.test(en.description), '描述说明了体积上限');
}

// 6) 打包清单包含详情文档目录与本地化资源
check(Array.isArray(pkg.files) && pkg.files.includes('docs'), 'files 包含 docs');
check(pkg.files.some((item) => item.startsWith('locale/')), 'files 包含 locale');
check(pkg.exports['./locale/*.json'] === './locale/*.json', '导出 locale');
check(pkg.exports['./icon'] === './icon.svg', '导出 icon');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
