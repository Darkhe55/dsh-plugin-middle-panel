// 每帧合并器：一帧内多次触发只执行一次，可取消，超频只记录一次。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const perFrame = (run, label) => {');
const end = src.indexOf('const subscribe = (listener) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 受控的 requestAnimationFrame：手动推进帧。 */
const makeFrames = () => {
  const queue = new Map();
  let nextId = 1;
  const logs = [];
  const raf = (fn) => {
    const id = nextId++;
    queue.set(id, fn);
    return id;
  };
  const cancel = (id) => queue.delete(id);
  const tick = () => {
    const pending = Array.from(queue.entries());
    queue.clear();
    for (const [, fn] of pending) fn(16);
    return pending.length;
  };
  return { raf, cancel, tick, pending: () => queue.size, logs };
};

const run = () => {
  // 1) 同帧内 1000 次触发只跑一次
  {
    const frames = makeFrames();
    let runs = 0;
    const schedule = new Function(
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'devlog',
      'Date',
      body + '\nreturn perFrame;',
    )(frames.raf, frames.cancel, () => {}, Date)(() => {
      runs += 1;
    }, 'test');
    for (let i = 0; i < 1000; i += 1) schedule();
    check(frames.pending() === 1, '1000 次触发只排一个帧', String(frames.pending()));
    frames.tick();
    check(runs === 1, '一帧只执行一次回调', String(runs));
    // 下一帧再触发应当再执行一次
    schedule();
    frames.tick();
    check(runs === 2, '后续帧仍会执行', String(runs));
  }

  // 2) cancel 之后不会再执行
  {
    const frames = makeFrames();
    let runs = 0;
    const schedule = new Function(
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'devlog',
      'Date',
      body + '\nreturn perFrame;',
    )(frames.raf, frames.cancel, () => {}, Date)(() => {
      runs += 1;
    }, 'test');
    schedule();
    schedule.cancel();
    check(frames.pending() === 0, 'cancel 清掉了待执行的帧');
    frames.tick();
    check(runs === 0, '取消后不再执行');
  }

  // 3) 超频只记录一次，且不阻塞
  {
    let nowValue = 0;
    const fakeDate = { now: () => nowValue };
    const frames = makeFrames();
    const logs = [];
    const schedule = new Function(
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'devlog',
      'Date',
      body + '\nreturn perFrame;',
    )(frames.raf, frames.cancel, (name) => logs.push(name), fakeDate)(() => {}, 'observer');
    for (let second = 0; second < 3; second += 1) {
      nowValue = second * 1000;
      for (let i = 0; i < 500; i += 1) schedule();
      frames.tick();
    }
    check(logs.filter((name) => name === 'observer-rate').length === 1, '超频只记录一次', String(logs.length));
  }

  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
};

run();
