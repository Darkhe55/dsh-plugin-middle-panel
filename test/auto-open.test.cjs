// 自动展开判定：关闭不展开、有新产物才展开、已打开未变化不展开、重复调用不弹、无路径不展开。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('    const decideAutoOpen = (input) => {');
const end = src.indexOf('    const rememberAutoOpened = (key) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const api = new Function(
  'sameFile',
  src.slice(start, end) + '\nreturn { decideAutoOpen };',
)((left, right) => String(left).replace(/\\/g, '/') === String(right).replace(/\\/g, '/'));

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const decide = api.decideAutoOpen;

// 1) 开关关闭：什么都不做
{
  const result = decide({ enabled: false, targets: ['a.md'], callKey: 'c1', seen: new Set(), openPaths: [] });
  check(result.action === 'skip' && result.reason === 'off', '关闭后不展开', JSON.stringify(result));
}

// 2) 有新产物：展开，且只包含新路径
{
  const result = decide({
    enabled: true,
    targets: ['old.md', 'new.html'],
    callKey: 'c2',
    seen: new Set(),
    openPaths: ['old.md'],
  });
  check(result.action === 'open', '有新产物时展开', JSON.stringify(result));
  check(result.fresh.length === 1 && result.fresh[0] === 'new.html', '只打开新产物，不含旧产物', result.fresh.join(','));
}

// 3) 全部已打开：不展开
{
  const result = decide({
    enabled: true,
    targets: ['a.md'],
    callKey: 'c3',
    seen: new Set(),
    openPaths: ['a.md'],
  });
  check(result.action === 'skip' && result.reason === 'unchanged', '已打开且未变化时不展开', JSON.stringify(result));
}

// 4) 重复调用（同一 callKey 已处理）：不弹第二次
{
  const seen = new Set(['c4']);
  const result = decide({ enabled: true, targets: ['x.md'], callKey: 'c4', seen, openPaths: [] });
  check(result.action === 'skip' && result.reason === 'dup', '同一次调用不重复展开', JSON.stringify(result));
}

// 5) 没有路径：不展开
{
  const result = decide({ enabled: true, targets: [], callKey: 'c5', seen: new Set(), openPaths: [] });
  check(result.action === 'skip' && result.reason === 'nopath', '没有产物路径时不展开', JSON.stringify(result));
}

// 6) 路径写法差异（反斜杠 / 大小写）视为同一文件
{
  const result = decide({
    enabled: true,
    targets: ['demo\\notes.md'],
    callKey: 'c6',
    seen: new Set(),
    openPaths: ['demo/notes.md'],
  });
  check(result.action === 'skip', '同一文件的不同写法不重复打开', JSON.stringify(result));
}

// 7) 多个新产物：一次全部打开
{
  const result = decide({
    enabled: true,
    targets: ['a.html', 'b.pdf', 'c.glb'],
    callKey: 'c7',
    seen: new Set(),
    openPaths: ['b.pdf'],
  });
  check(result.action === 'open' && result.fresh.length === 2, '多个新产物一起打开', result.fresh.join(','));
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
