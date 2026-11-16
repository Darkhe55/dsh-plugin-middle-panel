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
const checkToken = process.argv.includes('--check-token');
const stageOnly = process.argv.includes('--stage');
const approveIndex = process.argv.indexOf('--approve');
const approveId = approveIndex >= 0 ? String(process.argv[approveIndex + 1] || '') : '';
const otpIndex = process.argv.indexOf('--otp');
const otp = otpIndex >= 0 ? String(process.argv[otpIndex + 1] || '') : '';
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

/** Same as `run`, but keeps the output so a failure can be classified. */
const runCaptured = (args, env) => {
  const result = spawnSync(launch.command, [...launch.args, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: launch.shell === true,
    env: env || process.env,
    encoding: 'utf8',
  });
  const output = String(result.stdout || '') + String(result.stderr || '');
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status, output };
};

const tokenFile = path.join(os.homedir(), '.dsh', 'npm-publish-token.txt');
const readToken = () => {
  const fromEnv = String(process.env.NPM_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  return '';
};

/**
 * npm reports auth failures with a code, and every code needs a different fix.
 * A token that expired is a 401; a token lacking a scope is a 403; a version that
 * is mid-delivery is a 409.
 */
const explain = (output) => {
  const text = String(output || '');
  if (/\bE401\b|\b401\b .*Unauthorized|authenticate/i.test(text)) {
    return {
      message: 'npm 拒绝了凭据：token 无效、已过期或已被撤销',
      hint:
        '在 npmjs.com → Access Tokens 生成新的 Automation token，写入 ' +
        tokenFile +
        '（一行，不要加引号）或设置 NPM_TOKEN；随后用 node scripts/release.cjs --check-token 复验',
    };
  }
  if (/\bE403\b|\b403\b/.test(text)) {
    return {
      message: 'npm 拒绝了这个操作（403）：token 缺少 publish 权限，或该操作被账号策略禁止',
      hint: '确认 token 具有 Publish 权限；unpublish 一类操作需要账号本人交互式完成，不能靠 token',
    };
  }
  if (/previously published versions|EPUBLISHCONFLICT/i.test(text)) {
    return {
      message: 'package.json 里的版本已经发布过了',
      hint:
        '先把 package.json 的 version 提高（例如 0.5.4 → 0.5.5）再发布；' +
        '想确认线上现状可查 npm view ' + pkg.name + ' version',
    };
  }
  if (/\bEOTP\b|one-time password/i.test(text)) {
    return {
      message: 'npm 要求一次性密码（2FA）',
      hint: '用 node scripts/release.cjs --otp <6 位数字> 重试，或改用不需要 OTP 的 Automation token',
    };
  }
  if (/\bE409\b|\b409\b/.test(text)) {
    return {
      message: '该版本正在投递中（409）',
      hint: '等 30–60 秒再查 registry；不要为了“重试”去改版本号',
    };
  }
  if (/\bE402\b|\b402\b/.test(text)) {
    return { message: 'npm 要求付费或权限升级（402）', hint: '检查包名占用与账号计划' };
  }
  return { message: 'npm publish 失败', hint: '查看上面 npm 的输出；不要盲目重跑发布' };
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

/**
 * Read the registry's own publication time for \`target\`, or null when it is not published.
 * The index is a claim about what exists on npm, so it may only be written from the
 * registry's answer: stamping Date.now() for an unreleased version made the index
 * advertise a version nobody could install.
 */
const publishedAt = (name, target) =>
  new Promise((resolve) => {
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(name);
    const request = require('node:https').get(
      url,
      { agent: false, headers: { accept: 'application/json' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 4 * 1024 * 1024) body += chunk;
        });
        response.on('end', () => {
          try {
            const data = JSON.parse(body);
            const stamp = data && data.time && data.time[target];
            resolve(stamp ? Math.floor(new Date(stamp).getTime() / 1000) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('error', () => resolve(null));
    request.setTimeout(15000, () => {
      request.destroy();
      resolve(null);
    });
  });

/** Point market-index.json at \`version\` — only when the registry confirms it is published. */
const updateMarketIndex = async () => {
  const indexPath = path.join(root, 'market-index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = (index.plugins || []).find((plugin) => plugin.name === pkg.name);
  if (!entry) {
    fail('market-index.json 里没有 ' + pkg.name);
    return;
  }
  const stamp = await publishedAt(pkg.name, version);
  if (!stamp) {
    fail(
      pkg.name + '@' + version + ' 不在 npm registry 上',
      'market-index 只能记录真实发布过的版本：先完成发布，再运行 --index-only。',
    );
    return;
  }
  const versions = Array.isArray(entry.versions) ? entry.versions : [];
  const rest = versions.filter((item) => item.version !== version);
  const engines = (pkg.dsh && pkg.dsh.engines) || pkg.engines || {};
  rest.unshift({
    version,
    publishTimestamp: stamp,
    source: { type: 'npm' },
    ...(engines.dsh ? { engines: { dsh: engines.dsh } } : {}),
  });
  entry.versions = rest.slice(0, 5);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log(
    '✓ market-index.json 指向 ' + version + '（registry 发布时间 ' + new Date(stamp * 1000).toISOString() + '）',
  );
};

// 审批一个已暂存的版本：这一步是「证明你在场」，需要 2FA 或豁免 2FA 的凭据
if (approveId) {
  const approved = withNpmrc((env) => {
    const args = ['stage', 'approve', approveId, '--registry', registry];
    if (otp) args.push('--otp', otp);
    return runCaptured(args, env);
  });
  if (approved.status !== 0) {
    const reason = explain(approved.output);
    fail(reason.message, reason.hint);
  }
  console.log('\n✓ 已审批 ' + approveId + '，' + pkg.name + '@' + version + ' 已上线');
  updateMarketIndex()
    .then(() => {
      console.log('  接下来：git add package.json market-index.json CHANGELOG.md && git commit -m "release: ' + version + '" && git push');
      process.exit(0);
    })
    .catch((error) => fail('索引更新失败：' + (error && error.message ? error.message : String(error))));
  return;
}

if (indexOnly) {
  updateMarketIndex()
    .then(() => {
      console.log('  接下来：git add market-index.json && git commit -m "release: ' + version + '" && git push');
      process.exit(0);
    })
    .catch((error) => fail('索引更新失败：' + (error && error.message ? error.message : String(error))));
  return;
}

// 只验凭据：token 会在某个日期过期，这一步让它在发布当天之前就暴露出来
if (checkToken) {
  withNpmrc((env) => {
    const who = runCaptured(['whoami', '--registry', registry], env);
    if (who.status !== 0) {
      const reason = explain(who.output);
      fail(reason.message, reason.hint);
    }
    console.log('✓ token 有效，登录身份：' + String(who.output).trim().split('\n').pop());
    console.log('  提示：npm 的 token 有有效期（Granular token 最长 90 天）；过期后发布会以 401 失败，');
    console.log('        重新生成后写入 ' + tokenFile + ' 即可，其余流程不受影响。');
  });
  process.exit(0);
}

console.log('发布 ' + pkg.name + '@' + version + (dryRun ? '（dry run）' : ''));

// 1) 测试必须全绿：发出去的产物就是测试跑过的产物
const test = run(['test']);
if (test.status !== 0) fail('测试未通过，已中止发布');

// 2) 打包预演：确认白名单内容就是预期内容
const pack = run(['pack', '--dry-run']);
if (pack.status !== 0) fail('npm pack --dry-run 失败');

// 3) 先验凭据再发布：把 401/403 与版本冲突区分开，别让过期 token 看起来像 409
const publishResult = withNpmrc((env) => {
  const who = runCaptured(['whoami', '--registry', registry], env);
  if (who.status !== 0) {
    const reason = explain(who.output);
    return { status: 1, output: who.output, reason };
  }
  const args = [stageOnly ? 'stage' : 'publish'];
  if (stageOnly) args.push('publish');
  args.push('--registry', registry, '--access', 'public');
  if (dryRun) args.push('--dry-run');
  if (otp) args.push('--otp', otp);
  return runCaptured(args, env);
});
if (publishResult.status !== 0) {
  const reason = publishResult.reason || explain(publishResult.output);
  fail(reason.message, reason.hint);
}

if (dryRun) {
  console.log('\n dry run 结束，未写入 market-index.json');
  process.exit(0);
}

// 暂存模式：包还没上线，索引不能动；审批由人（或带 2FA 豁免的 CI）完成
if (stageOnly) {
  console.log('\n✓ 已暂存 ' + pkg.name + '@' + version + '（尚未发布）');
  console.log('  审批后才会真正上线，二选一：');
  console.log('    1) 本人审批：npm stage approve <stage-id>（需要 2FA）');
  console.log('    2) 本脚本审批：node scripts/release.cjs --approve <stage-id>');
  console.log('  查看待审批列表：npm stage list ' + pkg.name + ' --json');
  console.log('  审批通过后再更新索引：node scripts/release.cjs --index-only');
  process.exit(0);
}

// 4) 索引更新是独立一步：发布已经成功，索引失败不该让人以为整次发布失败
updateMarketIndex()
  .then(() => {
    console.log('✓ 发布流程完成：' + pkg.name + '@' + version);
  })
  .catch((error) => {
    fail(
      'npm 已发布 ' + version + '，但 market-index.json 更新失败：' + (error && error.message ? error.message : String(error)),
      '恢复命令：node scripts/release.cjs --index-only',
    );
  });

/** Files this script itself touches; the safe core of a release commit. */
const RELEASE_FILES = ['package.json', 'client.js', 'CHANGELOG.md', 'market-index.json'];

/** Names that should never be committed, whatever the ignore file says. */
const RISKY = [
  /\.npmrc/i,
  /(^|\/)[^/]*token[^/]*\.txt$/i,
  /\.env(\.|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /\.tgz$/i,
  /^dsh-smoke-/,
  /(^|\/)\.{1,2}$/,
];

/**
 * Suggest the narrowest commit that still records the release.
 *
 * A blanket stage of the whole tree would sweep in whatever else it happens to
 * hold, so the script lists the working tree, refuses to recommend anything when a
 * risky path is present, and otherwise names the release files explicitly.
 */
const suggestCommit = () => {
  const status = runCaptured(['status', '--porcelain=v1', '-z']);
  const rows = String(status.output)
    .split('\0')
    .filter((row) => row.trim().length > 3)
    .map((row) => ({ code: row.slice(0, 2).trim(), file: row.slice(3) }));

  const risky = rows.filter((row) => RISKY.some((pattern) => pattern.test(row.file)));
  const unrelated = rows.filter((row) => !RELEASE_FILES.includes(row.file));

  console.log('\n  当前工作树：');
  if (!rows.length) console.log('    （干净，无需提交）');
  for (const row of rows) console.log('    ' + row.code + ' ' + row.file);

  if (risky.length) {
    console.error('\n⚠ 工作树里有不该提交的文件：');
    for (const row of risky) console.error('    ' + row.file);
    console.error('  先把它们移到仓库外或补进 .gitignore，再提交；不要整树暂存。');
  }

  if (unrelated.length && !risky.length) {
    console.log('\n  注意：除发布相关文件外还有其它改动，提交前请逐项确认。');
  }

  if (!risky.length) {
    const addable = rows.filter((row) => RELEASE_FILES.includes(row.file)).map((row) => row.file);
    if (addable.length) {
      console.log('\n  只提交发布相关文件：');
      console.log('    git add ' + addable.join(' ') + ' && git commit -m "release: ' + version + '" && git push');
    }
  }
};

console.log('\n✓ 已发布 ' + version + '');
suggestCommit();
