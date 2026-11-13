#!/usr/bin/env node
/**
 * Release guard: decide whether a tag may be published.
 *
 *   node scripts/version-guard.cjs --tag v0.5.5
 *   node scripts/version-guard.cjs --tag v0.5.5 --offline   # 跳过 registry 查询
 *
 * Exit codes: 0 可以发布 / 1 参数或版本有问题 / 2 该版本已存在（应跳过发布）。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = flag('tag', process.env.GITHUB_REF_NAME || '');
const offline = argv.includes('--offline');
const registry = flag('registry', 'https://registry.npmjs.org');

const say = (text) => console.log(text);
const stop = (code, message) => {
  console.error('✗ ' + message);
  process.exit(code);
};

// 1) 标签必须存在，且形如 v<version>
if (!tag) stop(1, '缺少 --tag（例如 v' + version + '），无法判断要发布什么');
if (!tag.startsWith('v')) stop(1, '标签必须以 v 开头：' + tag);
const tagged = tag.slice(1);
if (tagged !== version) {
  stop(1, '标签 ' + tag + ' 与 package.json 版本 ' + version + ' 不一致：先改版本再打标签');
}
say('✓ 标签与版本一致：' + tag);

// 2) 与 registry 现状比较：已存在则跳过，低于 latest 则拒绝
const parse = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(text);
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

// node:https with `agent: false` instead of global fetch: undici keeps a keep-alive
// socket open, and exiting while it closes trips a libuv assertion on Windows.
const https = require('node:https');

const fetchText = (url) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-middle-panel-guard' }, agent: false, timeout: 15000 },
      (response) => {
        if (response.statusCode === 404) {
          response.resume();
          resolve(null);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('registry ' + response.statusCode));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      },
    );
    request.on('timeout', () => request.destroy(new Error('registry 超时')));
    request.on('error', reject);
  });

const main = async () => {
  if (offline) {
    say('（离线模式，跳过 registry 检查）');
    return;
  }
  const body = await fetchText(registry + '/' + encodeURIComponent(pkg.name));
  if (!body) {
    say('✓ registry 上还没有这个包，可以首发');
    return;
  }
  const meta = JSON.parse(body);
  const versions = Object.keys(meta.versions || {});
  if (versions.includes(version)) {
    console.error('• ' + pkg.name + '@' + version + ' 已存在，跳过发布');
    process.exitCode = 2;
    return;
  }
  const latest = meta['dist-tags'] && meta['dist-tags'].latest;
  const mine = parse(version);
  const theirs = latest ? parse(latest) : null;
  if (mine && theirs && compare(mine, theirs) <= 0) {
    stop(1, '版本 ' + version + ' 不高于线上的 latest ' + latest + '：请先升级 package.json 的版本');
  }
  say('✓ 线上 latest 为 ' + (latest || '(无)') + '，可以发布 ' + version);
};

main().catch((error) => stop(1, '版本检查失败：' + (error && error.message ? error.message : String(error))));
