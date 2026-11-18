// 设置路由的来源校验与保存路由一致：桌面不透明来源放行，其它端口的 loopback 拒绝。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 从 index.js 抽出 corsFor 单独执行（它只用 header 读取，不依赖 ctx）
const start = src.indexOf('const corsFor = (request, hostHeader) => {');
const end = src.indexOf('export function apply(ctx)');
if (start < 0 || end < 0) {
  console.log('无法定位 corsFor');
  process.exit(1);
}
const corsFor = new Function(src.slice(start, end) + '\nreturn corsFor;')();

const makeRequest = (headers) => ({ headers: { get: (name) => headers[name.toLowerCase()] || '' } });

// 1) 桌面端不透明来源
{
  const cors = corsFor(makeRequest({ origin: 'null' }), '127.0.0.1:9935');
  check(Boolean(cors), '桌面端不透明来源放行');
  check(cors['access-control-allow-origin'] === 'null', '回显 null 而不是通配符', cors['access-control-allow-origin']);
}

// 2) 同端口 loopback 放行
{
  const cors = corsFor(makeRequest({ origin: 'http://127.0.0.1:9935', host: '127.0.0.1:9935' }), '127.0.0.1:9935');
  check(Boolean(cors), '同端口 loopback 放行');
}

// 3) 其它端口的 loopback 拒绝
{
  const cors = corsFor(makeRequest({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:9935' }), '127.0.0.1:9935');
  check(!cors, '其它端口的本机页面被拒绝');
}

// 4) 外部来源拒绝
{
  const cors = corsFor(makeRequest({ origin: 'https://evil.example', host: '127.0.0.1:9935' }), '127.0.0.1:9935');
  check(!cors, '外部来源被拒绝');
}

// 5) 设置路由确实挂在 /dsh-canvas/prefs，且只接受布尔值
{
  check(src.includes("path: '/dsh-canvas/prefs'"), '路由路径正确');
  check(src.includes("typeof body.autoOpenNew !== 'boolean'"), '只接受布尔值');
  check(src.includes("if (method === 'GET') return reply(200, { ok: true, autoOpenNew: viewPrefs.autoOpenNew })"), '提供 GET 读取当前值');
  check(src.includes('registerPromptSection()'), '开关变化时重注册提示词');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
