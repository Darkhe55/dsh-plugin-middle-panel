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
    // "Failed to fetch" tells the user nothing; a network-level failure here always
    // means the request never reached this app's own server.
    const netText = (error, action) => {
      const raw = errText(error);
      if (/failed to fetch|networkerror|load failed/i.test(raw)) {
        return action + '失败：请求没有到达本机服务（' + location.origin + '）。请确认 DSH 仍在运行，然后刷新页面重试。';
      }
      return action + '失败：' + raw;
    };
    const basename = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');

    // A rail row shows the path the tab header shows, so a reviewer can tell two
    // same-named files apart. Long paths keep the first segment and the file name
    // and fold the middle, which is the part that repeats.
    const shortenPath = (path, max) => {
      const value = String(path || '');
      const limit = max || 30;
      if (value.length <= limit) return value;
      const parts = value.split('/');
      const name = parts[parts.length - 1] || value;
      const head = parts.length > 1 ? parts[0] : '';
      if (head && name.length + head.length + 4 <= limit) return head + '/…/' + name;
      if (name.length + 2 <= limit) return '…/' + name;
      return '…' + value.slice(-(limit - 1));
    };

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
      // Targets waiting for the session id, drained in order once it arrives.
      pendingList: undefined,
      // Side by side: which second deliverable shares the panel, at what ratio.
      split: { on: false, secondId: null, ratio: 0.5, dir: 'row' },
      // Which slot the annotation rail and the toolbar follow.
      splitFocus: 'a',
      marks: [],
      seq: 0,
      restored: false,
      reportedBridge: false,
      reportedBlock: false,
      // Transient UI state: the floating confirmation shown after a copy action.
      flash: '',
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

    // Last mtime seen per file: it stamps new marks and detects marks that the
    // file has since outgrown.
    const fileVersions = new Map();
    const noteFileVersion = (path, version) => {
      const key = pathKey(path);
      const stamp = Number(version) || 0;
      if (!key || !stamp) return;
      if (fileVersions.get(key) === stamp) return;
      fileVersions.set(key, stamp);
      notify();
    };
    const fileVersionOf = (path) => fileVersions.get(pathKey(path)) || 0;

    // Hovering a mark in the rail spotlights the same spot in the viewer. This is
    // transient UI state: it is never persisted and never leaves the panel. It also
    // has its own subscription channel, so moving the mouse does not re-render
    // components that only care about marks and documents.
    const hoverListeners = new Set();
    let hoverVersion = 0;
    const notifyHover = () => {
      hoverVersion += 1;
      for (const listener of Array.from(hoverListeners)) listener();
    };
    const subscribeHover = (listener) => {
      hoverListeners.add(listener);
      return () => hoverListeners.delete(listener);
    };
    const useHoverVersion = () => React.useSyncExternalStore(subscribeHover, () => hoverVersion);
    const setHoverMark = (id) => {
      if (store.hoverId === id) return;
      store.hoverId = id;
      notifyHover();
    };
    const hoveredMarkFor = (path) => {
      if (!store.hoverId) return null;
      const mark = store.marks.find((candidate) => candidate.id === store.hoverId);
      return mark && sameFile(mark.path, path) ? mark : null;
    };
    const useHoverMark = (path) => {
      useHoverVersion();
      return hoveredMarkFor(path);
    };
    // Following a hovered mark by scrolling is a preference, remembered per install.
    const followHover = { on: true };
    try {
      const saved = localStorage.getItem('dsh.canvas.follow');
      if (saved === '0' || saved === '1') followHover.on = saved === '1';
    } catch {
      /* storage is best effort */
    }
    const followHoverOn = () => followHover.on;
    // Whether sending also empties the rail; a review session often wants to keep
    // the entries around until the round is finished.
    const sendPrefs = { autoClear: false };
    try {
      sendPrefs.autoClear = localStorage.getItem('dsh.canvas.autoclear') === '1';
    } catch {
      /* storage is best effort */
    }
    const autoClearAfterSend = () => sendPrefs.autoClear;
    const toggleAutoClear = () => {
      sendPrefs.autoClear = !sendPrefs.autoClear;
      try {
        localStorage.setItem('dsh.canvas.autoclear', sendPrefs.autoClear ? '1' : '0');
      } catch {
        /* storage is best effort */
      }
      notify();
    };


    const setFollowHover = (on) => {
      followHover.on = Boolean(on);
      try {
        localStorage.setItem('dsh.canvas.follow', followHover.on ? '1' : '0');
      } catch {
        /* storage is best effort */
      }
      notify();
    };
    // A mark is stale once the file it points into reports a different mtime.
    const markStale = (mark) => {
      if (mark.spotStale) return true;
      const current = fileVersionOf(mark.path);
      return Boolean(mark.mtimeMs && current && Math.abs(mark.mtimeMs - current) > 1);
    };

    const persist = () => {
      try {
        localStorage.setItem(
          storageKey(),
          JSON.stringify({
            docs: store.docs,
            activeId: store.activeId,
            marks: store.marks,
            seq: store.seq,
            split: splitState(),
            splitFocus: store.splitFocus,
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
      if (data.split && typeof data.split === 'object') {
        store.split = {
          on: Boolean(data.split.on),
          secondId: typeof data.split.secondId === 'string' ? data.split.secondId : null,
          ratio: Math.min(0.8, Math.max(0.2, Number(data.split.ratio) || 0.5)),
          dir: data.split.dir === 'column' ? 'column' : 'row',
        };
        // A stale second id would leave an empty half behind.
        if (store.split.on && !store.docs.some((doc) => doc.id === store.split.secondId)) {
          store.split = { on: false, secondId: null, ratio: store.split.ratio, dir: store.split.dir };
        }
      }
      if (data.splitFocus === 'b') store.splitFocus = 'b';
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
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng'].includes(ext)) return 'image';
if (['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts'].includes(ext)) return 'video';
      if (ext === 'pdf') return 'pdf';
      if (['stl', 'obj', 'glb', 'gltf', 'ply', 'off', 'noff', 'coff', 'cnoff', '3mf', 'dae'].includes(ext)) return 'model';
      if (ext === 'dxf') return 'cad';
      if (['psd', 'ai', 'sketch', 'xd', 'fig', 'eps', 'afdesign'].includes(ext)) return 'design';
      if (['step', 'stp', 'iges', 'igs', 'dwg', 'fbx', '3ds', 'blend', 'skp', 'sldprt', 'ipt'].includes(ext)) return 'unsupported';
      if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(ext)) return 'office';
      if (['csv', 'tsv'].includes(ext)) return 'sheet';
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
      if (left.kind === 'paragraph') return left.paragraph === right.paragraph;

    // A clip mark is the same spot when both ends land within a fifth of a second.
      if (left.kind === 'video') {
        return Math.abs(Number(left.start) - Number(right.start)) <= 0.2 && Math.abs(Number(left.end) - Number(right.end)) <= 0.2;
      }
      // A generic pick: page, cell, slide, triangle, layer or pixel, identified by
      // its human-readable locator.
      if (left.kind === 'spot') return left.label === right.label;
      if (left.kind === 'region') {
        if (Boolean(left.norm) !== Boolean(right.norm)) return false;
        if (left.norm && Number(left.page || 0) !== Number(right.page || 0)) return false;
        const a = left.rect || [];
        const b = right.rect || [];
        // Normalised rectangles (0..1) need a proportional tolerance; pixels use 2px.
        const tolerance = left.norm ? 0.01 : 2;
        return (
          a.length === b.length &&
          a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= tolerance)
        );
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
      // Numbers stay dense: they follow the marks that exist, so a cleared or
      // restored list always continues from what is actually on screen.
      const highest = store.marks.reduce((max, candidate) => Math.max(max, Number(candidate.n) || 0), 0);
      const n = highest + 1;
      const created = Object.assign({ id: 'm' + Date.now().toString(36) + n, n, note: '' }, mark);
      mutate({ marks: store.marks.concat(created), seq: n });
      persist();
      devlog('mark-added', ['n=' + n, 'kind=' + created.kind]);
      return n;
    };

    const addTextMark = (path, startLine, endLine, quote, context) => {
      if (!path) return 0;
      const created = {
        kind: 'text',
        path: normalizePath(path),
        lines: [startLine, endLine],
        quote: String(quote || '').slice(0, 1200),
      };
      if (context) created.context = context;
      return upsertMark(created);
    };

    // Marks store line numbers, which drift whenever the file is edited. Each text
    // mark also keeps the text just before and after it, so a moved passage can be
    // found again instead of merely being flagged as stale.
    const similarChars = (left, right) => {
      const a = String(left || '');
      const b = String(right || '');
      let score = 0;
      const limit = Math.min(a.length, b.length);
      for (let index = 0; index < limit; index += 1) {
        if (a[a.length - 1 - index] === b[b.length - 1 - index]) score += 1;
        else break;
      }
      return score;
    };
    const similarCharsForward = (left, right) => {
      const a = String(left || '');
      const b = String(right || '');
      let score = 0;
      const limit = Math.min(a.length, b.length);
      for (let index = 0; index < limit; index += 1) {
        if (a[index] === b[index]) score += 1;
        else break;
      }
      return score;
    };
    const relocateOne = (text, mark) => {
      const needle = String(mark.quote || '').split('\n')[0].trim().slice(0, 80);
      if (!needle) return null;
      const context = mark.context || {};
      let best = { index: -1, score: -1 };
      let from = text.indexOf(needle);
      let guard = 0;
      while (from >= 0 && guard < 200) {
        guard += 1;
        let score = 0;
        // The text before a passage is more discriminating than what follows it.
        if (context.before) score += 2 * similarChars(text.slice(Math.max(0, from - context.before.length), from), context.before);
        if (context.after) score += similarCharsForward(text.slice(from + needle.length, from + needle.length + context.after.length), context.after);
        if (score > best.score) best = { index: from, score };
        if (best.score >= 24) break;
        from = text.indexOf(needle, from + 1);
      }
      return best.index >= 0 ? best : null;
    };
    const relocateMarks = (path, text, version) => {
      if (!text || !version) return;
      const lineOf = (index) => text.slice(0, index).split('\n').length;
      let changed = 0;
      const next = store.marks.map((mark) => {
        if (!sameFile(mark.path, path) || mark.kind !== 'text' || !mark.quote || !mark.context) return mark;
        if (mark.mtimeMs && Math.abs(mark.mtimeMs - version) < 2) return mark;
        const found = relocateOne(text, mark);
        if (!found) return mark;
        const start = lineOf(found.index);
        const span = String(mark.quote).split('\n').length;
        const end = Math.max(start, start + span - 1);
        const already = mark.lines && mark.lines[0] === start && mark.lines[1] === end;
        if (already && Math.abs((mark.mtimeMs || 0) - version) < 2) return mark;
        changed += 1;
        return Object.assign({}, mark, { lines: [start, end], mtimeMs: version, relocated: true });
      });
      if (changed) {
        mutate({ marks: next });
        persist();
        devlog('marks-relocated', ['count=' + changed]);
      }
    };

    // A 3D mark names a face by index, which only holds for the exact export that
    // produced it. The centroid recorded with the mark finds the same face again
    // after a re-export: first at the same index, then by nearest match.
    const relocateSpotMarks = (path, positions, radius) => {
      if (!positions || !positions.length) return;
      const total = Math.floor(positions.length / 9);
      if (!total) return;
      const tolerance = Math.max(1e-9, Number(radius || 1) * 0.01);
      const limit = tolerance * tolerance;
      let changed = 0;
      const next = store.marks.map((mark) => {
        if (!sameFile(mark.path, path) || mark.kind !== 'spot') return mark;
        if (typeof mark.triangle !== 'number') return mark;
        if (!Array.isArray(mark.centroid) || mark.centroid.length !== 3) return mark;
        const centerX = Number(mark.centroid[0]) || 0;
        const centerY = Number(mark.centroid[1]) || 0;
        const centerZ = Number(mark.centroid[2]) || 0;
        const distanceSquared = (triangle) => {
          const base = triangle * 9;
          const dx = (positions[base] + positions[base + 3] + positions[base + 6]) / 3 - centerX;
          const dy = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3 - centerY;
          const dz = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3 - centerZ;
          return dx * dx + dy * dy + dz * dz;
        };
        if (mark.triangle >= 0 && mark.triangle < total && distanceSquared(mark.triangle) <= limit) {
          if (!mark.spotStale) return mark;
          changed += 1;
          return Object.assign({}, mark, { spotStale: false });
        }
        // A full scan is only worth it while the model stays interactive; past that
        // the mark is flagged instead of freezing the viewer.
        let best = -1;
        let bestDistance = Infinity;
        if (total <= 1500000) {
          for (let triangle = 0; triangle < total; triangle += 1) {
            const value = distanceSquared(triangle);
            if (value < bestDistance) {
              bestDistance = value;
              best = triangle;
            }
          }
        }
        if (best >= 0 && bestDistance <= limit * 4) {
          changed += 1;
          return Object.assign({}, mark, { triangle: best, spotStale: false, relocated: true });
        }
        if (mark.spotStale) return mark;
        changed += 1;
        return Object.assign({}, mark, { spotStale: true });
      });
      if (changed) {
        mutate({ marks: next });
        persist();
        devlog('spot-marks-relocated', ['changed=' + changed]);
      }
    };

    const addMark = (partial) => {
      if (!partial || !partial.path) return 0;
      const path = normalizePath(partial.path);
      // Stamp the file version the mark was made against, so a later edit can be
      // reported as "this annotation may have moved" instead of mismarking quietly.
      const known = fileVersionOf(path);
      const stamped = Object.assign({}, partial, { path });
      if (known && !stamped.mtimeMs) stamped.mtimeMs = known;
      return upsertMark(stamped);
    };

    const setMarkNote = (id, note) => {
      mutate({
        marks: store.marks.map((mark) => (mark.id === id ? Object.assign({}, mark, { note }) : mark)),
      });
      persist();
    };

    // Review receipt: a mark keeps its number, but once the change lands in the file
    // the mark can be ticked off instead of deleted, so the trail survives.
    const toggleDone = (id) => {
      mutate({
        marks: store.marks.map((mark) => (mark.id === id ? Object.assign({}, mark, { done: !mark.done }) : mark)),
      });
      persist();
    };
    const pendingMarks = () => store.marks.filter((mark) => !mark.done);

    const removeMark = (id) => {
      mutate({ marks: store.marks.filter((mark) => mark.id !== id) });
      persist();
    };

    const clearMarks = () => {
      mutate({ marks: [], seq: 0 });
      persist();
    };

    // One tool call may carry several deliverables: open them all, then make the
    // first one active so the call still lands on the thing it named first.
    const openDocs = (inputs) => {
      if (!Array.isArray(inputs) || !inputs.length) return '';
      let firstPath = '';
      for (const input of inputs) {
        const target = normalizePath(input && input.path);
        if (!target) continue;
        if (!firstPath) firstPath = target;
        openDoc(input);
      }
      if (firstPath) {
        const target = store.docs.find((doc) => sameFile(doc.path, firstPath));
        if (target && target.id !== store.activeId) mutate({ activeId: target.id });
      }
      return firstPath;
    };

    const openDoc = (input) => {
      const path = normalizePath(input && input.path);
      if (!path) return;
      const view = resolveView(input && input.view, path);
      // The session may not be known yet; queue every target instead of only the
      // last one, otherwise a multi-file call would silently drop the earlier tabs.
      if (!store.sessionId) {
        const queue = Array.isArray(store.pendingList) ? store.pendingList : [];
        queue.push({ path, view: input && input.view, note: input && input.note, line: input && input.line });
        store.pendingList = queue;
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

    const atLeastTwoDocs = () => store.docs.length > 1;

    // The split is a view over two documents; the marks stay attached to files.
    const splitState = () => store.split || { on: false, secondId: null, ratio: 0.5, dir: 'row' };
    const secondDoc = () => {
      const state = splitState();
      if (!state.secondId) return null;
      return store.docs.find((doc) => doc.id === state.secondId) || null;
    };
    const setSplit = (patch) => mutate({ split: Object.assign({}, splitState(), patch) });

    const focusDoc = (doc) => {
      if (!doc) return;
      const state = splitState();
      if (!state.on) {
        mutate({ activeId: doc.id });
        return;
      }
      if (doc.id === store.activeId) {
        mutate({ splitFocus: 'a' });
        return;
      }
      if (doc.id === state.secondId) {
        mutate({ splitFocus: 'b' });
        return;
      }
      // A third tab replaces whichever half is not focused.
      if ((store.splitFocus || 'a') === 'b') {
        mutate({ activeId: doc.id, splitFocus: 'a' });
      } else {
        mutate({ split: Object.assign({}, state, { secondId: doc.id }), splitFocus: 'b' });
      }
    };

    const toggleSplit = () => {
      const state = splitState();
      if (state.on) {
        mutate({ split: Object.assign({}, state, { on: false, secondId: null }), splitFocus: 'a' });
        return;
      }
      const other = store.docs.find((doc) => doc.id !== store.activeId);
      if (!other) {
        flash('再打开一个交付物，就能并排对比');
        return;
      }
      mutate({ split: Object.assign({}, state, { on: true, secondId: other.id }), splitFocus: 'a' });
    };

    const closeDoc = (id) => {
      const state = splitState();
      if (state.on && state.secondId === id) {
        const fallback = store.docs.find((doc) => doc.id !== id && doc.id !== store.activeId);
        mutate({
          split: Object.assign({}, state, { on: Boolean(fallback), secondId: fallback ? fallback.id : null }),
          splitFocus: 'a',
        });
        if (fallback) return;
      }
      const docs = store.docs.filter((doc) => doc.id !== id);
      const activeId = store.activeId === id ? (docs.length ? docs[docs.length - 1].id : undefined) : store.activeId;
      mutate({ docs, activeId });
      persist();
    };

    const activateDoc = (id) => {
      if (!id || id === store.activeId) return;
      mutate({ activeId: id });
      persist();
    };

    const cycleDoc = (delta) => {
      const docs = store.docs;
      if (docs.length < 2) return;
      const index = docs.findIndex((doc) => doc.id === store.activeId);
      const next = ((index < 0 ? 0 : index) + delta + docs.length) % docs.length;
      activateDoc(docs[next].id);
    };

    // Where a mark points, in words. Shared by the outline and the per-mark copy.
    // 00:12.4 — one decimal points at a frame pair without pretending to be exact.
    const formatTime = (value) => {
      const total = Math.max(0, Number(value) || 0);
      // Round first: 9.96 is ten seconds, not "010.0".
      const minutes = Math.floor(total / 60);
      const seconds = Math.round((total - minutes * 60) * 10) / 10;
      return String(minutes).padStart(2, '0') + ':' + (seconds < 10 ? '0' : '') + seconds.toFixed(1);
    };
    const timeLabel = (mark) => formatTime(mark && mark.start) + '–' + formatTime(mark && mark.end);

    // A clip mark jumps back to its moment when clicked.
    const seekVideoMark = (mark) => {
      mutate({ seek: { path: mark.path, time: Number(mark.start) || 0, stamp: Date.now() } });
    };
    const markPlace = (mark) =>
      mark.kind === 'video'
        ? h(
            'button',
            {
              key: 'where',
              type: 'button',
              className: 'dshcv-timecode',
              title: '跳到这一时刻',
              onClick: () => seekVideoMark(mark),
            },
            timeLabel(mark) + (Array.isArray(mark.rect) ? ' · 画面区域' : ''),
          )
        : markWhere(mark);

    // ---------------- code highlighting ----------------
    // A small tokenizer instead of a syntax library: the panel ships as one file with
    // no runtime dependencies, and reading code only needs keywords, strings,
    // comments, numbers and call sites to stand apart.
    const CODE_LANG = {
      js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
      ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
      json: 'json', jsonc: 'json', json5: 'json',
      html: 'html', htm: 'html', xml: 'html', xsl: 'html', vue: 'html',
      css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
      py: 'py', pyw: 'py',
      rs: 'rs', go: 'go',
      java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java',
      c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', cs: 'c',
      php: 'php', rb: 'rb', lua: 'lua',
      sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh',
      yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml', cfg: 'yaml', conf: 'yaml',
      sql: 'sql',
      graphql: 'js', gql: 'js', prisma: 'js',
    };

    const codeLangOf = (path) => {
      const match = /\.([a-z0-9]+)$/i.exec(String(path || ''));
      return match ? CODE_LANG[match[1].toLowerCase()] || '' : '';
    };

    const CODE_KEYWORDS = {
      js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof in of delete void yield static null undefined true false',
      ts: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof in of delete void yield static null undefined true false interface type enum implements declare readonly public private protected abstract as satisfies namespace keyof infer never unknown any',
      json: 'true false null',
      css: 'important media supports keyframes import font-face root',
      py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self match case',
      rs: 'fn let mut const struct enum impl trait for while loop if else match return use mod pub crate self super as where async await move ref dyn box unsafe true false Some None Ok Err',
      go: 'func var const type struct interface map chan go defer select case switch default for range if else return break continue package import nil true false make new len cap append',
      java: 'public private protected class interface extends implements new return if else for while do switch case break continue static final void int long double float boolean char byte short this super try catch finally throw throws import package abstract synchronized volatile transient native enum record true false null instanceof var',
      c: 'int char float double void long short unsigned signed struct union enum typedef static const volatile extern return if else for while do switch case break continue sizeof goto class namespace template public private protected virtual override new delete this nullptr true false using include define',
      php: 'function class return if else elseif foreach for while switch case break continue new echo print public private protected static const use namespace try catch finally throw true false null array isset unset',
      rb: 'def end class module return if elsif else unless while until for in do begin rescue ensure raise yield lambda proc true false nil self require include attr_accessor',
      lua: 'function local return if then elseif else end for while repeat until do break in pairs ipairs true false nil and or not require',
      sh: 'if then else elif fi for while do done case esac function return export local set unset echo cd exit source alias read shift',
      yaml: 'true false null yes no on off',
      sql: 'select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset union all distinct as and or not null is in like between case when then else end primary key foreign references default',
    };

    // \x60 keeps a literal backtick out of this source line while still quoting
    // template strings; the second entry is a single quote.
    const CODE_BACKTICK = '\x60';
    const CODE_SINGLE = String.fromCharCode(39);
    const CODE_DOUBLE = String.fromCharCode(34);

    const CODE_COMMENT = {
      js: '//', ts: '//', css: '', json: '', html: '',
      py: '#', rs: '//', go: '//', java: '//', c: '//', php: '//',
      rb: '#', lua: '--', sh: '#', yaml: '#', sql: '--',
    };
    const CODE_BLOCK = {
      js: ['/*', '*/'], ts: ['/*', '*/'], css: ['/*', '*/'], c: ['/*', '*/'],
      java: ['/*', '*/'], php: ['/*', '*/'], rs: ['/*', '*/'], go: ['/*', '*/'],
      sql: ['/*', '*/'], html: ['<!--', '-->'],
    };
    const CODE_TYPE_LANGS = { ts: true, rs: true, go: true, java: true, c: true };

    const codeQuotes = (lang) => {
      const base = CODE_SINGLE + CODE_DOUBLE;
      if (lang === 'js' || lang === 'ts' || lang === 'go') return base + CODE_BACKTICK;
      if (lang === 'json') return CODE_DOUBLE;
      if (lang === 'rs' || lang === 'yaml' || lang === 'py') return base;
      if (lang === 'sql') return base;
      return base;
    };

    const codeKeywords = (lang) => new Set(String(CODE_KEYWORDS[lang] || '').split(' ').filter(Boolean));

    const tokensOf = (tokens) => {
      const push = (text, cls) => {
        if (!text) return;
        const last = tokens[tokens.length - 1];
        if (last && last[1] === cls) last[0] += text;
        else tokens.push([text, cls]);
      };
      return push;
    };

    // One pass per line; only block comments carry state to the next line.
    const tokenizeCodeLine = (line, lang, state) => {
      const tokens = [];
      const push = tokensOf(tokens);
      const comment = CODE_COMMENT[lang] || '';
      const block = CODE_BLOCK[lang];
      const quotes = codeQuotes(lang);
      const keywords = codeKeywords(lang);
      let open = state && state.block ? state.block : '';
      let i = 0;
      while (i < line.length) {
        if (open) {
          const close = line.indexOf(open, i);
          if (close < 0) {
            push(line.slice(i), 'com');
            return { tokens, state: { block: open } };
          }
          push(line.slice(i, close + open.length), 'com');
          i = close + open.length;
          open = '';
          continue;
        }
        if (block && line.startsWith(block[0], i)) {
          open = block[1];
          i += block[0].length;
          continue;
        }
        if (comment && line.startsWith(comment, i)) {
          push(line.slice(i), 'com');
          return { tokens, state: { block: '' } };
        }
        const char = line[i];
        if (quotes.includes(char)) {
          let j = i + 1;
          while (j < line.length) {
            if (line[j] === '\\') {
              j += 2;
              continue;
            }
            if (line[j] === char) {
              j += 1;
              break;
            }
            j += 1;
          }
          push(line.slice(i, j), 'str');
          i = j;
          continue;
        }
        if (char >= '0' && char <= '9') {
          let j = i + 1;
          while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j])) j += 1;
          push(line.slice(i, j), 'num');
          i = j;
          continue;
        }
        if (/[A-Za-z_$@]/.test(char)) {
          let j = i + 1;
          while (j < line.length && /[A-Za-z0-9_$-]/.test(line[j])) j += 1;
          const word = line.slice(i, j);
          const lower = word.toLowerCase();
          const isCall = /^\s*\(/.test(line.slice(j));
          let cls = '';
          if (keywords.has(word) || keywords.has(lower)) cls = 'kw';
          else if (isCall) cls = 'fn';
          else if (CODE_TYPE_LANGS[lang] && /^[A-Z]/.test(word)) cls = 'type';
          push(word, cls);
          i = j;
          continue;
        }
        if ('{}()[];,.:=+-*/%<>!&|^~?'.includes(char)) {
          push(char, 'punc');
          i += 1;
          continue;
        }
        push(char, '');
        i += 1;
      }
      return { tokens, state: { block: open } };
    };

    // Markup gets its own pass: tags and attribute names are what make a page readable.
    const tokenizeHtmlLine = (line, state) => {
      const tokens = [];
      const push = tokensOf(tokens);
      let open = state && state.block ? state.block : '';
      let i = 0;
      while (i < line.length) {
        if (open) {
          const close = line.indexOf('-->', i);
          if (close < 0) {
            push(line.slice(i), 'com');
            return { tokens, state: { block: open } };
          }
          push(line.slice(i, close + 3), 'com');
          i = close + 3;
          open = '';
          continue;
        }
        if (line.startsWith('<!--', i)) {
          open = '-->';
          i += 4;
          continue;
        }
        const char = line[i];
        if (char === '<') {
          const close = line.indexOf('>', i);
          const end = close < 0 ? line.length : close + 1;
          const chunk = line.slice(i, end);
          const match = /^(<\/?)([A-Za-z0-9:-]+)/.exec(chunk);
          if (match) {
            push(match[1], 'punc');
            push(match[2], 'tag');
            let rest = chunk.slice(match[0].length);
            let at = 0;
            while (at < rest.length) {
              const attr = /^\s*([A-Za-z_:@][-A-Za-z0-9_:.]*)(=)("[^"]*"|'[^']*')?/.exec(rest.slice(at));
              if (!attr) break;
              push(attr[1], 'attr');
              push(attr[2], 'punc');
              if (attr[3]) push(attr[3], 'str');
              at += attr[0].length;
            }
            push(rest.slice(at), 'punc');
          } else {
            push(chunk, 'punc');
          }
          i = end;
          continue;
        }
        if (char === CODE_DOUBLE || char === CODE_SINGLE) {
          const close = line.indexOf(char, i + 1);
          const end = close < 0 ? line.length : close + 1;
          push(line.slice(i, end), 'str');
          i = end;
          continue;
        }
        let j = i;
        while (j < line.length && line[j] !== '<' && line[j] !== CODE_DOUBLE && line[j] !== CODE_SINGLE) j += 1;
        push(line.slice(i, j), '');
        i = j;
      }
      return { tokens, state: { block: open } };
    };

    // Lines beyond the budget stay plain: a huge log should not cost tokens it
    // never shows.
    const HIGHLIGHT_LINE_BUDGET = 4000;
    const buildCodeLines = (text, lang) => {
      if (!lang) return null;
      const lines = String(text || '').split('\n');
      const out = [];
      let state = { block: '' };
      for (let index = 0; index < lines.length; index += 1) {
        if (index >= HIGHLIGHT_LINE_BUDGET) {
          out.push([[lines[index], '']]);
          continue;
        }
        const result =
          lang === 'html' ? tokenizeHtmlLine(lines[index], state) : tokenizeCodeLine(lines[index], lang, state);
        state = result.state || { block: '' };
        out.push(result.tokens.length ? result.tokens : [['', '']]);
      }
      return out;
    };

    const parseTime = (text) => {
    // Lenient on purpose: "1:" means one minute, ":30" means half a minute.
    const raw = String(text === undefined || text === null ? '' : text).replace(/\s+/g, '');
    if (!raw) return NaN;
    const parts = raw.split(':');
    if (parts.length > 3) return NaN;
    let total = 0;
    for (const part of parts) {
      if (part === '') {
        total *= 60;
        continue;
      }
      if (!/^\d+(\.\d+)?$/.test(part)) return NaN;
      total = total * 60 + Number(part);
    }
    return total;
    };

    // "4% x 37%" says nothing about where; a coarse anchor plus the exact offset
    // does, and it stays short enough for the rail.
    const regionWhere = (rect) => {
      const values = (rect || []).map((value) => Number(value) || 0);
      const x = values[0];
      const y = values[1];
      const w = values[2];
      const h = values[3];
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      const column = centerX < 0.34 ? '左' : centerX > 0.66 ? '右' : '中';
      const row = centerY < 0.34 ? '上' : centerY > 0.66 ? '下' : '中';
      const anchor = row === '中' && column === '中' ? '中部' : row + column;
      return (
        anchor +
        ' · 距左 ' +
        Math.round(x * 100) +
        '%、距上 ' +
        Math.round(y * 100) +
        '% · ' +
        Math.round(w * 100) +
        '% × ' +
        Math.round(h * 100) +
        '%'
      );
    };

    const markWhere = (mark) =>
      mark.kind === 'text'
        ? mark.lines && mark.lines[0] === mark.lines[1]
          ? '第 ' + mark.lines[0] + ' 行'
          : '第 ' + mark.lines[0] + '-' + mark.lines[1] + ' 行'
        : mark.kind === 'paragraph'
          ? '第 ' + mark.paragraph + ' 段'
          : mark.kind === 'spot'
            ? mark.label || '选取'
            : mark.kind === 'element'
              ? '元素 `' + mark.selector + '`'
              : mark.kind === 'layer'
                ? '图层 `' + mark.selector + '`'
                : mark.kind === 'video'
? timeLabel(mark) + (Array.isArray(mark.rect) ? ' · 画面区域' : '')
  : mark.text && Array.isArray(mark.bands)
    ? '第 ' + (mark.page || 1) + ' 页 · 引用文字（' + mark.bands.length + ' 行）'
  : mark.norm && Array.isArray(mark.rect)
    ? '第 ' + (mark.page || 1) + ' 页 · ' + regionWhere(mark.rect)
    : '区域 (' + (mark.rect || []).join(', ') + ')';

    const markToBlock = (mark) => {
      const lines = [mark.n + '. `' + mark.path + '` — ' + markWhere(mark)];
      if (mark.quote) {
        for (const quoteLine of String(mark.quote).split('\n').slice(0, 6)) lines.push('   > ' + quoteLine);
      }
      // A 3D face needs more than an index: the index is only meaningful inside the
      // exact file version that produced it, while the corners and normal let the
      // reader locate the same face again.
      if (mark.kind === 'spot' && Array.isArray(mark.vertices) && mark.vertices.length === 3) {
        const point = (value) => '(' + value.map((item) => Number(item).toFixed(3)).join(', ') + ')';
        lines.push('   > 顶点 ' + mark.vertices.map(point).join(' '));
        const bits = [];
        if (Array.isArray(mark.normal)) bits.push('法线 ' + point(mark.normal));
        if (typeof mark.area === 'number') bits.push('面积 ' + mark.area.toFixed(3));
        if (mark.place) bits.push('位于模型 ' + mark.place);
        if (typeof mark.triangles === 'number') bits.push('该模型共 ' + Number(mark.triangles).toLocaleString() + ' 个三角面');
        if (bits.length) lines.push('   > ' + bits.join(' · '));
      }
      lines.push('   意见：' + (mark.note && mark.note.trim() ? mark.note.trim() : '（未填写，请按引用判断）'));
      return lines.join('\n');
    };

    const buildMarkdown = () => {
      const marks = store.marks.filter((mark) => !mark.done).sort((a, b) => a.n - b.n);
      if (!marks.length) return '';
      const lines = ['以下是我在画布面板中的标注（共 ' + marks.length + ' 条），请按编号逐条处理：', ''];
      // Group by file: a review that touches three files reads far better when the
      // marks arrive under the file they belong to.
      let currentFile = '';
      for (const mark of marks) {
        if (mark.path !== currentFile) {
          currentFile = mark.path;
          lines.push('### `' + currentFile + '`');
          lines.push('');
        }
        lines.push(markToBlock(mark));
        lines.push('');
      }
      return lines.join('\n').slice(0, 12000);
    };

    // Insert arbitrary text into the composer, sharing one path with sendMarks.
    const insertIntoComposer = (text) => {
      const actions = store.actions;
      if (actions && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
        try {
          const captured = actions.captureInsertion();
          const span = captured && captured.span !== undefined ? captured.span : captured;
          actions.insertText(text, span);
          return 'ok';
        } catch (error) {
          devlog('insert-failed', [errText(error)]);
        }
      }
      if (actions && typeof actions.setDraft === 'function') {
        try {
          actions.setDraft(text);
          return 'ok';
        } catch (error) {
          devlog('insert-draft-failed', [errText(error)]);
        }
      }
      return 'failed';
    };

    // One mark straight to the composer, for the ⟶ button on a rail row.
    const sendOneMark = (mark) => {
      const result = insertIntoComposer(markToBlock(mark) + '\n');
      if (result !== 'ok') {
        copyMark(mark);
        return result;
      }
      // Auto-clear means "sent marks leave the rail"; for a single send that is
      // this one mark, never the whole list.
      if (sendPrefs.autoClear) {
        mutate({ marks: store.marks.filter((item) => item.id !== mark.id) });
        persist();
      }
      return result;
    };

    // Marks live in localStorage, so a review is otherwise tied to this install.
    // Exporting writes a small JSON document that can be versioned or handed over.
    const exportMarks = () => {
      if (!store.marks.length) return '空标注';
      const payload = {
        kind: 'dsh-canvas-marks',
        version: 1,
        exportedAt: new Date().toISOString(),
        marks: store.marks,
      };
      const text = JSON.stringify(payload, null, 2);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
      try {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'canvas-marks-' + stamp + '.json';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'ok';
      } catch {
        return 'failed';
      }
    };

    // Import merges by locator: an identical spot keeps its existing number, a new
    // one continues the sequence, and notes from the file win when the row exists.
    const importMarks = async (file) => {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, reason: '不是有效的 JSON' };
      }
      const incoming = Array.isArray(payload) ? payload : payload && Array.isArray(payload.marks) ? payload.marks : null;
      if (!incoming) return { ok: false, reason: '文件里没有 marks 数组' };
      let added = 0;
      let updated = 0;
      for (const raw of incoming) {
        if (!raw || !raw.path) continue;
        const candidate = Object.assign({}, raw, { path: normalizePath(raw.path) });
        delete candidate.n;
        const existing = store.marks.find((mark) => sameLocator(mark, candidate));
        if (existing) {
          if (candidate.note && candidate.note !== existing.note) {
            setMarkNote(existing.id, candidate.note);
            updated += 1;
          }
          continue;
        }
        addMark(candidate);
        added += 1;
      }
      return { ok: true, added, updated };
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
      // ---- control tokens ----
      // brand-primary is ink (black in light, white in dark), so it is used for text
      // and hairlines rather than as a fill; a tint carries the primary weight.
      ':root{--dshcv-ink:var(--dsw-alias-label-primary);--dshcv-guide:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);--dshcv-ink-2:var(--dsw-alias-label-secondary);--dshcv-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--dshcv-line-strong:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);--dshcv-tint:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);--dshcv-wash:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);--dshcv-off-mid:#e9a6ab;--dshcv-off-edge:#d88b92;--dshcv-on-mid:#8ec9a3;--dshcv-on-edge:#cdead8}',
      // ---- actions ----
      '.dshcv-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dshcv-line);border-radius:8px;background:transparent;color:var(--dshcv-ink);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;transition:background-color .12s ease,color .12s ease,border-color .12s ease,box-shadow .16s ease}',
      '.dshcv-btn:hover{background:var(--dshcv-wash);border-color:var(--dshcv-line-strong)}',
      '.dshcv-btn:active{background:var(--dshcv-tint)}',
      '.dshcv-btn:focus-visible{outline:2px solid var(--dshcv-ink);outline-offset:1px}',
      '.dshcv-btn[data-kind="quiet"]{border-color:transparent;color:var(--dshcv-ink-2);height:26px;padding:0 7px}',
      '.dshcv-btn[data-kind="quiet"]:hover{background:var(--dshcv-wash);color:var(--dshcv-ink)}',
      '.dshcv-btn[data-kind="quiet"][data-danger="1"]:hover{color:var(--dshcv-off-edge);background:color-mix(in srgb,var(--dshcv-off-edge) 12%,transparent)}',
      // Primary: light tinted fill with two counter-moving wave bands, so the fill
      // itself reads as motion without the label ever drifting.
// Primary button: pale blue fill, two coloured ring layers, seamless looping.
      '.dshcv-btn[data-kind="primary"]{background-color:rgba(79,140,255,.12)!important;border:1px solid rgba(79,140,255,.45)!important;color:var(--dsw-alias-label-primary);font-weight:600!important;height:30px!important;padding:0 14px!important;isolation:isolate;backdrop-filter:blur(6px) saturate(1.15);-webkit-backdrop-filter:blur(6px) saturate(1.15);box-shadow:0 0 12px rgba(79,140,255,.22),inset 0 1px 0 rgba(255,255,255,.30)}',
      '.dshcv-btn[data-kind="primary"]::before,.dshcv-btn[data-kind="primary"]::after{content:"";position:absolute;inset:-10px;z-index:-1;pointer-events:none;background-repeat:repeat;background-position:0 0}',
      '.dshcv-btn[data-kind="primary"]::before{background-image:repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,.55) 0 4px,transparent 4px 12px,rgba(150,200,255,.50) 12px 16px,transparent 16px 24px);filter:blur(3px);opacity:.80;animation:dshcv-drift-a 12s linear infinite}',
      '.dshcv-btn[data-kind="primary"]::after{background-image:repeating-radial-gradient(circle at 50% 50%,rgba(255,170,205,.45) 0 5px,transparent 5px 15px,rgba(255,255,255,.38) 15px 20px,transparent 20px 30px);filter:blur(4px);opacity:.62;animation:dshcv-drift-b 15s linear infinite}',
      // 位移取 240px：24px 与 30px 周期的公倍数，循环首尾图案完全重合，不会跳。
      '@keyframes dshcv-drift-a{from{background-position:0 0}to{background-position:-240px -240px}}',
      '@keyframes dshcv-drift-b{from{background-position:0 0}to{background-position:240px 240px}}',
      '@media (prefers-reduced-motion: reduce){.dshcv-btn[data-kind="primary"]::before,.dshcv-btn[data-kind="primary"]::after{animation:none}}',
      '.dshcv-btn[data-kind="primary"]:hover{filter:saturate(1.15) brightness(1.02)}',
      // Two axes at once: concentric rings whose centre travels diagonally, one way
      // outwards and the other inwards, so the fill reads as a surface ripple.
      // ---- toggles ----
      // Radial shading, not an outline: red runs medium in the middle to deep at the
      // rim, green runs medium to pale, and on is rounder so the state shows in the
      // silhouette as well as the hue.
      '.dshcv-toggle{display:inline-flex;align-items:center;gap:0;height:26px;padding:0 11px;border:0;border-radius:8px;background:radial-gradient(68% 96% at 50% 42%,color-mix(in srgb,var(--dshcv-off-mid) 50%,transparent) 0%,color-mix(in srgb,var(--dshcv-off-mid) 50%,transparent) 16%,color-mix(in srgb,var(--dshcv-off-edge) 50%,transparent) 94%);color:color-mix(in srgb,var(--dshcv-ink) 88%,transparent);font:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;box-shadow:0 1px 2px color-mix(in srgb,var(--dshcv-off-edge) 38%,transparent);transition:all .16s ease}',
      '.dshcv-toggle:hover{filter:brightness(1.04) saturate(1.08)}',
      '.dshcv-toggle[aria-pressed="true"]{border:0;border-radius:14px;background:radial-gradient(68% 96% at 50% 42%,color-mix(in srgb,var(--dshcv-on-mid) 50%,transparent) 0%,color-mix(in srgb,var(--dshcv-on-mid) 50%,transparent) 16%,color-mix(in srgb,var(--dshcv-on-edge) 50%,transparent) 94%);color:color-mix(in srgb,var(--dshcv-ink) 88%,transparent);box-shadow:0 1px 2px color-mix(in srgb,var(--dshcv-on-edge) 35%,transparent),0 0 9px color-mix(in srgb,var(--dshcv-on-edge) 30%,transparent)}',
      '.dshcv-toggle:focus-visible{outline:2px solid var(--dshcv-ink);outline-offset:1px}',
      '.dshcv-toggle[disabled]{opacity:.5;cursor:default}',
      // ---- segmented (exclusive modes) ----
      '.dshcv-seg{display:inline-flex;border:1px solid var(--dshcv-line);border-radius:8px;overflow:hidden}',
      '.dshcv-seg .dshcv-btn{border:0;border-radius:0;height:26px;padding:0 10px;color:var(--dshcv-ink-2)}',
      '.dshcv-seg .dshcv-btn+.dshcv-btn{border-left:1px solid var(--dshcv-line)}',
      '.dshcv-seg .dshcv-btn[aria-pressed="true"]{background:var(--dshcv-tint);color:var(--dshcv-ink);font-weight:600}',
      '.dshcv-btn[data-icon="1"]{width:26px;padding:0}',
      '.dshcv-btn[disabled]{opacity:.45;cursor:default}',
      '.dshcv-btn[disabled]:hover{background:transparent;border-color:var(--dshcv-line);color:var(--dshcv-ink-2)}',
      '.dshcv-chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}',
      '.dshcv-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshcv-chip[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshcv-layers{display:inline-flex;gap:4px;flex-wrap:wrap;align-items:center;max-width:100%}',
      '.dshcv-chip[data-on="0"]{opacity:.45;text-decoration:line-through}',
      '.dshcv-help{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;min-width:300px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 18px;box-shadow:0 18px 48px rgba(0,0,0,.3);font-size:12px;line-height:2}',
      '.dshcv-help kbd{display:inline-block;min-width:52px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font:inherit;text-align:center;margin-right:8px}',
      '.dshcv-search{display:inline-flex;align-items:center;gap:6px}',
      '.dshcv-searchinput{height:24px;width:140px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
      '.dshcv-searchinput:focus{border-color:var(--dsw-alias-brand-primary)}',
    // Code colours stay readable on both themes: semantic hues are fixed, and a
    // token without a class keeps the surrounding text colour.
    '.dshcv-code{font-variant-ligatures:none}',
    '.dshcv-tok-kw{color:#a626a4;font-weight:600}',
    '.dshcv-tok-str{color:#50a14f}',
    '.dshcv-tok-num{color:#b76b01}',
    '.dshcv-tok-com{color:#8b949e;font-style:italic}',
    '.dshcv-tok-fn{color:#3a7bd5}',
    '.dshcv-tok-type{color:#c18401}',
    '.dshcv-tok-tag{color:#e45649}',
    '.dshcv-tok-attr{color:#986801}',
    '.dshcv-tok-punc{color:#7a8290}',
    '@media (prefers-color-scheme:dark){',
  '.dshcv-tok-kw{color:#c678dd}',
  '.dshcv-tok-str{color:#98c379}',
  '.dshcv-tok-num{color:#d19a66}',
  '.dshcv-tok-com{color:#7d8590}',
  '.dshcv-tok-fn{color:#61afef}',
  '.dshcv-tok-type{color:#e5c07b}',
  '.dshcv-tok-tag{color:#e06c75}',
  '.dshcv-tok-attr{color:#d19a66}',
  '.dshcv-tok-punc{color:#8b949e}',
    '}',
    // Indent guides: one faint rule every two spaces of leading whitespace, which
    // is what makes block structure visible at a glance.
    '.dshcv-code{background-image:repeating-linear-gradient(to right,transparent 0,transparent calc(2ch - 1px),var(--dshcv-guide) calc(2ch - 1px),var(--dshcv-guide) 2ch);background-repeat:no-repeat;background-size:100% 100%}',
      '.dshcv-linehit{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.dshcv-linehitcur{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}',
      '.dshcv-hit{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);color:inherit;border-radius:3px;padding:0 1px}',
      '::highlight(dshcv-hover){background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent);color:inherit}',
      '.dshcv-mdtable{border-collapse:collapse;margin:10px 0;font-size:12px}',
      '.dshcv-mdtable th,.dshcv-mdtable td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px;text-align:left}',
      '.dshcv-mdtable th{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.dshcv-task{list-style:none;margin-left:-14px}',
      '.dshcv-check{margin-right:6px;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-imgchip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:5px;border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dshcv-diff{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-difhead{display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-diffbody{overflow:auto;flex:1 1 auto;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 0}',
      '.dshcv-difrow{display:flex;gap:8px;padding:0 12px;white-space:pre}',
      '.dshcv-difnum{flex:0 0 34px;text-align:right;color:var(--dsw-alias-label-secondary);user-select:none}',
      '.dshcv-difsign{flex:0 0 10px;user-select:none}',
      '.dshcv-diftext{flex:1 1 auto;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dshcv-dif-add{background:color-mix(in srgb,#2ea043 18%,transparent)}',
      '.dshcv-dif-del{background:color-mix(in srgb,#d1242f 18%,transparent)}',
      '.dshcv-dif-gap{color:var(--dsw-alias-label-secondary);opacity:.7}',
      '.dshcv-md del{opacity:.65}',
      '.dshcv-badge{flex:0 0 auto;min-width:18px;height:18px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 5px;font-variant-numeric:tabular-nums}',
      '.dshcv-note{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;padding:5px 8px;border-radius:7px;border:1px solid transparent;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical;transition:border-color .12s ease}',
      '.dshcv-note:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dshcv-note:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcv-card{display:flex;align-items:center;gap:10px;padding:8px 10px;margin:6px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshcv-pick{position:fixed;z-index:60;transform:translate(-50%,-100%);box-shadow:0 8px 24px rgba(0,0,0,.2)}',
      '.dshcv-toast-2{bottom:52px}', 
      '.dshcv-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;pointer-events:none;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.16);animation:dshcv-toast-in .16s ease-out both}',
      '@keyframes dshcv-toast-in{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}',
      '@media (prefers-reduced-motion: reduce){.dshcv-btn,.dshcv-chip,.dshcv-note{transition:none}}',
    ].join('\n');

    const CSS_PANEL = [
      '.dshcv-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshcv-head{display:flex;align-items:center;gap:6px;padding:0 8px 0 12px;min-height:40px;position:relative;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-headmenu{position:absolute;top:calc(100% - 4px);right:8px;z-index:40;min-width:190px;padding:5px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 30px rgba(15,17,21,.14);display:flex;flex-direction:column;gap:1px}',
      '.dshcv-menuitem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:none;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer}',
      '.dshcv-menuitem:hover,.dshcv-menuitem:focus-visible{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);outline:none}',
      '.dshcv-menukey{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshcv-menurule{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}',
      '.dshcv-title{font-size:13px;font-weight:600;letter-spacing:-0.01em;white-space:nowrap}',
      '.dshcv-path{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dshcv-spacer{flex:1 1 auto;min-width:8px}',
      '.dshcv-body{display:flex;flex:1 1 0;min-height:0;overflow:hidden}',
      '.dshcv-slots{display:flex;flex:1 1 0;min-height:0;min-width:0;overflow:hidden}',
      '.dshcv-video{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;position:relative}',
      '.dshcv-videostage{flex:1 1 auto;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;background:#0b0c0e;border-radius:10px;overflow:hidden;touch-action:none}',
      '.dshcv-videostage video{max-width:100%;max-height:100%;display:block;cursor:pointer}',
      '.dshcv-videostage[data-boxing="1"]{cursor:crosshair}',
      '.dshcv-marquee{position:absolute;border:1px solid rgba(79,140,255,.9);background:rgba(79,140,255,.18);pointer-events:none}',
      '.dshcv-regionbox{position:absolute;border:1.5px solid rgba(79,140,255,.95);background:rgba(79,140,255,.12);border-radius:2px;pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,.18)}',
      '.dshcv-videobar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshcv-videotime{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dshcv-track{position:relative;height:22px;border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);cursor:pointer;touch-action:none;overflow:hidden}',
      '.dshcv-trackfill{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
      '.dshcv-trackhead{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:var(--dsw-alias-brand-primary)}',
      '.dshcv-markband{position:absolute;top:-1px;bottom:-1px;background:rgba(79,140,255,.22);box-shadow:0 0 10px rgba(79,140,255,.55),inset 0 0 6px rgba(79,140,255,.35);pointer-events:none;border-radius:3px}',
      '.dshcv-markhead{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:rgba(79,140,255,.95);box-shadow:0 0 8px rgba(79,140,255,.85);pointer-events:none}',
    // The text is transparent and sits exactly over the bitmap: selecting it looks
    // like selecting the page, and ::selection paints the highlight.
    '.dshcv-pdftext{position:absolute;inset:0;overflow:hidden;line-height:1;pointer-events:auto;user-select:text}',
    '.dshcv-pdftext span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}',
    '.dshcv-pdftext span::selection{background:rgba(79,140,255,.34);color:transparent}',
    '.dshcv-pdftext span::-moz-selection{background:rgba(79,140,255,.34);color:transparent}',
    '.dshcv-pdfmain{display:flex;gap:10px;min-height:0;flex:1 1 auto}',
    '.dshcv-pdfthumbs{flex:0 0 116px;min-height:0;overflow:auto;padding:4px;border-right:1px solid var(--dshcv-line)}',
    '.dshcv-pdfthumb{display:block;width:100%;margin:0 0 8px;padding:3px;border:0;background:transparent;cursor:pointer;border-radius:6px}',
    '.dshcv-pdfthumb canvas{display:block;width:100%;height:auto;background:#fff;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.18)}',
    '.dshcv-pdfthumb-on canvas{box-shadow:0 0 0 2px rgba(79,140,255,.95),0 2px 8px rgba(0,0,0,.2)}',
    '.dshcv-pdfthumbnum{display:block;font-size:10px;color:var(--dshcv-ink-2);margin-top:2px}',
    '.dshcv-pdfpages{flex:1 1 auto;min-height:0;overflow:auto;display:flex;justify-content:center;padding:12px 0 24px}',
    '.dshcv-pdfcolumn{display:flex;flex-direction:column;align-items:center;gap:14px;width:100%}',
    '.dshcv-pdfhit{position:absolute;background:rgba(255,196,0,.34);border-radius:2px;pointer-events:none}',
    '.dshcv-pdfhit[data-active="1"]{background:rgba(255,138,0,.55);box-shadow:0 0 0 1px rgba(255,138,0,.85)}',
    '.dshcv-pdfregion-hot{background:rgba(79,140,255,.22)!important;box-shadow:0 0 12px rgba(79,140,255,.65)!important;border-style:solid!important}',
    '.dshcv-pdfcanvasbox{position:relative;align-self:center;margin:0 auto;line-height:0}',
    '.dshcv-pdfcanvas{display:block;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.16)}',
    '.dshcv-scroll{overflow:auto}',
    '.dshcv-pdfpage{position:absolute;overflow:hidden}',
    '.dshcv-pdflayer{position:absolute;inset:0;cursor:crosshair;touch-action:none}',
    '.dshcv-pdflayer:not(.dshcv-pdflayer-on){cursor:default}',
    '.dshcv-pdfmarquee{position:absolute;border:1.5px solid rgba(79,140,255,.95);background:rgba(79,140,255,.16);box-shadow:0 0 10px rgba(79,140,255,.45);pointer-events:none;border-radius:2px}',
    // A text mark is a set of line bands that sit exactly on the glyphs: no outline,
    // so it reads as highlighted text rather than a selected box.
    '.dshcv-pdftexthit{position:absolute;background:rgba(79,140,255,.30);border-radius:2px;pointer-events:none}',
    '.dshcv-pdftexthit-hot{background:rgba(79,140,255,.46);box-shadow:0 0 8px rgba(79,140,255,.55)}',
    '.dshcv-pdfregion{position:absolute;border:1.5px dashed rgba(79,140,255,.9);background:rgba(79,140,255,.10);box-shadow:0 0 12px rgba(79,140,255,.5);pointer-events:none;border-radius:2px}',
      '.dshcv-hoverhead{position:absolute;top:-2px;bottom:-2px;width:0;margin-left:-0.5px;border-left:1px dashed rgba(79,140,255,.85);pointer-events:none}',
      '.dshcv-trackband{position:absolute;top:0;bottom:0;background:rgba(79,140,255,.35);border-left:1px solid rgba(79,140,255,.8);border-right:1px solid rgba(79,140,255,.8)}',
      '.dshcv-tracktip{position:absolute;bottom:calc(100% + 6px);transform:translateX(-50%);background:#0f1115;color:#fff;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 7px;border-radius:6px;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}',
      '.dshcv-timeinput{width:92px;height:24px;padding:0 7px;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;text-align:center}',
      '.dshcv-timeinput:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
      '.dshcv-track{overflow:visible}',
      '.dshcv-videohint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dshcv-track[data-zoomed="1"]{height:34px}',
      '.dshcv-track[data-frame="1"]{height:42px}',
      '.dshcv-tick{position:absolute;top:0;bottom:0;width:1px;background:color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);pointer-events:none}',
      '.dshcv-tickmajor{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent)}',
      '.dshcv-inmark,.dshcv-outmark{position:absolute;top:-3px;bottom:-3px;width:2px;pointer-events:none;background:rgba(79,140,255,.95)}',
      '.dshcv-inmark::after,.dshcv-outmark::after{content:"";position:absolute;top:0;width:6px;height:6px;background:rgba(79,140,255,.95)}',
      '.dshcv-inmark::after{left:0}',
      '.dshcv-outmark::after{right:0}',
      '.dshcv-inoutband{position:absolute;top:0;bottom:0;background:rgba(79,140,255,.20);pointer-events:none}',
      '.dshcv-videomenu{position:absolute;z-index:60;min-width:200px;padding:5px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 34px rgba(15,17,21,.18);display:flex;flex-direction:column;gap:1px}',
      '.dshcv-videomenu .dshcv-menuitem[disabled]{opacity:.45;cursor:default}',
      '.dshcv-videomenu .dshcv-menuitem[disabled]:hover{background:none}',
      '.dshcv-timecode{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}',
      '.dshcv-timecode:hover{color:var(--dsw-alias-brand-primary)}',
      '.dshcv-slots[data-dir="column"]{flex-direction:column}',
      '.dshcv-slot{display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0;overflow:hidden;position:relative}',
      '.dshcv-slots[data-split="1"] .dshcv-slot{box-shadow:inset 0 0 0 1px transparent;transition:box-shadow .18s ease,opacity .18s ease}',
      '.dshcv-slots[data-split="1"] .dshcv-slot[data-active="1"]{box-shadow:inset 0 0 0 1px rgba(79,140,255,.42)}',
      '.dshcv-slots[data-split="1"] .dshcv-slot[data-active="0"]{opacity:.9}',
      '.dshcv-divider{flex:0 0 9px;position:relative;cursor:col-resize;touch-action:none;background:transparent}',
      '.dshcv-slots[data-dir="column"] .dshcv-divider{cursor:row-resize}',
      '.dshcv-divider::after{content:"";position:absolute;inset:0;margin:auto;width:1px;height:100%;background:var(--dsw-alias-border-l1);border-radius:2px;transition:background .15s ease,width .15s ease}',
      '.dshcv-slots[data-dir="column"] .dshcv-divider::after{width:100%;height:1px}',
      '.dshcv-divider:hover::after,.dshcv-divider:focus-visible::after{width:3px;background:rgba(79,140,255,.5)}',
      '.dshcv-slots[data-dir="column"] .dshcv-divider:hover::after{width:100%;height:3px}',
      '.dshcv-chip[data-second="1"]{box-shadow:inset 0 0 0 1px rgba(79,140,255,.5)}',
      '.dshcv-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;container-type:inline-size}',
'.dshcv-tools{flex-wrap:wrap;row-gap:2px}',
'.dshcv-head{flex-wrap:wrap;row-gap:2px}',
'.dshcv-more{display:none}',
      '@container (max-width: 720px){ :is(.dshcv-tools,.dshcv-head):not(.dshcv-expanded) .dshcv-opt{display:none} .dshcv-more{display:inline-flex} }',
      '@container (max-width: 620px){ :is(.dshcv-tools,.dshcv-head):not(.dshcv-expanded) .dshcv-opt2{display:none} }',
      // The conversation must see a definite, clipped box: an auto-height flex
      // parent let it grow past the pane, so its transcript kept believing it
      // had more room and the last messages ended up under the composer.
      '.dshcv-conv{position:relative;flex:1 1 0;min-width:0;min-height:0;overflow:hidden}',
      '.dshcv-convfill{position:absolute;inset:0;overflow:hidden}',
      '.dshcv-convfill>*{height:100%;min-height:0}',
      '.dshcv-split{flex:0 0 9px;cursor:col-resize;position:relative;background:transparent}',
      '.dshcv-split::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:var(--dsw-alias-border-l1);transition:background-color .12s ease}',
      '.dshcv-split:hover::after{background:var(--dsw-alias-brand-primary)}',
      '.dshcv-hsplit{flex:0 0 7px;cursor:row-resize;position:relative;background:transparent;z-index:2}',
      '.dshcv-hsplit::after{content:"";position:absolute;left:12px;right:12px;top:3px;height:1px;background:var(--dsw-alias-border-l1);transition:background-color .12s ease}',
      '.dshcv-hsplit:hover::after{background:var(--dsw-alias-brand-primary);height:2px;top:2px}',
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
      '.dshcv-editor{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:10px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}',
      '.dshcv-docwrap{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px 24px}',
      '.dshcv-doc{font-size:13px;line-height:1.75;max-width:760px}',
      '.dshcv-doc p{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshcv-docp{cursor:pointer;border-radius:4px;padding:2px 4px;margin-left:-4px}',
      '.dshcv-docp:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.dshcv-docblank{height:6px;margin:0}',
      '.dshcv-tablewrap{margin:10px 0 18px}',
      '.dshcv-tcaption{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 6px}',
      '.dshcv-table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}',
      '.dshcv-table th,.dshcv-table td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px;text-align:left;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}',
      '.dshcv-slide{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 14px;margin:0 0 12px;max-width:760px}',
      '.dshcv-slidehead{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 6px}',
      '.dshcv-slide p{margin:0 0 4px;font-size:13px}',
      '.dshcv-canvas3d{flex:1 1 auto;min-height:0;width:100%;height:100%;display:block;background:var(--dsw-alias-bg-layer-1);cursor:grab;touch-action:none}',
      // The 3D canvas must stretch, unlike the image wrapper it used to share.
      '.dshcv-3dwrap{flex:1 1 auto;min-height:0;display:flex;align-items:stretch;padding:0;overflow:hidden}',
      '.dshcv-canvas3d:active{cursor:grabbing}',
      '.dshcv-cadwrap{flex:1 1 auto;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.dshcv-cadwrap svg{width:100%;height:100%;display:block}',
      '.dshcv-cadwrap svg line,.dshcv-cadwrap svg polyline,.dshcv-cadwrap svg polygon,.dshcv-cadwrap svg circle,.dshcv-cadwrap svg path{fill:none;stroke:var(--dsw-alias-label-primary);stroke-width:.6;vector-effect:non-scaling-stroke}',
      '.dshcv-cadwrap svg polygon{fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.dshcv-cadwrap svg text{fill:var(--dsw-alias-label-secondary);stroke:none}',
      '.dshcv-canvaswrap{flex:1 1 auto;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshcv-bitmap{max-width:100%;height:auto;image-rendering:auto;box-shadow:0 6px 24px rgba(0,0,0,.22);border:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-outline{margin:8px 0 0;padding:0;list-style:none;font-size:12px}',
      '.dshcv-outline li{padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:baseline}',
      '.dshcv-outline .dshcv-tcaption{margin:0;flex:0 0 auto;min-width:70px}',
      '.dshcv-md{font-size:13px;line-height:1.7;padding:12px 16px;overflow-wrap:anywhere}',
      // Empty state: one primary action, three numbered steps, then facts.
      '.dshcv-guide{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:26px 24px}',
      '.dshcv-guidehead{display:flex;flex-direction:column;gap:6px}',
      '.dshcv-guidetitle{font-size:15px;font-weight:600;letter-spacing:-.2px}',
      '.dshcv-guidesub{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);max-width:52ch}',
      '.dshcv-guideactions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dshcv-guidehint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;max-width:62ch}',
      '.dshcv-steps li{position:relative;padding:9px 12px 9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary)}',
      '.dshcv-steps b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dshcv-guidefoot{display:flex;gap:10px;align-items:flex-start;font-size:11px;max-width:62ch}',
      '.dshcv-guidesec{flex:0 0 auto;color:var(--dsw-alias-label-secondary);padding-top:2px}',
      '.dshcv-tags{display:flex;flex-wrap:wrap;gap:4px}',
      '.dshcv-tag{padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}',
      // Rail hover -> viewer spotlight.
      '.dshcv-spot{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);outline:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);border-radius:3px}',
      '.dshcv-dim{opacity:.4;transition:opacity .14s ease}',
      '.dshcv-cadhit{stroke:var(--dsw-alias-brand-primary) !important;stroke-width:3 !important;vector-effect:non-scaling-stroke}',
      '.dshcv-line.dshcv-spot{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);outline:none}',
      '.dshcv-docp.dshcv-spot,.dshcv-slide.dshcv-spot{box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}',
      '.dshcv-table td.dshcv-spot,.dshcv-table th.dshcv-spot{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);outline:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent)}',
      '.dshcv-mark-done{opacity:.55}',
      '.dshcv-badge-done{background:color-mix(in srgb,#2ea043 22%,transparent);color:color-mix(in srgb,#2ea043 82%,var(--dsw-alias-label-primary))}',
      '.dshcv-mpath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:-.01em;white-space:nowrap}',
      '.dshcv-railgroup{display:flex;align-items:center;gap:4px;min-width:0}',
      '.dshcv-railgroup>.dshcv-mpath{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshcv-markrow-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-radius:6px}',
      '.dshcv-template-menu{position:absolute;z-index:20;top:26px;left:0;width:260px;max-height:220px;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.24);padding:4px;display:flex;flex-direction:column;gap:4px}',
      '.dshcv-template-list{display:flex;flex-direction:column;gap:2px}',
      '.dshcv-template-save{justify-content:flex-start;text-align:left;height:32px;padding:0 10px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);border-radius:7px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);font-size:12px;line-height:1.4}',
      '.dshcv-template-rule{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}',
      '.dshcv-template-row{display:flex;align-items:center;gap:4px}',
      '.dshcv-template-tag{flex:0 0 auto;font-size:9px;line-height:14px;padding:0 3px;border-radius:3px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-template-pick{flex:1 1 auto;justify-content:flex-start;text-align:left;height:26px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcv-template-remove{flex:0 0 auto;width:20px;padding:0}',
      '.dshcv-stale{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-warning,#c28b00);align-self:flex-start}',
      '.dshcv-railhead{display:flex;gap:6px;align-items:center;padding:4px 0 6px;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}',
      '.dshcv-railgroup{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:6px 0 2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:2px}',
      '.dshcv-conflict{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 12px;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-warning,#c28b00) 14%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1)}',
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
      '.dshcv-code{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--dshcv-text-size,12px);padding:6px 0}',
      '.dshcv-line{display:flex;gap:10px;padding:0 12px;white-space:pre}',
      '.dshcv-line:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshcv-num{color:var(--dsw-alias-label-secondary);user-select:none;text-align:right;min-width:42px;flex:0 0 auto;opacity:.75}',
      '.dshcv-text{white-space:pre}',
      '.dshcv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}',
      '.dshcv-marks{flex:0 0 auto;max-height:38%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:4px 12px 8px}',
      '.dshcv-mark{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcv-mark:last-child{border-bottom:0}',
      '.dshcv-markbody{flex:1 1 auto;min-width:0}',
      '.dshcv-meta{font-size:11px;color:var(--dsw-alias-label-primary);opacity:.8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
          if (Array.isArray(store.pendingList) && store.pendingList.length) {
            const queue = store.pendingList;
            store.pendingList = undefined;
            openDocs(queue);
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
      const listed = args && Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === 'string' && item.trim()) : [];
      // A single call may name several deliverables; the card opens all of them.
      const targets = listed.length ? listed : path ? [path] : [];

      React.useEffect(() => {
        if (props.phase === 'preparing') return;
        const key = String(props.callId || '') + '|' + targets.join('|');
        if (opened.current === key) return;
        opened.current = key;
        // Open the panel once per call. Without this, switching back to the
        // conversation remounts this card, whose effect would immediately
        // select the canvas again and the panel could never be closed.
        if (autoOpened.has(key)) return;
        autoOpened.add(key);
        selectPanel(PANEL_KEY);
        if (targets.length) {
          openDocs(
            targets.map((item, index) => ({
              path: item,
              view: args && args.view,
              // The note and the focus line belong to the deliverable named first.
              note: index === 0 ? args && args.note : undefined,
              line: index === 0 ? args && args.line : undefined,
            })),
          );
        }
      }, [props.phase, props.callId, targets.join('|')]);

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

    // A panel shortcut may only fire when the panel itself owns the keyboard:
    // the pointer is over it with nothing else focused, or focus is inside it.
    // Anything typed into the composer, an input, or a contenteditable is left
    // strictly alone.
    const ownsKeyboard = (event, root) => {
      if (!root) return false;
      if (event.isComposing || event.keyCode === 229) return false;
      // Typing wins over hovering. The pointer habitually rests over the panel, and
      // the hover shortcut used to swallow arrows inside inputs (the caret could not
      // be moved) — so the editable check runs first.
      const target = event.target;
      if (target && target.isContentEditable) return false;
      if (target && typeof target.closest === 'function') {
        if (target.closest('input,textarea,select,[contenteditable="true"]')) return false;
      }
      // Otherwise the pointer resting over the panel means a shortcut is meant for it.
      if (typeof root.matches === 'function' && root.matches(':hover')) return true;
      const active = document.activeElement;
      return Boolean(active && root.contains(active));
    };

    // ---------------- markdown ----------------
    // Small renderer: no dependency, and it builds React nodes instead of
    // injecting HTML, so a document can never execute markup.
    const inlineMd = (text) => {
      const nodes = [];
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\((?:https?:|mailto:|#)[^\s)]+\))/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = 'i' + match.index;
        if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)));
        else if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('~~')) nodes.push(h('del', { key }, token.slice(2, -2)));
        else if (token.startsWith('![')) {
          // A preview document has no base URL for relative assets, so an image is
          // shown as a labelled chip instead of a broken <img>.
          const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
          nodes.push(
            h(
              'span',
              { key, className: 'dshcv-imgchip', title: image ? image[2] : '' },
              (image && image[1] ? image[1] : '图片') + ' · ' + (image ? image[2] : ''),
            ),
          );
        } else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    };

    const parseMarkdown = (text) => {
      const source = String(text || '').split('\n');
      const blocks = [];
      let paragraph = [];
      let paragraphLine = 0;
      let list = null;
      let fence = null;
      // Every block remembers the source line it came from, so a selection in the
      // rendered view can still be numbered as line ranges.
      const push = (element, line) => blocks.push(React.cloneElement(element, { 'data-line': line }));
      const flushParagraph = () => {
        if (!paragraph.length) return;
        push(h('p', { key: 'p' + blocks.length }, inlineMd(paragraph.join(' '))), paragraphLine);
        paragraph = [];
      };
      const flushList = () => {
        if (!list) return;
        push(
          h(
            list.ordered ? 'ol' : 'ul',
            { key: 'l' + blocks.length },
            list.items.map((item, index) =>
              h(
                'li',
                {
                  key: index,
                  'data-line': item.line,
                  className: list.task ? 'dshcv-task' : undefined,
                },
                list.task ? h('span', { className: 'dshcv-check' }, item.checked ? '☑' : '☐') : null,
                inlineMd(item.text),
              ),
            ),
          ),
          list.line,
        );
        list = null;
      };
      const flushAll = () => {
        flushParagraph();
        flushList();
      };

      for (let index = 0; index < source.length; index += 1) {
        const line = source[index];
        const lineNo = index + 1;
        if (fence) {
          if (/^```/.test(line)) {
            push(h('pre', { key: 'c' + blocks.length }, h('code', null, fence.lines.join('\n'))), fence.line);
            fence = null;
          } else {
            fence.lines.push(line);
          }
          continue;
        }
        const fenceStart = /^```(\w*)/.exec(line);
        if (fenceStart) {
          flushAll();
          fence = { lines: [], line: lineNo };
          continue;
        }
        if (!line.trim()) {
          flushAll();
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushAll();
          push(h('h' + heading[1].length, { key: 'h' + blocks.length }, inlineMd(heading[2])), lineNo);
          continue;
        }
        if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flushAll();
          push(h('hr', { key: 'r' + blocks.length }), lineNo);
          continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          flushAll();
          push(h('blockquote', { key: 'q' + blocks.length }, inlineMd(quote[1])), lineNo);
          continue;
        }
        // Tables: a pipe row followed by a separator row.
        if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < source.length && /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(source[index + 1])) {
          flushAll();
          const cells = (row) =>
            row
              .replace(/^\s*\|/, '')
              .replace(/\|\s*$/, '')
              .split('|')
              .map((cell) => cell.trim());
          const head = cells(line);
          const rows = [];
          const tableLine = lineNo;
          let cursor = index + 2;
          while (cursor < source.length && /^\s*\|.*\|\s*$/.test(source[cursor])) {
            rows.push({ cells: cells(source[cursor]), line: cursor + 1 });
            cursor += 1;
          }
          index = cursor - 1;
          push(
            h(
              'table',
              { key: 'tb' + blocks.length, className: 'dshcv-mdtable' },
              h('thead', null, h('tr', null, head.map((cell, column) => h('th', { key: 'th' + column }, inlineMd(cell))))),
              h(
                'tbody',
                null,
                rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: 'tr' + rowIndex },
                    head.map((cell, column) => h('td', { key: 'td' + column }, inlineMd(row.cells[column] || ''))),
                  ),
                ),
              ),
            ),
            tableLine,
          );
          continue;
        }
        // Task list items carry a checkbox state in the marker.
        const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
        if (task) {
          flushParagraph();
          if (!list || list.ordered || !list.task) {
            flushList();
            list = { ordered: false, task: true, items: [], line: lineNo };
          }
          list.items.push({ text: task[2], line: lineNo, checked: task[1].toLowerCase() === 'x' });
          continue;
        }
        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (unordered || ordered) {
          flushParagraph();
          const isOrdered = Boolean(ordered);
          if (!list || list.ordered !== isOrdered) {
            flushList();
            list = { ordered: isOrdered, items: [], line: lineNo };
          }
          list.items.push({ text: (unordered || ordered)[1], line: lineNo });
          continue;
        }
        flushList();
        if (!paragraph.length) paragraphLine = lineNo;
        paragraph.push(line.trim());
      }
      // The last block has no terminating blank line, so flush what is pending.
      if (fence) push(h('pre', { key: 'c' + blocks.length }, h('code', null, fence.lines.join('\n'))), fence.line || source.length);
      flushAll();
      return blocks;
    };

    // Hover classes are applied to an already parsed tree, so moving the mouse
    // never re-parses the document.
    const applyMarkdownHover = (blocks, from, to) => {
      if (!from || !to) return blocks;
      const spans = blocks.map((block, index) => {
        const start = Number(block.props['data-line']) || 0;
        const next = index + 1 < blocks.length ? Number(blocks[index + 1].props['data-line']) || 0 : 0;
        return { start, end: next > start ? next - 1 : Infinity };
      });
      return blocks.map((block, index) => {
        const span = spans[index];
        const hit = span.start > 0 && from <= span.end && to >= span.start;
        if (hit) return supportsCssHighlights() ? block : React.cloneElement(block, { className: (block.props.className ? block.props.className + ' ' : '') + 'dshcv-spot' });
        return React.cloneElement(block, {
          className: (block.props.className ? block.props.className + ' ' : '') + 'dshcv-dim',
        });
      });
    };

    const MarkdownBody = (props) => {
      const blocks = React.useMemo(() => parseMarkdown(props.text), [props.text]);
      const shown = React.useMemo(
        () => applyMarkdownHover(blocks, props.hoverFrom, props.hoverTo),
        [blocks, props.hoverFrom, props.hoverTo],
      );
      return h('div', { className: 'dshcv-md' }, shown);
    };

    // ---------------- text viewer ----------------
    // Always same-origin. In the Web UI that is the server itself; in the desktop
    // shell the page is `dsh-app://app`, whose protocol handler forwards every path
    // that is not a static asset straight to the loopback host. Hardcoding
    // `http://127.0.0.1:1296` bypassed that forwarding and broke the moment the
    // server picked another port, which surfaced as "Failed to fetch" after a
    // two-second connect timeout.
    const SAVE_PATH = '/dsh-canvas/save';
    const saveUrl = () => SAVE_PATH;
    const fileUrl = () => '/dsh-canvas/file';

    // Preview budgets. A viewer that survives a 500 MB file is worth less than
    // one that says so clearly, so every heavy reader asks for the size first.
    // Reading a large file is fine; editing one inline is not, because the draft,
    // the baseline and every snapshot copy the whole string. So the two limits differ.
    const LIMITS = { model: 64, design: 64, office: 32, pdf: 256, html: 16, sheet: 32, text: 16, video: 256, image: 64 };
    const EDIT_LIMIT = { text: 4 };
    const MB = 1024 * 1024;

    const readFileInfo = async (sessionId, path, signal) => {
      if (!sessionId) return null;
      try {
        const query = new URLSearchParams({ sessionId, path });
        const response = await fetch(fileUrl() + '?' + query.toString(), { signal });
        if (!response.ok) return null;
        const body = await response.json();
        if (!body || typeof body.size !== 'number') return null;
        const info = { size: body.size, mtimeMs: Number(body.mtimeMs) || 0 };
        // Every probe doubles as a version stamp for mark staleness.
        if (info.mtimeMs) noteFileVersion(path, info.mtimeMs);
        return info;
      } catch {
        return null;
      }
    };

    const readFileSize = async (sessionId, path, signal) => {
      const info = await readFileInfo(sessionId, path, signal);
      return info ? info.size : null;
    };

    // Parsed meshes are expensive and tab switching unmounts the viewer, so a
    // byte-budgeted LRU keeps a few around instead of re-reading from disk.
    const MESH_CACHE_BYTES = 256 * MB;
    const meshCache = new Map();
    let meshCacheBytes = 0;
    const meshCacheKey = (sessionId, path, info) => sessionId + '|' + path + '|' + (info ? info.mtimeMs + ':' + info.size : '0');
    const meshCacheGet = (key) => meshCache.get(key) || null;
    const meshCacheSet = (key, value) => {
      const size = value.positions.byteLength + (value.colors ? value.colors.byteLength : 0);
      if (size > MESH_CACHE_BYTES) return;
      while (meshCacheBytes + size > MESH_CACHE_BYTES && meshCache.size) {
        const oldestKey = meshCache.keys().next().value;
        const oldest = meshCache.get(oldestKey);
        meshCacheBytes -= oldest.size || 0;
        meshCache.delete(oldestKey);
      }
      meshCache.set(key, Object.assign({ size }, value));
      meshCacheBytes += size;
    };
    const releaseMesh = (key) => {
      const cached = meshCache.get(key);
      if (!cached) return;
      meshCacheBytes -= cached.size || 0;
      meshCache.delete(key);
    };

    // File contents come from the in-process workspace channel; the HTTP route
    // only answers metadata, so nothing here can read arbitrary bytes.

    const assertFits = async (sessionId, path, kind, signal) => {
      const limit = (LIMITS[kind] || 32) * MB;
      const size = await readFileSize(sessionId, path, signal);
      if (size !== null && size > limit) {
        throw new Error(
          kind === 'video'
        ? '视频 ' +
          (size / MB).toFixed(1) +
          ' MB，超过预览上限 ' +
          Math.round(limit / MB) +
          ' MB；请先裁切，或用更低的码率重新导出。'
        : '文件 ' + (size / MB).toFixed(1) + ' MB，超过预览上限 ' + Math.round(limit / MB) + ' MB；请先转换或裁切后再看。',
        );
      }
      return size;
    };


    // Chromium exposes ::highlight; without it the row keeps the older wash.
    // Render counters are a debugging aid, not something a reviewer needs to see;
    // they stay hidden unless a GL error appears or the toggle is on.
    const debugState = { on: false };
    try {
      debugState.on = localStorage.getItem('dsh.canvas.debug') === '1';
    } catch {
      /* storage is best effort */
    }
    // Injecting the picker into a preview document is what makes element picking
    // work, but it does run our code inside someone else's page; it can be turned
    // off for HTML that is not trusted.
    const injectState = { on: true };
    try {
      injectState.on = localStorage.getItem('dsh.canvas.injectscript') !== '0';
    } catch {
      /* storage is best effort */
    }
    const injectScriptAllowed = () => injectState.on;
    const toggleInjectScript = () => {
      injectState.on = !injectState.on;
      try {
        localStorage.setItem('dsh.canvas.injectscript', injectState.on ? '1' : '0');
      } catch {
        /* storage is best effort */
      }
      notify();
    };

    const debugRender = () => debugState.on;
    const toggleDebugRender = () => {
      debugState.on = !debugState.on;
      try {
        localStorage.setItem('dsh.canvas.debug', debugState.on ? '1' : '0');
      } catch {
        /* storage is best effort */
      }
      notify();
    };

    const supportsCssHighlights = () =>
      typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight !== 'undefined';

    // Locate the exact characters of a quote inside a container and return a
    // Range. Multi-line quotes are matched by their first and last line, so the
    // highlight covers the whole selection without guessing whitespace between
    // rows (the raw view has no newline characters between line elements).
    const collectTextNodes = (host) => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      const entries = [];
      let flat = '';
      let node = walker.nextNode();
      while (node) {
        let line = 0;
        let element = node.parentElement;
        while (element && element !== host) {
          if (element.dataset && element.dataset.line) {
            line = Number(element.dataset.line) || 0;
            break;
          }
          element = element.parentElement;
        }
        entries.push({ node, start: flat.length, length: (node.nodeValue || '').length, line });
        flat += node.nodeValue || '';
        node = walker.nextNode();
      }
      return { entries, flat };
    };

    // Find one needle, preferring the occurrence closest to a source line.
    const locateNeedle = (entries, needle, preferLine, fromIndex) => {
      if (!needle) return null;
      const matches = [];
      for (const entry of entries) {
        const text = entry.node.nodeValue || '';
        let at = text.indexOf(needle);
        while (at >= 0) {
          matches.push({ entry, offset: at, line: entry.line });
          at = text.indexOf(needle, at + 1);
          if (matches.length > 200) break;
        }
      }
      if (!matches.length) return null;
      const usable = fromIndex === undefined ? matches : matches.filter((match) => match.entry.start >= fromIndex);
      const pool = usable.length ? usable : matches;
      let best = pool[0];
      if (preferLine) {
        let bestDistance = Infinity;
        for (const match of pool) {
          const distance = match.line ? Math.abs(match.line - preferLine) : 999;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = match;
          }
        }
      }
      return best;
    };

    const findQuoteRange = (host, quote, preferLine, endLine) => {
      if (!host || !quote || typeof document === 'undefined') return null;
      const wanted = String(quote)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (!wanted.length) return null;
      const { entries } = collectTextNodes(host);
      if (!entries.length) return null;

      const firstNeedle = wanted[0].slice(0, 120);
      const first = locateNeedle(entries, firstNeedle, preferLine);
      if (!first) return null;

      let last = first;
      let lastNeedle = firstNeedle;
      if (wanted.length > 1) {
        const tail = wanted[wanted.length - 1].slice(-120);
        const tailShort = tail.slice(0, 60);
        const found = locateNeedle(entries, tail, endLine || preferLine, first.entry.start);
        if (found) {
          last = found;
          lastNeedle = tail;
        } else {
          const fallback = locateNeedle(entries, tailShort, endLine || preferLine, first.entry.start);
          if (fallback) {
            last = fallback;
            lastNeedle = tailShort;
          }
        }
      }

      const range = document.createRange();
      try {
        range.setStart(first.entry.node, first.offset);
        range.setEnd(last.entry.node, Math.min(last.entry.length, last.offset + lastNeedle.length));
      } catch {
        return null;
      }
      return range;
    };

    // Line diff for "what changed while I was editing". Common prefix and suffix are
    // trimmed first, then the middle is compared with an LCS; if the middle is too
    // large for the table, it degrades to a block replacement instead of hanging.
    const diffLines = (leftText, rightText, context) => {
      const a = String(leftText == null ? '' : leftText).split('\n');
      const b = String(rightText == null ? '' : rightText).split('\n');
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
      let endA = a.length - 1;
      let endB = b.length - 1;
      while (endA >= start && endB >= start && a[endA] === b[endB]) {
        endA -= 1;
        endB -= 1;
      }
      const middleA = a.slice(start, endA + 1);
      const middleB = b.slice(start, endB + 1);
      const rows = [];
      for (let index = 0; index < start; index += 1) rows.push({ type: 'same', text: a[index], left: index + 1, right: index + 1 });

      if (middleA.length * middleB.length <= 400000) {
        const width = middleB.length + 1;
        const table = new Uint32Array((middleA.length + 1) * width);
        for (let i = middleA.length - 1; i >= 0; i -= 1) {
          for (let j = middleB.length - 1; j >= 0; j -= 1) {
            table[i * width + j] =
              middleA[i] === middleB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
          }
        }
        let i = 0;
        let j = 0;
        while (i < middleA.length && j < middleB.length) {
          if (middleA[i] === middleB[j]) {
            rows.push({ type: 'same', text: middleA[i], left: start + i + 1, right: start + j + 1 });
            i += 1;
            j += 1;
          } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            rows.push({ type: 'del', text: middleA[i], left: start + i + 1 });
            i += 1;
          } else {
            rows.push({ type: 'add', text: middleB[j], right: start + j + 1 });
            j += 1;
          }
        }
        while (i < middleA.length) {
          rows.push({ type: 'del', text: middleA[i], left: start + i + 1 });
          i += 1;
        }
        while (j < middleB.length) {
          rows.push({ type: 'add', text: middleB[j], right: start + j + 1 });
          j += 1;
        }
      } else {
        middleA.forEach((text, index) => rows.push({ type: 'del', text, left: start + index + 1 }));
        middleB.forEach((text, index) => rows.push({ type: 'add', text, right: start + index + 1 }));
      }
      for (let index = endA + 1; index < a.length; index += 1) {
        rows.push({ type: 'same', text: a[index], left: index + 1, right: index + (b.length - a.length) + 1 });
      }

      // Keep only the interesting band: context lines around a change, gaps elsewhere.
      const keep = Math.max(1, Number(context) || 3);
      const changed = rows.map((row, index) => (row.type === 'same' ? -1 : index)).filter((index) => index >= 0);
      if (!changed.length) return { rows: [], added: 0, removed: 0, firstChange: 0 };
      const first = Math.max(0, changed[0] - keep);
      const last = Math.min(rows.length - 1, changed[changed.length - 1] + keep);
      const trimmed = [];
      let gap = false;
      for (let index = first; index <= last; index += 1) {
        const row = rows[index];
        const near = changed.some((at) => Math.abs(at - index) <= keep);
        if (row.type === 'same' && !near) {
          if (!gap) trimmed.push({ type: 'gap', text: '…' });
          gap = true;
          continue;
        }
        gap = false;
        trimmed.push(row);
      }
      return {
        rows: trimmed,
        added: rows.filter((row) => row.type === 'add').length,
        removed: rows.filter((row) => row.type === 'del').length,
        firstChange: changed[0] + 1,
      };
    };

    // Side-by-side is overkill for a review panel: one column with -/+ rows reads
    // better at half width.
    const DiffView = (props) => {
      const diff = React.useMemo(() => diffLines(props.left, props.right, 3), [props.left, props.right]);
      return h(
        'div',
        { className: 'dshcv-diff' },
        h(
          'div',
          { className: 'dshcv-difhead' },
          h('span', null, props.title || '差异'),
          h('span', { className: 'dshcv-msg' }, '+' + diff.added + ' / -' + diff.removed),
          h('span', { className: 'dshcv-spacer' }),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: props.onClose }, '关闭'),
        ),
        diff.rows.length
          ? h(
              'div',
              { className: 'dshcv-diffbody' },
              diff.rows.map((row, index) =>
                h(
                  'div',
                  { key: index, className: 'dshcv-difrow dshcv-dif-' + row.type },
                  h('span', { className: 'dshcv-difnum' }, row.type === 'add' ? '' : String(row.left || '')),
                  h('span', { className: 'dshcv-difnum' }, row.type === 'del' ? '' : String(row.right || '')),
                  h('span', { className: 'dshcv-difsign' }, row.type === 'add' ? '+' : row.type === 'del' ? '-' : row.type === 'gap' ? '⋯' : ' '),
                  h('span', { className: 'dshcv-diftext' }, row.text || ' '),
                ),
              ),
            )
          : h('div', { className: 'dshcv-msg', style: { padding: '10px 12px' } }, '两边内容一致'),
      );
    };

    function TextDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', text: '', absolutePath: '', version: undefined, size: 0, error: '' });
      const [picked, setPicked] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      const [pageBudget, setPageBudget] = React.useState(12);
      const hovered = useHoverMark(doc.path);
      const hoverLines =
        hovered && hovered.kind === 'text' && hovered.lines ? { from: hovered.lines[0], to: hovered.lines[1] } : null;
      const [draft, setDraft] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [conflict, setConflict] = React.useState(null);
      const [reloadTick, setReloadTick] = React.useState(0);
      // Editing safety net: the text as it was on disk, plus periodic snapshots so
      // a bad edit can be undone without leaving the editor.
      const [snapshots, setSnapshots] = React.useState([]);
      const [baseline, setBaseline] = React.useState('');
      const [diffState, setDiffState] = React.useState(null);
      const [fontSize, setFontSize] = React.useState(() => {
        const saved = Number(localStorage.getItem('dsh.canvas.fontsize'));
        return saved >= 10 && saved <= 22 ? saved : 12;
      });
      const applyFontSize = (next) => {
        const value = Math.max(10, Math.min(22, next));
        setFontSize(value);
        try {
          localStorage.setItem('dsh.canvas.fontsize', String(value));
        } catch {
          /* storage is best effort */
        }
      };
      const isMarkdown = doc.view === 'markdown';
      // Code files get a token layer; plain text and markdown source stay as they are.
      const codeLang = doc.view === 'text' ? codeLangOf(doc.path) : '';
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
          setState({ status: 'idle', text: '', absolutePath: '', version: undefined, error: '', truncated: false });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', text: '', absolutePath: '', version: undefined, error: '', truncated: false });
        setEditing(false);
        const load = async () => {
          try {
            const info = await readFileInfo(sessionId, doc.path, controller.signal);
            const page = await readTextPages(sessionId, doc.path, controller.signal, pageBudget);
            if (cancelled) return;
            noteFileVersion(doc.path, page.version);
            relocateMarks(doc.path, page.text, Number(page.version) || 0);
            setState({
              status: 'ready',
              text: page.text,
              absolutePath: page.absolutePath,
              version: (info && info.mtimeMs) || page.version,
              size: info ? Number(info.size) || 0 : 0,
              error: '',
              truncated: page.truncated,
            });
          } catch (error) {
            if (cancelled) return;
            setState({ status: 'failed', text: '', absolutePath: '', version: undefined, error: errText(error), truncated: false });
          }
        };
        load();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId, pageBudget, reloadTick]);

      // Snapshot the draft once typing pauses, so undo has somewhere to go back to.
      React.useEffect(() => {
        if (!editing) return undefined;
        const timer = setTimeout(() => {
          setSnapshots((list) => {
            if (!list.length || list[list.length - 1] !== draft) {
              const next = list.concat([draft]);
              return next.length > 24 ? next.slice(next.length - 24) : next;
            }
            return list;
          });
        }, 1200);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [draft, editing]);
      React.useEffect(() => {
        if (!message) return undefined;
        const timer = setTimeout(() => setMessage(''), 3000);
        return () => clearTimeout(timer);
      }, [message]);

      const codeLines = React.useMemo(
        () => buildCodeLines(state.text, codeLang),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [state.text, codeLang],
      );

      const lineElements = React.useMemo(() => {
        if (state.status !== 'ready') return [];
        return state.text.split('\n');
      }, [state]);

      const [searchOpen, setSearchOpen] = React.useState(false);
      const [searchQuery, setSearchQuery] = React.useState('');
      const [searchIndex, setSearchIndex] = React.useState(-1);

      const searchHits = React.useMemo(() => {
        const needle = searchQuery.trim().toLowerCase();
        if (!needle) return [];
        const hits = [];
        for (let index = 0; index < lineElements.length; index += 1) {
          if (lineElements[index] && lineElements[index].toLowerCase().includes(needle)) hits.push(index + 1);
          if (hits.length >= 2000) break;
        }
        return hits;
      }, [lineElements, searchQuery]);

      // Typing stays on the fast path: the query is deferred, so keystrokes are not
      // blocked by highlighting thousands of lines.
      const deferredQuery = React.useDeferredValue(searchQuery);
      const deferredHits = React.useMemo(() => {
        const needle = deferredQuery.trim().toLowerCase();
        if (!needle) return searchHits;
        const hits = [];
        for (let index = 0; index < lineElements.length; index += 1) {
          if (lineElements[index] && lineElements[index].toLowerCase().includes(needle)) hits.push(index + 1);
          if (hits.length >= 2000) break;
        }
        return hits;
      }, [lineElements, deferredQuery, searchHits]);

      const highlight = (line, query) => {
        const needle = String(query || '').trim();
        if (!needle || !line) return line || ' ';
        const lower = line.toLowerCase();
        const target = needle.toLowerCase();
        const pieces = [];
        let from = 0;
        let at = lower.indexOf(target);
        let guard = 0;
        while (at >= 0 && guard < 200) {
          if (at > from) pieces.push(line.slice(from, at));
          pieces.push(h('mark', { key: 'm' + at + '-' + guard, className: 'dshcv-hit' }, line.slice(at, at + needle.length)));
          from = at + needle.length;
          at = lower.indexOf(target, from);
          guard += 1;
        }
        if (from < line.length) pieces.push(line.slice(from));
        return pieces.length ? pieces : line;
      };

      // Rows are rebuilt only when the content, the search or the spotlight change:
      // a 12-page file is tens of thousands of nodes.
      const hoverFrom = hoverLines ? hoverLines.from : 0;
      const hoverTo = hoverLines ? hoverLines.to : 0;
      const rows = React.useMemo(
        () =>
          lineElements.map((line, index) =>
            h(
              'div',
              {
                key: index,
                className:
                  'dshcv-line' +
                  (deferredHits.includes(index + 1) ? ' dshcv-linehit' : '') +
                  (searchIndex >= 0 && deferredHits[searchIndex] === index + 1 ? ' dshcv-linehitcur' : '') +
                  (hoverFrom
                    ? index + 1 >= hoverFrom && index + 1 <= hoverTo
                      ? supportsCssHighlights()
                        ? ''
                        : ' dshcv-spot'
                      : ' dshcv-dim'
                    : ''),
                'data-line': index + 1,
              },
              h('span', { className: 'dshcv-num' }, String(index + 1)),
              h('span', { className: 'dshcv-text' + (codeLang ? ' dshcv-code' : '') },
            codeLines && codeLines[index]
              ? codeLines[index].map(([text, cls], tokenIndex) =>
                h('span', { key: tokenIndex, className: cls ? 'dshcv-tok dshcv-tok-' + cls : undefined }, text),
                )
              : highlight(line, deferredQuery),
          ),
            ),
          ),
        [lineElements, deferredHits, searchIndex, deferredQuery, hoverFrom, hoverTo],
      );

      // One stepper for the keyboard and the two buttons, so both cannot drift.
      const stepSearch = (delta) => {
        if (!searchHits.length) return;
        setSearchIndex((value) => {
          const size = searchHits.length;
          return (((Math.max(0, value) + delta) % size) + size) % size;
        });
      };

      React.useEffect(() => {
        if (searchIndex < 0 || !searchHits.length) return;
        const line = searchHits[Math.min(searchIndex, searchHits.length - 1)];
        const host = scrollRef.current;
        const node = host && host.querySelector('[data-line="' + line + '"]');
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
      }, [searchIndex, searchHits]);

      // Rail hover covers exactly the marked characters (CSS Highlights), so a long
      // paragraph keeps its context while the quote itself stands out.
      React.useEffect(() => {
        if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return undefined;
        CSS.highlights.delete('dshcv-hover');
        const host = scrollRef.current;
        const mark = hovered;
        if (!host || !mark || mark.kind !== 'text' || !mark.quote) return undefined;
        const range = findQuoteRange(host, mark.quote, mark.lines ? mark.lines[0] : 0);
        if (range) {
          CSS.highlights.set('dshcv-hover', new Highlight(range));
        }
        return () => {
          try {
            CSS.highlights.delete('dshcv-hover');
          } catch {
            /* ignore */
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hovered && hovered.id, rendered]);

      // Rail hover scrolls the marked lines into view, unless following is off.
      React.useEffect(() => {
        const host = scrollRef.current;
        if (!host || !hoverLines || !followHoverOn()) return;
        const node = host.querySelector('[data-line="' + hoverLines.from + '"]');
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hovered && hovered.id]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (!ownsKeyboard(event, scrollRef.current)) return;
          if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault();
            setSearchOpen(true);
            return;
          }
          if (event.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
            setSearchQuery('');
            setSearchIndex(-1);
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [searchOpen]);

      const clampNode = (node) => {
        let element = node && node.nodeType === 3 ? node.parentElement : node;
        while (element && !(element.dataset && element.dataset.line)) element = element.parentElement;
        return element && element.dataset && element.dataset.line ? element : null;
      };

      const onMouseUp = () => {
        if (editing) return;
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
        // Capture the surrounding text so the mark can be found again after an edit.
        const context = (() => {
          const source = state.text || '';
          const rows = source.split('\n');
          const startLine = Math.max(0, picked.startLine - 1);
          const offset = rows.slice(0, startLine).reduce((sum, row) => sum + row.length + 1, 0);
          const block = rows.slice(startLine, picked.endLine).join('\n');
          return {
            before: source.slice(Math.max(0, offset - 24), offset),
            after: source.slice(offset + block.length, offset + block.length + 24),
          };
        })();
        const number = addTextMark(doc.path, picked.startLine, picked.endLine, picked.quote, context);
        if (number) setMessage('已标注为 #' + number);
        setPicked(null);
        try {
          window.getSelection().removeAllRanges();
        } catch {
          /* ignore */
        }
      };

      const beginEdit = () => {
        const editable = (EDIT_LIMIT[fileKind(doc.path)] || 8) * MB;
        if (state.size && state.size > editable) {
          setMessage(
            '文件 ' +
              (state.size / MB).toFixed(1) +
              ' MB，超过可编辑上限 ' +
              Math.round(editable / MB) +
              ' MB；可以只读查看，需要修改请用外部编辑器。',
          );
          return;
        }
        setDraft(state.text);
        setBaseline(state.text);
        setSnapshots([]);
        setDiffState(null);
        setEditing(true);
        setRendered(false);
        setPicked(null);
        setMessage('');
      };

      const cancelEdit = () => {
        setEditing(false);
        setDraft('');
        setDiffState(null);
        setSnapshots([]);
        setMessage('');
      };

      const save = async (force) => {
        if (!state.absolutePath) {
          setMessage('未取得文件绝对路径，无法保存');
          return;
        }
        setSaving(true);
        setConflict(null);
        if (!state.version && !state.size) setMessage('缺少版本信息，本次保存无法检测外部改动');
        else setMessage('保存中…');
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
              expectedMtime: state.version || 0,
              expectedSize: state.size || 0,
              force: force === true,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.status === 409) {
            setConflict({ mtimeMs: payload && payload.mtimeMs ? payload.mtimeMs : 0, size: payload && payload.size ? payload.size : 0 });
            setMessage('文件已被外部修改');
            return;
          }
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
          const nextVersion = payload && payload.mtimeMs ? payload.mtimeMs : state.version;
          noteFileVersion(doc.path, nextVersion);
          setState(
            Object.assign({}, state, {
              text: draft,
              version: nextVersion,
              size: payload && payload.size ? payload.size : state.size,
            }),
          );
          setEditing(false);
          setMessage('已保存');
        } catch (error) {
          setMessage(netText(error, '保存'));
        } finally {
          setSaving(false);
        }
      };

      const undoDraft = () => {
        setSnapshots((list) => {
          if (!list.length) {
            setDraft(baseline);
            return list;
          }
          const next = list.slice(0, list.length - 1);
          setDraft(next.length ? next[next.length - 1] : baseline);
          return next;
        });
      };

      const compareWithBaseline = () => {
        setDiffState({ left: baseline, right: draft, title: '与打开时的内容对比' });
      };

      // Pull the current disk text and diff it against the draft; used from the
      // conflict bar so "overwrite or discard" is not a blind choice.
      const compareWithDisk = async () => {
        try {
          const page = await readTextPages(sessionId, doc.path, undefined, pageBudget);
          setDiffState({ left: page.text || '', right: draft, title: '磁盘内容 ← → 我的修改' });
        } catch (error) {
          setMessage('无法读取磁盘内容：' + errText(error));
        }
      };

      const reloadFromDisk = () => {
        setConflict(null);
        setEditing(false);
        setMessage('已重新读取');
        setReloadTick((value) => value + 1);
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
        searchOpen
          ? h(
              'span',
              { className: 'dshcv-search' },
              h('input', {
                type: 'search',
                className: 'dshcv-searchinput',
                value: searchQuery,
                placeholder: '查找…',
                onChange: (event) => {
                  setSearchQuery(event.target.value);
                  setSearchIndex(0);
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  stepSearch(event.shiftKey ? -1 : 1);
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': 'quiet',
                  'data-icon': '1',
                  disabled: !searchHits.length,
                  title: '上一个匹配（Shift+Enter）',
                  onClick: () => stepSearch(-1),
                },
                '‹',
              ),
              h(
                'span',
                { className: 'dshcv-msg' },
                searchHits.length ? Math.max(0, searchIndex) + 1 + '/' + searchHits.length : '无匹配',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': 'quiet',
                  'data-icon': '1',
                  disabled: !searchHits.length,
                  title: '下一个匹配（Enter）',
                  onClick: () => stepSearch(1),
                },
                '›',
              ),
            )
          : null,
        state.truncated
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                title: '文件超过一次读取量，点击继续加载',
                onClick: () => setPageBudget((value) => value + 12),
              },
              '已截断 · 继续加载',
            )
          : null,
        message ? h('span', { className: 'dshcv-msg' }, message) : null,
        editing
          ? h(
              'button',
              { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', title: '回到上一个快照', onClick: undoDraft },
              '撤销',
            )
          : null,
        editing && draft !== baseline
          ? h(
              'button',
              { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', title: '丢弃修改，恢复打开时的内容', onClick: () => setDraft(baseline) },
              '回滚',
            )
          : null,
        editing
          ? h(
              'button',
              { type: 'button', className: 'dshcv-btn dshcv-opt', 'data-kind': 'quiet', title: '与打开时的内容逐行对比', onClick: compareWithBaseline },
              '对比',
            )
          : null,
        editing
          ? h(
              'button',
              { type: 'button', className: 'dshcv-btn', 'data-kind': 'primary', disabled: saving, onClick: () => save(false)  },
              saving ? '保存中…' : '保存',
            )
          : null,
      );

      // Save conflict: the file moved on disk while this editor was open.
      const toolbarWithBanner = conflict
        ? h(
            React.Fragment,
            null,
            toolbar,
            h(
              'div',
              { className: 'dshcv-conflict' },
              h(
                'span',
                null,
                '文件已被外部修改' + (conflict.size ? '（磁盘上 ' + conflict.size.toLocaleString() + ' 字节）' : '') + '，直接保存会覆盖对方的改动。',
              ),
              h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'primary', disabled: saving, onClick: () => save(true) }, '仍然覆盖'),
              h('button', { type: 'button', className: 'dshcv-btn', onClick: compareWithDisk }, '查看差异'),
              h('button', { type: 'button', className: 'dshcv-btn', onClick: reloadFromDisk }, '放弃我的修改并重读'),
            ),
          )
        : toolbar;
      const pickButton = picked
        ? h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn dshcv-pick',
              'data-kind': 'primary',
              style: { top: picked.top, left: picked.left },
              onMouseDown: (event) => event.preventDefault(),
              onClick: commit,
            },
            '标记 ' + (picked.startLine === picked.endLine ? '第 ' + picked.startLine + ' 行' : '第 ' + picked.startLine + '-' + picked.endLine + ' 行'),
          )
        : null;

      if (diffState) {
        return h(
          React.Fragment,
          null,
          toolbarWithBanner,
          h(DiffView, {
            left: diffState.left,
            right: diffState.right,
            title: diffState.title,
            onClose: () => setDiffState(null),
          }),
        );
      }
      if (isMarkdown && rendered && !editing) {
        return h(
          React.Fragment,
          null,
          toolbarWithBanner,
          h(
            'div',
            { className: 'dshcv-scroll', ref: scrollRef, onMouseUp: onMouseUp, style: { '--dshcv-text-size': fontSize + 'px' } },
            h(MarkdownBody, { text: state.text, hoverFrom: hoverLines && hoverLines.from, hoverTo: hoverLines && hoverLines.to }),
          ),
          pickButton,
        );
      }

      if (editing) {
        return h(
          React.Fragment,
          null,
          toolbarWithBanner,
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
        toolbarWithBanner,
        h(
          'div',
          { className: 'dshcv-scroll', ref: scrollRef, onMouseUp: onMouseUp, style: { '--dshcv-text-size': fontSize + 'px' } },
          h('div', { className: 'dshcv-code' }, rows),
        ),
        picked
          ? pickButton
          : null,
      );
    }

    // ---------------- marks rail ----------------
    // Marks grouped by file, optionally limited to the open file, with per-mark
    // actions: copy one entry, delete, and hover-to-spotlight from the row.
    const railScope = { mode: 'all' };
    try {
      const savedScope = localStorage.getItem('dsh.canvas.railscope');
      if (savedScope === 'all' || savedScope === 'active') railScope.mode = savedScope;
    } catch {
      /* storage is best effort */
    }
    const setRailScope = (mode) => {
      railScope.mode = mode === 'active' ? 'active' : 'all';
      try {
        localStorage.setItem('dsh.canvas.railscope', railScope.mode);
      } catch {
        /* storage is best effort */
      }
      notify();
    };

    // A transient message that survives the component that triggered it: a copy
    // action usually happens while the eye is on the picture, not on the toolbar.
    let flashTimer = 0;
    const flash = (text) => {
      store.flash = String(text || '');
      notify();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        store.flash = '';
        notify();
      }, 1800);
    };

    // Same toast, but it stays long enough to be read and reported.
    const flashLong = (text) => {
      store.flash = String(text || '');
      notify();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        store.flash = '';
        notify();
      }, 4000);
    };

    // One clipboard path for text: the async API when available, a hidden textarea
    // otherwise. Both the mark copy button and the colour picker use it.
    const copyText = (text, label) => {
      const value = String(text == null ? '' : text);
      const fallback = () => {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand('copy');
        } catch {
          /* ignore */
        }
        document.body.removeChild(area);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(value)
          .then(() => flash(label || '已复制'))
          .catch(() => {
            fallback();
            flash(label || '已复制');
          });
        return;
      }
      fallback();
      flash(label || '已复制');
    };

    const copyMark = (mark) => copyText(markToBlock(mark), '已复制第 ' + mark.n + ' 条');

    // ---- comment templates ----
    const DEFAULT_TEMPLATES = ['这段太啰嗦，请精简', '改成主动语态', '术语前后不一致，请统一', '补上异常分支'];
    const loadTemplates = () => {
      try {
        const raw = localStorage.getItem('dsh.canvas.templates');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string' && item.trim()).slice(0, 30);
        }
      } catch {
        /* storage is best effort */
      }
      return DEFAULT_TEMPLATES.slice();
    };
    const saveTemplates = (list) => {
      store.templates = list;
      try {
        localStorage.setItem('dsh.canvas.templates', JSON.stringify(list));
      } catch {
        /* storage is best effort */
      }
      notify();
    };
    store.templates = loadTemplates();

    function MarksRail(props) {
      useVersion();
      useHoverVersion();
      const [query, setQuery] = React.useState('');
      const [menuFor, setMenuFor] = React.useState(null);
      // The menu is a popover, so it closes on Escape and on a click anywhere else.
      React.useEffect(() => {
        if (!menuFor) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuFor(null);
        };
        const onDown = (event) => {
          const target = event.target;
          if (target && target.closest && target.closest('[data-menu-trigger]')) return;
          setMenuFor(null);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', onDown);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('pointerdown', onDown);
        };
      }, [menuFor]);
      if (!store.marks.length) return null;

      // In a split the rail follows the focused half, not always the first one.
      const splitNow = splitState();
      const focusedDoc = splitNow.on && store.splitFocus === 'b' ? secondDoc() : store.docs.find((doc) => doc.id === store.activeId);
      const activeDoc = focusedDoc || store.docs.find((doc) => doc.id === store.activeId);
      const activePath = activeDoc ? activeDoc.path : '';
      const activeCount = activePath ? store.marks.filter((mark) => sameFile(mark.path, activePath)).length : 0;
      const needle = query.trim().toLowerCase();
      const visible = store.marks
        .filter((mark) => (railScope.mode === 'active' && activePath ? sameFile(mark.path, activePath) : true))
        .filter((mark) => {
          if (!needle) return true;
          const haystack = (mark.path + ' ' + (mark.quote || '') + ' ' + (mark.note || '') + ' ' + (mark.label || '') + ' ' + markWhere(mark)).toLowerCase();
          return haystack.includes(needle);
        })
        .sort((a, b) => a.n - b.n);
      if (!visible.length) return null;

      const groups = [];
      for (const mark of visible) {
        const key = pathKey(mark.path);
        let group = groups.find((entry) => entry.key === key);
        if (!group) {
          group = { key, path: mark.path, marks: [] };
          groups.push(group);
        }
        group.marks.push(mark);
      }
      const showGroupHeaders = groups.length > 1;

      const renderMark = (mark) =>
        h(
          'div',
          {
            key: mark.id,
            className:
              'dshcv-mark' +
              (store.hoverId === mark.id ? ' dshcv-markrow-on' : '') +
              (mark.done ? ' dshcv-mark-done' : ''),
            onMouseEnter: () => setHoverMark(mark.id),
            onMouseLeave: () => setHoverMark(undefined),
            tabIndex: 0,
            // Delete removes the row, Enter jumps into its note: the same two actions
            // the buttons offer, without a mouse.
            onKeyDown: (event) => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                removeMark(mark.id);
              } else if (event.key === 'Enter') {
                const note = event.currentTarget.querySelector('.dshcv-note');
                if (note) {
                  event.preventDefault();
                  note.focus();
                }
              }
            },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-badge' + (mark.done ? ' dshcv-badge-done' : ''),
              title: mark.done ? '已处理，点击撤销' : '标记为已处理',
              onClick: () => toggleDone(mark.id),
            },
            mark.done ? '✓' : String(mark.n),
          ),
          markStale(mark)
            ? h('span', { className: 'dshcv-stale', title: '文件已改动，这条标注的位置可能已偏移' }, '⚠')
            : mark.relocated
              ? h('span', { className: 'dshcv-stale', title: '文件改动后已按上下文重新定位' }, '↻')
              : null,
          h(
            'div',
            { className: 'dshcv-markbody' },
            h(
              'div',
              { className: 'dshcv-meta' },
              showGroupHeaders
                ? markPlace(mark)
                : [
                    h('span', { key: 'path', className: 'dshcv-mpath', title: mark.path }, shortenPath(mark.path)),
                    ' · ',
                    markPlace(mark),
                  ],
            ),
            mark.quote ? h('div', { className: 'dshcv-quote' }, mark.quote.split('\n').slice(0, 3).join('\n')) : null,
            h('input', {
              className: 'dshcv-note',
              placeholder: '写修改意见，发送时按编号带上',
              value: mark.note || '',
              onChange: (event) => setMarkNote(mark.id, event.target.value),
            }),
            h(
              'div',
              { style: { position: 'relative', display: 'flex', gap: '6px', alignItems: 'center' } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': 'quiet',
                  title: '插入常用意见',
                  'data-menu-trigger': mark.id,
                  onClick: () => setMenuFor(menuFor === mark.id ? null : mark.id),
                },
                '常用意见',
              ),
              menuFor === mark.id
                ? h(
                    'div',
                    { className: 'dshcv-template-menu' },
                    // The save action is an action, not a template, so it sits above the
                    // rule and carries its own accent instead of looking like an entry.
                    (mark.note || '').trim()
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dshcv-btn dshcv-template-save',
                            onClick: () => {
                              const current = (mark.note || '').trim();
                              if (!current) return;
                              saveTemplates((store.templates || DEFAULT_TEMPLATES).concat([current]).slice(-30));
                              setMenuFor(null);
                            },
                          },
                          '＋ 把当前意见存为模板',
                        )
                      : null,
                    (mark.note || '').trim() ? h('div', { className: 'dshcv-template-rule' }) : null,
                    h(
                      'div',
                      { className: 'dshcv-template-list' },
                      (store.templates || DEFAULT_TEMPLATES).map((template, index) =>
                        h(
                          'div',
                          { key: 'tpl' + index, className: 'dshcv-template-row' },
                          h(
                            'span',
                            { className: 'dshcv-template-tag' },
                            '已存',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dshcv-btn dshcv-template-pick',
                              title: template,
                              onClick: () => {
                                const current = (mark.note || '').trim();
                                setMarkNote(mark.id, current ? current + '；' + template : template);
                                setMenuFor(null);
                              },
                            },
                            template,
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dshcv-btn dshcv-template-remove',
                              'data-kind': 'quiet',
                              title: '删除这条模板',
                              onClick: () => saveTemplates((store.templates || DEFAULT_TEMPLATES).filter((item) => item !== template)),
                            },
                            '×',
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': 'quiet',
              title: '复制这一条的 Markdown',
              onClick: () => copyMark(mark),
            },
            '⧉',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': 'quiet',
              title: '只把这一条发送到对话框',
              onClick: () => sendOneMark(mark),
            },
            '↗',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': 'quiet',
              title: '删除标记',
              onClick: () => removeMark(mark.id),
            },
            '×',
          ),
        );

      return h(
        'div',
        { className: 'dshcv-marks', style: props && props.style },
        h(
          'div',
          { className: 'dshcv-railhead' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-chip',
              'aria-pressed': railScope.mode === 'all' ? 'true' : 'false',
              onClick: () => setRailScope('all'),
            },
            '全部 ' + store.marks.length,
          ),
          activePath
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-chip',
                  'aria-pressed': railScope.mode === 'active' ? 'true' : 'false',
                  disabled: !activeCount,
                  title: activeCount ? '只看当前文件的标注' : '当前文件还没有标注',
                  onClick: () => setRailScope('active'),
                },
                basename(activePath) + ' ' + activeCount,
              )
            : null,
          h('input', {
            type: 'search',
            className: 'dshcv-searchinput',
            value: query,
            placeholder: '搜索标注（跨文件）',
            style: { flex: '1 1 auto', minWidth: '80px' },
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        ...groups.map((group) =>
          h(
            React.Fragment,
            { key: group.key },
            showGroupHeaders
              ? h(
                  'div',
                  { className: 'dshcv-railgroup', title: group.path },
                  h('span', { key: 'path', className: 'dshcv-mpath' }, shortenPath(group.path, 40)),
                  ' · ' + group.marks.length + ' 条',
                )
              : null,
            group.marks.map((mark) => renderMark(mark)),
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

    const readTextPages = async (sessionId, path, signal, maxPages) => {
      const files = workspaceFiles();
      if (!files) throw new Error('workspaceFiles.read unavailable');
      await assertFits(sessionId, path, fileKind(path), signal);
      let text = '';
      let offset = 1;
      let absolutePath = '';
      let version;
      let truncated = false;
      const budget = Math.max(1, Number(maxPages) || 12);
      for (let page = 0; page < budget; page += 1) {
        const result = unwrap(await files.read(sessionId, path, { offset }, signal));
        if (page === 0 && result) {
          absolutePath = String(result.absolutePath || '');
          version = result.version;
        }
        text += (text ? '\n' : '') + String(result && result.text ? result.text : '');
        if (!result || result.eof) break;
        if (page === budget - 1) truncated = true;
        offset += Math.max(1, Number(result.lines) || 1000);
      }
      // The remote may not report a version; our own metadata route always does, and
      // assertFits has just refreshed it.
      return { text, absolutePath, version: fileVersionOf(path) || version, truncated };
    };

    const readBytesFile = async (sessionId, path, signal) => {
      const files = workspaceFiles();
      if (!files || typeof files.readBytes !== 'function') throw new Error('workspaceFiles.readBytes unavailable');
      // Refuse oversized payloads before they are materialised in memory.
      await assertFits(sessionId, path, fileKind(path), signal);
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
      'var box=null,dwellEl=null,dwellTimer=null,spotEl=null,paused=false;',
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
      'function hideBox(){if(box)box.style.display="none";}',
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
// Nothing animates here, so picking needs no pause: the page is already still.
// A document is still when nothing animates. getCurrentTime() is the SVG document
// timeline and keeps counting in a static file, so it cannot be used as a signal:
// look for actual SMIL elements plus CSS/WAAPI animations instead.
'function smilCount(){try{return document.querySelectorAll("animate,animateMotion,animateTransform,animateColor,set").length;}catch(e){return 0;}}',
'function frozen(){if(paused)return true;try{if(anims().length)return false;}catch(e){}if(smilCount())return false;return true;}',
      'function pauseAll(){var list=anims();for(var i=0;i<list.length;i++){try{list[i].pause();}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{roots[j].pauseAnimations&&roots[j].pauseAnimations();}catch(e){}}paused=true;report();}',
      'function resumeAll(){var list=anims();for(var i=0;i<list.length;i++){try{list[i].play();}catch(e){}}',
      'var roots=svgRoots();for(var j=0;j<roots.length;j++){try{roots[j].unpauseAnimations&&roots[j].unpauseAnimations();}catch(e){}}paused=false;releaseRaf();hideBox();report();}',
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
      'parent.postMessage({source:"dshcv-anim",state:{paused:paused,duration:Math.round(duration),current:Math.round(current),count:list.length,raf:rafQueue.length}},"*");}',
      // pointer behaviour: every attention-drawing affordance (hover outline and
      // dwell spotlight) belongs to the frozen frame, so a playing preview is
      // left exactly as the document ships it.
      'document.addEventListener("mousemove",function(e){var el=e.target;if(!el||el.nodeType!==1)return;',
      'if(!frozen()){hideBox();dwellEl=el;if(spotEl||document.documentElement.hasAttribute("data-dshcv-spotlight"))clearSpot();return;}',
      'var b=overlay();var r=el.getBoundingClientRect();b.style.display="block";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";',
      'if(el!==dwellEl){dwellEl=el;clearSpot();clearTimeout(dwellTimer);dwellTimer=setTimeout(function(){if(dwellEl===el)markSpot(el);},500);}},true);',
      'document.addEventListener("mouseleave",function(){dwellEl=null;clearTimeout(dwellTimer);clearSpot();hideBox();},true);',
      // Playing: clicks belong to the document (its handlers, its animations).
      // Paused: they pick the element and create a numbered mark instead.
      'document.addEventListener("click",function(e){var el=e.target;if(!el||el.nodeType!==1)return;if(!frozen())return;e.preventDefault();e.stopPropagation();',
      'var r=el.getBoundingClientRect();var text=(el.innerText||el.textContent||"").trim().slice(0,240);',
      'parent.postMessage({source:"dshcv-picker",selector:sel(el),tag:el.tagName.toLowerCase(),text:text,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]},"*");},true);',
      'document.addEventListener("keydown",function(e){var t=e.target;if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||"")))return;var step=e.shiftKey?100:16;',
      // Alt + A/S/D: one left hand, no browser or IME collisions (Space toggles
      // IMEs, scrolls the page and is claimed by most embedded players).
      'if(e.altKey&&(e.key==="s"||e.key==="S")){e.preventDefault();paused?resumeAll():pauseAll();}',
      'else if(e.altKey&&(e.key==="a"||e.key==="A")){e.preventDefault();pauseAll();var t2=anims();var c=0;for(var i=0;i<t2.length;i++){try{c=Math.max(c,Number(t2[i].currentTime)||0);}catch(x){}}seek(c-step);}',
      'else if(e.altKey&&(e.key==="d"||e.key==="D")){e.preventDefault();pauseAll();var u=anims();var d=0;for(var i=0;i<u.length;i++){try{d=Math.max(d,Number(u[i].currentTime)||0);}catch(x){}}seek(d+step);}',
      'else if(e.key==="ArrowLeft"){e.preventDefault();pauseAll();var t3=anims();var c3=0;for(var i=0;i<t3.length;i++){try{c3=Math.max(c3,Number(t3[i].currentTime)||0);}catch(x){}}seek(c3-step);}',
      'else if(e.key==="ArrowRight"){e.preventDefault();pauseAll();var u3=anims();var d3=0;for(var i=0;i<u3.length;i++){try{d3=Math.max(d3,Number(u3[i].currentTime)||0);}catch(x){}}seek(d3+step);}',
      'else if(e.key==="p"||e.key==="P"){paused?resumeAll():pauseAll();}},true);',
      'window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.source!=="dshcv-cmd")return;',
      'if(d.cmd==="pause")pauseAll();else if(d.cmd==="resume")resumeAll();else if(d.cmd==="seek")seek(d.time);',
      'else if(d.cmd==="step")stepFrame(d.dir||1);',
      'else if(d.cmd==="state")report();else if(d.cmd==="spot"){var spotTarget=null;if(d.selector){try{spotTarget=document.querySelector(d.selector);}catch(spotError){}}if(spotTarget){markSpot(spotTarget);}else{clearSpot();}}},false);',
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
      const { anim, onPause, onResume, onSeek, onStep } = props;
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
          { type: 'button', className: 'dshcv-btn', title: '暂停 / 继续（Alt+S）', onClick: anim.paused ? onResume : onPause },
          anim.paused ? '继续' : '暂停',
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
          { className: 'dshcv-msg', title: anim.paused ? '定格中：悬停任意元素 0.5 秒，其余元素淡化' : 'Alt+S 暂停 / 继续' },
          anim.paused
            ? Math.round(current) + ' ms / ' + Math.round(span) + ' ms' + (anim.raf ? ' · JS 帧 ' + anim.raf : '')
            : anim.count || anim.raf
              ? (anim.count || 0) + ' 个动画' + (anim.raf ? ' · JS 帧 ' + anim.raf : '')
              : '无动画',
        ),
        injectScriptAllowed()
          ? null
          : h('span', { className: 'dshcv-msg', title: '按 ? 打开帮助可重新开启' }, '标注脚本已禁用'),
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
      const [anim, setAnim] = React.useState({ paused: false, duration: 0, current: 0, count: 0 });
      const frameRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const pausedRef = React.useRef(false);

      const post = (cmd, extra) => {
        const frame = frameRef.current;
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage(Object.assign({ source: 'dshcv-cmd', cmd }, extra || {}), '*');
      };

      // Rail hover spotlights the same element inside the preview document.
      const hovered = useHoverMark(doc.path);
      const hoverSelector = hovered && hovered.kind === 'element' ? hovered.selector || '' : '';
      React.useEffect(() => {
        if (state.status !== 'ready') return;
        post('spot', { selector: hoverSelector });
      }, [hoverSelector, state.status]);

      // Space pauses and resumes; both stay inert while the user types outside
      // the panel.
      React.useEffect(() => {
        const onKey = (event) => {
          if (!ownsKeyboard(event, rootRef.current)) return;
          if (document.activeElement === frameRef.current) return;
          if (event.altKey && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            const next = !pausedRef.current;
            pausedRef.current = next;
            setAnim((previous) => Object.assign({}, previous, { paused: next }));
            post(next ? 'pause' : 'resume');
            return;
          }
          // Frame stepping must also work while the preview iframe does not own
          // the keyboard, so the panel forwards it like pause does.
          if (event.altKey && (event.key === 'a' || event.key === 'A' || event.key === 'd' || event.key === 'D')) {
            event.preventDefault();
            const forward = event.key === 'd' || event.key === 'D';
            pausedRef.current = true;
            setAnim((previous) => Object.assign({}, previous, { paused: true }));
            post('step', { dir: forward ? 1 : -1 });
          }
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
            objectUrl = URL.createObjectURL(
  new Blob([injectScriptAllowed() ? injectPicker(html) : html], { type: 'text/html' }),
);
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
            pausedRef.current = Boolean(data.state.paused);
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
        { ref: rootRef, style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        // A document that ships nothing animated needs no playback UI: the frame is
        // already still, so picking works directly.
        anim.count > 0
          ? h(AnimBar, {
            anim,
            onPause: () => post('pause'),
            onResume: () => post('resume'),
            onSeek: (time) => post('seek', { time }),
            onStep: (dir) => post('step', { dir }),
          })
          : null,
        h(
          FitStage,
          { enabled: props.fit, designWidth: 1280 },
          h('iframe', {
            ref: frameRef,
            src: state.url,
            title: 'canvas html preview',
            sandbox: 'allow-scripts',
            onLoad: () => post('state'),
            style: { flex: '1 1 auto', width: '100%', height: '100%', border: '0', background: '#fff' },
          }),
        ),
      );
    }

    // ---------------- svg viewer (sandboxed preview, filter as a second layer) ----------------
    // SVG is injected inline so its elements can be picked, which means it shares this
    // page's origin: a hostile file could read the annotation store or call the save
    // route. The filter therefore removes every known way to run script — not only
    // <script> and on* attributes, but also foreignObject, external hrefs and SMIL
    // nodes that can rewrite an attribute after this pass.
    const sanitizeSvg = (text) => {
      const parsed = new DOMParser().parseFromString(String(text || ''), 'image/svg+xml');
      if (!parsed || !parsed.documentElement || parsed.querySelector('parsererror')) return null;
      const root = parsed.documentElement;
      const dropTags = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'handler', 'audio', 'video'];
      for (const tag of dropTags) {
        for (const node of Array.from(root.getElementsByTagName(tag))) node.remove();
      }
      // External references would either execute or leak a request to a third party.
      const allowedHref = (value) => {
        const target = String(value || '').trim().toLowerCase();
        return target === '' || target.startsWith('#') || target.startsWith('data:image/');
      };
      const executable = /(?:javascript|vbscript|data:text\/html)/i;
      const rewrite = (node) => {
        for (const attribute of Array.from(node.attributes || [])) {
          const name = attribute.name.toLowerCase();
          const value = String(attribute.value || '');
          if (name.startsWith('on')) {
            node.removeAttribute(attribute.name);
            continue;
          }
          if ((name === 'href' || name === 'xlink:href' || name === 'src') && !allowedHref(value)) {
            node.removeAttribute(attribute.name);
            continue;
          }
          if (executable.test(value) && /^(href|xlink:href|src|style|values|to|from|attributeName)$/.test(name)) {
            node.removeAttribute(attribute.name);
          }
        }
        if (node.children && node.children.length) {
          for (const child of Array.from(node.children)) {
            const tag = String(child.localName || child.tagName || '').toLowerCase();
            // SMIL can retarget an attribute at runtime, which would defeat the pass
            // above: an <animate attributeName="href" values="javascript:..."> is the
            // classic bypass, so only keep animation of visual attributes.
            if (tag === 'set' || tag === 'animate') {
              const target = String(child.getAttribute('attributeName') || '').toLowerCase();
              if (!target || target.startsWith('on') || target === 'href' || target === 'xlink:href' || target === 'src') {
                child.remove();
                continue;
              }
            }
            rewrite(child);
          }
        }
      };
      rewrite(root);
      // A stylesheet can pull in a remote URL (@import) even with no other reference.
      for (const style of Array.from(root.getElementsByTagName('style'))) {
        const body = String(style.textContent || '');
        if (/@import|url\s*\(\s*['"]?\s*(?:https?:|javascript:|data:text)/i.test(body)) style.remove();
      }
      return root.outerHTML;
    };

    // The SVG runs inside the same sandboxed iframe as an HTML preview: it keeps the
    // picker, the dwell spotlight and the SMIL controls, but a hostile file can no
    // longer touch this page's origin, its annotation store or the save route.
    const buildSvgDocument = (markup) =>
      [
        '<!doctype html><html><head><meta charset="utf-8">',
        '<style>',
        'html,body{height:100%;margin:0;background:transparent}',
        'body{display:flex;align-items:center;justify-content:center;overflow:hidden}',
        'svg{max-width:100%;max-height:100%}',
        '</style></head><body>',
        markup,
        '</body></html>',
      ].join('');

    function SvgDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', error: '' });
      const [anim, setAnim] = React.useState({ paused: false, duration: 0, current: 0, count: 0 });
  // Whether the injected picker ever reported: a silent miss looks like a still
  // document, so it is tracked and surfaced instead.
  const [picker, setPicker] = React.useState('waiting');
      const frameRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const pausedRef = React.useRef(false);

      const post = (cmd, extra) => {
        const frame = frameRef.current;
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage(Object.assign({ source: 'dshcv-cmd', cmd }, extra || {}), '*');
      };

      // Rail hover spotlights the matching layer inside the sandbox.
      const hovered = useHoverMark(doc.path);
      const hoverSelector = hovered && hovered.kind === 'layer' ? hovered.selector || '' : '';
      React.useEffect(() => {
        if (state.status !== 'ready') return;
        post('spot', { selector: hoverSelector });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hoverSelector, state.status]);

      React.useEffect(() => {
        if (!sessionId) {
          setState({ status: 'idle', url: '', error: '等待会话…' });
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        let objectUrl = '';
        readTextPages(sessionId, doc.path, controller.signal)
          .then(async (page) => {
            let text = page.text;
            if (!text) {
              const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
              if (bytes) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            }
            if (cancelled) return;
            // The filter is defence in depth now, not the only boundary: the document
            // never runs in this origin even if a bypass exists.
            const markup = sanitizeSvg(text);
            if (!markup) {
              setState({ status: 'failed', url: '', error: '无法解析 SVG' });
              return;
            }
            const html = buildSvgDocument(markup);
            objectUrl = URL.createObjectURL(
              new Blob([injectScriptAllowed() ? injectPicker(html) : html], { type: 'text/html' }),
            );
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
            setPicker('ready');
            pausedRef.current = Boolean(data.state.paused);
            setAnim(data.state);
            return;
          }
          if (data.source !== 'dshcv-picker') return;
          // The iframe decides when picking is allowed (frozen, or nothing to
          // animate). Re-checking paused here silently dropped every click in a
          // still document.
          const target = String(data.selector || '');
          if (!target) return;
          addMark({ kind: 'layer', path: doc.path, selector: target, quote: String(data.tag || '') });
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [doc.path]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (!ownsKeyboard(event, rootRef.current)) return;
          if (event.altKey && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            post(pausedRef.current ? 'resume' : 'pause');
            return;
          }
          if (event.altKey && (event.key === 'a' || event.key === 'A' || event.key === 'd' || event.key === 'D')) {
            event.preventDefault();
            const forward = event.key === 'd' || event.key === 'D';
            post('pause');
            post('step', { dir: forward ? 1 : -1 });
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, []);

      React.useEffect(() => {
        if (state.status !== 'ready') return undefined;
        const timer = setTimeout(() => {
          setPicker((now) => (now === 'waiting' ? 'missing' : now));
        }, 1500);
        return () => clearTimeout(timer);
      }, [state.status]);

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该 SVG'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, state.status === 'loading' ? '解析中…' : '……'));
      }
      return h(
        'div',
        { ref: rootRef, style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        // A document that ships nothing animated needs no playback UI: the frame is
        // already still, so picking works directly.
        anim.count > 0
          ? h(AnimBar, {
            anim,
            onPause: () => post('pause'),
            onResume: () => post('resume'),
            onSeek: (time) => post('seek', { time }),
            onStep: (dir) => post('step', { dir }),
          })
          : null,
        picker === 'missing'
          ? h(
              'div',
              { className: 'dshcv-msg', style: { padding: '4px 2px 8px' } },
              '选择器未注入：右上角菜单里的「注入脚本」开关是关闭状态，打开后悬停元素才能选中。',
            )
          : null,
        h('iframe', {
          ref: frameRef,
          src: state.url,
          title: 'canvas svg preview',
          sandbox: 'allow-scripts',
          onLoad: () => post('state'),
          style: { flex: '1 1 auto', minHeight: 0, width: '100%', border: '0', background: 'transparent' },
        }),
      );
    }
    // Long parses yield to the event loop so the UI keeps painting, a cancel can
    // take effect, and progress can be reported.
    const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
    const checkAbort = (options) => {
      if (options && options.signal && options.signal.aborted) throw new Error('已取消');
    };
    const reportProgress = (options, fraction) => {
      if (options && typeof options.onProgress === 'function') options.onProgress(Math.max(0, Math.min(1, fraction)));
    };

    // ---------------- office documents: read the container, show the content ----------------
    // OOXML files are zip containers. Chromium ships DecompressionStream, so the
    // archive opens without a dependency and the XML is read with DOMParser.
    const openZip = async (bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let eocd = -1;
      const floor = Math.max(0, bytes.length - 66000);
      for (let index = bytes.length - 22; index >= floor; index -= 1) {
        if (view.getUint32(index, true) === 0x06054b50) {
          eocd = index;
          break;
        }
      }
      if (eocd < 0) throw new Error('不是有效的 zip 容器');
      const count = view.getUint16(eocd + 10, true);
      let cursor = view.getUint32(eocd + 16, true);
      const entries = [];
      for (let index = 0; index < count; index += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) break;
        const method = view.getUint16(cursor + 10, true);
        const compressed = view.getUint32(cursor + 20, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const offset = view.getUint32(cursor + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        entries.push({ name, method, compressed, offset });
        cursor += 46 + nameLength + extraLength + commentLength;
      }
      const read = async (entry) => {
        const nameLength = view.getUint16(entry.offset + 26, true);
        const extraLength = view.getUint16(entry.offset + 28, true);
        const dataStart = entry.offset + 30 + nameLength + extraLength;
        const data = bytes.subarray(dataStart, dataStart + entry.compressed);
        if (entry.method === 0) return data;
        if (typeof DecompressionStream !== 'function') throw new Error('当前运行时不支持解压 zip');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
      const text = async (name) => {
        const entry = entries.find((candidate) => candidate.name === name);
        if (!entry) return '';
        return new TextDecoder('utf-8', { fatal: false }).decode(await read(entry));
      };
      return { entries, read, text };
    };

    const parseXml = (source) => new DOMParser().parseFromString(String(source || ''), 'application/xml');
    const xmlText = (node) => (node ? node.textContent || '' : '');

    const docxToParagraphs = (xml) => {
      const doc = parseXml(xml);
      return Array.from(doc.getElementsByTagName('w:p')).map((paragraph) => {
        const pieces = Array.from(paragraph.getElementsByTagName('w:t')).map(xmlText);
        const tabs = paragraph.getElementsByTagName('w:tab').length;
        return pieces.join('') + (tabs ? '\t'.repeat(tabs) : '');
      });
    };

    const pptxToSlides = (zip) =>
      zip.entries
        .map((entry) => entry.name)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((left, right) => Number(left.replace(/\D+/g, '')) - Number(right.replace(/\D+/g, '')));

    const columnIndex = (reference) => {
      const letters = String(reference || '').replace(/[^A-Z]/g, '');
      let value = 0;
      for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
      return Math.max(0, value - 1);
    };

    const xlsxToSheets = async (zip) => {
      const sharedXml = await zip.text('xl/sharedStrings.xml');
      const shared = sharedXml
        ? Array.from(parseXml(sharedXml).getElementsByTagName('si')).map((item) =>
            Array.from(item.getElementsByTagName('t')).map(xmlText).join(''),
          )
        : [];
      let sheetNames = [];
      try {
        const workbook = parseXml(await zip.text('xl/workbook.xml'));
        sheetNames = Array.from(workbook.getElementsByTagName('sheet')).map((sheet) => sheet.getAttribute('name') || '');
      } catch {
        sheetNames = [];
      }
      const sheetEntries = zip.entries
        .map((entry) => entry.name)
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .sort((left, right) => Number(left.replace(/\D+/g, '')) - Number(right.replace(/\D+/g, '')))
        .slice(0, 3);
      const sheets = [];
      for (let index = 0; index < sheetEntries.length; index += 1) {
        const sheet = parseXml(await zip.text(sheetEntries[index]));
        const rows = [];
        const rowNodes = Array.from(sheet.getElementsByTagName('row')).slice(0, 300);
        for (const rowNode of rowNodes) {
          const cells = [];
          for (const cell of Array.from(rowNode.getElementsByTagName('c')).slice(0, 30)) {
            const reference = cell.getAttribute('r') || '';
            const type = cell.getAttribute('t');
            let value = '';
            if (type === 's') value = shared[Number(xmlText(cell.getElementsByTagName('v')[0]))] || '';
            else if (type === 'inlineStr') value = Array.from(cell.getElementsByTagName('t')).map(xmlText).join('');
            else value = xmlText(cell.getElementsByTagName('v')[0]);
            const at = reference ? columnIndex(reference) : cells.length;
            while (cells.length < at) cells.push('');
            cells[at] = value;
          }
          rows.push(cells);
        }
        sheets.push({ name: sheetNames[index] || '工作表 ' + (index + 1), rows });
      }
      return sheets;
    };

    const parseDelimited = (source, delimiter) => {
      const rows = [];
      let row = [];
      let field = '';
      let quoted = false;
      const text = String(source || '').replace(/\r\n/g, '\n');
      for (let index = 0; index < text.length && rows.length < 300; index += 1) {
        const character = text[index];
        if (quoted) {
          if (character === '"' && text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else if (character === '"') {
            quoted = false;
          } else {
            field += character;
          }
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === delimiter) {
          row.push(field);
          field = '';
        } else if (character === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else field += character;
      }
      if (field || row.length) {
        row.push(field);
        rows.push(row);
      }
      return rows;
    };

    function DataTable(props) {
      const { rows, caption, onPick, sheet, spot } = props;
      const body = rows.slice(0, 200);
      const width = body.reduce((widest, row) => Math.max(widest, row.length), 0);
      const columns = Array.from({ length: width }, (_, index) => index);
      const columnName = (index) => {
        let name = '';
        let value = index + 1;
        while (value > 0) {
          const remainder = (value - 1) % 26;
          name = String.fromCharCode(65 + remainder) + name;
          value = Math.floor((value - 1) / 26);
        }
        return name;
      };
      return h(
        'div',
        { className: 'dshcv-tablewrap', 'data-sheet': sheet || undefined },
        caption ? h('div', { className: 'dshcv-tcaption' }, caption) : null,
        h(
          'table',
          { className: 'dshcv-table' },
          h('thead', null, h('tr', null, columns.map((column) => h('th', { key: 'h' + column }, columnName(column))))),
          h(
            'tbody',
            null,
            body.map((row, rowIndex) =>
              h(
                'tr',
                { key: 'r' + rowIndex },
                columns.map((column) =>
                  h(
                    'td',
                    {
                      key: 'c' + column,
                      title: row[column] || '',
                      'data-row': rowIndex,
                      'data-col': column,
                      className: spot && spot.row === rowIndex && spot.column === column ? 'dshcv-spot' : undefined,
                      style: onPick ? { cursor: 'pointer' } : undefined,
                      onClick: onPick ? () => onPick(rowIndex, column, row[column] || '') : undefined,
                    },
                    row[column] || '',
                  ),
                ),
              ),
            ),
          ),
        ),
        rows.length > body.length ? h('div', { className: 'dshcv-tcaption' }, '仅显示前 ' + body.length + ' 行') : null,
      );
    }

    function OfficeDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', error: '', tables: [], slides: [], paragraphs: [], note: '' });
      const hoverSpot = useHoverMark(doc.path);
      const officeScrollRef = React.useRef(null);
      // Rail hover can bring the target into view; scrolling is not always wanted,
      // so it follows the persisted toggle.
      React.useEffect(() => {
        const host = officeScrollRef.current;
        if (!host || !hoverSpot || !followHoverOn()) return;
        let node = null;
        if (hoverSpot.kind === 'paragraph' && hoverSpot.paragraph) {
          node = host.querySelector('[data-para="' + hoverSpot.paragraph + '"]');
        } else if (hoverSpot.kind === 'spot' && typeof hoverSpot.slide === 'number') {
          node = host.querySelector('[data-slide="' + (hoverSpot.slide + 1) + '"]');
        } else if (hoverSpot.kind === 'spot' && typeof hoverSpot.row === 'number') {
          node =
            Array.from(host.querySelectorAll('[data-row][data-col]')).find(
              (cell) =>
                Number(cell.dataset.row) === hoverSpot.row &&
                Number(cell.dataset.col) === hoverSpot.column &&
                (!hoverSpot.sheet ||
                  (cell.closest('[data-sheet]') && cell.closest('[data-sheet]').dataset.sheet === hoverSpot.sheet)),
            ) || null;
        }
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hoverSpot && hoverSpot.id]);

      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', error: '', tables: [], slides: [], paragraphs: [], note: '' });
        const match = /\.([a-z0-9]+)$/i.exec(doc.path);
        const extension = match ? match[1].toLowerCase() : '';
        readBytesFile(sessionId, doc.path, controller.signal)
          .then(async (bytes) => {
            if (!bytes) throw new Error('读取不到文件内容');
            if (['doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(extension)) {
              throw new Error('旧版 Office / OpenDocument 暂不支持预览，请先另存为 .docx / .xlsx / .pptx');
            }
            const zip = await openZip(bytes);
            if (extension === 'docx') {
              const paragraphs = docxToParagraphs(await zip.text('word/document.xml'));
              if (cancelled) return;
              setState({ status: 'ready', error: '', tables: [], slides: [], paragraphs, note: paragraphs.length + ' 段' });
              return;
            }
            if (extension === 'pptx') {
              const slides = [];
              for (const name of pptxToSlides(zip).slice(0, 40)) {
                const xml = parseXml(await zip.text(name));
                const lines = Array.from(xml.getElementsByTagName('a:t')).map(xmlText).filter(Boolean);
                slides.push({ title: lines[0] || '', lines });
              }
              if (cancelled) return;
              setState({ status: 'ready', error: '', tables: [], slides, paragraphs: [], note: slides.length + ' 页' });
              return;
            }
            const tables = await xlsxToSheets(zip);
            if (cancelled) return;
            setState({ status: 'ready', error: '', tables, slides: [], paragraphs: [], note: tables.length + ' 个工作表' });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', error: errText(error), tables: [], slides: [], paragraphs: [], note: '' });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该文档'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '解析文档…'));
      }
      const body = [];
      if (state.paragraphs.length) {
        body.push(
          h(
            'div',
            { className: 'dshcv-doc' },
            state.paragraphs.map((line, index) =>
              h(
                'p',
                {
                  key: 'p' + index,
                  className:
                    (line.trim() ? 'dshcv-docp' : 'dshcv-docblank') +
                    (hoverSpot
                      ? hoverSpot.kind === 'paragraph' && hoverSpot.paragraph === index + 1
                        ? ' dshcv-spot'
                        : ' dshcv-dim'
                      : ''),
                  'data-para': index + 1,
                  title: line.trim() ? '点击标注这一段' : undefined,
                  onClick: line.trim()
                    ? () => addMark({ kind: 'paragraph', path: doc.path, paragraph: index + 1, quote: line.trim().slice(0, 240) })
                    : undefined,
                },
                line || '\u00a0',
              ),
            ),
          ),
        );
      }
      for (let index = 0; index < state.tables.length; index += 1) {
        const table = state.tables[index];
        body.push(
          h(DataTable, {
            key: 't' + index,
            rows: table.rows,
            caption: table.name,
            sheet: table.name,
            spot: hoverSpot && hoverSpot.kind === 'spot' && hoverSpot.sheet === table.name ? hoverSpot : null,
            onPick: (rowIndex, column, value) =>
              addMark({
                kind: 'spot',
                path: doc.path,
                label: table.name + ' · ' + String.fromCharCode(65 + Math.min(25, column)) + (rowIndex + 1),
                quote: String(value || '').slice(0, 200),
                sheet: table.name,
                row: rowIndex,
                column,
              }),
          }),
        );
      }
      for (let index = 0; index < state.slides.length; index += 1) {
        const slide = state.slides[index];
        body.push(
          h(
            'div',
            {
              key: 's' + index,
              className:
                'dshcv-slide dshcv-docp' +
                (hoverSpot && hoverSpot.kind === 'spot'
                  ? hoverSpot.slide === index
                    ? ' dshcv-spot'
                    : ' dshcv-dim'
                  : ''),
              'data-slide': index + 1,
              title: '点击标注这一页',
              onClick: () =>
                addMark({
                  kind: 'spot',
                  path: doc.path,
                  label: '第 ' + (index + 1) + ' 页',
                  quote: (slide.title || slide.lines[0] || '').slice(0, 200),
                  slide: index,
                }),
            },
            h('div', { className: 'dshcv-slidehead' }, '第 ' + (index + 1) + ' 页' + (slide.title ? ' · ' + slide.title : '')),
            slide.lines.map((line, lineIndex) => h('p', { key: 'l' + lineIndex }, line)),
          ),
        );
      }
      return h(
        'div',
        { className: 'dshcv-docwrap', ref: officeScrollRef },
        h('div', { className: 'dshcv-tools' }, h('span', { className: 'dshcv-msg' }, state.note || '已解析')),
        ...body,
      );
    }

    function SheetDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', error: '', rows: [] });
      const hoverSpot = useHoverMark(doc.path);
      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        readTextPages(sessionId, doc.path, controller.signal)
          .then((page) => {
            if (cancelled) return;
            const delimiter = /\.tsv$/i.test(doc.path) ? '\t' : ',';
            setState({ status: 'ready', error: '', rows: parseDelimited(page.text, delimiter) });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', error: errText(error), rows: [] });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);
      if (state.status === 'failed') return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取表格'), h('div', null, state.error));
      if (state.status !== 'ready') return h('div', { className: 'dshcv-empty' }, h('div', null, '读取中…'));
      return h(
        'div',
        { className: 'dshcv-docwrap' },
        h(DataTable, {
          rows: state.rows,
          caption: state.rows.length + ' 行',
          spot: hoverSpot && hoverSpot.kind === 'spot' && hoverSpot.sheet === undefined ? hoverSpot : null,
          onPick: (rowIndex, column, value) =>
            addMark({
              kind: 'spot',
              path: doc.path,
              label: String.fromCharCode(65 + Math.min(25, column)) + (rowIndex + 1),
              quote: String(value || '').slice(0, 200),
              row: rowIndex,
              column,
            }),
        }),
      );
    }

    // ---------------- pdf viewer (own renderer) ----------------
    // The built-in reader lives in a plugin process: no geometry, no events. pdf.js is
    // vendored and served from /dsh-canvas/vendor/pdfjs, so the page is a canvas we lay
    // out ourselves and a region is a fraction of the real page.
    let pdfjsPromise = null;
    // Preferred: the prefix route, which is also what pdf.js joins cmap and font names
    // onto. Fallback: the exact route with ?f=, for a host that does not match wildcards.
    const VENDOR_PREFIX = '/dsh-canvas/vendor/pdfjs/';
    const VENDOR_EXACT = '/dsh-canvas/vendor?f=';
    let vendorShape = 'prefix';

    const vendorUrl = (name, shape) =>
      shape === 'exact' ? VENDOR_EXACT + encodeURIComponent(name) : VENDOR_PREFIX + name;

    const loadPdfJs = () => {
      if (pdfjsPromise) return pdfjsPromise;
      const attempt = (shape) =>
        import(vendorUrl('pdf.min.mjs', shape)).then((mod) => {
          vendorShape = shape;
          mod.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs', shape);
          return mod;
        });
      pdfjsPromise = attempt('prefix').catch(() => attempt('exact'));
      return pdfjsPromise;
    };

    // Text of a page, cached: search and the text layer both want it.
    const pageTextCache = new Map();
    const textContentOf = async (pdf, pageNumber) => {
      const key = (pdf.fingerprints && pdf.fingerprints[0] ? pdf.fingerprints[0] : 'doc') + ':' + pageNumber;
      if (pageTextCache.has(key)) return pageTextCache.get(key);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTextCache.set(key, content);
      return content;
    };

    // One page: canvas, text layer, mark overlays. Rendered only when near the viewport.
    function PdfPage(props) {
      const {
        pdf,
        pageNumber,
        scale,
        markMode,
        onRegion,
        onSelect,
        onVisible,
        registerEl,
        pageHits,
        activeHit,
        pageMarks,
        hoverBands,
        hoverRect,
        pdfjs,
      } = props;
      const [size, setSize] = React.useState({ width: 0, height: 0 });
      const [items, setItems] = React.useState([]);
      const [visible, setVisible] = React.useState(pageNumber === 1);
      const [drag, setDrag] = React.useState(null);
      const canvasRef = React.useRef(null);
      const wrapRef = React.useRef(null);
      const pressRef = React.useRef(null);
      const tokenRef = React.useRef(0);

      React.useEffect(() => {
        if (registerEl) registerEl(pageNumber, wrapRef.current);
        return () => {
          if (registerEl) registerEl(pageNumber, null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageNumber]);

      // Render only what is close to the viewport.
      React.useEffect(() => {
        const node = wrapRef.current;
        if (!node || typeof IntersectionObserver !== 'function') {
          setVisible(true);
          return undefined;
        }
        const observer = new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (!entry) return;
            if (entry.isIntersecting) setVisible(true);
            if (entry.isIntersecting && onVisible) onVisible(pageNumber, entry.intersectionRatio);
          },
          { rootMargin: '600px 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageNumber]);

      React.useEffect(() => {
        if (!visible || !pdf) return undefined;
        const token = tokenRef.current + 1;
        tokenRef.current = token;
        let cancelled = false;
        (async () => {
          const page = await pdf.getPage(pageNumber);
          if (cancelled || tokenRef.current !== token) return;
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ratio = Math.min(3, window.devicePixelRatio || 1);
          canvas.width = Math.round(viewport.width * ratio);
          canvas.height = Math.round(viewport.height * ratio);
          canvas.style.width = viewport.width + 'px';
          canvas.style.height = viewport.height + 'px';
          const context = canvas.getContext('2d');
          if (!context) return;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          context.clearRect(0, 0, viewport.width, viewport.height);
          await page.render({ canvasContext: context, viewport }).promise;
          if (cancelled || tokenRef.current !== token) return;
          setSize({ width: viewport.width, height: viewport.height });
          const content = await textContentOf(pdf, pageNumber);
          if (cancelled || tokenRef.current !== token) return;
          const Util = pdfjs && pdfjs.Util;
          if (!Util) {
            setItems([]);
            return;
          }
          const spans = [];
          for (const item of content.items || []) {
            if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
            const transform = Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(transform[2], transform[3]);
            if (!fontHeight) continue;
            spans.push({
              str: item.str,
              left: transform[4],
              top: transform[5] - fontHeight,
              fontHeight,
              width: Math.max(0, Number(item.width) || 0) * viewport.scale,
            });
          }
          setItems(spans);
        })().catch(() => setItems([]));
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible, pageNumber, scale, pdf]);

      const toFraction = (event) => {
        const wrap = wrapRef.current;
        if (!wrap) return null;
        const rect = wrap.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
      };

      const onDown = (event) => {
        if (event.button !== 0) return;
        const at = toFraction(event);
        if (!at) return;
        event.preventDefault();
        pressRef.current = at;
        setDrag({ from: at, to: at });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* best effort */
        }
      };
      const onMove = (event) => {
        if (!pressRef.current) return;
        const at = toFraction(event);
        if (!at) return;
        setDrag({ from: pressRef.current, to: at });
      };
      const onUp = (event) => {
        const from = pressRef.current;
        pressRef.current = null;
        const box = drag;
        setDrag(null);
        if (!from || !box) return;
        const at = toFraction(event) || box.to;
        const x = Math.min(from.x, at.x);
        const y = Math.min(from.y, at.y);
        const w = Math.abs(at.x - from.x);
        const h = Math.abs(at.y - from.y);
        if (w * h < 0.0004) return;
        if (onRegion) onRegion(pageNumber, [x, y, w, h]);
      };

      // Every line fragment gets its own band, so a mark hugs the text instead of
      // drawing one box around the whole selection.
      const readSelection = () => {
        const wrap = wrapRef.current;
        const active = window.getSelection ? window.getSelection() : null;
        if (!wrap || !active || active.isCollapsed) return;
        const text = String(active.toString() || "").replace(/\s+$/g, "");
        if (!text.trim()) return;
        const box = wrap.getBoundingClientRect();
        const fragments = Array.from(active.getRangeAt(0).getClientRects()).filter(
          (item) => item.width > 1 && item.height > 1,
        );
        if (!fragments.length) return;
        const bands = fragments
          .map((item) => [
            (item.left - box.left) / box.width,
            (item.top - box.top) / box.height,
            item.width / box.width,
            item.height / box.height,
          ])
          .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        const left = Math.min(...bands.map((item) => item[0]));
        const top = Math.min(...bands.map((item) => item[1]));
        const right = Math.max(...bands.map((item) => item[0] + item[2]));
        const bottom = Math.max(...bands.map((item) => item[1] + item[3]));
        if (right <= left || bottom <= top) return;
        if (onSelect) {
          onSelect(
            pageNumber,
            [left, top, right - left, bottom - top],
            bands.map((item) => item.map((value) => Math.round(value * 10000) / 10000)),
            text,
          );
        }
      };

      return h(
        'div',
        {
          ref: wrapRef,
          className: 'dshcv-pdfpagebox',
          style: size.width ? { width: size.width + 'px', height: size.height + 'px' } : null,
          'data-page': pageNumber,
        },
        h('canvas', { ref: canvasRef, className: 'dshcv-pdfcanvas' }),
        h(
          'div',
          { className: 'dshcv-pdftext', onMouseUp: readSelection },
          items.map((item, index) =>
            h(
              'span',
              {
                key: index,
                style: {
                  left: item.left + 'px',
                  top: item.top + 'px',
                  fontSize: item.fontHeight + 'px',
                  width: item.width ? item.width + 'px' : undefined,
                  display: 'block',
                  overflow: 'hidden',
                },
              },
              item.str,
            ),
          ),
        ),
        pageHits.map((hit, index) =>
          h('div', {
            key: 'hit' + index,
            className: 'dshcv-pdfhit',
            'data-active': activeHit && activeHit.page === pageNumber && activeHit.index === hit.index ? '1' : '0',
            style: {
              left: hit.rect[0] * 100 + '%',
              top: hit.rect[1] * 100 + '%',
              width: hit.rect[2] * 100 + '%',
              height: hit.rect[3] * 100 + '%',
            },
          }),
        ),
        pageMarks.map((mark, index) =>
          mark.text && Array.isArray(mark.bands)
            ? mark.bands.map((band, bandIndex) =>
                h("div", {
                  key: "band" + index + "-" + bandIndex,
                  className: "dshcv-pdftexthit",
                  style: {
                    left: band[0] * 100 + "%",
                    top: band[1] * 100 + "%",
                    width: band[2] * 100 + "%",
                    height: band[3] * 100 + "%",
                  },
                }),
              )
            : h("div", {
                key: "mark" + index,
                className: "dshcv-pdfregion",
                style: {
                  left: mark.rect[0] * 100 + "%",
                  top: mark.rect[1] * 100 + "%",
                  width: mark.rect[2] * 100 + "%",
                  height: mark.rect[3] * 100 + "%",
                },
              }),
        ),
        hoverBands && hoverBands.length
          ? hoverBands.map((band, bandIndex) =>
              h("div", {
                key: "hover" + bandIndex,
                className: "dshcv-pdftexthit dshcv-pdftexthit-hot",
                style: {
                  left: band[0] * 100 + "%",
                  top: band[1] * 100 + "%",
                  width: band[2] * 100 + "%",
                  height: band[3] * 100 + "%",
                },
              }),
            )
          : hoverRect
            ? h("div", {
                className: "dshcv-pdfregion dshcv-pdfregion-hot",
                style: {
                  left: hoverRect[0] * 100 + "%",
                  top: hoverRect[1] * 100 + "%",
                  width: hoverRect[2] * 100 + "%",
                  height: hoverRect[3] * 100 + "%",
                },
              })
            : null,
        drag
          ? h('div', {
              className: 'dshcv-pdfmarquee',
              style: {
                left: Math.min(drag.from.x, drag.to.x) * 100 + '%',
                top: Math.min(drag.from.y, drag.to.y) * 100 + '%',
                width: Math.abs(drag.to.x - drag.from.x) * 100 + '%',
                height: Math.abs(drag.to.y - drag.from.y) * 100 + '%',
              },
            })
          : null,
        h('div', {
          className: markMode ? 'dshcv-pdflayer dshcv-pdflayer-on' : 'dshcv-pdflayer',
          style: { pointerEvents: markMode ? 'auto' : 'none' },
          onPointerDown: onDown,
          onPointerMove: onMove,
          onPointerUp: onUp,
          onPointerCancel: onUp,
        }),
      );
    }

    // Sidebar thumbnail: drawn lazily, one small canvas per page.
    function PdfThumb(props) {
      const { pdf, pageNumber, current, onPick, width } = props;
      const canvasRef = React.useRef(null);
      const [drawn, setDrawn] = React.useState(false);
      React.useEffect(() => {
        if (drawn || !pdf) return undefined;
        let cancelled = false;
        (async () => {
          const page = await pdf.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          const ratio = Math.min(2, window.devicePixelRatio || 1);
          canvas.width = Math.round(viewport.width * ratio);
          canvas.height = Math.round(viewport.height * ratio);
          canvas.style.width = viewport.width + 'px';
          canvas.style.height = viewport.height + 'px';
          const context = canvas.getContext('2d');
          if (!context) return;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          await page.render({ canvasContext: context, viewport }).promise;
          if (!cancelled) setDrawn(true);
        })().catch(() => {});
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageNumber, pdf, width]);
      return h(
        'button',
        {
          type: 'button',
          className: 'dshcv-pdfthumb' + (current ? ' dshcv-pdfthumb-on' : ''),
          title: '第 ' + pageNumber + ' 页',
          onClick: () => onPick(pageNumber),
        },
        h('canvas', { ref: canvasRef }),
        h('span', { className: 'dshcv-pdfthumbnum' }, String(pageNumber)),
      );
    }

    function PdfCanvasDoc(props) {
      const { doc, sessionId, onFail } = props;
      const [state, setState] = React.useState({ status: 'loading', error: '', pages: 0 });
      const [zoom, setZoom] = React.useState(1);
      const [markMode, setMarkMode] = React.useState(false);
      const [current, setCurrent] = React.useState(1);
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState([]);
      const [hitIndex, setHitIndex] = React.useState(0);
      const [selection, setSelection] = React.useState(null);
      const [width, setWidth] = React.useState(760);
      const [searching, setSearching] = React.useState(false);
      const docRef = React.useRef(null);
      const pdfjsRef = React.useRef(null);
      const scrollRef = React.useRef(null);
      const boxRef = React.useRef(null);
      const pageEls = React.useRef(new Map());
      const hovered = useHoverMark(doc.path);
      const marks = store.marks || [];
      const pageMarksFor = (pageNumber) =>
        marks.filter(
          (mark) => mark.kind === 'region' && mark.norm && sameFile(mark.path, doc.path) && Number(mark.page) === pageNumber,
        );
      const hoverMark =
        hovered && hovered.kind === 'region' && hovered.norm && sameFile(hovered.path, doc.path) ? hovered : null;

      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        let task = null;
        setState({ status: 'loading', error: '', pages: 0 });
        Promise.all([loadPdfJs(), readBytesFile(sessionId, doc.path, controller.signal)])
          .then(async ([pdfjs, bytes]) => {
            if (cancelled || !bytes) return;
            pdfjsRef.current = pdfjs;
            task = pdfjs.getDocument({
              cMapUrl: vendorShape === 'prefix' ? VENDOR_PREFIX + 'cmaps/' : undefined,
              cMapPacked: vendorShape === 'prefix',
              standardFontDataUrl: vendorShape === 'prefix' ? VENDOR_PREFIX + 'standard_fonts/' : undefined,
              data: bytes,
            });
            const loaded = await task.promise;
            if (cancelled) return;
            docRef.current = loaded;
            setState({ status: 'ready', error: '', pages: loaded.numPages });
          })
          .catch((error) => {
            if (cancelled) return;
            if (onFail) onFail(errText(error));
            else setState({ status: 'failed', error: errText(error), pages: 0 });
          });
        return () => {
          cancelled = true;
          controller.abort();
          // destroy() lives on the loading task in some builds and on the document in
          // others; call whichever exists and never let cleanup throw.
          const done = (value) => {
            if (value && typeof value.catch === 'function') value.catch(() => {});
          };
          try {
            if (task && typeof task.destroy === 'function') done(task.destroy());
            else if (docRef.current && typeof docRef.current.destroy === 'function') done(docRef.current.destroy());
          } catch (error) {
            /* cleanup is best effort */
          }
          docRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc.path, sessionId]);

      // Column width drives the render scale; a stale number costs sharpness only.
      React.useEffect(() => {
        const node = boxRef.current;
        if (!node) return undefined;
        const measure = () => setWidth(Math.max(280, (node.clientWidth || 760) - 48));
        measure();
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure);
          observer.observe(node);
        } else {
          window.addEventListener('resize', measure);
        }
        return () => {
          if (observer) observer.disconnect();
          else window.removeEventListener('resize', measure);
        };
      }, [state.status]);

      const registerEl = (pageNumber, node) => {
        if (node) pageEls.current.set(pageNumber, node);
        else pageEls.current.delete(pageNumber);
      };

      const scrollToPage = (pageNumber) => {
        const node = pageEls.current.get(pageNumber);
        if (node && node.scrollIntoView) {
          node.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        const scroller = scrollRef.current;
        if (scroller) scroller.scrollTop = (pageNumber - 1) * 400;
      };

      const onVisible = (pageNumber, ratio) => {
        if (ratio > 0.35) setCurrent((now) => (now === pageNumber ? now : pageNumber));
      };

      const search = async () => {
        const pdf = docRef.current;
        const term = query.trim();
        if (!pdf || !term) {
          setHits([]);
          setHitIndex(0);
          return;
        }
        setSearching(true);
        const needle = term.toLowerCase();
        const found = [];
        const total = pdf.numPages;
        try {
          for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
            const content = await textContentOf(pdf, pageNumber);
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const Util = pdfjsRef.current && pdfjsRef.current.Util;
            if (!Util) break;
            for (const item of content.items || []) {
              if (!item || typeof item.str !== 'string') continue;
              if (!item.str.toLowerCase().includes(needle)) continue;
              const transform = Util.transform(viewport.transform, item.transform);
              const height = Math.hypot(transform[2], transform[3]);
              if (!height) continue;
              const boxWidth = Math.max(1, Number(item.width) || 0);
              found.push({
                page: pageNumber,
                index: found.length,
                text: item.str,
                rect: [
                  transform[4] / viewport.width,
                  (transform[5] - height) / viewport.height,
                  boxWidth / viewport.width,
                  height / viewport.height,
                ],
              });
            }
          }
          setHits(found);
          setHitIndex(0);
          if (found.length) scrollToPage(found[0].page);
        } finally {
          setSearching(false);
        }
      };

      const gotoHit = (next) => {
        if (!hits.length) return;
        const index = (next + hits.length) % hits.length;
        setHitIndex(index);
        scrollToPage(hits[index].page);
      };

      const onRegion = (pageNumber, rect) => {
        addMark({
          kind: 'region',
          path: doc.path,
          page: pageNumber,
          norm: true,
          rect: rect.map((value) => Math.round(value * 10000) / 10000),
          quote: '第 ' + pageNumber + ' 页区域',
        });
      };

      const onSelect = (pageNumber, rect, bands, text) => {
        setSelection({ page: pageNumber, rect, bands, text });
      };

      const markSelection = () => {
        if (!selection) return;
        addMark({
          kind: 'region',
          path: doc.path,
          page: selection.page,
        bands: selection.bands,
          norm: true,
          text: true,
          rect: selection.rect.map((value) => Math.round(value * 10000) / 10000),
          quote: selection.text,
        });
        setSelection(null);
      };

      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法渲染该 PDF'), h('div', null, state.error));
      }

      const pages = state.pages || 0;
      const pdf = docRef.current;
      const pagesOfHits = new Map();
      for (const hit of hits) {
        if (!pagesOfHits.has(hit.page)) pagesOfHits.set(hit.page, []);
        pagesOfHits.get(hit.page).push(hit);
      }
      const activeHit = hits[hitIndex] || null;

      return h(
        'div',
        { className: 'dshcv-docwrap', style: { minHeight: 0 } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h('span', { className: 'dshcv-msg' }, '第 ' + current + ' / ' + (pages || '…') + ' 页'),
          h('button', { type: 'button', className: 'dshcv-btn', title: '缩小', onClick: () => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 100) / 100)) }, '−'),
          h('button', { type: 'button', className: 'dshcv-btn', title: '放大', onClick: () => setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100)) }, '+'),
          h('input', {
            type: 'search',
            className: 'dshcv-searchinput',
            placeholder: '搜索全文…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              search();
            },
            style: { width: '150px' },
          }),
          h('button', { type: 'button', className: 'dshcv-btn', disabled: searching, onClick: search }, searching ? '搜索中…' : '搜索'),
          hits.length
            ? h(
                'span',
                { className: 'dshcv-msg' },
                hits.length + ' 处 · 第 ' + (hitIndex + 1) + ' 处',
                h('button', { type: 'button', className: 'dshcv-btn', onClick: () => gotoHit(hitIndex - 1) }, '上一个'),
                h('button', { type: 'button', className: 'dshcv-btn', onClick: () => gotoHit(hitIndex + 1) }, '下一个'),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': 'primary',
              onClick: () =>
                addMark({ kind: 'spot', path: doc.path, label: '第 ' + current + ' 页', quote: '', page: current }),
            },
            '标记此页',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': markMode ? 'primary' : 'quiet',
              'aria-pressed': markMode,
              title: markMode ? '退出框选' : '在页面上拖出一块区域并标注',
              onClick: () => setMarkMode((on) => !on),
            },
            markMode ? '退出框选' : '框选标注',
          ),
          selection
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': 'primary',
                  title: '把选中的文字标注下来（引用原文）',
                  onClick: markSelection,
                },
                '标注选中文字',
              )
            : null,
        ),
        h(
          'div',
          { className: 'dshcv-pdfmain' },
          h(
            'div',
            { className: 'dshcv-pdfthumbs' },
            pages
              ? Array.from({ length: pages }, (item, index) =>
                  h(PdfThumb, {
                    key: index + 1,
                    pdf,
                    pageNumber: index + 1,
                    current: current === index + 1,
                    width: 104,
                    onPick: scrollToPage,
                  }),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dshcv-pdfpages', ref: scrollRef },
            h(
              'div',
              { className: 'dshcv-pdfcolumn', ref: boxRef },
              pages
                ? Array.from({ length: pages }, (item, index) => {
                    const pageNumber = index + 1;
                    const hit = activeHit && activeHit.page === pageNumber ? activeHit : null;
                    return h(PdfPage, {
                      key: pageNumber,
                      pdf,
                      pdfjs: pdfjsRef.current,
                      pageNumber,
                      scale: zoom,
                      markMode,
                      onRegion,
                      onSelect,
                      onVisible,
                      registerEl,
                      pageHits: pagesOfHits.get(pageNumber) || [],
                      activeHit: hit,
                      pageMarks: pageMarksFor(pageNumber),
                      hoverBands:
                        hoverMark && Number(hoverMark.page) === pageNumber && Array.isArray(hoverMark.bands)
                          ? hoverMark.bands
                          : null,
                      hoverRect:
                        hoverMark && Number(hoverMark.page) === pageNumber && Array.isArray(hoverMark.rect)
                          ? hoverMark.rect
                          : null,
                    });
                  })
                : h('div', { className: 'dshcv-empty' }, h('div', null, '读取中…')),
            ),
          ),
        ),
        markMode
          ? h('div', { className: 'dshcv-msg', style: { paddingTop: 4 } }, '拖出一块区域即可标注；坐标按页面计算')
          : null,
      );
    }

    // Falls back to the embedded reader if pdf.js cannot load, so a broken vendor
    // tree never means "no PDF at all".
    function PdfDoc(props) {
      const [fallback, setFallback] = React.useState('');
      // Say why the renderer is off instead of silently looking identical to the old
      // behaviour: "route not loaded" and "import blocked" need different fixes.
      if (fallback) {
        return h(
          'div',
          { className: 'dshcv-docwrap', style: { minHeight: 0 } },
          h('div', { className: 'dshcv-msg', style: { padding: '4px 2px 8px' } }, '已回退到系统阅读器：' + fallback),
          h(EmbeddedPdfDoc, props),
        );
      }
      return h(PdfCanvasDoc, Object.assign({}, props, { onFail: (error) => setFallback(error || 'pdf.js 不可用') }));
    }

    function EmbeddedPdfDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', size: 0, error: '', pages: 0, aspect: 0 });
      const [page, setPage] = React.useState(1);
      // The embedded PDF runs in a plugin process, so its clicks never reach us.
      // A capture layer over it, switched on demand, is how a region gets picked.
      const [markMode, setMarkMode] = React.useState(false);
      const [drag, setDrag] = React.useState(null);
      const pdfRef = React.useRef(null);
      const pageRef = React.useRef(null);
      const layerRef = React.useRef(null);
      const pressRef = React.useRef(null);
      const hovered = useHoverMark(doc.path);
      const hoverRegion =
        hovered &&
        hovered.kind === 'region' &&
        hovered.norm &&
        Array.isArray(hovered.rect) &&
        hovered.page === page
          ? hovered.rect
          : null;
      const hoverPage =
        hovered && hovered.kind === 'region' && hovered.norm && hovered.page !== page ? hovered.page : 0;

      // Ratios are taken against the page box, not the viewer: the page keeps its
      // aspect and is letterboxed, so viewer fractions drift when the pane resizes.
      const ratioOf = (event) => {
        const page = pageRef.current;
        if (!page) return null;
        const rect = page.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
      };

      const onLayerDown = (event) => {
        if (event.button !== 0) return;
        const at = ratioOf(event);
        if (!at) return;
        event.preventDefault();
        pressRef.current = at;
        setDrag({ from: at, to: at });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* capture is a nicety */
        }
      };

      const onLayerMove = (event) => {
        if (!pressRef.current) return;
        const at = ratioOf(event);
        if (!at) return;
        setDrag({ from: pressRef.current, to: at });
      };

      const onLayerUp = (event) => {
        const from = pressRef.current;
        pressRef.current = null;
        const box = drag;
        setDrag(null);
        if (!from || !box) return;
        const at = ratioOf(event) || box.to;
        const x = Math.min(from.x, at.x);
        const y = Math.min(from.y, at.y);
        const w = Math.abs(at.x - from.x);
        const h = Math.abs(at.y - from.y);
        // A stray click is not a region.
        if (w * h < 0.0008) return;
        addMark({
          kind: 'region',
          path: doc.path,
          page,
          norm: true,
          rect: [
            Math.round(x * 10000) / 10000,
            Math.round(y * 10000) / 10000,
            Math.round(w * 10000) / 10000,
            Math.round(h * 10000) / 10000,
          ],
          quote: '第 ' + page + ' 页区域',
        });
      };
      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        let objectUrl = '';
        readBytesFile(sessionId, doc.path, controller.signal)
          .then((bytes) => {
            if (cancelled || !bytes) return;
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            // Page objects are usually plain text in the file, which is enough to
            // offer page-numbered annotations without shipping a full renderer.
            const raw = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, 8 * 1024 * 1024)));
            const found = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;

            // The page aspect decides where the page actually sits inside the viewer,
            // which is what keeps a stored region in place when the pane is resized.
            const mediaBox = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(raw);
            const mediaAspect = mediaBox
              ? (() => {
                  const width = Number(mediaBox[3]) - Number(mediaBox[1]);
                  const height = Number(mediaBox[4]) - Number(mediaBox[2]);
                  return width > 0 && height > 0 ? width / height : 0;
                })()
              : 0;
            setState({ status: 'ready', url: objectUrl, size: bytes.length, error: '', pages: found, aspect: mediaAspect });
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'failed', url: '', size: 0, error: errText(error) });
          });
        return () => {
          cancelled = true;
          controller.abort();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
      }, [doc.path, sessionId]);
      if (state.status === 'failed') return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取 PDF'), h('div', null, state.error));
      if (state.status !== 'ready') return h('div', { className: 'dshcv-empty' }, h('div', null, '读取中…'));
      if (navigator.pdfViewerEnabled === false) {
        return h(
          'div',
          { className: 'dshcv-empty' },
          h('div', null, '当前运行时不支持内置 PDF 预览'),
          h('div', null, '文件已读取（' + Math.round(state.size / 1024) + ' KB），可用系统阅读器打开：'),
          h('code', null, doc.path),
        );
      }
      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h(
            'span',
            { className: 'dshcv-msg' },
            Math.round(state.size / 1024) + ' KB · ' + (state.pages ? '共 ' + state.pages + ' 页' : '页数未知（压缩流）'),
          ),
          h('input', {
            type: 'number',
            min: 1,
            max: state.pages || 9999,
            value: page,
            title: '页码',
            style: { width: '58px' },
            className: 'dshcv-searchinput',
            onChange: (event) => setPage(Math.max(1, Math.min(Number(event.target.value) || 1, state.pages || 9999))),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': 'primary',
              onClick: () =>
                addMark({ kind: 'spot', path: doc.path, label: '第 ' + page + ' 页', quote: '', page }),
            },
            '标记此页',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              onClick: () => addMark({ kind: 'spot', path: doc.path, label: '整份 PDF', quote: '' }),
            },
            '标记整份文档',
          ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': markMode ? 'primary' : 'quiet',
                  'aria-pressed': markMode,
                  title: markMode ? '退出框选，恢复滚动' : '在页面上拖出一块区域并标注',
                  onClick: () => {
                    setMarkMode((on) => !on);
                    setDrag(null);
                    pressRef.current = null;
                  },
                },
                markMode ? '退出框选' : '框选标注',
              ),
        ),
        h(
          'div',
          {
            style: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' },
          },
          h(
            FitStage,
            { enabled: props.fit, designWidth: 900 },
            h(
              'div',
              {
                ref: pageRef,
                className: 'dshcv-pdfpage',
                style: state.aspect
                  ? { top: 0, left: 0, width: "100%", aspectRatio: String(state.aspect) }
                  : { inset: 0 },
              },
              h('iframe', {
                ref: pdfRef,
                title: 'canvas pdf preview',
                src: state.url,
                style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: '0', background: '#fff' },
              }),
              hoverRegion
                ? h('div', {
                  className: 'dshcv-pdfregion',
                  style: {
                    left: hoverRegion[0] * 100 + '%',
                    top: hoverRegion[1] * 100 + '%',
                    width: hoverRegion[2] * 100 + '%',
                    height: hoverRegion[3] * 100 + '%',
                  },
                })
                : null,
              drag
                ? h('div', {
                  className: 'dshcv-pdfmarquee',
                  style: {
                    left: Math.min(drag.from.x, drag.to.x) * 100 + '%',
                    top: Math.min(drag.from.y, drag.to.y) * 100 + '%',
                    width: Math.abs(drag.to.x - drag.from.x) * 100 + '%',
                    height: Math.abs(drag.to.y - drag.from.y) * 100 + '%',
                  },
                })
                : null,
              h('div', {
                ref: layerRef,
                className: markMode ? 'dshcv-pdflayer dshcv-pdflayer-on' : 'dshcv-pdflayer',
                style: { pointerEvents: markMode ? 'auto' : 'none' },
                onPointerDown: onLayerDown,
                onPointerMove: onLayerMove,
                onPointerUp: onLayerUp,
                onPointerCancel: onLayerUp,
              }),
            ),
          ),
          markMode
            ? h(
              'div',
              { className: 'dshcv-msg', style: { position: 'absolute', left: 10, bottom: 8, padding: '2px 8px', background: 'rgba(0,0,0,.55)', color: '#fff', borderRadius: 6 } },
              '拖出一块区域即可标注；框选期间滚轮不可用，再点一次按钮退出' +
                (hoverPage ? '（当前页 ' + page + '，该标注在第 ' + hoverPage + ' 页）' : ''),
            )
            : null,
        ),
      );
    }

    // ---------------- design files ----------------
    // PSD: read the flattened composite at the end of the file (raw or RLE), so a
    // quick look works without a full layer engine. .sketch / .xd are zip+JSON,
    // so their structure and copy can be listed. A .ai that carries a PDF
    // compatibility stream opens in the PDF viewer.
    const unpackBits = (data, offset, expected) => {
      const out = new Uint8Array(expected);
      let written = 0;
      let cursor = offset;
      while (written < expected && cursor < data.length) {
        const header = data[cursor];
        cursor += 1;
        if (header < 128) {
          const count = header + 1;
          for (let index = 0; index < count && written < expected; index += 1) out[written++] = data[cursor + index];
          cursor += count;
        } else if (header > 128) {
          const count = 257 - header;
          const value = data[cursor];
          cursor += 1;
          for (let index = 0; index < count && written < expected; index += 1) out[written++] = value;
        }
      }
      return out;
    };

    const parsePsd = async (bytes, options) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 26 || view.getUint32(0, false) !== 0x38425053) throw new Error('不是有效的 PSD 文件');
      const channels = view.getUint16(12, false);
      const height = view.getUint32(14, false);
      const width = view.getUint32(18, false);
      const depth = view.getUint16(22, false);
      const mode = view.getUint16(24, false);
      if (depth !== 8) throw new Error('仅支持 8 位/通道的 PSD（当前 ' + depth + ' 位）');
      if (![1, 3].includes(mode)) throw new Error('仅支持 RGB / 灰度 PSD（当前色彩模式 ' + mode + '）');
      if (width * height > 40e6) {
        throw new Error('PSD 尺寸 ' + width + '×' + height + ' 过大（超过 4000 万像素），请先缩小后再导出');
      }
      let offset = 26;
      offset += 4 + view.getUint32(offset, false);
      offset += 4 + view.getUint32(offset, false);
      offset += 4 + view.getUint32(offset, false);
      const compression = view.getUint16(offset, false);
      offset += 2;
      const plane = width * height;
      const planes = [];
      if (compression === 0) {
        for (let channel = 0; channel < channels; channel += 1) {
          planes.push(bytes.subarray(offset + channel * plane, offset + channel * plane + plane));
        }
      } else if (compression === 1) {
        const rows = height * channels;
        const counts = [];
        for (let row = 0; row < rows; row += 1) counts.push(view.getUint16(offset + row * 2, false));
        let cursor = offset + rows * 2;
        for (let channel = 0; channel < channels; channel += 1) {
          const data = new Uint8Array(plane);
          for (let row = 0; row < height; row += 1) {
            const count = counts[channel * height + row];
            data.set(unpackBits(bytes, cursor, width), row * width);
            cursor += count;
            if (row % 512 === 511) {
              checkAbort(options);
              reportProgress(options, (channel * height + row) / (channels * height));
              await yieldFrame();
            }
          }
          planes.push(data);
        }
      } else {
        throw new Error('不支持的 PSD 压缩方式：' + compression);
      }
      const rgba = new Uint8ClampedArray(plane * 4);
      for (let index = 0; index < plane; index += 1) {
        const red = planes[0] ? planes[0][index] : 0;
        const green = mode === 3 && planes[1] ? planes[1][index] : red;
        const blue = mode === 3 && planes[2] ? planes[2][index] : red;
        const alpha = planes[3] ? planes[3][index] : 255;
        rgba[index * 4] = red;
        rgba[index * 4 + 1] = green;
        rgba[index * 4 + 2] = blue;
        rgba[index * 4 + 3] = mode === 3 ? alpha : red;
      }
      return { width, height, rgba, channels };
    };

    const sketchOutline = async (zip) => {
      const pages = zip.entries.map((entry) => entry.name).filter((name) => /^(pages|artboards)\/.*\.json$/.test(name));
      const found = [];
      for (const name of pages.slice(0, 20)) {
        try {
          const json = JSON.parse(await zip.text(name));
          const walk = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 6) return;
            const label = node.name || (node.attributedString && node.attributedString.string) || '';
            if (label && String(label).trim()) found.push({ path: name, label: String(label).trim().slice(0, 120) });
            for (const key of ['layers', 'children']) {
              if (Array.isArray(node[key])) for (const child of node[key]) walk(child, depth + 1);
            }
          };
          walk(json, 0);
        } catch {
          /* a page that does not parse is skipped */
        }
      }
      return found;
    };

    const xdOutline = async (zip) => {
      const entry = zip.entries.find((candidate) => /graphicContent\.agc$/.test(candidate.name));
      if (!entry) return [];
      const json = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(await zip.read(entry)));
      const found = [];
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 8) return;
        if (node.name || node.label) found.push({ path: 'artboards', label: String(node.name || node.label).slice(0, 120) });
        if (node.text && node.text.rawText) found.push({ path: 'text', label: String(node.text.rawText).slice(0, 120) });
        for (const key of ['children', 'artboards', 'resources']) {
          if (Array.isArray(node[key])) for (const child of node[key]) walk(child, depth + 1);
        }
      };
      walk(json, 0);
      return found;
    };

    function DesignDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', error: '', mode: '', bitmap: null, outline: [], info: '' });
      const canvasRef = React.useRef(null);
      const hoverSpot = useHoverMark(doc.path);
      const hoverPixel = hoverSpot && hoverSpot.kind === 'spot' && Array.isArray(hoverSpot.pixel) ? hoverSpot.pixel : null;
      const psdCanvas = canvasRef.current;
      const pixelFactor = state.bitmap && psdCanvas && psdCanvas.clientWidth ? state.bitmap.width / psdCanvas.clientWidth : 1;

      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', error: '', mode: '', bitmap: null, outline: [], info: '' });
        const match = /\.([a-z0-9]+)$/i.exec(doc.path);
        const extension = match ? match[1].toLowerCase() : '';
        readBytesFile(sessionId, doc.path, controller.signal)
          .then(async (bytes) => {
            if (cancelled || !bytes) return;
            if (extension === 'psd') {
              const bitmap = await parsePsd(bytes, { signal: controller.signal });
              if (cancelled) return;
              setState({
                status: 'ready',
                error: '',
                mode: 'bitmap',
                bitmap,
                outline: [],
                info: bitmap.width + ' × ' + bitmap.height + ' · 合成图 · ' + bitmap.channels + ' 通道',
              });
              return;
            }
            if (extension === 'ai') {
              const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 5));
              if (head !== '%PDF-') {
                throw new Error('该 .ai 不含 PDF 兼容数据（可能是纯 EPS），请另存为 PDF 后再预览');
              }
              const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
              if (cancelled) return;
              setState({ status: 'ready', error: '', mode: 'pdf', bitmap: null, outline: [], info: url });
              return;
            }
            if (extension === 'sketch' || extension === 'xd') {
              const zip = await openZip(bytes);
              if (cancelled) return;
              const outline = extension === 'sketch' ? await sketchOutline(zip) : await xdOutline(zip);
              if (cancelled) return;
              setState({ status: 'ready', error: '', mode: 'outline', bitmap: null, outline, info: outline.length + ' 个图层/文本' });
              return;
            }
            throw new Error('该设计格式是私有封装，暂不支持解析，请导出为 PNG / PDF / .psd');
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'failed', error: errText(error), mode: '', bitmap: null, outline: [], info: '' });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      React.useEffect(() => {
        if (state.mode !== 'bitmap' || !state.bitmap) return undefined;
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const { width, height, rgba } = state.bitmap;
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return undefined;
        const image = new ImageData(rgba, width, height);
        context.putImageData(image, 0, 0);
        return undefined;
      }, [state.mode, state.bitmap]);

      if (state.status === 'failed') return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该设计文件'), h('div', null, state.error));
      if (state.status !== 'ready') return h('div', { className: 'dshcv-empty' }, h('div', null, '解析设计文件…'));
      const header = h('div', { className: 'dshcv-tools' }, h('span', { className: 'dshcv-msg' }, state.info));
      if (state.mode === 'bitmap') {
        return h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          header,
          h(
            'div',
            { className: 'dshcv-canvaswrap' },
            h(
              'div',
              { style: { position: 'relative', display: 'inline-block' } },
              h('canvas', {
                ref: canvasRef,
                className: 'dshcv-bitmap',
                style: { cursor: 'crosshair' },
                onClick: (event) => {
                  const bitmap = state.bitmap;
                  if (!bitmap) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x = Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * bitmap.width);
                  const y = Math.round(((event.clientY - rect.top) / Math.max(1, rect.height)) * bitmap.height);
                  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
                  const at = (y * bitmap.width + x) * 4;
                  const red = bitmap.rgba[at];
                  const green = bitmap.rgba[at + 1];
                  const blue = bitmap.rgba[at + 2];
                  addMark({
                    kind: 'spot',
                    path: doc.path,
                    label: '像素 (' + x + ', ' + y + ')',
                    quote: 'rgb(' + red + ', ' + green + ', ' + blue + ')',
                    pixel: [x, y],
                  });
                },
              }),
              hoverPixel
                ? h('div', {
                    style: {
                      position: 'absolute',
                      left: hoverPixel[0] / pixelFactor + 'px',
                      top: hoverPixel[1] / pixelFactor + 'px',
                      width: '16px',
                      height: '16px',
                      marginLeft: '-8px',
                      marginTop: '-8px',
                      border: '2px solid var(--dsw-alias-brand-primary)',
                      borderRadius: '50%',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,.3)',
                      pointerEvents: 'none',
                    },
                  })
                : null,
            ),
          ),
        );
      }
      if (state.mode === 'pdf') {
        // A PDF-compatible .ai gets the full PDF viewer, not a bare embed: that is
        // where page navigation and the page/doc mark buttons live.
        return h(PdfDoc, { doc, sessionId });
      }
      return h(
        'div',
        { className: 'dshcv-docwrap' },
        header,
        state.outline.length
          ? h(
              'ul',
              { className: 'dshcv-outline' },
              state.outline.slice(0, 400).map((item, index) =>
                h(
                  'li',
                  {
                    key: index,
                    className:
                      hoverSpot && hoverSpot.kind === 'spot'
                        ? hoverSpot.outlineIndex === index
                          ? 'dshcv-spot'
                          : 'dshcv-dim'
                        : undefined,
                    style: { cursor: 'pointer' },
                    title: '点击标注这一项',
                    onClick: () =>
                      addMark({ kind: 'spot', path: doc.path, label: item.label, quote: item.path, outlineIndex: index }),
                  },
                  h('span', { className: 'dshcv-tcaption' }, item.path),
                  ' ',
                  item.label,
                ),
              ),
            )
          : h('div', { className: 'dshcv-msg' }, '没有解析到图层或文本'),
      );
    }

    // ---- PLY (ascii + binary little endian), OFF family, 3MF and Collada ----
    const PLY_SCALAR = {
      char: (view, at) => view.getInt8(at), int8: (view, at) => view.getInt8(at),
      uchar: (view, at) => view.getUint8(at), uint8: (view, at) => view.getUint8(at),
      short: (view, at) => view.getInt16(at, true), int16: (view, at) => view.getInt16(at, true),
      ushort: (view, at) => view.getUint16(at, true), uint16: (view, at) => view.getUint16(at, true),
      int: (view, at) => view.getInt32(at, true), int32: (view, at) => view.getInt32(at, true),
      uint: (view, at) => view.getUint32(at, true), uint32: (view, at) => view.getUint32(at, true),
      float: (view, at) => view.getFloat32(at, true), float32: (view, at) => view.getFloat32(at, true),
      double: (view, at) => view.getFloat64(at, true), float64: (view, at) => view.getFloat64(at, true),
    };
    const PLY_BYTES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

    const parsePly = async (bytes, options) => {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const stamp = new TextEncoder().encode('end_header');
      let headerStop = -1;
      for (let index = 0; index + stamp.length <= bytes.length; index += 1) {
        let match = true;
        for (let offset = 0; offset < stamp.length; offset += 1) {
          if (bytes[index + offset] !== stamp[offset]) {
            match = false;
            break;
          }
        }
        if (match) {
          headerStop = index;
          break;
        }
      }
      if (headerStop < 0) throw new Error('PLY 头部缺失（找不到 end_header）');
      const head = decoder.decode(bytes.subarray(0, headerStop));
      const headerLines = head.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const formatLine = headerLines.find((line) => /^format\b/i.test(line)) || '';
      if (!formatLine) throw new Error('PLY 缺少 format 行');
      const format = formatLine;
      const binary = /binary_little_endian/i.test(format);
      if (/binary_big_endian/i.test(format)) throw new Error('暂不支持大端 PLY');
      if (!binary && !/ascii/i.test(format)) throw new Error('未知的 PLY 编码：' + format);

      const elements = [];
      let current = null;
      for (const line of headerLines.slice(1)) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'element') {
          current = { name: parts[1], count: Number(parts[2]) || 0, properties: [] };
          elements.push(current);
        } else if (parts[0] === 'property' && current) {
          if (parts[1] === 'list') current.properties.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
          else current.properties.push({ list: false, type: parts[1], name: parts[2] });
        }
      }

      let dataStart = headerStop;
      while (dataStart < bytes.length && bytes[dataStart] !== 0x0a) dataStart += 1;
      dataStart += 1;

      const positions = [];
      const colors = [];
      const indices = [];

      if (binary) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let cursor = dataStart;
        const total = elements.reduce((sum, element) => sum + element.count, 0) || 1;
        let processed = 0;
        const readScalar = (type) => {
          const key = String(type || '').toLowerCase();
          const reader = PLY_SCALAR[key];
          if (!reader) throw new Error('未知的 PLY 属性类型：' + type);
          const value = reader(view, cursor);
          cursor += PLY_BYTES[key];
          return value;
        };
        for (const element of elements) {
          for (let index = 0; index < element.count; index += 1) {
            const record = {};
            for (const property of element.properties) {
              if (property.list) {
                const count = readScalar(property.countType);
                const items = [];
                for (let item = 0; item < count; item += 1) items.push(readScalar(property.itemType));
                record[property.name] = items;
              } else {
                record[property.name] = readScalar(property.type);
              }
            }
            if (element.name === 'vertex') {
              positions.push(record.x || 0, record.y || 0, record.z || 0);
              if (record.red !== undefined) colors.push((record.red || 0) / 255, (record.green || 0) / 255, (record.blue || 0) / 255);
            } else if (element.name === 'face') {
              const face = record.vertex_indices || record.vertex_index || [];
              for (let item = 1; item + 1 < face.length; item += 1) indices.push(face[0], face[item], face[item + 1]);
            }
            processed += 1;
            if (processed % 20000 === 0) {
              checkAbort(options);
              reportProgress(options, processed / total);
              await yieldFrame();
            }
          }
        }
      } else {
        const rows = decoder.decode(bytes.subarray(dataStart)).split(/\r?\n/);
        let cursor = 0;
        const total = elements.reduce((sum, element) => sum + element.count, 0) || 1;
        let processed = 0;
        for (const element of elements) {
          for (let index = 0; index < element.count; index += 1) {
            const tokens = (rows[cursor] || '').trim().split(/\s+/).map(Number);
            cursor += 1;
            if (element.name === 'vertex') {
              positions.push(tokens[0] || 0, tokens[1] || 0, tokens[2] || 0);
              let offset = 3;
              for (const property of element.properties) {
                if (property.list) continue;
                if (property.name === 'red') colors.push(((tokens[offset] || 0) / 255), ((tokens[offset + 1] || 0) / 255), ((tokens[offset + 2] || 0) / 255));
                offset += 1;
              }
            } else if (element.name === 'face') {
              const count = tokens[0] || 0;
              for (let item = 1; item + 2 <= count; item += 1) indices.push(tokens[item] || 0, tokens[item + 1] || 0, tokens[item + 2] || 0);
            }
            processed += 1;
            if (processed % 20000 === 0) {
              checkAbort(options);
              reportProgress(options, processed / total);
              await yieldFrame();
            }
          }
        }
      }

      if (indices.length) {
        const soup = new Float32Array((indices.length / 3) * 9);
        for (let index = 0; index < indices.length; index += 1) {
          const base = indices[index] * 3;
          soup[index * 3] = positions[base] || 0;
          soup[index * 3 + 1] = positions[base + 1] || 0;
          soup[index * 3 + 2] = positions[base + 2] || 0;
        }
        return { positions: soup, colors: colors.length ? new Float32Array(colors) : null, points: false };
      }
      return { positions: new Float32Array(positions), colors: colors.length ? new Float32Array(colors) : null, points: true };
    };

    const parseOff = (bytes) => {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const lines = text.split(/\r?\n/);
      let cursor = 0;
      while (cursor < lines.length && !/^\s*(?:[NC]*OFF)\b/i.test(lines[cursor])) cursor += 1;
      if (cursor >= lines.length) throw new Error('OFF 头部缺失');
      const flavour = ((lines[cursor].match(/([NC]*)OFF/i) || ['', ''])[1] || '').toUpperCase();
      cursor += 1;
      const nextNumbers = () => {
        while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
        const values = (lines[cursor] || '').trim().split(/\s+/).map(Number);
        cursor += 1;
        return values;
      };
      const counts = nextNumbers();
      const vertexCount = counts[0] || 0;
      const faceCount = counts[1] || 0;
      const positions = [];
      const colors = [];
      for (let index = 0; index < vertexCount; index += 1) {
        const values = nextNumbers();
        positions.push(values[0] || 0, values[1] || 0, values[2] || 0);
        if (flavour.includes('C')) {
          let offset = 3;
          if (flavour.includes('N')) offset += 3;
          const red = values[offset] || 0;
          const green = values[offset + 1] || 0;
          const blue = values[offset + 2] || 0;
          const alpha = values[offset + 3] === undefined ? 1 : values[offset + 3] / 255 || 1;
          colors.push(Math.min(1, red / 255 / alpha), Math.min(1, green / 255 / alpha), Math.min(1, blue / 255 / alpha));
        }
      }
      const soup = [];
      for (let face = 0; face < faceCount; face += 1) {
        const values = nextNumbers();
        const count = values[0] || 0;
        for (let item = 1; item + 2 <= count; item += 1) {
          for (const corner of [values[1], values[item + 1], values[item + 2]]) {
            soup.push(positions[corner * 3] || 0, positions[corner * 3 + 1] || 0, positions[corner * 3 + 2] || 0);
          }
        }
      }
      return { positions: new Float32Array(soup), colors: colors.length ? new Float32Array(colors) : null, points: false };
    };
    const parse3mf = async (bytes) => {
      const zip = await openZip(bytes);
      const modelEntry = zip.entries.find((entry) => /3D\/.*\.model$/i.test(entry.name)) || zip.entries.find((entry) => /\.model$/i.test(entry.name));
      if (!modelEntry) throw new Error('3MF 里没有找到 .model 文件');
      const xml = parseXml(new TextDecoder('utf-8', { fatal: false }).decode(await zip.read(modelEntry)));
      const vertices = Array.from(xml.getElementsByTagName('vertex')).map((node) => [
        Number(node.getAttribute('x')) || 0,
        Number(node.getAttribute('y')) || 0,
        Number(node.getAttribute('z')) || 0,
      ]);
      const out = [];
      for (const triangle of Array.from(xml.getElementsByTagName('triangle'))) {
        for (const attribute of ['v1', 'v2', 'v3']) {
          const index = Number(triangle.getAttribute(attribute)) || 0;
          const vertex = vertices[index] || [0, 0, 0];
          out.push(vertex[0], vertex[1], vertex[2]);
        }
      }
      return { positions: new Float32Array(out), colors: null };
    };

    // Collada is XML with an indirection that is easy to get wrong: a primitive's
    // VERTEX input often points at a <vertices> block, which in turn points at the
    // <source> element holding the <float_array>. Reading the geometry is split from
    // interpreting it so the index maths can be tested without a DOM.
    const readCollada = (xml) => {
      const buckets = new Map();
      for (const node of Array.from(xml.getElementsByTagName('*'))) {
        const name = node.localName || String(node.tagName || '').split(':').pop();
        if (!buckets.has(name)) buckets.set(name, []);
        buckets.get(name).push(node);
      }
      const pick = (name) => buckets.get(name) || [];
      const directChildren = (node, name) =>
        Array.from(node.children || []).filter((child) => (child.localName || String(child.tagName || '').split(':').pop()) === name);

      const sources = new Map();
      for (const source of pick('source')) {
        const id = source.getAttribute('id');
        if (!id) continue;
        const array = directChildren(source, 'float_array')[0] || directChildren(source, 'double_array')[0] || pick('float_array').find((node) => source.contains(node));
        if (!array) continue;
        const values = (array.textContent || '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => Number(value) || 0);
        sources.set(id, values);
        // Exporters reference either the source id or the array id; keep both.
        const arrayId = array.getAttribute('id');
        if (arrayId && !sources.has(arrayId)) sources.set(arrayId, values);
      }

      const vertices = new Map();
      for (const block of pick('vertices')) {
        const id = block.getAttribute('id');
        if (!id) continue;
        const position = Array.from(block.getElementsByTagName('input')).find(
          (input) => String(input.getAttribute('semantic') || '').toUpperCase() === 'POSITION',
        );
        if (position) vertices.set(id, String(position.getAttribute('source') || '').replace(/^#/, ''));
      }

      const primitives = [];
      const readInputs = (node) =>
        directChildren(node, 'input').map((input) => ({
          semantic: String(input.getAttribute('semantic') || '').toUpperCase(),
          source: String(input.getAttribute('source') || '').replace(/^#/, ''),
          offset: Number(input.getAttribute('offset')) || 0,
        }));
      const readNumbers = (node) =>
        (node && node.textContent ? node.textContent : '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => Number(value) || 0);

      for (const kind of ['triangles', 'polylist', 'polygons', 'tristrips', 'trifans']) {
        for (const node of pick(kind)) {
          const inputs = readInputs(node);
          const vcountNode = directChildren(node, 'vcount')[0];
          const polygons = kind === 'polygons' ? Array.from(node.getElementsByTagName('p')) : null;
          if (polygons) {
            primitives.push({
              kind,
              inputs,
              polygons: polygons.map((entry) => readNumbers(entry)),
            });
            continue;
          }
          const p = directChildren(node, 'p')[0] || node.getElementsByTagName('p')[0];
          if (!p) continue;
          primitives.push({
            kind,
            inputs,
            p: readNumbers(p),
            vcount: vcountNode ? readNumbers(vcountNode) : [],
          });
        }
      }
      return { sources, vertices, primitives };
    };

    const triangulateCollada = (model) => {
      const out = [];
      const lookup = (ref) => {
        if (model.sources.has(ref)) return model.sources.get(ref);
        const viaVertices = model.vertices.get(ref);
        if (viaVertices !== undefined) return model.sources.get(viaVertices) || null;
        return null;
      };
      for (const primitive of model.primitives) {
        const vertex = primitive.inputs.find((input) => input.semantic === 'VERTEX');
        if (!vertex) continue;
        const values = lookup(vertex.source);
        if (!values) continue;
        const step = Math.max(1, ...primitive.inputs.map((input) => input.offset + 1));
        const cornersOf = (raw, offset) => {
          // Materials and normals interleave with positions; only VERTEX is used.
          const corners = [];
          for (const corner of [0, 1, 2]) {
            const vertexIndex = raw[offset + corner * step + vertex.offset];
            corners.push([
              values[vertexIndex * 3] || 0,
              values[vertexIndex * 3 + 1] || 0,
              values[vertexIndex * 3 + 2] || 0,
            ]);
          }
          return corners;
        };
        const emit = (corners) => {
          for (const corner of corners) out.push(corner[0], corner[1], corner[2]);
        };

        if (primitive.polygons) {
          for (const polygon of primitive.polygons) {
            const points = [];
            for (let index = 0; index + step <= polygon.length; index += step) {
              const vertexIndex = polygon[index + vertex.offset];
              points.push([
                values[vertexIndex * 3] || 0,
                values[vertexIndex * 3 + 1] || 0,
                values[vertexIndex * 3 + 2] || 0,
              ]);
            }
            for (let index = 1; index + 1 < points.length; index += 1) {
              emit([points[0], points[index], points[index + 1]]);
            }
          }
          continue;
        }

        const raw = primitive.p || [];
        if (primitive.kind === 'triangles') {
          for (let index = 0; index + step * 3 <= raw.length; index += step * 3) emit(cornersOf(raw, index));
        } else if (primitive.kind === 'polylist') {
          let cursor = 0;
          for (const count of primitive.vcount) {
            const points = [];
            for (let corner = 0; corner < count; corner += 1) {
              const base = cursor + corner * step;
              const vertexIndex = raw[base + vertex.offset];
              points.push([
                values[vertexIndex * 3] || 0,
                values[vertexIndex * 3 + 1] || 0,
                values[vertexIndex * 3 + 2] || 0,
              ]);
            }
            for (let index = 1; index + 1 < points.length; index += 1) {
              emit([points[0], points[index], points[index + 1]]);
            }
            cursor += count * step;
          }
        } else {
          // tristrips / trifans: overlapping windows, with the strip flipping winding.
          const points = [];
          for (let index = 0; index + step <= raw.length; index += step) {
            const vertexIndex = raw[index + vertex.offset];
            points.push([
              values[vertexIndex * 3] || 0,
              values[vertexIndex * 3 + 1] || 0,
              values[vertexIndex * 3 + 2] || 0,
            ]);
          }
          for (let index = 0; index + 2 < points.length; index += 1) {
            emit(
              primitive.kind === 'tristrips' && index % 2 === 1
                ? [points[index + 1], points[index], points[index + 2]]
                : [points[index], points[index + 1], points[index + 2]],
            );
          }
        }
      }
      return { positions: new Float32Array(out), colors: null };
    };

    const parseCollada = (bytes) => {
      const xml = parseXml(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      return triangulateCollada(readCollada(xml));
    };

    const loadMesh = async (bytes, extension, options) => {
      if (extension === 'stl') return { positions: await parseStl(bytes, options), colors: null };
      if (extension === 'obj') return { positions: parseObj(new TextDecoder('utf-8', { fatal: false }).decode(bytes)), colors: null };
      if (extension === 'ply') return await parsePly(bytes, options);
      if (['off', 'noff', 'coff', 'cnoff'].includes(extension)) return parseOff(bytes);
      if (extension === '3mf') return parse3mf(bytes);
      if (extension === 'dae') return parseCollada(bytes);
      return { positions: parseGltf(bytes), colors: null };
    };

    // ---------------- 3d models: triangle soup in, WebGL out ----------------
    const parseStl = async (bytes, options) => {
      if (bytes.length >= 84) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const declared = view.getUint32(80, true);
        if (declared > 0 && 84 + declared * 50 === bytes.length) {
          const positions = new Float32Array(declared * 9);
          let at = 84 + 12;
          const chunk = 50000;
          for (let index = 0; index < declared; index += 1) {
            for (let corner = 0; corner < 9; corner += 1) positions[index * 9 + corner] = view.getFloat32(at + corner * 4, true);
            at += 50;
            if (index % chunk === chunk - 1) {
              checkAbort(options);
              reportProgress(options, index / declared);
              await yieldFrame();
            }
          }
          return positions;
        }
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const found = [];
      const pattern = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
      let match;
      let seen = 0;
      while ((match = pattern.exec(text))) {
        found.push(Number(match[1]), Number(match[2]), Number(match[3]));
        seen += 1;
        if (seen % 100000 === 0) {
          checkAbort(options);
          reportProgress(options, match.index / Math.max(1, text.length));
          await yieldFrame();
        }
      }
      return new Float32Array(found);
    };

    const parseObj = (text) => {
      const vertices = [];
      const triangles = [];
      for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('v ')) {
          const parts = line.split(/\s+/);
          vertices.push(Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0);
        } else if (line.startsWith('f ')) {
          const indices = line
            .split(/\s+/)
            .slice(1)
            .map((token) => parseInt(token.split('/')[0], 10))
            .filter((index) => Number.isFinite(index) && index !== 0);
          for (let index = 1; index + 1 < indices.length; index += 1) {
            for (const corner of [indices[0], indices[index], indices[index + 1]]) {
              const base = (corner < 0 ? vertices.length / 3 + corner : corner - 1) * 3;
              triangles.push(vertices[base] || 0, vertices[base + 1] || 0, vertices[base + 2] || 0);
            }
          }
        }
      }
      return new Float32Array(triangles);
    };

    const quatToMatrix = (x, y, z, w) => {
      const m = new Float64Array(16);
      const xx = x * x;
      const yy = y * y;
      const zz = z * z;
      m[0] = 1 - 2 * (yy + zz);
      m[1] = 2 * (x * y + z * w);
      m[2] = 2 * (x * z - y * w);
      m[4] = 2 * (x * y - z * w);
      m[5] = 1 - 2 * (xx + zz);
      m[6] = 2 * (y * z + x * w);
      m[8] = 2 * (x * z + y * w);
      m[9] = 2 * (y * z - x * w);
      m[10] = 1 - 2 * (xx + yy);
      m[15] = 1;
      return m;
    };

    const multiplyMatrix = (left, right) => {
      const out = new Float64Array(16);
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          let sum = 0;
          for (let index = 0; index < 4; index += 1) sum += left[index * 4 + row] * right[column * 4 + index];
          out[column * 4 + row] = sum;
        }
      }
      return out;
    };

    const nodeMatrix = (node) => {
      if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
      let matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      if (node.rotation) matrix = quatToMatrix(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
      if (node.scale) {
        const scale = new Float64Array([node.scale[0], 0, 0, 0, 0, node.scale[1], 0, 0, 0, 0, node.scale[2], 0, 0, 0, 0, 1]);
        matrix = multiplyMatrix(matrix, scale);
      }
      if (node.translation) {
        const translate = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, node.translation[0], node.translation[1], node.translation[2], 1]);
        matrix = multiplyMatrix(translate, matrix);
      }
      return matrix;
    };

    const parseGltf = (bytes) => {
      let json = null;
      let binary = null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length > 12 && view.getUint32(0, true) === 0x46546c67) {
        const length = view.getUint32(8, true);
        let offset = 12;
        while (offset < Math.min(length, bytes.length)) {
          const chunkLength = view.getUint32(offset, true);
          const chunkType = view.getUint32(offset + 4, true);
          const start = offset + 8;
          if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + chunkLength)));
          if (chunkType === 0x004e4942) binary = bytes.subarray(start, start + chunkLength);
          offset = start + chunkLength;
        }
      } else {
        json = JSON.parse(new TextDecoder().decode(bytes));
        const uri = json.buffers && json.buffers[0] && json.buffers[0].uri;
        if (uri && uri.startsWith('data:')) {
          const base64 = uri.slice(uri.indexOf(',') + 1);
          const raw = atob(base64);
          binary = new Uint8Array(raw.length);
          for (let index = 0; index < raw.length; index += 1) binary[index] = raw.charCodeAt(index);
        }
      }
      if (!json || !binary) throw new Error('需要 .glb（或内嵌 data URI 的 .gltf）；外部 .bin 无法读取');
      const readAccessor = (accessorIndex) => {
        const accessor = json.accessors[accessorIndex];
        const bufferView = json.bufferViews[accessor.bufferView];
        const components = accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : 1;
        const offset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        const stride = bufferView.byteStride || components * 4;
        const count = accessor.count;
        const out = new Float32Array(count * components);
        const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
        for (let index = 0; index < count; index += 1) {
          for (let part = 0; part < components; part += 1) {
            out[index * components + part] = data.getFloat32(offset + index * stride + part * 4, true);
          }
        }
        return out;
      };
      const triangles = [];
      const visit = (nodeIndex, parent) => {
        const node = json.nodes[nodeIndex];
        if (!node) return;
        const matrix = multiplyMatrix(parent, nodeMatrix(node));
        if (typeof node.mesh === 'number') {
          const mesh = json.meshes[node.mesh];
          for (const primitive of mesh.primitives || []) {
            if (primitive.mode !== undefined && primitive.mode !== 4) continue;
            const attributes = primitive.attributes || {};
            if (attributes.POSITION === undefined) continue;
            const points = readAccessor(attributes.POSITION);
            const indices = primitive.indices !== undefined ? readAccessor(primitive.indices) : null;
            const order = indices || points.map((_, index) => index);
            const stride = 3;
            for (let index = 0; index < order.length; index += 1) {
              const source = order[index] * stride;
              const x = points[source] || 0;
              const y = points[source + 1] || 0;
              const z = points[source + 2] || 0;
              triangles.push(
                matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
              );
            }
          }
        }
        for (const child of node.children || []) visit(child, matrix);
      };
      const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const scene = json.scenes && json.scenes[json.scene || 0];
      for (const nodeIndex of (scene && scene.nodes) || []) visit(nodeIndex, identity);
      return new Float32Array(triangles);
    };

    const withNormals = (positions) => {
      const count = Math.floor(positions.length / 9);
      const out = new Float32Array(count * 18);
      for (let index = 0; index < count; index += 1) {
        const at = index * 9;
        const ax = positions[at];
        const ay = positions[at + 1];
        const az = positions[at + 2];
        const bx = positions[at + 3];
        const by = positions[at + 4];
        const bz = positions[at + 5];
        const cx = positions[at + 6];
        const cy = positions[at + 7];
        const cz = positions[at + 8];
        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        for (let corner = 0; corner < 3; corner += 1) {
          const from = at + corner * 3;
          const to = index * 18 + corner * 6;
          out[to] = positions[from];
          out[to + 1] = positions[from + 1];
          out[to + 2] = positions[from + 2];
          out[to + 3] = nx;
          out[to + 4] = ny;
          out[to + 5] = nz;
        }
      }
      return out;
    };

    const perspective = (fieldOfView, aspect, near, far) => {
      const f = 1 / Math.tan(fieldOfView / 2);
      return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    };

    const lookAt = (eye, target, up) => {
      const z = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
      const zl = Math.hypot(z[0], z[1], z[2]) || 1;
      z[0] /= zl;
      z[1] /= zl;
      z[2] /= zl;
      const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
      const xl = Math.hypot(x[0], x[1], x[2]) || 1;
      x[0] /= xl;
      x[1] /= xl;
      x[2] /= xl;
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
        -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
        -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
        1,
      ]);
    };

    // Distance and angle between picked surface points; values are in model units.
    const describeMeasure = (mode, points) => {
      const round = (value) => (Math.abs(value) >= 100 ? value.toFixed(2) : Math.abs(value) >= 10 ? value.toFixed(3) : value.toFixed(4));
      if (mode === 'distance' && points.length === 2) {
        const [a, b] = points;
        return '距离 ' + round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      }
      if (mode === 'angle' && points.length === 3) {
        const [a, b, c] = points;
        const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        const lu = Math.hypot(u[0], u[1], u[2]);
        const lv = Math.hypot(v[0], v[1], v[2]);
        if (!lu || !lv) return '';
        const cosine = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)));
        return '夹角 ' + (Math.acos(cosine) * 180 / Math.PI).toFixed(1) + '°';
      }
      return '';
    };

    function ModelDoc(props) {
      const { doc, sessionId } = props;
      useVersion();
      const [state, setState] = React.useState({ status: 'idle', error: '', info: '', stats: null });
      const [options, setOptions] = React.useState({ faces: true, edges: true, hiddenLine: true, fog: true, axes: true, normals: false });
      const [notice, setNotice] = React.useState('');
      const [progress, setProgress] = React.useState(0);
      // Visible render diagnostics: triangle and line counts plus the last GL error.
      const [diag, setDiag] = React.useState({ triangles: 0, lineVertices: 0, error: 0 });
      const [measure, setMeasure] = React.useState({ mode: '', points: [], result: '' });
      const measurePointsRef = React.useRef([]);
      measurePointsRef.current = measure.points;
      const diagRef = React.useRef({ triangles: 0, lineVertices: 0, error: 0 });
      const publishDiag = (patch) => {
        const next = Object.assign({}, diagRef.current, patch);
        const previous = diagRef.current;
        if (next.triangles === previous.triangles && next.lineVertices === previous.lineVertices && next.error === previous.error) return;
        diagRef.current = next;
        setDiag(next);
      };
      const canvasRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const meshRef = React.useRef(null);
      const viewRef = React.useRef({ yaw: 0.72, pitch: 0.42, distance: 3, pan: [0, 0, 0], center: [0, 0, 0], radius: 1 });
      const drawRef = React.useRef(() => {});
      const repaintRef = React.useRef(() => {});
      const pickRef = React.useRef(() => null);
      // A click that ends a drag must not drop a mark on the model.
      const dragMovedRef = React.useRef(false);

      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        setState({ status: 'loading', error: '', info: '', stats: null });
        setProgress(0);
        const match = /\.([a-z0-9]+)$/i.exec(doc.path);
        const extension = match ? match[1].toLowerCase() : '';
        const apply = (rawPositions, mesh) => {
          if (!rawPositions || rawPositions.length < 9) {
            throw new Error(mesh && mesh.points ? '这是点云数据，三维面片查看器暂不显示' : '没有解析到三角形，可能格式不受支持或模型为空');
          }
          const reduced = decimateMesh(rawPositions, MAX_PREVIEW_TRIANGLES);
          const positions = reduced.positions;
          meshRef.current = positions;
          let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            for (let index = 0; index < positions.length; index += 3) {
              const x = positions[index];
              const y = positions[index + 1];
              const z = positions[index + 2];
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              if (z < minZ) minZ = z;
              if (z > maxZ) maxZ = z;
            }
          const size = [maxX - minX, maxY - minY, maxZ - minZ];
          const radius = Math.max(size[0], size[1], size[2], 1e-6) / 2;
          // Area and signed volume are cheap one-pass integrals; the watertight
          // check needs an edge census, which is skipped on very large meshes.
          let area = 0;
          let volume = 0;
          for (let index = 0; index + 8 < positions.length; index += 9) {
            const ax = positions[index];
            const ay = positions[index + 1];
            const az = positions[index + 2];
            const bx = positions[index + 3];
            const by = positions[index + 4];
            const bz = positions[index + 5];
            const cx = positions[index + 6];
            const cy = positions[index + 7];
            const cz = positions[index + 8];
            const ux = bx - ax;
            const uy = by - ay;
            const uz = bz - az;
            const vx = cx - ax;
            const vy = cy - ay;
            const vz = cz - az;
            area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
          }
          let watertight = null;
          if (positions.length / 9 <= 200000) {
            const edges = new Map();
            const keyOf = (x, y, z) => x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
            for (let index = 0; index + 8 < positions.length; index += 9) {
              const keys = [0, 1, 2].map((corner) =>
                keyOf(positions[index + corner * 3], positions[index + corner * 3 + 1], positions[index + corner * 3 + 2]),
              );
              for (const [left, right] of [[0, 1], [1, 2], [2, 0]]) {
                const edge = keys[left] < keys[right] ? keys[left] + '|' + keys[right] : keys[right] + '|' + keys[left];
                edges.set(edge, (edges.get(edge) || 0) + 1);
              }
            }
            watertight = true;
            for (const count of edges.values()) {
              if (count !== 2) {
                watertight = false;
                break;
              }
            }
          }
          viewRef.current.center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
          viewRef.current.radius = radius;
          viewRef.current.distance = radius / Math.tan(Math.PI / 8) + radius;
          if (cancelled) return;
          relocateSpotMarks(doc.path, positions, radius);
          setState({
            status: 'ready',
            error: '',
            info:
              (positions.length / 9).toLocaleString() +
              ' 个三角形' +
              (reduced.reduced ? '（已抽稀，原 ' + (rawPositions.length / 9).toLocaleString() + '）' : ''),
            stats: {
              triangles: positions.length / 9,
              vertices: positions.length / 3,
              size,
              area,
              volume: Math.abs(volume),
              watertight,
            },
          });
        };

        const run = async () => {
          const info = await readFileInfo(sessionId, doc.path, controller.signal);
          const key = meshCacheKey(sessionId, doc.path, info);
          const cached = meshCacheGet(key);
          if (cached) {
            apply(cached.positions, null);
            return;
          }
          const bytes = await readBytesFile(sessionId, doc.path, controller.signal);
          if (cancelled || !bytes) return;
          const mesh = await loadMesh(bytes, extension, {
            signal: controller.signal,
            onProgress: (fraction) => setProgress(fraction),
          });
          if (cancelled) return;
          meshCacheSet(key, { positions: mesh.positions, colors: mesh.colors });
          apply(mesh.positions, mesh);
        };
        run().catch((error) => {
          if (!cancelled) setState({ status: 'failed', error: errText(error), info: '', stats: null });
        });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      React.useEffect(() => {
        if (state.status !== 'ready') return undefined;
        const canvas = canvasRef.current;
        const positions = meshRef.current;
        if (!canvas || !positions) return undefined;
        const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
        if (!gl) {
          setState((previous) => Object.assign({}, previous, { status: 'failed', error: '当前环境不支持 WebGL' }));
          return undefined;
        }
        // Vertex array state lives on the context, not on the program, and this
        // effect is rebuilt on every option change. Start from a clean slate so a
        // stale array cannot point at a buffer the previous run deleted.
        try {
          const maxAttributes = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 8;
          for (let index = 0; index < maxAttributes; index += 1) gl.disableVertexAttribArray(index);
        } catch {
          /* best effort */
        }

        const compile = (type, source) => {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '着色器编译失败');
          return shader;
        };
        const link = (vertexSource, fragmentSource) => {
          const program = gl.createProgram();
          gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
          gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '程序链接失败');
          return program;
        };

        // Blinn-Phong: a key light, a dimmer back fill, and optional distance fog.
        const solid = link(
          'attribute vec3 aPosition;attribute vec3 aNormal;uniform mat4 uMvp;uniform mat4 uView;uniform mat4 uModel;' +
            'varying vec3 vNormal;varying vec3 vEye;varying float vDepth;' +
            'void main(){vec4 world=uModel*vec4(aPosition,1.0);vec4 eye=uView*world;vNormal=normalize(mat3(uModel)*aNormal);' +
            'vEye=normalize(-eye.xyz);vDepth=length(eye.xyz);gl_Position=uMvp*vec4(aPosition,1.0);}',
          'precision mediump float;varying vec3 vNormal;varying vec3 vEye;varying float vDepth;' +
            'uniform vec3 uColor;uniform float uFog;uniform float uFar;uniform float uNormalView;uniform float uDim;' +
            'void main(){vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;' +
            'if(uNormalView>0.5){gl_FragColor=vec4(n*0.5+0.5,1.0);return;}' +
            'vec3 key=normalize(vec3(0.45,0.72,0.55));vec3 fill=normalize(vec3(-0.55,-0.25,-0.6));' +
            'float keyDiff=max(dot(n,key),0.0);float fillDiff=max(dot(n,fill),0.0)*0.35;' +
            'vec3 halfKey=normalize(key+vEye);float spec=pow(max(dot(n,halfKey),0.0),48.0)*0.35;' +
            'vec3 base=uColor*(0.18+0.82*keyDiff+fillDiff)+vec3(spec);' +
            'float fog=uFog>0.5?clamp((vDepth-uFar*0.55)/(uFar*0.75),0.0,0.85):0.0;' +
            'vec3 shaded=mix(base,vec3(0.09,0.11,0.14),fog);' +
            // uDim fades everything that is not the spotlit triangle.
            'gl_FragColor=vec4(shaded,1.0);' +
            'gl_FragColor.a=mix(1.0,0.16,uDim);' +
            'gl_FragColor.rgb*=mix(1.0,0.55,uDim);}',
        );
        const lines = link(
          'attribute vec3 aPosition;uniform mat4 uMvp;void main(){gl_Position=uMvp*vec4(aPosition,1.0);}',
          'precision mediump float;uniform vec3 uColor;void main(){gl_FragColor=vec4(uColor,1.0);}',
        );

        const data = withNormals(positions);
        const solidBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, solidBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const solidCount = data.length / 6;

        // Edges are drawn as a plain vertex list: 32-bit indices need
        // OES_element_index_uint, and without it drawElements failed silently,
        // which is exactly why the wireframe button blanked the model.
        // The list costs 72 bytes per triangle, so it is only built when edges are
        // actually visible; a shaded 800k-triangle model would otherwise hold 57 MB
        // of lines that no one can see.
        const triangleCount = solidCount / 3;
        const wantsLines = options.edges && (!options.faces || triangleCount <= 400000);
        let lineBuffer = null;
        let lineVertexCount = 0;
        if (wantsLines) {
          lineBuffer = gl.createBuffer();
          lineVertexCount = solidCount * 2;
          const lines = new Float32Array(solidCount * 2 * 3);
          let write = 0;
          for (let triangle = 0; triangle < triangleCount; triangle += 1) {
            const base = triangle * 3;
            for (const [from, to] of [[0, 1], [1, 2], [2, 0]]) {
              for (const corner of [from, to]) {
                const at = (base + corner) * 6;
                lines[write] = data[at];
                lines[write + 1] = data[at + 1];
                lines[write + 2] = data[at + 2];
                write += 3;
              }
            }
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
        }
        publishDiag({ triangles: triangleCount, lineVertices: lineVertexCount, error: 0 });
        // One reusable buffer for the axis overlay: allocating per frame made
        // every orbit step leave garbage behind.
        const axisBuffer = gl.createBuffer();

        const uniforms = {
          solid: {
            mvp: gl.getUniformLocation(solid, 'uMvp'),
            view: gl.getUniformLocation(solid, 'uView'),
            model: gl.getUniformLocation(solid, 'uModel'),
            color: gl.getUniformLocation(solid, 'uColor'),
            fog: gl.getUniformLocation(solid, 'uFog'),
            far: gl.getUniformLocation(solid, 'uFar'),
            normals: gl.getUniformLocation(solid, 'uNormalView'),
            dim: gl.getUniformLocation(solid, 'uDim'),
          },
          lines: { mvp: gl.getUniformLocation(lines, 'uMvp'), color: gl.getUniformLocation(lines, 'uColor') },
        };
        const attributes = {
          solid: { position: gl.getAttribLocation(solid, 'aPosition'), normal: gl.getAttribLocation(solid, 'aNormal') },
          lines: { position: gl.getAttribLocation(lines, 'aPosition') },
        };
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

        const render = () => {
          const ratio = window.devicePixelRatio || 1;
          const width = canvas.clientWidth || 1;
          const height = canvas.clientHeight || 1;
          if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
          }
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.DEPTH_TEST);
          // Double-sided on purpose: winding differs between OBJ/PLY/OFF writers,
          // and culling a reversed file made the whole model vanish.
          gl.disable(gl.CULL_FACE);
          const view = viewRef.current;
          const center = view.center;
          const distance = view.distance;
          const pan = view.pan || [0, 0, 0];
          const target = [center[0] + pan[0], center[1] + pan[1], center[2] + pan[2]];
          const eye = [
            target[0] + distance * Math.cos(view.pitch) * Math.sin(view.yaw),
            target[1] + distance * Math.sin(view.pitch),
            target[2] + distance * Math.cos(view.pitch) * Math.cos(view.yaw),
          ];
          const projection = perspective(Math.PI / 4, width / height, distance / 500, distance * 40);
          const camera = lookAt(eye, target, [0, 1, 0]);
          const mvp = multiplyMatrix(new Float32Array(projection), camera);
          // Hovering a triangle mark spotlights it: everything else fades towards the
          // page background instead of merely keeping its own colour.
          const spotMark = hoveredMarkFor(doc.path);
          const spotTriangle = spotMark && spotMark.kind === 'spot' && typeof spotMark.triangle === 'number' ? spotMark.triangle : -1;
          const dimming = spotTriangle >= 0;



          if (options.faces) {
            gl.useProgram(solid);
            gl.bindBuffer(gl.ARRAY_BUFFER, solidBuffer);
            gl.enableVertexAttribArray(attributes.solid.position);
            gl.vertexAttribPointer(attributes.solid.position, 3, gl.FLOAT, false, 24, 0);
            gl.enableVertexAttribArray(attributes.solid.normal);
            gl.vertexAttribPointer(attributes.solid.normal, 3, gl.FLOAT, false, 24, 12);
            gl.uniformMatrix4fv(uniforms.solid.mvp, false, mvp);
            gl.uniformMatrix4fv(uniforms.solid.view, false, camera);
            gl.uniformMatrix4fv(uniforms.solid.model, false, identity);
            gl.uniform3f(uniforms.solid.color, 0.62, 0.72, 0.9);
            gl.uniform1f(uniforms.solid.fog, options.fog ? 1 : 0);
            gl.uniform1f(uniforms.solid.far, distance);
            gl.uniform1f(uniforms.solid.normals, options.normals ? 1 : 0);
            gl.uniform1f(uniforms.solid.dim, dimming ? 1 : 0);
            if (dimming) {
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
              gl.depthMask(false);
            }
            gl.drawArrays(gl.TRIANGLES, 0, solidCount);
            if (dimming) {
              gl.depthMask(true);
              gl.disable(gl.BLEND);
            }
            // Leave the normal array off: an enabled array whose buffer is later
            // deleted makes every following draw fail with INVALID_OPERATION, which
            // is what blanked the wireframe once faces were switched off.
            if (attributes.solid.normal >= 0) gl.disableVertexAttribArray(attributes.solid.normal);
          }

          if (options.edges && lineBuffer) {
            // Pure wireframe can either hide occluded edges (default) or show the
            // whole cage through the model, which is the usual "see-through" view.
            const seeThrough = !options.faces && !options.hiddenLine;
            if (seeThrough) gl.disable(gl.DEPTH_TEST);
            // Edges sit exactly on the surface, so LESS would reject every one of
            // them when faces are drawn; LEQUAL lets coincident lines through.
            gl.depthFunc(gl.LEQUAL);
            gl.useProgram(lines);
            gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
            gl.enableVertexAttribArray(attributes.lines.position);
            gl.vertexAttribPointer(attributes.lines.position, 3, gl.FLOAT, false, 12, 0);
            gl.uniformMatrix4fv(uniforms.lines.mvp, false, mvp);
            const edgeFade = dimming ? 0.35 : 1;
            gl.uniform3f(
              uniforms.lines.color,
              (options.faces ? 0.28 : 0.72) * edgeFade,
              (options.faces ? 0.34 : 0.82) * edgeFade,
              1.0 * edgeFade,
            );
            gl.drawArrays(gl.LINES, 0, lineVertexCount);
            if (seeThrough) gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
          }

          if (options.axes) {
            // Bind the line program explicitly: with edges off it is not current,
            // and setting its uniforms while another program runs is INVALID_OPERATION.
            gl.useProgram(lines);
            const origin = new Float32Array([target[0], target[1], target[2]]);
            const size = view.radius * 1.35;
            const axes = new Float32Array([
              origin[0], origin[1], origin[2], origin[0] + size, origin[1], origin[2],
              origin[0], origin[1], origin[2], origin[0], origin[1] + size, origin[2],
              origin[0], origin[1], origin[2], origin[0], origin[1], origin[2] + size,
            ]);
            const axisBufferLocal = axisBuffer;
            gl.bindBuffer(gl.ARRAY_BUFFER, axisBufferLocal);
            gl.bufferData(gl.ARRAY_BUFFER, axes, gl.STREAM_DRAW);
            gl.enableVertexAttribArray(attributes.lines.position);
            gl.vertexAttribPointer(attributes.lines.position, 3, gl.FLOAT, false, 12, 0);
            gl.uniform3f(uniforms.lines.color, 0.9, 0.42, 0.42);
            gl.drawArrays(gl.LINES, 0, 2);
            gl.uniform3f(uniforms.lines.color, 0.42, 0.85, 0.5);
            gl.drawArrays(gl.LINES, 2, 2);
            gl.uniform3f(uniforms.lines.color, 0.42, 0.62, 0.95);
            gl.drawArrays(gl.LINES, 4, 2);
          }

          // Measurement overlay: segments between picked points plus a small cross
          // at each point, drawn with the same line program as the axes.
          const measurePoints = measurePointsRef.current;
          if (measurePoints.length) {
            const marks = [];
            for (let index = 0; index + 1 < measurePoints.length; index += 1) {
              marks.push(...measurePoints[index], ...measurePoints[index + 1]);
            }
            const arm = view.radius * 0.035;
            for (const point of measurePoints) {
              marks.push(point[0] - arm, point[1], point[2], point[0] + arm, point[1], point[2]);
              marks.push(point[0], point[1] - arm, point[2], point[0], point[1] + arm, point[2]);
              marks.push(point[0], point[1], point[2] - arm, point[0], point[1], point[2] + arm);
            }
            gl.useProgram(lines);
            gl.bindBuffer(gl.ARRAY_BUFFER, axisBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(marks), gl.STREAM_DRAW);
            gl.enableVertexAttribArray(attributes.lines.position);
            gl.vertexAttribPointer(attributes.lines.position, 3, gl.FLOAT, false, 12, 0);
            gl.depthFunc(gl.LEQUAL);
            gl.uniform3f(uniforms.lines.color, 0.98, 0.62, 0.16);
            gl.drawArrays(gl.LINES, 0, marks.length / 3);
            gl.depthFunc(gl.LESS);
          }

          if (spotTriangle >= 0) {
            const start = spotTriangle * 9;
            if (start >= 0 && start + 8 < positions.length) {
              const outline = new Float32Array([
                positions[start], positions[start + 1], positions[start + 2],
                positions[start + 3], positions[start + 4], positions[start + 5],
                positions[start + 6], positions[start + 7], positions[start + 8],
              ]);
              // Filled face first, so the live triangle is unmistakable even when the
              // rest of the model is faded to a ghost.
              if (options.faces) {
                gl.useProgram(solid);
                gl.bindBuffer(gl.ARRAY_BUFFER, axisBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, outline, gl.STREAM_DRAW);
                gl.enableVertexAttribArray(attributes.solid.position);
                gl.vertexAttribPointer(attributes.solid.position, 3, gl.FLOAT, false, 12, 0);
                if (attributes.solid.normal >= 0) gl.disableVertexAttribArray(attributes.solid.normal);
                gl.uniformMatrix4fv(uniforms.solid.mvp, false, mvp);
                gl.uniformMatrix4fv(uniforms.solid.view, false, camera);
                gl.uniformMatrix4fv(uniforms.solid.model, false, identity);
                gl.uniform3f(uniforms.solid.color, 1.0, 0.78, 0.24);
                gl.uniform1f(uniforms.solid.fog, 0);
                gl.uniform1f(uniforms.solid.far, distance);
                gl.uniform1f(uniforms.solid.normals, 0);
                gl.uniform1f(uniforms.solid.dim, 0);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.depthMask(true);
                gl.disable(gl.BLEND);
              }
              gl.useProgram(lines);
              gl.bindBuffer(gl.ARRAY_BUFFER, axisBuffer);
              gl.bufferData(gl.ARRAY_BUFFER, outline, gl.STREAM_DRAW);
              gl.enableVertexAttribArray(attributes.lines.position);
              gl.vertexAttribPointer(attributes.lines.position, 3, gl.FLOAT, false, 12, 0);
              gl.depthFunc(gl.LEQUAL);
              gl.uniform3f(uniforms.lines.color, 1.0, 0.78, 0.24);
              gl.drawArrays(gl.LINE_LOOP, 0, 3);
              gl.depthFunc(gl.LESS);
            }
          }
          publishDiag({ error: gl.getError() });
        };
        drawRef.current = render;

        // A hovered mark only changes the overlay, so repaint without rebuilding.
        const repaint = () => {
          if (drawRef.current) drawRef.current();
        };
        repaintRef.current = repaint;

        // Click picking: build a ray through the clicked pixel and take the
        // nearest triangle hit, so a model can be annotated like any other file.
        pickRef.current = (clientX, clientY) => {
          const soup = meshRef.current;
          if (!soup) return null;
          const rect = canvas.getBoundingClientRect();
          const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
          const ndcY = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
          const view = viewRef.current;
          const basis = cameraBasis(view);
          const tanHalf = Math.tan(Math.PI / 8);
          const aspect = rect.width / Math.max(1, rect.height);
          const dir = [
            basis.forward[0] + basis.right[0] * ndcX * tanHalf * aspect + basis.up[0] * ndcY * tanHalf,
            basis.forward[1] + basis.right[1] * ndcX * tanHalf * aspect + basis.up[1] * ndcY * tanHalf,
            basis.forward[2] + basis.right[2] * ndcX * tanHalf * aspect + basis.up[2] * ndcY * tanHalf,
          ];
          const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          dir[0] /= length;
          dir[1] /= length;
          dir[2] /= length;
          const pan = view.pan || [0, 0, 0];
          const target = [view.center[0] + pan[0], view.center[1] + pan[1], view.center[2] + pan[2]];
          const origin = [
            target[0] + view.distance * Math.cos(view.pitch) * Math.sin(view.yaw),
            target[1] + view.distance * Math.sin(view.pitch),
            target[2] + view.distance * Math.cos(view.pitch) * Math.cos(view.yaw),
          ];
          let best = Infinity;
          let bestTriangle = -1;
          let bestPoint = null;
          for (let at = 0; at + 8 < soup.length; at += 9) {
            const ax = soup[at], ay = soup[at + 1], az = soup[at + 2];
            const bx = soup[at + 3], by = soup[at + 4], bz = soup[at + 5];
            const cx = soup[at + 6], cy = soup[at + 7], cz = soup[at + 8];
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            const px = dir[1] * e2z - dir[2] * e2y;
            const py = dir[2] * e2x - dir[0] * e2z;
            const pz = dir[0] * e2y - dir[1] * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-9) continue;
            const inv = 1 / det;
            const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
            const u = (tx * px + ty * py + tz * pz) * inv;
            if (u < 0 || u > 1) continue;
            const qx = ty * e1z - tz * e1y;
            const qy = tz * e1x - tx * e1z;
            const qz = tx * e1y - ty * e1x;
            const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
            if (v < 0 || u + v > 1) continue;
            const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (distance > 1e-6 && distance < best) {
              best = distance;
              bestTriangle = at / 9;
              bestPoint = [origin[0] + dir[0] * distance, origin[1] + dir[1] * distance, origin[2] + dir[2] * distance];
            }
          }
          if (bestTriangle < 0) return null;
          return { triangle: bestTriangle, point: bestPoint };
        };

        // Pan moves the target along the camera's screen axes, not world X/Y.
        const cameraBasis = (view) => {
          const dir = [
            Math.cos(view.pitch) * Math.sin(view.yaw),
            Math.sin(view.pitch),
            Math.cos(view.pitch) * Math.cos(view.yaw),
          ];
          const forward = [-dir[0], -dir[1], -dir[2]];
          const rightRaw = [-forward[2], 0, forward[0]];
          const rightLength = Math.hypot(rightRaw[0], rightRaw[1], rightRaw[2]) || 1;
          const right = [rightRaw[0] / rightLength, rightRaw[1] / rightLength, rightRaw[2] / rightLength];
          const up = [
            right[1] * forward[2] - right[2] * forward[1],
            right[2] * forward[0] - right[0] * forward[2],
            right[0] * forward[1] - right[1] * forward[0],
          ];
          return { right, up, forward };
        };
        const panBy = (view, rightAmount, upAmount) => {
          const basis = cameraBasis(view);
          if (!view.pan) view.pan = [0, 0, 0];
          for (let axis = 0; axis < 3; axis += 1) {
            view.pan[axis] += basis.right[axis] * rightAmount + basis.up[axis] * upAmount;
          }
        };

        let dragging = 0;
        let lastX = 0;
        let lastY = 0;
        const onDown = (event) => {
          dragging = event.button === 0 && !event.shiftKey ? 1 : 2;
          lastX = event.clientX;
          lastY = event.clientY;
          dragMovedRef.current = false;
          canvas.setPointerCapture(event.pointerId);
        };
        const onMove = (event) => {
          if (!dragging) return;
          const view = viewRef.current;
          const deltaX = event.clientX - lastX;
          const deltaY = event.clientY - lastY;
          lastX = event.clientX;
          lastY = event.clientY;
          if (Math.abs(deltaX) + Math.abs(deltaY) > 2) dragMovedRef.current = true;
          if (dragging === 2) {
            const scale = view.distance * 0.0016;
            panBy(view, -deltaX * scale, deltaY * scale);
          } else {
            view.yaw -= deltaX * 0.01;
            view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + deltaY * 0.01));
          }
          render();
        };
        const onUp = () => {
          dragging = 0;
        };
        const onWheel = (event) => {
          event.preventDefault();
          const view = viewRef.current;
          const rect = canvas.getBoundingClientRect();
          const nx = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
          const ny = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
          const factor = 1 + Math.sign(event.deltaY) * 0.12;
          // Keep the point under the cursor roughly fixed while zooming.
          const shift = view.distance * (factor - 1) * 0.55;
          panBy(view, nx * shift, -ny * shift);
          view.distance = Math.max(view.radius * 0.05, Math.min(view.radius * 400, view.distance * factor));
          render();
        };
        const onDoubleClick = (event) => {
          const view = viewRef.current;
          const rect = canvas.getBoundingClientRect();
          const nx = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
          const ny = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
          panBy(view, nx * view.distance, -ny * view.distance);
          view.distance = Math.max(view.radius * 0.1, view.distance * 0.72);
          render();
        };
        const onContext = (event) => event.preventDefault();

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDoubleClick);
        canvas.addEventListener('contextmenu', onContext);
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => render()) : null;
        if (observer) observer.observe(canvas);
        render();
        return () => {
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('dblclick', onDoubleClick);
          canvas.removeEventListener('contextmenu', onContext);
          if (observer) observer.disconnect();
          if (attributes.solid.normal >= 0) gl.disableVertexAttribArray(attributes.solid.normal);
          if (attributes.solid.position >= 0) gl.disableVertexAttribArray(attributes.solid.position);
          if (attributes.lines.position >= 0) gl.disableVertexAttribArray(attributes.lines.position);
          gl.deleteBuffer(solidBuffer);
          if (lineBuffer) gl.deleteBuffer(lineBuffer);
          gl.deleteBuffer(axisBuffer);
        };
      }, [state.status, options, doc.path]);

      // F resets the camera, Shift+F frames the model again, 1-7 pick a view.
      React.useEffect(() => {
        const PRESETS = {
          '1': [0, 0],
          '2': [Math.PI, 0],
          '3': [Math.PI / 2, 0],
          '4': [-Math.PI / 2, 0],
          '5': [0, 1.5],
          '6': [0, -1.5],
          '7': [0.72, 0.42],
        };
        const onKey = (event) => {
          if (!ownsKeyboard(event, rootRef.current)) return;
          const view = viewRef.current;
          if (Object.prototype.hasOwnProperty.call(PRESETS, event.key)) {
            event.preventDefault();
            view.yaw = PRESETS[event.key][0];
            view.pitch = PRESETS[event.key][1];
            view.pan = [0, 0, 0];
            
            view.distance = view.radius / Math.tan(Math.PI / 8) + view.radius;
            drawRef.current();
            return;
          }
          if (event.key !== 'f' && event.key !== 'F') return;
          event.preventDefault();
          view.pan = [0, 0, 0];
          
          if (event.shiftKey) {
            view.yaw = 0.72;
            view.pitch = 0.42;
          }
          view.distance = view.radius / Math.tan(Math.PI / 8) + view.radius;
          drawRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const hoverToken = useHoverMark(doc.path);
      React.useEffect(() => {
        repaintRef.current();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hoverToken && hoverToken.id]);


      if (state.status === 'failed') return h('div', { className: 'dshcv-empty' }, h('div', null, '无法预览该模型'), h('div', null, state.error));
      const stats = state.stats;
      const toggle = (key) => setOptions((previous) => Object.assign({}, previous, { [key]: !previous[key] }));
      return h(
        'div',
        { ref: rootRef, style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h('span', { className: 'dshcv-msg' }, state.status === 'ready' ? state.info : '解析模型…'),
          state.status === 'loading' && progress > 0 ? h('span', { className: 'dshcv-msg' }, Math.round(progress * 100) + '%') : null,
          stats
            ? h(
                'span',
                { className: 'dshcv-msg', title: '包围盒尺寸 / 表面积 / 体积 / 封闭性' },
                '尺寸 ' + stats.size.map((value) => value.toFixed(2)).join(' × ') +
                  ' · 面积 ' + stats.area.toFixed(2) +
                  ' · 体积 ' + stats.volume.toFixed(2) +
                  (stats.watertight === null ? '' : stats.watertight ? ' · 封闭' : ' · 有破面') +
                  ' · 顶点 ' + stats.vertices.toLocaleString(),
              )
            : null,
h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn dshcv-more',
              title: '显示全部工具',
              onClick: (event) => {
                const row = event.currentTarget.parentElement;
                if (row) row.classList.toggle('dshcv-expanded');
              },
            },
            '⋯',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-toggle',
              'aria-pressed': options.faces ? 'true' : 'false',
              title: '显示实体面（关掉后只看线框）',
              onClick: () => toggle('faces'),
            },
            '面',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-toggle',
              'aria-pressed': options.edges ? 'true' : 'false',
              title: '显示三角边',
              onClick: () => toggle('edges'),
            },
            '边',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-toggle',
              'aria-pressed': options.hiddenLine ? 'true' : 'false',
              disabled: options.faces,
              title: options.faces ? '仅在线框模式下可用：隐藏被面挡住的边' : '隐藏被挡住的边（关闭则透视显示整个线架）',
              onClick: () => toggle('hiddenLine'),
            },
            '消隐',
          ),
          // Exclusive modes read better as one segmented control than as two switches.
          h(
            'div',
            { className: 'dshcv-seg', role: 'group', 'aria-label': '测量模式' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                'aria-pressed': measure.mode === 'distance' ? 'true' : 'false',
                title: '点两处测量距离',
                onClick: () => setMeasure({ mode: measure.mode === 'distance' ? '' : 'distance', points: [], result: '' }),
              },
              '测距',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                'aria-pressed': measure.mode === 'angle' ? 'true' : 'false',
                title: '点三处测量夹角（中间点为顶点）',
                onClick: () => setMeasure({ mode: measure.mode === 'angle' ? '' : 'angle', points: [], result: '' }),
              },
              '测角',
            ),
          ),
          measure.result
            ? h(
                'span',
                { className: 'dshcv-msg', title: '数值来自点击位置的世界坐标' },
                measure.result,
              )
            : null,
          measure.points.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  onClick: () =>
                    addMark({
                      kind: 'spot',
                      path: doc.path,
                      label: measure.result || '测量',
                      quote: measure.points.map((point) => point.map((value) => value.toFixed(3)).join(', ')).join('  →  '),
                    }),
                },
                '标注测量',
              )
            : null,
          measure.points.length
            ? h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', onClick: () => setMeasure({ mode: measure.mode, points: [], result: '' }) }, '清除测量')
            : null,
          h('button', { type: 'button', className: 'dshcv-toggle dshcv-opt', 'aria-pressed': options.normals ? 'true' : 'false', title: '按法线方向着色', onClick: () => toggle('normals') }, '法线'),
          h('button', { type: 'button', className: 'dshcv-toggle dshcv-opt', 'aria-pressed': options.fog ? 'true' : 'false', title: '远近雾化', onClick: () => toggle('fog') }, '雾'),
          h('button', { type: 'button', className: 'dshcv-toggle dshcv-opt', 'aria-pressed': options.axes ? 'true' : 'false', title: '显示世界坐标轴', onClick: () => toggle('axes') }, '坐标轴'),
          diag.error
            ? h(
                'span',
                {
                  className: 'dshcv-msg',
                  style: { color: 'var(--dsw-alias-warning,#c28b00)' },
                  title: 'WebGL 调用出错，画面可能不完整；按 ? 打开帮助可查看渲染计数',
                },
                'GL ' + diag.error,
              )
            : debugRender()
              ? h(
                  'span',
                  { className: 'dshcv-msg', title: '三角形数 · 线顶点数（调试）' },
                  '△ ' + diag.triangles.toLocaleString() + ' · ‖ ' + diag.lineVertices.toLocaleString(),
                )
              : null,
          options.edges && options.faces && diag.lineVertices === 0 && diag.triangles > 0
            ? h('span', { className: 'dshcv-msg', title: '面数超过 40 万时不生成描边，切到线框仍会显示全部边' }, '描边已省略')
            : null,
          notice ? h('span', { className: 'dshcv-msg' }, notice) : null,
        ),
        h('div', { className: 'dshcv-3dwrap' }, h('canvas', {
          ref: canvasRef,
          className: 'dshcv-canvas3d',
          onClick: (event) => {
            if (dragMovedRef.current) return;
            const hit = pickRef.current(event.clientX, event.clientY);
            if (!hit) return;
            // While measuring, a click contributes a point instead of a triangle mark.
            if (measure.mode) {
              const cap = measure.mode === 'angle' ? 3 : 2;
              const points = measure.points.concat([hit.point]).slice(-cap);
              setMeasure({ mode: measure.mode, points, result: describeMeasure(measure.mode, points) });
              repaintRef.current();
              return;
            }
            // A triangle index alone means nothing outside this exact file version, so
            // the mark carries the face itself: three corners, normal, area and a coarse
            // place in the bounding box.
            const soup = meshRef.current;
            const base = hit.triangle * 9;
            const details = { triangle: hit.triangle };
            if (soup && base >= 0 && base + 8 < soup.length) {
              const corner = (offset) => [soup[base + offset * 3], soup[base + offset * 3 + 1], soup[base + offset * 3 + 2]];
              const corners = [corner(0), corner(1), corner(2)];
              const edgeA = [corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]];
              const edgeB = [corners[2][0] - corners[0][0], corners[2][1] - corners[0][1], corners[2][2] - corners[0][2]];
              const cross = [
                edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
                edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
                edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
              ];
              const length = Math.hypot(cross[0], cross[1], cross[2]);
              const centroid = [
                (corners[0][0] + corners[1][0] + corners[2][0]) / 3,
                (corners[0][1] + corners[1][1] + corners[2][1]) / 3,
                (corners[0][2] + corners[1][2] + corners[2][2]) / 3,
              ];
              const middle = viewRef.current.center;
              const span = Math.max(1e-6, viewRef.current.radius || 1);
              const side = (value, axis) => {
                const delta = value - middle[axis];
                return delta < -span * 0.18 ? -1 : delta > span * 0.18 ? 1 : 0;
              };
              const axisWord = (() => {
                const x = ['左', '中', '右'][side(centroid[0], 0) + 1];
                const y = ['下', '中', '上'][side(centroid[1], 1) + 1];
                const z = ['后', '中', '前'][side(centroid[2], 2) + 1];
                return x + '·' + y + '·' + z;
              })();
              Object.assign(details, {
                vertices: corners.map((point) => point.map((value) => Math.round(value * 1000) / 1000)),
                normal: length > 0 ? cross.map((value) => Math.round((value / length) * 1000) / 1000) : [0, 0, 1],
                area: Math.round((length / 2) * 10000) / 10000,
                centroid: centroid.map((value) => Math.round(value * 1000) / 1000),
                place: axisWord,
                triangles: Math.round(soup.length / 9),
              });
            }
            addMark({
              kind: 'spot',
              path: doc.path,
              label: '三角面 #' + hit.triangle + (details.triangles ? '（共 ' + details.triangles.toLocaleString() + ' 面）' : ''),
              quote: hit.point.map((value) => value.toFixed(3)).join(', '),
              ...details,
            });
          },
        })),
        h('div', { className: 'dshcv-tools' }, h('span', { className: 'dshcv-msg' }, '左键旋转 · 右键/Shift 拖动平移 · 滚轮缩放 · 双击居中 · 1-5 前/后/右/左/顶 · 6 底 · 7 等轴测 · F 复位')),
      );
    }

    // Vertex clustering: cheap decimation that keeps the silhouette when a mesh
    // is far too heavy for an interactive preview.
    const MAX_PREVIEW_TRIANGLES = 800000;
    const decimateMesh = (positions, target) => {
      const triangles = positions.length / 9;
      if (triangles <= target) return { positions, reduced: false, triangles };
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let index = 0; index < positions.length; index += 3) {
        if (positions[index] < minX) minX = positions[index];
        if (positions[index] > maxX) maxX = positions[index];
        if (positions[index + 1] < minY) minY = positions[index + 1];
        if (positions[index + 1] > maxY) maxY = positions[index + 1];
        if (positions[index + 2] < minZ) minZ = positions[index + 2];
        if (positions[index + 2] > maxZ) maxZ = positions[index + 2];
      }
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
      const resolution = Math.max(8, Math.min(512, Math.round(Math.sqrt(target / 2))));
      const cell = span / resolution;
      const representatives = new Map();
      const remap = (x, y, z) => {
        const key =
          Math.floor((x - minX) / cell) + ',' + Math.floor((y - minY) / cell) + ',' + Math.floor((z - minZ) / cell);
        const seen = representatives.get(key);
        if (seen) return seen;
        const entry = { key, x, y, z };
        representatives.set(key, entry);
        return entry;
      };
      const out = [];
      for (let index = 0; index < positions.length; index += 9) {
        const a = remap(positions[index], positions[index + 1], positions[index + 2]);
        const b = remap(positions[index + 3], positions[index + 4], positions[index + 5]);
        const c = remap(positions[index + 6], positions[index + 7], positions[index + 8]);
        if (a.key === b.key || b.key === c.key || a.key === c.key) continue;
        out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
      if (!out.length) return { positions, reduced: false, triangles };
      return { positions: new Float32Array(out), reduced: true, triangles: out.length / 9 };
    };

    // ---------------- cad drawings: dxf entities in, svg out ----------------
    const parseDxf = (text) => {
      const lines = String(text || '').split(/\r\n|\r|\n/);
      const pairs = [];
      for (let index = 0; index + 1 < lines.length; index += 2) {
        pairs.push([lines[index].trim(), lines[index + 1]]);
      }
      const entities = [];
      let inEntities = false;
      let current = null;
      for (const [code, rawValue] of pairs) {
        const value = String(rawValue || '').trim();
        if (code === '0') {
          if (current && current.type) entities.push(current);
          current = value === 'ENTITIES' ? null : { type: value, values: [] };
          inEntities = value === 'ENTITIES';
          if (value === 'ENDSEC') {
            inEntities = false;
            current = null;
          }
          continue;
        }
        if (current && value !== '') {
          if (code === '8') current.layer = rawValue;
          current.values.push([code, rawValue]);
        }
      }
      if (current && current.type) entities.push(current);
      return entities.filter((entity) => ['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'POINT', 'SOLID'].includes(entity.type));
    };

    const dxfToShapes = (entities) => {
      const shapes = [];
      const layerOf = (entity) => (entity.layer && String(entity.layer).trim()) || '0';
      const numbers = (entity) => entity.values.filter(([code]) => code === '10' || code === '20' || code === '11' || code === '21' || code === '40' || code === '50' || code === '51' || code === '42');
      const first = (entity, code) => {
        const hit = entity.values.find(([candidate]) => candidate === code);
        return hit ? Number(hit[1]) : 0;
      };
      for (const entity of entities) {
        const before = shapes.length;
        if (entity.type === 'LINE') {
          shapes.push({ kind: 'line', a: [first(entity, '10'), first(entity, '20')], b: [first(entity, '11'), first(entity, '21')] });
        } else if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
          const center = [first(entity, '10'), first(entity, '20')];
          const radius = first(entity, '40');
          if (entity.type === 'CIRCLE') {
            shapes.push({ kind: 'circle', center, radius });
          } else {
            shapes.push({ kind: 'arc', center, radius, start: first(entity, '50'), end: first(entity, '51') });
          }
        } else if (entity.type === 'LWPOLYLINE') {
          const points = [];
          let pendingX = null;
          for (const [code, raw] of entity.values) {
            if (code === '10') pendingX = Number(raw);
            else if (code === '20' && pendingX !== null) {
              points.push([pendingX, Number(raw)]);
              pendingX = null;
            }
          }
          if (points.length) shapes.push({ kind: 'polyline', points, closed: (first(entity, '70') & 1) === 1 });
        } else if (entity.type === 'TEXT' || entity.type === 'MTEXT') {
          const label = entity.values
            .filter(([code]) => code === '1' || code === '3')
            .map(([, raw]) => raw)
            .join(' ')
            .trim();
          if (label) shapes.push({ kind: 'text', at: [first(entity, '10'), first(entity, '20')], label, height: first(entity, '40') || 2.5 });
        } else if (entity.type === 'POINT') {
          shapes.push({ kind: 'point', at: [first(entity, '10'), first(entity, '20')] });
        }
        for (let index = before; index < shapes.length; index += 1) shapes[index].layer = layerOf(entity);
        void numbers;
      }
      return shapes;
    };

    function CadDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', error: '', shapes: [], info: '' });
      const [zoom, setZoom] = React.useState({ scale: 1, panX: 0, panY: 0 });
      const [hidden, setHidden] = React.useState(() => new Set());
      const wrapRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const hoverShape = useHoverMark(doc.path);

      React.useEffect(() => {
        if (!sessionId) return undefined;
        const controller = new AbortController();
        let cancelled = false;
        readTextPages(sessionId, doc.path, controller.signal, 40)
          .then((page) => {
            if (cancelled) return;
            const entities = parseDxf(page.text);
            const shapes = dxfToShapes(entities);
            setState({ status: 'ready', error: '', shapes, info: entities.length + ' 个实体 · ' + shapes.length + ' 个可绘制元素' });
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'failed', error: errText(error), shapes: [], info: '' });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [doc.path, sessionId]);

      const extents = React.useMemo(() => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const visit = (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        };
        for (const shape of state.shapes) {
          if (shape.points) for (const [x, y] of shape.points) visit(x, y);
          if (shape.a) visit(shape.a[0], shape.a[1]);
          if (shape.b) visit(shape.b[0], shape.b[1]);
          if (shape.center) {
            visit(shape.center[0] - shape.radius, shape.center[1] - shape.radius);
            visit(shape.center[0] + shape.radius, shape.center[1] + shape.radius);
          }
          if (shape.at) visit(shape.at[0], shape.at[1]);
        }
        if (!Number.isFinite(minX)) return { x: -1, y: -1, width: 2, height: 2 };
        const pad = Math.max((maxX - minX) * 0.05, (maxY - minY) * 0.05, 1);
        return { x: minX - pad, y: -maxY - pad, width: Math.max(maxX - minX + pad * 2, 1e-3), height: Math.max(maxY - minY + pad * 2, 1e-3) };
      }, [state.shapes]);

      const layers = React.useMemo(() => {
        const found = [];
        for (const shape of state.shapes) {
          const layer = shape.layer || '0';
          if (!found.includes(layer)) found.push(layer);
        }
        return found;
      }, [state.shapes]);

      const fit = () => setZoom({ scale: 1, panX: 0, panY: 0 });

      const renderShape = (shape, index) => {
        if (shape.kind === 'line') {
          return h('line', { key: index, x1: shape.a[0], y1: -shape.a[1], x2: shape.b[0], y2: -shape.b[1] });
        }
        if (shape.kind === 'polyline') {
          const points = shape.points.map(([x, y]) => x + ',' + -y).join(' ');
          return shape.closed ? h('polygon', { key: index, points }) : h('polyline', { key: index, points });
        }
        if (shape.kind === 'circle') {
          return h('circle', { key: index, cx: shape.center[0], cy: -shape.center[1], r: shape.radius });
        }
        if (shape.kind === 'arc') {
          const sweep = (((shape.end - shape.start) % 360) + 360) % 360 || 360;
          const startRad = (shape.start * Math.PI) / 180;
          const endRad = ((shape.start + sweep) * Math.PI) / 180;
          const x1 = shape.center[0] + shape.radius * Math.cos(startRad);
          const y1 = -(shape.center[1] + shape.radius * Math.sin(startRad));
          const x2 = shape.center[0] + shape.radius * Math.cos(endRad);
          const y2 = -(shape.center[1] + shape.radius * Math.sin(endRad));
          return h('path', {
            key: index,
            d: 'M ' + x1 + ' ' + y1 + ' A ' + shape.radius + ' ' + shape.radius + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 0 ' + x2 + ' ' + y2,
          });
        }
        if (shape.kind === 'text') {
          return h('text', { key: index, x: shape.at[0], y: -shape.at[1], fontSize: Math.max(shape.height, 1) }, shape.label);
        }
        return h('circle', { key: index, cx: shape.at[0], cy: -shape.at[1], r: 0.6 });
      };

      // Pan and zoom work in drawing units so the cursor stays over its point.
      const toUnits = (pixels, along, box) => (pixels * (along === 'x' ? extents.width : extents.height)) / Math.max(1, box.width || box.height);

      const onPointerDown = (event) => {
        dragRef.current = { x: event.clientX, y: event.clientY };
        if (event.currentTarget && event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        const box = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
        if (!drag || !box) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        dragRef.current = { x: event.clientX, y: event.clientY };
        setZoom((value) => Object.assign({}, value, {
          panX: value.panX - toUnits(dx, 'x', box) / value.scale,
          panY: value.panY - toUnits(dy, 'y', box) / value.scale,
        }));
      };
      const onPointerUp = () => {
        dragRef.current = null;
      };
      const onWheel = (event) => {
        if (!wrapRef.current) return;
        event.preventDefault();
        const box = wrapRef.current.getBoundingClientRect();
        const nx = (event.clientX - box.left) / Math.max(1, box.width) - 0.5;
        const ny = (event.clientY - box.top) / Math.max(1, box.height) - 0.5;
        setZoom((value) => {
          const factor = Math.sign(event.deltaY) > 0 ? 1 / 1.18 : 1.18;
          const scale = Math.max(0.15, Math.min(60, value.scale * factor));
          const ratio = (value.scale / scale) - 1;
          return {
            scale,
            panX: value.panX + nx * extents.width * ratio,
            panY: value.panY + ny * extents.height * ratio,
          };
        });
      };

      if (state.status === 'failed') return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取该图纸'), h('div', null, state.error));
      if (state.status !== 'ready') return h('div', { className: 'dshcv-empty' }, h('div', null, '解析图纸…'));

      const viewBox = [
        extents.x + zoom.panX,
        extents.y + zoom.panY,
        extents.width / zoom.scale,
        extents.height / zoom.scale,
      ];
      const visible = state.shapes.filter((shape) => !hidden.has(shape.layer || '0'));
      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h('span', { className: 'dshcv-msg' }, state.info),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: fit }, '适应窗口'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom((value) => Object.assign({}, value, { scale: value.scale * 1.4 })) }, '放大'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom((value) => Object.assign({}, value, { scale: Math.max(0.15, value.scale / 1.4) })) }, '缩小'),
          layers.length > 1
            ? h(
                'span',
                { className: 'dshcv-layers' },
                layers.slice(0, 12).map((layer) =>
                  h(
                    'button',
                    {
                      key: layer,
                      type: 'button',
                      className: 'dshcv-chip',
                      'data-on': hidden.has(layer) ? '0' : '1',
                      title: hidden.has(layer) ? '显示该图层' : '隐藏该图层',
                      onClick: () =>
                        setHidden((value) => {
                          const next = new Set(value);
                          if (next.has(layer)) next.delete(layer);
                          else next.add(layer);
                          return next;
                        }),
                    },
                    layer,
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          {
            ref: wrapRef,
            className: 'dshcv-cadwrap',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onWheel,
            onDoubleClick: fit,
          },
          h(
            'svg',
            { viewBox: viewBox.join(' '), preserveAspectRatio: 'xMidYMid meet' },
            visible.map((shape, index) =>
              h(
                'g',
                {
                  key: index,
                  'data-shape': index,
                  className:
                    hoverShape && hoverShape.kind === 'spot'
                      ? hoverShape.shapeIndex === index
                        ? 'dshcv-cadhit'
                        : 'dshcv-dim'
                      : undefined,
                  style: { cursor: 'pointer' },
                  onClick: () =>
                    addMark({
                      kind: 'spot',
                      path: doc.path,
                      label: (shape.layer || '0') + ' · ' + String(shape.kind).toUpperCase(),
                      quote: shape.label || '',
                      shapeIndex: index,
                    }),
                },
                renderShape(shape, index),
              ),
            ),
          ),
        ),
        h('div', { className: 'dshcv-tools' }, h('span', { className: 'dshcv-msg' }, '拖动平移 · 滚轮朝光标缩放 · 双击适应窗口')),
      );
    }

    function UnsupportedDoc(props) {
      const { doc } = props;
      const match = /\.([a-z0-9]+)$/i.exec(doc.path);
      const extension = match ? match[1].toUpperCase() : '该';
      return h(
        'div',
        { className: 'dshcv-empty' },
        h('div', null, extension + ' 需要专业内核，暂不支持预览'),
        h('div', null, '可导出为 .glb / .obj / .stl（三维）或 .dxf（二维图纸）后在面板中查看：'),
        h('code', null, doc.path),
      );
    }

    // ---------------- image viewer with region / layer picking ----------------
    function ImageDoc(props) {
      const { doc, sessionId } = props;
      const [state, setState] = React.useState({ status: 'idle', url: '', error: '' });
      const [zoom, setZoom] = React.useState(1);
      const [selecting, setSelecting] = React.useState(false);
      const [marquee, setMarquee] = React.useState(null);
      // Animated images (GIF/APNG/WebP) play natively in <img>. Freezing keeps the
      // frame you are looking at, the way the html viewer's pause does.
      const [frozenFrame, setFrozenFrame] = React.useState(null);
      const animatedImage = /\.(gif|apng|webp)$/i.test(String(doc.path || ''));
      const marqueeRef = React.useRef(null);
      const [layers, setLayers] = React.useState([]);
      const imageRef = React.useRef(null);
      const [sample, setSample] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      // Ruler: two clicks give a pixel distance.
      const [ruler, setRuler] = React.useState({ on: false, points: [] });
      const rulerDistance = React.useMemo(() => {
        if (ruler.points.length !== 2) return 0;
        const [a, b] = ruler.points;
        return Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 10) / 10;
      }, [ruler.points]);
      const sampleCanvasRef = React.useRef(null);
      const hoverMark = useHoverMark(doc.path);
      const hoverRegion = hoverMark && hoverMark.kind === 'region' && Array.isArray(hoverMark.rect) ? hoverMark : null;
      const imageNode = imageRef.current;
      const displayFactor = imageNode && imageNode.naturalWidth && imageNode.clientWidth ? imageNode.naturalWidth / imageNode.clientWidth : 1;

      // Pixel sampling needs the raster in a canvas we control; an <img> cannot
      // be read back for cross-origin safety reasons once it is a blob.
      const ensureSampleCanvas = () => {
        if (sampleCanvasRef.current) return sampleCanvasRef.current;
        const image = imageRef.current;
        if (!image || !image.naturalWidth) return null;
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(image, 0, 0);
        sampleCanvasRef.current = canvas;
        return canvas;
      };
      const onSample = (event) => {
        if (!event.shiftKey) return;
        const canvas = ensureSampleCanvas();
        const image = imageRef.current;
        if (!canvas || !image) return;
        const rect = image.getBoundingClientRect();
        const x = Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width);
        const y = Math.round(((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height);
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
        const context = canvas.getContext('2d');
        const pixel = context.getImageData(x, y, 1, 1).data;
        setSample({ x, y, r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] });
      };

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

      const hexOf = (pixel) =>
        '#' +
        [pixel.r, pixel.g, pixel.b]
          .map((value) => Number(value || 0).toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();

      // Rasterize the marquee into a PNG blob; both copying and saving use it.
      const cropBlob = async () => {
        const image = imageRef.current;
        const rect = marqueeRef.current;
        const box = naturalRect();
        if (!image || !rect || !box) return null;
        const width = Math.max(1, Math.round(rect.width * box.factor));
        const height = Math.max(1, Math.round(rect.height * box.factor));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(
          image,
          Math.round(rect.left * box.factor),
          Math.round(rect.top * box.factor),
          width,
          height,
          0,
          0,
          width,
          height,
        );
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        return blob ? { blob, width, height } : null;
      };

      const copyCrop = async () => {
        const cropped = await cropBlob();
        if (!cropped) {
          setNotice('先框选一块区域');
          return;
        }
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': cropped.blob })]);
          flash('已复制 ' + cropped.width + ' × ' + cropped.height + ' 的图像');
        } catch {
          setNotice('复制失败：当前环境不允许写剪贴板');
        }
      };

      // Saving writes next to the source as <name>.crop.png, so the crop is a real
      // file the other tools (and the model) can pick up.
      const saveCrop = async () => {
        const cropped = await cropBlob();
        if (!cropped) {
          setNotice('先框选一块区域');
          return;
        }
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.slice(result.indexOf(',') + 1));
          };
          reader.onerror = () => resolve('');
          reader.readAsDataURL(cropped.blob);
        });
        if (!base64) {
          setNotice('无法编码图像');
          return;
        }
        setNotice('正在保存…');
        try {
          const response = await fetch(saveUrl(), {
            method: 'POST',
            mode: 'cors',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: store.sessionId,
              path: doc.path.replace(/(\.[^.\/]+)?$/, '.crop.png'),
              content: base64,
              encoding: 'base64',
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
          flash('已保存 ' + cropped.width + ' × ' + cropped.height + ' 的裁剪');
          setNotice('');
        } catch (error) {
          setNotice('保存失败：' + errText(error));
        }
      };

      // A click on the image either measures (ruler) or records a sample point.
      const onImageClick = (event) => {
        if (!ruler.on) return;
        const box = naturalRect();
        if (!box) return;
        const x = Math.round((event.clientX - box.left) * box.factor);
        const y = Math.round((event.clientY - box.top) * box.factor);
        setRuler({ on: true, points: ruler.points.concat([[x, y]]).slice(-2) });
      };

      const freezeFrame = () => {
        const image = imageRef.current;
        if (!image || !image.naturalWidth) return;
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) return;
        try {
          context.drawImage(image, 0, 0);
          setFrozenFrame(canvas.toDataURL('image/png'));
        } catch (error) {
          flash('无法冻结动图：' + errText(error));
        }
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
          h('button', { type: 'button', className: 'dshcv-toggle', 'aria-pressed': selecting ? 'true' : 'false', onClick: () => setSelecting(!selecting) }, selecting ? '框选中…' : '框选区域'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(Math.max(0.25, zoom - 0.25)) }, '−'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, Math.round(zoom * 100) + '%'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(Math.min(4, zoom + 0.25)) }, '+'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(1) }, '1:1'),
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setZoom(0.25) }, '适应'),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-toggle',
              'aria-pressed': ruler.on ? 'true' : 'false',
              title: '点两处量像素距离',
              onClick: () => setRuler({ on: !ruler.on, points: [] }),
            },
            '标尺',
          ),
          ruler.points.length === 2
            ? h('span', { className: 'dshcv-msg' }, 'Δ ' + rulerDistance + ' px')
            : null,
          sample
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn dshcv-opt',
                  'data-kind': 'quiet',
                  title: '复制这个颜色的 HEX',
                  onClick: () => {
                    copyText(hexOf(sample), '已复制 ' + hexOf(sample));
                  },
                },
                hexOf(sample),
              )
            : h('span', { className: 'dshcv-msg' }, 'Shift 悬停取样'),
          sample
            ? h('span', { className: 'dshcv-msg dshcv-opt2' }, sample.x + ',' + sample.y + ' · a' + (sample.a / 255).toFixed(2))
            : null,
          // Only formats that can animate get a toggle; a static image has nothing
          // to pause, matching the html viewer rule.
          animatedImage && state.status === "ready"
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  title: frozenFrame ? '继续播放动图' : '暂停动图（停在当前帧）',
                  'aria-pressed': Boolean(frozenFrame),
                  onClick: () => (frozenFrame ? setFrozenFrame(null) : freezeFrame()),
                },
                frozenFrame ? '播放' : '暂停',
              )
            : null,
          marquee
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  title: '把框选区域复制为 PNG',
                  onClick: () => copyCrop(),
                },
                '复制区域',
              )
            : null,
          marquee
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  title: '把框选区域保存为 <文件名>.crop.png',
                  onClick: () => saveCrop(),
                },
                '保存区域',
              )
            : null,
          notice ? h('span', { className: 'dshcv-msg' }, notice) : null,
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
              src: frozenFrame || state.url,
              alt: doc.path,
              style: { display: 'block', maxWidth: '100%', userSelect: 'none' },
              draggable: false,
              onMouseMove: onSample,
              onClick: onImageClick,
            }),
            ruler.points.length === 2
              ? h(
                  'svg',
                  {
                    style: {
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'none',
                    },
                  },
                  h('line', {
                    key: 'line',
                    x1: ruler.points[0][0] / displayFactor,
                    y1: ruler.points[0][1] / displayFactor,
                    x2: ruler.points[1][0] / displayFactor,
                    y2: ruler.points[1][1] / displayFactor,
                    stroke: 'var(--dsw-alias-brand-primary)',
                    strokeWidth: 2,
                    strokeDasharray: '6 4',
                  }),
                  ruler.points.map((point, index) =>
                    h('circle', {
                      key: 'p' + index,
                      cx: point[0] / displayFactor,
                      cy: point[1] / displayFactor,
                      r: 4,
                      fill: 'var(--dsw-alias-brand-primary)',
                    }),
                  ),
                )
              : null,
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
            // Rail hover frames the marked region and dims the rest of the image.
            hoverRegion
              ? h('div', {
                  style: {
                    position: 'absolute',
                    left: hoverRegion.rect[0] / displayFactor + 'px',
                    top: hoverRegion.rect[1] / displayFactor + 'px',
                    width: hoverRegion.rect[2] / displayFactor + 'px',
                    height: hoverRegion.rect[3] / displayFactor + 'px',
                    border: '2px solid var(--dsw-alias-brand-primary)',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,.3)',
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

    // A remount driven by a content refresh must not replay the reveal; only a
    // genuine open (nothing played in the last two seconds) animates.
    const panelReveal = { at: 0 };

    // A plugin must never take the whole window down with it. Without a boundary a
    // single render error unmounts the host tree and leaves a blank page, which is
    // how a hook-order slip turns into "clicking canvas whites out the app".
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        const error = this.state.error;
        if (!error) return this.props.children;
        return h(
          'div',
          { className: 'dshcv-empty', style: { alignItems: 'flex-start', gap: '10px' } },
          h('div', { style: { fontSize: '13px' } }, '画布渲染出错，已隔离，界面其余部分不受影响'),
          h(
            'div',
            { style: { font: '11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace', maxWidth: '70ch', opacity: 0.85, overflowWrap: 'anywhere' } },
            String((error && error.message) || error),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
            h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'primary', onClick: () => this.setState({ error: null }) }, '重试'),
            h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                onClick: () => {
                  mutate({ docs: [], activeId: undefined });
                  this.setState({ error: null });
                },
              },
              '关闭所有标签',
            ),
          ),
        );
      }
    }

    const guardPanel = (Component) => (props) => h(PanelBoundary, null, h(Component, props));

        // One viewer per document; both halves of the split render through it.
    const viewerFor = (doc) =>
doc.view === 'html'
        ? h(HtmlDoc, { key: doc.id + '-html', doc, sessionId: store.sessionId, fit: splitState().on })
        : doc.view === 'image'
          ? /\.svg$/i.test(doc.path)
            ? h(SvgDoc, { key: doc.id + '-svg', doc, sessionId: store.sessionId })
            : h(ImageDoc, { key: doc.id + '-image', doc, sessionId: store.sessionId })
          : doc.view === 'video'
          ? h(VideoDoc, {
              key: doc.id + '-video',
              doc,
              sessionId: store.sessionId,
              focused: !splitState().on || (store.splitFocus === 'b' ? doc.id === splitState().secondId : doc.id === store.activeId),
            })
        : doc.view === 'pdf'
            ? h(PdfDoc, { key: doc.id + '-pdf', doc, sessionId: store.sessionId, fit: splitState().on })
            : doc.view === 'model'
              ? h(ModelDoc, { key: doc.id + '-model', doc, sessionId: store.sessionId })
              : doc.view === 'cad'
                ? h(CadDoc, { key: doc.id + '-cad', doc, sessionId: store.sessionId })
                : doc.view === 'unsupported'
                  ? h(UnsupportedDoc, { key: doc.id + '-unsupported', doc })
                  : doc.view === 'design'
                    ? h(DesignDoc, { key: doc.id + '-design', doc, sessionId: store.sessionId })
                  : doc.view === 'office'
              ? h(OfficeDoc, { key: doc.id + '-office', doc, sessionId: store.sessionId })
              : doc.view === 'sheet'
                ? h(SheetDoc, { key: doc.id + '-sheet', doc, sessionId: store.sessionId })
                : h(TextDoc, { key: doc.id + '-text', doc, sessionId: store.sessionId })
;

// Fit a fixed-width preview into a narrow half without reflowing the page inside
// it: the content keeps its own layout width and the whole box is scaled down, so
// a side-by-side pane shows the same page rather than a squashed one.
function FitStage(props) {
  const ref = React.useRef(null);
  const [box, setBox] = React.useState({ width: 0, height: 0 });
  const designWidth = Number(props.designWidth) || 1280;
  const enabled = props.enabled !== false;

  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const width = node.clientWidth || 0;
      const height = node.clientHeight || 0;
      setBox((current) =>
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1 ? current : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const scale = enabled && box.width ? Math.min(1, box.width / designWidth) : 0;
  const scaled = scale > 0 && scale < 0.999;

  return h(
    'div',
    {
      ref,
      className: 'dshcv-fit',
      'data-scaled': scaled ? '1' : '0',
      style: { flex: '1 1 auto', minHeight: 0, position: 'relative', overflow: 'hidden' },
    },
    h(
      'div',
      {
        style: scaled
          ? {
              position: 'absolute',
              top: 0,
              left: 0,
              width: designWidth + 'px',
              height: Math.max(1, Math.round(box.height / scale)) + 'px',
              transform: 'scale(' + scale + ')',
              transformOrigin: 'top left',
              display: 'flex',
              flexDirection: 'column',
            }
          : { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' },
      },
      props.children,
    ),
  );
}

// Drag handle between the two halves. Snaps on release so a half never ends up
// too narrow to read, and double-click returns to an even split.
function SplitDivider(props) {
  const dragging = React.useRef(false);

  const applyFrom = (clientX, clientY, rect, dir) => {
    const raw = dir === 'column' ? (clientY - rect.top) / rect.height : (clientX - rect.left) / rect.width;
    const clamped = Math.min(0.8, Math.max(0.2, raw));
    setSplit({ ratio: Math.round(clamped * 100) / 100 });
  };

  const snap = (ratio) => {
    const steps = [0.3, 0.4, 0.5, 0.6, 0.7];
    for (const step of steps) {
      if (Math.abs(ratio - step) < 0.028) return step;
    }
    return ratio;
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dir = props.dir === 'column' ? 'column' : 'row';
    dragging.current = true;
    const move = (moveEvent) => {
      if (!dragging.current) return;
      applyFrom(moveEvent.clientX, moveEvent.clientY, rect, dir);
    };
    const up = (upEvent) => {
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const raw = dir === 'column' ? (upEvent.clientY - rect.top) / rect.height : (upEvent.clientX - rect.left) / rect.width;
      setSplit({ ratio: snap(Math.min(0.8, Math.max(0.2, Math.round(raw * 100) / 100))) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return h('div', {
    className: 'dshcv-divider',
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': props.dir === 'column' ? 'horizontal' : 'vertical',
    'aria-label': '调整两侧比例',
    title: '拖动调整比例 · 双击复位',
    onPointerDown,
    onDoubleClick: () => setSplit({ ratio: 0.5 }),
    onKeyDown: (event) => {
      const state = splitState();
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.04 : -0.04;
      setSplit({ ratio: Math.min(0.8, Math.max(0.2, Math.round((state.ratio + step) * 100) / 100)) });
    },
  });
}

    // ---------------- video container probe ----------------
    // HTML5 video does not expose a frame rate, but an MP4/MOV carries one: the
    // video track's mdhd gives timescale + duration and stts gives the sample count,
    // so fps = samples / (duration / timescale). WebM has no cheap equivalent here,
    // so the caller falls back to sampling requestVideoFrameCallback.
    const MP4_COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

    const snapFrameRate = (value) => {
      if (!Number.isFinite(value) || value < 5 || value > 240) return null;
      // Nearest wins: 30.0 must not be pulled to 29.97 just because that comes first.
      let best = null;
      let bestGap = Infinity;
      for (const rate of MP4_COMMON_RATES) {
        const gap = Math.abs(value - rate);
        if (gap < bestGap && gap <= rate * 0.005) {
          best = rate;
          bestGap = gap;
        }
      }
      if (best !== null) return best;
      return Math.round(value * 1000) / 1000;
    };

    const readBoxes = (view, start, end) => {
      const boxes = [];
      let offset = start;
      while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
          view.getUint8(offset + 4),
          view.getUint8(offset + 5),
          view.getUint8(offset + 6),
          view.getUint8(offset + 7),
        );
        let header = 8;
        if (size === 1) {
          if (offset + 16 > end) break;
          // 64-bit size: read hi/lo and stay inside the byte range.
          const hi = view.getUint32(offset + 8);
          const lo = view.getUint32(offset + 12);
          size = hi * 4294967296 + lo;
          header = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < header || offset + size > end) break;
        boxes.push({ type, start: offset + header, end: offset + size });
        offset += size;
      }
      return boxes;
    };

    const findBox = (view, boxes, type) => boxes.find((box) => box.type === type) || null;
    const probeMp4FrameRate = (bytes) => {
      try {
        if (!bytes || bytes.byteLength < 16) return null;
        const view = new DataView(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength);
        const top = readBoxes(view, 0, view.byteLength);
        const moov = findBox(view, top, 'moov');
        if (!moov) return null;
        const moovBoxes = readBoxes(view, moov.start, moov.end);
        for (const trak of moovBoxes.filter((box) => box.type === 'trak')) {
          const trakBoxes = readBoxes(view, trak.start, trak.end);
          const mdia = findBox(view, trakBoxes, 'mdia');
          if (!mdia) continue;
          const mdiaBoxes = readBoxes(view, mdia.start, mdia.end);
          const hdlr = findBox(view, mdiaBoxes, 'hdlr');
          const mdhd = findBox(view, mdiaBoxes, 'mdhd');
          if (!hdlr || !mdhd) continue;
          // hdlr: version/flags(4) pre_defined(4) handler_type(4)
          const handler = String.fromCharCode(
            view.getUint8(hdlr.start + 8),
            view.getUint8(hdlr.start + 9),
            view.getUint8(hdlr.start + 10),
            view.getUint8(hdlr.start + 11),
          );
          if (handler !== 'vide') continue;
          const version = view.getUint8(mdhd.start);
          let timescale;
          let duration;
          if (version === 1) {
            timescale = view.getUint32(mdhd.start + 20);
            const hi = view.getUint32(mdhd.start + 24);
            const lo = view.getUint32(mdhd.start + 28);
            duration = hi * 4294967296 + lo;
          } else {
            timescale = view.getUint32(mdhd.start + 12);
            duration = view.getUint32(mdhd.start + 16);
          }
          if (!timescale || !duration) continue;
          const minf = findBox(view, mdiaBoxes, 'minf');
          if (!minf) continue;
          const stbl = findBox(view, readBoxes(view, minf.start, minf.end), 'stbl');
          if (!stbl) continue;
          const stts = findBox(view, readBoxes(view, stbl.start, stbl.end), 'stts');
          if (!stts) continue;
          const entries = view.getUint32(stts.start + 4);
          let samples = 0;
          for (let index = 0; index < entries; index += 1) {
            const at = stts.start + 8 + index * 8;
            if (at + 8 > view.byteLength) break;
            samples += view.getUint32(at);
          }
          if (!samples) continue;
          const fps = snapFrameRate(samples / (duration / timescale));
          if (fps) return fps;
        }
      } catch (error) {
        return null;
      }
      return null;
    };

    // ---------------- video viewer (clip marks and frame regions) ----------------
    const VIDEO_NATIVE = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'];
    const videoExtOf = (path) => (/.([a-z0-9]+)$/i.exec(String(path || '')) || [, ''])[1].toLowerCase();
    const videoMimeOf = (path) => {
      const ext = videoExtOf(path);
      if (ext === 'webm') return 'video/webm';
      if (ext === 'ogv' || ext === 'ogg') return 'video/ogg';
      if (ext === 'mov') return 'video/quicktime';
      return 'video/mp4';
    };

    // A frame is the smallest unit the UI can point at, so every comparison is
    // quantised through it first (float seconds would say "same place" wrong).
    const quantizeTime = (time, fps) => {
      const rate = Number(fps) > 0 ? Number(fps) : 30;
      return Math.round((Number(time) || 0) * rate) / rate;
    };

    // What the mark button does depends only on the in/out pair.
    const clipAction = (inPoint, outPoint, fps) => {
      const rate = Number(fps) > 0 ? Number(fps) : 30;
      const hasIn = inPoint !== null && inPoint !== undefined;
      const hasOut = outPoint !== null && outPoint !== undefined;
      if (hasIn && hasOut && Math.round((outPoint - inPoint) * rate) >= 1) {
        return { kind: 'range', label: '标记区间', start: inPoint, end: outPoint };
      }
      if (hasIn) return { kind: 'point', label: '标记入点', start: inPoint, end: inPoint };
      if (hasOut) return { kind: 'point', label: '标记出点', start: outPoint, end: outPoint };
      return { kind: 'now', label: '标记此刻' };
    };

    // Zoom keeps the time under the cursor pinned while the window shrinks.
    const zoomWindow = (start, span, duration, anchor, factor, minSpan) => {
      const total = Number(duration) || 0;
      if (!total) return { start: 0, span: Infinity };
      const currentSpan = Math.min(total, Number.isFinite(span) ? Math.max(minSpan, span) : total);
      const currentStart = Math.max(0, Math.min(total - currentSpan, Number(start) || 0));
      const nextSpan = Math.min(total, Math.max(minSpan, currentSpan * factor));
      if (nextSpan >= total - 1e-6) return { start: 0, span: Infinity };
      const ratio = currentSpan > 0 ? (anchor - currentStart) / currentSpan : 0.5;
      const nextStart = Math.max(0, Math.min(total - nextSpan, anchor - ratio * nextSpan));
      return { start: nextStart, span: nextSpan };
    };

    function VideoDoc(props) {
      const { doc, sessionId } = props;
      const native = VIDEO_NATIVE.includes(videoExtOf(doc.path));
      const focused = props.focused !== false;
      const [state, setState] = React.useState({ status: native ? 'loading' : 'unsupported', url: '', error: '' });
      const [info, setInfo] = React.useState({ duration: 0, current: 0, playing: false, rate: 1, fps: 30 });
      // Timeline window: span is how many seconds the track shows (Infinity = all).
      const [view, setView] = React.useState({ start: 0, span: Infinity });
      const [drag, setDrag] = React.useState(null);
      const [boxing, setBoxing] = React.useState(false);
      const [marquee, setMarquee] = React.useState(null);
      const [hover, setHover] = React.useState(null);
      const [inPoint, setInPoint] = React.useState(null);
      const [outPoint, setOutPoint] = React.useState(null);
      const [menuAt, setMenuAt] = React.useState(null);
      const [timeDraft, setTimeDraft] = React.useState('');
      const videoRef = React.useRef(null);
      const stageRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const trackRef = React.useRef(null);
      const hoverBase = React.useRef(0);
      // A preview session moves the media element away from the committed time, so
      // it must remember where to put it back and keep timeupdate out of the state.
      const preview = React.useRef({ active: false, origin: 0 });
      const committedAt = React.useRef(0);
      const previewFrame = React.useRef(0);
      const pressRef = React.useRef(null);

      // Hovering a region mark in the rail shows that box on the frame.
      const hovered = useHoverMark(doc.path);
      const hoverRegion =
        hovered && hovered.kind === 'video' && Array.isArray(hovered.rect) && hovered.rect.length === 4 ? hovered : null;

      React.useEffect(() => {
        if (!native) return undefined;
        let cancelled = false;
        let objectUrl = '';
        setState({ status: 'loading', url: '', error: '' });
        readBytesFile(sessionId, doc.path, undefined)
          .then((bytes) => {
            if (cancelled || !bytes) return;
            // The container knows the frame rate even though the element does not.
            const detected = probeMp4FrameRate(bytes);
            if (detected) setInfo((current) => Object.assign({}, current, { fps: detected }));
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: videoMimeOf(doc.path) }));
            setState({ status: 'ready', url: objectUrl, error: '' });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ status: 'failed', url: '', error: errText(error) });
          });
        return () => {
          cancelled = true;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc.path, native]);

      const seek = store.seek;
      // Only a request newer than the one seen at mount may move the playhead, so a
      // stale store.seek cannot replay after a remount.
      const lastSeekStamp = React.useRef(seek && seek.stamp ? seek.stamp : 0);
      React.useEffect(() => {
        if (!seek || !sameFile(seek.path, doc.path)) return;
        if (seek.stamp && seek.stamp <= lastSeekStamp.current) return;
        lastSeekStamp.current = seek.stamp || 0;
        const node = videoRef.current;
        if (!node) return;
        if (Math.abs(node.currentTime - seek.time) < 0.05) return;
        node.currentTime = Math.max(0, Number(seek.time) || 0);
        committedAt.current = Date.now();
        setInfo((current) => Object.assign({}, current, { current: node.currentTime }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [seek && seek.stamp, doc.path]);

      React.useEffect(() => {
        if (focused) return;
        const node = videoRef.current;
        if (node && !node.paused) node.pause();
      }, [focused]);

      const video = () => videoRef.current;
      const fps = info.fps || 30;
      const frame = 1 / fps;
      const quantize = (time) => quantizeTime(time, fps);

      // ---- timeline window ----
      const duration = info.duration || 0;
      const fullSpan = duration || 1;
      const minSpan = Math.max(frame * 2, Math.min(1, fullSpan));
      const span = Math.min(fullSpan, Number.isFinite(view.span) ? Math.max(minSpan, view.span) : fullSpan);
      const zoomed = span < fullSpan - 1e-6;
      const viewStart = Math.max(0, Math.min(fullSpan - span, view.start));
      const viewEnd = viewStart + span;

      const timeToPercent = (time) => ((Math.max(viewStart, Math.min(viewEnd, time)) - viewStart) / span) * 100;
      const timeFromClientX = (clientX) => {
        const track = trackRef.current;
        if (!track) return 0;
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
        return viewStart + ratio * span;
      };

      const zoomAt = (anchorTime, factor) => {
        setView(zoomWindow(view.start, span, duration, anchorTime, factor, minSpan));
      };

      // Previewing moves the picture, never the committed playhead: the solid
      // marker and the time readout are the truth, the dashed line is the pointer.
      const previewAt = (time) => {
        const node = video();
        if (!node) return;
        // A commit wins: a preview queued just before it must not undo it.
        if (Date.now() - committedAt.current < 200) return;
        if (!preview.current.active) {
          preview.current.active = true;
          preview.current.origin = info.current;
        }
        if (previewFrame.current) cancelAnimationFrame(previewFrame.current);
        previewFrame.current = requestAnimationFrame(() => {
          previewFrame.current = 0;
          const target = Math.min(node.duration || 0, Math.max(0, time || 0));
          if (Math.abs(node.currentTime - target) < 0.01) return;
          node.currentTime = target;
        });
      };
      const cancelPreview = () => {
        if (previewFrame.current) {
          cancelAnimationFrame(previewFrame.current);
          previewFrame.current = 0;
        }
      };
      // Leaving the track, or committing, ends the session; the picture returns to
      // the committed time while the dashed indicator disappears.
      const endPreview = (restore) => {
        cancelPreview();
        if (!preview.current.active) return;
        preview.current.active = false;
        const node = video();
        if (restore && node && Math.abs(node.currentTime - preview.current.origin) > 0.01) {
          node.currentTime = Math.max(0, preview.current.origin);
        }
      };

      // Assigning currentTime before the media is ready throws, and a NaN duration
      // would clamp every target to 0. Queue in that case and never clamp on NaN.
      const applySeek = (node, time) => {
        const requested = Math.max(0, Number(time) || 0);
        const total = Number(node.duration);
        const target = Number.isFinite(total) && total > 0 ? Math.min(total, requested) : requested;
        if (!node.readyState) {
          const once = () => {
            node.currentTime = target;
          };
          node.addEventListener('loadedmetadata', once, { once: true });
          return target;
        }
        node.currentTime = target;
        return target;
      };

      // A commit is verified, not assumed: the element can refuse a seek when it has
      // no seekable range yet, and something else can move it afterwards. Retry a
      // few times and, if it still refuses, say so with the element's own state.
      const verifySeek = (node, target, attempt) => {
        if (!node) return;
        if (Math.abs(node.currentTime - target) <= 0.3) return;
        if (attempt >= 3) {
          const seekable = node.seekable && node.seekable.length ? node.seekable.end(0) : 0;
          // Long enough to read and copy.
          flashLong(
            '定位没生效：目标 ' +
              formatTime(target) +
              '，当前 ' +
              formatTime(node.currentTime) +
              '（readyState ' +
              node.readyState +
              '，可定位范围 0–' +
              formatTime(seekable) +
              '）',
          );
          return;
        }
        node.currentTime = target;
        window.setTimeout(() => verifySeek(node, target, attempt + 1), 300 * (attempt + 1));
      };

      // A paused element can accept currentTime without presenting the new frame.
      // requestVideoFrameCallback tells us whether a frame arrived; if none did, one
      // play/pause pulse forces the decoder to produce it.
      const nudgeFrame = (node) => {
        if (!node || typeof node.requestVideoFrameCallback !== 'function') return;
        let presented = false;
        try {
          node.requestVideoFrameCallback(() => {
            presented = true;
          });
        } catch (error) {
          return;
        }
        window.setTimeout(() => {
          if (presented) return;
          const current = video();
          if (!current || current !== node) return;
          const wasPaused = current.paused;
          if (!wasPaused) return;
          const started = current.play();
          const stop = () => {
            current.pause();
          };
          if (started && typeof started.then === 'function') started.then(stop).catch(() => {});
          else stop();
        }, 220);
      };

      const seekTo = (time) => {
        const node = video();
        if (!node) return;
        endPreview(false);
        const target = applySeek(node, time);
        committedAt.current = Date.now();
        setInfo((current) => Object.assign({}, current, { current: target }));
        window.setTimeout(() => verifySeek(node, target, 0), 250);
        nudgeFrame(node);
        // A committed move is the new resting place: any later preview captures it
        // as the position to return to.
        hoverBase.current = target;
      };

      const play = () => {
        const node = video();
        if (!node) return;
        if (node.paused) node.play().catch(() => {});
        else node.pause();
      };
      const step = (frames) => {
        const node = video();
        if (!node) return;
        node.pause();
        seekTo(Math.min(node.duration || 0, Math.max(0, node.currentTime + frames * frame)));
      };
      const cycleRate = () => {
        const node = video();
        if (!node) return;
        const rates = [1, 1.5, 2, 0.5];
        const next = rates[(rates.indexOf(info.rate) + 1) % rates.length];
        node.playbackRate = next;
        setInfo((current) => Object.assign({}, current, { rate: next }));
      };

      const addClip = (start, end, rect) => {
        const from = Math.round(Math.min(start, end) * 10) / 10;
        const to = Math.round(Math.max(start, end) * 10) / 10;
        const created = { kind: 'video', path: doc.path, start: from, end: to };
        if (Array.isArray(rect)) created.rect = rect;
        addMark(created);
        flash('已标注 ' + formatTime(from) + '–' + formatTime(to));
      };

      // ---- in / out points ----
      const hasIn = inPoint !== null;
      const hasOut = outPoint !== null;
      const hasRange = clipAction(inPoint, outPoint, fps).kind === 'range';

      const putIn = (time) => {
        const next = quantize(time);
        setInPoint(next);
        // An in-point at or after the out-point would select backwards: drop the out.
        if (hasOut && next >= outPoint) setOutPoint(null);
      };
      const putOut = (time) => {
        const next = quantize(time);
        setOutPoint(next);
        if (hasIn && next <= inPoint) setInPoint(null);
      };

      const action = clipAction(inPoint, outPoint, fps);
      const markButton = () => {
        if (action.kind === 'now') {
          addClip(info.current, info.current);
          return;
        }
        addClip(action.start, action.end);
      };
      const markLabel = action.label;

      // ---- pointer handling ----
      const onTrackDown = (event) => {
        // Left button only: a right-click opens the menu and must not nudge the
        // playhead, even if the pointer drifts while the menu is opening.
        if (event.button !== 0) return;
        if (!duration) {
          flash('视频时长还没读取出来，稍等一下再点');
          return;
        }
        event.preventDefault();
        setMenuAt(null);
        cancelPreview();
        const time = timeFromClientX(event.clientX);
        seekTo(time);
        pressRef.current = { clientX: event.clientX, time };
        setDrag({ from: time, to: time, moved: false });
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
      };

      const onTrackMove = (event) => {
        if (menuAt) return;
        const time = timeFromClientX(event.clientX);
        if (drag) {
          const moved = drag.moved || Math.abs(event.clientX - (pressRef.current ? pressRef.current.clientX : event.clientX)) > 4;
          setDrag({ from: drag.from, to: time, moved });
          if (moved && !info.playing) previewAt(time);
          return;
        }
        if (info.playing) return;
        if (hover === null) hoverBase.current = info.current;
        setHover(time);
        previewAt(time);
      };

      const onTrackUp = (event) => {
        if (event.button !== 0) return;
        if (!drag) return;
        const time = timeFromClientX(event.clientX);
        const start = Math.min(drag.from, time);
        const end = Math.max(drag.from, time);
        const moved = drag.moved || Math.abs(event.clientX - (pressRef.current ? pressRef.current.clientX : event.clientX)) > 4;
        setDrag(null);
        pressRef.current = null;
        endPreview(false);
        if (!moved) {
          // A click only moves the playhead; it must not create a clip.
          seekTo(time);
          setHover(null);
          return;
        }
        addClip(start, end);
        // Land on where the pointer was released so the selection end is visible.
        seekTo(time);
        setHover(null);
      };

      const onTrackLeave = () => {
        if (drag) return;
        if (hover === null) return;
        setHover(null);
        // Restore the picture to the committed time: the element must never stay at
        // a scrubbed position, or its timeupdate would drag the slider with it.
        endPreview(true);
      };

      // React binds wheel as a passive listener, so preventDefault there is ignored
      // and the page would scroll while the timeline zooms. Bind it ourselves.
      const wheelRef = React.useRef(null);
      wheelRef.current = (event) => {
        if (!duration) return;
        if (event.altKey) {
          event.preventDefault();
          const anchorTime = timeFromClientX(event.clientX);
          zoomAt(anchorTime, event.deltaY < 0 ? 1 / 1.4 : 1.4);
          return;
        }
        // Shift+wheel pans the zoomed window without changing its width.
        if (event.shiftKey) {
          if (!Number.isFinite(span) || span >= fullSpan - 1e-6) return;
          event.preventDefault();
          const step = (event.deltaY !== 0 ? Math.sign(event.deltaY) : 0) * span * 0.12;
          if (!step) return;
          setView({ start: Math.max(0, Math.min(fullSpan - span, viewStart + step)), span });
        }
      };
      React.useEffect(() => {
        const node = trackRef.current;
        if (!node) return undefined;
        const handler = (event) => {
          if (wheelRef.current) wheelRef.current(event);
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
      }, [state.status]);

      const onTrackMenu = (event) => {
        if (!duration) return;
        event.preventDefault();
        // Anchored to the panel, not the viewport: an ancestor transform makes
        // position:fixed resolve against that ancestor, which put the menu offscreen.
        const root = rootRef.current;
        const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        // Keep the whole menu inside the panel: flip above when there is no room
        // below, and clamp both axes by the menu's own size.
        const width = 220;
        const height = 148;
        const left = Math.max(8, Math.min(rect.width - width - 8, localX - 24));
        const top = localY + height + 12 > rect.height ? Math.max(8, localY - height) : localY + 6;
        setMenuAt({ x: left, y: top });
      };

      const onStageDown = (event) => {
        if (event.button !== 0) return;
        if (!boxing) return;
        const node = video();
        if (!node) return;
        node.pause();
        const rect = node.getBoundingClientRect();
        const point = {
          x: (event.clientX - rect.left) / Math.max(1, rect.width),
          y: (event.clientY - rect.top) / Math.max(1, rect.height),
        };
        setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
      };
      const onStageMove = (event) => {
        if (!marquee) return;
        const node = video();
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
        const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
        setMarquee({ x0: marquee.x0, y0: marquee.y0, x1: x, y1: y });
      };
      const onStageUp = () => {
        if (!marquee) return;
        const x = Math.min(marquee.x0, marquee.x1);
        const y = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0);
        const h = Math.abs(marquee.y1 - marquee.y0);
        setMarquee(null);
        if (w < 0.02 || h < 0.02) return;
        addClip(
          info.current,
          info.current,
          [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(w * 1000) / 1000, Math.round(h * 1000) / 1000],
        );
        setBoxing(false);
      };

      React.useEffect(() => {
        if (!menuAt) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('.dshcv-videomenu')) return;
          setMenuAt(null);
        };
        window.addEventListener('pointerdown', onDown, true);
        return () => window.removeEventListener('pointerdown', onDown, true);
      }, [menuAt]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (!ownsKeyboard(event, rootRef.current)) return;
          if (event.key === ' ') {
            event.preventDefault();
            play();
            return;
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            step(event.key === 'ArrowRight' ? 1 : -1);
            return;
          }
          if (event.key === 'i' || event.key === 'I') {
            event.preventDefault();
            putIn(info.current);
            return;
          }
          if (event.key === 'o' || event.key === 'O') {
            event.preventDefault();
            putOut(info.current);
            return;
          }
          if (event.key === 'Escape' && menuAt) setMenuAt(null);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [info.current, info.duration, info.playing, menuAt, inPoint, outPoint, span, viewStart]);

      if (state.status === 'unsupported') {
        return h(
          'div',
          { className: 'dshcv-empty' },
          h('div', null, '浏览器无法直接播放 .' + videoExtOf(doc.path)),
          h('div', null, '可播放 mp4 / webm / mov / m4v / ogv；其他格式请先转码。'),
        );
      }
      if (state.status === 'failed') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '无法读取该视频'), h('div', null, state.error));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'dshcv-empty' }, h('div', null, '加载中…'));
      }

      const ratio = duration ? Math.min(1, info.current / duration) : 0;
      const headPercent = timeToPercent(info.current);
      const bandFrom = drag && drag.moved ? timeToPercent(Math.min(drag.from, drag.to)) : 0;
      const bandTo = drag && drag.moved ? timeToPercent(Math.max(drag.from, drag.to)) : 0;

      // Tick marks: whole seconds while zoomed, single frames at the deepest zoom.
      const ticks = [];
      if (zoomed) {
        const frameTicks = span <= 1.5;
        const stepSize = frameTicks ? frame : Math.max(0.5, Math.round(span / 10 / 0.5) * 0.5);
        const first = Math.ceil(viewStart / stepSize) * stepSize;
        for (let time = first; time <= viewEnd + 1e-6; time += stepSize) {
          ticks.push({ time, major: !frameTicks ? Math.abs(time - Math.round(time)) < 1e-6 : Math.abs(time - Math.round(time)) < 1e-6 });
        }
      }

      return h(
        'div',
        { ref: rootRef, className: 'dshcv-video' },
        h(
          'div',
          {
            ref: stageRef,
            className: 'dshcv-videostage',
            'data-boxing': boxing ? '1' : '0',
            onPointerDown: onStageDown,
            onPointerMove: onStageMove,
            onPointerUp: onStageUp,
          },
          h('video', {
            ref: videoRef,
            src: state.url,
            playsInline: true,
            // Without preload the element may stay at HAVE_NOTHING while paused, and
            // then every seek is silently ignored.
            preload: 'auto',
            onLoadedMetadata: (event) => {
              const node = event.currentTarget;
              setInfo((current) => Object.assign({}, current, { duration: Number(node.duration) || 0 }));
              // Fallback when the container has no parseable frame rate.
              if (typeof node.requestVideoFrameCallback !== 'function') return;
              let first = null;
              let count = 0;
              const sample = (now, meta) => {
                if (!first) first = { media: Number(meta.mediaTime) || 0, frames: Number(meta.presentedFrames) || 0 };
                count += 1;
                const elapsed = (Number(meta.mediaTime) || 0) - first.media;
                const presented = (Number(meta.presentedFrames) || 0) - first.frames;
                if (elapsed >= 0.8 && presented > 4) {
                  const measured = snapFrameRate(presented / elapsed);
                  if (measured) setInfo((current) => Object.assign({}, current, { fps: measured }));
                  return;
                }
                if (count < 240) node.requestVideoFrameCallback(sample);
              };
              node.requestVideoFrameCallback(sample);
            },
            onTimeUpdate: (event) => {
              // A scrubbing preview fires timeupdate too; it must not move the
              // committed playhead.
              if (preview.current.active) return;
              const node = event.currentTarget;
              setInfo((current) => Object.assign({}, current, { current: node.currentTime }));
            },
            onPlay: () => setInfo((current) => Object.assign({}, current, { playing: true })),
            onPause: () => setInfo((current) => Object.assign({}, current, { playing: false })),
            onClick: play,
          }),
          hoverRegion && !marquee
            ? h('div', {
                className: 'dshcv-regionbox',
                title: '标注区域 ' + formatTime(hoverRegion.start),
                style: {
                  left: hoverRegion.rect[0] * 100 + '%',
                  top: hoverRegion.rect[1] * 100 + '%',
                  width: hoverRegion.rect[2] * 100 + '%',
                  height: hoverRegion.rect[3] * 100 + '%',
                },
              })
            : null,
          marquee
            ? h('div', {
                className: 'dshcv-marquee',
                style: {
                  left: Math.min(marquee.x0, marquee.x1) * 100 + '%',
                  top: Math.min(marquee.y0, marquee.y1) * 100 + '%',
                  width: Math.abs(marquee.x1 - marquee.x0) * 100 + '%',
                  height: Math.abs(marquee.y1 - marquee.y0) * 100 + '%',
                },
              })
            : null,
        ),
        h(
          'div',
          { className: 'dshcv-videobar' },
          h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'primary', onClick: play }, info.playing ? '暂停' : '播放'),
          h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', title: '后退一帧（←）', onClick: () => step(-1) }, '−1f'),
          h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', title: '前进一帧（→）', onClick: () => step(1) }, '+1f'),
          h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', title: '播放速度', onClick: cycleRate }, info.rate + '×'),
          h('input', {
            type: 'text',
            className: 'dshcv-timeinput',
            inputMode: 'decimal',
            spellCheck: false,
            value: timeDraft,
            title: '输入时间后回车跳转：12.4 / 01:23.4 / 01:02:03.5',
            placeholder: formatTime(info.current),
            'aria-label': '跳转到指定时间',
            onFocus: () => setTimeDraft(formatTime(info.current)),
            onChange: (event) => setTimeDraft(event.target.value),
            onBlur: () => setTimeDraft(''),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                setTimeDraft('');
                event.currentTarget.blur();
                return;
              }
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const target = parseTime(timeDraft);
              if (!Number.isFinite(target)) {
                flash('时间格式不对：试试 12.4、01:23.4 或 01:02:03.5');
                return;
              }
              if (duration && target > duration + 0.05) {
                flash('超出片长：最长 ' + formatTime(duration));
                return;
              }
              seekTo(target);
              setTimeDraft('');
              event.currentTarget.blur();
            },
          }),
          h('span', { className: 'dshcv-videotime' }, '/ ' + formatTime(duration)),
          (() => {
            const typed = parseTime(timeDraft);
            if (!Number.isFinite(typed)) return null;
            if (Math.abs(typed - info.current) <= frame / 2) return null;
            if (duration && typed > duration + 0.05) return null;
            return h(
              'button',
              {
                type: 'button',
                className: 'dshcv-btn',
                'data-kind': 'primary',
                title: '跳转到 ' + formatTime(typed),
                'aria-label': '跳转到 ' + formatTime(typed),
                // pointerdown, not click: pressing the mouse first blurs the input,
                // which clears the draft and unmounts this very button before the
                // click is dispatched. preventDefault keeps focus where it is.
                onPointerDown: (event) => {
                  event.preventDefault();
                  seekTo(typed);
                  setTimeDraft('');
                },
              },
              '跳转',
            );
          })(),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-toggle dshcv-opt',
              'aria-pressed': boxing ? 'true' : 'false',
              title: '在暂停画面上框选一块区域',
              onClick: () => {
                const node = video();
                if (node) node.pause();
                setBoxing((value) => !value);
              },
            },
            '框选画面',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn',
              'data-kind': hasRange ? 'primary' : 'default',
              title: hasRange ? '用入点与出点生成区间标注' : hasIn ? '在入点处打点' : hasOut ? '在出点处打点' : '在当前位置打点',
              onClick: markButton,
            },
            markLabel,
          ),
        ),
        h(
          'div',
          {
            ref: trackRef,
            className: 'dshcv-track',
            'data-zoomed': zoomed ? '1' : '0',
            'data-frame': zoomed && span <= 1.5 ? '1' : '0',
            onPointerDown: onTrackDown,
            onPointerMove: onTrackMove,
            onPointerUp: onTrackUp,
            onPointerLeave: onTrackLeave,
            onContextMenu: onTrackMenu,
          },
          h('div', { className: 'dshcv-trackfill', style: { width: headPercent + '%' } }),
          inPoint !== null ? h('div', { className: 'dshcv-inmark', style: { left: timeToPercent(inPoint) + '%' }, title: '入点 ' + formatTime(inPoint) }) : null,
          outPoint !== null ? h('div', { className: 'dshcv-outmark', style: { left: timeToPercent(outPoint) + '%' }, title: '出点 ' + formatTime(outPoint) }) : null,
          hasRange
            ? h('div', {
                className: 'dshcv-inoutband',
                style: { left: timeToPercent(inPoint) + '%', width: timeToPercent(outPoint) - timeToPercent(inPoint) + '%' },
              })
            : null,
          ticks.map((tick) =>
            h('div', {
              key: 'tick' + tick.time.toFixed(3),
              className: 'dshcv-tick' + (tick.major ? ' dshcv-tickmajor' : ''),
              style: { left: timeToPercent(tick.time) + '%' },
            }),
          ),
          h('div', { className: 'dshcv-trackhead', style: { left: headPercent + '%' } }),
          hover !== null && !drag
            ? h('div', { className: 'dshcv-hoverhead', style: { left: timeToPercent(hover) + '%' } })
            : null,
          // Hovering a clip mark in the rail lights up its moment (or range) here.
          hovered && hovered.kind === 'video'
            ? h('div', {
                className: 'dshcv-markband',
                style: {
                  left: timeToPercent(hovered.start) + '%',
                  width: Math.max(timeToPercent(hovered.end) - timeToPercent(hovered.start), 0) + '%',
                },
              })
            : null,
          hovered && hovered.kind === 'video'
            ? h('div', { className: 'dshcv-markhead', style: { left: timeToPercent(hovered.start) + '%' } })
            : null,
          hovered && hovered.kind === 'video' && hovered.end > hovered.start
            ? h('div', { className: 'dshcv-markhead', style: { left: timeToPercent(hovered.end) + '%' } })
            : null,
          hover !== null || drag
            ? h(
                'div',
                {
                  className: 'dshcv-tracktip',
                  style: { left: timeToPercent(drag ? drag.to : hover || 0) + '%' },
                },
                drag && drag.moved
                  ? formatTime(Math.min(drag.from, drag.to)) +
                      '–' +
                      formatTime(Math.max(drag.from, drag.to)) +
                      ' · ' +
                      Math.abs(drag.to - drag.from).toFixed(1) +
                      's'
                  : formatTime(drag ? drag.to : hover || 0),
              )
            : null,
          drag && bandTo > bandFrom
            ? h('div', {
                className: 'dshcv-trackband',
                style: { left: bandFrom + '%', width: bandTo - bandFrom + '%' },
              })
            : null,
        ),
        h(
          'div',
          { className: 'dshcv-videohint' },
          zoomed
            ? '窗口 ' + formatTime(viewStart) + '–' + formatTime(viewEnd) + '（' + (span <= 1.5 ? '帧级' : span.toFixed(1) + 's') + '）· Alt+滚轮 继续缩放或收回'
            : '拖动选段 → 标注区间；单击跳转；右键插入入/出点；Alt+滚轮 放大时间轴',
        ),
        menuAt
          ? h(
              'div',
              {
                className: 'dshcv-videomenu',
                style: { left: menuAt.x + 'px', top: menuAt.y + 'px' },
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-menuitem',
                  onClick: () => {
                    putIn(info.current);
                    setMenuAt(null);
                  },
                },
                '插入入点（' + formatTime(info.current) + '）',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-menuitem',
                  onClick: () => {
                    putOut(info.current);
                    setMenuAt(null);
                  },
                },
                '插入出点（' + formatTime(info.current) + '）',
              ),
              h('div', { className: 'dshcv-menurule' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-menuitem',
                  disabled: !hasIn && !hasOut,
                  onClick: () => {
                    setInPoint(null);
                    setOutPoint(null);
                    setMenuAt(null);
                  },
                },
                '清除入出点',
              ),
            )
          : null,
      );
    }

function CanvasPanel(props) {      useVersion();
      const ratioKey = 'dsh.canvas.ratio.' + (store.sessionId || 'none');
      const [ratio, setRatio] = React.useState(() => {
        try {
          // The split is remembered per session, falling back to the old global key.
          const saved = parseFloat(localStorage.getItem(ratioKey) || localStorage.getItem('dsh.canvas.ratio') || '');
          return saved > 0.2 && saved < 0.8 ? saved : 0.52;
        } catch {
          return 0.52;
        }
      });
      const [helpOpen, setHelpOpen] = React.useState(false);
      const panelRef = React.useRef(null);
      const importInputRef = React.useRef(null);
      const paneRef = React.useRef(null);
      // Height of the annotation rail. 0 means "use the default max-height".
      const [railHeight, setRailHeight] = React.useState(() => {
        try {
          const saved = parseFloat(localStorage.getItem('dsh.canvas.rail') || '');
          return saved > 60 ? saved : 0;
        } catch {
          return 0;
        }
      });
      const railHeightRef = React.useRef(railHeight);
      railHeightRef.current = railHeight;

      const startRailDrag = (event) => {
        event.preventDefault();
        const pane = paneRef.current;
        if (!pane) return;
        const rect = pane.getBoundingClientRect();
        const move = (moveEvent) => {
          const next = Math.round(Math.min(rect.height * 0.8, Math.max(80, rect.bottom - moveEvent.clientY)));
          setRailHeight(next);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          try {
            localStorage.setItem('dsh.canvas.rail', String(railHeightRef.current));
          } catch {
            /* storage is best effort */
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      const [toast, setToast] = React.useState('');
      // Marks ticked as handled stay visible but are left out of the next send.
      const doneCount = store.marks.filter((mark) => mark.done).length;
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const [closing, setClosing] = React.useState(false);
      const reducedMotion = () =>
        Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const animateOnMount = React.useMemo(() => {
        const reduced = reducedMotion();
        const recent = Date.now() - panelReveal.at < 2000;
        const play = !reduced && !recent;
        if (play) panelReveal.at = Date.now();
        return play;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      const [revealed, setRevealed] = React.useState(() => !animateOnMount);
      const [animating, setAnimating] = React.useState(animateOnMount);

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
        // The next open is a real one, so let it animate again.
        panelReveal.at = 0;
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
    // Breakpoints need the panel's own width: two text columns under ~600px are
    // unreadable, and a stacked split only makes sense while it is tall enough.
    const [paneBox, setPaneBox] = React.useState({ width: 0, height: 0 });
    const [menuOpen, setMenuOpen] = React.useState(false);
    React.useEffect(() => {
      const node = paneRef.current;
      if (!node || typeof ResizeObserver === 'undefined') return undefined;
      const measure = () => {
        const width = node.clientWidth || 0;
        const height = node.clientHeight || 0;
        setPaneBox((current) =>
          Math.abs(current.width - width) < 2 && Math.abs(current.height - height) < 2
            ? current
            : { width, height },
        );
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, []);

    // Close the header menu on an outside press; Esc is handled by the panel's
    // own key handler below.
    React.useEffect(() => {
      if (!menuOpen) return undefined;
      const onDown = (event) => {
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('.dshcv-headmenu, .dshcv-more')) return;
        setMenuOpen(false);
      };
      window.addEventListener('pointerdown', onDown, true);
      return () => window.removeEventListener('pointerdown', onDown, true);
    }, [menuOpen]);

    // Unknown size (first paint, tests) must not switch the view off.
    const splitWanted = splitState().on && Boolean(secondDoc());
    const splitReady =
      splitWanted &&
      (paneBox.width === 0 || paneBox.width >= 600) &&
      (paneBox.height === 0 || paneBox.height >= 500);
    // Below ~860px two columns squeeze text; stack them instead.
    const splitDir = paneBox.width > 0 && paneBox.width < 860 ? 'column' : splitState().dir;
    // Annotations belong to files, so a split can hold marks from both halves; the
    // toolbar says how many come from the pane you are not looking at.
    const focusedPath =
      store.splitFocus === 'b'
        ? (secondDoc() || {}).path || ''
        : (store.docs.find((doc) => doc.id === store.activeId) || {}).path || '';
    const otherPaneMarks = splitReady
      ? store.marks.filter((mark) => !mark.done && focusedPath && !sameFile(mark.path, focusedPath)).length
      : 0;

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
        // A scroll we did not originate is either the shell's own follow logic or
        // layout settling; only a real gesture may end "follow the tail".
        let userScrolledAt = 0;
        const markUserScroll = () => {
          userScrolledAt = Date.now();
        };

        const nearBottom = () => (area ? area.scrollHeight - area.scrollTop - area.clientHeight : 0) < 48;
        const pinToBottom = () => {
          if (!area) return;
          area.scrollTop = area.scrollHeight;
          anchor = area.scrollTop;
        };

        const onScroll = () => {
          if (!area) return;
          const distance = area.scrollHeight - area.scrollTop - area.clientHeight;
          if (distance < 48) {
            following = true;
            anchor = area.scrollTop;
            return;
          }
          // Ignore scrolls nobody asked for (the shell restoring position, the
          // element being re-measured) instead of freezing the reader there.
          if (Date.now() - userScrolledAt < 700) {
            following = false;
            anchor = area.scrollTop;
          } else if (following) {
            pinToBottom();
          }
        };

        const onContent = () => {
          if (!area) return;
          if (following) {
            pinToBottom();
          } else if (Math.abs(area.scrollTop - anchor) > 1) {
            // A reader who stopped mid-transcript keeps their place even while
            // content streams in below.
            area.scrollTop = anchor;
          }
        };

        const attach = (next) => {
          if (!next || !next.isConnected || next === area) return;
          if (area) {
            area.removeEventListener('scroll', onScroll);
            area.removeEventListener('wheel', markUserScroll);
            area.removeEventListener('touchstart', markUserScroll);
            area.removeEventListener('pointerdown', markUserScroll);
            area.removeEventListener('keydown', markUserScroll);
          }
          if (contentObserver) contentObserver.disconnect();
          area = next;
          area.addEventListener('scroll', onScroll, { passive: true });
          area.addEventListener('wheel', markUserScroll, { passive: true });
          area.addEventListener('touchstart', markUserScroll, { passive: true });
          area.addEventListener('pointerdown', markUserScroll, { passive: true });
          area.addEventListener('keydown', markUserScroll);
          contentObserver = new MutationObserver(onContent);
          contentObserver.observe(area, { childList: true, subtree: true, characterData: true });
          following = true;
          pinToBottom();
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
          if (area) {
            area.removeEventListener('scroll', onScroll);
            area.removeEventListener('wheel', markUserScroll);
            area.removeEventListener('touchstart', markUserScroll);
            area.removeEventListener('pointerdown', markUserScroll);
            area.removeEventListener('keydown', markUserScroll);
          }
        };
      }, []);

      React.useEffect(() => {
        const onKey = (event) => {
          if (!ownsKeyboard(event, panelRef.current)) return;
          const ctrl = event.ctrlKey || event.metaKey;
          if (ctrl && event.key === 'Tab') {
            event.preventDefault();
            cycleDoc(event.shiftKey ? -1 : 1);
            return;
          }
          if (event.altKey && event.key === '\\') {
          event.preventDefault();
          toggleSplit();
          return;
        }
        if (event.altKey && (event.key === '1' || event.key === '2')) {
          const state = splitState();
          if (!state.on) return;
          event.preventDefault();
          if (event.key === '2') {
            if (state.secondId) mutate({ splitFocus: 'b' });
          } else {
            mutate({ splitFocus: 'a' });
          }
          return;
        }
        if (event.key === 'Escape' && menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key === 'Escape' && splitState().on) {
          event.preventDefault();
          mutate({ split: Object.assign({}, splitState(), { on: false, secondId: null }), splitFocus: 'a' });
          return;
        }
        if (event.altKey && (event.key === 'w' || event.key === 'W')) {
            // Alt+W rather than Ctrl+W: the shell owns the window accelerator.
            event.preventDefault();
            if (store.activeId) closeDoc(store.activeId);
            return;
          }
          if (ctrl && event.key === 'Enter') {
            // Ctrl+Enter sends from anywhere in the panel, including the note fields.
            event.preventDefault();
            if (!store.marks.length) return;
            const result = sendMarks();
            setToast(result === 'ok' ? '已填入输入框' : result === 'copied' ? '已复制到剪贴板' : '发送失败');
            setTimeout(() => setToast(''), 2200);
            if (autoClearAfterSend()) clearMarks();
            return;
          }
          if (event.key === '?' || (event.shiftKey && event.key === '/')) {
            event.preventDefault();
            setHelpOpen((value) => !value);
            return;
          }
          if (event.key === 'Escape' && helpOpen) setHelpOpen(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [helpOpen]);

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
              localStorage.setItem(ratioKey, String(current));
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
        { className: 'dshcv-root', ref: panelRef },
        h(Styles, { panel: true }),
        h(
          'div',
          { className: 'dshcv-head' },
          h('span', { className: 'dshcv-title' }, '画布'),
          h('span', { className: 'dshcv-path' }, active ? active.path : '未打开交付物'),
          h('span', { className: 'dshcv-spacer' }),
          // Narrow panels hide the secondary buttons; this opens them as a menu
          // instead of expanding the header in place.
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn dshcv-more',
              title: '更多操作',
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen ? 'true' : 'false',
              'data-active': menuOpen ? '1' : '0',
              onClick: () => setMenuOpen((value) => !value),
            },
            '⋯',
          ),
          menuOpen
            ? h(
                'div',
                { className: 'dshcv-headmenu', role: 'menu' },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshcv-menuitem',
                    onClick: () => {
                      setMenuOpen(false);
                      setPickerOpen(true);
                    },
                  },
                  '打开工作区文件',
                  h('span', { className: 'dshcv-menukey' }, ''),
                ),
                store.marks.length
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        className: 'dshcv-menuitem',
                        onClick: () => {
                          setMenuOpen(false);
                          send();
                        },
                      },
                      '发送标注 (' + pendingMarks().length + ')',
                    )
                  : null,
                store.marks.length
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        className: 'dshcv-menuitem',
                        onClick: () => {
                          setMenuOpen(false);
                          exportMarks();
                        },
                      },
                      '导出标注 JSON',
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshcv-menuitem',
                    onClick: () => {
                      setMenuOpen(false);
                      if (importInputRef.current) importInputRef.current.click();
                    },
                  },
                  '导入标注 JSON',
                ),
                store.marks.length
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        className: 'dshcv-menuitem',
                        onClick: () => {
                          setMenuOpen(false);
                          setFollowHover(!followHover.on);
                        },
                      },
                      (followHover.on ? '关闭' : '开启') + '悬停跟随',
                    )
                  : null,
                store.marks.length
                  ? h(
                      'button',
                      {
                        type: 'button',
                        role: 'menuitem',
                        className: 'dshcv-menuitem',
                        onClick: () => {
                          setMenuOpen(false);
                          clearMarks();
                        },
                      },
                      '清空标注',
                    )
                  : null,
                h('div', { className: 'dshcv-menurule' }),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshcv-menuitem',
                    onClick: () => {
                      setMenuOpen(false);
                      setHelpOpen(true);
                    },
                  },
                  '帮助与键位',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'menuitem',
                    className: 'dshcv-menuitem',
                    onClick: () => {
                      setMenuOpen(false);
                      closePanel.current();
                    },
                  },
                  '回到对话',
                ),
              )
            : null,
          h('button', { type: 'button', className: 'dshcv-btn', onClick: () => setPickerOpen(!pickerOpen) }, '打开'),
          store.marks.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-toggle dshcv-opt',
                  'aria-pressed': followHover.on ? 'true' : 'false',
                  title: '悬停标注时自动滚动到对应内容',
                  onClick: () => setFollowHover(!followHover.on),
                },
                '跟随',
              )
            : null,
          store.marks.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-btn',
                  'data-kind': 'primary',
                  onClick: send,
                  title:
                    doneCount
                      ? '已处理 ' + doneCount + ' 条不参与发送'
                      : otherPaneMarks > 0
                        ? '把两个窗格的标注一起发送（其中 ' + otherPaneMarks + ' 条来自另一窗格）'
                        : '把全部标注发送到对话框',
                },
                '发送标注 (' + pendingMarks().length + ')',
              otherPaneMarks > 0
                ? h(
                    'span',
                    {
                      className: 'dshcv-opt',
                      style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
                      title: '并排时另一个窗格里的标注会一起发送',
                    },
                    '另有 ' + otherPaneMarks + ' 条在另一侧',
                  )
              : null,
              )
            : null,
          store.marks.length
            ? h('button', { type: 'button', className: 'dshcv-btn', 'data-kind': 'quiet', onClick: clearMarks }, '清空')
            : null,
          store.marks.length
            ? h(
                'button',
                { type: 'button', className: 'dshcv-btn dshcv-opt', 'data-kind': 'quiet', title: '导出标注为 JSON', onClick: () => exportMarks() },
                '导出',
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dshcv-btn dshcv-opt',
              'data-kind': 'quiet',
              title: '导入标注 JSON（相同位置复用原编号）',
              onClick: () => {
                if (importInputRef.current) importInputRef.current.click();
              },
            },
            '导入',
          ),
          h('input', {
            ref: importInputRef,
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: async (event) => {
              const picked = event.target.files && event.target.files[0];
              event.target.value = '';
              if (!picked) return;
              try {
                const result = await importMarks(picked);
                setToast(result.ok ? '已导入 ' + result.added + ' 条' + (result.updated ? '，更新 ' + result.updated + ' 条' : '') : result.reason);
              } catch (error) {
                setToast('导入失败：' + errText(error));
              }
            },
          }),
          store.marks.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshcv-toggle dshcv-opt',
                  'aria-pressed': sendPrefs.autoClear ? 'true' : 'false',
                  title: '发送标注后自动清空列表（Ctrl+Enter 也能发送）',
                  onClick: toggleAutoClear,
                },
                '发后清空',
              )
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
                'dshcv-pane' +
                (animateOnMount ? ' dshcv-reveal' : '') +
                (closing ? ' dshcv-closing' : '') +
                (animating ? ' dshcv-animating' : ''),
              ref: paneRef,
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
                          'data-second': splitState().on && doc.id === splitState().secondId ? '1' : '0',
                          title: doc.path,
                          onClick: () => focusDoc(doc),
                        },
                        basename(doc.path),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshcv-btn',
                          'data-kind': 'quiet',
                          style: { padding: '0 5px', lineHeight: '16px' },
                          title: '关闭该交付物',
                          onClick: () => closeDoc(doc.id),
                        },
                        '×',
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshcv-btn',
                      'data-kind': splitState().on ? 'primary' : 'default',
                      'aria-pressed': splitState().on ? 'true' : 'false',
                      title: '并排对比（Alt+\\）',
                      style: { marginLeft: 'auto' },
                      onClick: toggleSplit,
                    },
                    '⧉',
                  ),
                  splitReady
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dshcv-btn',
                          'data-kind': 'quiet',
                          title: splitDir === 'column' ? '改为左右并排' : '改为上下并排',
                          onClick: () => setSplit({ dir: splitDir === 'column' ? 'row' : 'column' }),
                        },
                        splitDir === 'column' ? '↕' : '↔',
                      )
                    : null,
                )
              : null,
            pickerOpen
              ? h(FilePicker, {
                  sessionId: store.sessionId,
                  onOpen: (path) => openDoc({ path }),
                  onClose: () => setPickerOpen(false),
                })
              : active
                ? h(
                    'div',
                    {
                      className: 'dshcv-slots',
                      'data-dir': splitDir,
                      'data-split': splitReady ? '1' : '0',
                    },
                    h(
                      'div',
                      {
                        key: 'a',
                        className: 'dshcv-slot',
                        'data-active': splitReady && store.splitFocus === 'b' ? '0' : '1',
                        onMouseDown: () => {
                          if (splitReady && store.splitFocus !== 'a') mutate({ splitFocus: 'a' });
                        },
                        style:
                          splitReady
                            ? { flex: '0 0 ' + Math.round(splitState().ratio * 1000) / 10 + '%' }
                            : { flex: '1 1 0' },
                      },
                      viewerFor(active),
                    ),
                    splitReady
                      ? h(SplitDivider, { key: 'divider', dir: splitState().dir })
                      : null,
                    splitReady
                      ? h(
                          'div',
                          {
                            key: 'b',
                            className: 'dshcv-slot',
                            'data-active': store.splitFocus === 'b' ? '1' : '0',
                            onMouseDown: () => {
                              if (store.splitFocus !== 'b') mutate({ splitFocus: 'b' });
                            },
                            style: { flex: '1 1 0' },
                          },
                          viewerFor(secondDoc()),
                        )
                      : null,
                  )
                : h(
                    'div',
                    { className: 'dshcv-guide' },
                    h(
                      'div',
                      { className: 'dshcv-guidehead' },
                      h('div', { className: 'dshcv-guidetitle' }, '画布 · 还没有打开交付物'),
                      h(
                        'div',
                        { className: 'dshcv-guidesub' },
                        '在这里预览文件并逐处标注；每条标注自动编号，可一次性写回对话。',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshcv-guideactions' },
                      h(
                        'button',
                        { type: 'button', className: 'dshcv-btn', 'data-kind': 'primary', onClick: () => setPickerOpen(true)  },
                        '打开工作区文件',
                      ),
                      h(
                        'span',
                        { className: 'dshcv-guidehint' },
                        store.sessionId
                          ? '或让模型调用 canvas 工具，打开的文件会自动出现在这里'
                          : '等待会话连接后即可打开文件…',
                      ),
                    ),
                    h(
                      'ol',
                      { className: 'dshcv-steps' },
                      h('li', null, h('b', null, '打开'), '　点左上「打开工作区文件」，或由模型工具打开；同一文件只保留一个标签。'),
                      h(
                        'li',
                        null,
                        h('b', null, '选取'),
                        '　文本划选行、HTML 点选元素、图片框选区域、表格点选单元格、三维点选三角面、DXF 点选图元、PSD 点取样像素。',
                      ),
                      h(
                        'li',
                        null,
                        h('b', null, '发送'),
                        '　在下方标注里写意见 → 点「发送标注」，按编号写入输入框；「清空」从 1 重新编号。',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshcv-guidefoot' },
                      h('span', { className: 'dshcv-guidesec' }, '支持'),
                      h(
                        'span',
                        { className: 'dshcv-tags' },
                        ['md', 'txt', 'html', 'svg', 'png/jpg', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'stl/obj/ply', '3mf/glb', 'dxf', 'psd', 'sketch'].map((tag) =>
                          h('span', { key: tag, className: 'dshcv-tag' }, tag),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshcv-guidefoot' },
                      h('span', { className: 'dshcv-guidesec' }, '快捷键'),
                      h(
                        'span',
                        { className: 'dshcv-tags' },
                        ['Alt+S 暂停/继续', 'Alt+A/D 逐帧', 'Ctrl+F 搜索', '? 全部键位'].map((tag) =>
                          h('span', { key: tag, className: 'dshcv-tag' }, tag),
                        ),
                      ),
                    ),
                  ),
            store.marks.length
              ? h('div', {
                  className: 'dshcv-hsplit',
                  title: '拖动调整标注区高度（双击复位）',
                  onPointerDown: startRailDrag,
                  onDoubleClick: () => {
                    setRailHeight(0);
                    try {
                      localStorage.removeItem('dsh.canvas.rail');
                    } catch {
                      /* ignore */
                    }
                  },
                })
              : null,
            h(MarksRail, {
              style: railHeight ? { flex: '0 0 ' + railHeight + 'px', maxHeight: 'none' } : undefined,
            }),
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
        store.flash ? h('div', { className: 'dshcv-toast' }, store.flash) : null,
        toast ? h('div', { className: 'dshcv-toast dshcv-toast-2' }, toast) : null,
        helpOpen
          ? h(
              'div',
              { className: 'dshcv-help' },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '快捷键'),
              ...[
                ['Alt+S', '暂停 / 继续（单手，悬停面板即可）'],
                ['Alt+A / Alt+D', '后退 / 前进一帧（Shift 为 100ms）'],
                ['← →', '逐帧步进（备用，Shift 为 100ms）'],
                ['F', '复位取景（Shift+F 也复位视角）'],
                ['1-7', '前 / 后 / 右 / 左 / 顶 / 底 / 等轴测'],
                ['Ctrl+Tab', '切换标签（加 Shift 反向）'],
                ['Alt+W', '关闭当前标签'],
['Alt+\\', '并排对比（再按一次收起）'],
['Alt+1 / Alt+2', '在并排的两个窗格里切换焦点'],
['Esc', '并排时先退出并排'],
                ['?', '显示 / 隐藏本帮助'],
              ].map(([key, label]) => h('div', { key }, h('kbd', null, key), label)),
              h(
                'div',
                { style: { marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center' } },
                h('kbd', null, '调试'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcv-toggle',
                    'aria-pressed': debugRender() ? 'true' : 'false',
                    onClick: toggleDebugRender,
                  },
                  debugRender() ? '渲染调试计数：开' : '渲染调试计数：关',
                ),
              ),
              h(
                'div',
                { style: { marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center' } },
                h('kbd', null, 'HTML'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcv-toggle',
                    'aria-pressed': injectScriptAllowed() ? 'true' : 'false',
                    title: '关闭后预览不再运行插件的标注脚本，元素点选将不可用',
                    onClick: toggleInjectScript,
                  },
                  injectScriptAllowed() ? '预览注入标注脚本：开' : '预览注入标注脚本：关',
                ),
              ),
            )
          : null,
      );
    }

    // ---------------- registrations ----------------
    const GuardedPanel = guardPanel(CanvasPanel);
    const GuardedBridge = guardPanel(Bridge);
    const GuardedToolCard = guardPanel(CanvasToolCard);

    return {
      inject: ['slots', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        ctxRef = ctx;
        devlog('apply', [
          'layout=' + typeof ctx.get('layout'),
          'files=' + typeof ctx.get('remote.workspaceFiles'),
        ]);

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, GuardedPanel));

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'canvas-bridge', order: -100 }, GuardedBridge),
        );

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'canvas' }, GuardedToolCard),
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
                    'data-kind': 'quiet',
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

