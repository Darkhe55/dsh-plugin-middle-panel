# Canvas panel

Adds a canvas column beside the conversation in the DeepSeek Harness Web GUI: deliverables produced by the model are opened there, and what you select — text, an element, a region, a face, a video range — comes back to the composer as one numbered message.

```text
┌──────────┬──────────────────────────────┬──────────────────┐
│ Files    │  Canvas (deliverable + notes) │  Conversation    │
│ ▸ docs   │  notes.md | hero.html | ▣    │  user / model    │
│ ▸ src    │  ─────────────────────────   │                  │
│          │  3. notes.md · lines 12-14 ✓ │  ┌────────────┐  │
│          │     > this paragraph is flat │  │ composer   │  │
└──────────┴──────────────────────────────┴──────────────────┘
```

No external network access, no writes outside the workspace, annotations stay on this machine.

## Install

```bash
# npm
dsh plugin --profile desktop add dsh-plugin-middle-panel

# or straight from Git
plugin_manager install_bundle
target: git+https://github.com/Darkhe55/dsh-plugin-middle-panel.git
```

Restart DSH afterwards; if the UI looks unchanged, hard-reload once with `Ctrl+Shift+R`.

Requires DSH `>=0.2.2-rc.1 <0.3.0` and Node `>=24.9.0`. The only runtime dependency is `@deepseek-ai/schemastery`, the schema library DSH itself ships, used to declare the plugin config.

## Quick start

1. Ask the model for a deliverable; it calls the `canvas` tool to open the file.
2. Annotate in the canvas: select text, hover and click an HTML element, drag a region on an image, click a 3D face, or drag a time range in a video.
3. Give each annotation a note, press **发送标注 (N)**, and the numbered text lands in the composer.

```text
以下是我在画布面板中的标注（共 2 条），请按编号逐条处理：

1. `demo/notes.md` — 第 5-6 行
   > - 第一条：这句话写得太平。
   意见：这里改成更具体的说法
```

Ticking an entry (`✓`) keeps its number but drops it from the next send.

You can also open the panel from the **画布** button at the right of the session header.

## What it previews

| Kind | Formats | Annotations |
|---|---|---|
| Web page | `.html` `.htm` | hover highlight, pick element (selector + text), pause and step frames |
| Text | `.md` `.txt` | line range, editable and saveable |
| Image | `.png` `.jpg` `.webp` `.gif` `.bmp` `.svg` | region marquee, colour pick, ruler, `Ctrl` / `Cmd` + wheel zoom; SVG layers are pickable |
| PDF | `.pdf` | text selection, region; encrypted files can be unlocked in place |
| Office | `.docx` `.xlsx` `.pptx` | paragraphs, cells, paged text |
| Sheets | `.csv` `.tsv` | cells |
| 3D | `.stl` `.obj` `.ply` `.off` `.3mf` `.dae` `.glb` `.gltf` | click a triangle face, with face data; re-exported models relocate marks |
| Video | `.mp4` `.m4v` `.webm` `.mov` `.ogv` `.ogg` | time range plus frame region; frame stepping, speed control |
| CAD | `.dxf` | drawing entities |
| Other | `.doc` `.xls` `.ppt` `.step` `.dwg` `.fbx`, … | explains the conversion needed instead of showing bytes |

Oversized models are refused with the reason (192 MB preview ceiling) rather than freezing the panel.

## Panel controls

| Key | Action |
|---|---|
| `?` | help overlay: shortcuts / settings, `←` `→` to switch pages |
| `Ctrl+Tab` | switch tab (`Shift` reverses) |
| `Alt+W` | close the current tab |
| `Alt+\` | side-by-side, press again to leave |
| `Alt+1` / `Alt+2` | focus one of the two panes |
| `Esc` | leave side-by-side, then close help |
| `Alt+S` | pause / resume (HTML animation, video) |
| `Alt+A` / `Alt+D`, `←` / `→` | step one frame back / forward |
| `F` | reset the camera (3D) |
| `1`–`7` | front, back, right, left, top, bottom, isometric (3D) |

Side-by-side: drag the divider to resize, below 860px it stacks vertically, and annotations stay attached to the file rather than the pane.

## Settings

The **Settings** page inside `?`:

| Switch | Default | Effect |
|---|---|---|
| Open new deliverables automatically | on | when the model produces a new file, switch to the canvas and focus it |
| Remember last folder | off | the file picker reopens where you left it |
| Clear after sending | off | empty the list once annotations are sent |
| Hover highlight | on | hovering an annotation highlights its target in the canvas |
| Inject annotation script | on | whether the HTML preview runs the element-picking script |
| Render diagnostics | off | show triangle and draw counters |

With automatic opening off, the model is no longer nudged to open the canvas either: the prompt and the panel behaviour switch together.

The same switch is a plugin **config** field, so it can also be changed where DSH renders this
plugin's configuration: it writes `config.autoOpenNew` on the plugin row in `cordis.patch.yml` and
survives a restart. The panel switch is a view of that value and writes it back.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Saving returns `413` | the request exceeded 6 MiB or the file exceeded 4 MiB; shorten it or split it |
| A tab says the file was moved | the file was renamed or deleted; close the tab, the file on disk is untouched |
| A PDF will not open | encrypted files ask for a password first; otherwise check the path and size in the tab |
| The 3D view stays blank | WebGL may be unavailable; the panel says so, and render diagnostics can help confirm |

## Development

```bash
node scripts/build.cjs    # generate client.js from src/parts/
npm test                  # full suite
```

Client changes need a page reload; host changes (`index.js`) need a DSH restart. See [CHANGELOG.md](CHANGELOG.md) for the implementation history; maintainer rules live in `AGENTS.md` at the repository root.

## Links

- [CHANGELOG.md](CHANGELOG.md)
- [LICENSE](LICENSE)
