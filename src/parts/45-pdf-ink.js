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
