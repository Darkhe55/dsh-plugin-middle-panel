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
