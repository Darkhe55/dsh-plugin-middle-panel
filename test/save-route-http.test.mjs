// 真实 HTTP 回归测试：超限请求体必须让客户端拿到 413，而不是连接被重置。
//
// 之前一超限就 request.destroy()，即使外层写了 413，客户端收到的也是 ECONNRESET。
// 这里用真实 http.createServer + http.request（含 chunked 分块上传）验证行为，
// 并且复用生产代码里的 readCappedBody / replyBodyTooLarge，避免测试与实现漂移。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = await import(pathToFileURL(path.join(here, '..', 'save-guard.js')).href);
const { readCappedBody, replyBodyTooLarge, BodyTooLarge, MAX_BODY_BYTES } = guard;

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 服务端完全照保存路由的写法：读体 → 捕获 BodyTooLarge → replyBodyTooLarge。 */
const serverState = { retained: 0, seen: 0 };

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const reply = (status, body, extra) => {
        const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {});
        response.writeHead(status, headers);
        response.end(JSON.stringify(body));
      };
      try {
        const text = await readCappedBody(request, true);
        serverState.retained = Math.max(serverState.retained, text.length);
        reply(200, { ok: true, retained: text.length });
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          replyBodyTooLarge({ reply, request, response, nodeStyle: true });
          return;
        }
        reply(400, { error: String(error && error.message) });
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

/** 发一个带 content-length 的完整请求体。 */
const sendWhole = (port, bytes) =>
  new Promise((resolve) => {
    const body = Buffer.alloc(bytes, 0x61);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dsh-canvas/save',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', (error) => resolve({ status: 0, error: error.code || error.message }));
    request.end(body);
  });

/** 分块上传：没有 content-length，逐块写入，中途越界。 */
const sendChunked = (port, chunkSize, chunkCount) =>
  new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dsh-canvas/save',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', (error) => resolve({ status: 0, error: error.code || error.message }));

    const block = Buffer.alloc(chunkSize, 0x62);
    let written = 0;
    const pump = () => {
      if (written >= chunkSize * chunkCount) {
        request.end();
        return;
      }
      written += chunkSize;
      request.write(block, (error) => {
        if (error) return; // 服务端提前收尾时写入可能失败，结果由响应决定
        setImmediate(pump);
      });
    };
    pump();
  });

const server = await startServer();
const { port } = server.address();

try {
  // 1) 小于上限：完整读取
  const small = await sendWhole(port, 1024 * 64);
  check(small.status === 200, '小于上限：客户端收到 200', String(small.status));
  check(small.body.includes('"retained":65536'), '小于上限：body 被完整读取', small.body);

  // 2) 正好等于上限：正常通过
  const exact = await sendWhole(port, MAX_BODY_BYTES);
  check(exact.status === 200, '正好等于上限：正常通过', exact.status + ' ' + (exact.error || ''));
  check(exact.body.includes('"retained":' + MAX_BODY_BYTES), '正好等于上限：全部读取');

  // 3) 超过上限：413 + 明确错误，且没有 ECONNRESET
  const over = await sendWhole(port, MAX_BODY_BYTES + 2 * 1024 * 1024);
  check(over.status === 413, '超过上限：客户端收到 413（不是 ECONNRESET）', 'status=' + over.status + ' ' + (over.error || ''));
  check(
    typeof over.body === 'string' && over.body.includes('request body is too large'),
    '超过上限：响应体说明原因',
    over.body || over.error,
  );
  check(
    serverState.retained <= MAX_BODY_BYTES,
    '服务端没有保留超限的 body',
    '最多保留 ' + serverState.retained + ' 字节',
  );

  // 4) 分块上传越界：仍然 413
  const chunked = await sendChunked(port, 512 * 1024, 40); // 20 MiB，无 content-length
  check(chunked.status === 413, '分块上传越界：收到 413', 'status=' + chunked.status + ' ' + (chunked.error || ''));

  // 5) 超限之后的新连接仍能正常工作（没有污染、没有未处理异常）
  const after = await sendWhole(port, 4096);
  check(after.status === 200, '超限之后的新连接仍正常', String(after.status) + ' ' + (after.error || ''));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

process.on('unhandledRejection', (reason) => {
  console.log('FAIL 出现未处理的 rejection → ' + reason);
  process.exit(1);
});

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
