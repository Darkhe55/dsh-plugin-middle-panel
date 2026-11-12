const { readSource } = require('./_source.cjs');
// 帧率探测：用合成的最小 MP4 结构验证解析器，避免依赖真实素材。
const fs = require('fs');
const src = readSource();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

const start = src.indexOf('    const MP4_COMMON_RATES =');
const end = src.indexOf('    function VideoDoc(props) {');
if (start < 0 || end < 0) {
  console.log('FAIL 帧率解析锚点缺失');
  process.exit(1);
}

const api = new Function(
  src.slice(start, end) + '\nreturn { probeMp4FrameRate, snapFrameRate };',
)();

// ---- 构造盒子的工具 ----
const box = (type, payload) => {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
};
const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0));
  return out;
};
const u8s = (...values) => new Uint8Array(values);
const concat = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const fourcc = (text) => u8s(...text.split('').map((char) => char.charCodeAt(0)));

const makeMp4 = ({ timescale, duration, samples, handler = 'vide', version = 0 }) => {
  const stts = box('stts', concat([u32(0), u32(1), u32(samples), u32(1)]));
  const stbl = box('stbl', stts);
  const minf = box('minf', stbl);
  const hdlr = box('hdlr', concat([u32(0), u32(0), fourcc(handler), u32(0), u32(0), u32(0)]));
  const mdhd =
    version === 1
      ? box('mdhd', concat([u8s(1, 0, 0, 0), u32(0, 0), u32(0, 0), u32(timescale), u32(0), u32(duration), u32(0)]))
      : box('mdhd', concat([u32(0), u32(0, 0), u32(timescale), u32(duration), u32(0)]));
  const mdia = box('mdia', concat([mdhd, hdlr, minf]));
  const trak = box('trak', mdia);
  const moov = box('moov', trak);
  const ftyp = box('ftyp', concat([fourcc('isom'), u32(0x200)]));
  return concat([ftyp, moov]);
};

// ---- 抓取：30fps ----
let bytes = makeMp4({ timescale: 30000, duration: 30000 * 10, samples: 300 });
check(api.probeMp4FrameRate(bytes) === 30, '30fps 素材解析为 30', String(api.probeMp4FrameRate(bytes)));

// ---- 25fps（PAL）----
bytes = makeMp4({ timescale: 25000, duration: 25000 * 4, samples: 100 });
check(api.probeMp4FrameRate(bytes) === 25, '25fps 解析为 25', String(api.probeMp4FrameRate(bytes)));

// ---- 23.976 ----
bytes = makeMp4({ timescale: 24000, duration: 24000 * 100, samples: 2397 });
check(Math.abs(api.probeMp4FrameRate(bytes) - 23.976) < 0.001, '23.976 吸附正确', String(api.probeMp4FrameRate(bytes)));

// ---- 60fps，version 1 的 mdhd ----
bytes = makeMp4({ timescale: 60000, duration: 60000 * 3, samples: 180, version: 1 });
check(api.probeMp4FrameRate(bytes) === 60, 'version=1 的 mdhd 也能解析', String(api.probeMp4FrameRate(bytes)));

// ---- 非视频轨跳过 ----
const withAudioFirst = (() => {
  const audio = box('trak', box('mdia', concat([
    box('mdhd', concat([u32(0), u32(0, 0), u32(48000), u32(48000 * 10), u32(0)])),
    box('hdlr', concat([u32(0), u32(0), fourcc('soun'), u32(0), u32(0), u32(0)])),
    box('minf', box('stbl', box('stts', concat([u32(0), u32(1), u32(480000), u32(1)])))),
  ])));
  const video = box('trak', box('mdia', concat([
    box('mdhd', concat([u32(0), u32(0, 0), u32(30000), u32(30000 * 5), u32(0)])),
    box('hdlr', concat([u32(0), u32(0), fourcc('vide'), u32(0), u32(0), u32(0)])),
    box('minf', box('stbl', box('stts', concat([u32(0), u32(1), u32(150), u32(1)])))),
  ])));
  return concat([box('ftyp', concat([fourcc('isom'), u32(0x200)])), box('moov', concat([audio, video]))]);
})();
check(api.probeMp4FrameRate(withAudioFirst) === 30, '跳过音轨，取视频轨', String(api.probeMp4FrameRate(withAudioFirst)));

// ---- 异常输入不抛错 ----
check(api.probeMp4FrameRate(new Uint8Array(0)) === null, '空数据返回 null');
check(api.probeMp4FrameRate(new Uint8Array([1, 2, 3])) === null, '过短数据返回 null');
check(api.probeMp4FrameRate(concat([box('ftyp', u32(0))])) === null, '没有 moov 返回 null');
check(api.probeMp4FrameRate(null) === null, 'null 安全');
check(api.probeMp4FrameRate(new Uint8Array(64)) === null, '全零数据不抛错');

// ---- 吸附与边界 ----
check(api.snapFrameRate(30.02) === 30, '30.02 吸附到 30（最近的赢）');
check(api.snapFrameRate(29.9) === 29.97, '29.9 归到 29.97');
check(api.snapFrameRate(24.05) === 24, '24.05 吸附到 24');
check(api.snapFrameRate(59.9) === 59.94, '59.9 归到 59.94');
check(api.snapFrameRate(31.5) === 31.5, '非标准帧率原样保留');
check(api.snapFrameRate(0) === null, '0 无效');
check(api.snapFrameRate(400) === null, '过高无效');
check(api.snapFrameRate(NaN) === null, 'NaN 无效');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
