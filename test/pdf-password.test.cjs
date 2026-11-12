// 加密 PDF：接管 onPassword，错密码可重试，成功后才收起表单。
const { readSource } = require('./_source.cjs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('function PdfCanvasDoc(props) {');
const end = src.indexOf('function PdfDoc(props) {');
const view = src.slice(start, end);

// 状态与回调
check(view.includes('const [unlock, setUnlock] = React.useState(null);'), '有解锁状态');
check(view.includes('const unlockRef = React.useRef(null);'), '保存 updatePassword');
check(view.includes('task.onPassword = (updatePassword, reason) => {'), '接管 onPassword');
check(view.includes('setUnlock({ wrong: reason === 2 });'), '区分密码错误');
check(view.includes('unlockRef.current = updatePassword;'), '保存重试回调');

// 提交
check(view.includes('const submitPassword = () => {'), '有提交函数');
check(view.includes('const update = unlockRef.current;'), '取最新回调');
check(view.includes('update(value);'), '调用 pdf.js 更新密码');
check(view.includes('setUnlock({ wrong: false, waiting: true });'), '提交后进入等待');

// 成功收起
check(view.includes('unlockRef.current = null;'), '成功后释放回调');
check(view.includes('setUnlock(null);'), '成功后收起表单');

// 界面
check(view.includes('该 PDF 已加密，请输入打开密码'), '有说明文字');
check(view.includes("placeholder: unlock.wrong ? '密码错误，请重试' : '密码',"), '错误提示');
check(view.includes("type: 'password'"), '密码输入框');
check(view.includes('submitPassword();'), '回车与按钮都能提交');
check(src.includes("'.dshcv-pdfunlock{"), '表单有样式');

// 不误判为失败
check(!view.includes('if (state.status === \'failed\') {\n    setUnlock'), '解析失败路径未与密码混用');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
