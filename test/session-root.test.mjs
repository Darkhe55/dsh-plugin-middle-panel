// 会话工作区的查找要兼容宿主服务的几种形态：
// 直接给 session、给包了一层 record 的值、给 agent，或者只能通过 values() 枚举。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = await import(pathToFileURL(path.join(here, '..', 'index.js')).href);
const { sessionCwdOf, sessionRootFromStore } = host;

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const CWD = 'C:/work/project';
const session = { header: { id: 's1', cwd: CWD } };

// 1) 直接是 session
check(sessionCwdOf(session) === CWD, '直接传入 session');
check(sessionCwdOf({ session }) === CWD, '包了一层 session');
check(sessionCwdOf({ record: { session } }) === CWD, 'record 包裹');
check(sessionCwdOf({ agent: { session } }) === CWD, 'agent 包裹');
check(sessionCwdOf({}) === undefined, '空对象返回 undefined');

// 2) ctx.sessions.get
{
  const ctx = { sessions: { get: (id) => (id === 's1' ? session : undefined) } };
  check(sessionRootFromStore(ctx, 's1') === CWD, 'ctx.sessions.get 命中');
  check(sessionRootFromStore(ctx, 'nope') === undefined, '未知会话返回 undefined');
  check(sessionRootFromStore(ctx, '') === undefined, '空 id 返回 undefined');
}

// 3) 只有旧的 ctx.get('sessions')
{
  const ctx = { get: (name) => (name === 'sessions' ? { get: () => ({ session }) } : undefined) };
  check(sessionRootFromStore(ctx, 's1') === CWD, '兼容 ctx.get("sessions")');
}

// 4) 旧的 ctx.get 抛错时不应崩
{
  const ctx = { get: () => { throw new Error('no service'); } };
  check(sessionRootFromStore(ctx, 's1') === undefined, '访问器抛错时返回 undefined');
}

// 5) 只能枚举的注册表
{
  const registry = {
    values: () => [{ id: 'x', session }, { header: { id: 's1', cwd: CWD } }],
  };
  const ctx = { sessions: registry };
  check(sessionRootFromStore(ctx, 's1') === CWD, '通过 values() 枚举匹配 id');
}

// 6) 两种访问器都给时不会重复处理
{
  const shared = { get: () => session };
  const ctx = { sessions: shared, get: () => shared };
  check(sessionRootFromStore(ctx, 's1') === CWD, '重复的访问器仍能命中');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
