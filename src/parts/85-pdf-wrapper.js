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
