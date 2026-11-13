// 保存写入口的守卫：请求体按字节在读取中截断、文本按 UTF-8 字节、base64 解码后再判，
// 以及真实路径（含符号链接 / Windows junction）必须落在工作区内。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guardUrl = pathToFileURL(path.join(here, '..', 'save-guard.js')).href;
const guard = await import(guardUrl);
const {
  MAX_BODY_BYTES,
  MAX_SAVE_BYTES,
  BodyTooLarge,
  OutsideWorkspace,
  readCappedBody,
  textTooLarge,
  utf8Bytes,
  decodeCappedBase64,
  resolveWriteTarget,
} = guard;

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const miB = 1024 * 1024;

// ---------- 请求体：读取过程中截断 ----------

const chunkStream = (size, chunkSize) => {
  let sent = 0;
  return {
    sent: () => sent,
    async *[Symbol.asyncIterator]() {
      while (sent < size) {
        sent += chunkSize;
        yield Buffer.alloc(chunkSize);
      }
    },
  };
};

{
  // 上限 6 MiB，喂 1 KiB 块：必须在读满上限时停下，而不是读完 20 MiB。
  const stream = chunkStream(20 * miB, 1024);
  let threw = null;
  try {
    await readCappedBody(stream, true);
  } catch (error) {
    threw = error;
  }
  check(threw instanceof BodyTooLarge, '超大请求体被拒绝', threw && threw.name);
  check(
    stream.sent() <= MAX_BODY_BYTES + 2 * 1024,
    '读取过程中就中止（未读完整个流）',
    '已读 ' + stream.sent() + ' 字节',
  );
}

{
  const ok = await readCappedBody(chunkStream(1000, 100), true);
  check(ok.length === 1000, '正常大小的请求体可读完');
}

// ---------- 文本：UTF-8 字节数 ----------

{
  const cjk = '中'.repeat(4_000_000); // 4,000,000 个字符 = 12 MB UTF-8
  check(utf8Bytes(cjk) === 12_000_000, '400 万中文字符合计 12 MB', String(utf8Bytes(cjk)));
  check(textTooLarge(cjk), '400 万中文字符无法绕过 4 MiB 限制');
  check(!textTooLarge('a'.repeat(MAX_SAVE_BYTES)), '4 MiB 边界值可以通过');
  check(textTooLarge('a'.repeat(MAX_SAVE_BYTES + 1)), '超出 1 字节即拒绝');
}

// ---------- base64：解码后再判 ----------

{
  const big = Buffer.alloc(MAX_SAVE_BYTES + 1, 7);
  let threw = null;
  try {
    decodeCappedBase64(big.toString('base64'));
  } catch (error) {
    threw = error;
  }
  check(threw instanceof BodyTooLarge, 'base64 解码后超限返回 413 语义', threw && threw.name);

  const exact = Buffer.alloc(MAX_SAVE_BYTES, 7);
  const decoded = decodeCappedBase64(exact.toString('base64'));
  check(decoded.length === MAX_SAVE_BYTES, 'base64 解码后正好 4 MiB 可保存', String(decoded.length));
}

// ---------- 路径：真实路径必须在工作区内 ----------

const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-'));
const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-outside-'));
await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');

{
  const place = await resolveWriteTarget(fsp, workspace, path.join(workspace, 'note.md'));
  check(
    place.realTarget === path.join(await fsp.realpath(workspace), 'note.md'),
    '工作区内普通路径被接受',
    place.realTarget,
  );
}

{
  let threw = null;
  try {
    await resolveWriteTarget(fsp, workspace, path.join(workspace, '..', 'escape.txt'));
  } catch (error) {
    threw = error;
  }
  check(threw instanceof OutsideWorkspace, '../ 越界被拒绝', threw && threw.name);
}

{
  const link = path.join(workspace, 'link-out.txt');
  let created = true;
  try {
    await fsp.symlink(path.join(outside, 'secret.txt'), link, 'file');
  } catch {
    created = false;
  }
  if (!created) {
    console.log('SKIP 符号链接不可用（需要开发者模式或权限）');
  } else {
    let threw = null;
    try {
      await resolveWriteTarget(fsp, workspace, link);
    } catch (error) {
      threw = error;
    }
    check(threw instanceof OutsideWorkspace, '指向工作区外部的 symlink 被拒绝', threw && threw.name);
  }
}

{
  const dirLink = path.join(workspace, 'dir-out');
  let created = true;
  try {
    await fsp.symlink(outside, dirLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    created = false;
  }
  if (!created) {
    console.log('SKIP 目录联接不可用');
  } else {
    let threw = null;
    try {
      await resolveWriteTarget(fsp, workspace, path.join(dirLink, 'secret.txt'));
    } catch (error) {
      threw = error;
    }
    const label = process.platform === 'win32' ? 'Windows junction 指向外部时被拒绝' : '目录符号链接指向外部时被拒绝';
    check(threw instanceof OutsideWorkspace, label, threw && threw.name);
  }
}

{
  // 工作区内的子目录链接是允许的
  const inner = path.join(workspace, 'sub');
  await fsp.mkdir(inner, { recursive: true });
  const place = await resolveWriteTarget(fsp, workspace, path.join(inner, 'ok.txt'));
  check(place.realTarget.startsWith(await fsp.realpath(workspace)), '工作区内的子目录写入被接受');
}

await fsp.rm(workspace, { recursive: true, force: true });
await fsp.rm(outside, { recursive: true, force: true });

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
