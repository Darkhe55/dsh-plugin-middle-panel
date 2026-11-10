// Live probe for the save/conflict path.
//
//   node test/live-probe.cjs
//
// Finds the running DSH server and this workspace's newest session, then checks:
//   1. the metadata route answers with a real mtime (it used to 404),
//   2. a save with a stale version is refused with 409,
//   3. a save with the current version succeeds.
// It works on a throwaway file and removes it again.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const workspace = process.cwd().replace(/[\\/]plugins[\\/]canvas-panel$/, '');
const probeName = '.canvas-live-probe.txt';
const probePath = path.join(workspace, probeName);

const sessionRoot = path.join(os.homedir(), '.dsh', 'sessions');
const sessions = [];
const collect = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.startsWith('session') && entry.name.includes('.')) {
      sessions.push({ id: entry.name.split('.')[0], mtime: fs.statSync(full).mtimeMs, file: full });
    }
  }
};
collect(sessionRoot);

const workspaceKey = workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const mine = sessions
  .filter((entry) => entry.file.toLowerCase().includes(workspaceKey.slice(0, 24)))
  .sort((a, b) => b.mtime - a.mtime);
const sessionId = (mine[0] || sessions.sort((a, b) => b.mtime - a.mtime)[0] || {}).id;

const tryPort = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(120);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });

(async () => {
  if (!sessionId) {
    console.log('未找到会话记录');
    process.exit(1);
  }
  console.log('工作区:', workspace);
  console.log('会话:', sessionId);

  let base = '';
  for (let port = 9000; port <= 13000; port += 1) {
    if (!(await tryPort(port))) continue;
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/dsh-canvas/file?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(probeName));
      const text = await response.text();
      if (text.includes('unknown session') || text.includes('cannot stat') || text.includes('"size"')) {
        base = 'http://127.0.0.1:' + port;
        break;
      }
    } catch {
      /* not our server */
    }
  }
  if (!base) {
    console.log('未找到画布路由所在端口');
    process.exit(1);
  }
  console.log('服务:', base);

  fs.writeFileSync(probePath, 'A\nB\nC\n');
  const stat = fs.statSync(probePath);

  const meta = await fetch(base + '/dsh-canvas/file?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(probeName));
  const metaText = await meta.text();
  console.log('\n[1] 元数据路由 →', meta.status, metaText.slice(0, 160));

  const staleSave = await fetch(base + '/dsh-canvas/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      path: probeName,
      content: 'stale\n',
      expectedMtime: 1,
      expectedSize: 1,
    }),
  });
  console.log('[2] 过期版本保存 →', staleSave.status, (await staleSave.text()).slice(0, 160), staleSave.status === 409 ? '（正确：拒绝覆盖）' : '（异常：没有被拦下）');

  const fresh = fs.statSync(probePath);
  const goodSave = await fetch(base + '/dsh-canvas/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      path: probeName,
      content: 'fresh\n',
      expectedMtime: fresh.mtimeMs,
      expectedSize: fresh.size,
    }),
  });
  console.log('[3] 当前版本保存 →', goodSave.status, (await goodSave.text()).slice(0, 160));
  console.log('    写入前 mtime:', stat.mtimeMs);

  fs.rmSync(probePath, { force: true });
})();
