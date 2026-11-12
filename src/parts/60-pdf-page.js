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
      // Until the page geometry is known nothing is drawn: assuming Letter first made
      // the column jump once the real size arrived.
      const known = Boolean(baseSize && baseSize.width && baseSize.height);
      const width = known ? Math.max(0, baseSize.width * scale) : 0;
      const height = known ? Math.max(0, baseSize.height * scale) : 0;
      const [items, setItems] = React.useState([]);

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
        if (!visible || !pdf || !width || !known) return undefined;
        const token = tokenRef.current + 1;
        tokenRef.current = token;
        let cancelled = false;
        (async () => {
          const page = await pdf.getPage(pageNumber);
          if (cancelled || tokenRef.current !== token) return;
          const viewport = page.getViewport({ scale: known ? width / baseSize.width : 1 });
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
      const itemStyles = content.styles || {};

for (let index = 0; index < rawItems.length; index += 1) {
            const item = rawItems[index];
            if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
            const transform = Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(transform[2], transform[3]);
            if (!fontHeight) continue;
            const declared = Math.max(0, Number(item.width) || 0) * viewport.scale;
            spans.push({
              str: item.str,
              family: (itemStyles[item.fontName] && itemStyles[item.fontName].fontFamily) || "",
              left: transform[4],
              top: transform[5] - fontHeight,
              baseline: transform[5],
              fontHeight,
              width: declared,
            });
          }
          
// Run widths come straight from the PDF. An ink-based widening was tried and
// removed: the declared advances already match the drawn glyphs, and a loose
// scan of a busy page could inflate a whole line by up to 25%.
          
          // One span per glyph, exactly like a CJK document: every character carries its own
          // position, so a width error stays local instead of accumulating along the line.
          const glyphs = [];
          for (const span of spans) {
            const chars = Array.from(span.str);
            const table = chars.length > 1 ? advanceTable(span.str, span.fontHeight, span.family) : null;
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
            if (onClear) onClear(pageNumber);
          }
          return;
        }
        const range = active.getRangeAt(0);
        if (!range || !wrap.contains(range.commonAncestorContainer)) {
          if (!keepIfLost) {
            setLive([]);
            // The toolbar button is parent state, so it has to be told as well.
            if (onClear) onClear(pageNumber);
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
            if (onClear) onClear(pageNumber);
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
