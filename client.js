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

    // Diagnostics stay silent in the delivered plugin; point this at
    // console.debug while iterating on a viewer.
    const devlog = () => {};

    // ---------------- tiny shared store ----------------
    const listeners = new Set();
    let version = 0;
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
    };
    const subscribe = (listener) => {
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

    const restore = () => {
      if (store.restored || !store.sessionId) return;
      store.restored = true;
      try {
        const raw = localStorage.getItem(storageKey());
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.docs)) store.docs = data.docs;
        if (Array.isArray(data.marks)) store.marks = data.marks;
        if (typeof data.activeId === 'string') store.activeId = data.activeId;
        if (typeof data.seq === 'number') store.seq = data.seq;
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

    const addTextMark = (path, startLine, endLine, quote) => {
      if (!path) return;
      const n = store.seq + 1;
      const mark = {
        id: 'm' + Date.now().toString(36) + n,
        n,
        kind: 'text',
        path,
        lines: [startLine, endLine],
        quote: String(quote || '').slice(0, 1200),
        note: '',
      };
      mutate({ marks: store.marks.concat(mark), seq: n });
      persist();
      devlog('mark-added', ['n=' + n, 'lines=' + startLine + '-' + endLine]);
    };

    const addMark = (partial) => {
      if (!partial || !partial.path) return;
      const n = store.seq + 1;
      const mark = Object.assign({ id: 'm' + Date.now().toString(36) + n, n, note: '' }, partial);
      mutate({ marks: store.marks.concat(mark), seq: n });
      persist();
      devlog('mark-added', ['n=' + n, 'kind=' + mark.kind]);
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
      const path = String((input && input.path) || '');
      if (!path) return;
      const view = resolveView(input && input.view, path);
      if (!store.sessionId) {
        store.pending = { path, view: input && input.view, note: input && input.note, line: input && input.line };
        devlog('doc-pending', ['path=' + path]);
        return;
      }
      const existing = store.docs.find((doc) => doc.path === path);
      let docs;
      let activeId;
      if (existing) {
        docs = store.docs.map((doc) => (doc.id === existing.id ? Object.assign({}, doc, { view, note: input.note, line: input.line }) : doc));
        activeId = existing.id;
      } else {
        const id = 'd' + Date.now().toString(36);
        docs = store.docs.concat({ id, path, view, note: input && input.note, line: input && input.line });
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
    const CSS = [
      '.dshcv-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshcv-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:40px}',
      '.dshcv-title{font-size:13px;font-weight:600;white-space:nowrap}',
      '.dshcv-path{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-spacer{flex:1 1 auto}',
      '.dshcv-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}',
      '.dshcv-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcv-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dshcv-btn[data-quiet="1"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-body{display:flex;flex:1 1 auto;min-height:0}',
      '.dshcv-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}',
      '.dshcv-split{flex:0 0 7px;cursor:col-resize;background:var(--dsw-alias-border-l1)}',
      '.dshcv-split:hover{background:var(--dsw-alias-brand-primary)}',
      '.dshcv-docs{display:flex;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}',
      '.dshcv-chip{font-size:12px;padding:3px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}',
      '.dshcv-chip[data-active="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dshcv-scroll{flex:1 1 auto;min-height:0;overflow:auto}',
      '.dshcv-code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 0}',
      '.dshcv-line{display:flex;gap:10px;padding:0 12px;white-space:pre}',
      '.dshcv-line:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcv-num{color:var(--dsw-alias-label-secondary);user-select:none;text-align:right;min-width:42px;flex:0 0 auto}',
      '.dshcv-text{white-space:pre}',
      '.dshcv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}',
      '.dshcv-marks{flex:0 0 auto;max-height:38%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px}',
      '.dshcv-mark{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-badge{flex:0 0 auto;min-width:20px;height:20px;border-radius:10px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:11px;line-height:20px;text-align:center;padding:0 5px}',
      '.dshcv-markbody{flex:1 1 auto;min-width:0}',
      '.dshcv-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-quote{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;margin:4px 0;max-height:56px;overflow:hidden}',
      '.dshcv-note{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical}',
      '.dshcv-pick{position:fixed;z-index:60;transform:translate(-50%,-100%);box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '.dshcv-toast{position:absolute;right:16px;top:48px;z-index:50;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 12px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.16)}',
      '.dshcv-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin:6px 0;display:flex;align-items:center;gap:10px}',
    ].join('\n');

    const Styles = () => h('style', { 'data-dshcv': '1' }, CSS);

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
        // Open the panel even when the argument shape was unreadable: the call
        // itself means the user should be looking at the canvas.
        selectPanel(PANEL_KEY);
        if (path) openDoc({ path, view: args && args.view, note: args && args.note, line: args && args.line });
      }, [props.phase, props.callId, path]);

      if (!path) {
        return h(
          'div',
          { className: 'dshcv-card' },
          h('span', { style: { fontSize: 13 } }, '🖼'),
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, '在画布面板中查看'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => selectPanel(PANEL_KEY) }, '打开画布'),
        );
      }
      return h(
        'div',
        { className: 'dshcv-card' },
        h('span', { style: { fontSize: 13 } }, '🖼'),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { className: 'dshcv-path' }, path),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '已在画布面板中打开 / opened in the canvas panel'),
        ),
        h(
          'button',
          { type: 'button', className: 'dshcv-btn', onClick: () => { openDoc({ path, view: args && args.view }); selectPanel(PANEL_KEY); } },
          '查看',
        ),
      );
    }

    // ---------------- text viewer ----------------
    function TextDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', text: '', error: '' });
      const [picked, setPicked] = React.useState(null);
      const scrollRef = React.useRef(null);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', text: '', error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', text: '', error: '' });
        const load = async () => {
          try {
            const text = await readTextPages(sessionId, doc.path, controller.signal);
            if (cancelled) return;
            setState({ status: 'ready', text, error: '' });
            devlog('read-ok', ['path=' + doc.path, 'chars=' + text.length]);
          } catch (error) {
            if (cancelled) return;
            setState({ status: 'failed', text: '', error: errText(error) });
            devlog('read-failed', ['path=' + doc.path, 'error=' + errText(error)]);
          }
        };
        load();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

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
        addTextMark(doc.path, picked.startLine, picked.endLine, picked.quote);
        setPicked(null);
        try {
          window.getSelection().removeAllRanges();
        } catch {
          /* ignore */
        }
      };

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取该文件'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '读取中…' : state.error || '……'));
      }

      return h(
        React.Fragment,
        null,
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
      for (let page = 0; page < 12; page += 1) {
        const result = unwrap(await files.read(sessionId, path, { offset }, signal));
        if (page === 0) {
          devlog('read-page0', [
            'path=' + path,
            'textLen=' + String(result && typeof result.text === 'string' ? result.text.length : -1),
            'eof=' + String(result && result.eof),
          ]);
        }
        text += (text ? '\n' : '') + String(result && result.text ? result.text : '');
        if (!result || result.eof) break;
        offset += Math.max(1, Number(result.lines) || 1000);
      }
      return text;
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
    const PICKER_SCRIPT = [
      '(function(){',
      'var box=null;',
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
      'document.addEventListener("mousemove",function(e){var el=e.target;if(!el||el.nodeType!==1)return;var b=overlay();var r=el.getBoundingClientRect();',
      'b.style.display="block";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";},true);',
      'document.addEventListener("click",function(e){var el=e.target;if(!el||el.nodeType!==1)return;e.preventDefault();e.stopPropagation();',
      'var r=el.getBoundingClientRect();var text=(el.innerText||el.textContent||"").trim().slice(0,240);',
      'parent.postMessage({source:"dshcv-picker",selector:sel(el),tag:el.tagName.toLowerCase(),text:text,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]},"*");},true);',
      '})();',
    ].join('\n');

    const injectPicker = (html) => {
      const tag = '<scr' + 'ipt>' + PICKER_SCRIPT + '</scr' + 'ipt>';
      if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
      return html + tag;
    };

    function HtmlDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', error: '' });
      const frameRef = React.useRef(null);

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
          .then(async (text) => {
            let html = text;
            if (!html) {
              devlog('html-empty-text', ['trying bytes']);
              const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
              if (bytes) html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            }
            if (cancelled) return;
            objectUrl = URL.createObjectURL(new Blob([injectPicker(html)], { type: 'text/html' }));
            setState({ status: 'ready', url: objectUrl, error: '' });
            devlog('html-ready', ['path=' + doc.path, 'chars=' + html.length]);
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', url: '', error: errText(error) });
            devlog('html-failed', [errText(error)]);
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
          if (!data || data.source !== 'dshcv-picker') return;
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
      return h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h('div', { style: { padding: '6px 12px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '点选页面元素即可生成编号标注'),
        h('iframe', {
          ref: frameRef,
          src: state.url,
          title: 'canvas html preview',
          sandbox: 'allow-scripts',
          style: { flex: '1 1 auto', minHeight: 0, width: '100%', border: '0', background: '#fff' },
        }),
      );
    }

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
            let text = await readTextPages(sessionId, doc.path, controller.signal);
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
      const bodyRef = React.useRef(null);

      const active = store.docs.find((doc) => doc.id === store.activeId) || store.docs[0];

      React.useEffect(() => {
        devlog('panel-mount', ['docs=' + store.docs.length, 'hasFactory=' + (typeof props.renderFactorySlot === 'function')]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const startDrag = (event) => {
        event.preventDefault();
        const host = bodyRef.current;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const move = (moveEvent) => {
          const next = Math.min(0.8, Math.max(0.2, (moveEvent.clientX - rect.left) / rect.width));
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
        h(Styles),
        h(
          'div',
          { className: 'dshcv-head' },
          h('span', { className: 'dshcv-title' }, '画布'),
          h('span', { className: 'dshcv-path' }, active ? active.path : '未打开交付物'),
          h('span', { className: 'dshcv-spacer' }),
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
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => selectPanel(null) }, '回到对话'),
        ),
        h(
          'div',
          { className: 'dshcv-body', ref: bodyRef },
          h(
            'div',
            { className: 'dshcv-pane', style: { flexBasis: ratio * 100 + '%', flexGrow: 1, flexShrink: 1 } },
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
            active
              ? active.view === 'html'
                ? h(HtmlDoc, { key: active.id + '-html', doc: active, sessionId: store.sessionId })
                : active.view === 'image'
                  ? h(ImageDoc, { key: active.id + '-image', doc: active, sessionId: store.sessionId })
                  : h(TextDoc, { key: active.id + '-text', doc: active, sessionId: store.sessionId })
              : h(
                  'div',
                  { className: 'dshcv-empty' },
                  h('div', { style: { fontSize: 13 } }, '这里显示交付物'),
                  h('div', null, '模型用 canvas 工具打开文件后，它出现在这里；'),
                  h('div', null, '划选文字、点选页面元素或框选图片区域，会生成编号标注，发送回对话即可。'),
                  h('div', { style: { marginTop: 8, fontSize: 11 } }, store.sessionId ? '当前会话已连接' : '等待会话…'),
                ),
            h(MarksRail),
          ),
          h('div', { className: 'dshcv-split', onPointerDown: startDrag, title: '拖动调整宽度' }),
          h(
            'div',
            { className: 'dshcv-pane', style: { flex: '1 1 0', minWidth: 0 } },
            h(
              React.Suspense,
              { fallback: h('div', { className: 'dshcv-empty' }, '对话加载中…') },
              conversation,
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
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-quiet': '1',
                  title: '打开画布面板 / Open canvas panel',
                  onClick: () => selectPanel(PANEL_KEY),
                },
                '画布',
              );
            },
          ),
        );
      },
    };
  },
});
