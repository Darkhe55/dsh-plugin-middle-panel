# Middle panel / Canvas panel

Turns the centre column of the DeepSeek Harness Web GUI into a two-pane workspace: `[canvas | conversation]`. The workspace list stays on the left, the deliverable is in the middle, the native conversation is on the right.

The canvas supports text selection, HTML element picking, image region marquee and SVG layer picking. Annotations are numbered and sent back to the composer.

Package `dsh-plugin-middle-panel`, installed as a bundle in the current profile.

## Usage

1. Click **画布 / Canvas** at the right of the session header, or let the model call the `canvas` tool (the panel opens automatically):
   ```json
   { "path": "demo/hero.html", "view": "auto", "note": "colors follow the new spec" }
   ```
2. In the panel:
   - **text**: select lines → "标记第 N 行";
   - **HTML**: hover to highlight, click to pick an element (selector + text);
   - **image**: click "框选区域" then drag a rectangle; SVG also lists clickable layers.
3. Give each annotation a note, then **发送标注 (N)** fills the composer with:

```
以下是我在画布面板中的标注（共 2 条），请按编号逐条处理：

1. `demo/notes.md` — 第 5-6 行
   > - 第一条：这句话写得太平。
   意见：这里改成更具体的说法
```

## How it works

- The panel registers as the global `main` key `canvas` (`ctx.layout.selectPanel('canvas')`).
- The right half is the **native conversation rendered as an embedded occurrence**: `props.renderFactorySlot('conversation.content', {})`. The frame has no fourth column and the `root` slot forbids registration, so this is the only middle layout that does not fork the frame.
- Session identity and composer APIs come from a zero-height bridge registered in `conversation.composer.dock`: `sessionId` plus `inputActions` (`captureInsertion` / `insertText`, falling back to `setDraft`, then the clipboard).
- File reads go through `remote.workspaceFiles`. The client Remote answers with a `{ ok, value }` envelope — unwrap it — and `remote.workspaceFiles` must be listed in the client module's `inject`.
- HTML preview: read the text, inject the picker script, serve a Blob iframe (`sandbox="allow-scripts"`, no same-origin); picks travel back over `postMessage`.
- Annotations live in the browser (`localStorage`, keyed per session); only sending them enters the Session log.

## Limits

- While the panel is open the **right sidebar is unavailable** (the frame only reserves that track while the conversation fills the centre); "回到对话" restores it.
- The embedded conversation has no session header (title / view tabs / right-sidebar toggle).
- HTML preview does not bundle assets: relative CSS/JS/images do not load, inline styles and data URIs do.
- No "real" image layers: SVG uses its own layer tree, raster images only support region marquee.
- **No file write-back**: edits go to the model as annotations (planned).
- Annotations do not sync across devices.

## Development

- Client changes: hard-reload the page (Ctrl+Shift+R).
- Host changes (`index.js`): disable and re-enable the `include:dsh-plugin-middle-panel` row through `plugin_manager`.
- Reinstall: point `plugin_manager install_bundle` at this directory (remove the old bundle first).
