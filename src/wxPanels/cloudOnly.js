// 衛星画像の「雲だけ」表示
//   ひまわりのタイル画像は、雲のない所（地面・海）が黒〜濃い灰色で塗られているため、そのまま重ねると地形が見えない。
//   タイルを読み込むたびに明るさから不透明度を決め、暗い所（雲のない所）を透明にしてから地図に貼る。
//     明るさ ≤ lo … 透明、lo〜hi … だんだん不透明、≥ hi … 不透明
//   赤外（B13 TBB）の明るさは雲頂温度（白いほど冷たい＝高い雲）、可視（B03 ALBD）は反射の強さ。
import * as Cesium from 'cesium';

//   赤外は「その辺りの晴れた所（海面・地面）の温度」を画像から推定し、それより 8℃ほど冷たい所から雲として見せる
//   （adaptive）。南の海（海面 25℃以上）では、雲頂が +10℃前後の低い雲（積雲・層積雲）も見えるようにするため。
//   明るさと温度：明るさ 0 ≒ +40℃、255 ≒ −80℃（1℃ ≒ 2.1）。地面の明るさ＝256×256 ごとの暗い方から 5% の値
export const CLOUD_ONLY = {
  ir: { lo: 75, hi: 170, white: true, adaptive: true },     // 晴れた所が分からないときは 約 +5℃ から見え始め、約 −40℃ で不透明
  vis: { lo: 80, hi: 185, white: true },    // 地面・海（反射率が低い）は透明、雲（明るい）を残す
  snd: { lo: 70, hi: 165, white: false },   // 雲頂強調画像：冷たい雲頂の色はそのまま残す
};

export function toCloudCanvas(img, { lo, hi, white, adaptive = false }) {
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // Cesium はタイルを「上下反転済みの ImageBitmap」で渡してくる（GPU に送るときの都合）。
  //   そのまま canvas に描くと上下逆になり、canvas は送るときにもう一度反転されるため、タイルごとに上下が逆さまになる。
  //   ここで反転を戻してから描く
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) { ctx.translate(0, h); ctx.scale(1, -1); }
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const d = ctx.getImageData(0, 0, w, h), p = d.data;
  const loAt = adaptive ? clearSkyLo(p, w, h, lo) : () => lo, span = hi - lo;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    const L = loAt(x, y);
    const m = Math.max(p[i], p[i + 1], p[i + 2]);
    const a = Math.min(1, Math.max(0, (m - L) / span));
    if (white) { const v = 200 + 55 * a; p[i] = p[i + 1] = p[i + 2] = v; }   // 灰色の雲は白く
    p[i + 3] = Math.round(255 * a * (0.55 + 0.45 * a));                      // 薄い雲ほど薄く
  }
  ctx.putImageData(d, 0, 0);
  return cv;
}
/** 256×256 ごとに晴れた所の明るさ（暗い方から 5%）を求め、雲として見せ始める明るさ（＋8℃ぶん冷たい）をなめらかにつなぐ */
export function clearSkyLo(p, w, h, cap, B = 256) {
  const nx = Math.max(1, Math.round(w / B)), ny = Math.max(1, Math.round(h / B)), g = new Float32Array(nx * ny);
  const hist = new Uint32Array(256);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    hist.fill(0); let n = 0;
    for (let y = Math.floor(j * h / ny); y < Math.floor((j + 1) * h / ny); y += 2) for (let x = Math.floor(i * w / nx); x < Math.floor((i + 1) * w / nx); x += 2) {
      const k = (y * w + x) * 4, m = Math.max(p[k], p[k + 1], p[k + 2]);
      if (m >= 6) { hist[m]++; n++; }                 // 地球の外（黒）は除く
    }
    let c = 0, v = cap;
    if (n > 200) for (let b = 0; b < 256; b++) { c += hist[b]; if (c >= n * 0.05) { v = b; break; } }
    g[j * nx + i] = Math.max(40, Math.min(cap, v + 17));   // +8℃ぶん。南の海でも明るさ 40（＋21℃）より下は雲にしない
  }
  return (x, y) => {                                  // ブロックの中心どうしを直線でつなぐ
    const fx = Math.min(nx - 1, Math.max(0, x / (w / nx) - 0.5)), fy = Math.min(ny - 1, Math.max(0, y / (h / ny) - 0.5));
    const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1), a = fx - i0, b = fy - j0;
    return (g[j0 * nx + i0] * (1 - a) + g[j0 * nx + i1] * a) * (1 - b) + (g[j1 * nx + i0] * (1 - a) + g[j1 * nx + i1] * a) * b;
  };
}

/** 雲だけを残すタイルの読み込み口（UrlTemplateImageryProvider と同じ指定＋ cloud: CLOUD_ONLY.ir など） */
export class CloudOnlyImageryProvider extends Cesium.UrlTemplateImageryProvider {
  constructor(options) {
    super({ ...options, hasAlphaChannel: true });
    this._cloud = options.cloud || CLOUD_ONLY.ir;
  }
  requestImage(x, y, level, request) {
    const p = super.requestImage(x, y, level, request);
    if (!p) return p;                                // 混雑時は Cesium があとで取り直す
    return Promise.resolve(p).then(img => toCloudCanvas(img, this._cloud));
  }
}
