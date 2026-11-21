// market-index.json 是市场展示用的版本清单，只能记录 registry 上真实存在过的版本。
// 发布前 package.json 先升到新版本、清单要等发布成功才能写，两者之间本来就有发布窗口：
// 所以清单可以落后于 package.json，但不能领先——领先就是在广告一个装不到的版本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'market-index.json'), 'utf8'));

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const parse = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(text || ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' };
};

const compare = (left, right) => {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
};

const entry = (index.plugins || []).find((plugin) => plugin.name === pkg.name);
check(Boolean(entry), 'market-index 里有 ' + pkg.name);
if (entry) {
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const current = parse(pkg.version);
  const head = versions[0] ? parse(versions[0].version) : null;
  check(versions.length > 0, '版本列表非空');
  check(
    Boolean(head && current) && compare(head, current) <= 0,
    '清单首条不领先 package.json',
    '首条=' + (versions[0] && versions[0].version) + ' pkg=' + pkg.version,
  );
  check(versions.every((item) => typeof item.version === 'string' && item.version), '每条都有 version 字段');
  check(versions.length <= 5, '列表最多保留 5 条');
  const parsed = versions.map((item) => parse(item.version));
  check(
    parsed.every((item, position) => Boolean(item) && (position === 0 || compare(parsed[position - 1], item) > 0)),
    '版本严格降序，没有重复',
    parsed.map((item) => (item ? item.major + '.' + item.minor + '.' + item.patch : 'invalid')).join(' '),
  );
  const engines = (pkg.dsh && pkg.dsh.engines) || pkg.engines || {};
  check(
    Boolean(versions[0] && versions[0].engines && versions[0].engines.dsh),
    '首条记录了 dsh 兼容范围',
    JSON.stringify(versions[0] && versions[0].engines),
  );
  if (engines.dsh && versions[0] && versions[0].engines) {
    check(versions[0].engines.dsh === engines.dsh, '兼容范围与 package.json 一致');
  }
  if (head && current && compare(head, current) < 0) {
    console.log('注意 ' + pkg.version + ' 尚未写入市场清单（发布前的版本），清单停在 ' + versions[0].version);
  }
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
