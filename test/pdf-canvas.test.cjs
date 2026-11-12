// 自带 PDF 渲染：pdf.js 从插件树按需加载，区域坐标以画布（真实页面）为准。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync('src/client.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};
const has = (text) => src.includes(text);

// —— vendor 资源 ——
const vendor = path.join(__dirname, '..', 'vendor', 'pdfjs');
check(fs.existsSync(path.join(vendor, 'pdf.min.mjs')), 'pdf.min.mjs 已随插件分发');
check(fs.existsSync(path.join(vendor, 'pdf.worker.min.mjs')), 'worker 存在');
check(fs.existsSync(path.join(vendor, 'cmaps')) && fs.readdirSync(path.join(vendor, 'cmaps')).length > 100, 'cjk cmaps 齐全');
check(fs.existsSync(path.join(vendor, 'standard_fonts')), '标准字体存在');
check(fs.existsSync(path.join(vendor, 'LICENSE')), '附带许可证');

const size = (name) => fs.statSync(path.join(vendor, name)).size / 1024 / 1024;
check(size('pdf.min.mjs') < 2, '主模块体积可控', size('pdf.min.mjs').toFixed(2) + 'MB');

// —— 宿主路由 ——
const route = fs.readFileSync(path.join(__dirname, '..', 'vendor-route.js'), 'utf8');
check(route.includes('for (const relative of listVendorFiles()) add(PREFIX + relative, relative)'), '逐文件注册精确路由');
check(route.includes('path.relative(VENDOR_ROOT, absolute)'), '限制在插件目录内');
check(route.includes("relative.startsWith('..')"), '拒绝目录穿越');
check(route.includes('immutable'), '允许强缓存');
check(route.includes("'.mjs': 'text/javascript"), '模块 MIME 正确');
const host = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
check(host.includes('registerVendorRoute(ctx, corsFor)'), '宿主已挂载路由');

// —— 客户端加载器 ——
check(has('VENDOR_PREFIX = ') && has('VENDOR_EXACT = '), '支持前缀与精确两种路由');
check(has("attempt('prefix').catch(() => attempt('exact'))"), '前缀失败自动回退精确路由');
check(has("vendorUrl('pdf.worker.min.mjs', shape)"), 'worker 跟随同一路由形态');
check(has('let pdfjsPromise = null;'), '只加载一次');

// —— 渲染 ——
const start = src.indexOf('function PdfCanvasDoc(props) {');
const end = src.indexOf('function PdfDoc(props) {');
const body = src.slice(start, end);
check(body.includes('h(\'canvas\', { ref: canvasRef'), '页面渲染到 canvas');
check(body.includes('const ratio = Math.min(3, window.devicePixelRatio || 1);'), '按 DPR 提清晰度');
check(body.includes('pdfPage.render({ canvasContext: context, viewport })'), '调用 pdf.js 渲染');
check(body.includes('cMapUrl:'), '带上 cmaps');
check(body.includes('standardFontDataUrl:'), '带上标准字体');

// —— 坐标：以画布为准，与页面一致 ——
check(body.includes('const rect = canvas.getBoundingClientRect();'), '比例取自画布');
check(body.includes("left: hoverRegion[0] * 100 + '%',"), '高亮按页面百分比');
check(body.includes("kind: 'region',"), '生成区域标注');
check(body.includes('norm: true,'), '坐标按页面归一化');
check(body.includes('page,'), '记录页码');

// —— 兜底 ——
check(has('function PdfDoc(props) {') && has('function EmbeddedPdfDoc(props) {'), '保留内嵌阅读器');
check(has('h(EmbeddedPdfDoc, props)'), 'pdf.js 失败时回退');
check(has("'已回退到系统阅读器：' + fallback"), '回退时说明原因');

// —— 清理稳健性（曾因 loaded.destroy is not a function 使整个画布被隔离） ——
check(!has('loaded.destroy()'), '不再盲调 destroy');
check(has('const loaded = await task.promise;'), '保留 loading task 句柄');
check(has("if (task && typeof task.destroy === 'function')") || has('if (task && typeof task.destroy === "function")'), 'destroy 前检查能力');
check(has('/* cleanup is best effort */'), '清理异常不外泄');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
