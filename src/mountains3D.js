// 高い山（標高 2,000m 以上。日本・台湾・朝鮮半島・中国・東南アジア、2026-10-18 から衛星画像（ひまわり全球画像）の範囲全体＝
//   ヒマラヤ・チベット・中央アジア・シベリア・カムチャツカ・ニューギニア・オーストラリア・ニュージーランド・ハワイなど）を、高度の誇張（100倍）に合わせて立体表示する
//   地形そのものは実寸のまま。誇張表示のときだけ、高い山の部分を「高さ × 倍率」の面として重ねる。
//   これで経路の高度（同じ倍率）と山の高さを、同じ縮尺で見比べられる。
//   ・標高は Cesium World Terrain から約1km間隔で読む（初回のみ。数秒かかる）
//   ・アニメ風：約10km四方ごとの最高点を丸い「こぶ」にしてつないだ、なだらかな山（山頂の高さはそのまま）。
//     色は段々（緑・黄緑・茶・雪）、陰は3段階。ふもとは透明に消える
import * as Cesium from 'cesium';
import { inSatDisk, wrapLon } from './satDisk.js';

const SHOW_M = 2000;          // はっきり見せる標高
const FADE_M = 1000;          // ここから下は透明（山すそ）
const STEP = 0.01;            // 格子の間隔（度）≒ 1km
const LEVEL = 9;              // 地形を読む細かさ（タイルの段）

// 2,000m 以上の山がある範囲（日本アルプス・日光／尾瀬、東北、北海道、台湾）
const REGIONS = [
  { name: '中部山岳・日光', w: 135.9, e: 139.6, s: 34.9, n: 37.1 },
  { name: '飯豊山', w: 139.55, e: 139.85, s: 37.75, n: 37.95 },
  { name: '鳥海山', w: 139.9, e: 140.2, s: 39.0, n: 39.2 },
  { name: '岩手山', w: 140.85, e: 141.15, s: 39.75, n: 39.95 },
  { name: '大雪山・日高', w: 142.3, e: 143.3, s: 42.6, n: 43.8 },
  { name: '台湾', w: 120.3, e: 122.0, s: 22.0, n: 25.3 },
];
// 主な山（ラベル用）
const PEAKS = [
  ['富士山', 35.3606, 138.7274, 3776], ['北岳', 35.6741, 138.2385, 3193], ['奥穂高岳', 36.2893, 137.6482, 3190],
  ['槍ヶ岳', 36.3420, 137.6476, 3180], ['赤石岳', 35.4612, 138.1576, 3121], ['御嶽山', 35.8928, 137.4803, 3067],
  ['乗鞍岳', 36.1063, 137.5537, 3026], ['立山', 36.5757, 137.6197, 3015], ['木曽駒ヶ岳', 35.7894, 137.8044, 2956],
  ['赤岳（八ヶ岳）', 35.9709, 138.3701, 2899], ['白山', 36.1550, 136.7714, 2702], ['浅間山', 36.4062, 138.5232, 2568],
  ['日光白根山', 36.7986, 139.3758, 2578], ['燧ヶ岳', 36.9553, 139.2850, 2356], ['飯豊山', 37.8547, 139.7072, 2105],
  ['鳥海山', 39.0992, 140.0489, 2236], ['岩手山', 39.8525, 141.0011, 2038],
  ['旭岳（大雪山）', 43.6636, 142.8541, 2291], ['十勝岳', 43.4181, 142.6864, 2077], ['幌尻岳', 42.7194, 142.6828, 2052],
  ['白頭山（長白山）', 41.9936, 128.0767, 2744], ['冠帽峰', 41.7060, 129.3770, 2541], ['小五台山', 39.9675, 114.9817, 2882],
  ['霧霊山', 40.5833, 117.4833, 2118], ['武夷山（黄岡山）', 27.8975, 117.7806, 2158],
  ['玉山', 23.4700, 120.9573, 3952], ['雪山', 24.3833, 121.2317, 3886], ['南湖大山', 24.3611, 121.4386, 3742],
  ['貢嘎山（ミニヤコンカ）', 29.5950, 101.8794, 7556], ['玉龍雪山', 27.1000, 100.1800, 5596], ['峨眉山', 29.5200, 103.3300, 3099],
  ['太白山', 33.9600, 107.7700, 3771], ['ファンシーパン', 22.3033, 103.7750, 3147], ['ドイ・インタノン', 18.5886, 98.4867, 2565],
  ['プービア', 18.9800, 103.1500, 2819], ['ゴックリン', 15.0700, 107.9800, 2598], ['タハン山', 4.6340, 102.2340, 2187],
  ['キナバル山', 6.0750, 116.5583, 4095], ['アポ山', 6.9875, 125.2706, 2954], ['プラグ山', 16.5833, 120.8833, 2928],
  ['クリンチ山', -1.6970, 101.2640, 3805],
  // 衛星画像の範囲に広げた所（2026-10-18）
  ['エベレスト', 27.9881, 86.9250, 8849], ['カンチェンジュンガ', 27.7025, 88.1475, 8586], ['ナンダ・デヴィ', 30.3760, 79.9710, 7816],
  ['ナムチャバルワ', 29.6311, 95.0556, 7782], ['チョモラーリ', 27.8270, 89.2690, 7326], ['ベルーハ山', 49.8070, 86.5900, 4506],
  ['ホイテン峰', 49.1500, 87.8167, 4374], ['クリュチェフスカヤ山', 56.0560, 160.6420, 4750], ['ジャヤ峰', -4.0833, 137.1833, 4884],
  ['ウィルヘルム山', -5.7800, 145.0300, 4509], ['スメル山', -8.1080, 112.9220, 3676], ['リンジャニ山', -8.4110, 116.4570, 3726],
  ['コジオスコ山', -36.4560, 148.2630, 2228], ['アオラキ（マウント・クック）', -43.5950, 170.1420, 3724],
  ['マウナケア', 19.8207, -155.4681, 4207], ['ルアペフ山', -39.2810, 175.5680, 2797],
];

let cache = null;             // 地域ごとの標高格子
// 地形（Cesium World Terrain）は起動後しばらくしてから使えるようになるので、最大20秒待つ
async function terrainReady(viewer) {
  for (let k = 0; k < 40; k++) {
    const tp = viewer.terrainProvider;
    if (tp && !(tp instanceof Cesium.EllipsoidTerrainProvider)) return tp;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('地形データ（Cesium World Terrain）を読み込めません。.env の VITE_ION_TOKEN を確認してください');
}
let heightsP = null;
function loadHeights(viewer) {
  if (cache) return Promise.resolve(cache);
  heightsP ||= (async () => {
    const tp = await terrainReady(viewer);
    const out = [];
    for (const R of REGIONS) {
      const NX = Math.round((R.e - R.w) / STEP) + 1, NY = Math.round((R.n - R.s) / STEP) + 1;
      const carts = [];
      for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++)
        carts.push(Cesium.Cartographic.fromDegrees(R.w + i * STEP, R.n - j * STEP));
      await Cesium.sampleTerrain(tp, LEVEL, carts);
      out.push({ R, NX, NY, step: STEP, h: Float32Array.from(carts, c => c.height || 0) });
    }
    return (cache = out);
  })().catch(e => { heightsP = null; throw e; });   // 失敗したら次に押したとき読み直す
  return heightsP;
}

// 日本・台湾以外：2,000m 以上の山がある所を自動で探す（粗く読んでから、高い所だけ細かく読む）
//   1. 朝鮮半島・中国東部（細かく：約2km）
//   2. 中国（東経97度より東）・インドシナ半島・マレー半島・フィリピン・ボルネオ島・スマトラ島（範囲が広いので約4km）
//   3. 衛星画像の範囲（円）の残り全部（2026-10-18 追加。さらに広いので、粗い読み取りは約20km・細かい読み取りは約5km）
const AREAS = [
  { name: '朝鮮半島・中国東部', w: 114.5, e: 131.5, s: 24, n: 46, fine: { step: 0.02, level: 9 }, pick: 1500, keep: SHOW_M },
  { name: '中国・東南アジア', w: 97, e: 131.5, s: -6, n: 46, fine: { step: 0.04, level: 8 }, pick: 1200, keep: 1800 },   // 粗く読むと山頂が低く出るので基準を下げる（マレー半島の 2,100m 級も拾う）
  { name: '衛星画像の範囲', w: 59, e: 222, s: -82, n: 82, disk: true, scan: { step: 0.2, level: 5 }, fine: { step: 0.05, level: 7 }, pick: 1000, keep: 1800, out: 0.05 },
];
const SCAN = { step: 0.1, level: 6 };     // 粗い読み取り（約10km）
const inBox = (B, lo, la) => lo > B.w && lo < B.e && la > B.s && la < B.n;
const foreign = [];
async function loadForeign(viewer, k) {
  if (foreign[k]) return foreign[k];
  const A = AREAS[k], prev = AREAS.slice(0, k), SC = A.scan || SCAN;
  const tp = await terrainReady(viewer);
  const NX = Math.round((A.e - A.w) / SC.step) + 1, NY = Math.round((A.n - A.s) / SC.step) + 1;
  const carts = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const lo = A.w + i * SC.step, la = A.n - j * SC.step;
    if (A.disk && !inSatDisk(la, lo)) continue;
    if (!prev.some(B => inBox(B, lo, la))) carts.push(Cesium.Cartographic.fromDegrees(wrapLon(lo), la));
  }
  for (let i = 0; i < carts.length; i += 40000) await Cesium.sampleTerrain(tp, SC.level, carts.slice(i, i + 40000));
  // 1度四方ごとの最高点。粗い読み取りは山頂が低めに出るので 1,500m 以上を候補にする
  const tiles = new Map();
  carts.forEach(c => {
    if ((c.height || 0) < A.pick) return;
    const lo = Math.floor(Cesium.Math.toDegrees(c.longitude)), la = Math.floor(Cesium.Math.toDegrees(c.latitude));
    if (REGIONS.some(R => inBox(R, lo + 0.5, la + 0.5)) || prev.some(B => inBox(B, lo + 0.5, la + 0.5) || inBox(B, lo + 360.5, la + 0.5))) return;   // 他で読む所と重複
    tiles.set(`${lo},${la}`, [lo, la]);
  });
  const out = [], list = [...tiles.values()], F = A.fine;
  for (let i = 0; i < list.length; i += 4) {                 // 4枚ずつ読む
    const part = await Promise.all(list.slice(i, i + 4).map(async ([lo, la]) => {
      const R = { name: `${lo}E${la}N`, w: lo, e: lo + 1, s: la, n: la + 1 };
      const nx = Math.round(1 / F.step) + 1, cs = [];
      for (let j = 0; j < nx; j++) for (let q = 0; q < nx; q++) cs.push(Cesium.Cartographic.fromDegrees(R.w + q * F.step, R.n - j * F.step));
      await Cesium.sampleTerrain(tp, F.level, cs);
      const h = Float32Array.from(cs, c => c.height || 0);
      return h.some(v => v >= A.keep) ? { R, NX: nx, NY: nx, step: F.step, h, out: A.out } : null;
    }));
    out.push(...part.filter(Boolean));
  }
  return (foreign[k] = out);
}

/** 標高 → 色（RGB）と不透明度 */
function colorOf(h) {
  const a = Math.min(1, Math.max(0, (h - FADE_M) / (SHOW_M - FADE_M)));
  let c;
  if (h >= 3000) c = [246, 248, 252];                                  // 雪
  else if (h >= 2500) { const f = (h - 2500) / 500; c = [150 + 96 * f, 138 + 110 * f, 126 + 126 * f]; }   // 岩 → 雪
  else if (h >= SHOW_M) { const f = (h - SHOW_M) / 500; c = [110 + 40 * f, 118 + 20 * f, 92 + 34 * f]; } // 森林限界付近 → 岩
  else c = [96, 118, 82];                                              // 山すそ（緑灰）
  return { c, a: a * a * 0.95 };
}

// ---- アニメ風の山 ----
//   地形をそのまま100倍にすると、細かい起伏が針の山のようになる。
//   約10km四方ごとの最高点を「山のこぶ」（なめらかな丸い山）にして、その一番高い所をつないだ形にする。
//   山頂の高さはそのまま（経路の高度と比べられる）、形はアニメ風のなだらかな山。色も段々に塗り分ける。
const CELL = 0.1;                                     // こぶの元にするマス（度）
const OUT_STEP = 0.02;                                // 表示する面の細かさ（度）≒ 2km
const D2R = Math.PI / 180;
const radiusKm = H => 22 + H / 120;                   // こぶの半径（富士山で約53km）
const ckey = (ci, cj) => (ci + 4000) * 8000 + (cj + 4000);   // マスの番号（数値にして速く引く）
function coarseCells(grids) {
  const m = new Map();
  m.coarseTiles = new Set();                          // 粗く作る1度四方（範囲を広げた所。山の面を約5km の細かさで作る）
  for (const { R, NX, NY, h, step, out } of grids) {
    if (out) m.coarseTiles.add(`${R.w},${R.s}`);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const v = h[j * NX + i]; if (v < FADE_M) continue;
      const lon = R.w + i * step, lat = R.n - j * step;
      const ci = Math.floor(lon / CELL), cj = Math.floor(lat / CELL), key = ckey(ci, cj), c = m.get(key);
      if (!c || v > c.h) m.set(key, { h: v, lat, lon, ci, cj });
    }
  }
  return m;
}
function envelopeAt(cells, lat, lon) {
  const ci = Math.floor(lon / CELL), cj = Math.floor(lat / CELL), cos = Math.cos(lat * D2R);
  let best = 0;
  for (let dj = -6; dj <= 6; dj++) for (let di = -8; di <= 8; di++) {
    const c = cells.get(ckey(ci + di, cj + dj)); if (!c) continue;
    const d = Math.hypot((c.lat - lat) * 111, (c.lon - lon) * 111 * cos), R = radiusKm(c.h);
    if (d >= R) continue;
    const t = 1 - (d / R) ** 2, v = c.h * t * t;
    if (v > best) best = v;
  }
  return best;
}
/** こぶを重ねた山の面を、1度四方ごとの格子で作る（山のある1度四方と、その周り） */
//   形は倍率によらないので、一度作ったら使い回す。範囲が広いので少しずつ作って画面を止めない
const animeCache = new Map();
async function animeGridsCached(grids) {
  const key = grids.length;
  if (!animeCache.has(key)) animeCache.set(key, animeGrids(coarseCells(grids)));
  return animeCache.get(key);
}
async function animeGrids(cells) {
  const tiles = new Set();
  for (const { ci, cj } of cells.values()) {
    const lo = Math.floor(ci * CELL + 1e-9), la = Math.floor(cj * CELL + 1e-9);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) tiles.add(`${lo + a},${la + b}`);
  }
  // 1度四方ごとに面を作ると、範囲を広げたときに数千個になって描画が重くなる（2026-10-18）。
  // そこで、いくつかの1度四方をまとめた「ブロック」ごとに1つの面にする：
  //   日本〜東南アジア（細かく、約2km）… 2度四方のブロック、範囲を広げた所（粗く、約5km）… 5度四方のブロック
  const isCoarse = (lo, la) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (cells.coarseTiles?.has(`${lo + a},${la + b}`)) return true;
    return false;
  };
  const blocks = new Map();
  for (const t of tiles) {
    const [lo, la] = t.split(',').map(Number), c = isCoarse(lo, la), B = c ? 5 : 2;
    const k = `${c ? 'c' : 'f'}${Math.floor(lo / B)},${Math.floor(la / B)}`;
    if (!blocks.has(k)) blocks.set(k, { c, B, bx: Math.floor(lo / B) * B, by: Math.floor(la / B) * B, mem: new Set() });
    blocks.get(k).mem.add(t);
  }
  const out = [];
  let n = 0;
  for (const { c, B, bx, by, mem } of blocks.values()) {
    if (++n % 2 === 0) await new Promise(r => setTimeout(r, 0));
    const os = c ? 0.05 : OUT_STEP, R = { w: bx, e: bx + B, s: by, n: by + B }, N = Math.round(B / os) + 1;
    const h = new Float32Array(N * N);
    let mx = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const lat = R.n - j * os, lon = R.w + i * os;
      // このブロックの1度四方（境目の点は、隣り合うどれかが入っていれば）だけ計算する
      const f0 = Math.floor(lon - 1e-6), f1 = Math.floor(lon + 1e-6), g0 = Math.floor(lat - 1e-6), g1 = Math.floor(lat + 1e-6);
      if (!mem.has(`${f0},${g0}`) && !mem.has(`${f1},${g0}`) && !mem.has(`${f0},${g1}`) && !mem.has(`${f1},${g1}`)) continue;
      const v = envelopeAt(cells, lat, lon); h[j * N + i] = v; if (v > mx) mx = v;
    }
    if (mx >= 300) out.push({ R, NX: N, NY: N, step: os, h, anime: true });
  }
  return out;
}
/** アニメ風の色（段々の塗り分け）と、ふもとの透明度 */
function animeColor(h) {
  const c = h >= 2600 ? [246, 249, 253] : h >= 1900 ? [178, 152, 112] : h >= 1100 ? [140, 186, 96] : [92, 158, 84];
  return { c, a: Math.min(1, Math.max(0, (h - 150) / 750)) };
}

/** 1地域ぶんの面（高さ × 倍率）を作る */
function regionPrimitive({ R, NX, NY, h, step = STEP, anime = false }, scale) {
  // 陰影（北西からの光）。アニメ風は明るさを3段階に分ける（セル調）
  const cv = document.createElement('canvas'); cv.width = NX; cv.height = NY;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(NX, NY);
  const cellM = step * 111000;
  const minH = anime ? 150 : FADE_M;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i, { c, a } = anime ? animeColor(h[k]) : colorOf(h[k]);
    const hx = (h[j * NX + Math.min(NX - 1, i + 1)] - h[j * NX + Math.max(0, i - 1)]) / (2 * cellM);
    const hy = (h[Math.max(0, j - 1) * NX + i] - h[Math.min(NY - 1, j + 1) * NX + i]) / (2 * cellM);
    const ex = anime ? 25 : 4;                                              // 誇張した形に合わせて斜面を強めに
    const nx = -hx * ex, ny = -hy * ex, nz = 1, nl = Math.hypot(nx, ny, nz);
    const lit = Math.max(0, (nx * -0.6 + ny * 0.6 + nz * 0.53) / nl);       // 光は北西・やや上から
    const sh = anime ? (lit > 0.72 ? 1.05 : lit > 0.42 ? 0.86 : 0.66) : 0.45 + 0.75 * lit;
    img.data[k * 4] = Math.min(255, c[0] * sh); img.data[k * 4 + 1] = Math.min(255, c[1] * sh); img.data[k * 4 + 2] = Math.min(255, c[2] * sh);
    img.data[k * 4 + 3] = Math.round(255 * a);
  }
  ctx.putImageData(img, 0, 0);

  // 山すそより高い所だけ三角形を作る
  const pos = new Float64Array(NX * NY * 3), st = new Float32Array(NX * NY * 2);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    const p = Cesium.Cartesian3.fromDegrees(R.w + i * step, R.n - j * step, Math.max(0, h[k]) * scale);
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    st[k * 2] = (i + 0.5) / NX; st[k * 2 + 1] = 1 - (j + 0.5) / NY;
  }
  const idx = [];
  for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
    const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
    if (Math.max(h[a], h[b], h[c], h[d]) < minH) continue;
    idx.push(a, c, b, b, c, d);
  }
  if (!idx.length) return null;
  const used = new Set(idx), sph = [];
  for (const k of used) sph.push(new Cesium.Cartesian3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]));
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromPoints(sph),
  });
  const material = new Cesium.Material({
    fabric: {
      uniforms: { image: cv.toDataURL('image/png') },
      source: `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb * ${anime ? '0.25' : '1.0'}; m.emission = c.rgb * ${anime ? '0.85' : '0.55'}; m.alpha = c.a;
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
 * 表示の管理。高度の倍率が 1 より大きいときだけ表示する（実寸のときは地形そのものが見える）
 *   getScale: 今の高度倍率を返す関数
 */
export function createMountains3D(viewer, { getScale }) {
  const group = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  let labels = null, busy = null, shownFor = 1, enabled = true, loading = false, error = null;
  const notify = () => window.dispatchEvent(new Event('aw:mountains'));
  async function update() {
    const scale = enabled ? getScale() : 1;
    if (scale === shownFor) return;
    group.removeAll(); labels = null; shownFor = scale;
    if (scale <= 1) return;
    try {
      error = null;
      if (!cache) { loading = true; notify(); }
      const grids = await loadHeights(viewer).finally(() => { loading = false; notify(); });
      if ((enabled ? getScale() : 1) !== scale) return;   // 待っている間に倍率が変わった
      const meshes = group.add(new Cesium.PrimitiveCollection());
      const drawMeshes = async gs => {
        const ag = await animeGridsCached(gs);
        if (shownFor !== scale || meshes.isDestroyed()) return;
        meshes.removeAll(); for (const g of ag) { const p = regionPrimitive(g, scale); if (p) meshes.add(p); }
      };
      await drawMeshes(grids);
      labels = group.add(new Cesium.LabelCollection());
      for (const [name, lat, lon, m] of PEAKS) {
        labels.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, m * scale + 2500), text: `${name} ${m.toLocaleString()}m`,
          font: '600 12px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#3b2f1e'),
          showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(255,248,230,0.88)'),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.2e6) });
      }
      // 海外の山は後から、近い所から順に（初回は読み取りに時間がかかる）
      (async () => {
        let all = grids;
        for (let k = 0; k < AREAS.length; k++) {
          const fs = await loadForeign(viewer, k);
          if (shownFor !== scale || meshes.isDestroyed()) return;
          all = [...all, ...fs];
          await drawMeshes(all);                       // 境目でこぶが切れないよう、全部まとめて作り直す
        }
      })().catch(e => console.warn('[mountains3D] foreign', e));
    } catch (e) { console.warn('[mountains3D]', e); shownFor = 1; error = e.message; notify(); }
  }
  const run = () => { busy = (busy || Promise.resolve()).then(update); return busy; };
  window.addEventListener('aw:altscale', run);
  run();
  return {
    update: run,
    get enabled() { return enabled; },
    get loading() { return loading; },
    get error() { return error; },
    setEnabled(v) { enabled = v; return run(); },
  };
}
