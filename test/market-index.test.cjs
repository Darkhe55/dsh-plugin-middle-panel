// market-index.json 是市场展示用的版本清单，必须跟 package.json 的版本一致，
// 否则按标签发布之后市场页仍指向旧版本。
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

const entry = (index.plugins || []).find((plugin) => plugin.name === pkg.name);
check(Boolean(entry), 'market-index 里有 ' + pkg.name);
if (entry) {
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  check(versions.length > 0, '版本列表非空');
  check(versions[0] && versions[0].version === pkg.version, '首条版本与 package.json 一致', '首条=' + (versions[0] && versions[0].version) + ' pkg=' + pkg.version);
  check(versions.every((item) => typeof item.version === 'string' && item.version), '每条都有 version 字段');
  check(versions.length <= 5, '列表最多保留 5 条');
  const engines = (pkg.dsh && pkg.dsh.engines) || pkg.engines || {};
  check(
    Boolean(versions[0] && versions[0].engines && versions[0].engines.dsh),
    '首条记录了 dsh 兼容范围',
    JSON.stringify(versions[0] && versions[0].engines),
  );
  if (engines.dsh && versions[0] && versions[0].engines) {
    check(versions[0].engines.dsh === engines.dsh, '兼容范围与 package.json 一致');
  }
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
