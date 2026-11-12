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


