// 视频与 PDF 的资源释放：静态断言创建/释放配对，避免再次出现"只创建不释放"。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const block = (from, to, label) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) {
    console.log('FAIL 找不到 ' + label + ' 的切片锚点');
    failures += 1;
    return '';
  }
  return src.slice(start, end);
};

// ---- 视频元素释放 ----
const video = block("const native = VIDEO_NATIVE.includes(videoExtOf(doc.path));", 'const seek = store.seek;', '视频加载 effect');
check(/revokeObjectUrl\(objectUrl\)/.test(video), '视频 Object URL 在卸载时释放');
check(/node\.pause\(\)/.test(video), '卸载时暂停播放');
check(/removeAttribute\('src'\)/.test(video), '卸载时清空 src');
check(/node\.srcObject = null/.test(video), '卸载时清空 srcObject');
check(/node\.load\(\)/.test(video), '卸载时调用 load() 释放媒体管线');
check(/catch \(error\)/.test(video), '清理失败不抛错');

// ---- PDF 页面渲染任务 ----
const page = block('function PdfPage(props)', 'function PdfThumb(props)', 'PDF 页面组件');
check(/renderTask = page\.render\(/.test(page), '记录 renderTask');
check(/renderTask\.cancel\(\)/.test(page), '卸载/重渲染时取消 renderTask');
check(/pageRef\.cleanup\(\)/.test(page), '释放页面缓存');
check(/Math\.min\(2, window\.devicePixelRatio/.test(page), '页面渲染 DPR 上限 2');

const thumb = block('function PdfThumb(props)', '// ----------------', 'PDF 缩略图组件');
check(/renderTask\.cancel\(\)/.test(thumb), '缩略图也取消未完成的 renderTask');
check(/pageRef\.cleanup\(\)/.test(thumb), '缩略图释放页面缓存');

// ---- PDF 文档销毁 ----
const doc = block('const loaded = await task.promise;', 'const first = await loaded.getPage(1);', 'PDF 文档加载');
check(/docRef\.current = loaded/.test(doc), '持有文档引用');
const viewer = block('function PdfCanvasDoc(props)', 'function EmbeddedPdfDoc(props)', 'PDF 主组件');
check(/task\.destroy\(\)/.test(viewer) || /docRef\.current\.destroy/.test(viewer), '切换/卸载时销毁文档');

// ---- HTML 预览 ----
const html = block('function HtmlDoc(props)', 'function FitStage', 'HTML 预览组件');
check(/removeEventListener\('message', onMessage\)/.test(html), 'message 监听在卸载时移除');
check(/frame\.src = 'about:blank'/.test(html), '关闭时卸载预览文档');
check(/post\('pause'\)/.test(html), '关闭前暂停预览动画');
check(/revokeObjectUrl\(objectUrl\)/.test(html), 'HTML Object URL 在卸载时释放');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
