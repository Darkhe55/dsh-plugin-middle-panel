const { readSource } = require('./_source.cjs');
// 分词器的真实行为：不是文本形状，而是真的把代码切成带类名的片段。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// 抽出模块级的分词器实现并求值
const start = src.indexOf('    const CODE_LANG = {');
const end = src.indexOf('    const parseTime = (text) => {');
if (start < 0 || end < 0) {
  console.log('FAIL 锚点缺失');
  process.exit(1);
}
const api = new Function(src.slice(start, end) + '\nreturn { codeLangOf, buildCodeLines };')();

const flat = (tokens) => tokens.map(([text]) => text).join('');
const classesOf = (tokens) => tokens.map(([, cls]) => cls).filter(Boolean);
const textOf = (tokens, cls) => tokens.filter(([, c]) => c === cls).map(([t]) => t).join('');

// —— 语言识别 ——
check(api.codeLangOf('a.ts') === 'ts', 'ts');
check(api.codeLangOf('a.tsx') === 'ts', 'tsx');
check(api.codeLangOf('main.py') === 'py', 'py');
check(api.codeLangOf('README.md') === '', 'md 不算代码');
check(api.codeLangOf('x.unknownext') === '', '未知扩展名不猜');

// —— JS ——
const js = api.buildCodeLines('const a = call(42); // tail\nlet s = "hi";', 'js');
check(flat(js[0]) === 'const a = call(42); // tail', '不改动原文', flat(js[0]));
check(textOf(js[0], 'kw') === 'const', '关键字 const', textOf(js[0], 'kw'));
check(textOf(js[0], 'fn') === 'call', '调用点标记为函数', textOf(js[0], 'fn'));
check(textOf(js[0], 'num') === '42', '数字', textOf(js[0], 'num'));
check(textOf(js[0], 'com') === '// tail', '行注释', textOf(js[0], 'com'));
check(textOf(js[1], 'str') === '"hi"', '字符串', textOf(js[1], 'str'));
check(textOf(js[1], 'kw') === 'let', '第二行关键字', textOf(js[1], 'kw'));

// —— 块注释跨行 ——
const block = api.buildCodeLines('/* start\nmiddle\nend */ code()', 'js');
check(classesOf(block[0]).includes('com'), '块注释第一行');
check(classesOf(block[1]).every((c) => c === 'com'), '块注释中间行全是注释');
check(classesOf(block[2]).includes('com') && classesOf(block[2]).includes('fn'), '块注释结束后恢复正常');

// —— 字符串里的注释符号不误判 ——
const tricky = api.buildCodeLines('const u = "http://x"; // real', 'js');
check(textOf(tricky[0], 'str') === '"http://x"', '字符串内 // 不算注释', textOf(tricky[0], 'str'));
check(textOf(tricky[0], 'com') === '// real', '真正注释仍识别');

// —— Python ——
const py = api.buildCodeLines('def f(x):\n    return x + 1  # add', 'py');
check(textOf(py[0], 'kw') === 'def', 'py def');
check(textOf(py[0], 'fn') === 'f', 'py 函数名');
check(textOf(py[1], 'com') === '# add', 'py 注释');

// —— HTML ——
const html = api.buildCodeLines('<div class="box" data-x="1">hi</div>', 'html');
check(textOf(html[0], 'tag') === 'divdiv', '标签名成对出现', textOf(html[0], 'tag'));
check(textOf(html[0], 'attr') === 'classdata-x', '属性名', textOf(html[0], 'attr'));
check(textOf(html[0], 'str') === '"box""1"', '属性值', textOf(html[0], 'str'));

// —— JSON ——
const json = api.buildCodeLines('{"a": 1, "b": true}', 'json');
check(textOf(json[0], 'num') === '1', 'json 数字');
check(textOf(json[0], 'kw') === 'true', 'json 布尔');
check(textOf(json[0], 'str') === '"a""b"', 'json 键仍是字符串');

// —— 大文件预算 ——
const big = api.buildCodeLines(Array.from({ length: 4100 }, () => 'const a = 1;').join('\n'), 'js');
check(big.length === 4100, '行数不变');
check(classesOf(big[3999]).includes('kw'), '预算内正常高亮');
check(classesOf(big[4000]).length === 0, '超出预算退化为纯文本');

// —— 空行与 null ——
check(api.buildCodeLines('', 'js').length === 1, '空文本仍是一行');
check(api.buildCodeLines('x', '') === null, '无语言返回 null');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
