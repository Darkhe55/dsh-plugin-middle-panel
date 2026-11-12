const { readSource } = require('./_source.cjs');
// Collada geometry: the indirection, the index maths, and the DOM reading, without
// a browser. The fake DOM implements only the handful of methods the reader uses.
const fs = require('fs');
const src = readSource();
const start = src.indexOf('const readCollada = (xml) => {');
const end = src.indexOf('const parseCollada = (bytes) => {');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const factory = new Function(src.slice(start, end) + '\nreturn { readCollada, triangulateCollada };');
const { readCollada, triangulateCollada } = factory();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

// Minimal element: enough for getAttribute, children, textContent, contains and
// the two getElementsByTagName flavours the reader calls.
const el = (name, attrs, children, text) => {
  const node = {
    tagName: name,
    localName: String(name).split(':').pop(),
    attributes: attrs || {},
    children: children || [],
    textContent: text === undefined ? '' : String(text),
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    },
    getElementsByTagName(tag) {
      const out = [];
      const walk = (item) => {
        for (const child of item.children) {
          if (tag === '*' || child.localName === tag || child.tagName === tag) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    contains(other) {
      let found = false;
      const walk = (item) => {
        if (item === other) found = true;
        for (const child of item.children) walk(child);
      };
      walk(this);
      return found;
    },
  };
  return node;
};

const squareArray = el('float_array', { id: 'pos-array', count: '12' }, [], '0 0 0 1 0 0 1 1 0 0 1 0');
const sourceNode = el('source', { id: 'pos' }, [squareArray]);
const positionInput = el('input', { semantic: 'POSITION', source: '#pos' });
const verticesNode = el('vertices', { id: 'verts' }, [positionInput]);
const triangleInput = el('input', { semantic: 'VERTEX', source: '#verts', offset: '0' });
const pNode = el('p', {}, [], '0 1 2 0 2 3');
const trianglesNode = el('triangles', { count: '2' }, [triangleInput, pNode]);
const mesh = el('mesh', {}, [sourceNode, verticesNode, trianglesNode]);
const geometry = el('geometry', { id: 'g' }, [mesh]);
const root = el('COLLADA', {}, [geometry]);

const model = readCollada(root);
check(model.sources.has('pos-array'), 'source 的子 float_array 被读到', JSON.stringify([...model.sources.keys()]));
check(model.vertices.get('verts') === 'pos', 'vertices 的 POSITION 指向 source', String(model.vertices.get('verts')));
check(model.primitives.length === 1 && model.primitives[0].inputs[0].source === 'verts', 'triangles 的 VERTEX 指向 vertices');

const sample = triangulateCollada(model);
check(sample.positions.length === 18, '样例网格得到两个三角形', '浮点数 ' + sample.positions.length);
check(
  Array.from(sample.positions.slice(0, 9)).join(',') === '0,0,0,1,0,0,1,1,0',
  '第一个三角形坐标正确',
  Array.from(sample.positions.slice(0, 9)).join(','),
);

// Namespaced document: <c:triangles> must still be found.
const nsTriangles = el('c:triangles', {}, [el('c:input', { semantic: 'VERTEX', source: '#pos' }), el('c:p', {}, [], '0 1 2')]);
const nsRoot = el('c:COLLADA', {}, [el('c:geometry', {}, [el('c:mesh', {}, [el('c:source', { id: 'pos' }, [el('c:float_array', { id: 'pos-array' }, [], '0 0 0 1 0 0 1 1 0')]), nsTriangles])])]);
const nsModel = readCollada(nsRoot);
check(nsModel.primitives.length === 1, '带命名空间前缀的 triangles 能被识别', String(nsModel.primitives.length));
check(triangulateCollada(nsModel).positions.length === 9, '带前缀的文档也能三角化');

// A source that must be looked up through its array id.
const byArrayId = {
  sources: new Map([['arr', [0, 0, 0, 1, 0, 0, 1, 1, 0]]]),
  vertices: new Map(),
  primitives: [{ kind: 'triangles', inputs: [{ semantic: 'VERTEX', source: 'arr', offset: 0 }], p: [0, 1, 2] }],
};
check(triangulateCollada(byArrayId).positions.length === 9, '直接引用数组 id 也能解析');

// polylist / strips / fans / polygons
const base = { sources: new Map([['pos', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]]]), vertices: new Map() };
const withInputs = (kind, extra) => ({
  ...base,
  primitives: [{ kind, inputs: [{ semantic: 'VERTEX', source: 'pos', offset: 0 }], ...extra }],
});
check(triangulateCollada(withInputs('polylist', { p: [0, 1, 2, 3, 0, 2, 3], vcount: [4, 3] })).positions.length === 27, 'polylist：四边形 + 三角形 = 3 个三角形');
check(triangulateCollada(withInputs('tristrips', { p: [0, 1, 2, 3] })).positions.length === 18, 'tristrips 生成两个三角形');
check(
  Array.from(triangulateCollada(withInputs('tristrips', { p: [0, 1, 2, 3] })).positions.slice(9, 18)).join(',') === '1,1,0,1,0,0,0,1,0',
  'tristrips 第二个三角形绕序翻转',
);
check(triangulateCollada(withInputs('trifans', { p: [0, 1, 2, 3] })).positions.length === 18, 'trifans 生成两个三角形');
check(triangulateCollada(withInputs('polygons', { polygons: [[0, 1, 2, 3], [0, 2, 3]] })).positions.length === 27, 'polygons 每个多边形独立三角化');

// 交错属性
const interleaved = {
  sources: new Map([['pos', [0, 0, 0, 1, 0, 0, 1, 1, 0]]]),
  vertices: new Map(),
  primitives: [
    {
      kind: 'triangles',
      inputs: [
        { semantic: 'VERTEX', source: 'pos', offset: 0 },
        { semantic: 'NORMAL', source: 'nrm', offset: 1 },
      ],
      p: [0, 0, 1, 0, 2, 0],
    },
  ],
};
check(Array.from(triangulateCollada(interleaved).positions).join(',') === '0,0,0,1,0,0,1,1,0', '交错步长按最大 offset 计算');

check(triangulateCollada({ sources: new Map(), vertices: new Map(), primitives: [] }).positions.length === 0, '空模型不抛错');
check(
  triangulateCollada({
    sources: new Map(),
    vertices: new Map(),
    primitives: [{ kind: 'triangles', inputs: [{ semantic: 'VERTEX', source: 'missing', offset: 0 }], p: [0, 1, 2] }],
  }).positions.length === 0,
  '引用不到的 source 被跳过',
);

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}

