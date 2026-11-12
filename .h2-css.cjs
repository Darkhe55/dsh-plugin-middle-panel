const fs = require('fs');
let src = fs.readFileSync('src/client.js', 'utf8').replace(/\r\n/g, '\n');

// 1) 面板根成为定位上下文，菜单改为 absolute
const videoCss = "      '.dshcv-video{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px}',";
if (!src.includes(videoCss)) throw new Error('video 样式锚点缺失');
src = src.replace(
  videoCss,
  "      '.dshcv-video{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;position:relative}',",
);

const menuCss = "      '.dshcv-videomenu{position:fixed;z-index:60;";
if (!src.includes(menuCss)) throw new Error('菜单样式锚点缺失');
src = src.replace(menuCss, "      '.dshcv-videomenu{position:absolute;z-index:60;");

// 2) 悬停虚线
const headCss = "      '.dshcv-trackhead{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:var(--dsw-alias-brand-primary)}',";
if (!src.includes(headCss)) throw new Error('trackhead 样式锚点缺失');
src = src.replace(
  headCss,
  headCss +
    "\n      '.dshcv-hoverhead{position:absolute;top:-2px;bottom:-2px;width:0;margin-left:-0.5px;border-left:1px dashed rgba(79,140,255,.85);pointer-events:none}',",
);

fs.writeFileSync('src/client.js', src);
console.log('样式已更新');
