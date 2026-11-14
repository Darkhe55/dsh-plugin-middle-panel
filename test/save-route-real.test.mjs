// 真实路由 + 真实 socket 的回归测试。
//
// 直接从插件里取出保存路由的 handler（ctx.webServer.register 注册的那个），
// 挂到真实 http.createServer 上，再用真实 http.request 发超限请求体。这样测试
// 覆盖的是生产代码路径，而不是测试里另写一份等价逻辑。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = await import(pathToFileURL(path.join(here, '..', 'index.js')).href);
const guard = await import(pathToFileURL(path.join(here, '..', 'save-guard.js')).href);
const { MAX_BODY_BYTES } = guard;

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-route-'));
const SESSION = 'session-v4-http-regression';
const session = { header: { id: SESSION, cwd: workspace } };

// 只提供保存路由实际用到的东西；其它注册只收集、不动作。
const routes = [];
const registeredTools = [];
const ctx = {
  effect: (fn) => {
    try {
      fn();
    } catch {
      /* 注册失败与本次测试无关 */
    }
  },
  get: (name) => (name === 'sessions' ? { get: (id) => (id === SESSION ? session : undefined), values: () => [session] } : undefined),
  sessions: { get: (id) => (id === SESSION ? session : undefined), values: () => [session] },
  tools: { register: (tool) => registeredTools.push(tool) },
  systemPrompt: { section: () => {} },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  },
  fs: {
    resolve: async (target) => target,
    writeText: async (target, content) => {
      await fs.promises.writeFile(target, content, 'utf8');
    },
  },
  workingDirectory: { get: () => workspace },
};

plugin.apply(ctx);

const saveRoute = routes.find((route) => route && route.path === '/dsh-canvas/save');
check(Boolean(saveRoute), '取到真实的保存路由');

const server = http.createServer((request, response) => saveRoute.handler(request, response, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = 'http://127.0.0.1:' + port;

const call = (payload, options = {}) =>
  new Promise((resolve) => {
    const body = Buffer.from(payload, 'utf8');
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dsh-canvas/save',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(options.chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': body.length }),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let json = null;
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, headers: response.headers, json, text });
        });
      },
    );
    request.on('error', (error) => resolve({ status: 0, error: error.code || error.message }));
    if (options.chunked) {
      // 分块发送：每块 1 MiB，直到超过上限
      const unit = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const total = options.bytes || body.length;
      const pump = () => {
        if (sent >= total) {
          request.end();
          return;
        }
        sent += unit.length;
        request.write(unit, () => setImmediate(pump));
      };
      pump();
      return;
    }
    request.end(body);
  });

try {
  // 正常保存：确认路由本体没被改坏
  const okPayload = JSON.stringify({ sessionId: SESSION, path: path.join(workspace, 'note.txt'), content: 'hello 世界' });
  const normal = await call(okPayload);
  check(normal.status === 200, '正常保存返回 200', normal.status + ' ' + (normal.text || normal.error || ''));
  check(normal.json && normal.json.ok === true, '正常保存响应 ok');
  check(fs.existsSync(path.join(workspace, 'note.txt')), '正常保存真的落盘');
  check(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8') === 'hello 世界', '落盘内容正确');

  // 超限：客户端必须拿到 413
  const bigPayload = JSON.stringify({ sessionId: SESSION, path: path.join(workspace, 'big.txt'), content: 'a'.repeat(MAX_BODY_BYTES + 1024 * 1024) });
  const over = await call(bigPayload);
  check(over.status === 413, '超限请求体：客户端收到 413（不是 ECONNRESET）', 'status=' + over.status + ' ' + (over.text || over.error || ''));
  check(
    over.json && over.json.error === 'request body is too large',
    '超限响应带明确错误',
    over.text || over.error,
  );
  check(
    String(over.headers && over.headers.connection).toLowerCase() === 'close',
    '超限响应声明 Connection: close',
    over.headers && over.headers.connection,
  );
  check(!fs.existsSync(path.join(workspace, 'big.txt')), '超限请求没有写出文件');

  // 分块上传超限
  const chunked = await call('', { chunked: true, bytes: MAX_BODY_BYTES + 2 * 1024 * 1024 });
  check(chunked.status === 413, '分块上传超限：收到 413', 'status=' + chunked.status + ' ' + (chunked.text || chunked.error || ''));

  // 超限之后仍然能正常保存
  const again = await call(okPayload);
  check(again.status === 200, '超限之后仍能正常保存', again.status + ' ' + (again.text || again.error || ''));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.promises.rm(workspace, { recursive: true, force: true });
}

process.on('unhandledRejection', (reason) => {
  console.log('FAIL 出现未处理的 rejection → ' + reason);
  process.exit(1);
});

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
