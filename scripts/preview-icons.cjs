#!/usr/bin/env node
/**
 * Regenerate docs/internal/icons-preview.html from the icon table in src/parts/00-head.js.
 *
 *   node scripts/preview-icons.cjs
 *
 * The preview is a snapshot, so it drifts the moment a glyph changes; regenerating it
 * is one command instead of hand-editing the HTML.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'parts', '00-head.js'), 'utf8');

const block = /const ICON_SHAPES = \{([\s\S]*?)\n    \};/.exec(source);
if (!block) throw new Error('ICON_SHAPES not found in src/parts/00-head.js');
const page = /const PAGE = \[([\s\S]*?)\];/.exec(source);
if (!page) throw new Error('PAGE constant not found');
const colorBlock = /const ICON_COLORS = \{([\s\S]*?)\n    \};/.exec(source);
if (!colorBlock) throw new Error('ICON_COLORS not found');
const colors = new Function('return {' + colorBlock[1] + '};')();

// Evaluate only our own object literal; PAGE is supplied as a parameter.
const MARK = 'mark';
const shapes = new Function('PAGE', 'MARK', 'return {' + block[1] + '};')(
  new Function('return [' + page[1] + '];')(),
  MARK,
);

const attr = (props) =>
  Object.entries(props)
    .map(([key, value]) => key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + '="' + value + '"')
    .join(' ');

const svg = (kind, size) => {
  const parts = shapes[kind] || shapes.text;
  const accent = colors[kind] || colors.text;
  const body = parts
    .map(([tag, props, role]) => {
      const merged = Object.assign({}, props);
      if (role === 'mark') {
        merged.stroke = accent;
        if (merged.fill === 'currentColor') merged.fill = accent;
      }
      return '<' + tag + ' ' + attr(merged) + ' />';
    })
    .join('');
  return (
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" ' +
    'stroke-linecap="round" stroke-linejoin="round" width="' + size + '" height="' + size + '" ' +
    'aria-hidden="true">' + body + '</svg>'
  );
};

const labels = {
  folder: '文件夹',
  text: '文本 .txt / 无扩展名',
  markdown: 'Markdown .md',
  html: 'HTML .html',
  pdf: 'PDF',
  office: 'Office .docx/.pptx',
  sheet: '表格 .csv',
  image: '图片 .png/.jpg/.svg',
  video: '视频 .mp4/.mov',
  model: '3D 模型 .glb/.obj',
  cad: 'CAD .dxf',
  design: '设计稿 .psd/.fig',
  unsupported: '暂不支持',
};

const sampleFiles = [
  { name: 'docs', dir: true },
  { name: 'notes.md' },
  { name: 'report.pdf' },
  { name: 'screenshot.png' },
  { name: 'demo.mp4' },
  { name: 'index.html' },
  { name: 'data.csv' },
  { name: 'spec.docx' },
  { name: 'scene.glb' },
  { name: 'plan.dxf' },
  { name: 'mockup.fig' },
  { name: 'notes.txt' },
  { name: 'archive.step' },
];

const kindOf = (name) => {
  if (name.endsWith('.md')) return 'markdown';
  if (name.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpg|jpeg|svg)$/.test(name)) return 'image';
  if (/\.(mp4|mov)$/.test(name)) return 'video';
  if (name.endsWith('.html')) return 'html';
  if (/\.(csv|tsv)$/.test(name)) return 'sheet';
  if (/\.(docx|pptx|xlsx)$/.test(name)) return 'office';
  if (/\.(glb|obj|gltf|stl)$/.test(name)) return 'model';
  if (name.endsWith('.dxf')) return 'cad';
  if (/\.(fig|psd|ai)$/.test(name)) return 'design';
  if (/\.(step|stp|iges|dwg|fbx)$/.test(name)) return 'unsupported';
  return 'text';
};

const rows = sampleFiles
  .map((entry) => {
    const kind = entry.dir ? 'folder' : kindOf(entry.name);
    return (
      '<div class="row"><span class="icon">' + svg(kind, 14) + '</span>' +
      '<span class="name">' + entry.name + (entry.dir ? '/' : '') + '</span>' +
      '<span class="hint">' + labels[kind] + '</span></div>'
    );
  })
  .join('');

const gallery = Object.keys(labels)
  .map(
    (kind) =>
      '<figure class="cell"><div class="big">' + svg(kind, 40) + '</div>' +
      '<figcaption>' + kind + '<br><em>' + labels[kind] + '</em></figcaption></figure>',
  )
  .join('');

const html = `<!-- 生成的图标快照：改了 ICON_SHAPES 之后运行 npm run icons:preview 重新生成 -->
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>文件列表类型图标预览</title>
<style>
  :root{ --bg:#ffffff; --fg:#1b1b1f; --muted:#6b6b76; --hover:#f2f3f5; --line:#e6e7eb; }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#16171a; --fg:#e8e9ee; --muted:#9a9ba6; --hover:#23252a; --line:#2b2d33; }
  }
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
    font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  h1{font-size:16px;margin:0 0 4px}
  p.sub{margin:0 0 20px;color:var(--muted);font-size:12px}
  .panel{max-width:440px;border:1px solid var(--line);border-radius:10px;padding:6px 4px}
  .row{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:7px}
  .row:hover{background:var(--hover)}
  .row .icon{flex:0 0 auto;width:14px;height:14px;color:var(--muted);opacity:.9;display:flex}
  .row:hover .icon{color:var(--fg);opacity:1}
  .row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .hint{margin-left:auto;color:var(--muted);font-size:11px;opacity:.7}
  h2{font-size:13px;margin:28px 0 10px;color:var(--muted);font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
  .cell{margin:0;border:1px solid var(--line);border-radius:10px;padding:12px 8px;text-align:center}
  .cell .big{color:var(--fg);display:flex;justify-content:center;margin-bottom:6px}
  .cell figcaption{font-size:11px;color:var(--muted);line-height:1.5}
  .cell em{font-style:normal;opacity:.75}
</style></head>
<body>
  <h1>文件列表类型图标</h1>
  <p class="sub">上方为面板里的真实尺寸（14px，行高 28px）；下方放大到 40px，便于确认形状是否可区分。</p>
  <div class="panel">${rows}</div>
  <h2>放大对照（40px）</h2>
  <div class="grid">${gallery}</div>
</body></html>`;

const out = path.join(root, 'docs', 'internal', 'icons-preview.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('已生成 ' + path.relative(root, out) + '（' + fs.statSync(out).size + ' 字节，' + Object.keys(labels).length + ' 个图标）');
