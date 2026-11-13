#!/usr/bin/env node
/**
 * Smoke test for the write route against a *running* instance.
 *
 *   node scripts/smoke-save.cjs [--port 6688] [--session <id>] [--root <dir>]
 *
 * Checks the behaviour that only shows up at runtime: the envelope cap aborts a
 * body mid-read, the file cap counts UTF-8 bytes, the boundary value is accepted,
 * conflicts still answer 409, and a junction inside the workspace cannot be used
 * to write outside it. Everything it creates is removed again.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = Number(flag('port', 6688));
const stamp = Date.now().toString(36);
const WORK_NAME = 'dsh-smoke-' + stamp + '.txt';
const LINK_NAME = 'dsh-smoke-link-' + stamp;

let failures = 0;

/** Paths to remove on any exit, including an unexpected throw. */
const cleanupPaths = [];
const removeAll = () => {
  for (const item of cleanupPaths.splice(0)) {
    try {
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) fs.unlinkSync(item);
      else fs.rmSync(item, { force: true });
    } catch {
      /* already gone */
    }
  }
};
process.on('exit', removeAll);
process.on('SIGINT', () => {
  removeAll();
  process.exit(130);
});
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** The session folder name encodes its cwd: --C-Users-me-proj-- with ~XXXX~ escapes. */
const decodeSessionDir = (name) => {
  const body = name.replace(/^--/, '').replace(/--$/, '');
  const text = body.replace(/~([0-9A-Fa-f]{4})~/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  // A Windows path loses its colon in the encoding: "C-Users-..." is C:\Users\...
  const drive = /^([A-Za-z])-(.*)$/.exec(text);
  const windows = drive ? drive[1] + ':\\' + drive[2].replace(/-/g, '\\') : text.replace(/-/g, '\\');
  const posix = '/' + text.replace(/-/g, '/');
  if (fs.existsSync(windows)) return windows;
  if (fs.existsSync(posix)) return posix;
  return windows;
};

const candidates = () => {
  const base = path.join(os.homedir(), '.dsh', 'sessions');
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const workspaceDir of fs.readdirSync(base)) {
    const workspacePath = path.join(base, workspaceDir);
    let entries = [];
    try {
      entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
      const full = path.join(workspacePath, entry.name);
      // The id the route expects is the directory name, prefix included; the
      // session log's own mtime is what identifies the live session.
      let mtime = 0;
      for (const file of fs.readdirSync(full)) {
        try {
          mtime = Math.max(mtime, fs.statSync(path.join(full, file)).mtimeMs);
        } catch {
          /* skip */
        }
      }
      out.push({ id: entry.name, root: decodeSessionDir(workspaceDir), mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
};

const post = (payload) =>
  new Promise((resolve) => {
    const body = Buffer.from(payload, 'utf8');
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/dsh-canvas/save',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:' + port,
          'content-length': body.length,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, text, json });
        });
      },
    );
    request.on('error', (error) => resolve({ status: 0, error: error.code || error.message }));
    request.end(body);
  });

const save = (sessionId, filePath, content, extra) =>
  post(
    JSON.stringify({
      sessionId,
      path: filePath,
      content,
      ...(extra || {}),
    }),
  );

const main = async () => {
  const all = candidates();
  const explicit = flag('session', null);
  const picked = explicit
    ? all.filter((item) => item.id === explicit).concat(
        flag('root', null) ? [{ id: explicit, root: flag('root', null) }] : [],
      )
    : all;

  if (!picked.length) {
    console.log('找不到任何会话目录，请用 --session <id> --root <dir> 指定');
    process.exit(1);
  }

  let sessionId = null;
  let root = null;
  let target0 = null;
  for (const candidate of picked) {
    if (!fs.existsSync(candidate.root)) continue;
    const attempted = path.join(candidate.root, WORK_NAME);
    cleanupPaths.push(attempted);
    const probe = await save(candidate.id, attempted, 'probe');
    if (probe.status === 200) {
      sessionId = candidate.id;
      // Trust the server's own resolved path when it reports one.
      const written = probe.json && probe.json.path ? probe.json.path : attempted;
      root = path.dirname(written);
      target0 = written;
      break;
    }
    if (probe.status !== 403) {
      console.log('探测失败：' + probe.status + ' ' + (probe.text || probe.error || ''));
      break;
    }
  }
  if (!sessionId) {
    console.log('没有可用的会话：服务端不认识这些 sessionId。');
    console.log('请在面板里打开一次文件（触发一次保存）后重试，或用 --session <id> 指定。');
    process.exit(1);
  }
  console.log('会话 ' + sessionId.slice(0, 8) + '… 工作区 ' + root);
  const target = target0 || path.join(root, WORK_NAME);
  console.log('目标文件 ' + target);

  cleanupPaths.push(target);

  try {
    // 1) 正常保存
    const ok = await save(sessionId, target, 'smoke 你好\n');
    check(ok.status === 200, '正常文本保存返回 200', ok.status + ' ' + (ok.text || ok.error || ''));
    check(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'smoke 你好\n', '磁盘内容与提交一致');
    if (ok.json) check(ok.json.bytes === Buffer.byteLength('smoke 你好\n', 'utf8'), '响应里的字节数是 UTF-8 字节');

    // 2) 边界值：正好 4 MiB 应当被接受
    const exact = 'a'.repeat(4 * 1024 * 1024);
    const edge = await save(sessionId, target, exact, { force: true });
    check(edge.status === 200, '正好 4 MiB 的文件可以保存', edge.status + ' ' + (edge.text || edge.error || ''));

    // 3) 文本超限：按 UTF-8 字节判断
    const tooBig = 'a'.repeat(4 * 1024 * 1024 + 1);
    const big = await save(sessionId, target, tooBig, { force: true });
    check(big.status === 413, '超过 4 MiB 的文本返回 413', big.status + ' ' + (big.text || big.error || ''));

    // 中文：字符数远小于字节数，不能因为“看起来不大”而放行
    const cjk = '中'.repeat(1_500_000); // 4.5 MB UTF-8
    const cjkRes = await save(sessionId, target, cjk, { force: true });
    check(cjkRes.status === 413, '150 万中文字符（4.5 MB）返回 413', cjkRes.status + ' ' + (cjkRes.text || cjkRes.error || ''));

    // 4) 请求体超限：必须中断连接，而不是读完再回 JSON
    const huge = await save(sessionId, target, 'a'.repeat(6 * 1024 * 1024 + 1024), { force: true });
    check(huge.status === 0, '超过 6 MiB 的请求体在读入过程中中断', String(huge.status) + ' ' + (huge.text || huge.error || ''));

    // 5) 冲突检测仍在
    const stale = await save(sessionId, target, 'x', { expectedMtime: 1, expectedSize: 1 });
    check(stale.status === 409, '过期的 expectedMtime 返回 409', stale.status + ' ' + (stale.text || stale.error || ''));

    // 6) 工作区内的 junction 指向外部：必须拒绝，且外部不留文件
    if (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-smoke-out-'));
      const link = path.join(root, LINK_NAME);
      let linked = true;
      try {
        await fsp.symlink(outside, link, 'junction');
        cleanupPaths.push(link);
      } catch (error) {
        linked = false;
        console.log('SKIP junction 创建失败：' + (error && error.code));
      }
      if (linked) {
        const escape = await save(sessionId, path.join(link, 'escape.txt'), 'should not exist');
        check(escape.status === 403, '指向工作区外部的 junction 被拒绝', escape.status + ' ' + (escape.text || escape.error || ''));
        check(!fs.existsSync(path.join(outside, 'escape.txt')), '外部目录没有产生文件');
      }
      await fsp.rm(outside, { recursive: true, force: true });
    }
  } finally {
    removeAll();
  }

  console.log(failures ? '\n失败 ' + failures + ' 项' : '\n全部通过');
  process.exit(failures ? 1 : 0);
};

main().catch((error) => {
  console.error('冒烟脚本异常：', error && error.message);
  process.exit(1);
});
