const { readSource } = require('./_source.cjs');
// A5: sending one mark and the auto-clear preference must not fight each other.
const fs = require('fs');
const src = readSource();
const start = src.indexOf('const sendOneMark = (mark) => {');
const end = src.indexOf('const exportMarks = () => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(
  'store',
  'sendPrefs',
  'insertIntoComposer',
  'copyMark',
  'markToBlock',
  'mutate',
  'persist',
  src.slice(start, end) + '\nreturn sendOneMark;',
);

const setup = ({ insert = 'ok', autoClear = false, marks = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] } = {}) => {
  const state = { store: { marks }, copies: 0, persisted: 0, inserted: '' };
  const sendOneMark = factory(
    state.store,
    { autoClear },
    (text) => {
      state.inserted = text;
      return insert;
    },
    () => {
      state.copies += 1;
    },
    (mark) => 'block#' + mark.id + '\n',
    (partial) => {
      state.store.marks = partial.marks;
    },
    () => {
      state.persisted += 1;
    },
  );
  return { state, sendOneMark };
};

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 关闭"发后清空"：发完留在列表里
let run = setup();
let result = run.sendOneMark({ id: 'a', n: 1 });
check(result === 'ok', '发送成功返回 ok');
check(run.state.inserted.includes('block#a'), '插入的是这一条的内容');
check(run.state.store.marks.length === 2, '未开启清空时保留全部标注', String(run.state.store.marks.length));
check(run.state.persisted === 0, '未开启清空时不写存储');

// 开启"发后清空"：只移除这一条
run = setup({ autoClear: true });
result = run.sendOneMark({ id: 'a', n: 1 });
check(run.state.store.marks.length === 1, '开启清空时只移除发送的那一条', String(run.state.store.marks.length));
check(run.state.store.marks[0].id === 'b', '留下的是没发送的那条', run.state.store.marks[0].id);
check(run.state.persisted === 1, '移除后持久化一次');

// 插入失败：回退到复制，且不清空
run = setup({ insert: 'failed', autoClear: true });
result = run.sendOneMark({ id: 'a', n: 1 });
check(result === 'failed', '插入失败时返回失败');
check(run.state.copies === 1, '失败时复制到剪贴板作为兜底');
check(run.state.store.marks.length === 2, '失败时不清空任何标注');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
