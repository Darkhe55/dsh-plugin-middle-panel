// 发布白名单必须覆盖 index.js 的每一个相对导入：
// 0.5.4 就是这样坏的——save-guard.js 写进了仓库，却漏在 files 里，装上去插件直接加载失败。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const files = Array.isArray(pkg.files) ? pkg.files : [];
check(files.length > 0, 'package.json 声明了 files 白名单');

/** `vendor/` 覆盖 vendor 下的任何文件；`index.js` 只覆盖自身。 */
const covered = (relative) => {
  const target = relative.replace(/^\.\//, '');
  return files.some((entry) => {
    const clean = entry.replace(/^\.\//, '');
    if (clean === target) return true;
    if (clean.endsWith('/')) return target.startsWith(clean);
    return false;
  });
};

const hostFiles = ['index.js', 'vendor-route.js', 'save-guard.js'].filter((name) =>
  fs.existsSync(path.join(root, name)),
);

const imports = new Set();
for (const name of hostFiles) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  const pattern = /from\s+['"](\.\/[^'"]+)['"]/g;
  let match = pattern.exec(text);
  while (match) {
    imports.add(match[1]);
    match = pattern.exec(text);
  }
}

check(imports.size > 0, '找到宿主侧相对导入', String(imports.size));
for (const relative of imports) {
  check(covered(relative), '导入被打包：' + relative);
}

// 运行时会直接读的其它文件
for (const required of ['client.js', 'cordis.patch.yml']) {
  check(covered(required), '运行时文件被打包：' + required);
}

// 反向检查：白名单里的条目应当真实存在，避免拼写错误静默失效
for (const entry of files) {
  if (entry.endsWith('/')) {
    check(fs.existsSync(path.join(root, entry)), '白名单目录存在：' + entry);
    continue;
  }
  check(fs.existsSync(path.join(root, entry)), '白名单文件存在：' + entry);
}

// A directory entry publishes everything inside it, including material that is only meant
// for the repository: `docs` once put docs/internal/ - the design drafts - into the tarball.
const INTERNAL = ['docs/internal', 'test', 'node_modules', 'src', 'scripts'];
let internalHits = 0;
const inspect = (directory, relative) => {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative + '/' + child.name;
    if (INTERNAL.some((prefix) => childRelative === prefix || childRelative.startsWith(prefix + '/'))) {
      internalHits += 1;
      continue;
    }
    if (child.isDirectory()) inspect(path.join(directory, child.name), childRelative);
  }
};
for (const entry of files) {
  const clean = entry.replace(/^\.\//, '').replace(/\/$/, '');
  const full = path.join(root, clean);
  if (entry.endsWith('/') && fs.existsSync(full)) inspect(full, clean);
}
check(internalHits === 0, '白名单目录里没有仓库内部资料', String(internalHits) + ' 个');

// The plugin detail page depends on these three paths, so they are listed by name rather
// than through the whole docs directory.
for (const required of ['docs/DETAIL.md', 'docs/DETAIL.zh.md', 'docs/preview.svg', 'icon.svg']) {
  check(covered(required), '发布物包含：' + required);
}

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
