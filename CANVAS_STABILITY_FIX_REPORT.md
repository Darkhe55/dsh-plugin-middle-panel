# 画布插件高负载稳定性修复报告

日期：2026-11-15
范围：画布插件仓库本身（`canvas-panel`，仅此插件）
基线提交：`beee3dd`（工作区干净）
约束遵守：未启动 DSH / Studio / Firefox / Chrome / HyperFrames / 任何真实媒体预览；全部验证通过
Node 测试与合成数据模拟完成；未发布 npm、未推送远程、未改版本号。

---

## 一、按文件列出的改动摘要

### `src/parts/00-head.js`

| 改动 | 说明 |
|---|---|
| 新增 `runSliced(total, each, options)` | 统一时间分片执行器：默认预算 8ms、硬上限 16ms、每片后让出、每片前后检查 `AbortSignal`，返回 `{ cancelled, processed, slices, maxSliceMs }` |
| 新增 `makeFloatChunks()` | 分块 `Float32Array` 累加器，替代可能上百万 Number 的普通数组；`copyInto`/`release` 明确所有权 |
| 新增资源计数 `counters` + `count()` | `objectUrls` / `pdfTasks` / `observers` / `rafs` / `webglContexts` / `canvasPixels` / `modelTasks` / `relocationTasks` |
| 新增 `createObjectUrl` / `revokeObjectUrl` | 所有 Object URL 走计数包装，创建与释放对称 |
| 新增 `makeObserver()` | 包装 `ResizeObserver`/`MutationObserver`，`disconnect()` 幂等并成对减计数 |
| 新增 `requestFrameTracked` / `cancelFrameTracked` | RAF 计数成对 |
| `relocateSpotMarks(path, positions, radius, options)` | 新增 `options.signal`；每片开始与提交前检查 signal/generation；返回统一结果 `{ cancelled, scannedTriangles, totalTriangles, elapsedMs, matched }`；取消后不 `mutate`/`persist` |
| 网格缓存重写 | 96 MB 预算（硬上限 128 MB）、单项 32 MB 上限、真正的 LRU（get 重新插入）、替换先扣旧字节、`meshCacheClear(reason)`、`releaseMesh`、`meshCacheReport()` |
| 生命周期监听器 | `installLifecycle()` / `uninstallLifecycle()` 单次安装标记，pagehide 时 flush 并清空网格缓存；卸载时移除 |
| `persistDigest` | 从保留整份 4 MB JSON 改为 FNV-1a 短摘要（`hash36:length`），比较语义不变、内存占用从 O(状态) 降到常数 |
| `resourceReport()` | 增加 `meshCache`（entries/bytes/limit/hits/misses/evictions/skipped）与 `active`（模型任务、重定位任务、Object URL、PDF 任务、观察者、RAF、WebGL 上下文、画布像素） |
| 会话切换 | `Bridge` 检测到 session 变化时 `meshCacheClear('session-switch')` |

### `src/parts/90-tail.js`

| 改动 | 说明 |
|---|---|
| 新增模型流水线 | `meshBoundsSliced` / `decimateMeshSliced` / `meshStatsSliced` / `watertightSliced` / `buildModelPreview`，全部可取消、可分片 |
| `decimateMesh`（同步版） | 删除，由 `decimateMeshSliced` 取代：两遍计算（先计数后一次分配 `Float32Array`）、代表点存于分块 `Float32Array`、输出**硬上限** `MAX_PREVIEW_TRIANGLES` 并标记 `truncated` |
| 包围盒 / 面积 / 体积 | 从同步循环改为分片通道，阶段间检查 signal |
| 封闭性 | 独立预算 `WATERTIGHT_BUDGET = { maxTriangles: 120000, maxVertices: 200000, maxEdges: 400000 }`；超限返回 `watertight = null` + `skipped`，界面显示「封闭性未分析」；顶点 ID 改为整数 Map + 数值边键，避免百万字符串键 |
| `ModelDoc` effect | 异步流水线 + `AbortController`；cleanup 里 `abort()`、释放引用；只有未取消时才 `meshRef`、`setState`、`meshCacheSet`、`relocateSpotMarks`；模型任务计数成对增减 |
| 体积保护 | `MAX_PREVIEW_BYTES = 192 MB`，超限给出可读拒绝信息而不是崩溃 |
| 资源计数 | WebGL 上下文、画布像素（backing store）、观察者、PDF 任务接入计数 |

### `src/parts/60-pdf-page.js` / `70-pdf-thumb.js` / `80-pdf-viewer.js`

| 改动 | 说明 |
|---|---|
| PDF renderTask | 记录并在清理时 `cancel()`，`page.cleanup()` 释放页面缓存（上一轮已做），本轮加入 `count('pdfTasks')` 成对计数 |
| 观察者 | `ResizeObserver` 改为 `makeObserver` 包装，计数对称 |

### `index.js`

| 改动 | 说明 |
|---|---|
| `sessionRoots` | 无界 `Map` → 有界 LRU + TTL：上限 256、空闲 30–60 分钟（取 45 分钟）、每次 set/get 轻量清理、`clearSessionRoots()` 在插件卸载时调用 |
| 路径安全 | 未改动 `isInside` / `normalize` / 403 逻辑；仅替换读写入口为 `rememberSessionRoot` / `recallSessionRoot` |

### 测试（新增 4 个文件，更新 4 个）

| 文件 | 覆盖 |
|---|---|
| `test/model-pipeline.test.cjs` | 150 万三角形分片、让出间隔（真实时钟）、取消、A/B 竞争、抽稀硬上限、封闭性预算、预算内结论 |
| `test/mesh-cache.test.cjs` | 字节计数、替换去重、LRU 刷新、超预算淘汰、单项过大跳过、空值不缓存、clear 归零、单键释放 |
| `test/session-roots.test.cjs` | 上限 256、TTL 范围、溢出淘汰、最近使用保留、过期删除、清空、越界拒绝、未知会话 |
| `test/resource-counters.test.cjs` | 100 轮创建/销毁回归基线、帧执行后计数回落、幂等 disconnect、全局监听器只装一套 |
| `test/image-zoom.test.cjs`（更新） | 新增 100 轮挂载/卸载后监听与待执行帧归零 |
| `test/relocate-spot-chunk.test.cjs` / `spot-relocate.test.cjs`（更新） | 注入 `count` 依赖；新增 abort 取消用例 |
| `test/viewer-cleanup.test.cjs`（更新） | 同步到计数包装后的调用名 |

---

## 二、资源所有权 / 创建点 / 取消点 / 释放点

| 资源 | 所有者 | 创建点 | 取消点 | 释放点 |
|---|---|---|---|---|
| 模型解析任务 | `ModelDoc` effect | `run()` 内 `count('modelTasks', 1)` | cleanup `controller.abort()`；`buildModelPreview` 每片检查 | `finally` 中 `count('modelTasks', -1)`；取消后不写 `meshRef`/state/缓存 |
| 模型流水线分片 | `runSliced` | `buildModelPreview` 各阶段 | `signal.aborted` → `{ cancelled: true }` | 分片结束即返回，中间数组由调用方丢弃 |
| 抽稀中间数组 | `decimateMeshSliced` | `makeFloatChunks` + 目标 `Float32Array` | 取消时 `reps.clear()` + `repCoords.release()` | 两遍计算后 `flat` 复制完立即 `release()` |
| 3D 标注重定位 | `relocateSpotMarks` | 调用时 `count('relocationTasks', 1)` | `options.signal` + generation token | 各分支 `count('relocationTasks', -1)`；取消/过期不 `mutate` |
| 网格缓存 | 模块级 LRU | `meshCacheSet` | — | `meshCacheClear`（pagehide / session 切换 / 显式）、`releaseMesh`、超预算淘汰 |
| Object URL | 各 viewer effect | `createObjectUrl` | effect cleanup | `revokeObjectUrl`（计数成对） |
| PDF renderTask | `PdfPage` / `PdfThumb` | `page.render(...)` + `count('pdfTasks', 1)` | cleanup `renderTask.cancel()` | `page.cleanup()`；计数在 cleanup 或 promise 落定时回落 |
| ResizeObserver / MutationObserver | 组件 / bridge | `makeObserver` | `disconnect()` | 包装内幂等减计数 |
| RAF | `perFrame` / 各 effect | `requestAnimationFrame` | `cancelAnimationFrame` / `schedule.cancel()` | 帧回调内或 cancel 时减计数 |
| WebGL 上下文 / 程序 / 着色器 / 缓冲 | 3D effect | `getContext('webgl')`、`link()`、`createBuffer` | effect cleanup | `deleteProgram` / `deleteShader` / `deleteBuffer`；画布像素计数随尺寸更新 |
| 全局 pagehide/visibilitychange | 模块 | `installLifecycle()`（单次） | — | `uninstallLifecycle()` |
| `sessionRoots` | 插件进程 | `rememberSessionRoot` | TTL / 上限淘汰 | 插件卸载 `clearSessionRoots()` |

---

## 三、执行的测试命令与结果

```
node scripts/build.cjs          → build: 10 parts, 559295 → 386237 bytes
node --check client.js          → 0
node --check index.js           → 0
node test/model-pipeline.test.cjs   → 全部通过
node test/mesh-cache.test.cjs       → 全部通过
node test/session-roots.test.cjs    → 全部通过
node test/resource-counters.test.cjs→ 全部通过
node test/image-zoom.test.cjs       → 全部通过（含 100 轮）
node test/relocate-spot-chunk.test.cjs → 全部通过（含 abort）
npm test                        → 83 个测试文件 / 1829 项通过（1 SKIP）
git diff --check                → 0
```

关键数字（本机实测，合成数据）：

| 指标 | 结果 |
|---|---|
| 150 万三角形模型流水线 | 110 片，抽稀到 261,882 三角形，总耗时 ~960 ms |
| 让出间隔（800k 三角形） | 最多 10–15 ms，中位 8–9 ms，超过 16 ms 的片数 0 |
| 抽稀输出上限 | 断言 `triangles <= MAX_PREVIEW_TRIANGLES`，另测 `target=50000` 时输出 ≤ 50000 |
| 封闭性预算 | 超 120,000 三角形直接 `null` + `skipped`，原因 `triangles` |
| 网格缓存 | 默认预算 96 MB；替换同 key 不重复累计；LRU 命中后不被优先淘汰；clear 后字节/项数归零 |
| 资源计数 | 100 轮观察者/ObjectURL/RAF 创建销毁后全部回到 0；全局监听器重复安装只有一套 |
| 重定位 abort | 取消后 Promise 及时结束，标注未被写入 |

---

## 四、仍未覆盖的真实环境风险

1. **真实 GPU 行为未验证**：WebGL 上下文丢失（`webglcontextlost`）、驱动级内存回收、集成显卡上的大纹理行为，只能在真实 DSH 里观察。本轮只保证不泄漏程序/着色器/缓冲与画布像素上界。
2. **未接入 Worker**：当前构建把 10 个 part 拼成单文件 IIFE，Worker 需要额外打包路径；已用统一分片执行器替代，单次同步块实测 ≤ 15 ms，但分片仍占用主线程（只是被打断）。
3. **100 次挂载/卸载是模拟**：仓库没有 jsdom，计数测试通过生产代码中的同一批包装函数（`makeObserver` / `createObjectUrl` / `requestFrameTracked` / `attachImageZoom`）驱动，未真正渲染 React 组件树。真实 React 生命周期下的清理仍需要一次人工验证。
4. **封闭性预算触发后没有渐进式替代方案**：超限时直接给「未分析」，未提供后台分批建边表的选项。
5. **`sessionRoots` 的 45 分钟 TTL 是经验值**：若宿主长时间不触发 `workingDirectory.ensure`，回退可能失效；实时 session store 仍是首选路径（未改动）。
6. **持久化摘要碰撞**：`hash36:length` 理论上可能对两段不同文本给出相同摘要，届时会跳过一次写入；概率极低且下一条变更会补齐，但这是可靠性换内存的取舍。
7. **真实超大文件**：`MAX_PREVIEW_BYTES = 192 MB` 与抽稀上限是静态阈值，未在真实 500 MB 模型上验证拒绝路径的提示文案与用户体验。

---

## 五、首次真实验证的建议步骤（分阶段，勿同时开 HyperFrames）

1. 只启动 DSH，打开面板，确认帮助/快捷键与资源报告正常；
2. 打开小文本、小图片（验证滚轮缩放）、小 PDF（验证翻页与 renderTask），逐个关闭；
3. 打开小 3D 模型（<5 MB）：预览 → 旋转 → 打点标注 → 切走再切回（验证缓存命中与重定位）；
4. 打开一个 50–150 MB 的模型：观察是否出现「封闭性未分析」，面板是否保持可交互；
5. 在模型解析过程中立即切到别处：确认没有报错、没有残留任务（可用 `localStorage.dsh.canvas.debug=1` 查看 `resourceReport()` 的 `active` 计数）；
6. 全部通过后再测试超大模型（>192 MB）的拒绝提示。

---

## 六、结论

本轮把 3D 大模型的同步长任务全部改为可取消的时间分片，给网格缓存与 `sessionRoots` 加了确定的上界，让重定位支持真正的卸载取消，并把资源计数做成对称可诊断的形态。原有功能（预览、旋转/缩放/拾取、统计、3D 标注、重定位、缓存命中）保持，全部 1829 项测试通过。
