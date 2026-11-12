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
        // A text mark is identified by its quote too: two different quotes can share one
        // line box, and collapsing them would silently drop the second mark.
        if (left.text || right.text) {
          if (String(left.quote || '') !== String(right.quote || '')) return false;
        }
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
    // like selecting the page, and the highlight is painted by us instead.
    '.dshcv-pdftext{position:absolute;inset:0;overflow:hidden;line-height:1;pointer-events:auto;user-select:text}',
    '.dshcv-pdftext span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}',
    '.dshcv-pdftext[data-own="1"] span::selection{background:transparent;color:transparent}',
    '.dshcv-pdftext span::-moz-selection{background:rgba(79,140,255,.34);color:transparent}',
    // The viewer owns its own scrolling: the toolbar must never scroll away, or the
    // mark buttons become unreachable once a long document is scrolled.
    '.dshcv-pdfdocwrap{overflow:hidden;display:flex;flex-direction:column;padding:6px 8px 0}',
    '.dshcv-pdfdocwrap .dshcv-tools{flex:0 0 auto;position:sticky;top:0;z-index:5;background:var(--dsw-alias-bg-layer-2,#fff);padding-top:4px}',
    '.dshcv-pdfdocwrap .dshcv-msg{position:static}',
    '.dshcv-pdfnote{flex:0 0 auto;padding:4px 10px 6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
    '.dshcv-pdfunlock{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px 8px;flex-wrap:wrap}',
    '.dshcv-pdfunlocktitle{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.dshcv-pdfmain{display:flex;gap:10px;min-height:0;flex:1 1 auto;overflow:hidden}',
    '.dshcv-pdfthumbs{flex:0 0 116px;min-height:0;overflow:auto;padding:4px;border-right:1px solid var(--dshcv-line)}',
    '.dshcv-pdfthumb{display:block;width:100%;margin:0 0 8px;padding:3px;border:0;background:transparent;cursor:pointer;border-radius:6px}',
    '.dshcv-pdfthumb canvas{display:block;width:100%;height:auto;background:#fff;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.18)}',
    '.dshcv-pdfthumb-on canvas{box-shadow:0 0 0 2px rgba(79,140,255,.95),0 2px 8px rgba(0,0,0,.2)}',
    '.dshcv-pdfthumbnum{display:block;font-size:10px;color:var(--dshcv-ink-2);margin-top:2px}',
    '.dshcv-pdfpages{flex:1 1 auto;min-height:0;overflow:auto;display:flex;justify-content:center;padding:12px 0 24px}',
    '.dshcv-pdfcolumn{display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;flex:0 0 auto}',
    '.dshcv-pdfhit{position:absolute;background:rgba(255,196,0,.34);border-radius:2px;pointer-events:none}',
    '.dshcv-pdfhit[data-active="1"]{background:rgba(255,138,0,.55);box-shadow:0 0 0 1px rgba(255,138,0,.85)}',
    '.dshcv-pdfregion-hot{background:rgba(79,140,255,.22)!important;box-shadow:0 0 12px rgba(79,140,255,.65)!important;border-style:solid!important}',
    // The page box owns the coordinate system: every overlay inside a page is
    // positioned against it, so it must be the positioned ancestor.
    '.dshcv-pdfpagebox{position:relative;overflow:hidden;background:#fff;line-height:0;border-radius:2px;box-shadow:0 2px 14px rgba(0,0,0,.16);flex:0 0 auto}',
    '.dshcv-pdfpagebox canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
    // While the sharper bitmap is still being produced the stretched one shows; the
    // flag exists so a future step can dim it instead of adding a transition.

    '.dshcv-pdfpagebox{contain:paint}',
    '.dshcv-pdfcanvasbox{position:relative;align-self:center;margin:0 auto;line-height:0}',
    '.dshcv-pdfcanvas{display:block;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.16)}',
    '.dshcv-scroll{overflow:auto}',
    '.dshcv-pdfpage{position:absolute;overflow:hidden}',
    '.dshcv-pdflayer{position:absolute;inset:0;cursor:crosshair;touch-action:none}',
    '.dshcv-pdflayer:not(.dshcv-pdflayer-on){cursor:default}',
    '.dshcv-pdfmarquee{position:absolute;border:1.5px solid rgba(79,140,255,.95);background:rgba(79,140,255,.16);box-shadow:0 0 10px rgba(79,140,255,.45);pointer-events:none;border-radius:2px}',
    // A text mark is a set of line bands that sit exactly on the glyphs: no outline,
    // so it reads as highlighted text rather than a selected box.
    // Browser selection is invisible here: the same renderer that draws a stored mark
    // draws the live selection, so the two can never disagree.
    '.dshcv-pdftext[data-own="1"] ::selection{background:transparent;color:transparent}',
    '.dshcv-pdftext[data-own="1"]::selection{background:transparent;color:transparent}',
    '.dshcv-pdfsel{position:absolute;background:rgba(79,140,255,.24);border-radius:2px;pointer-events:none}',
    '.dshcv-pdftexthit{position:absolute;background:rgba(79,140,255,.10);border-radius:2px;pointer-events:none}',
    '.dshcv-pdftexthit-hot{background:rgba(79,140,255,.12);box-shadow:inset 0 -1px 0 rgba(79,140,255,.65)}',
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
            onChange: (event) => {
              const value = event.target.value;
              setQuery(value);
              // Clearing the box must clear the highlights: they belong to the query.
              if (!value.trim()) {
                setHits([]);
                setHitIndex(0);
              }
            },
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

