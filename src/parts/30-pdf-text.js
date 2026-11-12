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
