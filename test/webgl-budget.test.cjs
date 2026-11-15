// WebGL 资源与像素预算的静态约束：程序/着色器必须被删除，尺寸必须封顶。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const webglStart = src.indexOf("const gl = canvas.getContext('webgl'");
const webglEnd = src.indexOf('}, [state.status, options, doc.path]);', webglStart);
if (webglStart < 0 || webglEnd < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const block = src.slice(webglStart, webglEnd);

// 创建后被记录
check(/const createdShaders = \[\];/.test(block), '着色器被登记');
check(/const createdPrograms = \[\];/.test(block), '程序被登记');
check(/createdShaders\.push\(shader\)/.test(block), '创建着色器时记录');
check(/createdPrograms\.push\(program\)/.test(block), '创建程序时记录');

// 清理时删除
check(/gl\.deleteProgram\(program\)/.test(block), '清理时删除程序');
check(/gl\.deleteShader\(shader\)/.test(block), '清理时删除着色器');
check(/gl\.deleteBuffer\(solidBuffer\)/.test(block), '清理时删除顶点缓冲');

// 像素预算
check(/const MAX_CANVAS_PIXELS = \d+ \* 1024;/.test(src), '定义了画布像素上限');
check(/Math\.min\(2, dpr, budget\)/.test(block), 'devicePixelRatio 上限 2 且受像素预算约束');
check(/Math\.sqrt\(MAX_CANVAS_PIXELS/.test(block), '按像素预算反推缩放比');

// 不得在每次重建时丢掉上下文（否则后续 getContext 拿到的是已丢失的上下文）
check(!/forceContextLoss|loseContext/.test(block), '不在重建时丢失 WebGL 上下文');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
