// 开关现在是真正的插件配置：schema 默认开、只接受布尔；宿主 apply 采用配置值并据此选提示词。
let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const main = async () => {
  const mod = await import('../index.js');
  const { Config, apply } = mod;

  // 1) 声明了 Config，且是一个 schema（可调用、带 object 字段）
  check(Boolean(Config), '导出了 Config');
  check(typeof Config === 'function', 'Config 是 schema 函数', typeof Config);

  // 2) 默认值：开
  const defaults = Config({});
  check(defaults.autoOpenNew === true, '默认开启', JSON.stringify(defaults));

  // 3) 只接受布尔值
  const on = Config({ autoOpenNew: false });
  check(on.autoOpenNew === false, '接受 false');
  let rejected = false;
  try {
    Config({ autoOpenNew: 'no' });
  } catch {
    rejected = true;
  }
  check(rejected, '拒绝非布尔值');

  // 4) apply 是函数，且接收配置（签名 arity 至少 2：ctx, config）
  check(typeof apply === 'function', '导出了 apply');
  check(apply.length >= 2, 'apply 接收 config 参数', String(apply.length));

  // 5) 未声明其他字段，避免把内部状态暴露成用户配置
  check(Object.keys(defaults).length === 1 && defaults.autoOpenNew === true, '配置里只有一个开关', Object.keys(defaults).join(','));

  // 6) 宿主仍然导出工具（防止改坏既有导出）
  check(typeof mod.writeIsStale === 'function', '既有导出未受影响');
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
