// sessionRoots：有界 LRU + TTL，且不削弱路径约束。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

const start = src.indexOf('const SESSION_ROOT_LIMIT = 256;');
const end = src.indexOf('const normalize = (value) =>');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}

const makeApi = () => {
  const factory = new Function(
    'Date',
    src.slice(start, end) +
      '\nreturn { rememberSessionRoot, recallSessionRoot, clearSessionRoots, sessionRoots, SESSION_ROOT_LIMIT, SESSION_ROOT_TTL_MS };',
  );
  return factory(Date);
};

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 1) 正常读写
{
  const api = makeApi();
  api.rememberSessionRoot('s1', '/work/one');
  check(api.recallSessionRoot('s1') === '/work/one', '写入后可读回');
  check(api.recallSessionRoot('nope') === undefined, '未知 session 返回 undefined');
  check(api.SESSION_ROOT_LIMIT === 256, '上限为 256', String(api.SESSION_ROOT_LIMIT));
  check(api.SESSION_ROOT_TTL_MS >= 30 * 60 * 1000 && api.SESSION_ROOT_TTL_MS <= 60 * 60 * 1000, 'TTL 在 30–60 分钟内', String(api.SESSION_ROOT_TTL_MS));
}

// 2) 超过上限淘汰最旧
{
  const api = makeApi();
  for (let index = 0; index < api.SESSION_ROOT_LIMIT + 20; index += 1) {
    api.rememberSessionRoot('s' + index, '/work/' + index);
  }
  check(api.sessionRoots.size <= api.SESSION_ROOT_LIMIT, '条目数不超过上限', String(api.sessionRoots.size));
  check(api.recallSessionRoot('s0') === undefined, '最旧条目被淘汰');
  const last = 's' + (api.SESSION_ROOT_LIMIT + 19);
  check(api.recallSessionRoot(last) === '/work/' + (api.SESSION_ROOT_LIMIT + 19), '最新条目保留');
}

// 3) 最近使用不被优先淘汰
{
  const api = makeApi();
  for (let index = 0; index < api.SESSION_ROOT_LIMIT; index += 1) {
    api.rememberSessionRoot('s' + index, '/work/' + index);
  }
  api.recallSessionRoot('s0'); // s0 变成最近使用
  api.rememberSessionRoot('fresh', '/work/fresh');
  check(api.recallSessionRoot('s0') === '/work/0', '被访问过的旧条目仍然保留');
  check(api.recallSessionRoot('s1') === undefined, '真正最旧的条目被淘汰');
}

// 4) TTL 过期
{
  let now = Date.now();
  const fakeDate = {
    now: () => now,
  };
  const factory = new Function(
    'Date',
    src.slice(start, end) +
      '\nreturn { rememberSessionRoot, recallSessionRoot, sessionRoots, SESSION_ROOT_TTL_MS };',
  );
  const api = factory(fakeDate);
  api.rememberSessionRoot('old', '/work/old');
  now += api.SESSION_ROOT_TTL_MS + 1000;
  api.rememberSessionRoot('new', '/work/new');
  check(api.recallSessionRoot('old') === undefined, '过期条目被删除');
  check(api.recallSessionRoot('new') === '/work/new', '未过期条目保留');
}

// 5) 清空
{
  const api = makeApi();
  api.rememberSessionRoot('s1', '/work/one');
  api.clearSessionRoots();
  check(api.sessionRoots.size === 0, '清空后没有条目');
  check(api.recallSessionRoot('s1') === undefined, '清空后读不到旧条目');
}

// 6) 路径越界与未知会话仍然拒绝（沿用原有校验函数）
{
  const normalizeStart = src.indexOf('const normalize = (value) =>');
  const normalizeEnd = src.indexOf('/**', normalizeStart);
  const body = src.slice(normalizeStart, normalizeEnd);
  const helpers = new Function(body + '\nreturn { normalize, isInside };')();
  check(helpers.isInside('/work/one', '/work/one/file.txt'), '工作区内路径被接受');
  check(!helpers.isInside('/work/one', '/work/two/file.txt'), '跨工作区路径被拒绝');
  check(!helpers.isInside('/work/one', '/etc/passwd'), '绝对路径越界被拒绝');
  const api = makeApi();
  check(api.recallSessionRoot('ghost') === undefined, '未知 session 没有根路径（路由返回 403）');
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
