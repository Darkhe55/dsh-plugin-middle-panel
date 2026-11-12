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
      // Page geometry, so a page box can be sized without waiting for its bitmap.
      const [pageSizes, setPageSizes] = React.useState({});
      const [baseSize, setBaseSize] = React.useState(null);
      const docRef = React.useRef(null);
      const pdfjsRef = React.useRef(null);
      const scrollRef = React.useRef(null);
      const boxRef = React.useRef(null);
      const pageEls = React.useRef(new Map());
      const zoomAnchor = React.useRef(null);
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
            const first = await loaded.getPage(1);
            const firstBox = first.getViewport({ scale: 1 });
            setBaseSize({ width: firstBox.width, height: firstBox.height });
            if (!cancelled) {
              // Uniform pages are the norm, so page 1 already sizes the whole column;
              // the full table only refines mixed-size documents.
              (async () => {
                const table = { 1: { width: firstBox.width, height: firstBox.height } };
                for (let n = 2; n <= loaded.numPages; n += 1) {
                  if (cancelled) return;
                  try {
                    const page = await loaded.getPage(n);
                    const box = page.getViewport({ scale: 1 });
                    table[n] = { width: box.width, height: box.height };
                  } catch (error) {
                    /* keep page 1 geometry for this one */
                  }
                }
                if (!cancelled) setPageSizes(table);
              })();
            }
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

      const scrollToPage = (pageNumber, rect) => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const centerOf = () => {
          const node = pageEls.current.get(pageNumber);
          if (!node) return null;
          const pageRect = node.getBoundingClientRect();
          const viewRect = scroller.getBoundingClientRect();
          if (!pageRect.height) return null;
          const offset = rect ? rect[1] * pageRect.height : 0;
          const height = rect ? Math.max(8, rect[3] * pageRect.height) : pageRect.height;
          const absolute = scroller.scrollTop + (pageRect.top - viewRect.top) + offset;
          return { absolute, height };
        };
        const place = () => {
          const box = centerOf();
          if (!box) return false;
          // Centre the target; a hit near the bottom must not land under the rail.
          scroller.scrollTop = Math.max(0, box.absolute - (scroller.clientHeight - box.height) / 2);
          return true;
        };
        if (!place()) {
          const node = pageEls.current.get(pageNumber);
          if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
          return;
        }
        // The rail can expand right after, which shrinks the viewport: settle again.
        window.requestAnimationFrame(() => place());
        window.setTimeout(() => place(), 140);
      };

      // Ctrl (Cmd) + wheel zooms the page, like every other document viewer. React
      // binds wheel passively, so the listener is registered natively to allow
      // preventDefault and stop the browser from zooming the whole app.
      React.useEffect(() => {
        const node = scrollRef.current;
        if (!node) return undefined;
        let token = 0;
        let pendingFactor = 1;
        let frame = 0;
        let anchor = null;
        const applyZoom = () => {
          frame = 0;
          const factor = pendingFactor;
          pendingFactor = 1;
          if (factor !== 1) {
            setZoom((z) => Math.min(4, Math.max(0.4, Math.round(z * factor * 100) / 100)));
          }
          if (!anchor) return;
          const mine = token;
          const until = Date.now() + 240;
          // Sizes are synchronous now, so one correction usually lands; the short loop
          // only absorbs the frames between the state update and the new layout.
          const tick = () => {
            if (mine !== token) return;
            const target = scrollRef.current;
            if (!target) return;
            target.scrollTop = Math.max(0, anchor.ratio * target.scrollHeight - anchor.offset);
            if (Date.now() < until) window.requestAnimationFrame(tick);
          };
          window.requestAnimationFrame(tick);
        };

        const onWheel = (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          const node = scrollRef.current;
          if (!node) return;
          if (!frame) {
            const rect = node.getBoundingClientRect();
            anchor = {
              ratio: (event.clientY - rect.top + node.scrollTop) / Math.max(1, node.scrollHeight),
              offset: event.clientY - rect.top,
            };
            token += 1;
          }
          // One physical gesture emits many events: fold them into a single zoom step per
          // frame so the layout changes once, not fifteen times.
          pendingFactor *= event.deltaY < 0 ? 1.1 : 1 / 1.1;
          if (!frame) frame = window.requestAnimationFrame(applyZoom);
        };
        node.addEventListener("wheel", onWheel, { passive: false });
        return () => {
          token += 1;
          node.removeEventListener("wheel", onWheel);
        };
      }, []);

      // Following a mark: hovering its rail row brings the page to it, so the
      // highlight is never off screen.
      React.useEffect(() => {
        if (!hoverMark || state.status !== "ready") return;
        scrollToPage(Number(hoverMark.page) || 1, hoverMark.rect);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hoverMark ? hoverMark.id : "", state.status]);

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
        try {
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const content = await textContentOf(pdf, pageNumber);
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const Util = pdfjsRef.current && pdfjsRef.current.Util;
            if (!Util) break;
            // CJK documents often emit one item per glyph, so a multi-character query
            // can never match inside a single item. Build the page string first.
            let joined = "";
            let previousRight = null;
            let previousTop = null;
            const pieces = [];
            for (const item of content.items || []) {
              if (!item || typeof item.str !== "string") continue;
              const transform = Util.transform(viewport.transform, item.transform);
              const height = Math.hypot(transform[2], transform[3]);
              if (!height) continue;
              const width = Math.max(1, (Number(item.width) || 0) * viewport.scale);
              const left = transform[4];
              const top = transform[5] - height;
              if (previousRight !== null && Math.abs(top - previousTop) < height * 0.6 && left - previousRight > 1) {
                joined += " ";
              }
              pieces.push({ start: joined.length, end: joined.length + item.str.length, left, top, width, height, length: item.str.length });
              joined += item.str;
              previousRight = left + width;
              previousTop = top;
            }
            if (!joined) continue;
            // Character counts are not widths: the same cumulative advance table the text
            // layer uses maps a character offset onto a position, or the box ends short.
            const measureCtx2 = document.createElement("canvas").getContext("2d");
            for (const piece of pieces) {
              const cumulative = [0];
              let running = 0;
              if (measureCtx2) measureCtx2.font = Math.max(4, piece.height) + "px " + MEASURE_FONT;
              for (const ch of piece.str) {
                running += measureCtx2 ? measureCtx2.measureText(ch).width : 1;
                cumulative.push(running);
              }
              piece.cumulative = cumulative;
              piece.cumTotal = running;
            }
            const haystack = joined.toLowerCase();
            let at = haystack.indexOf(needle);
            while (at >= 0) {
              const to = at + term.length;
              const rects = [];
              for (const piece of pieces) {
                if (piece.end <= at || piece.start >= to) continue;
                const from = Math.max(at, piece.start) - piece.start;
                const tail = Math.min(to, piece.end) - piece.start;
                const total = piece.cumTotal > 0 ? piece.cumTotal : Math.max(1, piece.length);
                const a = piece.cumTotal > 0 ? piece.cumulative[from] / total : from / Math.max(1, piece.length);
                const b = piece.cumTotal > 0 ? piece.cumulative[tail] / total : tail / Math.max(1, piece.length);
                rects.push([
                  (piece.left + piece.width * a) / viewport.width,
                  piece.top / viewport.height,
                  Math.max(piece.width * (b - a), 2) / viewport.width,
                  piece.height / viewport.height,
                ]);
              }
              if (rects.length) {
                found.push({
                  page: pageNumber,
                  index: found.length,
                  text: joined.slice(at, to),
                  rects,
                  rect: rects[0],
                });
              }
              at = haystack.indexOf(needle, to);
            }
          }
          setHits(found);
          setHitIndex(0);
    if (found.length) scrollToPage(found[0].page, found[0].rect || (found[0].rects && found[0].rects[0]));
        } finally {
          setSearching(false);
        }
      };

      const gotoHit = (next) => {
        if (!hits.length) return;
        const index = (next + hits.length) % hits.length;
        setHitIndex(index);
        const hit = hits[index];
        scrollToPage(hit.page, hit.rect || (hit.rects && hit.rects[0]));
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
        { className: 'dshcv-docwrap dshcv-pdfdocwrap', style: { minHeight: 0 } },
        h(
          'div',
          { className: 'dshcv-tools' },
          h('span', { className: 'dshcv-msg' }, '第 ' + current + ' / ' + (pages || '…') + ' 页'),
          h('button', { type: 'button', className: 'dshcv-btn', title: '缩小（Ctrl+滚轮）', onClick: () => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 100) / 100)) }, '−'),
          h('button', { type: 'button', className: 'dshcv-btn', title: '放大（Ctrl+滚轮）', onClick: () => setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100)) }, '+'),
          h('input', {
            type: 'search',
            className: 'dshcv-searchinput',
            placeholder: '搜索全文…',
            value: query,
            onChange: (event) => {
              const value = event.target.value;
              setQuery(value);
              // The highlights belong to the query: clearing it clears them.
              if (!value.trim()) {
                setHits([]);
                setHitIndex(0);
              }
            },
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
                      baseSize: pageSizes[pageNumber] || baseSize,
                      markMode,
                      onRegion,
                      onSelect,
                      onClear: () => setSelection(null),
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
