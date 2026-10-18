// 雲頂の高さに合わせた 3D 雲（リアルタイム）
//   ひまわり赤外の雲頂温度（TBB）を、気象庁モデルの気温の鉛直分布に当てはめて雲頂の高さを求め、
//   その高さの面（雲のふた）として地球儀に描く。色は雲頂の高さ（FL）で塗り分ける。
//   高さは画面の高度倍率（1倍／100倍）に合わせる。
//   範囲（2026-10-17 から）：アジア全域＝衛星画像の「3D：雲頂の高さ」と同じ 東経 78.75〜168.75 度・南緯 21.9〜北緯 55.8 度、
//   格子 0.2 度（以前は 北海道〜沖縄 だけ・0.1 度）。気温の鉛直分布は日本付近を 2 度ごと、それ以外を 6 度ごとに取る。
//   積乱雲は、気象庁のレーダーがある所はエコー × 雲頂、ない所（海外）は雲頂の高さとまわりからの盛り上がりで判断する。
import * as Cesium from 'cesium';
import { irRasterLike, fetchProfiles } from '../advisor/cbDetect.js';
import { topAltFt, PROFILE_LEVELS } from '../advisor/cbCore.js';
import { sprites, bbSize } from './animeSprites.js';

export const BOX = { w: 122.0, e: 148.0, s: 23.0, n: 47.0 };   // 北海道〜沖縄（気温分布の細かい範囲。ほかのモジュールも使う）
export const CT_BOX = { w: 78.75, e: 168.75, s: -21.9, n: 55.8 };   // 雲頂3D の範囲（アジア全域）
const RES = 0.2;                                       // 格子（度）
const NX = Math.round((CT_BOX.e - CT_BOX.w) / RES) + 1, NY = Math.round((CT_BOX.n - CT_BOX.s) / RES) + 1;
const PSTEP = 2, PSTEP_ASIA = 6;                       // 気温分布を取る間隔（度）：日本付近・アジア
const CELLS = n => Math.max(1, Math.round(n * 0.1 / RES));   // 0.1 度の格子のとき n マスだった距離 → 今の格子のマス数
const JP_IR = { w: 117, e: 157, s: 18, n: 50 };        // ひまわり日本域画像のある範囲（それ以外は全球画像）
const lon2px = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const lat2px = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 256 * 2 ** z;

// 雲頂の高さ（FL）→ 色（雲頂強調画像のように、高いほど目立つ色）
const STOPS = [
  [0, [190, 200, 210]], [100, [225, 230, 236]], [200, [255, 255, 255]], [300, [140, 210, 255]],
  [350, [90, 160, 255]], [400, [255, 235, 60]], [450, [255, 140, 0]], [500, [255, 40, 40]],
];
export const LEGEND = STOPS.map(([fl, c]) => ({ fl, css: `rgb(${c.join(',')})` }));
function colorAt(fl) {
  if (fl <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (fl <= STOPS[i][0]) {
      const [f0, c0] = STOPS[i - 1], [f1, c1] = STOPS[i], u = (fl - f0) / (f1 - f0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * u));
    }
  }
  return STOPS.at(-1)[1];
}

/**
 * 範囲 box の気温の鉛直分布を step 度ごとに取り、任意の地点の分布を4点から内挿する関数を返す
 *   profAt(lat, lon) → [{ p, t }]
 */
export async function profileField(box, step = PSTEP) {
  const plat = [], plon = [];
  for (let la = box.s; la <= box.n + 1e-6; la += step) plat.push(la);
  for (let lo = box.w; lo <= box.e + 1e-6; lo += step) plon.push(lo);
  const profs = await fetchProfiles(plat.flatMap(la => plon.map(lo => ({ lat: la, lon: lo }))));
  const T = profs.map(p => p.map(x => x.t));
  const f = (lat, lon) => {
    const fi = Math.min(plat.length - 1.001, Math.max(0, (lat - box.s) / step)), fj = Math.min(plon.length - 1.001, Math.max(0, (lon - box.w) / step));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = T[i * plon.length + j], b = T[i * plon.length + j + 1], c = T[(i + 1) * plon.length + j], d = T[(i + 1) * plon.length + j + 1];
    return PROFILE_LEVELS.map((p, k) => ({ p, t: [a, b, c, d].some(q => q?.[k] == null) ? null :
      a[k] * (1 - u) * (1 - v) + b[k] * (1 - u) * v + c[k] * u * (1 - v) + d[k] * u * v }));
  };
  f.fallback = profs.fallback || 0;                      // 標準大気で代用した地点の数
  return f;
}

/** 雲頂の高さの格子を作る（データ取得＋計算） */
/** 気温の鉛直分布：日本付近は細かく（2度ごと）、アジアは粗く（6度ごと）。Open-Meteo の利用回数を抑えるため */
async function asiaProfileField() {
  const [jp, asia] = await Promise.all([profileField(BOX), profileField(CT_BOX, PSTEP_ASIA)]);
  const f = (lat, lon) => (lat >= BOX.s && lat <= BOX.n && lon >= BOX.w && lon <= BOX.e ? jp(lat, lon) : asia(lat, lon));
  f.fallback = (jp.fallback || 0) + (asia.fallback || 0);
  return f;
}

export async function buildCloudTopGrid() {
  const z = 5;
  const tx0 = Math.floor(lon2px(CT_BOX.w, z) / 256), tx1 = Math.floor(lon2px(CT_BOX.e, z) / 256);
  const ty0 = Math.floor(lat2px(CT_BOX.n, z) / 256), ty1 = Math.floor(lat2px(CT_BOX.s, z) / 256);
  const r = { W: (tx1 - tx0 + 1) * 256, H: (ty1 - ty0 + 1) * 256, z, x0: tx0 * 256, y0: ty0 * 256 };
  const [ir, profAt] = await Promise.all([irRasterLike(r, null, { jpBox: JP_IR }), asiaProfileField()]);
  // 格子ごとの TBB（周囲 3×3 画素の平均）と雲頂の高さ
  const ft = new Float32Array(NX * NY).fill(NaN), tbbG = new Float32Array(NX * NY).fill(NaN);
  for (let jy = 0; jy < NY; jy++) {
    const lat = CT_BOX.n - (CT_BOX.n - CT_BOX.s) * jy / (NY - 1);
    const py = Math.round(lat2px(lat, z) - r.y0);
    for (let ix = 0; ix < NX; ix++) {
      const lon = CT_BOX.w + (CT_BOX.e - CT_BOX.w) * ix / (NX - 1);
      const px = Math.round(lon2px(lon, z) - r.x0);
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= r.W || y >= r.H) continue;
        const v = ir.tbb[y * r.W + x]; if (isFinite(v)) { s += v; n++; }
      }
      if (!n) continue;
      const tbb = s / n, k = jy * NX + ix;
      tbbG[k] = tbb;
      const h = topAltFt(profAt(lat, lon), tbb);
      ft[k] = h == null ? 0 : h;                      // 0 = 雲なし
    }
  }
  return { ft, tbb: tbbG, irTime: ir.time, profFallback: profAt.fallback };
}

/** 格子 → Cesium の面（Primitive） */
export function cloudTopPrimitive(grid, altScale = 1, { anime = false, mask = null } = {}) {
  const { ft } = grid;
  // なだらかにする（雲なしの所は 0 のまま、雲の縁だけ少し落とす）
  const h = Float32Array.from(ft, v => (isFinite(v) ? v : 0));
  if (anime) {
    // アニメ風（薄い層雲）：雲のない所も近くの雲の高さで埋め、縁が地面へ垂れ下がる「壁」を作らない
    for (let pass = 0; pass < 6; pass++) {
      const src = h.slice();
      for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
        const k = j * NX + i; if (src[k] > 0) continue;
        let s2 = 0, n = 0; for (const q of [k - 1, k + 1, k - NX, k + NX]) if (src[q] > 0) { s2 += src[q]; n++; }
        if (n) h[k] = s2 / n;
      }
    }
  }
  for (let pass = 0; pass < (anime ? 10 : 2); pass++) {   // アニメ風はなめらかに（高度100倍で壁にならないように）
    const src = h.slice();
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      let s = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += src[(j + dj) * NX + i + di];
      h[j * NX + i] = s / 9;
    }
  }
  // 色と透明度のテクスチャ（1格子 = 1画素）
  const cv = document.createElement('canvas'); cv.width = NX; cv.height = NY;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(NX, NY);
  const alpha = new Float32Array(NX * NY);
  for (let k = 0; k < NX * NY; k++) {
    const f = ft[k];
    if (!(f > 0) || mask?.has(k)) { img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = 255; continue; }
    const fl = f / 100;
    // アニメ風：エコーのない雲は薄い白の半透明。色分け：雲頂FLの色
    const c = anime ? [255, 255, 255] : colorAt(fl);        // アニメ風：エコーのない雲は薄い白
    img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2];
    alpha[k] = anime ? (fl >= 250 ? 0.3 : 0.38) : Math.min(0.92, 0.35 + fl / 450);   // 低い雲ほど薄く（色分け）
  }
  if (anime) for (let pass = 0; pass < 2; pass++) {       // 縁をふんわり
    const src = alpha.slice();
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      let s2 = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s2 += src[(j + dj) * NX + i + di];
      alpha[j * NX + i] = s2 / 9;
    }
  }
  for (let k = 0; k < NX * NY; k++) img.data[k * 4 + 3] = Math.round(255 * alpha[k]);
  ctx.putImageData(img, 0, 0);

  const pos = new Float64Array(NX * NY * 3), st = new Float32Array(NX * NY * 2);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    const lat = CT_BOX.n - (CT_BOX.n - CT_BOX.s) * j / (NY - 1), lon = CT_BOX.w + (CT_BOX.e - CT_BOX.w) * i / (NX - 1);
    const c = Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(300, h[k] * 0.3048) * altScale);
    pos[k * 3] = c.x; pos[k * 3 + 1] = c.y; pos[k * 3 + 2] = c.z;
    st[k * 2] = (i + 0.5) / NX; st[k * 2 + 1] = 1 - (j + 0.5) / NY;
  }
  const idx = new Uint32Array((NX - 1) * (NY - 1) * 6);
  let p = 0;
  for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
    const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: idx, primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  const material = new Cesium.Material({
    fabric: {
      uniforms: { image: cv.toDataURL('image/png') },
      source: anime ? `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb * 0.2; m.emission = c.rgb * 0.9; m.alpha = c.a;
        return m; }` : `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb; m.emission = c.rgb * 0.45; m.alpha = c.a;
        return m; }`,
    },
  });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({ material, flat: true, translucent: true, faceForward: true }),
    asynchronous: false,
  });
}

/**
 * 積乱雲として描くか（レーダーのエコー mm/h × ひまわり赤外から推定した雲頂 ft）
 *   弱い雨（にわか雨）や、雲頂の低い雲からの雨は積乱雲にしない。以前は 1mm/h 以上のエコーをすべて
 *   積乱雲（雲頂は最低 10000ft に底上げ）にしていたため、沖縄付近の低い雲のにわか雨まで積乱雲に見えていた
 *     ・5mm/h 以上 かつ 雲頂 25000ft（約 −35℃）以上
 *     ・20mm/h 以上 かつ 雲頂 18000ft 以上（発達中の雄大積雲〜積乱雲）
 *     ・雲頂が取れない所は 20mm/h 以上だけ
 */
export function isCb(mm, top) {
  if (!top) return mm >= 20;
  return (mm >= 5 && top >= 25000) || (mm >= 20 && top >= 18000);
}

/**
 * 格子 → アニメ風の雲
 *   ・強いエコー × 高い雲頂の所（isCb） … 積乱雲（入道雲）。雲底から推定雲頂まで1枚の大きな絵で、上はかなとこ雲
 *   ・エコーのない雲 … 薄い層雲。雲頂の高さに、横に長く透けた雲を大きく敷く
 *   ・FL300以上の積乱雲には雲頂FLの札
 * @param radar レーダーの解析格子（radarMotion の grid：mx=降水mm/h）。無ければ高さだけで判断
 */
export function cloudTopAnime(grid, altScale = 1, camPos = null, radar = null) {
  const SP = sprites();
  const out = new Cesium.PrimitiveCollection();
  const bb = out.add(new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
  const lb = out.add(new Cesium.LabelCollection());
  const ft = grid.ft, at = (i, j) => (i < 0 || j < 0 || i >= NX || j >= NY ? 0 : ft[j * NX + i] || 0);
  const dLon = (CT_BOX.e - CT_BOX.w) / (NX - 1), dLat = (CT_BOX.n - CT_BOX.s) / (NY - 1);
  const ll = (i, j) => ({ lat: CT_BOX.n - dLat * j, lon: CT_BOX.w + dLon * i });
  const maxTop = (i, j, r) => { let m = 0; for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) m = Math.max(m, at(i + di, j + dj)); return m; };
  // その範囲のレーダーの最大降水強度
  const rainMax = radar ? (lat, lon, half) => {
    const gx = l => (lon2px(l, radar.z) - radar.x0) / radar.B, gy = l => (lat2px(l, radar.z) - radar.y0) / radar.B;
    const x0 = Math.max(0, Math.floor(gx(lon - half))), x1 = Math.min(radar.W - 1, Math.ceil(gx(lon + half)));
    const y0 = Math.max(0, Math.floor(gy(lat + half))), y1 = Math.min(radar.H - 1, Math.ceil(gy(lat - half)));
    let m = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m = Math.max(m, radar.mx[y * radar.W + x]);
    return m;
  } : null;
  const jitter = (i, j) => { const h = ((i * 73856093) ^ (j * 19349663)) >>> 0; return { h, r1: (h % 1000) / 1000, r2: ((h >> 10) % 1000) / 1000 }; };
  const tint = (fl, a = 1) => fl >= 450 ? new Cesium.Color(1, 0.84, 0.86, a) : fl >= 350 ? new Cesium.Color(1, 0.92, 0.92, a)
    : fl >= 200 ? new Cesium.Color(1, 1, 1, a) : fl >= 100 ? new Cesium.Color(0.94, 0.97, 1, a) : new Cesium.Color(0.85, 0.9, 0.98, a);
  const queue = [], peaks = [];
  const cbCells = new Set();

  // 1) 積乱雲：0.7度ごと。エコーがあれば（無ければ、まわりより大きく盛り上がった高い雲頂）
  const SC = 9;
  for (let j = 2; j < NY - 2; j += SC) for (let i = 2; i < NX - 2; i += SC) {
    const { lat, lon } = ll(i, j);
    const mm = rainMax ? rainMax(lat, lon, dLon * SC * 0.6) : 0;
    let top = maxTop(i, j, 3);
    if (rainMax) { if (!isCb(mm, top)) continue; }
    else { let ring = 0; for (const [di, dj] of [[-6, 0], [6, 0], [0, -6], [0, 6]]) ring += at(i + di, j + dj); if (!(top >= 25000 && top - ring / 4 >= 8000)) continue; }
    if (!top) top = 25000;                              // 雲頂が取れない所（強いエコーのみ）は仮の高さ
    const { h, r1, r2 } = jitter(i, j);
    const cellM = dLon * SC * 111000 * Math.cos(lat * Math.PI / 180);
    const baseM = 2000 * 0.3048 * altScale, topM = top * 0.3048 * altScale, Hm = Math.max(topM - baseM, cellM * 0.8);
    const w = Math.max(cellM * 3.5, Hm * 2.0) * (0.9 + 0.3 * r1);     // 横に広がった積乱雲（高さの約2倍の幅）
    const pl = lat + (r1 - 0.5) * dLat * SC * 0.6, pn = lon + (r2 - 0.5) * dLon * SC * 0.6;
    queue.push({ pos: Cesium.Cartesian3.fromDegrees(pn, pl, baseM), w: w * 0.75, hgt: Hm, s: SP.cbWide[h % SP.cbWide.length], color: tint(top / 100), origin: Cesium.VerticalOrigin.BOTTOM });
    // 雲頂の少し下に、横へ大きく広がるかなとこ雲（積乱雲が横に広がって見えるように）
    const aw = Math.max(cellM * 4, w * 1.1), al = SP.layer[h % SP.layer.length];
    queue.push({ pos: Cesium.Cartesian3.fromDegrees(pn + 0.12, pl, topM - Math.max(aw * 0.12, 3000 * 0.3048 * altScale)), w: aw, hgt: Math.max(aw * 0.18, 4000 * 0.3048 * altScale), s: al, color: tint(top / 100), origin: Cesium.VerticalOrigin.BOTTOM });
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) if (di * di + dj * dj <= 9) cbCells.add((j + dj) * NX + i + di);   // 層雲の面に穴をあけて積乱雲を見せる
    if (top >= 30000) peaks.push({ lat: pl, lon: pn, top, mm });
  }
  // 2) 薄い層雲は、雲頂の高さの面（cloudTopPrimitive の anime）で描くので、ここでは置かない
  const SS = 8;
  for (let j = 3; j < NY - 3 && false; j += SS) for (let i = 3; i < NX - 3; i += SS) {
    if (cbCells.has(j * NX + i)) continue;
    const top = maxTop(i, j, 2); if (top <= 0) continue;
    const { lat, lon } = ll(i, j), { h, r1, r2 } = jitter(i, j);
    const cellM = dLon * SS * 111000 * Math.cos(lat * Math.PI / 180);
    const w = cellM * (8 + 3 * r1), s = SP.stratus[h % SP.stratus.length];
    const fl = top / 100;
    queue.push({ pos: Cesium.Cartesian3.fromDegrees(lon + (r2 - 0.5) * dLon * SS * 0.7, lat + (r1 - 0.5) * dLat * SS * 0.7, top * 0.3048 * altScale),
      w, hgt: w * s.cv.height / s.cv.width, s, color: tint(fl, fl >= 250 ? 0.85 : 0.95), origin: Cesium.VerticalOrigin.CENTER });
  }
  // 半透明の絵は奥から手前の順に描く（手前の縁が奥の雲を隠さないように）
  if (camPos) queue.sort((a, b) => Cesium.Cartesian3.distanceSquared(b.pos, camPos) - Cesium.Cartesian3.distanceSquared(a.pos, camPos));
  for (const q of queue) {
    const b = bb.add({ position: q.pos, ...bbSize(q.w, q.hgt), sizeInMeters: true, color: q.color, verticalOrigin: q.origin });
    b.setImage(q.s.id, q.s.cv);
  }
  // 高い積乱雲に雲頂FLの札（近いものはまとめる）
  peaks.sort((a, b) => b.top - a.top);
  const shown = [];
  for (const p of peaks) {
    if (shown.some(q => Math.hypot(q.lat - p.lat, (q.lon - p.lon) * Math.cos(p.lat * Math.PI / 180)) < 3)) continue;
    shown.push(p); if (shown.length > 6) break;
    lb.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.top * 0.3048 * altScale * 1.05 + 5000),
      text: `積乱雲 雲頂FL${Math.round(p.top / 1000) * 10}`, font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#3b5f8f'),
      showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(255,255,255,0.85)'),
      disableDepthTestDistance: Number.POSITIVE_INFINITY });
  }
  out._cbCells = cbCells;
  return out;
}

// ---- アニメ風の積乱雲（山と同じ作り方） ----
//   エコーの中で雲頂が一番高い所に大きな丸い「頭」のこぶ、エコーのある約10km四方ごとに低い「すそ」のこぶを立て、
//   その一番高い所をつないだ形にする。
//   はっきりした白で、陰は3段階（青みのある灰色）。雲底（約2,000ft）より下は透明にして、地面から浮かせる。
const CB_STEP = 0.03;                                   // 面の細かさ（度）≒ 3km
const cbRadiusKm = topFt => 60 + topFt / 300;           // 頭のこぶの半径（雲頂 FL400 で約190km。高度100倍でも細い針にならず、丸い入道雲に見える太さ）
export const CB_ALPHA = 0.6;                            // 積乱雲の濃さ（2026-10-17：0.97 → 0.6。後ろの雲・地図・経路が透けて見えるように）
export function cloudAnimeCb(grid, altScale = 1, radar = null, { alpha = CB_ALPHA } = {}) {
  const out = new Cesium.PrimitiveCollection();
  const ft = grid.ft, at = (i, j) => (i < 0 || j < 0 || i >= NX || j >= NY ? 0 : ft[j * NX + i] || 0);
  const dLon = (CT_BOX.e - CT_BOX.w) / (NX - 1), dLat = (CT_BOX.n - CT_BOX.s) / (NY - 1);
  // その範囲のレーダーの最大降水強度。レーダーの範囲（気象庁のレーダー＝日本付近）の外は null
  const rainMax = radar ? (lat, lon, half) => {
    const gx = l => (lon2px(l, radar.z) - radar.x0) / radar.B, gy = l => (lat2px(l, radar.z) - radar.y0) / radar.B;
    const cx = gx(lon), cy = gy(lat);
    if (cx < 0 || cy < 0 || cx >= radar.W || cy >= radar.H) return null;
    const x0 = Math.max(0, Math.floor(gx(lon - half))), x1 = Math.min(radar.W - 1, Math.ceil(gx(lon + half)));
    const y0 = Math.max(0, Math.floor(gy(lat + half))), y1 = Math.min(radar.H - 1, Math.ceil(gy(lat - half)));
    let m = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m = Math.max(m, radar.mx[y * radar.W + x]);
    return m;
  } : () => null;
  // 1) 積乱雲のマスと雲頂。レーダーのある所はエコー × 雲頂、ない所は雲頂の高さとまわりからの盛り上がり
  const R6 = CELLS(6);
  let cells = [];
  const cbCells = new Set();
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const c0 = at(i, j); if (c0 < 18000 && !radar) continue;   // 低い雲は積乱雲にしない（調べる数を減らす）
    const lat = CT_BOX.n - dLat * j, lon = CT_BOX.w + dLon * i;
    let top = Math.max(c0, at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1));
    const mm = rainMax(lat, lon, dLon * 0.6);
    if (mm != null) { if (!isCb(mm, top)) continue; }
    else { let ring = 0; for (const [di, dj] of [[-R6, 0], [R6, 0], [0, -R6], [0, R6]]) ring += at(i + di, j + dj); if (!(top >= 25000 && top - ring / 4 >= 8000)) continue; }
    if (!top) top = 25000;                              // 雲頂が取れない所（強いエコーのみ）は仮の高さ
    cells.push({ i, j, lat, lon, top, mm: mm || 0 });
  }
  // 熱帯で数が多すぎると重くなるので、雲頂の高い順に上限を設ける
  const MAX_CELLS = 2500;
  if (cells.length > MAX_CELLS) cells = cells.sort((a, b) => b.top - a.top).slice(0, MAX_CELLS);
  if (!cells.length) { out._cbCells = cbCells; return out; }
  // 塔（入道雲の頭）：近くの最高の雲頂を持つ所を、約0.5度以上離して選ぶ。まわりのエコーは低い「すそ」のこぶにする
  //   0.1度ごとにこぶを立てるとトゲトゲになるので、頭は少なく大きく、すそで塊をつなぐ
  const byKey0 = new Map(cells.map(c => [c.j * NX + c.i, c]));
  const R2 = CELLS(2);
  const nearTop = c => { let m = c.top; for (let dj = -R2; dj <= R2; dj++) for (let di = -R2; di <= R2; di++) { const q = byKey0.get((c.j + dj) * NX + c.i + di); if (q && q.top > m) m = q.top; } return m; };
  const heads = [];
  for (const c of [...cells].map(c => ({ ...c, top: nearTop(c) })).sort((a, b) => b.top - a.top)) {
    if (heads.some(h => Math.hypot(h.lat - c.lat, (h.lon - c.lon) * Math.cos(c.lat * Math.PI / 180)) < 0.8)) continue;
    heads.push({ ...c, R: cbRadiusKm(c.top) });
  }
  // 雷雲：レーダーエコーが赤（50mm/h以上）の所。近くに赤いエコーがある頭は、灰色の雷雲にする
  const RED = 50;
  const thunderCells = cells.filter(c => c.mm >= RED);
  for (const h of heads) h.thunder = thunderCells.some(c => Math.hypot(c.lat - h.lat, (c.lon - h.lon) * Math.cos(h.lat * Math.PI / 180)) < 0.35);
  // もくもく（カリフラワー）：頭のまわりの斜面と頂上に、小さなこぶを重ねてふくらませる（参考：夏の入道雲のイラスト）
  const lumps = [];
  const rnd = seed => { let x = Math.sin(seed) * 43758.5453; return x - Math.floor(x); };
  for (const [n, h] of heads.entries()) {
    const cos = Math.cos(h.lat * Math.PI / 180), km = 1 / 111;
    const put = (ang, frac, rFrac, lift) => {
      const d = h.R * frac, dome = h.top * (1 - frac * frac) ** 0.6;
      lumps.push({ lat: h.lat + Math.sin(ang) * d * km, lon: h.lon + Math.cos(ang) * d * km / cos,
        top: Math.min(h.top * 1.06, dome + h.top * lift), R: h.R * rFrac, p: 0.5, thunder: h.thunder });
    };
    for (let k = 0; k < 7; k++) put(k / 7 * 2 * Math.PI + rnd(n * 7 + k) * 0.6, 0.62 + 0.12 * rnd(n * 11 + k), 0.36 + 0.08 * rnd(n * 13 + k), 0.16);   // 肩のこぶ
    for (let k = 0; k < 5; k++) put(k / 5 * 2 * Math.PI + 0.5 + rnd(n * 17 + k), 0.38 + 0.1 * rnd(n * 19 + k), 0.3 + 0.06 * rnd(n * 23 + k), 0.12);    // 上のこぶ
    for (let k = 0; k < 3; k++) put(k / 3 * 2 * Math.PI + rnd(n * 29 + k) * 2, 0.12 + 0.1 * rnd(n * 31 + k), 0.3, 0.07);                              // 頂上のこぶ
  }
  const bumps = [...heads.map(h => ({ ...h, p: 0.6 })), ...lumps,
    ...cells.map(c => ({ lat: c.lat, lon: c.lon, top: c.top * 0.5, R: 26, p: 0.5, thunder: c.mm >= RED }))];
  // 近くのこぶだけを調べる：1度四方の面ごとに、その面にかかるこぶ（中心±半径）を先に選んでおく（アジア全域で軽くするため）
  for (const c of bumps) { c.Rlat = c.R / 111; c.R2 = c.R * c.R; }
  let envThunder = false;                                // 直前の env で一番高かったこぶが雷雲か
  let cand = bumps;
  const env = (lat, lon) => {                            // その地点の雲の高さ（ft）＝こぶの一番高い所
    const cos = Math.cos(lat * Math.PI / 180), kx = 111 * cos;
    let best = 0; envThunder = false;
    for (let n = 0; n < cand.length; n++) {
      const c = cand[n], dy = (c.lat - lat) * 111; if (dy >= c.R || dy <= -c.R) continue;
      const dx = (c.lon - lon) * kx, d2 = dx * dx + dy * dy; if (d2 >= c.R2) continue;
      const v = c.top * (1 - d2 / c.R2) ** c.p;          // 0.5〜0.6 乗：ふくらんだ丸いこぶ
      if (v > best) { best = v; envThunder = !!c.thunder; }
    }
    return best;
  };
  const candFor = (lo, la) => bumps.filter(c => {
    const rl = c.Rlat, ro = c.Rlat / Math.max(0.2, Math.cos(c.lat * Math.PI / 180));
    return c.lat + rl > la && c.lat - rl < la + 1 && c.lon + ro > lo && c.lon - ro < lo + 1;
  });
  const BASE = 2000;
  // 2) 1度四方ごとに面を作る
  const tiles = new Set();
  for (const c of cells) for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) tiles.add(`${Math.floor(c.lon) + a},${Math.floor(c.lat) + b}`);
  for (const t of tiles) {
    const [lo, la] = t.split(',').map(Number), N = Math.round(1 / CB_STEP) + 1;
    cand = candFor(lo, la); if (!cand.length) continue;
    const h = new Float32Array(N * N), th = new Uint8Array(N * N); let mx = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const v = env(la + 1 - j * CB_STEP, lo + i * CB_STEP); h[j * N + i] = v; th[j * N + i] = envThunder; if (v > mx) mx = v; }
    if (mx < BASE * 1.5) continue;
    { const src = h.slice(); for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) { let s2 = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s2 += src[(j + dj) * N + i + di]; h[j * N + i] = s2 / 9; } }
    // 陰（北西からの光、3段階）と色
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), cellFt = CB_STEP * 111000 / 0.3048;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, v = h[k];
      const hx = (h[j * N + Math.min(N - 1, i + 2)] - h[j * N + Math.max(0, i - 2)]) / (4 * cellFt);   // 2マス先との差（陰が縞にならないように）
      const hy = (h[Math.max(0, j - 2) * N + i] - h[Math.min(N - 1, j + 2) * N + i]) / (4 * cellFt);
      const nx = -hx * 25, ny = -hy * 25, nl = Math.hypot(nx, ny, 1);
      const lit = Math.max(0, (nx * -0.6 + ny * 0.6 + 0.53) / nl);
      const c = th[k] ? (lit > 0.72 ? [214, 216, 222] : lit > 0.42 ? [184, 188, 198] : [150, 156, 170])     // 雷雲：灰色
        : lit > 0.72 ? [255, 255, 255] : lit > 0.42 ? [234, 241, 252] : [200, 214, 238];                       // 入道雲：白、陰は空色がかる
      img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2];
      img.data[k * 4 + 3] = Math.round(255 * Math.min(alpha, Math.max(0, (v - BASE) / (BASE * 1.5))));
    }
    ctx.putImageData(img, 0, 0);
    const pos = new Float64Array(N * N * 3), st = new Float32Array(N * N * 2), idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, p = Cesium.Cartesian3.fromDegrees(lo + i * CB_STEP, la + 1 - j * CB_STEP, Math.max(BASE, h[k]) * 0.3048 * altScale);
      pos.set([p.x, p.y, p.z], k * 3); st.set([(i + 0.5) / N, 1 - (j + 0.5) / N], k * 2);
    }
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if (Math.max(h[a], h[b], h[c], h[d]) < BASE) continue;
      idx.push(a, c, b, b, c, d);
    }
    if (!idx.length) continue;
    const used = new Set(idx), sph = [];
    for (const k of used) sph.push(new Cesium.Cartesian3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]));
    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
        st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
      },
      indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromPoints(sph),
    });
    const material = new Cesium.Material({ fabric: { uniforms: { image: cv.toDataURL('image/png') },
      source: `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb * 0.2; m.emission = c.rgb * 0.9; m.alpha = c.a;
        return m; }` } });
    out.add(new Cesium.Primitive({ geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: new Cesium.MaterialAppearance({ material, flat: true, translucent: true, faceForward: true }), asynchronous: false }));
  }
  // 3) 層雲の面に穴をあける所（積乱雲の所）と、高い積乱雲の札
  for (const c of cells) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) cbCells.add((c.j + dj) * NX + c.i + di);
  const lb = out.add(new Cesium.LabelCollection()), shown = [];
  for (const c of [...cells].sort((a, b) => b.top - a.top)) {
    if (c.top < 30000 || shown.length > 6) break;
    if (shown.some(q => Math.hypot(q.lat - c.lat, (q.lon - c.lon) * Math.cos(c.lat * Math.PI / 180)) < 3)) continue;
    shown.push(c);
    lb.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.top * 0.3048 * altScale * 1.05 + 5000),
      text: `積乱雲 雲頂FL${Math.round(c.top / 1000) * 10}`, font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#3b5f8f'),
      showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(255,255,255,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY });
  }
  // 4) 雷：赤いエコー（50mm/h以上）の所に、雲底から地面へ黄色い稲妻と、青い雨の線（約0.25度ごと・最大40か所）
  const bolts = [], spots = [];
  for (const c of [...thunderCells].sort((a, b) => b.mm - a.mm)) {
    if (spots.length >= 40 || spots.some(q => Math.hypot(q.lat - c.lat, (q.lon - c.lon) * Math.cos(c.lat * Math.PI / 180)) < 0.25)) continue;
    spots.push(c);
  }
  if (spots.length) {
    const pc = out.add(new Cesium.PolylineCollection());
    const boltMat = () => Cesium.Material.fromType('PolylineOutline', { color: Cesium.Color.fromCssColorString('#ffeb2a'), outlineColor: Cesium.Color.fromCssColorString('#8a7a00'), outlineWidth: 2 });
    const rainMat = Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString('#2a72e0').withAlpha(0.9) });
    const topM = BASE * 3 * 0.3048 * altScale, M = 1 / 111000;          // 地面〜雲の下の方（6,000ft）
    for (const [n, c] of spots.entries()) {
      const cos = Math.cos(c.lat * Math.PI / 180), w = topM * 0.22;          // 稲妻の横ぶれ（高さに比例）
      for (let b = 0; b < 2; b++) {                                             // 1か所に稲妻2本
        const ox = (b ? 0.06 : -0.05), pts = [];
        const zig = [[0, 1], [0.35, 0.68], [-0.15, 0.6], [0.3, 0.3], [-0.1, 0.24], [0.2, 0]];   // 横（幅の割合）と高さ（割合）
        for (const [x, z] of zig) pts.push(Cesium.Cartesian3.fromDegrees(c.lon + ox / cos + x * w * (b ? -1 : 1) * M / cos, c.lat + (b ? -0.03 : 0.03), z * topM));
        bolts.push(pc.add({ positions: pts, width: 8, material: boltMat() }));
      }
      for (let r = 0; r < 6; r++) {                                             // 斜めの雨の線
        const dx = (rnd(n * 37 + r) - 0.5) * 0.24, dy = (rnd(n * 41 + r) - 0.5) * 0.18, len = topM * 0.7;
        const z0 = topM * (0.85 - 0.2 * rnd(n * 43 + r));
        pc.add({ positions: [Cesium.Cartesian3.fromDegrees(c.lon + dx / cos, c.lat + dy, z0),
          Cesium.Cartesian3.fromDegrees(c.lon + dx / cos - len * 0.45 * M / cos, c.lat + dy, z0 - len)], width: 3, material: rainMat });
      }
    }
  }
  // 遠くからも分かるように、稲妻のマーク（画面上で一定の大きさ）を雲の下に置く
  if (spots.length) {
    const ic = boltIcon(), bbc = out.add(new Cesium.BillboardCollection());
    for (const c of spots) bolts.push(bbc.add({ image: ic, position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, BASE * 1.5 * 0.3048 * altScale),
      width: 30, height: 40, verticalOrigin: Cesium.VerticalOrigin.CENTER, scaleByDistance: new Cesium.NearFarScalar(3e5, 1.6, 8e6, 0.7),
      disableDepthTestDistance: Number.POSITIVE_INFINITY }));
  }
  // 稲妻を光らせる（呼ぶたびに一部だけ消す）
  out._flash = t => { bolts.forEach((b, k) => { b.show = ((k * 7 + t) % 5) !== 0 && ((k + t) % 3) !== 1; }); };
  out._thunder = spots.length;
  out._cbCells = cbCells;
  return out;
}

/** 稲妻のマーク（黄色・こげ茶の縁。参考：雷雲のイラスト） */
let _boltIcon = null;
function boltIcon() {
  if (_boltIcon) return _boltIcon;
  const cv = document.createElement('canvas'); cv.width = 60; cv.height = 80;
  const g = cv.getContext('2d');
  g.beginPath(); g.moveTo(38, 2); g.lineTo(10, 46); g.lineTo(28, 44); g.lineTo(16, 78); g.lineTo(52, 30); g.lineTo(33, 32); g.lineTo(46, 2); g.closePath();
  g.fillStyle = '#ffeb2a'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#8a7a00'; g.lineJoin = 'round'; g.stroke();
  return (_boltIcon = cv);
}

/** アニメ風のときは、宇宙の黒い背景を青空にする（星・太陽・月を隠す）。複数の表示から使うので数える */
const skyUsers = new Set();
export function animeSky(viewer, want, who = 'cloud') {
  const sc = viewer.scene;
  if (want) skyUsers.add(who); else skyUsers.delete(who);
  const on = skyUsers.size > 0;
  if (on && !sc._awSky) sc._awSky = { bg: sc.backgroundColor.clone(), sky: sc.skyBox?.show, sun: sc.sun?.show, moon: sc.moon?.show };
  if (on) {
    sc.backgroundColor = Cesium.Color.fromCssColorString('#4f9fe6');
    if (sc.skyBox) sc.skyBox.show = false; if (sc.sun) sc.sun.show = false; if (sc.moon) sc.moon.show = false;
  } else if (sc._awSky) {
    sc.backgroundColor = sc._awSky.bg;
    if (sc.skyBox) sc.skyBox.show = sc._awSky.sky ?? true; if (sc.sun) sc.sun.show = sc._awSky.sun ?? true; if (sc.moon) sc.moon.show = sc._awSky.moon ?? true;
    sc._awSky = null;
  }
}

/** 表示の管理：on/off・高度倍率の変更・10分ごとの更新 */
export function createCloudTop3D(viewer, { onStatus, getRadar } = {}) {
  let prim = null, grid = null, radar = null, on = false, timer = null, style = 'anime', cbAlpha = CB_ALPHA, scale = () => (window.awGetAltScale?.() ?? 1);
  let flashTimer = null;
  const draw = () => {
    clearInterval(flashTimer); flashTimer = null;
    if (prim) { viewer.scene.primitives.remove(prim); prim = null; }
    animeSky(viewer, on && style === 'anime');
    if (on && grid) {
      if (style === 'anime') {                             // 薄い層雲の面 ＋ エコーの所の積乱雲
        const cb = cloudAnimeCb(grid, scale(), radar, { alpha: cbAlpha });
        const pc = new Cesium.PrimitiveCollection();
        pc.add(cloudTopPrimitive(grid, scale(), { anime: true, mask: cb._cbCells }));
        pc.add(cb);
        prim = viewer.scene.primitives.add(pc);
        if (cb._thunder) { let t = 0; flashTimer = setInterval(() => { cb._flash(++t); viewer.scene.requestRender?.(); }, 450); }
      } else prim = viewer.scene.primitives.add(cloudTopPrimitive(grid, scale()));
    }
    viewer.scene.requestRender?.();
  };
  async function refresh() {
    onStatus?.('雲頂の高さを計算しています…');
    try {
      grid = await buildCloudTopGrid();
      try { radar = (await getRadar?.())?.grid || null; } catch { radar = null; }   // エコーの場所（積乱雲にする所）
      draw();
      const n = grid.ft.filter(v => v > 0).length, hi = grid.ft.filter(v => v >= 30000).length;
      onStatus?.(`ひまわり赤外 ${grid.irTime.slice(8, 10)}:${grid.irTime.slice(10, 12)}Z の雲頂温度から推定。雲域の${n ? Math.round(hi / n * 100) : 0}%が FL300 より上。` +
        (grid.profFallback ? '（気象モデルの気温分布を取得できなかったため、標準大気で代用。高さの誤差が大きくなります）' : '') +
        (style === 'anime' && !radar ? '（レーダーの解析待ち：積乱雲の場所は雲頂の高さから判断）' : ''));
    } catch (e) { onStatus?.(`雲頂3Dを作れませんでした（${e.message}）`); console.warn('[cloud top 3D]', e); }
  }
  // 視点を動かし終えたら、奥から手前の順に並べ直す（アニメ風のときだけ）
  // （アニメ風は面で描くので、視点を動かしても並べ直しは不要）
  // main.js で高度倍率が変わったら作り直す
  window.addEventListener('aw:altscale', () => { if (on) draw(); });
  return {
    get on() { return on; },
    get style() { return style; },
    setStyle(v) { style = v; if (on) draw(); },
    /** 積乱雲の濃さ（エコーと同時に見るときは半透明にして、中の色の柱を見せる） */
    setCbAlpha(a) { if (a === cbAlpha) return; cbAlpha = a; if (on) draw(); },
    async show() { on = true; if (!grid) await refresh(); else { try { radar = (await getRadar?.())?.grid || radar; } catch { /* そのまま */ } draw(); } clearInterval(timer); timer = setInterval(refresh, 10 * 60 * 1000); },
    hide() { on = false; clearInterval(timer); draw(); onStatus?.(''); },
    refresh,
  };
}
