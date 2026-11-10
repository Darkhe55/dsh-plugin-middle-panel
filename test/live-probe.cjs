// Live probe for the save/conflict path.
//
//   node test/live-probe.cjs
//
// Finds the running DSH server (its port changes every launch), the newest session
// in this workspace, then checks:
//   1. the metadata route answers with a real mtime,
//   2. a save with a stale version is refused with 409,
//   3. a save with the current version succeeds.
// It only touches a throwaway file and removes it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const workspace = process.cwd().replace(/[\\/]plugins[\\/]canvas-panel$/, '');
const probeName = '.canvas-live-probe.txt';
const probePath = path.join(workspace, probeName);

// Session ids are the `session-…` directory names; the files inside are not.
const findSession = () => {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const workspaceKey = workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let best = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^session-/.test(entry.name) && dir.toLowerCase().includes(workspaceKey)) {
          let newest = 0;
          for (const file of fs.readdirSync(full)) {
            const stat = fs.statSync(path.join(full, file));
            if (stat.mtimeMs > newest) newest = stat.mtimeMs;
          }
          if (!best || newest > best.mtime) best = { id: entry.name, mtime: newest };
        }
        walk(full);
      }
    }
  };
  walk(root);
  return best;
};

// Every loopback port in LISTENING state, newest DSH instance included.
const listeningPorts = () => {
  const ports = new Set();
  try {
    const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    for (const line of output.split('\n')) {
      const match = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING/i.exec(line);
      if (match) ports.add(Number(match[1]));
    }
  } catch {
    /* netstat unavailable */
  }
  return [...ports].sort((a, b) => a - b);
};

const probeRoute = async (port, sessionId) => {
  const url = 'http://127.0.0.1:' + port + '/dsh-canvas/file?sessionId=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(probeName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (text.includes('dsh-canvas') || text.includes('unknown session') || text.includes('cannot stat') || text.includes('"size"')) {
      return { port, status: response.status, text };
    }
  } catch {
    /* not this port */
  } finally {
    clearTimeout(timer);
  }
  return null;
};

(async () => {
  const session = findSession();
  if (!session) {
    console.log('未找到本工作区的会话记录：' + workspace);
    process.exit(1);
  }
  console.log('工作区:', workspace);
  console.log('会话:', session.id);

  fs.writeFileSync(probePath, 'A\nB\nC\n');
  const stat = fs.statSync(probePath);

  let found = null;
  for (const port of listeningPorts()) {
    const hit = await probeRoute(port, session.id);
    if (hit) {
      found = hit;
      break;
    }
  }
  if (!found) {
    console.log('未找到画布路由：本机监听端口里没有响应 /dsh-canvas/file 的服务');
    fs.rmSync(probePath, { force: true });
    process.exit(1);
  }
  const base = 'http://127.0.0.1:' + found.port;
  console.log('服务:', base, '（元数据路由 HTTP ' + found.status + '）');
  console.log('真实 mtime:', stat.mtimeMs, 'size:', stat.size);
  console.log('探针返回:', found.text.slice(0, 160));

  const stale = await fetch(base + '/dsh-canvas/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, path: probeName, content: 'stale\n', expectedMtime: 1, expectedSize: 1 }),
  });
  const staleText = await stale.text();
  console.log(
    '\n[2] 过期版本保存 →',
    stale.status,
    staleText.slice(0, 160),
    stale.status === 409 ? '✔ 正确拒绝' : '✘ 没有被拦下（会静默覆盖）',
  );

  const fresh = fs.statSync(probePath);
  const good = await fetch(base + '/dsh-canvas/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, path: probeName, content: 'fresh\n', expectedMtime: fresh.mtimeMs, expectedSize: fresh.size }),
  });
  console.log('[3] 当前版本保存 →', good.status, (await good.text()).slice(0, 160));

  fs.rmSync(probePath, { force: true });
})();
