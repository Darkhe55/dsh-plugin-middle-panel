/**
 * Client half of the canvas panel bundle.
 *
 * The panel is a global `main` panel, so the middle column becomes
 *   [canvas | live conversation occurrence]
 * and the frame keeps the workspace list on the left.
 *
 * The conversation half is the shipped Conversation Factory rendered as an
 * embedded occurrence; the canvas half is ours.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-middle-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_KEY = 'canvas';
    const STORAGE_PREFIX = 'dsh.canvas.v1.';

    const errText = (error) => (error && error.message ? error.message : String(error));
    const basename = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');

    // One file, one tab: the model may name the same file as `a/b`, `./a/b`,
    // `a\b`, or an absolute path; compare the normalized form.
    const normalizePath = (path) => {
      let value = String(path || '').trim().replace(/\\/g, '/');
      while (value.startsWith('./')) value = value.slice(2);
      value = value.replace(/\/{2,}/g, '/');
      if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
      return value;
    };
    const pathKey = (path) => normalizePath(path).replace(/^[a-z]:/i, (drive) => drive.toLowerCase());
    const isAbsolutePath = (path) => /^[a-z]:\//i.test(path) || path.startsWith('/');
    const sameFile = (left, right) => {
      const a = pathKey(left);
      const b = pathKey(right);
      if (!a || !b) return false;
      if (a === b) return true;
      // An absolute and a workspace-relative spelling of the same file.
      if (isAbsolutePath(a) === isAbsolutePath(b)) return false;
      const absolute = isAbsolutePath(a) ? a : b;
      const relative = isAbsolutePath(a) ? b : a;
      return absolute.endsWith('/' + relative);
    };

    // Diagnostics stay silent in the delivered plugin; point this at
    // console.debug while iterating on a viewer.
    const devlog = () => {};

    // ---------------- tiny shared store ----------------
    const listeners = new Set();
    let version = 0;
    /** Tool calls whose panel opening already happened; a remounted card must not reopen it. */
    const autoOpened = new Set();
    const store = {
      sessionId: undefined,
      actions: undefined,
      docs: [],
      activeId: undefined,
      marks: [],
      seq: 0,
      restored: false,
      reportedBridge: false,
      reportedBlock: false,
    };
    const notify = () => {
      version += 1;
      for (const listener of Array.from(listeners)) listener();
    };    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const useVersion = () => React.useSyncExternalStore(subscribe, () => version);
    const mutate = (patch) => {
      Object.assign(store, patch);
      notify();
    };

    const storageKey = () => STORAGE_PREFIX + (store.sessionId || 'none');

    const persist = () => {
      try {
        localStorage.setItem(
          storageKey(),
          JSON.stringify({
            docs: store.docs,
            activeId: store.activeId,
            marks: store.marks,
            seq: store.seq,
          }),
        );
      } catch (error) {
        devlog('persist-failed', [errText(error)]);
      }
    };

    // Heal state saved by earlier builds: one tab per file, one number per spot.
    const dedupeDocs = (docs) => {
      const kept = [];
      for (const doc of docs) {
        if (!doc || typeof doc.path !== 'string') continue;
        if (kept.some((existing) => sameFile(existing.path, doc.path))) continue;
        kept.push(doc);
      }
      return kept;
    };
    const dedupeMarks = (marks) => {
      const kept = [];
      for (const mark of marks) {
        if (!mark || typeof mark.path !== 'string') continue;
        if (kept.some((existing) => sameLocator(existing, mark))) continue;
        kept.push(mark);
      }
      return kept;
    };

    const restore = () => {
      if (store.restored || !store.sessionId) return;
      store.restored = true;
      try {
        const raw = localStorage.getItem(storageKey());
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.docs)) store.docs = dedupeDocs(data.docs);
        if (Array.isArray(data.marks)) store.marks = dedupeMarks(data.marks);
        if (typeof data.activeId === 'string') store.activeId = data.activeId;
        const highest = store.marks.reduce((max, mark) => Math.max(max, Number(mark.n) || 0), 0);
        store.seq = Math.max(Number(data.seq) || 0, highest);
        if (!store.docs.some((doc) => doc.id === store.activeId)) store.activeId = store.docs.length ? store.docs[0].id : undefined;
        devlog('restored', ['docs=' + store.docs.length, 'marks=' + store.marks.length]);
      } catch (error) {
        devlog('restore-failed', [errText(error)]);
      }
    };

    const fileKind = (path) => {
      const match = /\.([a-z0-9]+)$/i.exec(String(path || ''));
      const ext = match ? match[1].toLowerCase() : '';
      if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
      if (['md', 'markdown'].includes(ext)) return 'markdown';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
      if (['csv', 'tsv', 'xlsx', 'xls', 'pdf', 'docx', 'pptx'].includes(ext)) return 'text';
      return 'text';
    };

    const resolveView = (requested, path) =>
      !requested || requested === 'auto' ? fileKind(path) : requested;

    const findMark = (id) => store.marks.find((mark) => mark.id === id);

    // The same spot keeps its number: marking it again only refreshes the quote.
    const sameLocator = (left, right) => {
      if (left.kind !== right.kind || !sameFile(left.path, right.path)) return false;
      if (left.kind === 'text') return Boolean(left.lines && right.lines) && left.lines[0] === right.lines[0] && left.lines[1] === right.lines[1];
      if (left.kind === 'element' || left.kind === 'layer') return left.selector === right.selector;
      if (left.kind === 'region') {
        const a = left.rect || [];
        const b = right.rect || [];
        return a.length === b.length && a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= 2);
      }
      return false;
    };

    const upsertMark = (mark) => {
      const existing = store.marks.find((candidate) => sameLocator(candidate, mark));
      if (existing) {
        mutate({
          marks: store.marks.map((candidate) =>
            candidate.id === existing.id ? Object.assign({}, candidate, { quote: mark.quote || candidate.quote }) : candidate,
          ),
        });
        persist();
        devlog('mark-reused', ['n=' + existing.n]);
        return existing.n;
      }
      const n = store.seq + 1;
      const created = Object.assign({ id: 'm' + Date.now().toString(36) + n, n, note: '' }, mark);
      mutate({ marks: store.marks.concat(created), seq: n });
      persist();
      devlog('mark-added', ['n=' + n, 'kind=' + created.kind]);
      return n;
    };

    const addTextMark = (path, startLine, endLine, quote) => {
      if (!path) return 0;
      return upsertMark({
        kind: 'text',
        path: normalizePath(path),
        lines: [startLine, endLine],
        quote: String(quote || '').slice(0, 1200),
      });
    };

    const addMark = (partial) => {
      if (!partial || !partial.path) return 0;
      return upsertMark(Object.assign({}, partial, { path: normalizePath(partial.path) }));
    };

    const setMarkNote = (id, note) => {
      mutate({
        marks: store.marks.map((mark) => (mark.id === id ? Object.assign({}, mark, { note }) : mark)),
      });
      persist();
    };

    const removeMark = (id) => {
      mutate({ marks: store.marks.filter((mark) => mark.id !== id) });
      persist();
    };

    const clearMarks = () => {
      mutate({ marks: [], seq: 0 });
      persist();
    };

    const openDoc = (input) => {
      const path = normalizePath(input && input.path);
      if (!path) return;
      const view = resolveView(input && input.view, path);
      if (!store.sessionId) {
        store.pending = { path, view: input && input.view, note: input && input.note, line: input && input.line };
        devlog('doc-pending', ['path=' + path]);
        return;
      }
      const existing = store.docs.find((doc) => sameFile(doc.path, path));
      let docs;
      let activeId;
      if (existing) {
        docs = store.docs.map((doc) =>
          doc.id === existing.id
            ? Object.assign({}, doc, { view, note: input && input.note, line: input && input.line })
            : doc,
        );
        activeId = existing.id;
      } else {
        // Drop any stale duplicate tab of the same file (older builds stored them).
        const kept = store.docs.filter((doc) => !sameFile(doc.path, path));
        const id = 'd' + Date.now().toString(36);
        docs = kept.concat({ id, path, view, note: input && input.note, line: input && input.line });
        activeId = id;
      }
      mutate({ docs, activeId });
      persist();
    };

    const closeDoc = (id) => {
      const docs = store.docs.filter((doc) => doc.id !== id);
      const activeId = store.activeId === id ? (docs.length ? docs[docs.length - 1].id : undefined) : store.activeId;
      mutate({ docs, activeId });
      persist();
    };

    const buildMarkdown = () => {
      const marks = store.marks.slice().sort((a, b) => a.n - b.n);
      if (!marks.length) return '';
      const lines = ['以下是我在画布面板中的标注（共 ' + marks.length + ' 条），请按编号逐条处理：', ''];
      for (const mark of marks) {
        const where =
          mark.kind === 'text'
            ? mark.lines && mark.lines[0] === mark.lines[1]
              ? '第 ' + mark.lines[0] + ' 行'
              : '第 ' + mark.lines[0] + '-' + mark.lines[1] + ' 行'
            : mark.kind === 'element'
              ? '元素 `' + mark.selector + '`'
              : mark.kind === 'layer'
                ? '图层 `' + mark.selector + '`'
                : '区域 (' + (mark.rect || []).join(', ') + ')';
        lines.push(mark.n + '. `' + mark.path + '` — ' + where);
        if (mark.quote) {
          const quoteLines = String(mark.quote).split('\n').slice(0, 6);
          for (const quoteLine of quoteLines) lines.push('   > ' + quoteLine);
        }
        lines.push('   意见：' + (mark.note && mark.note.trim() ? mark.note.trim() : '（未填写，请按引用判断）'));
        lines.push('');
      }
      return lines.join('\n').slice(0, 12000);
    };

    const sendMarks = () => {
      const text = buildMarkdown();
      if (!text) return '空标注';
      const actions = store.actions;
      if (actions && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
        try {
          const captured = actions.captureInsertion();
          const span = captured && captured.span !== undefined ? captured.span : captured;
          actions.insertText(text + '\n', span);
          devlog('send', ['ok-insertText', 'capture=' + (captured ? Object.keys(captured).join(',') : 'none')]);
          return 'ok';
        } catch (error) {
          devlog('send-insertText-failed', [errText(error)]);
        }
      }
      if (actions && typeof actions.setDraft === 'function') {
        try {
          actions.setDraft(text + '\n');
          devlog('send', ['ok-setDraft']);
          return 'ok';
        } catch (error) {
          devlog('send-setDraft-failed', [errText(error)]);
        }
      }
      if (!actions) devlog('send', ['no-actions']);
      try {
        navigator.clipboard.writeText(text);
        return 'copied';
      } catch (error) {
        return 'failed';
      }
    };

    // ---------------- styles ----------------
    // Controls follow the host's compact-button language: no border, transparent
    // fill, a soft hover wash, 26px tall, 8px radius, secondary label colour.
    // Theme tokens only, so light and dark both follow the application.
    const CSS_BASE = [
      '.dshcv-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}',
      '.dshcv-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshcv-btn:active{background:var(--dsw-alias-bg-layer-1)}',
      '.dshcv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshcv-btn[data-primary="1"]{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshcv-btn[data-primary="1"]:hover{color:#fff;filter:brightness(1.06)}',
      '.dshcv-btn[data-quiet="1"]{color:var(--dsw-alias-label-secondary)}',
      '.dshcv-btn[data-icon="1"]{width:26px;padding:0}',
      '.dshcv-btn[disabled]{opacity:.55;cursor:default}',
      '.dshcv-btn[disabled]:hover{background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}',
      '.dshcv-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshcv-chip[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshcv-badge{flex:0 0 auto;min-width:18px;height:18px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 5px;font-variant-numeric:tabular-nums}',
      '.dshcv-note{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;padding:5px 8px;border-radius:7px;border:1px solid transparent;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical;transition:border-color .12s ease}',
      '.dshcv-note:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dshcv-note:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcv-card{display:flex;align-items:center;gap:10px;padding:8px 10px;margin:6px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshcv-pick{position:fixed;z-index:60;transform:translate(-50%,-100%);box-shadow:0 8px 24px rgba(0,0,0,.2)}',
      '.dshcv-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;pointer-events:none;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.16);animation:dshcv-toast-in .16s ease-out both}',
      '@keyframes dshcv-toast-in{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}',
      '@media (prefers-reduced-motion: reduce){.dshcv-btn,.dshcv-chip,.dshcv-note{transition:none}}',
    ].join('\n');

    const CSS_PANEL = [
      '.dshcv-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshcv-head{display:flex;align-items:center;gap:6px;padding:0 8px 0 12px;min-height:40px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-title{font-size:13px;font-weight:600;letter-spacing:-0.01em;white-space:nowrap}',
      '.dshcv-path{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dshcv-spacer{flex:1 1 auto;min-width:8px}',
      '.dshcv-body{display:flex;flex:1 1 0;min-height:0;overflow:hidden}',
      '.dshcv-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
      // The conversation must see a definite, clipped box: an auto-height flex
      // parent let it grow past the pane, so its transcript kept believing it
      // had more room and the last messages ended up under the composer.
      '.dshcv-conv{position:relative;flex:1 1 0;min-width:0;min-height:0;overflow:hidden}',
      '.dshcv-convfill{position:absolute;inset:0;overflow:hidden}',
      '.dshcv-convfill>*{height:100%;min-height:0}',
      '.dshcv-split{flex:0 0 9px;cursor:col-resize;position:relative;background:transparent}',
      '.dshcv-split::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:var(--dsw-alias-border-l1);transition:background-color .12s ease}',
      '.dshcv-split:hover::after{background:var(--dsw-alias-brand-primary)}',
      // Enter/leave motion: the canvas half reveals while the conversation keeps
      // its place, so opening the panel does not flash the transcript.
      '@keyframes dshcv-reveal{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}',
      '@keyframes dshcv-hide{from{opacity:1;transform:none}to{opacity:0;transform:translateX(-10px)}}',
      '.dshcv-reveal{animation:dshcv-reveal .19s cubic-bezier(.2,0,0,1) both}',
      '.dshcv-closing{animation:dshcv-hide .15s cubic-bezier(.4,0,1,1) both;pointer-events:none}',
      // Width travel: applied only while opening or closing, so dragging the
      // splitter stays immediate.
      '.dshcv-animating{transition:flex-basis .2s cubic-bezier(.2,0,0,1)}',
      '@media (prefers-reduced-motion: reduce){.dshcv-reveal,.dshcv-closing{animation:none}.dshcv-animating{transition:none}}',
      '.dshcv-docs{display:flex;align-items:center;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}',
      '.dshcv-crumbs{display:flex;align-items:center;gap:2px;min-width:0;overflow-x:auto}',
      '.dshcv-row{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dshcv-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcv-rowname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-scroll{flex:1 1 auto;min-height:0;overflow:auto}',
      '.dshcv-tools{display:flex;align-items:center;gap:4px;min-height:34px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-msg{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshcv-range{flex:0 0 150px;min-width:80px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dshcv-svg{flex:1 1 auto;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:12px}',
      '.dshcv-svg>svg{max-width:100%;height:auto}',
      '.dshcv-svg[data-dshcv-spotlight] *{opacity:.45 !important;transition:opacity .18s cubic-bezier(.33,0,.2,1) !important}',
      '.dshcv-svg[data-dshcv-spotlight] [data-dshcv-path]{opacity:1 !important}',
      '.dshcv-svg[data-dshcv-spotlight] [data-dshcv-focus],.dshcv-svg[data-dshcv-spotlight] [data-dshcv-focus] *{opacity:1 !important}',
      '@media (prefers-reduced-motion: reduce){.dshcv-svg[data-dshcv-spotlight] *{transition:none !important}}',
      '.dshcv-editor{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:10px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}',
      '.dshcv-md{font-size:13px;line-height:1.7;padding:12px 16px;overflow-wrap:anywhere}',
      '.dshcv-md>:first-child{margin-top:0}',
      '.dshcv-md h1{font-size:19px;margin:16px 0 8px}',
      '.dshcv-md h2{font-size:16px;margin:14px 0 6px}',
      '.dshcv-md h3,.dshcv-md h4,.dshcv-md h5,.dshcv-md h6{font-size:14px;margin:12px 0 6px}',
      '.dshcv-md p{margin:8px 0}',
      '.dshcv-md ul,.dshcv-md ol{margin:8px 0;padding-left:22px}',
      '.dshcv-md li{margin:2px 0}',
      '.dshcv-md code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:5px}',
      '.dshcv-md pre{margin:10px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:auto}',
      '.dshcv-md pre code{background:none;padding:0;font-size:12px}',
      '.dshcv-md blockquote{margin:10px 0;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.dshcv-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.dshcv-md a:hover{text-decoration:underline}',
      '.dshcv-md hr{margin:16px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 0}',
      '.dshcv-line{display:flex;gap:10px;padding:0 12px;white-space:pre}',
      '.dshcv-line:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcv-num{color:var(--dsw-alias-label-secondary);user-select:none;text-align:right;min-width:42px;flex:0 0 auto;opacity:.75}',
      '.dshcv-text{white-space:pre}',
      '.dshcv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}',
      '.dshcv-marks{flex:0 0 auto;max-height:38%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:4px 12px 8px}',
      '.dshcv-mark{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-mark:last-child{border-bottom:0}',
      '.dshcv-markbody{flex:1 1 auto;min-width:0}',
      '.dshcv-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-quote{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l1);padding-left:8px;margin:4px 0;max-height:56px;overflow:hidden}',
      '@media (prefers-reduced-motion: reduce){.dshcv-split::after{transition:none}}',
    ].join('\n');

    const Styles = (props) =>
      h('style', { 'data-dshcv': props && props.panel ? 'panel' : 'base' }, props && props.panel ? CSS_BASE + '\n' + CSS_PANEL : CSS_BASE);

    // ---------------- conversation bridge ----------------
    // The composer dock is Session-scoped, so it gives us the current session
    // identity and the composer input actions the root-scoped panel cannot read.
    function Bridge(props) {
      const sessionId = props.sessionId;
      const actions = props.inputActions;
      React.useEffect(() => {
        const sessionChanged = store.sessionId !== sessionId;
        const actionsChanged = store.actions !== actions;
        if (!sessionChanged && !actionsChanged) return;
        store.sessionId = sessionId;
        store.actions = actions;
        if (sessionChanged) {
          store.docs = [];
          store.activeId = undefined;
          store.marks = [];
          store.seq = 0;
          store.restored = false;
          restore();
          if (store.pending) {
            const pending = store.pending;
            store.pending = undefined;
            openDoc(pending);
          }
        }
        if (!store.reportedBridge) {
          store.reportedBridge = true;
          devlog('bridge', [
            'session=' + String(sessionId),
            'actions=' + (actions ? Object.keys(actions).join(',') : 'none'),
          ]);
        }
        notify();
      }, [sessionId, actions]);
      return null;
    }

    // ---------------- tool card ----------------
    // The owner hands us a phase block whose shape is not part of the public
    // contract, so scan it (and any lazy accessor) for the object carrying our
    // `path` argument instead of assuming one field name.
    const deepArgs = (value, depth) => {
      if (value === undefined || value === null || depth > 4) return undefined;
      if (typeof value === 'function') {
        try {
          return deepArgs(value(), depth + 1);
        } catch {
          return undefined;
        }
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
          try {
            return deepArgs(JSON.parse(trimmed), depth + 1);
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = deepArgs(item, depth + 1);
          if (found) return found;
        }
        return undefined;
      }
      if (typeof value === 'object') {
        if (typeof value.path === 'string' && value.path) return value;
        for (const key of Object.keys(value)) {
          if (key === 'props' || key === 'children' || key === '_owner') continue;
          const found = deepArgs(value[key], depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    };

    const readToolArgs = (props) => deepArgs(props.block, 0) || deepArgs(props.args, 0);

    function CanvasToolCard(props) {
      useVersion();
      const opened = React.useRef('');
      const args = readToolArgs(props);
      const path = args && typeof args.path === 'string' ? args.path : '';

      React.useEffect(() => {
        if (props.phase === 'preparing') return;
        const key = String(props.callId || '') + '|' + path;
        if (opened.current === key) return;
        opened.current = key;
        // Open the panel once per call. Without this, switching back to the
        // conversation remounts this card, whose effect would immediately
        // select the canvas again and the panel could never be closed.
        if (autoOpened.has(key)) return;
        autoOpened.add(key);
        selectPanel(PANEL_KEY);
        if (path) openDoc({ path, view: args && args.view, note: args && args.note, line: args && args.line });
      }, [props.phase, props.callId, path]);

      const glyph = h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' },
        },
        h('rect', { x: 2.25, y: 2.75, width: 11.5, height: 10.5, rx: 2.25, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M6.6 3.2v9.6', stroke: 'currentColor', strokeWidth: 1.3 }),
      );

      if (!path) {
        return h(
          React.Fragment,
          null,
          h(Styles),
          h(
            'div',
            { className: 'dshcv-card' },
            glyph,
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, '在画布面板中查看'),
            h('button', { type: 'button', className: 'dshcv-btn', onClick: () => selectPanel(PANEL_KEY) }, '打开'),
          ),
        );
      }
      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          { className: 'dshcv-card' },
          glyph,
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'dshcv-path' }, path),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '已在画布面板中打开'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              onClick: () => {
                openDoc({ path, view: args && args.view });
                selectPanel(PANEL_KEY);
              },
            },
            '查看',
          ),
        ),
      );
    }

    // ---------------- workspace picker ----------------
    const joinPath = (base, name) => {
      const prefix = String(base || '').replace(/\/+$/, '');
      return prefix ? prefix + '/' + name : name;
    };

    function FilePicker(props) {
      const { sessionId, onOpen, onClose } = props;
      const [state, setState] = React.useState({ path: '', status: 'loading', entries: [], error: '' });

      const load = async (path) => {
        // The workspace file service rejects an empty path; '.' names its root.
        const target = path && path !== '.' ? path : '.';
        setState({ path: target === '.' ? '' : target, status: 'loading', entries: [], error: '' });
        try {
          const files = workspaceFiles();
          if (!files || typeof files.list !== 'function') throw new Error('workspaceFiles.list unavailable');
          const result = unwrap(await files.list(sessionId, target, new AbortController().signal)) || {};
          const entries = (result.entries || [])
            .map((entry) => ({
              name: String(entry.name || entry.path || ''),
              dir: entry.type === 'directory' || entry.kind === 'directory' || entry.isDirectory === true,
            }))
            .filter((entry) => entry.name);
          entries.sort((left, right) => (left.dir === right.dir ? left.name.localeCompare(right.name) : left.dir ? -1 : 1));
          const reported = String(result.path || target);
          setState({ path: reported === '.' ? '' : reported, status: 'ready', entries, error: '' });
        } catch (error) {
          setState({ path: '', status: 'failed', entries: [], error: errText(error) });
        }
      };

      React.useEffect(() => {
        if (sessionId) load('');
        else setState({ path: '', status: 'failed', entries: [], error: '等待会话…' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId]);

      const segments = String(state.path || '').split('/').filter(Boolean);
      const crumbs = [h('button', { key: 'root', type: 'button', className: 'dshcv-chip', onClick: () => load('') }, '工作区')];
      segments.forEach((segment, index) => {
        crumbs.push(h('span', { key: 'sep' + index, className: 'dshcv-msg' }, '/'));
        crumbs.push(
          h(
            'button',
            {
              key: 'seg' + index,
              type: 'button',
              className: 'dshcv-chip',
              onClick: () => load(segments.slice(0, index + 1).join('/')),
            },
            segment,
          ),
        );
      });

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h('button', { type: 'button', className: 'dshcv-btn', onClick: onClose }, '返回'),
          h('span', { className: 'dshcv-crumbs' }, crumbs),
        ),
        h(
          'div',
          { className: 'dshcv-scroll', style: { padding: '6px 8px' } },
          state.status === 'loading' ? h('div', { className: 'dshcv-empty' }, '读取中…') : null,
          state.status === 'failed' ? h('div', { className: 'dshcv-empty' }, state.error) : null,
          state.status === 'ready' && !state.entries.length ? h('div', { className: 'dshcv-empty' }, '空目录') : null,
          state.entries.map((entry) =>
            h(
              'button',
              {
                key: entry.name,
                type: 'button',
                className: 'dshcv-row',
                onClick: () => {
                  if (entry.dir) load(joinPath(state.path, entry.name));
                  else {
                    onOpen(joinPath(state.path, entry.name));
                    onClose();
                  }
                },
              },
              h('span', { className: 'dshcv-rowname' }, entry.name + (entry.dir ? '/' : '')),
            ),
          ),
        ),
      );
    }

    // ---------------- markdown ----------------
    // Small renderer: no dependency, and it builds React nodes instead of
    // injecting HTML, so a document can never execute markup.
    const inlineMd = (text) => {
      const nodes = [];
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:https?:|mailto:)[^\s)]+\))/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = 'i' + match.index;
        if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)));
        else if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          nodes.push(
            h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]),
          );
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    };

    const renderMarkdown = (text) => {
      const lines = String(text || '').split('\n');
      const blocks = [];
      let paragraph = [];
      let list = null;
      let fence = null;
      const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push(h('p', { key: 'p' + blocks.length }, inlineMd(paragraph.join(' '))));
        paragraph = [];
      };
      const flushList = () => {
        if (!list) return;
        blocks.push(
          h(
            list.ordered ? 'ol' : 'ul',
            { key: 'l' + blocks.length },
            list.items.map((item, index) => h('li', { key: index }, inlineMd(item))),
          ),
        );
        list = null;
      };
      const flushAll = () => {
        flushParagraph();
        flushList();
      };

      for (const line of lines) {
        if (fence) {
          if (/^```/.test(line)) {
            blocks.push(h('pre', { key: 'c' + blocks.length }, h('code', null, fence.lines.join('\n'))));
            fence = null;
          } else {
            fence.lines.push(line);
          }
          continue;
        }
        const fenceStart = /^```(\w*)/.exec(line);
        if (fenceStart) {
          flushAll();
          fence = { lines: [] };
          continue;
        }
        if (!line.trim()) {
          flushAll();
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushAll();
          blocks.push(h('h' + heading[1].length, { key: 'h' + blocks.length }, inlineMd(heading[2])));
          continue;
        }
        if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flushAll();
          blocks.push(h('hr', { key: 'r' + blocks.length }));
          continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          flushAll();
          blocks.push(h('blockquote', { key: 'q' + blocks.length }, inlineMd(quote[1])));
          continue;
        }
        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (unordered || ordered) {
          flushParagraph();
          const isOrdered = Boolean(ordered);
          if (!list || list.ordered !== isOrdered) {
            flushList();
            list = { ordered: isOrdered, items: [] };
          }
          list.items.push((unordered || ordered)[1]);
          continue;
        }
        flushList();
        paragraph.push(line.trim());
      }
      if (fence) blocks.push(h('pre', { key: 'c' + blocks.length }, h('code', null, fence.lines.join('\n'))));
      flushAll();
      return blocks;
    };

    const MarkdownBody = (props) =>
      h('div', { className: 'dshcv-md' }, renderMarkdown(props.text));

    // ---------------- text viewer ----------------
    const SAVE_PATH = '/dsh-canvas/save';
    const SAVE_ABSOLUTE = 'http://127.0.0.1:1296/dsh-canvas/save';
    const saveUrl = () => (/^https?:$/.test(location.protocol) ? SAVE_PATH : SAVE_ABSOLUTE);

    function TextDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', text: '', absolutePath: '', version: undefined, error: '' });
      const [picked, setPicked] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const isMarkdown = doc.view === 'markdown';
      const [rendered, setRendered] = React.useState(isMarkdown);
      const scrollPos = React.useRef(0);
      const scrollRef = React.useRef(null);

      // Switching between rendered and source keeps the reading position and
      // never moves focus: the toggle cancels its own mousedown.
      React.useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollPos.current;
      }, [rendered]);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', text: '', absolutePath: '', version: undefined, error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', text: '', absolutePath: '', version: undefined, error: '' });
        setEditing(false);
        const load = async () => {
          try {
            const page = await readTextPages(sessionId, doc.path, controller.signal);
            if (cancelled) return;
            setState({ status: 'ready', text: page.text, absolutePath: page.absolutePath, version: page.version, error: '' });
          } catch (error) {
            if (cancelled) return;
            setState({ status: 'failed', text: '', absolutePath: '', version: undefined, error: errText(error) });
          }
        };
        load();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      React.useEffect(() => {
        if (!message) return undefined;
        const timer = setTimeout(() => setMessage(''), 3000);
        return () => clearTimeout(timer);
      }, [message]);

      const lineElements = React.useMemo(() => {
        if (state.status !== 'ready') return [];
        return state.text.split('\n');
      }, [state]);

      const clampNode = (node) => {
        let element = node && node.nodeType === 3 ? node.parentElement : node;
        while (element && !(element.dataset && element.dataset.line)) element = element.parentElement;
        return element && element.dataset && element.dataset.line ? element : null;
      };

      const onMouseUp = () => {
        if (editing || rendered) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
          setPicked(null);
          return;
        }
        const range = selection.getRangeAt(0);
        const host = scrollRef.current;
        if (!host || !host.contains(range.commonAncestorContainer)) return;
        const startElement = clampNode(range.startContainer);
        const endElement = clampNode(range.endContainer);
        if (!startElement || !endElement) return;
        const quote = String(selection.toString());
        if (!quote.trim()) {
          setPicked(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        setPicked({
          startLine: Number(startElement.dataset.line),
          endLine: Number(endElement.dataset.line),
          quote,
          top: Math.max(8, rect.top),
          left: Math.min(window.innerWidth - 90, Math.max(46, rect.left + rect.width / 2)),
        });
      };

      const commit = () => {
        if (!picked) return;
        const number = addTextMark(doc.path, picked.startLine, picked.endLine, picked.quote);
        if (number) setMessage('已标注为 #' + number);
        setPicked(null);
        try {
          window.getSelection().removeAllRanges();
        } catch {
          /* ignore */
        }
      };

      const beginEdit = () => {
        setDraft(state.text);
        setEditing(true);
        setRendered(false);
        setPicked(null);
        setMessage('');
      };

      const cancelEdit = () => {
        setEditing(false);
        setDraft('');
        setMessage('');
      };

      const save = async () => {
        if (!state.absolutePath) {
          setMessage('未取得文件绝对路径，无法保存');
          return;
        }
        setSaving(true);
        setMessage('保存中…');
        try {
          const response = await fetch(saveUrl(), {
            method: 'POST',
            mode: 'cors',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              path: doc.path,
              absolutePath: state.absolutePath,
              content: draft,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
          setState(Object.assign({}, state, { text: draft, version: payload.version }));
          setEditing(false);
          setMessage('已保存');
        } catch (error) {
          setMessage('保存失败：' + errText(error));
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取该文件'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '读取中…' : state.error || '……'));
      }

      const toolbar = h(
        'div',
        { className: 'dshcv-tools' },
        h('button', { type: 'button', className: 'dshcv-btn', onClick: editing ? cancelEdit : beginEdit }, editing ? '退出编辑' : '编辑'),
        isMarkdown
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                title: rendered ? '显示 Markdown 原文' : '显示渲染结果',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  scrollPos.current = scrollRef.current ? scrollRef.current.scrollTop : 0;
                  setRendered(!rendered);
                },
              },
              rendered ? '原文' : '渲染',
            )
          : null,
        h('span', { className: 'dshcv-spacer' }),
        message ? h('span', { className: 'dshcv-msg' }, message) : null,
        editing
          ? h(
              'button',
              { type: 'button', className: 'dshcv-btn', 'data-primary': '1', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存',
            )
          : null,
      );

      if (isMarkdown && rendered && !editing) {
        return h(
          React.Fragment,
          null,
          toolbar,
          h(
            'div',
            { className: 'dshcv-scroll', ref: scrollRef },
            h(MarkdownBody, { text: state.text }),
          ),
        );
      }

      if (editing) {
        return h(
          React.Fragment,
          null,
          toolbar,
          h('textarea', {
            className: 'dshcv-editor',
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                save();
              }
            },
          }),
        );
      }

      return h(
        React.Fragment,
        null,
        toolbar,
        h(
          'div',
          { className: 'dshcv-scroll', ref: scrollRef, onMouseUp: onMouseUp },
          h(
            'div',
            { className: 'dshcv-code' },
            lineElements.map((line, index) =>
              h(
                'div',
                { key: index, className: 'dshcv-line', 'data-line': index + 1 },
                h('span', { className: 'dshcv-num' }, String(index + 1)),
                h('span', { className: 'dshcv-text' }, line || ' '),
              ),
            ),
          ),
        ),
        picked
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn dshcv-pick',
                'data-primary': '1',
                style: { top: picked.top, left: picked.left },
                onClick: commit,
              },
              '标记 ' + (picked.startLine === picked.endLine ? '第 ' + picked.startLine + ' 行' : '第 ' + picked.startLine + '-' + picked.endLine + ' 行'),
            )
          : null,
      );
    }

    // ---------------- marks rail ----------------
    function MarksRail() {
      useVersion();
      if (!store.marks.length) return null;
      return h(
        'div',
        { className: 'dshcv-marks' },
        store.marks
          .slice()
          .sort((a, b) => a.n - b.n)
          .map((mark) =>
            h(
              'div',
              { key: mark.id, className: 'dshcv-mark' },
              h('span', { className: 'dshcv-badge' }, String(mark.n)),
              h(
                'div',
                { className: 'dshcv-markbody' },
                h(
                  'div',
                  { className: 'dshcv-meta' },
                  basename(mark.path) +
                    ' · ' +
                    (mark.kind === 'text'
                      ? '第 ' + mark.lines[0] + (mark.lines[1] !== mark.lines[0] ? '-' + mark.lines[1] : '') + ' 行'
                      : mark.kind === 'element'
                        ? mark.selector
                        : '区域'),
                ),
                mark.quote ? h('div', { className: 'dshcv-quote' }, mark.quote.split('\n').slice(0, 3).join('\n')) : null,
                h('input', {
                  className: 'dshcv-note',
                  placeholder: '写修改意见，发送时按编号带上',
                  value: mark.note || '',
                  onChange: (event) => setMarkNote(mark.id, event.target.value),
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-quiet': '1',
                  title: '删除标记',
                  onClick: () => removeMark(mark.id),
                },
                '×',
              ),
            ),
          ),
      );
    }

    // ---------------- file reads (shared by the viewers) ----------------
    // Generated client remotes answer with a RemoteResult envelope `{ ok, value }`.
    const unwrap = (result) => {
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        if (!result.ok) {
          const error = result.error || {};
          throw new Error(error.message || error.code || 'remote request failed');
        }
        return result.value;
      }
      return result;
    };

    const workspaceFiles = () => {
      const files = ctxRef && ctxRef.get('remote.workspaceFiles');
      return files && typeof files.read === 'function' ? files : null;
    };

    const readTextPages = async (sessionId, path, signal) => {
      const files = workspaceFiles();
      if (!files) throw new Error('workspaceFiles.read unavailable');
      let text = '';
      let offset = 1;
      let absolutePath = '';
      let version;
      for (let page = 0; page < 12; page += 1) {
        const result = unwrap(await files.read(sessionId, path, { offset }, signal));
        if (page === 0 && result) {
          absolutePath = String(result.absolutePath || '');
          version = result.version;
        }
        text += (text ? '\n' : '') + String(result && result.text ? result.text : '');
        if (!result || result.eof) break;
        offset += Math.max(1, Number(result.lines) || 1000);
      }
      return { text, absolutePath, version };
    };

    const readBytesFile = async (sessionId, path, signal) => {
      const files = workspaceFiles();
      if (!files || typeof files.readBytes !== 'function') throw new Error('workspaceFiles.readBytes unavailable');
      const result = unwrap(await files.readBytes(sessionId, path, {}, signal));
      return result && result.data;
    };

    const mimeOf = (path) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(String(path || '')) || [, ''])[1].toLowerCase();
      if (ext === 'svg') return 'image/svg+xml';
      if (ext === 'png') return 'image/png';
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      if (ext === 'gif') return 'image/gif';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'bmp') return 'image/bmp';
      if (ext === 'ico') return 'image/x-icon';
      return 'application/octet-stream';
    };

    // ---------------- html viewer with element picking ----------------
    // Injected into the preview document: element picking, the 0.5s dwell
    // spotlight, and animation freeze/scrub control (CSS, WAAPI and SMIL).
    const PICKER_SCRIPT = [
      '(function(){',
      'var box=null,dwellEl=null,dwellTimer=null,spotEl=null,paused=false,capture=false;',
      // Freeze JS frame loops too: queue requestAnimationFrame callbacks while
      // frozen and release them on resume, so rAF-driven motion stops with the
      // rest of the timeline (a loop that captured the original function and
      // never reads window.requestAnimationFrame again stays out of reach).
      'var origRaf=window.requestAnimationFrame,origCaf=window.cancelAnimationFrame,rafQueue=[],rafSeq=0;',
      'window.requestAnimationFrame=function(cb){if(!paused)return origRaf.call(window,cb);rafSeq+=1;rafQueue.push({id:rafSeq,cb:cb});return rafSeq;};',
      'window.cancelAnimationFrame=function(id){for(var i=0;i<rafQueue.length;i++){if(rafQueue[i].id===id){rafQueue.splice(i,1);return;}}return origCaf?origCaf.call(window,id):undefined;};',
      'function releaseRaf(){var queue=rafQueue;rafQueue=[];for(var i=0;i<queue.length;i++){try{origRaf.call(window,queue[i].cb);}catch(e){}}}',
      'function runOneRaf(){var next=rafQueue.shift();if(!next)return false;try{next.cb(performance.now());}catch(e){}return true;}',
      'function overlay(){if(box)return box;box=document.createElement("div");',
      'box.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2f6feb;background:rgba(47,111,235,.12);border-radius:2px;display:none";',
      'document.documentElement.appendChild(box);return box;}',
      'function sel(el){if(el.id)return "#"+el.id;var parts=[];var node=el;var depth=0;',
      'while(node&&node.nodeType===1&&depth<5){var p=node.tagName.toLowerCase();',
      'var cls=(node.getAttribute("class")||"").trim().split(/\\s+/).filter(Boolean).slice(0,2);',
      'if(cls.length)p+="."+cls.join(".");',
      'var parent=node.parentElement;',
      'if(parent){var same=[];var kids=parent.children;for(var i=0;i<kids.length;i++){if(kids[i].tagName===node.tagName)same.push(kids[i]);}if(same.length>1)p+=":nth-of-type("+(same.indexOf(node)+1)+")";}',
      'parts.unshift(p);node=node.parentElement;depth++;}return parts.join(" > ");}',
      // dwell spotlight
      'function clearSpot(){var marks=document.querySelectorAll("[data-dshcv-focus],[data-dshcv-path]");for(var i=0;i<marks.length;i++){marks[i].removeAttribute("data-dshcv-focus");marks[i].removeAttribute("data-dshcv-path");}spotEl=null;document.documentElement.removeAttribute("data-dshcv-spotlight");}',
      'function markSpot(el){clearSpot();var node=el,first=true,guard=0;',
      'while(node&&node.nodeType===1&&node!==document.documentElement&&guard<64){node.setAttribute(first?"data-dshcv-focus":"data-dshcv-path","");first=false;node=node.parentElement;guard++;}',
      'document.documentElement.setAttribute("data-dshcv-spotlight","");spotEl=el;}',
      // animation control
      'function anims(){try{return document.getAnimations?document.getAnimations():[];}catch(e){return [];}}',
      'function svgRoots(){return document.querySelectorAll("svg");}',
      'function pauseAll(){var list=anims();for(var i=0;i<list.length;i++){try{list[i].pause();}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{roots[j].pauseAnimations&&roots[j].pauseAnimations();}catch(e){}}paused=true;report();}',
      'function resumeAll(){var list=anims();for(var i=0;i<list.length;i++){try{list[i].play();}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{roots[j].unpauseAnimations&&roots[j].unpauseAnimations();}catch(e){}}paused=false;releaseRaf();report();}',
      'function seek(ms){var at=Math.max(0,Number(ms)||0);var list=anims();',
      'for(var i=0;i<list.length;i++){try{var a=list[i],end=1e9;var t=a.effect&&a.effect.getComputedTiming?a.effect.getComputedTiming():null;if(t&&t.endTime)end=t.endTime;a.currentTime=Math.min(at,end);}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{roots[j].setCurrentTime&&roots[j].setCurrentTime(at/1000);}catch(e){}}report();}',
      'function stepFrame(dir){var delta=(dir||1)*16;var list=anims();',
      'for(var i=0;i<list.length;i++){try{var a=list[i],d=Number(a.currentTime)||0;a.pause();a.currentTime=Math.max(0,d+delta);}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{var root=roots[j];root.pauseAnimations&&root.pauseAnimations();',
      'var now=root.getCurrentTime?root.getCurrentTime():0;root.setCurrentTime&&root.setCurrentTime(Math.max(0,now+delta/1000));}catch(e){}}',
      'if((dir||1)>0)runOneRaf();paused=true;report();}',
      'function report(){var list=anims(),duration=0,current=0;',
      'for(var i=0;i<list.length;i++){try{var a=list[i];var t=a.effect&&a.effect.getComputedTiming?a.effect.getComputedTiming():null;',
      'var end=t&&t.endTime?t.endTime:0;if(isFinite(end)&&end>duration)duration=end;var c=Number(a.currentTime)||0;if(isFinite(c)&&c>current)current=c;}catch(e){}}',
      'parent.postMessage({source:"dshcv-anim",state:{paused:paused,capture:capture,duration:Math.round(duration),current:Math.round(current),count:list.length,raf:rafQueue.length}},"*");}',
      // pointer behaviour
      'document.addEventListener("mousemove",function(e){var el=e.target;if(!el||el.nodeType!==1)return;',
      'var b=overlay();var r=el.getBoundingClientRect();b.style.display="block";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";',
      'if(!capture){if(spotEl||document.documentElement.hasAttribute("data-dshcv-spotlight"))clearSpot();dwellEl=el;return;}',
      'if(el!==dwellEl){dwellEl=el;clearSpot();clearTimeout(dwellTimer);dwellTimer=setTimeout(function(){if(dwellEl===el)markSpot(el);},500);}},true);',
      'document.addEventListener("mouseleave",function(){dwellEl=null;clearTimeout(dwellTimer);clearSpot();},true);',
      'document.addEventListener("click",function(e){var el=e.target;if(!el||el.nodeType!==1)return;if(capture)return;e.preventDefault();e.stopPropagation();',
      'var r=el.getBoundingClientRect();var text=(el.innerText||el.textContent||"").trim().slice(0,240);',
      'parent.postMessage({source:"dshcv-picker",selector:sel(el),tag:el.tagName.toLowerCase(),text:text,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]},"*");},true);',
      // In capture mode a click freezes the interaction state; outside it the
      // page keeps its own interactions and clicks only create a mark.
      'document.addEventListener("pointerdown",function(){if(!capture)return;setTimeout(pauseAll,40);},true);',
      'document.addEventListener("keydown",function(e){var step=e.shiftKey?100:16;',
      'if(e.code==="Space"){e.preventDefault();capture=!capture;if(!capture)clearSpot();report();}',
      'else if(e.key==="ArrowLeft"){e.preventDefault();pauseAll();var t=anims();var c=0;for(var i=0;i<t.length;i++){try{c=Math.max(c,Number(t[i].currentTime)||0);}catch(x){}}seek(c-step);}',
      'else if(e.key==="ArrowRight"){e.preventDefault();pauseAll();var u=anims();var d=0;for(var i=0;i<u.length;i++){try{d=Math.max(d,Number(u[i].currentTime)||0);}catch(x){}}seek(d+step);}',
      'else if(e.key==="p"||e.key==="P"){paused?resumeAll():pauseAll();}},true);',
      'window.addEventListener("message",function(e){var d=e.data;if(!d||d.source!=="dshcv-cmd")return;',
      'if(d.cmd==="pause")pauseAll();else if(d.cmd==="resume")resumeAll();else if(d.cmd==="seek")seek(d.time);',
      'else if(d.cmd==="step")stepFrame(d.dir||1);',
      'else if(d.cmd==="capture"||d.cmd==="arm"){capture=!!d.on;if(!capture)clearSpot();report();}else if(d.cmd==="state")report();},false);',
      'setTimeout(report,300);',
      '})();',
    ].join('\n');

    const SPOTLIGHT_CSS = [
      'html[data-dshcv-spotlight] *{opacity:.45 !important;transition:opacity .18s cubic-bezier(.33,0,.2,1) !important}',
      'html[data-dshcv-spotlight] [data-dshcv-path]{opacity:1 !important}',
      'html[data-dshcv-spotlight] [data-dshcv-focus],html[data-dshcv-spotlight] [data-dshcv-focus] *{opacity:1 !important}',
      '@media (prefers-reduced-motion: reduce){html[data-dshcv-spotlight] *{transition:none !important}}',
    ].join('\n');

    const injectPicker = (html) => {
      const style = '<style data-dshcv-spotlight>' + SPOTLIGHT_CSS + '</style>';
      const tag = '<scr' + 'ipt>' + PICKER_SCRIPT + '</scr' + 'ipt>';
      let next = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, style + '</head>') : style + html;
      if (/<\/body>/i.test(next)) return next.replace(/<\/body>/i, tag + '</body>');
      return next + tag;
    };

    // Shared animation transport bar: pause, capture the next interaction,
    // scrub the timeline, and step single frames. Every control clamps to the
    // same span, so stepping cannot leave the timeline.
    function AnimBar(props) {
      const { anim, onPause, onResume, onSeek, onArm, onStep } = props;
      const finite = Number.isFinite(anim.duration) && anim.duration > 0 ? anim.duration : 0;
      // Looping animations report no finite end, so the span grows with the
      // elapsed time instead of collapsing to a meaningless value.
      const span = Math.max(finite, Math.min(30000, Math.max(1000, anim.current || 0)));
      const current = Math.min(Math.max(0, anim.current || 0), span);
      const clamp = (value) => Math.min(span, Math.max(0, Math.round(value)));
      const step = (delta) => {
        if (onStep) {
          onStep(delta > 0 ? 1 : -1);
          return;
        }
        onSeek(clamp(current + delta));
      };
      const canBack = current > 0;
      const canForward = Boolean(onStep) || current < span;
      return h(
        'div',
        { className: 'dshcv-tools' },
        h(
          'button',
          { type: 'button', className: 'dshcv-btn', onClick: anim.paused ? onResume : onPause },
          anim.paused ? '继续' : '暂停',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshcv-btn',
            'data-primary': anim.capture ? '1' : '0',
            title: '抓帧模式（空格）：悬停 0.5 秒淡化其余元素，点击定格交互态',
            onClick: () => onArm(!anim.capture),
          },
          anim.capture ? '抓帧中' : '抓帧',
        ),
        anim.paused
          ? h('input', {
              type: 'range',
              className: 'dshcv-range',
              min: 0,
              max: span,
              step: 16,
              value: current,
              onChange: (event) => onSeek(clamp(Number(event.target.value))),
            })
          : null,
        h(
          'span',
          { className: 'dshcv-msg' },
          anim.paused
            ? Math.round(current) + ' ms / ' + Math.round(span) + ' ms' + (anim.raf ? ' · JS 帧 ' + anim.raf : '')
            : anim.count || anim.raf
              ? (anim.count || 0) + ' 个动画' + (anim.raf ? ' · JS 帧 ' + anim.raf : '')
              : '无动画',
        ),
        anim.paused
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                'data-icon': '1',
                title: '后退一帧（JS 帧无法回退）',
                disabled: !canBack,
                onClick: () => step(-16),
              },
              '−',
            )
          : null,
        anim.paused
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                'data-icon': '1',
                title: onStep ? '前进一帧（含一个 JS 帧）' : '前进一帧',
                disabled: !canForward,
                onClick: () => step(16),
              },
              '+',
            )
          : null,
      );
    }

    function HtmlDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', error: '' });
      const [anim, setAnim] = React.useState({ paused: false, capture: false, duration: 0, current: 0, count: 0 });
      const frameRef = React.useRef(null);
      const captureRef = React.useRef(false);

      const post = (cmd, extra) => {
        const frame = frameRef.current;
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage(Object.assign({ source: 'dshcv-cmd', cmd }, extra || {}), '*');
      };

      // Space toggles capture while the panel has focus; the preview document
      // handles its own Space when the iframe owns focus.
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.code !== 'Space') return;
          const target = event.target;
          const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
          if (document.activeElement === frameRef.current) return;
          event.preventDefault();
          const next = !captureRef.current;
          captureRef.current = next;
          setAnim((previous) => Object.assign({}, previous, { capture: next }));
          post('capture', { on: next });
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', url: '', error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        let objectUrl = '';
        setState({ status: 'loading', url: '', error: '' });
        readTextPages(sessionId, doc.path, controller.signal)
          .then(async (page) => {
            let html = page.text;
            if (!html) {
              const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
              if (bytes) html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            }
            if (cancelled) return;
            objectUrl = URL.createObjectURL(new Blob([injectPicker(html)], { type: 'text/html' }));
            setState({ status: 'ready', url: objectUrl, error: '' });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', url: '', error: errText(error) });
          });
        return () => {
          cancelled = true;
          controller.abort();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
      }, [doc.path, sessionId]);

      React.useEffect(() => {
        const onMessage = (event) => {
          const frame = frameRef.current;
          if (!frame || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (!data) return;
          if (data.source === 'dshcv-anim' && data.state) {
            captureRef.current = Boolean(data.state.capture);
            setAnim(data.state);
          }
          if (data.source !== 'dshcv-picker') return;
          addMark({
            kind: 'element',
            path: doc.path,
            selector: String(data.selector || ''),
            quote: String(data.text || ''),
            rect: Array.isArray(data.rect) ? data.rect : undefined,
          });
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [doc.path]);

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该 HTML'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '渲染中…' : state.error || '……'));
      }
      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(AnimBar, {
          anim,
          onPause: () => post('pause'),
          onResume: () => post('resume'),
          onSeek: (time) => post('seek', { time }),
          onStep: (dir) => post('step', { dir }),
          onArm: (on) => {
            captureRef.current = on;
            setAnim((previous) => Object.assign({}, previous, { capture: on }));
            post('capture', { on });
          },
        }),
        h('iframe', {
          ref: frameRef,
          src: state.url,
          title: 'canvas html preview',
          sandbox: 'allow-scripts',
          onLoad: () => post('state'),
          style: { flex: '1 1 auto', minHeight: 0, width: '100%', border: '0', background: '#fff' },
        }),
      );
    }

    // ---------------- svg viewer (inline, so elements can be inspected) ----------------
    const sanitizeSvg = (text) => {
      const parsed = new DOMParser().parseFromString(String(text || ''), 'image/svg+xml');
      if (!parsed || !parsed.documentElement || parsed.querySelector('parsererror')) return null;
      const root = parsed.documentElement;
      for (const node of Array.from(root.querySelectorAll('script'))) node.remove();
      const walk = (node) => {
        for (const attribute of Array.from(node.attributes || [])) {
          const name = attribute.name.toLowerCase();
          const value = String(attribute.value || '').trim().toLowerCase();
          if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && value.startsWith('javascript:'))) {
            node.removeAttribute(attribute.name);
          }
        }
        for (const child of Array.from(node.children || [])) walk(child);
      };
      walk(root);
      return root.outerHTML;
    };

    function SvgDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', markup: '', error: '' });
      const [anim, setAnim] = React.useState({ paused: false, capture: false, duration: 0, current: 0, count: 0 });
      const hostRef = React.useRef(null);
      const dwellRef = React.useRef({ element: null, timer: null });
      const captureRef = React.useRef(false);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', markup: '', error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        readTextPages(sessionId, doc.path, controller.signal)
          .then(async (page) => {
            let text = page.text;
            if (!text) {
              const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
              if (bytes) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            }
            const markup = sanitizeSvg(text);
            if (cancelled) return;
            if (!markup) {
              setState({ status: 'failed', markup: '', error: '无法解析 SVG' });
              return;
            }
            setState({ status: 'ready', markup, error: '' });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', markup: '', error: errText(error) });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      const svg = () => hostRef.current && hostRef.current.querySelector('svg');
      const sync = () => {
        const root = svg();
        const paused = root && typeof root.animationsPaused === 'function' ? root.animationsPaused() : false;
        const current = root && typeof root.getCurrentTime === 'function' ? Math.round(root.getCurrentTime() * 1000) : 0;
        setAnim((previous) => Object.assign({}, previous, { paused, current, count: root ? 1 : 0 }));
      };
      const pause = () => {
        const root = svg();
        if (root && root.pauseAnimations) root.pauseAnimations();
        sync();
      };
      const resume = () => {
        const root = svg();
        if (root && root.unpauseAnimations) root.unpauseAnimations();
        sync();
      };
      const seek = (time) => {
        const root = svg();
        if (root && root.setCurrentTime) root.setCurrentTime(Math.max(0, time) / 1000);
        sync();
      };

      const spotting = () => Boolean(hostRef.current && hostRef.current.hasAttribute('data-dshcv-spotlight'));
      const clearSpot = () => {
        const host = hostRef.current;
        if (!host) return;
        for (const node of Array.from(host.querySelectorAll('[data-dshcv-focus],[data-dshcv-path]'))) {
          node.removeAttribute('data-dshcv-focus');
          node.removeAttribute('data-dshcv-path');
        }
        host.removeAttribute('data-dshcv-spotlight');
      };
      const markSpot = (element) => {
        clearSpot();
        let node = element;
        let first = true;
        let guard = 0;
        while (node && node.nodeType === 1 && node !== hostRef.current && guard < 64) {
          node.setAttribute(first ? 'data-dshcv-focus' : 'data-dshcv-path', '');
          first = false;
          node = node.parentElement;
          guard += 1;
        }
        if (hostRef.current) hostRef.current.setAttribute('data-dshcv-spotlight', '');
      };
      const onHover = (event) => {
        const target = event.target;
        if (!target || target.nodeType !== 1) return;
        if (!captureRef.current) {
          if (spotting()) clearSpot();
          return;
        }
        const dwell = dwellRef.current;
        if (dwell.element === target) return;
        dwell.element = target;
        clearSpot();
        clearTimeout(dwell.timer);
        dwell.timer = setTimeout(() => {
          if (dwellRef.current.element === target) markSpot(target);
        }, 500);
      };
      const onLeave = () => {
        dwellRef.current.element = null;
        clearTimeout(dwellRef.current.timer);
        clearSpot();
      };
      const onClick = (event) => {
        const target = event.target;
        if (!target || target.nodeType !== 1) return;
        if (captureRef.current) {
          setTimeout(pause, 40);
          return;
        }
        const id = target.getAttribute && target.getAttribute('id');
        const tag = target.tagName ? target.tagName.toLowerCase() : 'node';
        if (!id && tag === 'svg') return;
        addMark({ kind: 'layer', path: doc.path, selector: id ? '#' + id : tag, quote: tag });
      };

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.code !== 'Space') return;
          const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
          event.preventDefault();
          const next = !captureRef.current;
          captureRef.current = next;
          setAnim((previous) => Object.assign({}, previous, { capture: next }));
          if (!next) clearSpot();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      React.useEffect(() => {
        if (state.status === 'ready') sync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.status, state.markup]);

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该 SVG'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '解析中…' : '……'));
      }
      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(AnimBar, {
          anim,
          onPause: pause,
          onResume: resume,
          onSeek: seek,
          onArm: (on) => {
            captureRef.current = on;
            setAnim((previous) => Object.assign({}, previous, { capture: on }));
            if (!on) clearSpot();
          },
        }),
        h('div', {
          ref: hostRef,
          className: 'dshcv-svg',
          onMouseOver: onHover,
          onMouseLeave: onLeave,
          onClick,
          dangerouslySetInnerHTML: { __html: state.markup },
        }),
      );
    }

    // ---------------- image viewer with region / layer picking ----------------

    // ---------------- image viewer with region / layer picking ----------------
    function ImageDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', error: '' });
      const [zoom, setZoom] = React.useState(1);
      const [selecting, setSelecting] = React.useState(false);
      const [marquee, setMarquee] = React.useState(null);
      const marqueeRef = React.useRef(null);
      const [layers, setLayers] = React.useState([]);
      const imageRef = React.useRef(null);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', url: '', error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        let objectUrl = '';
        setState({ status: 'loading', url: '', error: '' });
        const load = async () => {
          const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
          if (cancelled || !bytes) return;
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(doc.path) }));
          setState({ status: 'ready', url: objectUrl, error: '' });
          devlog('image-ready', ['path=' + doc.path, 'bytes=' + (bytes.byteLength || bytes.length || 0)]);
          if (/\.svg$/i.test(doc.path)) {
            const page = await readTextPages(sessionId, doc.path, controller.signal);
            let text = page.text;
            if (!text) {
              const svgBytes = await readBytesFile(sessionId, doc.path, controller.signal);
              if (svgBytes) text = new TextDecoder('utf-8', { fatal: false }).decode(svgBytes);
            }
            if (cancelled) return;
            const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
            const found = [];
            const nodes = parsed.querySelectorAll('[id], g, path, rect, circle, text, image');
            for (const node of Array.from(nodes)) {
              if (found.length >= 40) break;
              const id = node.getAttribute && node.getAttribute('id');
              const tag = node.tagName ? node.tagName.toLowerCase() : 'node';
              if (!id && tag !== 'g') continue;
              found.push({ key: (id || tag) + '-' + found.length, id, tag });
            }
            setLayers(found);
            devlog('svg-layers', ['count=' + found.length]);
          }
        };
        load().catch((error) => {
          if (cancelled) return;
          setState({ status: 'failed', url: '', error: errText(error) });
          devlog('image-failed', [errText(error)]);
        });
        return () => {
          cancelled = true;
          controller.abort();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
      }, [doc.path, sessionId]);

      const naturalRect = () => {
        const image = imageRef.current;
        if (!image) return null;
        const rect = image.getBoundingClientRect();
        const factor = image.naturalWidth ? image.naturalWidth / rect.width : 1;
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, factor };
      };

      const startSelect = (event) => {
        if (!selecting) return;
        const box = naturalRect();
        if (!box) return;
        event.preventDefault();
        const startX = event.clientX - box.left;
        const startY = event.clientY - box.top;
        const move = (moveEvent) => {
          const currentX = Math.min(box.width, Math.max(0, moveEvent.clientX - box.left));
          const currentY = Math.min(box.height, Math.max(0, moveEvent.clientY - box.top));
          const next = { left: Math.min(startX, currentX), top: Math.min(startY, currentY), width: Math.abs(currentX - startX), height: Math.abs(currentY - startY) };
          marqueeRef.current = next;
          setMarquee(next);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const current = marqueeRef.current;
          marqueeRef.current = null;
          setMarquee(null);
          if (current && current.width > 4 && current.height > 4) {
            addMark({
              kind: 'region',
              path: doc.path,
              rect: [
                Math.round(current.left * box.factor),
                Math.round(current.top * box.factor),
                Math.round(current.width * box.factor),
                Math.round(current.height * box.factor),
              ],
            });
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取图片'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '读取中…' : state.error || '……'));
      }

      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          h('button', { type: 'button', className: 'dshcv-btn', 'data-primary': selecting ? '1' : '0', onClick: () => setSelecting(!selecting) }, selecting ? '框选中…' : '框选区域'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(Math.max(0.25, zoom - 0.25)) }, '−'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, Math.round(zoom * 100) + '%'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(Math.min(4, zoom + 0.25)) }, '+'),
          layers.length ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, layers.length + ' 个 SVG 图层') : null,
        ),
        h(
          'div',
          { className: 'dshcv-scroll', style: { position: 'relative' } },
          h(
            'div',
            {
              style: { position: 'relative', display: 'inline-block', transform: 'scale(' + zoom + ')', transformOrigin: 'top left', cursor: selecting ? 'crosshair' : 'default' },
              onPointerDown: startSelect,
            },
            h('img', {
              ref: imageRef,
              src: state.url,
              alt: doc.path,
              style: { display: 'block', maxWidth: '100%', userSelect: 'none' },
              draggable: false,
            }),
            marquee
              ? h('div', {
                  style: {
                    position: 'absolute',
                    left: marquee.left + 'px',
                    top: marquee.top + 'px',
                    width: marquee.width + 'px',
                    height: marquee.height + 'px',
                    border: '2px solid var(--dsw-alias-brand-primary)',
                    background: 'rgba(47,111,235,.12)',
                    pointerEvents: 'none',
                  },
                })
              : null,
          ),
        ),
        layers.length
          ? h(
              'div',
              { style: { maxHeight: 140, overflow: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '6px 12px' } },
              layers.map((layer) =>
                h(
                  'button',
                  {
                    key: layer.key,
                    type: 'button',
                    className: 'dshcv-chip',
                    style: { marginRight: 6, marginBottom: 6 },
                    title: layer.id ? '#' + layer.id : layer.tag,
                    onClick: () =>
                      addMark({
                        kind: 'layer',
                        path: doc.path,
                        selector: layer.id ? '#' + layer.id : layer.tag,
                        quote: layer.tag,
                      }),
                  },
                  layer.id ? '#' + layer.id : '<' + layer.tag + '>',
                ),
              ),
            )
          : null,
      );
    }

    // ---------------- panel ----------------
    let ctxRef;
    const selectPanel = (panelId) => {
      const layout = ctxRef && ctxRef.get('layout');
      if (!layout) return false;
      try {
        layout.selectPanel(panelId);
        return true;
      } catch (error) {
        devlog('select-failed', [errText(error)]);
        return false;
      }
    };

    function CanvasPanel(props) {
      useVersion();
      const [ratio, setRatio] = React.useState(() => {
        try {
          const saved = parseFloat(localStorage.getItem('dsh.canvas.ratio') || '');
          return saved > 0.2 && saved < 0.8 ? saved : 0.52;
        } catch {
          return 0.52;
        }
      });
      const [toast, setToast] = React.useState('');
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [closing, setClosing] = React.useState(false);
      const reducedMotion = () =>
        Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const [revealed, setRevealed] = React.useState(reducedMotion);
      const [animating, setAnimating] = React.useState(!reducedMotion());

      React.useEffect(() => {
        if (reducedMotion() || revealed) return undefined;
        const frame = requestAnimationFrame(() => setRevealed(true));
        const timer = setTimeout(() => setAnimating(false), 260);
        return () => {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const closePanel = React.useRef(() => {});
      closePanel.current = () => {
        if (closing) return;
        if (reducedMotion()) {
          selectPanel(null);
          return;
        }
        setAnimating(true);
        setClosing(true);
        setRevealed(false);
        setTimeout(() => selectPanel(null), 210);
      };
      const bodyRef = React.useRef(null);
      const convRef = React.useRef(null);
      const [convBox, setConvBox] = React.useState(null);

      const active = store.docs.find((doc) => doc.id === store.activeId) || store.docs[0];

      React.useEffect(() => {
        devlog('panel-mount', ['docs=' + store.docs.length, 'hasFactory=' + (typeof props.renderFactorySlot === 'function')]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // The embedded Conversation sizes its transcript and pins its sticky
      // composer from its own box; a percentage inside an absolutely filled
      // pane left that box content-sized, so the composer scrolled away and the
      // last messages hid under it. Hand it the measured pixels instead.
      React.useEffect(() => {
        const element = convRef.current;
        if (!element || typeof ResizeObserver !== 'function') return undefined;
        const measure = () => {
          const height = element.clientHeight;
          const width = element.clientWidth;
          if (height > 0 && width > 0) setConvBox({ height, width });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      // Evidence from the live DOM: the seat sits *inside* the scroller as a
      // normal flex child, and the shell's docking rule never matches because an
      // embedded occurrence resolves `conversation.composer` to its
      // `data-chain-overlay-fallback` entry. Restore that marker so the shipped
      // CSS docks the seat, make the view area the scroller (the chat view gives
      // up its own scrolling under [data-conversation-scroll]), keep its scroll
      // bar clear of the composer, and follow the tail only while the reader is
      // already at the bottom.
      React.useEffect(() => {
        const host = convRef.current;
        if (!host) return undefined;
        const mark = 'data-conversation-composer-overlay';
        let seatObserver;
        let contentObserver;
        let area = null;
        let following = true;
        let anchor = 0;

        const onScroll = () => {
          if (!area) return;
          following = area.scrollHeight - area.scrollTop - area.clientHeight < 48;
          if (!following) anchor = area.scrollTop;
        };

        const onContent = () => {
          if (!area) return;
          if (following) {
            area.scrollTop = area.scrollHeight;
            anchor = area.scrollTop;
          } else if (Math.abs(area.scrollTop - anchor) > 1) {
            // A reader who stopped mid-transcript keeps their place even while
            // content streams in below.
            area.scrollTop = anchor;
          }
        };

        const attach = (next) => {
          if (!next || next === area) return;
          if (area) area.removeEventListener('scroll', onScroll);
          if (contentObserver) contentObserver.disconnect();
          area = next;
          area.addEventListener('scroll', onScroll, { passive: true });
          contentObserver = new MutationObserver(onContent);
          contentObserver.observe(area, { childList: true, subtree: true, characterData: true });
          following = true;
          area.scrollTop = area.scrollHeight;
        };

        const apply = () => {
          const scroller = host.querySelector('[data-conversation-scroll]');
          const trunk = host.querySelector('[data-chain-overlay-fallback]');
          if (!scroller || !trunk) return;
          if (!trunk.hasAttribute(mark)) trunk.setAttribute(mark, '');
          const seat = host.querySelector('[data-composer-seat]');
          const view = host.querySelector('[data-conversation-scroll] > [data-slot="conversation.session"]');
          const next = view && view.firstElementChild ? view.firstElementChild : null;
          if (!seat || !next) return;
          if (next.dataset.canvasScroller !== '1') {
            next.dataset.canvasScroller = '1';
            next.style.overflowY = 'auto';
            next.style.overflowX = 'hidden';
            next.style.minHeight = '0';
            next.style.scrollbarGutter = 'stable';
          }
          const need = seat.offsetHeight;
          if (need > 0 && next.dataset.canvasPad !== String(need)) {
            next.dataset.canvasPad = String(need);
            next.style.paddingBottom = need + 'px';
          }
          // The seat leaves room for the real scroll bar instead of covering it.
          const bar = Math.max(0, next.offsetWidth - next.clientWidth);
          scroller.style.setProperty('--dsh-scrollbar-width', bar + 'px');
          next.style.setProperty('--dsh-scrollbar-width', bar + 'px');
          attach(next);
          if (!seatObserver && typeof ResizeObserver === 'function') {
            seatObserver = new ResizeObserver(() => {
              const height = seat.offsetHeight;
              if (height > 0) {
                next.dataset.canvasPad = String(height);
                next.style.paddingBottom = height + 'px';
              }
            });
            seatObserver.observe(seat);
          }
        };
        apply();
        const timer = setTimeout(apply, 600);
        const observer = new MutationObserver(apply);
        observer.observe(host, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          clearTimeout(timer);
          if (seatObserver) seatObserver.disconnect();
          if (contentObserver) contentObserver.disconnect();
          if (area) area.removeEventListener('scroll', onScroll);
        };
      }, []);

      const startDrag = (event) => {
        event.preventDefault();
        const host = bodyRef.current;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const SPLIT = 9;
        const MIN_CONVERSATION = 320;
        const maxRatio = Math.max(0.25, Math.min(0.8, (rect.width - MIN_CONVERSATION - SPLIT) / rect.width));
        const move = (moveEvent) => {
          const raw = (moveEvent.clientX - rect.left) / rect.width;
          // The canvas pane owns a fixed basis, so the conversation always gets
          // the remainder; clamp before the conversation can hit its floor.
          const next = Math.min(maxRatio, Math.max(0.2, raw));
          setRatio(next);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setRatio((current) => {
            try {
              localStorage.setItem('dsh.canvas.ratio', String(current));
            } catch {
              /* ignore */
            }
            return current;
          });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      const send = () => {
        const result = sendMarks();
        setToast(result === 'ok' ? '已填入输入框' : result === 'copied' ? '已复制到剪贴板' : '没有可发送的标注');
        setTimeout(() => setToast(''), 2200);
      };

      const conversation = props.renderFactorySlot
        ? props.renderFactorySlot('conversation.content', {})
        : h('div', { className: 'dshcv-empty' }, h('div', null, '此窗口不支持嵌入对话'));

      return h(
        'div',
        { className: 'dshcv-root' },
        h(Styles, { panel: true }),
        h(
          'div',
          { className: 'dshcv-head' },
          h('span', { className: 'dshcv-title' }, '画布'),
          h('span', { className: 'dshcv-path' }, active ? active.path : '未打开交付物'),
          h('span', { className: 'dshcv-spacer' }),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setPickerOpen(!pickerOpen) }, '打开'),
          store.marks.length
            ? h(
                'button',
                { type: 'button', className: 'dshcv-btn', 'data-primary': '1', onClick: send },
                '发送标注 (' + store.marks.length + ')',
              )
            : null,
          store.marks.length
            ? h('button', { type: 'button', className: 'dshcv-btn', 'data-quiet': '1', onClick: clearMarks }, '清空')
            : null,
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => closePanel.current() }, '回到对话'),
        ),
        h(
          'div',
          { className: 'dshcv-body', ref: bodyRef },
          h(
            'div',
            {
              className:
                'dshcv-pane dshcv-reveal' +
                (closing ? ' dshcv-closing' : '') +
                (animating ? ' dshcv-animating' : ''),
              style: {
                flex: '0 0 ' + (revealed ? Math.round(ratio * 1000) / 10 : 0) + '%',
                minWidth: 0,
              },
            },
            store.docs.length
              ? h(
                  'div',
                  { className: 'dshcv-docs' },
                  store.docs.map((doc) =>
                    h(
                      'span',
                      { key: doc.id, style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshcv-chip',
                          'data-active': doc.id === (active && active.id) ? '1' : '0',
                          title: doc.path,
                          onClick: () => mutate({ activeId: doc.id }),
                        },
                        basename(doc.path),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshcv-btn',
                          'data-quiet': '1',
                          style: { padding: '0 5px', lineHeight: '16px' },
                          title: '关闭该交付物',
                          onClick: () => closeDoc(doc.id),
                        },
                        '×',
                      ),
                    ),
                  ),
                )
              : null,
            pickerOpen
              ? h(FilePicker, {
                  sessionId: store.sessionId,
                  onOpen: (path) => openDoc({ path }),
                  onClose: () => setPickerOpen(false),
                })
              : active
                ? active.view === 'html'
                  ? h(HtmlDoc, { key: active.id + '-html', doc: active, sessionId: store.sessionId })
                  : active.view === 'image'
                    ? /\.svg$/i.test(active.path)
                      ? h(SvgDoc, { key: active.id + '-svg', doc: active, sessionId: store.sessionId })
                      : h(ImageDoc, { key: active.id + '-image', doc: active, sessionId: store.sessionId })
                    : h(TextDoc, { key: active.id + '-text', doc: active, sessionId: store.sessionId })
                : h(
                    'div',
                    { className: 'dshcv-empty' },
                    h('div', { style: { fontSize: 13 } }, '这里显示交付物'),
                    h('div', null, '模型用 canvas 工具打开文件后，它出现在这里；'),
                    h('div', null, '划选文字、点选页面元素或框选图片区域，会生成编号标注，发送回对话即可。'),
                    h(
                      'button',
                      { type: 'button', className: 'dshcv-btn', style: { marginTop: 8 }, onClick: () => setPickerOpen(true) },
                      '打开文件…',
                    ),
                    h('div', { style: { marginTop: 4, fontSize: 11 } }, store.sessionId ? '当前会话已连接' : '等待会话…'),
                  ),
            h(MarksRail),
          ),
          h('div', { className: 'dshcv-split', onPointerDown: startDrag, title: '拖动调整宽度' }),
          h(
            'div',
            { className: 'dshcv-conv', ref: convRef },
            h(
              React.Suspense,
              { fallback: h('div', { className: 'dshcv-empty' }, '对话加载中…') },
              h(
                'div',
                {
                  className: 'dshcv-convfill',
                  style: convBox ? { width: convBox.width + 'px', height: convBox.height + 'px' } : undefined,
                },
                conversation,
              ),
            ),
          ),
        ),
        toast ? h('div', { className: 'dshcv-toast' }, toast) : null,
      );
    }

    // ---------------- registrations ----------------
    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        ctxRef = ctx;
        devlog('apply', [
          'layout=' + typeof ctx.get('layout'),
          'files=' + typeof ctx.get('remote.workspaceFiles'),
        ]);

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, CanvasPanel));

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'canvas-bridge', order: -100 }, Bridge),
        );

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'canvas' }, CanvasToolCard),
        );

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'canvas-panel-open', order: 60 },
            function OpenCanvasButton() {
              return h(
                React.Fragment,
                null,
                h(Styles),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcv-btn',
                    'data-quiet': '1',
                    title: '画布面板 / Canvas panel',
                    'aria-label': '画布面板',
                    onClick: () => selectPanel(PANEL_KEY),
                  },
                  h(
                    'svg',
                    {
                      width: 14,
                      height: 14,
                      viewBox: '0 0 16 16',
                      fill: 'none',
                      'aria-hidden': true,
                      style: { flex: '0 0 auto' },
                    },
                    h('rect', { x: 2.25, y: 2.75, width: 11.5, height: 10.5, rx: 2.25, stroke: 'currentColor', strokeWidth: 1.4 }),
                    h('path', { d: 'M6.6 3.2v9.6', stroke: 'currentColor', strokeWidth: 1.4 }),
                  ),
                  '画布',
                ),
              );
            },
          ),
        );
      },
    };
  },
});
