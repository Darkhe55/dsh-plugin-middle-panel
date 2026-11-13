#!/usr/bin/env node
// One-command release: pack check, publish, then point the market index at the new version.
//
//   node scripts/release.cjs              # publish the version in package.json
//   node scripts/release.cjs --dry-run    # everything except the upload
//   node scripts/release.cjs --index-only # only redo the market-index step
//
// The token never appears on a command line and never lands in the repository: a
// private temporary .npmrc holds `_authToken=${NPM_TOKEN}`, npm expands it from the
// environment, and the file is removed in a finally block on every path out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const indexOnly = process.argv.includes('--index-only');
const registry = 'https://registry.npmjs.org';

const fail = (message, hint) => {
  console.error('✗ ' + message);
  if (hint) console.error('  ' + hint);
  process.exit(1);
};

// npm is a .cmd shim on Windows, which node refuses to spawn without a shell.
// Prefer the real CLI script and the current node binary; fall back to the shim.
const npmLaunch = () => {
  const fromNpm = String(process.env.npm_execpath || '');
  if (fromNpm && fs.existsSync(fromNpm)) return { command: process.execPath, args: [fromNpm] };
  const near = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(near)) return { command: process.execPath, args: [near] };
  const shim = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return { command: shim, args: [], shell: process.platform === 'win32' };
};

const launch = npmLaunch();
const run = (args, env) =>
  spawnSync(launch.command, [...launch.args, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: launch.shell === true,
    env: env || process.env,
  });

const tokenFile = path.join(os.homedir(), '.dsh', 'npm-publish-token.txt');
const readToken = () => {
  const fromEnv = String(process.env.NPM_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  return '';
};

/**
 * A throwaway .npmrc whose auth line references an environment variable, so the
 * token exists only in this process's environment.
 */
const withNpmrc = (callback) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npmrc-'));
  const file = path.join(dir, '.npmrc');
  const token = readToken();
  if (!token && !dryRun) fail('缺少 npm token', '设置 NPM_TOKEN，或写入 ' + tokenFile + '（一行，不要加引号）');
  fs.writeFileSync(
    file,
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=' + registry + '\n',
    { mode: 0o600 },
  );
  const env = { ...process.env, NPM_TOKEN: token, npm_config_userconfig: file };
  try {
    return callback(env);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the temp file is private and short-lived either way */
    }
  }
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

/** Point market-index.json at `version`; safe to run on its own. */
const updateMarketIndex = () => {
  const indexPath = path.join(root, 'market-index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = (index.plugins || []).find((plugin) => plugin.name === pkg.name);
  if (!entry) fail('market-index.json 里没有 ' + pkg.name);
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const rest = versions.filter((item) => item.version !== version);
  const engines = (pkg.dsh && pkg.dsh.engines) || pkg.engines || {};
  rest.unshift({
    version,
    publishTimestamp: Math.floor(Date.now() / 1000),
    source: { type: 'npm' },
    ...(engines.dsh ? { engines: { dsh: engines.dsh } } : {}),
  });
  entry.versions = rest.slice(0, 5);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log('✓ market-index.json 指向 ' + version);
};

if (indexOnly) {
  updateMarketIndex();
  console.log('  接下来：git add market-index.json && git commit -m "release: ' + version + '" && git push');
  process.exit(0);
}

console.log('发布 ' + pkg.name + '@' + version + (dryRun ? '（dry run）' : ''));

// 1) 测试必须全绿：发出去的产物就是测试跑过的产物
const test = run(['test']);
if (test.status !== 0) fail('测试未通过，已中止发布');

// 2) 打包预演：确认白名单内容就是预期内容
const pack = run(['pack', '--dry-run']);
if (pack.status !== 0) fail('npm pack --dry-run 失败');

// 3) 发布
const publishCode = withNpmrc((env) => {
  const args = ['publish', '--registry', registry, '--access', 'public'];
  if (dryRun) args.push('--dry-run');
  return run(args, env).status;
});
if (publishCode !== 0) {
  fail('npm publish 失败', '409 表示该版本正在投递，等 30–60 秒再查 registry；不要重复改动版本号');
}

if (dryRun) {
  console.log('\n dry run 结束，未写入 market-index.json');
  process.exit(0);
}

// 4) 索引更新是独立一步：发布已经成功，索引失败不该让人以为整次发布失败
try {
  updateMarketIndex();
} catch (error) {
  fail(
    'npm 已发布 ' + version + '，但 market-index.json 更新失败：' + (error && error.message ? error.message : String(error)),
    '恢复命令：node scripts/release.cjs --index-only',
  );
}

console.log('\n✓ 已发布 ' + version + '');
console.log('  接下来：git add -A && git commit -m "release: ' + version + '" && git push');
