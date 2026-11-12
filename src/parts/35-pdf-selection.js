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
