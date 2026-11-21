# 维护者须知（仓库约定）

这是**给维护者与自动化代理**看的约定文件，不是使用文档。使用者文档在 `README.md` / `README.en.md`，行为变更在 `CHANGELOG.md`。

## 一、不要替用户做发布决定

- 只有用户明确要求「发布 X.Y.Z」时，才允许改 `package.json.version`、打 tag、跑 `npm publish`。
- 平时的改动只写 `CHANGELOG.md` 顶部的「未发布」段落；**不要**动版本号，**不要**动 `market-index.json`。
- `market-index.json` 只能记录 registry 上真实存在的版本。`node scripts/release.cjs --index-only` 会先查询 registry，查不到就拒绝写入——不要绕过它手工填写时间戳。

这些规则一旦被破坏，使用者会看到一个装不到的「新版本」提示。

发布流程的细节（暂存发布、审批、恢复命令）留在本机维护者资料里，不写进仓库。

## 二、仓库里放什么

| 进仓库 | 不进仓库 |
|---|---|
| 可部署源码：`index.js`、`save-guard.js`、`vendor-route.js`、`client.js`、`src/parts/` | 审计报告、验证清单、设计草稿 |
| 构建与发布工具：`scripts/` | 本机测量输出、临时脚本、截图 |
| 测试：`test/`（CI 依赖） | 与具体机器相关的路径或账号信息 |
| 使用者文档：`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE` | 凭据、`.env`、私钥、token |
| 清单与元数据：`market-index.json`、`cordis.patch.yml`、`icon.svg` | |

判断标准：**使用者装完需要的东西进仓库；只有维护者需要读的东西不进。**

## 三、改完必须做的检查

```bash
node scripts/build.cjs          # client.js 由源码生成，不要手改
node --check client.js          # 语法
npm test                        # 全量测试
git diff --check                # 空白错误
```

推送前再做一次敏感扫描：token、私钥标记、本机绝对路径。

## 四、界面文案的两种读者

- 使用者会看到的提示（面板、错误、拒绝原因）要写清楚**发生了什么、能做什么**，例如「文件不存在或已被移动 → 关闭标签」；
- 内部诊断（计数、预算、耗时）默认静默，只有 `localStorage['dsh.canvas.debug'] = '1'` 时才输出，并通过 `__dshCanvasReport()` 读取。
