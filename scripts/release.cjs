#!/usr/bin/env node
// One-command release: test, publish, and point the market index at the new version.
//
//   node scripts/release.cjs            # publish the version in package.json
//   node scripts/release.cjs --dry-run  # everything except the upload
//
// The token is read from NPM_TOKEN, or from ~/.dsh/npm-publish-token.txt. It is
// passed on the command line so nothing is written into the repo or the user-level
// .npmrc.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const registry = 'https://registry.npmjs.org';

const fail = (message) => {
  console.error('✗ ' + message);
  process.exit(1);
};

// Windows cannot spawn npm.cmd directly, so both platforms go through a shell.
const run = (args) =>
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ' + args.map((item) => (item.includes(' ') ? '"' + item + '"' : item)).join(' ')], {
        cwd: root,
        stdio: 'inherit',
      })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit' });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
console.log('发布 ' + pkg.name + '@' + version + (dryRun ? '（dry run）' : ''));

// 1) 测试必须全绿：发出去的产物就是测试跑过的产物
const test = run(['test']);
if (test.status !== 0) fail('测试未通过，已中止发布');

// 2) 找 token
const tokenFile = path.join(os.homedir(), '.dsh', 'npm-publish-token.txt');
let token = String(process.env.NPM_TOKEN || '').trim();
if (!token && fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim();
if (!token && !dryRun) fail('缺少 npm token：设置 NPM_TOKEN，或写入 ' + tokenFile + '（一行，不要加引号）');

// 3) 发布
const args = ['publish', '--registry', registry, '--access', 'public'];
if (token) args.push('--//registry.npmjs.org/:_authToken=' + token);
if (dryRun) args.push('--dry-run');
const publish = run(args);
if (publish.status !== 0) fail('npm publish 失败（409 表示该版本正在投递，等 30–60 秒再查）');

if (dryRun) {
  console.log('\n dry run 结束，未写入 market-index.json');
  process.exit(0);
}

// 4) 市场索引指向新版本
const indexPath = path.join(root, 'market-index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const entry = (index.plugins || []).find((plugin) => plugin.name === pkg.name);
if (!entry) fail('market-index.json 里没有 ' + pkg.name);
const versions = Array.isArray(entry.versions) ? entry.versions : [];
const engines = (pkg.dsh && pkg.dsh.engines) || pkg.engines || {};
versions.unshift({
  version,
  publishTimestamp: Math.floor(Date.now() / 1000),
  source: { type: 'npm' },
  ...(engines.dsh ? { engines: { dsh: engines.dsh } } : {}),
});
entry.versions = versions.slice(0, 5);
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

console.log('\n✓ 已发布 ' + version + '，market-index.json 已更新');
console.log('  接下来：git add -A && git commit -m "release: ' + version + '" && git push');
