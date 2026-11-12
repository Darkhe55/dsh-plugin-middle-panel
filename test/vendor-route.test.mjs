// 端到端验证 vendor 路由：真的能按 URL 取到 pdf.js 与 cmaps，并且挡得住穿越。
import { registerVendorRoute } from '../vendor-route.js';

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

let handler = null;
const registered = [];
const ctx = {
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      registered.push(route.path);
      if (String(route.path).includes('/dsh-canvas/vendor')) handler = route.handler;
      return () => {};
    },
  },
};
const corsFor = () => ({ 'access-control-allow-origin': '*', vary: 'origin' });
registerVendorRoute(ctx, corsFor);
check(typeof handler === 'function', '路由已注册');
check(registered.includes('/dsh-canvas/vendor/pdfjs/*'), '注册了通配路由', registered.join(', '));
check(registered.includes('/dsh-canvas/vendor'), '注册了精确兜底路由', registered.join(', '));

const call = (url, headers = {}) =>
  new Promise((resolve) => {
    const chunks = [];
    const response = {
      writeHead: (status, meta) => {
        response.status = status;
        response.headers = meta || {};
      },
      end: (body) => {
        if (body && body.length) chunks.push(body);
        resolve({ status: response.status || 200, headers: response.headers || {}, body: chunks[0] });
      },
    };
    const request = {
      method: 'GET',
      url,
      headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    };
    handler(request, response).catch((error) => resolve({ status: 500, error: String(error) }));
  });

const allowed = { origin: 'http://127.0.0.1:7367', host: '127.0.0.1:7367' };

const main = await call('/dsh-canvas/vendor/pdfjs/pdf.min.mjs', allowed);
check(main.status === 200, '主模块 200', String(main.status));
check(String(main.headers['content-type']).includes('text/javascript'), 'MIME 为 javascript', main.headers['content-type']);
check(main.body && main.body.length > 400000, '返回真实字节', String(main.body && main.body.length));
check(String(main.headers['cache-control']).includes('immutable'), '带强缓存');

const worker = await call('/dsh-canvas/vendor/pdfjs/pdf.worker.min.mjs', allowed);
check(worker.status === 200 && worker.body.length > 1000000, 'worker 可取', String(worker.body && worker.body.length));

const cmap = await call('/dsh-canvas/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', allowed);
check(cmap.status === 200, '中文 cmap 可取', String(cmap.status));

const font = await call('/dsh-canvas/vendor/pdfjs/standard_fonts/FoxitFixed.pfb', allowed);
check(font.status === 200, '标准字体可取', String(font.status));

const missing = await call('/dsh-canvas/vendor/pdfjs/nope.js', allowed);
check(missing.status === 404, '缺失文件 404', String(missing.status));

const escape1 = await call('/dsh-canvas/vendor/pdfjs/../../index.js', allowed);
check(escape1.status !== 200, '拒绝向上穿越', String(escape1.status));

const escape2 = await call('/dsh-canvas/vendor/pdfjs/%2e%2e%2f%2e%2e%2findex.js', allowed);
check(escape2.status !== 200, '拒绝编码穿越', String(escape2.status));

const foreign = await call('/dsh-canvas/vendor/pdfjs/pdf.min.mjs', { origin: 'http://evil.example.com', host: '127.0.0.1:7367' });
check(foreign.status === 403 || foreign.status === 200, '跨源按 CORS 判定（此处只确认不崩）', String(foreign.status));

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
