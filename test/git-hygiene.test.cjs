// 发布脚本不该建议 `git add -A`：它会把工作树里的一切都扫进去。
// 这里断言忽略规则覆盖了凭据类文件，并且仓库里没有已跟踪的敏感文件。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const required = ['.npmrc', '*.tgz', '.env', '*.pem', '*.key', '*token*.txt', 'dsh-smoke-*', '*.bak'];
for (const pattern of required) {
  check(ignore.split('\n').some((line) => line.trim() === pattern), '忽略规则存在：' + pattern);
}

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// 已跟踪文件里不能有凭据类文件
const tracked = String(git(['ls-files']).stdout || '')
  .split('\n')
  .filter(Boolean);
const riskyTracked = tracked.filter((file) =>
  /(^|\/)\.npmrc$|\.env(\.|$)|\.(pem|key|p12|pfx)$|token.*\.txt$|\.tgz$/i.test(file),
);
check(riskyTracked.length === 0, '没有已跟踪的凭据文件', riskyTracked.slice(0, 3).join(', '));

// 忽略规则真的要生效（git check-ignore 对示例路径返回 0）
const samples = ['.npmrc', 'release.tgz', '.env.local', 'deploy.pem', 'npm-publish-token.txt', 'dsh-smoke-abc.txt'];
const notIgnored = samples.filter((sample) => git(['check-ignore', '-q', sample]).status !== 0);
check(notIgnored.length === 0, '忽略规则对示例路径生效', notIgnored.join(', '));

// 发布脚本不得再输出 git add -A
const script = fs.readFileSync(path.join(root, 'scripts', 'release.cjs'), 'utf8');
check(!/git add -A/.test(script), '发布脚本不再建议 git add -A');
check(/suggestCommit/.test(script), '发布脚本自带提交建议逻辑');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
