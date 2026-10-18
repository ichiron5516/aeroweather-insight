// レーダーエコーの動きの解析（画像の取得と地図への矢印表示）
//   計算そのものは radarMotionCore.js
import * as Cesium from 'cesium';
import { rainFromRGB } from '../advisor/wxSources.js';
import { coarsen, analyzeCells, motionText, lon2px, lat2px, dirName } from './radarMotionCore.js';
import { placeName } from './chartGuide.js';
import { analyzeCloudTops } from '../advisor/cbDetect.js';
import { cellTopTbb } from '../advisor/cbCore.js';

const Z = 6;                                        // 約2km/画素
const BOX = { w: 122.5, e: 147.0, s: 23.5, n: 46.0 };
const loadImg = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ng; im.src = src; });
const jmaDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));

/** タイルを貼り合わせて降水強度（mm/h）のラスタにする */
async function raster(tiles) {
  const tx0 = Math.floor(lon2px(BOX.w, Z) / 256), tx1 = Math.floor(lon2px(BOX.e, Z) / 256);
  const ty0 = Math.floor(lat2px(BOX.n, Z) / 256), ty1 = Math.floor(lat2px(BOX.s, Z) / 256);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let ok = 0;
  const jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
    const u = tiles.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
    jobs.push(loadImg(u).then(im => { ctx.drawImage(im, (x - tx0) * 256, (y - ty0) * 256); ok++; }).catch(() => null));
  }
  await Promise.all(jobs);
  if (!ok) throw new Error('レーダー画像を取得できません');
  const px = ctx.getImageData(0, 0, W, H).data, rain = new Float32Array(W * H);
  for (let n = 0; n < W * H; n++) if (px[n * 4 + 3] >= 40) rain[n] = rainFromRGB(px[n * 4], px[n * 4 + 1], px[n * 4 + 2], px[n * 4 + 3]);
  return { W, H, rain, z: Z, x0: tx0 * 256, y0: ty0 * 256 };
}

/**
 * 最新・30分前・60分前のレーダーから、雨域ごとの移動と発達を解析
 * @param frames radarFrames() の結果（古い順）
 */
export async function analyzeRadarMotion(frames, airports = []) {
  const latest = frames.at(-1), t0 = jmaDate(latest.time);
  const pick = min => frames.reduce((a, f) => (Math.abs((t0 - jmaDate(f.time)) / 60000 - min) < Math.abs((t0 - jmaDate(a.time)) / 60000 - min) ? f : a));
  const use = [latest, pick(30), pick(60)].filter((f, i, arr) => arr.indexOf(f) === i);
  const rs = await Promise.all(use.map(f => raster(f.tiles)));
  const fr = use.map((f, i) => ({ time: jmaDate(f.time), c: coarsen(rs[i], 4) }));
  const cells = analyzeCells(fr, airports.filter(a => isFinite(a.lat)));
  // 雲頂高度（ひまわり赤外）と発達した積乱雲（強いエコー × 冷たい雲頂）
  let cbs = [], irTime = null, cbError = null, grid = null;
  try {
    const ct = await analyzeCloudTops(rs[0], g => cells.map(c => ({ lat: c.lat, lon: c.lon, tbb: cellTopTbb(g, c.idx) })));
    cbs = ct.cbs; irTime = ct.irTime; grid = ct.grid;
    cells.forEach((c, i) => {
      c.tbb = ct.extra[i]?.tbb; c.top = ct.extra[i]?.top;
      const set = new Set(c.idx);
      c.cbs = cbs.filter(b => b.idx.some(k => set.has(k)));
    });
  } catch (e) { cbError = e.message; console.warn('[radar] cloud top', e); }
  return {
    time: t0, cells, cbs, irTime, cbError, grid,
    lines: motionText(cells, placeName, { time: t0 }),
    lags: fr.slice(1).map(f => Math.round((t0 - f.time) / 60000)),
  };
}

// ---------------- 地図の矢印 ----------------
let ds = null, shown = false;
const CIRC = '①②③④⑤⑥⑦⑧';
export function drawMotion(viewer, res) {
  if (!ds) {
    ds = new Cesium.CustomDataSource('radarMotion');
    // main.js の再読込（dataSources.removeAll）で消えたら付け直す
    viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds && shown) setTimeout(() => viewer.dataSources.add(ds), 0); });
  }
  shown = true;
  if (!viewer.dataSources.contains(ds)) viewer.dataSources.add(ds);
  ds.entities.removeAll();
  if (!res) return;
  res.cells.forEach((c, i) => {
    const m = c.motion;
    const lbl = `${CIRC[i] || ''} ${!m ? '' : m.speed < 8 ? '停滞' : `${dirName(m.dir)} ${Math.round(m.speed / 5) * 5}km/h`}${c.trend === 'grow' ? '・発達' : c.trend === 'decay' ? '・衰弱' : ''}` +
      (c.top && c.top.note !== 'low' ? `・頂FL${String(c.top.fl).padStart(3, '0')}` : '');
    if (m && m.speed >= 8) {                          // 矢印の先 = このまま進んだときの2時間後の位置
      ds.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([c.lon, c.lat, c.at2.lon, c.at2.lat]), width: 16, clampToGround: true,
        material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.fromCssColorString(c.trend === 'grow' ? '#ff7043' : '#ffee58').withAlpha(0.95)) } });
    }
    ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat), label: {
      text: lbl.trim(), font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE, showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), pixelOffset: new Cesium.Cartesian2(0, 20),   // 矢印と重ならないよう雨域の中心の下に
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  });
  drawCbs(viewer, res);
}
// 発達した積乱雲：雲頂の高さまでの円柱（高さは実寸。地図の高度倍率とは別）
export function drawCbs(viewer, res, { altScale = 1 } = {}) {
  if (!ds || !res?.cbs) return;
  for (const b of res.cbs) {
    if (!b.top) continue;
    const topM = b.top.fl * 100 * 0.3048 * altScale;
    const col = Cesium.Color.fromCssColorString(b.sev === 'SEV' ? '#ff1744' : '#ff9100');
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, topM / 2),
      cylinder: { length: topM, topRadius: b.radiusKm * 1000, bottomRadius: b.radiusKm * 1000, material: col.withAlpha(0.25), outline: true, outlineColor: col },
    });
    ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, topM), label: {
      text: `${b.sev === 'SEV' ? '非常に発達した' : '発達した'}積乱雲 頂FL${String(b.top.fl).padStart(3, '0')}${b.top.note === 'over' ? '+' : ''}`,
      font: '600 12px "Meiryo", sans-serif', fillColor: col.brighten(0.4, new Cesium.Color()), showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
}
export function clearMotion(viewer) { shown = false; if (ds) { ds.entities.removeAll(); if (viewer.dataSources.contains(ds)) viewer.dataSources.remove(ds, false); } }
