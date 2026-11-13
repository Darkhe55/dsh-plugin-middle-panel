// 发布守卫：标签必须与 package.json 一致；已发布的版本要能识别为「跳过」。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// CI 会设置 GITHUB_REF_NAME；这里显式清空，保证「没有标签」的用例在任何环境都成立。
const run = (args, extraEnv) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', 'version-guard.cjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: '', ...(extraEnv || {}) },
  });

const mismatch = run(['--tag', 'v0.0.1', '--offline']);
check(mismatch.status === 1, '标签与版本不一致时退出码 1', String(mismatch.status));
check(/不一致/.test(mismatch.stderr), '提示里说明不一致');

const missing = run(['--offline']);
check(missing.status === 1, '缺少标签时退出码 1', String(missing.status));

const okTag = run(['--tag', 'v' + pkg.version, '--offline']);
check(okTag.status === 0, '一致时放行', String(okTag.status));

// CI 里没有 --tag 时应当回落到 GITHUB_REF_NAME
const fromEnv = run(['--offline'], { GITHUB_REF_NAME: 'v' + pkg.version });
check(fromEnv.status === 0, '没有 --tag 时用 GITHUB_REF_NAME', String(fromEnv.status));

// workflow 侧的行为约定
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
check(/tags:\s*\n\s*- '?v\*'?/.test(workflow), '只在标签推送时触发');
check(!/branches:\s*\n\s*- main/.test(workflow), '分支推送不触发发布');
check(workflow.includes('id-token: write'), '声明 OIDC 权限');
check(workflow.includes('--provenance'), '发布带 provenance');
check(workflow.includes('version-guard.cjs'), '发布前跑版本守卫');
check(/skip=true/.test(workflow), '已发布版本会跳过而不是失败');

// CI 仍只做测试，不碰 registry
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
check(!/npm publish/.test(ci.split('stage:')[0]), 'CI 主任务不发布');
check(ci.includes('npm test'), 'CI 跑测试');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
