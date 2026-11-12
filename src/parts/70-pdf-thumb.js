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
