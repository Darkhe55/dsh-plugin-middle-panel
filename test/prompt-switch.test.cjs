// 提示词与开关同步：开关是「双重保险」，客户端自动展开与提示词必须一起切换。
// index.js 是 ESM，这里用动态 import 从 CommonJS 测试里加载。
let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const main = async () => {
  const { promptFor, PROMPT_ON, PROMPT_OFF, PROMPT_BASE } = await import('../prompt-variants.js');

  const on = promptFor(true);
  const off = promptFor(false);

  // 1) 两版都保留基础说明，避免模型完全不知道画布存在
  check(on.startsWith(PROMPT_BASE), '开启版包含基础说明');
  check(off.startsWith(PROMPT_BASE), '关闭版包含基础说明');

  // 2) 开启版：鼓励打开新产物
  check(/open that new file/i.test(on), '开启版要求打开新产物', on.slice(-120));
  check(/canvas/i.test(on), '开启版提到 canvas 工具');

  // 3) 关闭版：明确不主动打开
  check(/do not open it on your own initiative/i.test(off), '关闭版要求不主动打开', off.slice(-140));
  check(!/open that new file/i.test(off), '关闭版不含「打开新产物」的指令');

  // 4) 两版不同，缺省按开启处理
  check(on !== off, '两版内容不同');
  check(promptFor(undefined) === PROMPT_ON, '缺省值按开启处理');
  check(promptFor(false) === PROMPT_OFF && promptFor(true) === PROMPT_ON, '布尔值映射正确');

  // 5) 标注回填的说明必须两边都在，否则模型会忽略标注消息
  const annotations = /numbered annotations/i;
  check(annotations.test(on) && annotations.test(off), '两版都说明标注会以编号消息回传');

  // 6) 长度可控：提示词是每轮都要发的上下文开销
  check(on.length < 1400 && off.length < 1400, '两版长度都在预算内', on.length + ' / ' + off.length);
};

main()
  .then(() => {
    if (failures) {
      console.log('失败 ' + failures + ' 项');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.log('FAIL 测试抛错 → ' + (error && error.stack));
    process.exit(1);
  });
