// 安全与隐私：CORS 不再通配、pdf.js 关闭 eval、发布内容受白名单约束。
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const host = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const { readSource } = require('./_source.cjs');
const src = readSource();
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// CORS：opaque 来源只回 null，不再通配
check(host.includes("'access-control-allow-origin': opaque ? 'null' : origin,"), '不透明来源不再返回通配符');
check(!host.includes("'access-control-allow-origin': opaque ? '*'"), '没有残留的星号');
check(host.includes('vary: \'origin\''), '保留 vary: origin');

// pdf.js：关闭 eval 路径
check(src.includes('isEvalSupported: false,'), 'pdf.js 关闭 eval');
check(
  src.indexOf('isEvalSupported: false') > src.indexOf('data: bytes'),
  '参数落在 getDocument 里',
);

// 发布白名单
check(Array.isArray(pkg.files) && pkg.files.length > 0, '有 files 白名单');
check(pkg.files.includes('client.js'), '包含构建产物');
check(pkg.files.includes('vendor/'), '包含 vendored pdf.js');
check(!pkg.files.some((item) => item.startsWith('test')), '不发布测试');
check(!pkg.files.some((item) => item.startsWith('scripts')), '不发布构建脚本');

// 凭证卫生
check(fs.existsSync(path.join(__dirname, '..', '.gitignore')), '有 .gitignore');
const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
check(/^\.npmrc$/m.test(ignore), '.npmrc 被忽略');
check(!fs.existsSync(path.join(__dirname, '..', '.npmrc')), '工作区没有 .npmrc');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
