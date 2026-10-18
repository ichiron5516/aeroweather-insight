// 衛星画像（ひまわり）を雲頂の高さに持ち上げて表示する（3D 表示のとき）
//   地図に貼った衛星画像は地表に描かれるため、高度を強調した 3D では、立体の雲（悪天予想図の 3D・国際悪天の 3D）や
//   経路の高さと位置が合わない（斜めから見ると、高い所の雲と地表の画像が横にずれて見える）。
//   そこで 3D（高度倍率 > 1）のときは、同じ時刻の赤外画像（B13 雲頂温度）から雲頂の高さを推定し、
//   その高さの面に衛星画像（可視・赤外）を貼る。高さは画面の高度倍率に合わせる。
//     ・雲頂温度：赤外タイルの明るさから（明るさ 75 ≒ +5℃、170 ≒ −40℃、255 ≒ −80℃）
//     ・高さ：標準大気（地上 15℃、6.5℃/km、−56.5℃ で 11km）。それより冷たい雲頂は熱帯の圏界面（−80℃ ≒ 16.5km）まで直線で
//     ・範囲：アジア全域（2026-10-17 から）。ズーム 5 のタイル 横8×縦8 枚＝東経 78.75〜168.75 度・北緯 55.8〜南緯 21.9 度
//       （インド東部・中国・モンゴル南部・朝鮮半島・日本・東南アジア・インドネシア・フィリピン・グアム・マーシャル諸島まで）。
//       視点を動かしても作り直さない（以前は画面の中心のまわり 5×5 枚だけで、視点が大きく動いたら作り直していた）
import * as Cesium from 'cesium';
import { toCloudCanvas, CLOUD_ONLY, clearSkyLo } from './cloudOnly.js';

const Z = 5, TILE = 256, CELL = 40;                   // 格子はタイル1枚あたり 40 マス（以前と同じ細かさ）
export const ASIA_TILES = { x0: 23, y0: 10, nx: 8, ny: 8 };   // ズーム5 のタイル番号の範囲（アジア全域）
const GX = ASIA_TILES.nx * CELL, GY = ASIA_TILES.ny * CELL;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const loadImg = src => new Promise(ok => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });

/** 明るさ（0〜255）→ 雲頂の高さ（m） */
export function cloudTopM(b) {
  const T = b <= 170 ? 5 - (b - 75) * 45 / 95 : -40 - (b - 170) * 40 / 85;
  if (T >= 15) return 0;
  if (T >= -56.5) return (15 - T) / 6.5 * 1000;
  return Math.min(17000, 11000 + (-56.5 - T) / 23.5 * 5500);
}

async function compose(tmpl, { x0, y0, nx, ny }) {
  const cv = document.createElement('canvas'); cv.width = TILE * nx; cv.height = TILE * ny;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  await Promise.all(Array.from({ length: nx * ny }, async (_, k) => {
    const i = k % nx, j = Math.floor(k / nx), tx = ((x0 + i) % 2 ** Z + 2 ** Z) % 2 ** Z, ty = y0 + j;
    if (ty < 0 || ty >= 2 ** Z) return;
    const im = await loadImg(tmpl.replace('{z}', Z).replace('{x}', tx).replace('{y}', ty));
    if (im) ctx.drawImage(im, i * TILE, j * TILE);
  }));
  return cv;
}

/** 赤外の画像 → 格子ごとの雲頂の高さ（m）
 *  雲のない所は、近くの雲の高さをそのまま延ばす（透明なので見えない）。
 *  雲のない所を地表の高さにすると、雲の縁から地表まで斜めの「壁」ができ、低い雲まで柱のような
 *  積乱雲に見えてしまうため */
function heights(irCv) {
  const W = irCv.width, H = irCv.height, ir = irCv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const lo = clearSkyLo(ir, W, H, CLOUD_ONLY.ir.lo);    // 雲として見せ始める明るさ（cloudOnly.js と同じ）
  const nx = GX + 1, ny = GY + 1, h = new Float32Array(nx * ny).fill(NaN);
  const R = Math.ceil(W / GX / 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // 格子の周りで一番明るい（＝冷たい・高い）所を雲頂にする
    const cx = Math.min(W - 1, Math.round(i / GX * (W - 1))), cy = Math.min(H - 1, Math.round(j / GY * (H - 1)));
    let m = 0;
    for (let dy = -R; dy <= R; dy += R) for (let dx = -R; dx <= R; dx += R) {
      const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(H - 1, Math.max(0, cy + dy)), k = (y * W + x) * 4;
      m = Math.max(m, ir[k], ir[k + 1], ir[k + 2]);
    }
    if (m >= lo(cx, cy)) h[j * nx + i] = cloudTopM(m);
  }
  // 雲のない格子に、いちばん近い雲の高さを入れる（幅優先で外へ広げる）
  let front = [];
  for (let k = 0; k < h.length; k++) if (!isNaN(h[k])) front.push(k);
  if (!front.length) return h.fill(300);
  while (front.length) {
    const next = [];
    for (const k of front) {
      const i = k % nx, j = (k / nx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = b * nx + a; if (isNaN(h[q])) { h[q] = h[k]; next.push(q); }
      }
    }
    front = next;
  }
  // なめらかに（半径約 30km の平均を3回＝ガウスぼかしに近い）。高度を誇張すると、雲頂の小さな凸凹が
  //   山のように尖って見え、低い雲まで積乱雲のように見えるため、雲の面としてなだらかにする
  const RAD = 4, tmp = new Float32Array(h.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0, n = 0; for (let d = -RAD; d <= RAD; d++) { const q = i + d; if (q >= 0 && q < nx) { a += h[j * nx + q]; n++; } }
      tmp[j * nx + i] = a / n;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0, n = 0; for (let d = -RAD; d <= RAD; d++) { const q = j + d; if (q >= 0 && q < ny) { a += tmp[q * nx + i]; n++; } }
      h[j * nx + i] = a / n;
    }
  }
  return h;
}

function buildPrimitive(texCv, h, { x0, y0, nx: tnx, ny: tny }, scale) {
  const nx = GX + 1, ny = GY + 1;
  const pos = new Float64Array(nx * ny * 3), st = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const lon = tile2lon(x0 + i / GX * tnx, Z), lat = tile2lat(y0 + j / GY * tny, Z);
    const c = Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(300, h[j * nx + i]) * scale);
    const k = j * nx + i;
    pos[k * 3] = c.x; pos[k * 3 + 1] = c.y; pos[k * 3 + 2] = c.z;
    st[k * 2] = i / GX; st[k * 2 + 1] = 1 - j / GY;
  }
  const idx = new Uint32Array(GX * GY * 6); let p = 0;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: idx, primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  const material = new Cesium.Material({ fabric: { uniforms: { image: texCv, vis: 0 }, source: `czm_material czm_getMaterial(czm_materialInput mi) {
      czm_material m = czm_getDefaultMaterial(mi); vec4 c = texture(image, mi.st);
      m.diffuse = c.rgb * 0.3; m.emission = c.rgb * 0.6; m.alpha = c.a * 0.92 * vis; return m; }` } });
  // 絵（テクスチャ）が GPU に送られるまでの最初のコマは、Cesium が代わりに真っ白な絵を使うため、
  //   準備ができるまでは透明にしておく（vis を 1 にすると見える。show=false だと絵の読み込み自体が進まない）
  return new Cesium.Primitive({ geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({ material, flat: true, translucent: true, faceForward: true }), asynchronous: false });
}

/**
 * @returns { show(frame, band), hide(), get shown }
 *   frame … radarAnim の時刻（{ time, tiles }）、band … 'vis' | 'ir'
 */
export function createSatLift(viewer) {
  const cache = new Map();                      // key → { tex（雲だけの絵）, h（雲頂の高さ）, prim, sc }
  const MAX = 8;                                // 範囲が広い（以前の約2.2倍）ので、とっておくコマを少し減らす
  let cur = null, want = null, gen = 0, pending = null;
  const region = ASIA_TILES;
  const scale = () => window.awGetAltScale?.() ?? 1;
  // 見せないコマは描画もしない（show=false）。読み込み待ちのコマは描くが透明（vis=0）
  const setVis = (p, v) => { if (p) { p.appearance.material.uniforms.vis = v ? 1 : 0; p.show = !!v; } };
  const texReady = p => { const t = p?.appearance?.material?._textures?.image; return p && t && t !== viewer.scene.context.defaultTexture; };
  // 新しいコマの絵が使えるようになってから入れ替える（それまでは前のコマを出したまま＝白く光らない）
  viewer.scene.postRender.addEventListener(() => {
    if (!pending) return;
    if (!texReady(pending)) { viewer.scene.requestRender?.(); return; }
    if (cur && cur !== pending) setVis(cur, false);
    cur = pending; setVis(cur, true); pending = null;
  });
  function dropPrim(c) { if (c?.prim) { if (cur === c.prim) cur = null; if (pending === c.prim) pending = null; viewer.scene.primitives.remove(c.prim); c.prim = null; } }
  function remove() { setVis(cur, false); setVis(pending, false); cur = null; pending = null; }
  async function draw() {
    const my = ++gen;
    if (!want) { remove(); return; }
    const { frame, band } = want, sc = scale();
    const key = `${band}|${frame.time}`;
    let c = cache.get(key);
    if (!c) {
      const irTiles = frame.tiles.replace(/B03\/ALBD/, 'B13/TBB');
      const [tex0, ir] = await Promise.all([compose(frame.tiles, region), band === 'ir' ? null : compose(irTiles, region)]);
      if (my !== gen) return;
      // 貼る絵は「雲だけ」（雲のない所は透明）
      c = { tex: toCloudCanvas(tex0, CLOUD_ONLY[band] || CLOUD_ONLY.ir), h: heights(ir || tex0), prim: null, sc: 0 };
      cache.set(key, c);
      while (cache.size > MAX) { const k = cache.keys().next().value; dropPrim(cache.get(k)); cache.delete(k); }
    }
    if (!c.prim || c.sc !== sc) {
      dropPrim(c);
      c.prim = viewer.scene.primitives.add(buildPrimitive(c.tex, c.h, region, sc)); c.sc = sc;
    }
    if (my !== gen) { if (c.prim !== cur && c.prim !== pending) setVis(c.prim, false); return; }
    if (texReady(c.prim)) { if (cur && cur !== c.prim) setVis(cur, false); cur = c.prim; setVis(cur, true); pending = null; }
    else { if (pending && pending !== c.prim) setVis(pending, false); pending = c.prim; pending.show = true; }   // 絵の準備ができたら postRender で表示
    viewer.scene.requestRender?.();
  }
  window.addEventListener('aw:altscale', () => { if (want) draw(); });
  return {
    get shown() { return !!want; },
    // 同じコマ・同じ種類なら作り直さない（作っている途中で呼ばれると、そのたびに最初からやり直して、いつまでも出なかった）
    show(frame, band) { if (!frame) return; if (want && want.frame.time === frame.time && want.band === band) return; want = { frame, band }; draw(); },
    hide() { want = null; gen++; remove(); },
  };
}
