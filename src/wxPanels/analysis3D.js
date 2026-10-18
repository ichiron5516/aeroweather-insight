// 解析3D（2026-10-17）：数値予報（気象庁 GSM の解析時刻の値。Open-Meteo 経由）から、天気図で読む構造を立体で表す
//   ・ジェット気流     … 300〜200hPa で風が一番強い高さ。60kt 以上の帯（60kt ごく薄い赤、100kt 赤、強いほど濃い赤）と、
//                        中心の軸（管のような太い矢印。区間ごとに風速の赤。先に円錐の矢じり。札：最大風速と FL）
//   ・下層ジェット     … 850hPa（約 FL050）の 30kt 以上の帯と、40kt 以上の軸（矢印）
//   ・前線帯           … 紫の面。850hPa の気温の差が大きい所（0.9℃/100km 以上）の軸から、700・500・400・300hPa の軸を北（寒気側）へたどり、
//                        地上付近（約 1,000ft）まで延ばして、傾いた 1 枚の面にする
//   ・湿域             … 緑。850・700hPa の湿数（T−Td）3℃以下（AUPQ78 の網かけと同じ基準）。6℃以下は薄い緑
//   ・圏界面           … 気温の下がり方が 2℃/km 以下になる最初の高さ（WMO の定義の目安）。うねる面
//   ・寒気             … 500・850hPa の −6℃ 以下を青のグラデーション（低いほど濃い青）。線は 500hPa −30℃（大雪の目安）・
//                        −36℃（大雪のおそれ大）・−6℃（夏の雷の目安）、850hPa −6℃（平地で雪の目安）
//   ・圏界面は黄色の面、500hPa の谷は茶色の破線、峰は黄土色の線（2026-10-18）
//   ・500hPa の谷・峰  … 500hPa 高度の東西の偏差から谷（赤の破線）・峰（黄）の軸。等高線（60m ごと、5880m は太平洋高気圧の目安）も
//   データ：2026-10-18 から京都大学 RISH の気象庁 GSM（src/gpvSource/）。RISH のときは全地点を 1 回で読み、待たない（数秒）。
//     読めないときは Open-Meteo（以下）
//   データ：衛星画像の範囲を 2.5度ごと（RISH。約 3,300地点・22要素）。Open-Meteo のときは東経95〜165度・北緯0〜60度を 2.5度ごと（725地点・22要素）。Open-Meteo の回数は1回の読み込みで約1,600回。
//     1分600回の上限を超えないように間を空けて読む（全部で約3分）。読んだデータは GSM の新しい初期値が出るまで
//     ブラウザ（IndexedDB）に保存して使い回す。高さは画面の高度倍率に合わせる
import * as Cesium from 'cesium';
import { gpvSource } from '../gpvSource/omShim.js';
import { rishBase } from '../gpvSource/rishGsm.js';
import { inSatDisk } from '../satDisk.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const META = 'https://api.open-meteo.com/data/jma_gsm/static/meta.json';
// 範囲（2026-10-18 午後）：衛星画像（ひまわり）の範囲＝東経140.7度を中心に半径81度の円（satDisk.js）を囲む四角を 2.5度ごと。
//   円の外の格子は読まない・描かない。経度は 180度を超えて東へ続ける（西経は 360 足す）。それまでは東経95〜165度・北緯0〜60度
export const A = { w: 60, e: 222.5, s: -80, n: 80, d: 2.5 };
const OLD = { w: 95, e: 165, s: 0, n: 60 };   // Open-Meteo で読むときは回数の上限があるので、もとの範囲だけ
const NX = Math.round((A.e - A.w) / A.d) + 1, NY = Math.round((A.n - A.s) / A.d) + 1, N = NX * NY;
const T_LV = [850, 700, 500, 400, 300, 250, 200, 150, 100];
const W_LV = [850, 700, 300, 250, 200];
const TD_LV = [850, 700];
const FT = 0.3048;
/** 気圧（hPa）→ 標準大気の高さ（ft） */
export const paFt = p => (p >= 226.32 ? 145366.45 * (1 - (p / 1013.25) ** 0.190284) : 36089 + 20806 * Math.log(226.32 / p));
const fl3 = ft => 'FL' + String(Math.round(ft / 1000) * 10).padStart(3, '0');
const latOf = i => A.s + i * A.d, lonOf = j => A.w + j * A.d;

// ---------- データ ----------
function idb() {
  return new Promise((ok, ng) => {
    try { const q = indexedDB.open('aw-analysis3d', 1); q.onupgradeneeded = () => q.result.createObjectStore('d'); q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error); }
    catch (e) { ng(e); }
  });
}
async function idbGet(k) { try { const db = await idb(); return await new Promise(ok => { const r = db.transaction('d').objectStore('d').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); } catch { return null; } }
async function idbPut(k, v) { try { const db = await idb(); await new Promise(ok => { const t = db.transaction('d', 'readwrite'); t.objectStore('d').put(v, k); t.oncomplete = ok; t.onerror = ok; }); } catch { /* 保存できなくても表示は続ける */ } }

const hourStr = ms => new Date(ms).toISOString().slice(0, 13) + ':00';
/**
 * 解析時刻（GSM の最新の初期値）の値を読む。onProgress(done, total)、onWait(秒)
 * 返り値：{ init(ms), T:{p:Float32Array}, U:{p}, V:{p}, Z500, TD:{p} }（格子は [i*NX+j]、i は南から）
 */
export async function fetchAnalysis({ onProgress, onWait } = {}) {
  let init = null;
  try { init = (await (await fetch(META, { cache: 'no-store' })).json()).last_run_initialisation_time * 1000; } catch { /* 分からなければ下で最新の時刻 */ }
  const key = `a-${A.d}-${NX}x${NY}-${init}`;
  if (init) { const saved = await idbGet(key); if (saved) return saved; }
  const V = [];
  for (const p of T_LV) V.push(['T', p, `temperature_${p}hPa`]);
  for (const p of W_LV) V.push(['WS', p, `wind_speed_${p}hPa`], ['WD', p, `wind_direction_${p}hPa`]);
  for (const p of TD_LV) V.push(['TD', p, `dew_point_${p}hPa`]);
  V.push(['Z', 500, 'geopotential_height_500hPa']);
  const arr = () => new Float32Array(N).fill(NaN);
  const out = { init, T: {}, WS: {}, WD: {}, TD: {}, Z500: arr() };
  for (const [k, p] of V) if (k !== 'Z') out[k][p] = arr();
  const pts = []; for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) if (inSatDisk(latOf(i), lonOf(j))) pts.push([latOf(i), lonOf(j), i * NX + j]);
  const when = init ? `&start_hour=${hourStr(init)}&end_hour=${hourStr(init)}` : '&forecast_hours=1';
  const put = (b, list) => b.forEach((q, n) => {
    const h = list[n].hourly;
    for (const [k, p, name] of V) { const v = h[name]?.[0]; if (v == null) continue; (k === 'Z' ? out.Z500 : out[k][p])[q[2]] = v; }
  });
  // RISH（京都大学の GSM）が使えるときは全地点を 1 回で（回数の制限がない）
  if (gpvSource() === 'rish' && rishBase()) {
    try {
      onProgress?.(0, pts.length);
      const r = await fetch(`${OM}?latitude=${pts.map(q => q[0]).join(',')}&longitude=${pts.map(q => q[1]).join(',')}&hourly=${V.map(v => v[2]).join(',')}` +
        `&models=jma_gsm&wind_speed_unit=kn&timezone=GMT${when}`);
      if (r.headers.get('X-AW-Source') !== 'rish') throw new Error('RISH で答えられませんでした');
      put(pts, await r.json());
      onProgress?.(pts.length, pts.length);
      if (init) idbPut(key, out);
      return out;
    } catch (e) { console.warn('[解析3D] RISH が使えないので Open-Meteo で読みます：', e.message || e); }
  }
  // Open-Meteo：もとの範囲（東経95〜165度・北緯0〜60度）だけ読む
  const omPts = pts.filter(([la, lo]) => lo >= OLD.w && lo <= OLD.e && la >= OLD.s && la <= OLD.n);
  pts.length = 0; pts.push(...omPts);
  const B = 50, W1 = B * V.length / 10, sent = [];
  for (let s = 0; s < pts.length; s += B) {
    const b = pts.slice(s, s + B);
    for (;;) {                                              // 1分600回を超えないように（余裕を見て550回まで）
      const now = Date.now(); while (sent.length && now - sent[0][0] > 61e3) sent.shift();
      if (sent.reduce((a, x) => a + x[1], 0) + W1 <= 550) break;
      onWait?.(Math.ceil((61e3 - (now - sent[0][0])) / 1000)); await new Promise(ok => setTimeout(ok, 1000));
    }
    sent.push([Date.now(), W1]);
    const u = `${OM}?latitude=${b.map(q => q[0]).join(',')}&longitude=${b.map(q => q[1]).join(',')}&hourly=${V.map(v => v[2]).join(',')}` +
      `&models=jma_gsm&wind_speed_unit=kn&timezone=GMT${when}`;
    let r;
    for (let tries = 0; ; tries++) {
      r = await fetch(u);
      if (r.ok) break;
      const j = await r.json().catch(() => ({})), why = j.reason || '';
      if (/minutely/i.test(why) && tries < 3) { onWait?.(61); await new Promise(ok => setTimeout(ok, 61e3)); continue; }
      throw new Error(/daily/i.test(why) ? 'Open-Meteo の1日の利用上限に達しています（日本時間の朝9時ごろに戻ります）'
        : /hourly/i.test(why) ? 'Open-Meteo の1時間の利用上限に達しています（しばらくしてから試してください）' : `Open-Meteo ${r.status} ${why}`);
    }
    const j = await r.json(), list = Array.isArray(j) ? j : [j];
    put(b, list);
    onProgress?.(Math.min(pts.length, s + B), pts.length);
  }
  if (init) idbPut(key, out);
  return out;
}

// ---------- 計算 ----------
const at = (a, i, j) => (i < 0 || j < 0 || i >= NY || j >= NX ? NaN : a[i * NX + j]);
const uv = (ws, wd) => [-ws * Math.sin(wd * Math.PI / 180), -ws * Math.cos(wd * Math.PI / 180)];
/** 気温の水平方向の差（K/100km） */
function gradT(T) {
  const g = new Float32Array(N).fill(NaN);
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
    const dx = A.d * 111 * Math.cos(latOf(i) * Math.PI / 180) * 2, dy = A.d * 111 * 2;
    const gx = (at(T, i, j + 1) - at(T, i, j - 1)) / dx, gy = (at(T, i + 1, j) - at(T, i - 1, j)) / dy;
    if (isFinite(gx) && isFinite(gy)) g[i * NX + j] = Math.hypot(gx, gy) * 100;
  }
  return g;
}
/** 上空の強風の高さ：300・250・200hPa の風速の山（放物線で結ぶ）。{ v: 風速kt, ft: 高さ } */
function jetCore(d) {
  const v = new Float32Array(N).fill(NaN), h = new Float32Array(N).fill(NaN);
  const L = [300, 250, 200], Z = L.map(paFt);
  for (let k = 0; k < N; k++) {
    const s = L.map(p => d.WS[p][k]); if (s.some(x => !isFinite(x))) continue;
    let m = 0; for (let n = 1; n < 3; n++) if (s[n] > s[m]) m = n;
    let z = Z[m], vm = s[m];
    if (m === 1) { const dd = s[0] - 2 * s[1] + s[2]; if (dd < 0) { const t = 0.5 * (s[0] - s[2]) / dd; z = t < 0 ? Z[1] + t * (Z[1] - Z[0]) : Z[1] + t * (Z[2] - Z[1]); vm = s[1] - 0.25 * (s[0] - s[2]) * t; } }
    v[k] = vm; h[k] = z;
  }
  return { v, h };
}
/** 圏界面の高さ（ft）：500hPa より上で、気温の下がり方が 2℃/km 以下になる最初の高さ */
function tropopause(d) {
  const L = [500, 400, 300, 250, 200, 150, 100], Z = L.map(p => paFt(p) * FT / 1000);   // km
  const out = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) {
    const t = L.map(p => d.T[p][k]); if (t.some(x => !isFinite(x))) continue;
    const lapse = []; for (let n = 0; n < L.length - 1; n++) lapse.push((t[n] - t[n + 1]) / (Z[n + 1] - Z[n]));
    let z = Z.at(-1);
    for (let n = 1; n < lapse.length; n++) {
      if (lapse[n] <= 2) {                                   // 層の間で 2℃/km を下回る所を、前の層との間で内挿
        const z0 = (Z[n - 1] + Z[n]) / 2, z1 = (Z[n] + Z[n + 1]) / 2, a = lapse[n - 1], b = lapse[n];
        z = a > 2 ? z0 + (z1 - z0) * (a - 2) / (a - b) : Z[n];
        break;
      }
    }
    out[k] = z * 1000 / FT;
  }
  return smooth(out, 1);
}
function smooth(a, passes = 1) {
  let s = a;
  for (let p = 0; p < passes; p++) {
    const o = new Float32Array(N).fill(NaN);
    for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
      let sum = 0, n = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const v = at(s, i + di, j + dj); if (isFinite(v)) { sum += v; n++; } }
      if (n) o[i * NX + j] = sum / n;
    }
    s = o;
  }
  return s;
}
/** 等値線（マーチングスクエア）→ 線分 [[lon,lat],[lon,lat]] */
function contour(a, v) {
  const segs = [];
  const P = (i, j) => [lonOf(j), latOf(i)];
  const lerp = (p, q, va, vb) => { const t = (v - va) / (vb - va); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
  for (let i = 0; i < NY - 1; i++) for (let j = 0; j < NX - 1; j++) {
    const c = [at(a, i, j), at(a, i, j + 1), at(a, i + 1, j + 1), at(a, i + 1, j)];
    if (c.some(x => !isFinite(x))) continue;
    const p = [P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j)];
    const cr = [];
    for (let e = 0; e < 4; e++) { const a0 = c[e], a1 = c[(e + 1) % 4]; if ((a0 < v) !== (a1 < v)) cr.push(lerp(p[e], p[(e + 1) % 4], a0, a1)); }
    if (cr.length === 2) segs.push(cr);
    else if (cr.length === 4) { segs.push([cr[0], cr[1]]); segs.push([cr[2], cr[3]]); }
  }
  return segs;
}
/** 帯の中心の軸（南北に見て一番強い所を、東西につなぐ）。val(i,j) が min 以上の所 */
function axes(val, min, { minLen = 3, maxJump = 2 } = {}) {
  const cand = [];
  for (let j = 0; j < NX; j++) for (let i = 1; i < NY - 1; i++) {
    const v = val(i, j), a = val(i - 1, j), b = val(i + 1, j);
    if (!(v >= min) || !(v >= a) || !(v >= b)) continue;
    const dd = a - 2 * v + b, t = dd < 0 ? 0.5 * (a - b) / dd : 0;
    cand.push({ i, j, lat: latOf(i) + t * A.d, lon: lonOf(j), v });
  }
  const chains = [];
  for (const c of cand.sort((x, y) => x.j - y.j)) {
    let best = null;
    for (const ch of chains) { const l = ch.at(-1); if (l.j === c.j - 1 && Math.abs(l.i - c.i) <= maxJump && (!best || Math.abs(best.at(-1).i - c.i) > Math.abs(l.i - c.i))) best = ch; }
    if (best && best.at(-1).j === c.j - 1 && !best._took?.has(c.j)) { best.push(c); (best._took ||= new Set()).add(c.j); } else chains.push([c]);
  }
  return chains.filter(ch => ch.length >= minLen);
}
/** 500hPa の谷・峰の軸（東西の偏差の極小・極大を、南北につなぐ） */
function troughRidge(Z) {
  const anom = new Float32Array(N).fill(NaN);
  for (let i = 0; i < NY; i++) {
    let s = 0, n = 0; for (let j = 0; j < NX; j++) { const v = at(Z, i, j); if (isFinite(v)) { s += v; n++; } }
    for (let j = 0; j < NX; j++) anom[i * NX + j] = at(Z, i, j) - s / n;
  }
  const an = smooth(anom, 1), out = [];
  for (const kind of ['trough', 'ridge']) {
    const sg = kind === 'trough' ? -1 : 1, pts = [];
    for (let i = 0; i < NY; i++) {
      const lat = latOf(i); if (Math.abs(lat) < 20 || Math.abs(lat) > 60) continue;   // 北半球・南半球の中緯度
      for (let j = 3; j < NX - 3; j++) {
        const v = sg * at(an, i, j); if (!(v >= 20)) continue;
        let ext = true; for (let dj = -3; dj <= 3; dj++) if (dj && sg * at(an, i, j + dj) > v) { ext = false; break; }
        if (ext) pts.push({ i, j, lat, lon: lonOf(j), v });
      }
    }
    const chains = [];
    for (const c of pts.sort((x, y) => x.i - y.i)) {
      const ch = chains.find(h => h.at(-1).i === c.i - 1 && Math.abs(h.at(-1).j - c.j) <= 3);
      if (ch) ch.push(c); else chains.push([c]);
    }
    for (const ch of chains) if (ch.length >= 3) out.push({ kind, pts: ch });
  }
  return out;
}

// ---------- 描画 ----------
// 東の端が 180度を超えるときは西経に直す（西 > 東 で日付変更線をまたぐ四角）
const rect = () => { const e = A.e + A.d / 2; return Cesium.Rectangle.fromDegrees(A.w - A.d / 2, A.s - A.d / 2, e > 180 ? e - 360 : e, A.n + A.d / 2); };
/** 格子の色（rgba 0〜255）を、なめらかにした絵にする（北が上） */
function texture(rgba) {
  const c = document.createElement('canvas'); c.width = NX; c.height = NY;
  const g = c.getContext('2d'), img = g.createImageData(NX, NY);
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
    const col = rgba(i, j), k = ((NY - 1 - i) * NX + j) * 4;
    if (col) { img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = col[3]; }
  }
  g.putImageData(img, 0, 0);
  const big = document.createElement('canvas'); big.width = NX * 12; big.height = NY * 12;
  const b = big.getContext('2d'); b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'high'; b.drawImage(c, 0, 0, big.width, big.height);
  return big;
}
const imageMaterial = cv => new Cesium.Material({ fabric: { type: 'Image', uniforms: { image: cv.toDataURL('image/png') } }, translucent: true });
/** 一定の高さの板（色は格子ごと） */
function sheet(rgba, ft, scale) {
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.RectangleGeometry({ rectangle: rect(), height: ft * FT * scale,
      vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat, granularity: Cesium.Math.toRadians(0.5) }) }),
    appearance: new Cesium.MaterialAppearance({ material: imageMaterial(texture(rgba)), translucent: true, flat: true, faceForward: true,
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED }),
    asynchronous: false,
  });
}
/** 高さが場所で変わる面（hFt(i,j)、色は格子ごと） */
function surface(hFt, rgba, scale) {
  const pos = new Float64Array(N * 3), st = new Float32Array(N * 2), idx = [];
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
    const k = i * NX + j, h = hFt(i, j);
    const c = Cesium.Cartesian3.fromDegrees(lonOf(j), latOf(i), (isFinite(h) ? h : 0) * FT * scale);
    pos.set([c.x, c.y, c.z], k * 3); st.set([(j + 0.5) / NX, (i + 0.5) / NY], k * 2);
  }
  for (let i = 0; i < NY - 1; i++) for (let j = 0; j < NX - 1; j++) {
    const a = i * NX + j, b = a + 1, c = a + NX, d = c + 1;
    if ([a, b, c, d].some(k => !isFinite(hFt((k / NX) | 0, k % NX)))) continue;
    idx.push(a, b, c, b, d, c);
  }
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  return new Cesium.Primitive({ geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({ material: imageMaterial(texture(rgba)), translucent: true, flat: true, faceForward: true }), asynchronous: false });
}
const lbl = (labels, lon, lat, ft, scale, text, bg, fg = '#ffffff') => labels.add({
  position: Cesium.Cartesian3.fromDegrees(lon, lat, ft * FT * scale), text, font: '600 12.5px "Meiryo", sans-serif',
  fillColor: Cesium.Color.fromCssColorString(fg), showBackground: true, backgroundColor: Cesium.Color.fromCssColorString(bg),
  backgroundPadding: new Cesium.Cartesian2(6, 3), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -6),
  disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.4e7),
  scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 1.2e7, 0.75) });
/** 等値線を描き、いくつかの所に札を付ける */
function drawContour(pc, labels, a, v, ft, scale, color, width, text, bg, every = 18) {
  const segs = contour(a, v); if (!segs.length) return 0;
  const lines = pc.add(new Cesium.PolylineCollection());
  const col = Cesium.Color.fromCssColorString(color);
  for (const s of segs) lines.add({ positions: s.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la, ft * FT * scale)), width, material: Cesium.Material.fromType('Color', { color: col }) });
  if (text) for (let n = Math.floor(every / 2); n < segs.length; n += every) { const [p] = segs[n]; lbl(labels, p[0], p[1], ft, scale, text, bg); }
  return segs.length;
}
/** 矢印つきの軸 */
function arrowLine(pc, pts, color, width) {
  const l = pc.add(new Cesium.PolylineCollection());
  l.add({ positions: pts, width, material: Cesium.Material.fromType('PolylineArrow', { color: Cesium.Color.fromCssColorString(color) }) });
}

/** 色の段階（[値, [r,g,b]] の並び）で内挿 */
function rampRgb(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
    const [v0, a] = stops[k - 1], [v1, b] = stops[k], t = (v - v0) / (v1 - v0);
    return a.map((x, n) => Math.round(x + (b[n] - x) * t));
  }
  return stops.at(-1)[1];
}
// ジェット気流の赤（2026-10-18 午後）：60kt ごく薄い赤 → 100kt 赤 → 強くなるほど濃い赤（160kt 以上が一番濃い）
const JET_RED = [[60, [255, 228, 230]], [80, [255, 170, 175]], [100, [235, 40, 40]], [120, [200, 20, 25]], [140, [160, 8, 15]], [160, [105, 0, 5]]];
// 寒気の青：−6℃ 薄い青 → −42℃ 以下 濃い青
const COLD_BLUE = [[-42, [10, 30, 110]], [-36, [21, 70, 192]], [-30, [30, 120, 229]], [-20, [90, 170, 245]], [-6, [190, 225, 252]]];

/** 並びをなめらかに（前後 w 個の移動平均。端は短い窓） */
function smooth1d(a, w = 2, passes = 2) {
  let x = a.slice();
  for (let p = 0; p < passes; p++) x = x.map((_, k) => { let s = 0, n = 0; for (let d = -w; d <= w; d++) { const v = x[k + d]; if (v != null && isFinite(v)) { s += v; n++; } } return n ? s / n : x[k]; });
  return x;
}
/**
 * 滑らかな管（2026-10-18 午後に作り直し）。pts：[{ lon, lat, ft, v }]（流れの向きの順）
 *   ・格子ごとに選んだ軸の位置はギザギザなので、緯度・高さを移動平均でならし、Catmull-Rom で細かく分けて 1 本の管にする
 *   ・管は半透明（風速が強いほど濃い赤）。中に赤い矢印の線を通して、流れの向きを示す（教科書のジェット気流の絵と同じ形）
 */
function tubeArrow(pc, pts, scale, color, radius = 60000) {
  if (pts.length < 3) return;
  const lat = smooth1d(pts.map(p => p.lat), 2, 3), ft = smooth1d(pts.map(p => p.ft), 2, 3);
  const P = pts.map((p, k) => Cesium.Cartesian3.fromDegrees(p.lon, lat[k], ft[k] * FT * scale));
  const spline = new Cesium.CatmullRomSpline({ times: P.map((_, k) => k), points: P });
  const line = [];
  for (let t = 0; t <= P.length - 1 + 1e-9; t += 0.125) line.push(spline.evaluate(Math.min(t, P.length - 1)));
  const circle = Array.from({ length: 24 }, (_, k) => new Cesium.Cartesian2(Math.cos(k / 24 * 2 * Math.PI) * radius, Math.sin(k / 24 * 2 * Math.PI) * radius));
  pc.add(new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineVolumeGeometry({ polylinePositions: line, shapePositions: circle, cornerType: Cesium.CornerType.ROUNDED, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.42)) },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }), asynchronous: false,
  }));
  // 管の中の矢印（少し手前で止めて、矢じりが管の先に来るように）
  const arrow = pc.add(new Cesium.PolylineCollection());
  arrow.add({ positions: line.slice(Math.min(2, line.length - 2)), width: 16, material: Cesium.Material.fromType('PolylineArrow', { color: Cesium.Color.fromCssColorString('#e53935') }) });
}

/** 要素ごとの描画。d：fetchAnalysis の結果、scale：高度倍率 */
const DRAW = {
  jet(d, scale, pc, labels) {
    // 2026-10-18：赤のグラデーション（風速が強いほど濃い赤）の面と、管のような太い矢印（流れの向き）
    const { v, h } = jetCore(d), hs = smooth(h, 1);
    // 60kt 以上の帯：60kt はごく薄く（透けて）、強いほど濃く・不透明に
    pc.add(surface((i, j) => hs[i * NX + j], (i, j) => { const s = v[i * NX + j]; return s >= 60 ? [...rampRgb(JET_RED, s), Math.round(45 + Math.min(1, (s - 60) / 100) * 165)] : null; }, scale));
    for (const ch of axes((i, j) => at(v, i, j), 80)) {
      // 風の向き（ふつうは西→東）に並べる
      const mid = ch[ch.length >> 1], [u] = uv(at(d.WS[250], mid.i, mid.j), at(d.WD[250], mid.i, mid.j));
      const seq = u >= 0 ? ch : [...ch].reverse();
      const top = ch.reduce((a, b) => (b.v > a.v ? b : a));
      tubeArrow(pc, seq.map(c => ({ lon: c.lon, lat: c.lat, ft: at(hs, c.i, c.j) + 1500, v: c.v })), scale, Cesium.Color.fromBytes(...rampRgb(JET_RED, top.v), 255));
      lbl(labels, top.lon, top.lat, at(hs, top.i, top.j) + 5000, scale, `ジェット気流 ${Math.round(top.v / 5) * 5}kt ${fl3(at(hs, top.i, top.j))}`, 'rgba(120,10,10,0.9)');
    }
  },
  llj(d, scale, pc, labels) {
    const W = d.WS[850], ft = paFt(850);
    pc.add(sheet((i, j) => { const s = at(W, i, j); return s >= 30 ? [0, 230, 118, Math.round(60 + Math.min(1, (s - 30) / 30) * 110)] : null; }, ft, scale));
    for (const ch of axes((i, j) => at(W, i, j), 40, { minLen: 2 })) {
      // 風の向き（西→東とは限らない）：中央の風向に合わせて並べ替える
      const mid = ch[ch.length >> 1], [u] = uv(at(d.WS[850], mid.i, mid.j), at(d.WD[850], mid.i, mid.j));
      const seq = u >= 0 ? ch : [...ch].reverse();
      arrowLine(pc, seq.map(c => Cesium.Cartesian3.fromDegrees(c.lon, c.lat, (ft + 800) * FT * scale)), '#00c853', 12);
      const top = ch.reduce((a, b) => (b.v > a.v ? b : a));
      lbl(labels, top.lon, top.lat, ft + 2500, scale, `下層ジェット ${Math.round(top.v / 5) * 5}kt（850hPa）`, 'rgba(0,90,40,0.88)');
    }
  },
  front(d, scale, pc, labels) {
    // 2026-10-18：紫の面。850hPa の前線帯の軸（気温の差が一番大きい所）から、700・500・400hPa の軸を
    // 北（寒気側）へたどってつなぎ、上空から地上付近まで傾いた面にする。地上付近は 850→700hPa のずれを南へ延ばして求める
    const LV = [850, 700, 500, 400, 300], G = Object.fromEntries(LV.map(p => [p, smooth(gradT(d.T[p]), 1)]));
    const PURPLE = [156, 39, 176];
    let best = null;
    for (const ch of axes((i, j) => at(G[850], i, j), 0.9, { minLen: 3, maxJump: 1 })) {
      // 列ごとに、上の高さの軸の緯度を北へ探す（下の高さの位置から 0〜4 格子北まで）。
      // 上空で気温の差がはっきりしないときは、下の 2 つの高さの傾きをそのまま上へ延ばす（300hPa 付近まで届くように）
      // 寒気側は北半球なら北、南半球なら南（sg）
      const sg = ch[ch.length >> 1].lat >= 0 ? 1 : -1;
      const cols = ch.map(c => {
        const rows = [{ p: 850, i: c.i, lat: c.lat, g: c.v }];
        let i0 = c.i;
        for (const p of LV.slice(1)) {
          let bi = -1, bg = 0;
          for (let n = 0; n <= 4; n++) { const i = i0 + sg * n; if (i < 0 || i >= NY) break; const g = at(G[p], i, c.j); if (g > bg) { bg = g; bi = i; } }
          let lat;
          if (bi >= 0 && bg >= 0.4) { lat = latOf(bi); i0 = bi; }
          else {
            const r1 = rows.at(-1), r0 = rows.at(-2) || { lat: r1.lat - sg, p: 1000 };
            lat = r1.lat + sg * Math.max(0.5, sg * (r1.lat - r0.lat)) * (paFt(p) - paFt(r1.p)) / Math.max(1, paFt(r1.p) - paFt(r0.p));
          }
          rows.push({ p, lat, g: bg });
        }
        return { lon: c.lon, rows };
      });
      // 列の間でならす（ギザギザを消す）
      for (let r = 0; r < LV.length; r++) { const sm = smooth1d(cols.map(c => c.rows[r].lat), 1, 2); cols.forEach((c, k) => { c.rows[r].lat = sm[k]; }); }
      const nUp = Math.min(...cols.map(c => c.rows.length));
      if (nUp < 2) continue;
      // 地上付近（約 1,000ft）：850 と 700hPa のずれ（傾き）を、そのまま下へ延ばした位置
      const ground = cols.map(c => ({ lat: c.rows[0].lat - sg * Math.min(4, Math.max(0.3, sg * (c.rows[1].lat - c.rows[0].lat)) * (paFt(850) - 1000) / (paFt(700) - paFt(850))), ft: 1000 }));
      const rowsFt = [1000, ...LV.slice(0, nUp).map(paFt)];
      const pos = [], idx = [];
      cols.forEach((c, k) => {
        const lats = [ground[k].lat, ...c.rows.slice(0, nUp).map(r => r.lat)];
        lats.forEach((la, r) => { const q = Cesium.Cartesian3.fromDegrees(c.lon, la, rowsFt[r] * FT * scale); pos.push(q.x, q.y, q.z); });
      });
      const R = nUp + 1;
      for (let k = 0; k < cols.length - 1; k++) for (let r = 0; r < R - 1; r++) {
        const a = k * R + r, b = a + 1, c2 = a + R, e = c2 + 1;
        idx.push(a, c2, b, b, c2, e);
      }
      const strength = ch.reduce((a, b) => a + b.v, 0) / ch.length;
      const geometry = new Cesium.Geometry({
        attributes: { position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(pos) }) },
        indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromVertices(pos),
      });
      Cesium.GeometryPipeline.computeNormal(geometry);
      pc.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromBytes(...PURPLE, Math.round(110 + Math.min(1, (strength - 0.9) / 1.2) * 110))) } }),
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: false, faceForward: true }), asynchronous: false,
      }));
      // 面のへり（上と下）を濃い紫の線で
      const line = pc.add(new Cesium.PolylineCollection());
      const col = Cesium.Color.fromBytes(106, 27, 154, 255);
      line.add({ positions: cols.map((c, k) => Cesium.Cartesian3.fromDegrees(c.lon, ground[k].lat, 1000 * FT * scale)), width: 3, material: Cesium.Material.fromType('Color', { color: col }) });
      line.add({ positions: cols.map(c => Cesium.Cartesian3.fromDegrees(c.lon, c.rows[nUp - 1].lat, rowsFt[nUp] * FT * scale)), width: 2, material: Cesium.Material.fromType('Color', { color: col }) });
      if (!best || strength > best.s) best = { s: strength, c: cols[cols.length >> 1], ft: rowsFt[R - 1], top: ch.reduce((a, b) => (b.v > a.v ? b : a)) };
      const m = cols[cols.length >> 1];
      lbl(labels, m.lon, m.rows[nUp - 1].lat, rowsFt[nUp] + 2000, scale, `前線帯（地上付近〜${LV[nUp - 1]}hPa・${ch.reduce((a, b) => Math.max(a, b.v), 0).toFixed(1)}℃/100km）`, 'rgba(74,20,140,0.9)');
    }
  },
  moist(d, scale, pc, labels) {
    for (const p of [850, 700]) {
      const T = d.T[p], TD = d.TD[p], ft = paFt(p);
      // 2026-10-18：緑（湿数が小さいほど濃い緑）
      pc.add(sheet((i, j) => { const dd = at(T, i, j) - at(TD, i, j); return dd <= 3 ? [0, 200, 83, Math.round(90 + (3 - Math.max(0, dd)) / 3 * 100)] : dd <= 6 ? [105, 240, 174, 45] : null; }, ft, scale));
      drawContour(pc, labels, Float32Array.from(T, (t, k) => t - TD[k]), 3, ft + 300, scale, '#00e676', 2, `湿域（${p}hPa 湿数3℃以下）`, 'rgba(0,80,40,0.9)', 40);
    }
  },
  trop(d, scale, pc, labels) {
    const h = tropopause(d);
    pc.add(surface((i, j) => h[i * NX + j], () => [255, 214, 0, 120], scale));   // 2026-10-18：黄色の面
    for (let i = 2; i < NY; i += 6) for (let j = 2; j < NX; j += 7) { const v = at(h, i, j); if (isFinite(v)) lbl(labels, lonOf(j), latOf(i), v + 800, scale, `圏界面 ${fl3(v)}`, 'rgba(90,80,0,0.8)', '#fff9c4'); }
  },
  cold(d, scale, pc, labels) {
    const T5 = d.T[500], T8 = d.T[850], f5 = paFt(500), f8 = paFt(850);
    // 2026-10-18：−6℃ 以下を青のグラデーション（低いほど濃い青）
    const blue = t => (t <= -6 ? [...rampRgb(COLD_BLUE, t), Math.round(60 + Math.min(1, (-6 - t) / 30) * 120)] : null);
    pc.add(sheet((i, j) => blue(at(T5, i, j)), f5, scale));
    drawContour(pc, labels, T5, -30, f5 + 200, scale, '#64b5f6', 3, '500hPa −30℃（大雪の目安）', 'rgba(13,71,161,0.9)');
    drawContour(pc, labels, T5, -36, f5 + 200, scale, '#2962ff', 4, '500hPa −36℃（大雪のおそれ大）', 'rgba(13,40,120,0.92)');
    drawContour(pc, labels, T5, -6, f5 + 200, scale, '#bbdefb', 2, '500hPa −6℃（夏の雷の目安）', 'rgba(13,71,161,0.85)');
    pc.add(sheet((i, j) => blue(at(T8, i, j)), f8, scale));
    drawContour(pc, labels, T8, -6, f8 + 200, scale, '#bbdefb', 3, '850hPa −6℃（平地で雪の目安）', 'rgba(21,101,192,0.9)');
  },
  ridge(d, scale, pc, labels) {
    const Z = d.Z500, ft = paFt(500);
    for (let z = 4800; z <= 5940; z += 60) {
      const thick = z === 5400 || z === 5700 || z === 5880;
      drawContour(pc, labels, Z, z, ft, scale, z === 5880 ? '#ff8a65' : '#90caf9', thick ? 2.5 : 1.2, thick ? `${z}m${z === 5880 ? '（太平洋高気圧の目安）' : ''}` : null, 'rgba(13,50,90,0.85)', 30);
    }
    for (const ax of troughRidge(Z)) {
      const trough = ax.kind === 'trough';
      const l = pc.add(new Cesium.PolylineCollection());
      const la = smooth1d(ax.pts.map(c => c.lat), 1, 1), lo = smooth1d(ax.pts.map(c => c.lon), 1, 2);
      l.add({ positions: ax.pts.map((c, k) => Cesium.Cartesian3.fromDegrees(lo[k], la[k], (ft + 600) * FT * scale)), width: trough ? 14 : 7,
        material: trough ? Cesium.Material.fromType('PolylineDash', { color: Cesium.Color.fromCssColorString('#8d5524'), gapColor: Cesium.Color.TRANSPARENT, dashLength: 28, dashPattern: 0x0f0f })   // 谷：太い茶色の点線
          : Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString('#c8a032') }) });                                // 峰：黄土色
      const top = ax.pts.at(-1);
      lbl(labels, top.lon, top.lat, ft + 2500, scale, trough ? '気圧の谷（500hPa）' : '気圧の峰（500hPa）', trough ? 'rgba(93,50,20,0.92)' : 'rgba(140,105,20,0.92)');
    }
  },
};
export const ITEMS = [['jet', 'ジェット気流'], ['llj', '下層ジェット'], ['front', '前線帯'], ['moist', '湿域'], ['trop', '圏界面'], ['cold', '寒気'], ['ridge', '500hPa 谷・峰']];

/**
 * 表示の管理。fetcher を差し替えると、ほかのデータでも描ける（テスト用）
 * @returns { set(key, on) → Promise<boolean>, isOn(key) }
 */
export function createAnalysis3D(viewer, { onStatus, fetcher = fetchAnalysis } = {}) {
  const on = new Set(), prims = new Map();
  let data = null, loading = null;
  const scale = () => window.awGetAltScale?.() ?? 1;
  const remove = k => { const p = prims.get(k); if (p) { viewer.scene.primitives.remove(p); prims.delete(k); } };
  function draw(k) {
    remove(k); if (!on.has(k) || !data) return;
    const pc = new Cesium.PrimitiveCollection(), labels = pc.add(new Cesium.LabelCollection());
    try { DRAW[k](data, scale(), pc, labels); } catch (e) { console.warn('[analysis3d]', k, e); }
    prims.set(k, viewer.scene.primitives.add(pc));
    viewer.scene.requestRender?.();
  }
  const timeText = () => (data?.init ? `${new Date(data.init).toISOString().slice(5, 13).replace('-', '/').replace('T', ' ')}UTC の解析（気象庁 GSM・2.5度格子）` : '最新の解析（気象庁 GSM）');
  async function load() {
    if (data) return data;
    loading ||= fetcher({
      onProgress: (a, b) => onStatus?.(`数値予報を読み込んでいます… ${a}/${b}地点`),
      onWait: s => onStatus?.(`Open-Meteo の1分あたりの回数制限のため待っています…（あと約${s}秒。全部で約3分）`),
    }).then(d => (data = d)).finally(() => { loading = null; });
    return loading;
  }
  window.addEventListener('aw:altscale', () => { for (const k of on) draw(k); });
  return {
    isOn: k => on.has(k),
    async set(k, want) {
      if (!want) { on.delete(k); remove(k); onStatus?.(on.size ? timeText() : ''); return false; }
      on.add(k);
      try { await load(); } catch (e) { on.delete(k); onStatus?.(`読み込めませんでした（${e.message}）`); return false; }
      if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);   // 高さが分かるように誇張
      draw(k); onStatus?.(timeText() + '。天気図の目安となる構造を自動で求めたもので、気象庁の解析図と見比べて使う');
      return true;
    },
  };
}
