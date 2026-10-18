// 衛星画像（ひまわり）の雲の動きと雲の種類の自動解析
//   ・動き：最新・約30分前・約60分前の赤外画像（ズーム4・約9km/画素）を比べ、雲域ごとの移動と発達を求める
//     （計算はレーダーと同じ radarMotionCore.js。雨の強さの代わりに「雲頂の冷たさ」を使う）
//   ・雲域：① 雲頂が −25℃以下の中・上層の雲域、② 雲頂の低い下層雲の広がり、を別々に探す
//   ・種類：雲頂温度（赤外）・雲頂の凸凹（温度のばらつき）・広さ、昼は可視画像の明るさ（雲の厚さ）から判別する
//       積乱雲（Cb）を含む対流雲／厚い層状雲（乱層雲・高層雲。前線や低気圧の雲域）／上層雲（巻雲・巻層雲）／
//       中層雲（高積雲・高層雲）／下層雲（積雲・層積雲）／層雲・霧の可能性
//     夜は可視画像がないため、巻雲と厚い雲の区別、霧の判別は不確か（赤外だけでの推定）
//   ・赤外の明るさ → 温度：明るさ 0 ≒ +40℃、255 ≒ −80℃（cloudOnly.js・satLift3D.js と同じ）
import * as Cesium from 'cesium';
import { coarsen, analyzeCells, lon2px, lat2px, px2lon, px2lat, dirName } from './radarMotionCore.js';
import { placeName } from './chartGuide.js';
import { intlPlaceName, INTL_SITES } from './intlRadar.js';
import { clearSkyLo } from './cloudOnly.js';
import { cloudTopM } from './satLift3D.js';

const Z = 4, BOX = { w: 100, e: 150, s: 5, n: 50 }, B = 2;
const T = b => 40.5 - b * 120 / 255;                 // 明るさ → 雲頂温度（℃）
const loadImg = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ng; im.src = src; });
const jmaDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
const where = (lat, lon) => (lat >= 24 && lon >= 122 ? placeName(lat, lon) : intlPlaceName(lat, lon));
const fl = t => { const m = cloudTopM(Math.max(0, Math.min(255, (40.5 - t) * 255 / 120))); return Math.round(m / 0.3048 / 1000) * 10; };
const flText = f => (f < 50 ? 'FL050以下' : `FL${String(f).padStart(3, '0')}`);

/** タイルを貼り合わせて明るさ（0〜255）のラスタにする */
async function raster(tiles) {
  const tx0 = Math.floor(lon2px(BOX.w, Z) / 256), tx1 = Math.floor(lon2px(BOX.e, Z) / 256);
  const ty0 = Math.floor(lat2px(BOX.n, Z) / 256), ty1 = Math.floor(lat2px(BOX.s, Z) / 256);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let ok = 0;
  await Promise.all(Array.from({ length: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) }, async (_, k) => {
    const x = tx0 + (k % (tx1 - tx0 + 1)), y = ty0 + Math.floor(k / (tx1 - tx0 + 1));
    try { ctx.drawImage(await loadImg(tiles.replace('{z}', Z).replace('{x}', x).replace('{y}', y)), (x - tx0) * 256, (y - ty0) * 256); ok++; } catch { /* 欠けは飛ばす */ }
  }));
  if (!ok) throw new Error('衛星画像を取得できません');
  const px = ctx.getImageData(0, 0, W, H).data, b = new Uint8Array(W * H);
  for (let n = 0; n < W * H; n++) b[n] = Math.max(px[n * 4], px[n * 4 + 1], px[n * 4 + 2]);
  return { W, H, b, px, x0: tx0 * 256, y0: ty0 * 256 };
}
/** 雲の強さ（動きの追跡用）。high … 雲頂 −25℃以下の中・上層雲、low … 晴れた所より冷たく、−10℃より暖かい下層雲 */
function field(r, kind, lo, vis = null) {
  const rain = new Float32Array(r.W * r.H);
  for (let n = 0; n < r.W * r.H; n++) {
    const v = r.b[n];
    if (kind === 'high') rain[n] = v >= 138 ? 3 + (v - 138) / 8 : 0;                 // 138 ≒ −25℃
    else {
      // 下層雲：−10℃（107）より暖かく、晴れた所より冷たい。最新の図では、昼の可視画像で明るい（雲がある）所に限る
      //   （夜の陸は冷えて下層雲と見分けにくいため、下層雲の解析は昼だけ）
      const L = lo(n % r.W, (n / r.W) | 0);
      rain[n] = v < 107 && (vis ? v >= L + 4 && vis.b[n] >= 70 : v >= L + 8) ? 5 : 0;
    }
  }
  return { W: r.W, H: r.H, rain, z: Z, x0: r.x0, y0: r.y0 };
}
/** 雲域のマス（coarsen 後）→ 元の画素の統計 */
function stats(r, vis, idx, cW) {
  let n = 0, s = 0, s2 = 0, tmin = 99, cold = 0, vn = 0, vs = 0, vs2 = 0;
  for (const k of idx) {
    const cx = k % cW, cy = (k / cW) | 0;
    for (let dy = 0; dy < B; dy++) for (let dx = 0; dx < B; dx++) {
      const q = (cy * B + dy) * r.W + cx * B + dx, t = T(r.b[q]);
      n++; s += t; s2 += t * t; if (t < tmin) tmin = t; if (t <= -50) cold++;
      if (vis) { const a = vis.b[q]; vn++; vs += a; vs2 += a * a; }
    }
  }
  const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  const vm = vn ? vs / vn : 0, vsd = vn ? Math.sqrt(Math.max(0, vs2 / vn - vm * vm)) : 0;
  return { tmin, mean, sd, coldFrac: cold / n, vis: vn && vm > 12 ? { mean: vm, sd: vsd } : null };   // 可視の平均が暗すぎる＝夜
}
/** 雲の種類の判別 */
function classify(st, areaKm2, kind) {
  const day = !!st.vis, v = st.vis;
  if (kind === 'low') {
    if (day && v.mean >= 110 && v.sd < 18 && st.sd < 2.5) return { key: 'st', name: '層雲・霧の可能性（なめらかで明るい下層雲）', air: '雲底が低く視程が悪い可能性。到着空港の METAR・TAF で雲底・視程を確認する。' };
    return { key: 'cu', name: '下層雲（積雲・層積雲）', air: '雲底は低め。雲の中では弱い揺れ。冬の日本海側などでは発達した積雲から雪・着氷に注意。' };
  }
  if (st.tmin <= -55 && st.coldFrac > 0.03 && (st.sd >= 7 || areaKm2 < 40000) && (!day || v.mean >= 140)) {
    return { key: 'cb', name: '積乱雲（Cb）を含む対流雲', air: '雷・強い乱気流・着氷・ひょう。雲頂より上・20NM以上離して回避する。' };
  }
  if (day && st.mean <= -30 && v.mean < 95) return { key: 'ci', name: '上層雲（巻雲・巻層雲。薄い氷の雲）', air: '雲そのものの揺れは小さいことが多い。ジェット気流に沿う帯状の巻雲は、近くで晴天乱気流（CAT）に注意。' };
  if (st.mean <= -30 && st.sd < 7 && areaKm2 >= 50000) {
    return { key: 'ns', name: day ? '厚い層状雲（乱層雲・高層雲。前線・低気圧の雲域）' : '上層まで達する層状の雲域（乱層雲・高層雲、または厚い巻雲）', air: '雲中は計器気象状態。0℃〜−20℃の層で着氷、降水。上空に巻雲が広がる所はジェット気流に近く CAT の可能性。' };
  }
  if (st.mean <= -30) return { key: 'ci', name: day ? '上層雲（巻雲・巻層雲）' : '上層雲（巻雲など。夜は厚い雲との区別が不確か）', air: '雲そのものの揺れは小さいことが多い。帯状の巻雲はジェット気流の目印で、CAT に注意。' };
  return { key: 'ac', name: '中層雲（高積雲・高層雲）', air: '着氷（並程度）の可能性。雲の中では弱い揺れ。' };
}

/**
 * @param irFrames satFrames('B13/TBB') の結果（古い順）
 * @param airports 国内の空港（{ iata, nameJa, lat, lon }）
 */
export async function analyzeSatMotion(irFrames, airports = []) {
  const latest = irFrames.at(-1), t0 = jmaDate(latest.time);
  const pick = min => irFrames.reduce((a, f) => (Math.abs((t0 - jmaDate(f.time)) / 60000 - min) < Math.abs((t0 - jmaDate(a.time)) / 60000 - min) ? f : a));
  const use = [latest, pick(30), pick(60)].filter((f, i, arr) => arr.indexOf(f) === i);
  const [rs, vis] = await Promise.all([Promise.all(use.map(f => raster(f.tiles))), raster(latest.tiles.replace('B13/TBB', 'B03/ALBD')).catch(() => null)]);
  const lo = clearSkyLo(rs[0].px, rs[0].W, rs[0].H, 75, 64);   // 約500km ごとの晴れた所（夜の陸は海より冷えるので細かく）
  const apts = [...airports.filter(a => isFinite(a.lat)), ...INTL_SITES.map(s => ({ iata: s.iata, nameJa: s.name, lat: s.lat, lon: s.lon }))];
  const out = [];
  const isDay = !!vis && (() => { let n = 0, k = 0; for (let q = 0; q < vis.b.length; q += 97) { n++; if (vis.b[q] > 12) k++; } return k > n * 0.15; })();
  for (const kind of isDay ? ['high', 'low'] : ['high']) {
    const fr = use.map((f, i) => ({ time: jmaDate(f.time), c: coarsen(field(rs[i], kind, lo, i === 0 && kind === 'low' ? vis : null), B) }));
    const cells = analyzeCells(fr, apts, { maxKmh: kind === 'high' ? 160 : 90, cellOpts: { thr: 3, minCells: kind === 'high' ? 12 : 40, maxCount: kind === 'high' ? 6 : 3 } });
    for (const c of cells) {
      const st = stats(rs[0], vis, c.idx, fr[0].c.W);
      out.push({ ...c, kind, st, type: classify(st, c.areaKm2, kind), topFl: fl(st.tmin) });
    }
  }
  const circ = '①②③④⑤⑥⑦⑧⑨';
  const cells = out.map((c, i) => ({ ...c, no: circ[i] || '・' }));
  const lines = !cells.length ? ['動きを追えるまとまった雲域はない（晴れ間が広い）。'] : cells.map(c => {
    const area = c.areaKm2 >= 10000 ? `約${Math.round(c.areaKm2 / 10000)}万km²` : `約${Math.round(c.areaKm2 / 100) * 100}km²`;
    let s = `${c.no} ${where(c.lat, c.lon)}の雲域（${area}）：<b>${c.type.name}</b>。`;
    s += c.kind === 'high' ? `雲頂は最も高い所で約${flText(c.topFl)}（${Math.round(c.st.tmin)}℃）。` : `雲頂は約${flText(fl(c.st.mean)).replace('以下', '')}以下。`;
    const m = c.motion;
    if (!m) s += '動きは推定できませんでした。';
    else if (m.speed < 8) s += 'ほぼ停滞。';
    else s += `${dirName(m.dir)}へ時速約${Math.round(m.speed / 5) * 5}km（${Math.round(m.speed / 1.852)}kt）で移動${m.conf === 'low' ? '（形の変化が大きく、推定は不確か）' : ''}。`;
    if (c.kind === 'high') s += c.trend === 'grow' ? '1時間前より広がり・発達。' : c.trend === 'decay' ? '1時間前より衰弱・縮小。' : '';
    if (m && m.speed >= 8 && where(c.at1.lat, c.at1.lon) !== where(c.lat, c.lon)) s += `このまま進むと1時間後は${where(c.at1.lat, c.at1.lon)}。`;
    if (c.apts?.length) s += c.apts.map(p => (p.now ? `${p.a.iata} ${p.a.nameJa.replace(/（.*?）|国際空港|空港/g, '')}は雲域内` : p.h === 0 ? `${p.a.iata}は雲域の縁` : `${p.a.iata} ${p.a.nameJa.replace(/（.*?）|国際空港|空港/g, '')}に約${p.h < 1 ? Math.round(p.h * 60) + '分' : p.h.toFixed(1).replace('.0', '') + '時間'}後にかかる`)).join('、') + '。';
    return s + `<span style="color:#9fb3c8">（${c.type.air}）</span>`;
  });
  return { time: t0, day: isDay, cells, lines, lags: use.slice(1).map(f => Math.round((t0 - jmaDate(f.time)) / 60000)) };
}

export const satMotionShort = res => !res.cells.length ? '雲の動き：まとまった雲域なし'
  : '雲の動き：' + res.cells.slice(0, 3).map(c => `${c.no}${c.type.name.replace(/（.*$/, '')} ${!c.motion ? '不明' : c.motion.speed < 8 ? '停滞' : `${dirName(c.motion.dir)}へ${Math.round(c.motion.speed / 5) * 5}km/h`}`).join('・') + '（詳しくは図をクリック）';

// 地図の矢印（矢印の先＝このまま進んだときの2時間後の位置）。積乱雲は赤、層状・上層の雲域は水色、下層雲は灰
let ds = null, shown = false;
const COL = { cb: '#ff5252', ns: '#4fc3f7', ci: '#b3e5fc', ac: '#80deea', cu: '#cfd8dc', st: '#cfd8dc' };
export function drawSatMotion(viewer, res) {
  if (!ds) {
    ds = new Cesium.CustomDataSource('satMotion');
    viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds && shown) setTimeout(() => viewer.dataSources.add(ds), 0); });
  }
  shown = true;
  if (!viewer.dataSources.contains(ds)) viewer.dataSources.add(ds);
  ds.entities.removeAll();
  if (!res) return;
  for (const c of res.cells) {
    const m = c.motion, col = Cesium.Color.fromCssColorString(COL[c.type.key] || '#fff');
    if (m && m.speed >= 8) ds.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray([c.lon, c.lat, c.at2.lon, c.at2.lat]), width: 14, clampToGround: true,
      material: new Cesium.PolylineArrowMaterialProperty(col.withAlpha(0.9)) } });
    ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat), label: {
      text: `${c.no} ${c.type.name.replace(/（.*$/, '')}${m ? (m.speed < 8 ? ' 停滞' : ` ${dirName(m.dir)} ${Math.round(m.speed / 5) * 5}km/h`) : ''}`,
      font: '600 12px "Meiryo", sans-serif', fillColor: col.brighten(0.3, new Cesium.Color()), showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), pixelOffset: new Cesium.Cartesian2(0, -18),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
}
export function clearSatMotion(viewer) { shown = false; if (ds) { ds.entities.removeAll(); if (viewer.dataSources.contains(ds)) viewer.dataSources.remove(ds, false); } }
