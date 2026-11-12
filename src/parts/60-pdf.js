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
    // Keyed by the document object, not by a fingerprint: a missing fingerprint made
    // every document share one bucket, so a second PDF searched the first one.
    const pageTextCache = new WeakMap();
    const textContentOf = async (pdf, pageNumber) => {
      let bucket = pageTextCache.get(pdf);
      if (!bucket) {
        bucket = new Map();
        pageTextCache.set(pdf, bucket);
      }
      if (bucket.has(pageNumber)) return bucket.get(pageNumber);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      bucket.set(pageNumber, content);
      return content;
    };

    // One page: canvas, text layer, mark overlays.
    //
    // The layout size is computed synchronously from the page's own dimensions and the
    // zoom, while the bitmap is produced asynchronously. That split is what keeps
    // zooming stable: the scroll column never waits for a render to change height, and
    // the old bitmap simply stretches until the sharper one is swapped in.
    // Range.toString() walks the DOM, and pdf.js emits runs in content-stream order,
    // which need not match what the eye sees: selecting "tes" could yield "est".
    // Collect the selected glyphs per span, then order them by position.
    const selectedTextInVisualOrder = (wrap, range) => {
      if (!wrap || !range) return "";
      const parts = [];
      const spans = wrap.querySelectorAll(".dshcv-pdftext span");
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        const node = span.firstChild;
        if (!node || node.nodeType !== 3) continue;
        let start = -1;
        let end = -1;
        for (let offset = 0; offset < node.length; offset += 1) {
          if (range.comparePoint(node, offset) !== 0) continue;
          if (start < 0) start = offset;
          end = offset + 1;
        }
        if (start < 0) continue;
        const box = span.getBoundingClientRect();
        parts.push({ text: node.nodeValue.slice(start, end), top: box.top, left: box.left });
      }
      if (!parts.length) return String(range.toString() || "");
      const joined = parts.map((part) => part.text).join("");
      // A per-character scan can come up empty on unusual encodings; the browser
      // string is still correct for documents whose order matches the DOM.
      return joined.trim() ? joined : String(range.toString() || "");
      parts.sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));
    };

    // item.width is the sum of the advances the PDF declares, and those can be shorter
    // than the drawn glyphs; the error then accumulates along a line. The rendered
    // pixels are the ground truth, so each run is measured once and cached in page
    // units, which a later zoom only scales.
    // Helvetica-compatible measurement: the generic `sans-serif` family resolves to
    // a UI font on Windows whose per-character widths differ from the PDF font,
    // which shifts every glyph box inside a run. Arial is metric-compatible.
    const MEASURE_FONT = "Arial, Helvetica, sans-serif";
    let measureCtx = null;
    // Cumulative advance table for a string, in the measuring font.
    const advanceTable = (text, fontSize) => {
      if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
      if (!measureCtx || !text) return null;
      measureCtx.font = fontSize + "px " + MEASURE_FONT;
      const chars = Array.from(text);
      const cumulative = [0];
      let running = 0;
      for (const ch of chars) {
        running += measureCtx.measureText(ch).width;
        cumulative.push(running);
      }
      if (!(running > 0)) return null;
      return { cumulative, total: running, chars };
    };

    const inkWidthCache = new WeakMap();
    // Returns the absolute right edge of ink inside the box, in device pixels.
    const measureInkRight = (data, dataWidth, x0, x1, y0, y1) => {
      let right = -1;
      for (let y = y0; y < y1; y += 1) {
        const row = y * dataWidth;
        for (let x = x1 - 1; x >= x0; x -= 1) {
          const at = (row + x) * 4;
          if (data[at + 3] < 8) continue;
          if (data[at] > 245 && data[at + 1] > 245 && data[at + 2] > 245) continue;
          if (x > right) right = x;
          break;
        }
      }
      return right;
    };

    function PdfPage(props) {
      const {
        pdf,
        pageNumber,
        scale,
        baseSize,
        markMode,
        onRegion,
        onSelect,
        onClear,
        onVisible,
        registerEl,
        pageHits,
        activeHit,
        pageMarks,
        hoverBands,
        hoverRect,
        pdfjs,
      } = props;
      const width = Math.max(0, (baseSize && baseSize.width ? baseSize.width : 612) * scale);
      const height = Math.max(0, (baseSize && baseSize.height ? baseSize.height : 792) * scale);
      const [items, setItems] = React.useState([]);
      const [renderedAt, setRenderedAt] = React.useState(0);
      const [visible, setVisible] = React.useState(pageNumber <= 2);
      const [drag, setDrag] = React.useState(null);
      const [live, setLive] = React.useState([]);
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
            if (entry.isIntersecting) {
              setVisible(true);
              if (onVisible) onVisible(pageNumber, entry.intersectionRatio);
            }
          },
          { rootMargin: '600px 0px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pageNumber]);

      // Render into an offscreen canvas, then swap in one paint: the visible canvas is
      // never left half-drawn, and its CSS size already fills the (new) box.
      React.useEffect(() => {
        if (!visible || !pdf || !width) return undefined;
        const token = tokenRef.current + 1;
        tokenRef.current = token;
        let cancelled = false;
        (async () => {
          const page = await pdf.getPage(pageNumber);
          if (cancelled || tokenRef.current !== token) return;
          const viewport = page.getViewport({ scale: width / (baseSize && baseSize.width ? baseSize.width : 612) });
          const ratio = Math.min(3, window.devicePixelRatio || 1);
          const buffer = document.createElement('canvas');
          buffer.width = Math.max(1, Math.round(viewport.width * ratio));
          buffer.height = Math.max(1, Math.round(viewport.height * ratio));
          const bufferCtx = buffer.getContext('2d');
          if (!bufferCtx) return;
          bufferCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
          await page.render({ canvasContext: bufferCtx, viewport }).promise;
          if (cancelled || tokenRef.current !== token) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = buffer.width;
          canvas.height = buffer.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(buffer, 0, 0);
          setRenderedAt(viewport.width);
          const content = await textContentOf(pdf, pageNumber);
          if (cancelled || tokenRef.current !== token) return;
          const Util = pdfjs && pdfjs.Util;
          if (!Util) {
            setItems([]);
            return;
          }
          const measure = document.createElement("canvas").getContext("2d");
          const spans = [];
          const rawItems = content.items || [];
          let bucket = inkWidthCache.get(pdf);
          if (!bucket) {
            bucket = new Map();
            inkWidthCache.set(pdf, bucket);
          }
          for (let index = 0; index < rawItems.length; index += 1) {
            const item = rawItems[index];
            if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
            const transform = Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(transform[2], transform[3]);
            if (!fontHeight) continue;
            const declared = Math.max(0, Number(item.width) || 0) * viewport.scale;
            spans.push({
              str: item.str,
              left: transform[4],
              top: transform[5] - fontHeight,
              baseline: transform[5],
              fontHeight,
              width: declared,
            });
          }
          
          // A run is as wide as the PDF says, and those widths are sometimes a few percent
          // short of the glyphs actually drawn, which accumulates along the line. Each
          // line is therefore measured against its own ink once, and every run on it is
          // scaled by that ratio: one correction instead of one per glyph.
          if (spans.length && buffer.width) {
            const ratio = Math.min(3, window.devicePixelRatio || 1);
            const groups = new Map();
            for (const span of spans) {
              const key = Math.round(span.baseline) + ":" + Math.round(span.fontHeight);
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key).push(span);
            }
            let pixels = null;
            for (const [key, group] of groups) {
              let factor = bucket.get(key);
              if (factor === undefined) {
                const first = group.reduce((a, b) => (b.left < a.left ? b : a));
                const last = group.reduce((a, b) => (b.left + b.width > a.left + a.width ? b : a));
                const declaredSpan = last.left + last.width - first.left;
                let inkRight = 0;
                if (declaredSpan > 0.5) {
                  if (!pixels) pixels = bufferCtx.getImageData(0, 0, buffer.width, buffer.height);
                  const x0 = Math.max(0, Math.floor(first.left * ratio));
                  const x1 = Math.min(pixels.width, Math.ceil((first.left + declaredSpan * 1.5) * ratio));
                  const y0 = Math.max(0, Math.floor((first.top - first.fontHeight * 0.4) * ratio));
                  const y1 = Math.min(pixels.height, Math.ceil((first.top + first.fontHeight * 1.4) * ratio));
                  if (x1 > x0 && y1 > y0) {
                    const right = measureInkRight(pixels.data, pixels.width, x0, x1, y0, y1);
                    if (right >= 0) inkRight = right / ratio;
                  }
                }
                // Never shrink a line: a loose scan (or a neighbour) may read too far,
                // but a short reading would hide real glyphs. Clamp to a sane range.
                factor = 1;
                if (inkRight > 0) {
                  const measured = (inkRight - first.left) / declaredSpan;
                  if (measured > 1) factor = Math.min(1.25, measured);
                }
                bucket.set(key, factor);
              }
              if (factor !== 1) {
                for (const span of group) span.width *= factor;
              }
            }
          }
          
          // One span per glyph, exactly like a CJK document: every character carries its own
          // position, so a width error stays local instead of accumulating along the line.
          const glyphs = [];
          for (const span of spans) {
            const chars = Array.from(span.str);
            const table = chars.length > 1 ? advanceTable(span.str, span.fontHeight) : null;
            const shares = table ? table.cumulative : null;
            const total = table ? table.total : 0;
            if (!shares || !(total > 0)) {
              const natural = measure ? measure.measureText(span.str).width : 0;
              const one = natural > 0 ? span.width / natural : 1;
              glyphs.push({
                str: span.str,
                left: span.left,
                top: span.top,
                fontHeight: span.fontHeight,
                width: span.width,
                scaleX: one,
                layoutWidth: one ? span.width / one : span.width,
              });
              continue;
            }
            for (let index = 0; index < chars.length; index += 1) {
              // Each glyph gets its own slice of the run width, taken from the cumulative
              // advance table, so the slices always add up to the run width exactly.
              const from = shares[index] / total;
              const to = shares[index + 1] / total;
              const left = span.left + span.width * from;
              const width = span.width * (to - from);
              const natural = shares[index + 1] - shares[index];
              const scaleX = natural > 0 ? width / natural : 1;
              glyphs.push({
                str: chars[index],
                left,
                top: span.top,
                fontHeight: span.fontHeight,
                width,
                scaleX,
                layoutWidth: scaleX ? width / scaleX : width,
              });
            }
          }
          setItems(glyphs);
        })().catch(() => setItems([]));
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible, pageNumber, width, pdf]);

      // Native selection drives it; every change repaints our own bands.
      React.useEffect(() => {
        const handler = () => readSelection();
        document.addEventListener("selectionchange", handler);
        return () => document.removeEventListener("selectionchange", handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      
      // A zoom re-lays the text layer. Measuring before the new spans commit would
      // record the old geometry, so the rects are recomputed once items land too.
      React.useEffect(() => {
        if (!live.length) return;
        readSelection(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [width, items]);
      
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

      // Native selection stays the engine; only its appearance is ours. Browser
      // ::selection is hidden in the text layer and these rects are painted instead,
      // so the selection, the hover band and the stored mark share one renderer.
      const readSelection = (keepIfLost) => {
        const wrap = wrapRef.current;
        const active = window.getSelection ? window.getSelection() : null;
        if (!wrap || !active || !active.rangeCount || active.isCollapsed) {
          if (!keepIfLost) {
            setLive([]);
            // The toolbar button is parent state, so it has to be told as well.
            if (onClear) onClear();
          }
          return;
        }
        const range = active.getRangeAt(0);
        if (!range || !wrap.contains(range.commonAncestorContainer)) {
          if (!keepIfLost) {
            setLive([]);
            // The toolbar button is parent state, so it has to be told as well.
            if (onClear) onClear();
          }
          return;
        }
        const box = wrap.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const rects = Array.from(range.getClientRects()).filter(
          (item) => item.width > 1 && item.height > 1,
        );
        if (!rects.length) {
          if (!keepIfLost) {
            setLive([]);
            // The toolbar button is parent state, so it has to be told as well.
            if (onClear) onClear();
          }
          return;
        }
        // Merge fragments that sit on one line: adjacent boxes painted separately
        // darker where they touch, which read as a seam.
        const merged = [];
        for (const rect of rects.slice().sort((a, b) => a.top - b.top || a.left - b.left)) {
          const last = merged[merged.length - 1];
          if (last && Math.abs(rect.top - last.top) < Math.max(2, rect.height * 0.4) && rect.left <= last.right + 0.6) {
            last.right = Math.max(last.right, rect.right);
            last.bottom = Math.max(last.bottom, rect.bottom);
            last.top = Math.min(last.top, rect.top);
            continue;
          }
          merged.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
        const bands = merged.map((item) => [
          (item.left - box.left) / box.width,
          (item.top - box.top) / box.height,
          (item.right - item.left) / box.width,
          (item.bottom - item.top) / box.height,
        ]);
        setLive(bands);
        if (!onSelect) return;
        let text = "";
        try {
          text = selectedTextInVisualOrder(wrap, range).replace(/\s+$/g, "");
        } catch (error) {
          // A per-character scan can trip on exotic encodings; the browser string is
          // still usable and must not take the whole handler down with it.
          text = "";
        }
        if (!text.trim()) text = String(range.toString() || "").replace(/\s+$/g, "");
        // An empty string still describes a real area: the bands are the locator, so the
        // mark button appears even when no characters could be recovered.
        const left = Math.min(...bands.map((item) => item[0]));
        const top = Math.min(...bands.map((item) => item[1]));
        const right = Math.max(...bands.map((item) => item[0] + item[2]));
        const bottom = Math.max(...bands.map((item) => item[1] + item[3]));
        onSelect(
          pageNumber,
          [left, top, right - left, bottom - top],
          bands.map((item) => item.map((value) => Math.round(value * 10000) / 10000)),
          text,
        );
      };

      return h(
        'div',
        {
          ref: wrapRef,
          className: 'dshcv-pdfpagebox',
          style: width ? { width: width + 'px', height: height + 'px' } : null,
          'data-page': pageNumber,
          'data-sharp': renderedAt && Math.abs(renderedAt - width) < 1 ? '1' : '0',
        },
        h('canvas', { ref: canvasRef, className: 'dshcv-pdfcanvas' }),
        h(
          'div',
          { className: 'dshcv-pdftext' },
          items.map((item, index) =>
            h(
              'span',
              {
                key: index,
                style: {
                  left: item.left + 'px',
                  top: item.top + 'px',
                  fontSize: item.fontHeight + 'px',
                  width: item.layoutWidth ? item.layoutWidth + 'px' : undefined,
                  transform: item.scaleX && item.scaleX !== 1 ? 'scaleX(' + item.scaleX + ')' : undefined,
                  transformOrigin: '0 0',
                  display: 'block',
                },
              },
              item.str,
            ),
          ),
        ),
        live.map((band, bandIndex) =>
          h("div", {
            key: "live" + bandIndex,
            className: "dshcv-pdfsel",
            style: {
              left: band[0] * 100 + "%",
              top: band[1] * 100 + "%",
              width: band[2] * 100 + "%",
              height: band[3] * 100 + "%",
            },
          }),
        ),
        pageHits.map((hit, index) =>
          (hit.rects || [hit.rect]).map((rect, rectIndex) =>
            h('div', {
              key: 'hit' + index + '-' + rectIndex,
              className: 'dshcv-pdfhit',
              'data-active':
                activeHit && activeHit.page === pageNumber && activeHit.index === hit.index ? '1' : '0',
              style: {
                left: rect[0] * 100 + '%',
                top: rect[1] * 100 + '%',
                width: rect[2] * 100 + '%',
                height: rect[3] * 100 + '%',
              },
            }),
          ),
        ),
        // Text marks stay invisible until the rail row is hovered: a permanent tint
        // reads as "this text is selected". Dragged regions keep their outline.
        pageMarks.map((mark, index) =>
          mark.text
            ? null
            : h('div', {
                key: 'mark' + index,
                className: 'dshcv-pdfregion',
                style: {
                  left: mark.rect[0] * 100 + '%',
                  top: mark.rect[1] * 100 + '%',
                  width: mark.rect[2] * 100 + '%',
                  height: mark.rect[3] * 100 + '%',
                },
              }),
        ),
        hoverBands && hoverBands.length
          ? hoverBands.map((band, bandIndex) =>
              h('div', {
                key: 'hover' + bandIndex,
                className: 'dshcv-pdftexthit dshcv-pdftexthit-hot',
                style: {
                  left: band[0] * 100 + '%',
                  top: band[1] * 100 + '%',
                  width: band[2] * 100 + '%',
                  height: band[3] * 100 + '%',
                },
              }),
            )
          : hoverRect
            ? h('div', {
                className: 'dshcv-pdfregion dshcv-pdfregion-hot',
                style: {
                  left: hoverRect[0] * 100 + '%',
                  top: hoverRect[1] * 100 + '%',
                  width: hoverRect[2] * 100 + '%',
                  height: hoverRect[3] * 100 + '%',
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

