// 天気図の画像を、地図（Cesium の地球儀）にぴったり重ねるための座標変換
//
//   気象庁の天気図はいずれも「ポーラーステレオ図法」（北極を中心に放射状に経線が出る図法）。
//   画像の中の経緯線を読み取って、北極点の位置（px, py）・縮尺 k・中心の経度 lon0 を求めておき、
//   緯度経度 → 画像の画素 の式で画像を「緯度経度の格子（正距円筒）」に描き直してから地図に貼る。
//
//     ρ = k · tan((90° − 緯度) / 2)
//     x = px + ax · ρ · sin(経度 − lon0)
//     y = py + ρ · cos(経度 − lon0)
//
//   値は 2026-10 の実際の図で経緯線を検出して決めたもの（誤差は数画素＝おおむね 0.1° 以内）。
//   PDF の値は pdf.js で scale 1 に描いたときの座標（描画倍率 s を掛けて使う）。
import * as Cesium from 'cesium';

const AUPQ = { lon0: 140, px: 487.0, k: 789.3, ax: 1, wetGreen: true };   // wetGreen … 湿域を塗った濃い緑を、地図でもはっきり出す
const AUPA = { lon0: 141, px: 441.65, py: 122.08, k: 673.7, ax: 1, frame: [42, 76, 835, 717] };

// FXFE：1面の大きさは 880×679 画素（150dpi）。左の面の東経140度は x=684、北極は y=−420.5（下段の面の上端から）、k=1526 画素
function fxfePanels(top, bottom) {
  const P = (px, py, frame) => ({ lon0: 140, px, py, k: 732.5, ax: 1, frame });
  return {
    [`${top}_12`]: P(328.3, -193.2, [43, 10, 463, 333]), [`${top}_24`]: P(765.1, -193.2, [480, 10, 900, 333]),
    [`${bottom}_12`]: P(328.3, 155.3, [43, 358, 463, 682]), [`${bottom}_24`]: P(765.1, 155.3, [480, 358, 900, 682]),
  };
}
export const PROJ = {
  // 地上天気図（気象庁 600×581 画像）。横がわずかに縮んでいるため ax で補正
  sfc: { lon0: 140, px: 342.2, py: -288.5, k: 1098.9, ax: 0.9582, frame: [8, 6, 588, 573], mask: [[0, 0, 152, 30]] },
  sfc24: { lon0: 140, px: 342.2, py: -288.5, k: 1098.9, ax: 0.9582, frame: [8, 6, 588, 573], mask: [[0, 0, 152, 30]] },
  // 国内悪天予想図（1525×1130 画像、左の凡例部分は除く）
  fbjp: { lon0: 140, px: 1184, py: -1501, k: 3895, ax: 1, frame: [346, 42, 1478, 1088], jetRed: true },   // ジェット気流（濃い緑）は赤にする（3D表示と同じ色）
  // 高層天気図 AUPQ（上下2段。上段・下段で北極点の y だけが違う）
  aupq78: { pdf: true, panels: {
    850: { ...AUPQ, py: 369.8, frame: [20, 545, 704, 1011] },
    700: { ...AUPQ, py: -132.2, frame: [20, 44, 704, 509] } } },
  aupq35: { pdf: true, panels: {
    500: { ...AUPQ, py: 369.8, frame: [20, 545, 704, 1011] },
    300: { ...AUPQ, py: -132.2, frame: [20, 44, 704, 509] } } },
  // 極東域の予想図 FXFE502・FXFE5782（4面：上段・下段 × 12時間・24時間）。東経140度が縦の直線
  fxfe502: { pdf: true, order: ['500_24', '500_12', 'sfc_24', 'sfc_12'],
    labels: { '500_12': '500hPa 12h', '500_24': '500hPa 24h', 'sfc_12': '地上 12h', 'sfc_24': '地上 24h' }, panels: fxfePanels('500', 'sfc') },
  fxfe5782: { pdf: true, order: ['500_24', '500_12', '850_24', '850_12'],
    labels: { '500_12': '500/700hPa 12h', '500_24': '500/700hPa 24h', '850_12': '850/700hPa 12h', '850_24': '850/700hPa 24h' }, panels: fxfePanels('500', '850') },
  // 日本域の 850hPa 相当温位・風の予想図 FXJP854（4面：上段 12h・24h、下段 36h・48h）
  //   PDF の経緯線（経線は10°ごとの直線、緯線は北緯20〜50°の円弧）から求めた値。東経140度が縦の直線
  fxjp854: { pdf: true, order: ['12', '24', '36', '48'],
    labels: { 12: '850hPa 12h', 24: '850hPa 24h', 36: '850hPa 36h', 48: '850hPa 48h' }, panels: {
      12: { lon0: 140, px: 263.27, py: -260.93, k: 910.8, ax: 1, frame: [8.1, 43.0, 359.6, 394.5] },
      24: { lon0: 140, px: 620.43, py: -260.93, k: 910.8, ax: 1, frame: [365.3, 43.0, 716.8, 394.5] },
      36: { lon0: 140, px: 263.27, py: 124.57, k: 910.8, ax: 1, frame: [8.1, 428.5, 359.6, 780.0] },
      48: { lon0: 140, px: 620.43, py: 124.57, k: 910.8, ax: 1, frame: [365.3, 428.5, 716.8, 780.0] } } },
  // アジア太平洋域の 24時間予想図 FUPA（AUPA と同じ図法・同じ枠）
  fupa252: { pdf: true, panels: { 250: AUPA } },
  fupa302: { pdf: true, panels: { 300: AUPA } },
  fupa502: { pdf: true, panels: { 500: AUPA } },
  // 高層天気図 AUPA（アジア太平洋域、1段）
  aupa25: { pdf: true, panels: { 250: AUPA } },
  aupa20: { pdf: true, panels: { 200: AUPA } },
};

const D2R = Math.PI / 180;

/** 投影の式（緯度経度 → 画像の画素）。s は描画倍率 */
function forward(P, s, lat, lon) {
  const r = s * P.k * Math.tan((90 - lat) / 2 * D2R);
  const t = (lon - P.lon0) * D2R;
  return [s * P.px + P.ax * r * Math.sin(t), s * P.py + r * Math.cos(t)];
}
/** 逆の式（画像の画素 → 緯度経度） */
function inverse(P, s, x, y) {
  const dx = (x - s * P.px) / P.ax, dy = y - s * P.py;
  const r = Math.hypot(dx, dy) / (s * P.k);
  return [90 - 2 * Math.atan(r) / D2R, P.lon0 + Math.atan2(dx, dy) / D2R];
}

/** 図の枠の範囲（緯度経度）。北極が図に入るときは北緯72°で切る */
function geoBox(P, s) {
  const [x0, y0, x1, y1] = P.frame.map(v => v * s);
  let w = 999, e = -999, so = 99, n = -99;
  const add = (x, y) => { const [la, lo] = inverse(P, s, x, y); w = Math.min(w, lo); e = Math.max(e, lo); so = Math.min(so, la); n = Math.max(n, la); };
  for (let i = 0; i <= 40; i++) {
    const fx = x0 + (x1 - x0) * i / 40, fy = y0 + (y1 - y0) * i / 40;
    add(fx, y0); add(fx, y1); add(x0, fy); add(x1, fy);
  }
  const [pxp, pyp] = [s * P.px, s * P.py];
  if (pxp > x0 && pxp < x1 && pyp > y0 && pyp < y1) { n = 90; w = -180; e = 180; }
  return { w: Math.max(w, 80), e: Math.min(e, 180), s: Math.max(so, -5), n: Math.min(n, 72) };
}

/**
 * 図の画像（canvas か img）を緯度経度の格子に描き直す
 *   style 'light' … 背景（白・海陸の塗り）を透明にし、黒い線を白く、色の線を明るくする（暗い地図の上で見やすい）
 *   style 'raw'   … 元の色のまま
 */
export function warpChart(src, P, { s = 1, outW = 2048, style = 'light' } = {}) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0);
  const S = sctx.getImageData(0, 0, sw, sh).data;

  const box = geoBox(P, s);
  const W = outW, H = Math.max(2, Math.round(outW * (box.n - box.s) / (box.e - box.w)));
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H), O = img.data;
  const [fx0, fy0, fx1, fy1] = P.frame.map(v => v * s);
  const masks = (P.mask || []).map(m => m.map(v => v * s));

  // 経度ごとの sin/cos を先に計算
  const sinT = new Float32Array(W), cosT = new Float32Array(W);
  for (let i = 0; i < W; i++) { const lon = box.w + (i + 0.5) / W * (box.e - box.w); const t = (lon - P.lon0) * D2R; sinT[i] = Math.sin(t); cosT[i] = Math.cos(t); }

  for (let j = 0; j < H; j++) {
    const lat = box.n - (j + 0.5) / H * (box.n - box.s);
    const r = s * P.k * Math.tan((90 - lat) / 2 * D2R);
    for (let i = 0; i < W; i++) {
      const x = s * P.px + P.ax * r * sinT[i], y = s * P.py + r * cosT[i];
      if (x < fx0 || x > fx1 || y < fy0 || y > fy1) continue;
      if (masks.some(m => x >= m[0] && x <= m[2] && y >= m[1] && y <= m[3])) continue;
      // 4画素の重み付き平均（拡大してもギザギザにならないように）
      const x0 = Math.min(sw - 2, x | 0), y0 = Math.min(sh - 2, y | 0), tx = x - x0, ty = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const R = S[i00] * w00 + S[i10] * w10 + S[i01] * w01 + S[i11] * w11;
      const G = S[i00 + 1] * w00 + S[i10 + 1] * w10 + S[i01 + 1] * w01 + S[i11 + 1] * w11;
      const B = S[i00 + 2] * w00 + S[i10 + 2] * w10 + S[i01 + 2] * w01 + S[i11 + 2] * w11;
      const A = S[i00 + 3] * w00 + S[i10 + 3] * w10 + S[i01 + 3] * w01 + S[i11 + 3] * w11;
      if (A < 10) continue;
      const o = (j * W + i) * 4;
      // AUPQ78 の湿域（濃い緑に塗った所）は、地図でも濃い緑で残す（経緯線の緑と区別）
      if (P.wetGreen && G > R + 60 && G > B + 50 && style !== 'raw') { O[o] = 30; O[o + 1] = 150; O[o + 2] = 60; O[o + 3] = 150; continue; }
      // 悪天予想図のジェット気流（濃い緑の線と FL の文字）は赤で描く
      if (P.jetRed && G > R + 30 && G > B + 20 && R <= 60 && G < 200) { O[o] = 235; O[o + 1] = 40; O[o + 2] = 40; O[o + 3] = 255; continue; }
      if (style === 'raw') { O[o] = R; O[o + 1] = G; O[o + 2] = B; O[o + 3] = 235; continue; }
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), L = (R + G + B) / 3, sat = mx - mn;
      if (sat < 50) {                       // 白〜灰〜黒：黒い線ほど濃い白にする
        const a = Math.min(1, Math.max(0, (225 - L) / 140));
        if (a <= 0.05) continue;
        O[o] = 255; O[o + 1] = 255; O[o + 2] = 255; O[o + 3] = a * 255;
      } else {
        if (L > 175 && sat < 110) continue;  // 海・陸の淡い塗り
        if (G > R + 30 && G > B + 10 && R > 40) {   // 緑系（経緯線・海岸線）は控えめに
          O[o] = 170; O[o + 1] = 255; O[o + 2] = 170; O[o + 3] = 90; continue;
        }
        const f = 255 / Math.max(mx, 1);     // 色の線は明るくして、少し白を混ぜる
        O[o] = Math.min(255, R * f * 0.75 + 64); O[o + 1] = Math.min(255, G * f * 0.75 + 64); O[o + 2] = Math.min(255, B * f * 0.75 + 64); O[o + 3] = 255;
      }
    }
  }
  octx.putImageData(img, 0, 0);
  return { canvas: out, box };
}

/** 描き直した図を Cesium の画像レイヤとして追加する */
export async function addChartLayer(viewer, warped, { alpha = 0.9 } = {}) {
  const { canvas, box } = warped;
  const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
  const url = URL.createObjectURL(blob);
  const provider = new Cesium.SingleTileImageryProvider({
    url, tileWidth: canvas.width, tileHeight: canvas.height,
    rectangle: Cesium.Rectangle.fromDegrees(box.w, box.s, box.e, box.n), credit: new Cesium.Credit('気象庁'),
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.alpha = alpha;
  layer._awBlobUrl = url;
  return layer;
}
export function removeChartLayer(viewer, layer) {
  if (!layer) return;
  viewer.imageryLayers.remove(layer, true);
  if (layer._awBlobUrl) URL.revokeObjectURL(layer._awBlobUrl);
}

export { forward as projForward, inverse as projInverse };
