// 文件选择器的「记住路径」开关：默认关闭、按会话记录、失效时回落根目录。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 开关本身是一个持久化偏好，默认关闭
check(/const pickerPrefs = \{ remember: false \}/.test(src), '默认不记忆');
check(/dsh\.canvas\.picker\.remember/.test(src), '开关状态持久化');
check(/pickerPrefs\.remember = localStorage\.getItem\('dsh\.canvas\.picker\.remember'\) === '1'/.test(src), '读取开关状态');

// 路径按会话存放，避免跨工作区
check(/const pickerPathKey = \(sessionId\) => 'dsh\.canvas\.picker\.path\.' \+ String\(sessionId \|\| ''\)/.test(src), '路径按会话分键');
check(/const readPickerPath = \(sessionId\) =>/.test(src), '有读取函数');
check(/const writePickerPath = \(sessionId, path\) =>/.test(src), '有写入函数');

// 打开时回到上次路径
check(/const resume = remember \? readPickerPath\(sessionId\) : ''/.test(src), '仅开关打开时恢复');
check(/load\(resume\)/.test(src), '打开时用记住的路径加载');

// 成功加载后写回
check(/if \(pickerRemember\(\)\) writePickerPath\(sessionId, resolved\)/.test(src), '加载成功后记录当前路径');

// 目录被删/改名时回落根目录，而不是卡在报错
check(/if \(allowFallback !== false && target !== '\.'\)/.test(src), '失败时允许回落');
check(/writePickerPath\(sessionId, ''\);/.test(src), '清除失效的记住路径');
check(/load\('', false\)/.test(src), '回落到根目录且不再递归回落');

// 工具栏上的开关（可点击、有可见状态）
check(/const \[remember, setRemember\] = React\.useState\(\(\) => pickerRemember\(\)\)/.test(src), '组件持有开关状态');
check(/const toggleRemember = \(\) =>/.test(src), '有切换函数');
check(/if \(next\) writePickerPath\(sessionId, state\.path \|\| ''\)/.test(src), '打开开关时立刻记录当前目录');
check(/'aria-pressed': remember \? 'true' : 'false'/.test(src), '开关有无障碍状态');
check(/remember \? '✓ 记住路径' : '记住路径'/.test(src), '开关有可见文字状态');
check(/\.dshcv-tools>\.dshcv-chip\{flex:0 0 auto;margin-left:auto\}/.test(src), '开关固定在工具栏右侧');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
