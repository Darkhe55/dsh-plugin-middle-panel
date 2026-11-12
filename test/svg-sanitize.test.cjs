const { readSource } = require('./_source.cjs');
// The SVG sanitizer is the only place where workspace content is injected into this
// page's origin, so its blocklist is a security contract, not an implementation detail.
const fs = require('fs');

const src = readSource();
const start = src.indexOf('const sanitizeSvg = (text) => {');
const end = src.indexOf('function SvgDoc(props) {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 必须清除的元素
const dropped = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'handler', 'audio', 'video'];
const dropLine = body.match(/const dropTags = \[([^\]]+)\]/);
check(Boolean(dropLine), '存在元素黑名单');
const list = dropLine ? dropLine[1].toLowerCase() : '';
for (const tag of dropped) {
  check(list.includes(tag.toLowerCase()), '清除 <' + tag + '>');
}

// 2) on* 与 javascript: 必须处理
check(/name\.startsWith\('on'\)/.test(body), '移除 on* 事件属性');
check(/javascript/.test(body), '拒绝 javascript: 伪协议');
check(/vbscript/.test(body), '拒绝 vbscript: 伪协议');
check(/data:text/.test(body), '拒绝 data:text/html');

// 3) 外部链接只能保留 # 与 data:image
check(/startsWith\('#\'\)/.test(body), '允许内部锚点 #fragment');
check(/startsWith\('data:image\/'\)/.test(body), '允许 data:image 内联图');
check(/allowedHref/.test(body), 'href/src 走白名单');

// 4) SMIL 不能在清洗后改回危险属性
check(/attributeName/.test(body), '检查 SMIL 的 attributeName');
check(/child\.remove\(\)/.test(body), '不安全的动画节点被移除');

// 5) 样式表不能 @import 远程资源
check(/@import/.test(body), '移除 @import 样式');

// 6) 沙箱化：清洗只是第二道防线，真正的边界是 iframe
const svgStart = src.indexOf('function SvgDoc(props) {');
const svgEnd = src.indexOf('// Long parses yield to the event loop', svgStart);
const svgDoc = src.slice(svgStart, svgEnd > svgStart ? svgEnd : svgStart + 12000);
check(!/dangerouslySetInnerHTML/.test(src), '全文件不再内联注入 HTML');
check(/sandbox: 'allow-scripts'/.test(svgDoc), 'SVG 预览运行在沙箱 iframe 中');
check(!/allow-same-origin/.test(svgDoc), '沙箱不放行 same-origin，拿不到本页 localStorage');
check(svgDoc.includes('.source !== frame.contentWindow'), '只接受自己 iframe 的消息');
check(/kind: 'layer'/.test(svgDoc), '点选仍然生成图层标注');
check(/injectPicker/.test(svgDoc), '沙箱内复用同一个选取脚本');

// 7) 必须有解析失败保护
check(/parsererror/.test(body), '解析失败时返回 null 而不是注入');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}



