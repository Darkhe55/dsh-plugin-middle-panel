// 图片像素炸弹防护：只读文件头判断尺寸，超过上限在解码前拒绝。
const { readSource } = require('./_source.cjs');
const src = readSource();

const start = src.indexOf('const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;');
const end = src.indexOf('// ---------------- html viewer with element picking ----------------');
if (start < 0 || end < 0) {
  console.log('anchors missing');
  process.exit(1);
}
const body = src.slice(start, end);
const api = new Function(body + '\nreturn { imagePixelSize, imageTooLarge, MAX_IMAGE_PIXELS };')();

let failures = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !detail ? '' : ' → ' + detail));
  if (!ok) failures += 1;
};

/** 合成 PNG 头（IHDR 段） */
const pngHeader = (width, height) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

/** 合成 JPEG 头：SOI + SOF0 */
const jpegHeader = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xc0], 2);
  bytes.set([0x00, 0x11], 4);
  bytes[6] = 8;
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
};

/** 合成 GIF 头 */
const gifHeader = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
};

// 1) 各格式尺寸解析
const png = api.imagePixelSize(pngHeader(800, 600));
check(png && png.width === 800 && png.height === 600, 'PNG 尺寸解析正确', JSON.stringify(png));

const jpg = api.imagePixelSize(jpegHeader(1024, 768));
check(jpg && jpg.width === 1024 && jpg.height === 768, 'JPEG 尺寸解析正确', JSON.stringify(jpg));

const gif = api.imagePixelSize(gifHeader(320, 200));
check(gif && gif.width === 320 && gif.height === 200, 'GIF 尺寸解析正确', JSON.stringify(gif));

// 2) 正常图片不被拒绝
check(api.imageTooLarge(pngHeader(800, 600), 'a.png') === 0, '普通图片通过检查');

// 3) 像素炸弹被拒绝
const bomb = api.imageTooLarge(pngHeader(20000, 20000), 'big.png');
check(bomb === 400000000, '2 万 × 2 万像素被识别为超限', String(bomb));

// 4) JPEG 像素炸弹也拦得住
const jpegBomb = api.imageTooLarge(jpegHeader(30000, 30000), 'bomb.jpg');
check(jpegBomb > api.MAX_IMAGE_PIXELS, 'JPEG 像素炸弹被拦下', String(jpegBomb));

// 5) SVG 不受像素上限约束（矢量）
check(api.imageTooLarge(pngHeader(20000, 20000), 'vector.svg') === 0, 'SVG 不被像素上限拒绝');

// 6) 无法解析的头不误杀
check(api.imageTooLarge(new Uint8Array([1, 2, 3, 4]), 'weird.bin') === 0, '未知格式不误判');

if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
