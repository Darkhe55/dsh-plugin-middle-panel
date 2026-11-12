    const MEASURE_FONT = "Arial, Helvetica, sans-serif";
    let measureCtx = null;
    // Cumulative advance table for a string, in the measuring font.
    const advanceTable = (text, fontSize, family) => {
      if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
      if (!measureCtx || !text) return null;
      measureCtx.font = fontSize + "px " + (family || MEASURE_FONT);
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
