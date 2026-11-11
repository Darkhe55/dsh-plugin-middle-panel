// One canvas call may name several deliverables; each opens as its own tab and the
// first one becomes active.
const fs = require('fs');
const client = fs.readFileSync('src/client.js', 'utf8');
const host = fs.readFileSync('index.js', 'utf8');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// —— 宿主端协议 ——
check(/paths:\s*\{/.test(host), '工具声明了 paths 参数');
check(/maxItems: 12/.test(host), 'paths 限制最多 12 项');
check(/required: \[\]/.test(host), 'path 不再强制（paths 可单独使用）');
check(/path or paths is required/.test(host), '两者都缺时报错');
check(/const targets = listed\.length \? listed : single \? \[single\] : \[\]/.test(host), 'paths 优先，path 兼容');
check(/paths: targets/.test(host), '返回值包含全部路径');
check(/value\.paths\.length > 1/.test(host), '输出文案区分单/多');

// —— 客户端行为 ——
check(/const openDocs = \(inputs\) =>/.test(client), '客户端有批量打开函数');
check(/for \(const input of inputs\)/.test(client), '逐个打开');
check(/store\.activeId = target\.id|mutate\(\{ activeId: target\.id \}\)/.test(client), '最后把首个设为激活');
check(/Array\.isArray\(args\.paths\)/.test(client), '工具卡片读取 paths');
check(/openDocs\(/.test(client), '卡片调用批量打开');
check(/pendingList/.test(client), '会话未就绪时排队而不是覆盖');

// —— 用桩执行 openDocs ——
const start = client.indexOf('const openDocs = (inputs) => {');
const end = client.indexOf('const openDoc = (input) => {');
if (start < 0 || end < 0) {
  console.log('FAIL openDocs 锚点缺失');
  process.exit(1);
}
const run = (inputs) => {
  const store = { docs: [], activeId: undefined };
  const opened = [];
  const factory = new Function(
    'store',
    'normalizePath',
    'sameFile',
    'mutate',
    'openDoc',
    'devlog',
    client.slice(start, end) + '\nreturn openDocs;',
  );
  const openDocs = factory(
    store,
    (p) => String(p || '').trim().replace(/^\.\//, ''),
    (a, b) => a === b,
    (patch) => Object.assign(store, patch),
    (input) => {
      opened.push(input.path);
      store.docs.push({ id: 'd' + store.docs.length, path: input.path });
      store.activeId = 'd' + (store.docs.length - 1);
    },
    () => {},
  );
  const first = openDocs(inputs);
  return { first, opened, store };
};

let result = run([{ path: 'a.html' }, { path: 'b.html' }, { path: 'c.png' }]);
check(result.opened.length === 3, '三个路径都打开了', result.opened.join(','));
check(result.store.docs.length === 3, '生成三个标签');
check(result.first === 'a.html', '返回首个路径');
check(result.store.activeId === 'd0', '激活的是第一个标签', String(result.store.activeId));

result = run([{ path: 'a.html' }, { path: '' }, { path: '  ' }]);
check(result.opened.length === 1, '空路径被忽略');

result = run([]);
check(result.opened.length === 0 && result.first === '', '空数组安全返回');

result = run([{ path: 'x.md' }]);
check(result.store.activeId === 'd0', '单个也正常');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}

