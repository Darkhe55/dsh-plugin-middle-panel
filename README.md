# 画布面板 / Canvas panel

在 DeepSeek Harness Web GUI 里把中栏变成 `[画布 | 对话]` 两栏：左边工作区列表不动，中间是交付物画布，右边是原生对话。画布支持文本划选、HTML 元素选取、图片区域框选与 SVG 图层选取，标注按编号回传到输入框。

包名 `dsh-plugin-middle-panel`，以 bundle 形式装在当前 profile（`desktop`）里。

## 安装

- **从市场安装**：在 Plugins → Discover 里添加索引源
  `https://raw.githubusercontent.com/Darkhe55/dsh-plugin-middle-panel/main/market-index.json`，
  然后搜索 `middle-panel`。
- **从 Git 直接安装**（不需要 npm 账号）：
  ```
  plugin_manager install_bundle
  target: git+https://github.com/Darkhe55/dsh-plugin-middle-panel.git#<commit>
  ```
- **本地开发**：`install_bundle` 指向本目录。

兼容 `engines.dsh: >=0.2.2-rc.1 <0.3.0`。

## 用法

1. 会话头部右侧的 **画布** 按钮，或让模型调用 `canvas` 工具（模型调用会自动展开面板）：
   ```json
   { "path": "demo/hero.html", "view": "auto", "note": "配色按设计稿改了" }
   ```
2. 面板打开交付物后：
   - **文本**：划选 → 浮出的「标记第 N 行」；
   - **HTML**：悬停高亮、点一下选中元素（选择器 + 文本）；
   - **图片**：先点「框选区域」再拖矩形；SVG 还会列出可点选的图层。
3. 每条标注可写一句意见，右上角 **发送标注 (N)** 会把下面这种文本填进输入框，用户补一句话即可发送：

```
以下是我在画布面板中的标注（共 2 条），请按编号逐条处理：

1. `demo/notes.md` — 第 5-6 行
   > - 第一条：这句话写得太平。
   意见：这里改成更具体的说法
```

## 实现要点

- 面板注册为全局 `main` key `canvas`（`ctx.layout.selectPanel('canvas')`）。
- 右半是 **原生对话的嵌入式出现**：`props.renderFactorySlot('conversation.content', {})`。框架没有第四列，`root` 槽明确禁止注册，这是唯一不 fork 框架的中间布局。
- 会话身份与输入框 API 由一个零高度桥接组件从 `conversation.composer.dock` 拿：`sessionId` + `inputActions`（`captureInsertion` / `insertText`，失败回退 `setDraft`，再回退剪贴板）。
- 文件读取走 `remote.workspaceFiles`，注意客户端 Remote 返回的是 `{ ok, value }` 信封，必须解包；`remote.workspaceFiles` 也必须写进客户端 `inject`。
- HTML 预览：读文本 → 注入 picker 脚本 → Blob iframe（`sandbox="allow-scripts"`，不给 same-origin），选取结果经 `postMessage` 回传。
- 标注只存客户端（`localStorage`，按 session 分键）；**发送后才进入 session log**，符合“log 是唯一真相”。

## 最近的变化

- 面板头部 **打开**：工作区文件浏览（进目录、点文件即开），空状态也有「打开文件…」。
- 文本视图支持 **编辑 → 保存**（Ctrl+S），写回走 Host 路由，限定在会话自己的工作目录内。
- `.md` 默认 **渲染** 显示，可切「原文」；切换保持阅读位置、不抢焦点。
- 同一文件只保留一个标签（路径归一化）；同一位置重复标注复用原编号。
- 嵌入式对话的 **输入框吸底**：官方吸底依赖 `[data-conversation-composer-overlay]`，嵌入式出现拿不到该标记，插件补上标记并让视图区成为滚动容器、按输入框高度留白。

## 已知限制
- 面板打开时 **右侧栏不可用**（框架只在对话占据主栏时渲染右栏），点「回到对话」恢复。
- 嵌入的对话没有会话头部（标题 / 视图 tab / 右栏开关）；面板顶部只保留「画布 · 路径 · 发送标注 · 回到对话」。
- HTML 预览不做资源打包：相对路径的 CSS/JS/图片在 Blob 里加载不到，内联样式与 data URI 正常。
- 图片没有“真图层”：SVG 走真实图层树，位图只能框选区域（不做 PSD、不做自动分层）。
- **没有文件写回**：面板内不保存文本修改，改动一律以标注形式交给模型（Phase 2 待做）。
- 标注跨设备不同步；换浏览器或清 localStorage 会丢。
- 桌面端页面 origin 是 `dsh-app://app/`，自定义 HTTP 路由需注意跨域。

## 开发

- 改客户端：硬刷新页面（Ctrl+Shift+R）。
- 改 Host 半（`index.js`）：`plugin_manager` 对 `include:dsh-canvas-panel` 禁用再启用，即可热重载。
- 重新安装：`plugin_manager install_bundle` 指向本目录（已安装时先 `remove_bundle`）。
