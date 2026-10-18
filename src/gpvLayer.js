// GPV（数値予報の格子データ）の表示：気象庁 GSM（全球モデル。Open-Meteo 経由）
//   要素：上空の風（矢羽根）・気温（色分け＋等温線）・湿り（湿数 T−Td）・雲量・降水量（地上の1時間降水量）
//   高さ：850 / 700 / 500 / 300 / 250 / 200hPa。時刻：最大39時間先までスライダーで動かす
//   ・GSM は6時間ごとの予報。Open-Meteo が1時間ごとに内挿した値を使う（格子の元の細かさは0.5度）
//   表示：「地図」＝選んだ1つの高さを地図に重ねる。「3D」＝6つの高さを、それぞれの高度（標準大気の FL）に板として積み重ねる
//   範囲：衛星画像の範囲（下の G の説明）。Open-Meteo で読むときは、日本付近は全部の格子、それ以外は 3格子ごとに読み、
//     間の格子は内挿で埋める。矢羽根は読んだ地点だけに描く
//   ・6つの高さをまとめて一度に読む（27要素）。Open-Meteo は10要素ごとに1回と数えるので、1回の読み込みで約2,300回。
//     無料版は1分600回・1時間5000回・1日1万回まで。1分の上限を超えないように間を空けて読む（全部で約4〜5分）。
//     日本付近を先に読んで表示し、そのあと周りを読み足す。
//     読んだデータは、新しい GSM が出るまでブラウザ（IndexedDB）に保存して使い回す（ページを開き直しても読み直さない）
//   ・GSM の湿度・雲量は 300hPa まで。250・200hPa では湿り・雲量はない
//   ・2026-10-18：データ源を京都大学 生存圏研究所（RISH）の気象庁 GSM に変更（src/gpvSource/。fetch を包んで Open-Meteo の
//     問い合わせに答える）。RISH のときは衛星画像の範囲の全部の格子点（1.5度ごと 約9,000地点）を 1 回で読み、待ち時間もない。読めなければ Open-Meteo
//   ・地図のレイヤや 3D は primitive で描く（事例の切り替えや高度の倍率変更で viewer.entities が消されても残るように）
import * as Cesium from 'cesium';
import { gpvSource, rishGrid } from './gpvSource/omShim.js';
import { rishBase } from './gpvSource/rishGsm.js';
import { inSatDisk, SAT_LON0, SAT_RADIUS } from './satDisk.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const META = 'https://api.open-meteo.com/data/jma_gsm/static/meta.json';
// 範囲：衛星画像（ひまわり）が写る範囲（東経140.7度を中心に半径81度の円。satDisk.js）を囲む四角を 1.5度ごと（2026-10-18 に広げた。
//   それまでは東経97〜147度・南緯6度〜北緯46度を 1度ごと）。円の外の格子は読まない（描かない）。経度は 180度を超えて東へ続ける（西経は 360 足す）
const G = { w: 60, e: 222, s: -79.5, n: 79.5, d: 1.5 };
const JP = { w: 120, e: 150, s: 21, n: 48 };         // Open-Meteo で読むとき、全部の格子を読む範囲（日本付近）
const COARSE = 3;                                   // それ以外は何格子ごとに読むか（Open-Meteo のとき）
const NX = Math.round((G.e - G.w) / G.d) + 1, NY = Math.round((G.n - G.s) / G.d) + 1, N = NX * NY;
const HOURS = 40;                                   // 今の時刻＋39時間
export const LEVELS = [[850, 'FL050', 5000], [700, 'FL100', 10000], [500, 'FL180', 18000], [300, 'FL300', 30000], [250, 'FL340', 34000], [200, 'FL390', 39000]];
const MOIST_LV = [850, 700, 500, 300];              // 湿度・雲量がある高さ
const FIELDS = [['wind', '風'], ['temp', '気温'], ['moist', '湿り（湿数）'], ['cloud', '雲量'], ['precip', '降水量（地上）']];
const RECT = { w: G.w - G.d / 2, e: G.e + G.d / 2, s: G.s - G.d / 2, n: G.n + G.d / 2 };
// Cesium の四角は −180〜180 度。東の端が 180 度を超えるときは西経に直す（西 > 東 で日付変更線をまたぐ四角になる）
const cRect = () => Cesium.Rectangle.fromDegrees(RECT.w, RECT.s, RECT.e > 180 ? RECT.e - 360 : RECT.e, RECT.n);
const inDisk = (i, j) => inSatDisk(G.s + i * G.d, G.w + j * G.d);

// ---------- データの取得（6つの高さをまとめて） ----------
let cache = null;                                   // { at, init, data }
const STORE_KEY = `gsm-${G.d}-${G.w}-${G.s}-${NX}x${NY}`;   // 格子を変えたら別の保存として扱う
// ブラウザへの保存（IndexedDB）。使えない環境では何もしない
function idb() {
  return new Promise((ok, ng) => {
    try { const q = indexedDB.open('aeroweather-gpv', 1); q.onupgradeneeded = () => q.result.createObjectStore('msm'); q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error); }
    catch (e) { ng(e); }
  });
}
async function idbGet(k) {
  try { const db = await idb(); return await new Promise(ok => { const r = db.transaction('msm').objectStore('msm').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); }
  catch { return null; }
}
async function idbPut(k, v) {
  try { const db = await idb(); await new Promise(ok => { const t = db.transaction('msm', 'readwrite'); t.objectStore('msm').put(v, k); t.oncomplete = ok; t.onerror = ok; }); }
  catch { /* 保存できなくても表示は続ける */ }
}
async function modelInit() {
  try { const m = await (await fetch(META, { cache: 'no-store' })).json(); return m.last_run_initialisation_time * 1000; } catch { return null; }
}
async function fetchAll(onProgress, onWait, onPartial) {
  const init = await modelInit();
  if (cache && (init ? cache.init === init : Date.now() - cache.at < 3600e3)) return cache.data;
  // ブラウザに保存した同じ初期値のデータがあれば、それを使う（Open-Meteo の回数を使わない）
  const saved = await idbGet(STORE_KEY);
  if (saved && (init ? saved.init === init : Date.now() - saved.at < 3600e3)) {
    cache = { at: saved.at, init: saved.init, data: { ...saved.data, times: saved.data.times.map(t => new Date(t)) } };
    return cache.data;
  }
  const V = [['PR', null, 'precipitation']];
  for (const [p] of LEVELS) {
    V.push(['T', p, `temperature_${p}hPa`], ['WS', p, `wind_speed_${p}hPa`], ['WD', p, `wind_direction_${p}hPa`]);
    if (MOIST_LV.includes(p)) V.push(['TD', p, `dew_point_${p}hPa`], ['CC', p, `cloud_cover_${p}hPa`]);
  }
  const arr = () => new Float32Array(HOURS * N).fill(NaN);
  const lv = Object.fromEntries(LEVELS.map(([p]) => [p, { p, T: arr(), WS: arr(), WD: arr(), TD: arr(), CC: arr() }]));
  const PR = arr();
  const dest = ([k, p]) => (p ? lv[p][k] : PR);
  let times = null;
  const pts = [];
  const inJP = (la, lo) => lo >= JP.w && lo <= JP.e && la >= JP.s && la <= JP.n;
  const onLattice = (i, j) => i % COARSE === 0 && j % COARSE === 0;
  const fetched = new Uint8Array(N);
  // RISH（京都大学の GSM）が使えるときは、衛星画像の範囲の全部の格子点を 1 回で読む（回数の制限がない。JSON を通さず直接）
  if (gpvSource() === 'rish' && rishBase()) {
    const all = [];
    for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) if (inDisk(i, j)) all.push([G.s + i * G.d, G.w + j * G.d, i * NX + j]);
    try {
      onProgress?.(0, all.length);
      const hour0 = Math.floor(Date.now() / 3600e3) * 3600e3, tms = Array.from({ length: HOURS }, (_, k) => hour0 + k * 3600e3);
      const { data: got } = await rishGrid(V.map(v => v[2]), all.map(q => [q[0], q[1]]), tms, { wind: 'kn' });
      if (![...got.values()].some(a => a.some(Number.isFinite))) throw new Error('RISH の予報の範囲の外です');
      const NP = all.length;
      for (const v of V) {
        const a = got.get(v[2]), d = dest(v);
        for (let t = 0; t < HOURS; t++) for (let n = 0; n < NP; n++) { const x = a[t * NP + n]; if (Number.isFinite(x)) d[t * N + all[n][2]] = x; }
      }
      all.forEach(q => { fetched[q[2]] = 1; });
      onProgress?.(all.length, all.length);
      const data = { times: tms.map(t => new Date(t)), lv, PR, fetched, source: 'rish' };
      cache = { at: Date.now(), init, data };
      idbPut(STORE_KEY, { at: cache.at, init, data: { ...data, times: data.times.map(t => t.getTime()) } });
      return data;
    } catch (e) { console.warn('[GPV] RISH が使えないので Open-Meteo で読みます：', e.message || e); fetched.fill(0); times = null; }
  }
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) if (inDisk(i, j) && inJP(G.s + i * G.d, G.w + j * G.d)) pts.push([G.s + i * G.d, G.w + j * G.d, i * NX + j]);
  const nJP = pts.length;
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) if (inDisk(i, j) && !inJP(G.s + i * G.d, G.w + j * G.d) && onLattice(i, j)) pts.push([G.s + i * G.d, G.w + j * G.d, i * NX + j]);
  pts.forEach(q => { fetched[q[2]] = 1; });
  const B = 50;
  const W1 = B * Math.ceil(V.length / 10 * 10) / 10;            // 1回の要求で数えられる回数（地点数×要素数/10）
  const sent = [];                                             // 直近1分に送った [時刻, 回数]
  for (let s = 0; s < pts.length; s += B) {
    const b = pts.slice(s, s + B);
    // 1分600回を超えないように待つ（余裕を見て550回まで）
    for (;;) {
      const now = Date.now(); while (sent.length && now - sent[0][0] > 61e3) sent.shift();
      const used = sent.reduce((a, x) => a + x[1], 0);
      if (used + W1 <= 550) break;
      onWait?.(Math.ceil((61e3 - (now - sent[0][0])) / 1000));
      await new Promise(ok => setTimeout(ok, 1000));
    }
    sent.push([Date.now(), W1]);
    const u = `${OM}?latitude=${b.map(q => q[0]).join(',')}&longitude=${b.map(q => q[1]).join(',')}&hourly=${V.map(v => v[2]).join(',')}` +
      `&models=jma_gsm&forecast_hours=${HOURS}&wind_speed_unit=kn&timezone=GMT`;
    let r;
    for (let tries = 0; ; tries++) {
      r = await fetch(u);
      if (r.ok) break;
      const j = await r.json().catch(() => ({})), why = j.reason || '';
      if (/minutely/i.test(why) && tries < 3) { onWait?.(); await new Promise(ok => setTimeout(ok, 61e3)); continue; }   // 1分の上限：待って続ける
      throw new Error(/daily/i.test(why) ? 'Open-Meteo の1日の利用上限に達しました（日本時間の朝9時ごろに戻ります）'
        : /hourly/i.test(why) ? 'Open-Meteo の1時間の利用上限に達しました（しばらくしてから試してください）' : `Open-Meteo ${r.status} ${why}`);
    }
    const j = await r.json(), list = Array.isArray(j) ? j : [j];
    times = times || list[0].hourly.time;
    b.forEach((q, n) => {
      const h = list[n].hourly;
      for (const v of V) { const a = h[v[2]], d = dest(v); if (!a) continue; for (let t = 0; t < HOURS && t < a.length; t++) if (a[t] != null) d[t * N + q[2]] = a[t]; }
    });
    onProgress?.(Math.min(pts.length, s + B), pts.length);
    // 日本付近を読み終えたら、いったん表示する
    if (s + B >= nJP && s < nJP) onPartial?.({ times: times.map(x => new Date(x + 'Z')), lv, PR, fetched, partial: true });
  }
  fillCoarse([PR, ...Object.values(lv).flatMap(L => [L.T, L.TD, L.CC, L.WS])], Object.values(lv), fetched);
  const data = { times: times.map(s => new Date(s + 'Z')), lv, PR, fetched };
  cache = { at: Date.now(), init, data };
  idbPut(STORE_KEY, { at: cache.at, init, data: { ...data, times: data.times.map(t => t.getTime()) } });
  return data;
}

/** 3度ごとに読んだ所の間（読んでいない格子）を、周りの読んだ地点から内挿して埋める。風は東西・南北成分で埋める */
function fillCoarse(scalars, levels, fetched) {
  const li = [], lj = [];
  for (let i = 0; i < NY; i += COARSE) li.push(i);
  for (let j = 0; j < NX; j += COARSE) lj.push(j);
  const brk = (L, v) => { let a = 0; while (a < L.length - 2 && L[a + 1] <= v) a++; return a; };
  const targets = [];
  for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
    const k = i * NX + j; if (fetched[k]) continue;
    const a = brk(li, i), b = brk(lj, j), i0 = li[a], i1 = li[a + 1], j0 = lj[b], j1 = lj[b + 1];
    const fy = Math.min(1, Math.max(0, (i - i0) / (i1 - i0))), fx = Math.min(1, Math.max(0, (j - j0) / (j1 - j0)));
    targets.push([k, [i0 * NX + j0, i0 * NX + j1, i1 * NX + j0, i1 * NX + j1], [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]]);
  }
  const mix = (arr, o, ks, w) => { let v = 0, sw = 0; ks.forEach((q, n) => { const x = arr[o + q]; if (isFinite(x) && w[n] > 0) { v += x * w[n]; sw += w[n]; } }); return sw ? v / sw : NaN; };
  for (let t = 0; t < HOURS; t++) {
    const o = t * N;
    for (const [k, ks, w] of targets) for (const arr of scalars) arr[o + k] = mix(arr, o, ks, w);
    for (const L of levels) {            // 風向は成分に分けて内挿し直す（風速は上で入れた値を使わず作り直す）
      for (const [k, ks, w] of targets) {
        let u = 0, v = 0, sw = 0;
        ks.forEach((q, n) => { const sp = L.WS[o + q], dr = L.WD[o + q]; if (isFinite(sp) && isFinite(dr) && w[n] > 0) { u += -sp * Math.sin(dr * Math.PI / 180) * w[n]; v += -sp * Math.cos(dr * Math.PI / 180) * w[n]; sw += w[n]; } });
        if (!sw) { L.WS[o + k] = NaN; L.WD[o + k] = NaN; continue; }
        u /= sw; v /= sw; L.WS[o + k] = Math.hypot(u, v); L.WD[o + k] = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
      }
    }
  }
}

// ---------- 格子値の内挿 ----------
const lonIn = lon => (lon < G.w ? lon + 360 : lon);   // 西経（負）は 360 足して格子の経度に
function sample(arr, t, lat, lon) {
  lon = lonIn(lon);
  const x = (lon - G.w) / G.d, y = (lat - G.s) / G.d;
  if (x < -0.5 || y < -0.5 || x > NX - 0.5 || y > NY - 0.5) return NaN;
  const cx = Math.min(NX - 1, Math.max(0, x)), cy = Math.min(NY - 1, Math.max(0, y));
  const j0 = Math.min(NX - 2, Math.floor(cx)), i0 = Math.min(NY - 2, Math.floor(cy)), fx = cx - j0, fy = cy - i0, o = t * N;
  const a = arr[o + i0 * NX + j0], b = arr[o + i0 * NX + j0 + 1], c = arr[o + (i0 + 1) * NX + j0], e = arr[o + (i0 + 1) * NX + j0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}
/** 風は向きと速さのままでは内挿できないので、東西・南北成分に分けて内挿する */
function windAt(L, t, lat, lon) {
  lon = lonIn(lon);
  const o = t * N, x = (lon - G.w) / G.d, y = (lat - G.s) / G.d;
  if (x < -0.5 || y < -0.5 || x > NX - 0.5 || y > NY - 0.5) return null;
  const U = k => -L.WS[o + k] * Math.sin(L.WD[o + k] * Math.PI / 180), Vv = k => -L.WS[o + k] * Math.cos(L.WD[o + k] * Math.PI / 180);
  const cx = Math.min(NX - 1, Math.max(0, x)), cy = Math.min(NY - 1, Math.max(0, y));
  const j0 = Math.min(NX - 2, Math.floor(cx)), i0 = Math.min(NY - 2, Math.floor(cy)), fx = cx - j0, fy = cy - i0;
  const ks = [i0 * NX + j0, i0 * NX + j0 + 1, (i0 + 1) * NX + j0, (i0 + 1) * NX + j0 + 1], w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  let u = 0, v = 0; ks.forEach((k, n) => { u += U(k) * w[n]; v += Vv(k) * w[n]; });
  if (!isFinite(u)) return null;
  return { spd: Math.hypot(u, v), dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

// ---------- 色 ----------
const lerp = (a, b, f) => a + (b - a) * f;
function ramp(stops, v) {               // stops: [[値, [r,g,b,a]], ...]（値の小さい順）
  if (!isFinite(v)) return null;
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
    const [v0, c0] = stops[k - 1], [v1, c1] = stops[k], f = (v - v0) / (v1 - v0);
    return c0.map((x, n) => lerp(x, c1[n], f));
  }
  return stops.at(-1)[1];
}
const TEMP = [[-60, [80, 0, 140, 150]], [-45, [40, 60, 200, 140]], [-30, [40, 130, 230, 120]], [-15, [90, 200, 230, 110]], [0, [230, 240, 240, 90]],
  [10, [250, 210, 90, 110]], [20, [245, 130, 50, 130]], [30, [210, 30, 30, 150]]];
const WIND = [[20, [0, 0, 0, 0]], [30, [120, 200, 255, 60]], [50, [80, 160, 255, 110]], [80, [255, 230, 80, 140]], [100, [255, 150, 40, 160]], [120, [230, 40, 40, 175]], [160, [190, 40, 200, 190]]];
const MOIST = [[0, [0, 170, 70, 150]], [3, [40, 190, 90, 120]], [6, [140, 210, 140, 40]], [9, [0, 0, 0, 0]]];
const CLOUD = [[10, [255, 255, 255, 0]], [50, [235, 240, 245, 90]], [100, [250, 252, 255, 200]]];
const RAIN = [[0.2, [0, 0, 0, 0]], [0.5, [242, 242, 255, 170]], [1, [160, 210, 255, 190]], [5, [33, 140, 255, 205]], [10, [0, 65, 255, 215]], [20, [250, 245, 0, 225]], [30, [255, 153, 0, 230]], [50, [255, 40, 0, 235]], [80, [180, 0, 104, 240]]];
const RAIN_STEP = v => { let c = null; for (const [t, col] of RAIN) if (v >= t) c = col; return c; };   // 降水は気象庁と同じ段階の色

export const LEGENDS = {
  wind: { unit: 'kt', items: [[30, WIND[1][1]], [50, WIND[2][1]], [80, WIND[3][1]], [100, WIND[4][1]], [120, WIND[5][1]], [160, WIND[6][1]]], note: '矢羽根：短い線＝5kt、長い線＝10kt、旗＝50kt。80kt以上がジェット気流の目安' },
  temp: { unit: '℃', items: TEMP.map(([v, c]) => [v, c]), note: '等温線は3℃ごと。0℃の線（赤の太線）は着氷・雨雪の目安' },
  moist: { unit: '℃', items: [[0, MOIST[0][1]], [3, MOIST[1][1]], [6, MOIST[2][1]]], note: '湿数（気温−露点）3℃以下＝湿っている（雲がある目安）。300hPa まで' },
  cloud: { unit: '%', items: [[50, CLOUD[1][1]], [100, CLOUD[2][1]]], note: 'その気圧面の雲量。300hPa まで' },
  precip: { unit: 'mm/h', items: RAIN.slice(1).map(([v, c]) => [v, c]), note: '地上の1時間降水量（前1時間）。色は気象庁のレーダーと同じ段階' },
};
/** その要素がその高さで描けるか */
const hasField = (field, p) => field === 'precip' || ((field === 'moist' || field === 'cloud') ? MOIST_LV.includes(p) : true);

// ---------- 等値線（マーチングスクエア） ----------
function contours(grid, W, H, levels) {
  const segs = new Map(levels.map(l => [l, []]));
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = grid[y * W + x], b = grid[y * W + x + 1], c = grid[(y + 1) * W + x + 1], d = grid[(y + 1) * W + x];
    if (!isFinite(a + b + c + d)) continue;
    const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
    for (const L of levels) {
      if (L < lo || L > hi) continue;
      const pts = [];
      const edge = (v0, v1, x0, y0, x1, y1) => { if ((v0 < L) !== (v1 < L)) { const f = (L - v0) / (v1 - v0); pts.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]); } };
      edge(a, b, x, y, x + 1, y); edge(b, c, x + 1, y, x + 1, y + 1); edge(c, d, x + 1, y + 1, x, y + 1); edge(d, a, x, y + 1, x, y);
      for (let k = 0; k + 1 < pts.length; k += 2) segs.get(L).push([pts[k], pts[k + 1]]);
    }
  }
  return segs;
}

// ---------- 画像を描く（L＝その高さのデータ、PR＝地上の降水） ----------
function render(L, PR, field, t, PX = 60) {
  const W = NX * PX, H = NY * PX;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H), px = img.data;
  const lonOf = x => RECT.w + (x + 0.5) / W * (RECT.e - RECT.w), latOf = y => RECT.n - (y + 0.5) / H * (RECT.n - RECT.s);
  for (let y = 0; y < H; y++) {
    const la = latOf(y);
    for (let x = 0; x < W; x++) {
      const lo = lonOf(x);
      let c = null;
      if (field === 'temp') c = ramp(TEMP, sample(L.T, t, la, lo));
      else if (field === 'wind') c = ramp(WIND, sample(L.WS, t, la, lo));
      else if (field === 'moist') c = ramp(MOIST, sample(L.T, t, la, lo) - sample(L.TD, t, la, lo));
      else if (field === 'cloud') c = ramp(CLOUD, sample(L.CC, t, la, lo));
      else if (field === 'precip') c = RAIN_STEP(sample(PR, t, la, lo));
      if (!c) continue;
      const k = (y * W + x) * 4; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = c[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  // 等値線：気温＝3℃ごと、風＝等風速線 20kt ごと（60kt 以上）
  const lines = field === 'temp' ? { arr: L.T, levels: Array.from({ length: 31 }, (_, k) => -60 + 3 * k), bold: 0, color: 'rgba(30,30,30,.75)', fmt: v => `${v}` }
    : field === 'wind' ? { arr: L.WS, levels: [60, 80, 100, 120, 140, 160, 180], bold: 80, color: 'rgba(80,0,90,.8)', fmt: v => `${v}kt` } : null;
  if (lines) {
    const S = 4, gw = (NX - 1) * S + 1, gh = (NY - 1) * S + 1, g = new Float32Array(gw * gh), k = PX / 60;
    for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) g[i * gw + j] = sample(lines.arr, t, G.s + i / S * G.d, G.w + j / S * G.d);
    const toPx = ([gx, gy]) => [(gx / S + 0.5) * PX, H - (gy / S + 0.5) * PX];
    const segs = contours(g, gw, gh, lines.levels), placed = [];
    ctx.lineJoin = 'round'; ctx.font = `bold ${Math.round(30 * k)}px Meiryo, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [lvl, list] of segs) {
      if (!list.length) continue;
      ctx.strokeStyle = lvl === lines.bold ? (field === 'temp' ? 'rgba(200,0,0,.9)' : lines.color) : lines.color;
      ctx.lineWidth = (lvl === lines.bold ? 6 : 3) * k;
      ctx.beginPath();
      for (const [p0, p1] of list) { const a = toPx(p0), b = toPx(p1); ctx.moveTo(...a); ctx.lineTo(...b); }
      ctx.stroke();
      // 数値は線の途中に、互いに離して置く
      for (let n = 0; n < list.length; n += 12) {
        const [x, y] = toPx(list[n][0]);
        if (placed.some(([u, v]) => (u - x) ** 2 + (v - y) ** 2 < (250 * k) ** 2)) continue;
        placed.push([x, y]);
        ctx.lineWidth = 6 * k; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(lines.fmt(lvl), x, y);
        ctx.fillStyle = lvl === lines.bold && field === 'temp' ? '#c00' : '#222'; ctx.fillText(lines.fmt(lvl), x, y);
      }
    }
  }
  return cv;
}
const toUrl = async cv => URL.createObjectURL(await new Promise(ok => cv.toBlob(ok, 'image/png')));

// ---------- 矢羽根 ----------
const barbCache = new Map();
// 矢羽根の表示の大きさ（画面上の px。距離による縮小の前）
const BARB_PX = { s: 64, m: 96, l: 128 };
export function barbImage(kt) {
  const r = Math.round(kt / 5) * 5, key = r;
  if (barbCache.has(key)) return barbCache.get(key);
  // 高解像度で描いて、表示の大きさは billboard の width/height で決める（拡大してもにじまない）
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d'), cx = S / 2, cy = S / 2, L = 58;
  const col = r >= 100 ? '#ff5a5a' : r >= 80 ? '#ffb347' : r >= 50 ? '#ffe066' : '#ffffff';
  c.lineCap = 'round'; c.lineJoin = 'round';
  const draw = (stroke, w) => {
    c.strokeStyle = stroke; c.fillStyle = stroke; c.lineWidth = w;
    if (r < 3) { c.beginPath(); c.arc(cx, cy, 8, 0, 7); c.stroke(); return; }
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, cy - L); c.stroke();      // 軸は風上（北が上の向きで描き、回転させる）
    c.beginPath(); c.arc(cx, cy, 3.5, 0, 7); c.fill();                         // 観測点（地点の位置）
    let v = r, y = cy - L;
    while (v >= 50) { c.beginPath(); c.moveTo(cx, y); c.lineTo(cx + 25, y + 6); c.lineTo(cx, y + 14); c.closePath(); c.fill(); c.stroke(); y += 17; v -= 50; }
    while (v >= 10) { c.beginPath(); c.moveTo(cx, y); c.lineTo(cx + 26, y - 10); c.stroke(); y += 10; v -= 10; }
    if (v >= 5) { if (y === cy - L) y += 10; c.beginPath(); c.moveTo(cx, y); c.lineTo(cx + 14, y - 5.5); c.stroke(); }
  };
  draw('rgba(0,0,0,.9)', 8); draw(col, 3.6);
  barbCache.set(key, cv);
  return cv;
}

// ---------- 画面 ----------
const CSS = `
#awGpv{position:absolute;right:10px;bottom:200px;width:300px;max-height:calc(100vh - 260px);overflow:auto;z-index:30;box-shadow:0 4px 16px rgba(0,0,0,.5);
  background:rgba(20,30,45,.95);color:#fff;font:12.5px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:8px 10px;border-left:4px solid #81c784}
#awGpv[hidden]{display:none}
#awGpv h3{margin:0 0 4px;font-size:14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
#awGpv h3 button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:0 8px;cursor:pointer}
#awGpv .row{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
#awGpv .row button{font:11.5px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:2px 6px;cursor:pointer}
#awGpv .row button[aria-pressed="true"]{background:#1e5a8c;border-color:#fff}
#awGpv .row button:disabled{opacity:.4;cursor:default}
#awGpv .row .lbl{font-size:11px;color:#9fb3c8;align-self:center;margin-right:2px}
#awGpv .tm{display:flex;align-items:center;gap:6px}
#awGpv .tm input{flex:1}
#awGpv .tm button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:1px 8px;cursor:pointer;min-width:34px}
#awGpv .vt{font-size:12px;color:#cfe3f5;font-variant-numeric:tabular-nums}
#awGpv .lg{display:flex;flex-wrap:wrap;gap:2px 8px;font-size:11px;color:#cfe3f5;margin-top:4px}
#awGpv .lg i{display:inline-block;width:14px;height:10px;border:1px solid #47617d;margin-right:3px;vertical-align:-1px}
#awGpv .note,#awGpv .st{font-size:11px;color:#9fb3c8}
#awGpv .pt{font-size:12px;color:#fff;background:rgba(255,255,255,.06);border-radius:5px;padding:4px 6px;margin-top:4px;min-height:1.5em}`;

export function createGpvPanel(viewer) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const P = Object.assign(document.createElement('div'), { id: 'awGpv', hidden: true });
  P.innerHTML = `<h3 title="ドラッグで移動">GPV（気象庁GSM） <button data-x>閉じる</button></h3>
    <div class="row"><span class="lbl">表示</span><button data-m="map" aria-pressed="true" title="選んだ1つの高さを地図に重ねる">地図（1つの高さ）</button><button data-m="3d" aria-pressed="false" title="6つの高さを、それぞれの高度に板として積み重ねる">3D（全高度）</button></div>
    <div class="row" data-fields>${FIELDS.map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === 'wind'}">${l}</button>`).join('')}</div>
    <div class="row" data-levels>${LEVELS.map(([p, fl]) => `<button data-p="${p}" aria-pressed="${p === 300}" title="${fl} 付近">${p}hPa<br><small>${fl}</small></button>`).join('')}</div>
    <div class="row" data-bsz><span class="lbl">矢羽根</span>${[['s', '小'], ['m', '中'], ['l', '大']].map(([k, l]) => `<button data-b="${k}" aria-pressed="false">${l}</button>`).join('')}</div>
    <div class="tm"><button data-play aria-label="再生">▶</button><input type="range" min="0" max="${HOURS - 1}" value="0" data-t aria-label="予報時刻"></div>
    <div class="vt" data-vt>—</div>
    <div class="lg" data-lg></div><div class="note" data-note></div>
    <div class="pt" data-pt>地図の上にマウスを置くと、その地点の値を表示します。</div>
    <div class="st" data-st></div>`;
  document.body.appendChild(P);
  const $ = s => P.querySelector(s);
  const S = { barbSize: (() => { try { return localStorage.getItem('aw.gpv.barb') || 'm'; } catch { return 'm'; } })(), mode: 'map', field: 'wind', p: 300, t: 0, data: null, layer: null, barbs: null, sheets: [], labels: null, playing: false, timer: null, gen: 0, init: null };

  const say = t => { $('[data-st]').textContent = t; };
  const fmtT = dt => {
    const z = `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')} ${String(dt.getUTCHours()).padStart(2, '0')}Z`;
    const j = new Date(dt.getTime() + 9 * 3600e3);
    return `${z}（日本時間 ${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, '0')}:00）`;
  };
  const scale = () => window.awGetAltScale?.() ?? 1;
  function legend() {
    const L = LEGENDS[S.field];
    $('[data-lg]').innerHTML = L.items.map(([v, c]) => `<span><i style="background:rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.35, c[3] / 255)})"></i>${v}</span>`).join('') + `<span>${L.unit}</span>`;
    $('[data-note]').textContent = L.note + (S.mode === '3d' ? '。3D では選んだ高さを濃く、ほかを薄く表示（矢羽根は選んだ高さだけ）' : '');
    // 地図表示：降水量は高さに関係しない。湿り・雲量は 300hPa まで。3D 表示：選んだ高さ＝濃く表示する高さ
    P.querySelectorAll('[data-p]').forEach(b => { b.disabled = (S.mode === 'map' && S.field === 'precip') || !hasField(S.field, +b.dataset.p); });
  }

  // ---- 地図表示（1つの高さ） ----
  async function drawMap(gen) {
    const d = S.data, L = d.lv[S.p];
    const cv = render(L, d.PR, S.field, S.t, 24);
    // 範囲が日付変更線（180度）をまたぐので、画像を 180度で 2つに分けて別々の層にする（1枚の画像の四角は 180度をまたげない）
    const parts = [];
    if (RECT.e > 180) {
      const xs = Math.round((180 - RECT.w) / (RECT.e - RECT.w) * cv.width);
      const cut = (x0, x1) => { const c = document.createElement('canvas'); c.width = x1 - x0; c.height = cv.height; c.getContext('2d').drawImage(cv, -x0, 0); return c; };
      parts.push([cut(0, xs), Cesium.Rectangle.fromDegrees(RECT.w, RECT.s, 180, RECT.n)], [cut(xs, cv.width), Cesium.Rectangle.fromDegrees(-180, RECT.s, RECT.e - 360, RECT.n)]);
    } else parts.push([cv, cRect()]);
    const urls = await Promise.all(parts.map(([c]) => toUrl(c)));
    if (gen !== S.gen) { urls.forEach(u => URL.revokeObjectURL(u)); return; }
    const lays = parts.map(([c, rectangle], n) => {
      const prov = new Cesium.SingleTileImageryProvider({ url: urls[n], tileWidth: c.width, tileHeight: c.height, rectangle,
        credit: new Cesium.Credit('GPV：気象庁 GSM（京都大学 RISH／Open-Meteo）') });
      const lay = viewer.imageryLayers.addImageryProvider(prov);
      lay.alpha = 0.85; lay._url = urls[n];
      return lay;
    });
    lays[0]._pair = lays.slice(1);
    const old = S.layer; S.layer = lays[0];
    if (old) setTimeout(() => removeLayer(old), 250);   // 新しい画像が出てから消す（ちらつき防止）
    setBarbs(S.field === 'wind' ? [[S.p, 2000]] : [], false);
  }
  const removeLayer = l => { for (const x of [l, ...(l._pair || [])]) { viewer.imageryLayers.remove(x, true); URL.revokeObjectURL(x._url); } };

  // ---- 3D 表示（6つの高さを積み重ねる） ----
  async function draw3D(gen) {
    const d = S.data, k = scale();
    const lvls = S.field === 'precip' ? [] : LEVELS.filter(([p]) => hasField(S.field, p));
    const made = [];
    for (const [p, , ft] of lvls) {
      const cv = render(d.lv[p], d.PR, S.field, S.t, 12);
      const url = await toUrl(cv);
      if (gen !== S.gen) { URL.revokeObjectURL(url); made.forEach(m => { viewer.scene.primitives.remove(m); URL.revokeObjectURL(m._url); }); return; }
      const sel = p === S.p;
      const prim = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.RectangleGeometry({
          rectangle: cRect(), height: ft * 0.3048 * k,
          granularity: Cesium.Math.toRadians(1), vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT }) }),
        appearance: new Cesium.EllipsoidSurfaceAppearance({ aboveGround: true, translucent: true,
          material: Cesium.Material.fromType('Image', { image: url, color: new Cesium.Color(1, 1, 1, sel ? 0.95 : 0.4) }) }),
        asynchronous: false,
      });
      prim._url = url;
      made.push(viewer.scene.primitives.add(prim));
    }
    // 古い板を消し、高さの名前（板の北西の角）を付け直す
    clear3D(); S.sheets = made;
    S.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
    for (const [p, fl, ft] of LEVELS) {
      S.labels.add({ position: Cesium.Cartesian3.fromDegrees(SAT_LON0 - 25, 50, ft * 0.3048 * k),   // 高さの名前は日本の北西（範囲の角は遠すぎるため）
        text: `${p}hPa（${fl}）${hasField(S.field, p) ? '' : '　データなし'}`,
        font: p === S.p ? 'bold 15px Meiryo, sans-serif' : '13px Meiryo, sans-serif',
        fillColor: p === S.p ? Cesium.Color.fromCssColorString('#8fd0ff') : Cesium.Color.WHITE.withAlpha(0.85),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.RIGHT, pixelOffset: new Cesium.Cartesian2(-8, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    // 降水量は地上の値なので、地図に重ねる
    if (S.field === 'precip') await drawMap(gen); else if (S.layer) { removeLayer(S.layer); S.layer = null; }
    // 矢羽根は選んだ高さだけ（全部の高さに出すと重なって読めない。ほかの高さは風速の色で見る）
    if (S.field === 'wind') setBarbs(LEVELS.filter(([p]) => p === S.p).map(([p, , ft]) => [p, ft * 0.3048 * k]), true);
    else if (S.field !== 'precip') setBarbs([], true);
  }
  function clear3D() {
    S.sheets.forEach(m => { viewer.scene.primitives.remove(m); URL.revokeObjectURL(m._url); });
    S.sheets = [];
    if (S.labels) { viewer.scene.primitives.remove(S.labels); S.labels = null; }
  }

  // 矢羽根（levels：[[気圧面, 高さm], ...]）。3D では 2度ごとに間引く
  function setBarbs(levels, thin) {
    if (S.barbs) { viewer.scene.primitives.remove(S.barbs); S.barbs = null; }
    if (!levels.length) return;
    const col = new Cesium.BillboardCollection({ scene: viewer.scene });
    for (const [p, h] of levels) {
      const L = S.data.lv[p], o = S.t * N, sel = p === S.p;
      for (let i = 0; i < NY; i++) for (let j = 0; j < NX; j++) {
        if (S.data.fetched && !S.data.fetched[i * NX + j]) continue;   // 内挿で埋めた所には描かない
        if (thin && (i % 2 || j % 2)) continue;
        const k = o + i * NX + j, spd = L.WS[k], dir = L.WD[k];
        if (!isFinite(spd) || !isFinite(dir)) continue;
        col.add({ position: Cesium.Cartesian3.fromDegrees(G.w + j * G.d, G.s + i * G.d, h), image: barbImage(spd),
          width: BARB_PX[S.barbSize], height: BARB_PX[S.barbSize],
          rotation: -Cesium.Math.toRadians(dir), alignedAxis: Cesium.Cartesian3.UNIT_Z,
          color: Cesium.Color.WHITE.withAlpha(thin && !sel ? 0.55 : 1),
          // 近くでは大きく、日本全体を見るくらいでも読める大きさを保つ
          scaleByDistance: new Cesium.NearFarScalar(8e5, 1.2, 2.5e7, 0.35), disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // 地図表示で引いて見たときは 2度ごとに間引く（重なって読めないため）
          // 遠くから見るほど間引く（範囲が衛星画像の全体に広がったので、遠いほど 3度 → 6度 → 12度ごと）
          distanceDisplayCondition: (i % 8 || j % 8) ? new Cesium.DistanceDisplayCondition(0, (i % 2 || j % 2) ? 2.5e6 : (i % 4 || j % 4) ? 7e6 : 1.4e7) : undefined });
      }
    }
    S.barbs = viewer.scene.primitives.add(col);
  }

  async function draw() {
    if (!S.data) return;
    const gen = ++S.gen;
    if (S.mode === '3d') await draw3D(gen);
    else { clear3D(); await drawMap(gen); }
    const vt = S.data.times[S.t];
    $('[data-vt]').textContent = `${fmtT(vt)}　${S.t ? `${S.t}時間後` : '今'}` + (S.init ? `　／初期値 ${fmtT(new Date(S.init)).split('（')[0]}` : '');
  }
  async function load() {
    if (S.data) { await draw(); return; }
    say('6つの高さのデータを読み込んでいます…');
    try {
      S.init = await modelInit();
      let partialShown = false;
      const setT = () => { S.t = Math.min(S.t, S.data.times.length - 1); $('[data-t]').max = S.data.times.length - 1; $('[data-t]').value = S.t; };
      const full = await fetchAll((a, b) => say(`6つの高さのデータを読み込んでいます… ${a}/${b}地点` + (partialShown ? '（日本付近は表示中。周りを読み足しています）' : '')),
        sec => say(`Open-Meteo の1分あたりの回数制限のため待っています…（あと約${sec ?? 60}秒）　衛星画像の範囲を読むので、全部で数分かかります`),
        part => { partialShown = true; S.data = part; setT(); draw(); });
      S.data = full;
      S.t = Math.min(S.t, S.data.times.length - 1);
      $('[data-t]').max = S.data.times.length - 1; $('[data-t]').value = S.t;
      say(S.data.source === 'rish' ? '出典：気象庁 GSM（京都大学 生存圏研究所のアーカイブ。全球0.5度の GRIB2 を衛星画像の範囲で1.5度ごとに読み、6時間ごとの予報を時間で内挿）。教育用で、運航の判断には使えません。'
        : '出典：気象庁 GSM（Open-Meteo 経由。日本付近は1.5度ごと、それ以外は4.5度ごとに読んで内挿）。教育用で、運航の判断には使えません。');
      await draw();
    } catch (e) { say(`読み込めませんでした（${e.message}）`); console.warn('[GPV]', e); }
  }
  async function reloadIfNew() {           // 新しい GSM が出ていたら読み直す（開くたびに確認）
    const init = await modelInit();
    if (S.data && init && cache && cache.init !== init) S.data = null;
  }
  function clearAll() {
    S.gen++; pause();
    if (S.layer) { removeLayer(S.layer); S.layer = null; }
    if (S.barbs) { viewer.scene.primitives.remove(S.barbs); S.barbs = null; }
    clear3D();
  }
  function play() {
    if (S.playing || !S.data) return; S.playing = true; $('[data-play]').textContent = '❚❚';
    const step = async () => { if (!S.playing) return; S.t = (S.t + 1) % S.data.times.length; $('[data-t]').value = S.t; await draw(); S.timer = setTimeout(step, S.t === 0 ? 1500 : 800); };
    step();
  }
  function pause() { S.playing = false; clearTimeout(S.timer); $('[data-play]').textContent = '▶'; }

  P.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
    S.mode = b.dataset.m;
    P.querySelectorAll('[data-m]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (S.mode === '3d') {
      // 高さが分かるように高度を誇張し、日本を南から斜めに見る
      if (scale() === 1) await window.awSetExag?.(window.AW_EXAG > 1 ? window.AW_EXAG : 25);
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(135, 34, 0), 1500000),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-25), 4200000), duration: 1.5 });
    }
    legend(); draw();
  });
  P.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    S.field = b.dataset.f;
    P.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (!hasField(S.field, S.p)) { S.p = 300; P.querySelectorAll('[data-p]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.p === 300)); }
    legend(); draw();
  });
  P.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    S.p = +b.dataset.p;
    P.querySelectorAll('[data-p]').forEach(x => x.setAttribute('aria-pressed', x === b));
    draw();
  });
  const syncBsz = () => P.querySelectorAll('[data-b]').forEach(x => x.setAttribute('aria-pressed', x.dataset.b === S.barbSize));
  syncBsz();
  P.querySelectorAll('[data-b]').forEach(b => b.onclick = () => {
    S.barbSize = b.dataset.b; syncBsz();
    try { localStorage.setItem('aw.gpv.barb', S.barbSize); } catch { /* 保存できなくても表示は変える */ }
    draw();
  });
  $('[data-t]').oninput = e => { pause(); S.t = +e.target.value; draw(); };
  $('[data-play]').onclick = () => (S.playing ? pause() : play());
  $('[data-x]').onclick = () => api.setVisible(false);
  // 高度の倍率を変えたら 3D の板の高さを合わせ直す
  window.addEventListener('aw:altscale', () => { if (!P.hidden && S.mode === '3d') setTimeout(draw, 0); });

  // 見出しをドラッグしてパネルを動かす（他のパネルと重なったとき用）
  const h3 = $('h3');
  h3.onpointerdown = e => {
    if (e.target.closest('button')) return;
    const r = P.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    h3.setPointerCapture(e.pointerId);
    h3.onpointermove = m => {
      P.style.bottom = 'auto'; P.style.right = 'auto'; P.dataset.moved = '1';
      P.style.left = `${Math.max(0, Math.min(innerWidth - 60, m.clientX - ox))}px`;
      P.style.top = `${Math.max(0, Math.min(innerHeight - 40, m.clientY - oy))}px`;
    };
    h3.onpointerup = () => { h3.onpointermove = null; };
  };

  // 右下に置く：右下のボタン群（#camButtons）のすぐ上。上に余裕がなければボタン群の左横
  function place() {
    if (P.hidden || P.dataset.moved) return;
    const cb = document.getElementById('camButtons')?.getBoundingClientRect();
    Object.assign(P.style, { left: 'auto', top: 'auto', right: '10px', bottom: '40px', maxHeight: 'calc(100vh - 140px)' });
    if (!cb) return;
    const room = cb.top - 70;                                  // ボタン群の上に使える高さ
    if (room >= Math.min(P.scrollHeight, 420)) {
      P.style.bottom = `${innerHeight - cb.top + 8}px`;
      P.style.maxHeight = `${room}px`;
    } else {
      P.style.right = `${innerWidth - cb.left + 8}px`;
      P.style.maxHeight = `calc(100vh - 140px)`;
    }
  }
  window.addEventListener('resize', place);

  // マウスを置いた地点の値（選んでいる高さ）
  const hd = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  let lastMove = 0;
  hd.setInputAction(m => {
    if (P.hidden || !S.data || Date.now() - lastMove < 80) return;
    lastMove = Date.now();
    const c = viewer.camera.pickEllipsoid(m.endPosition, viewer.scene.globe.ellipsoid);
    const el = $('[data-pt]');
    if (!c) { el.textContent = '—'; return; }
    const g = Cesium.Cartographic.fromCartesian(c), la = Cesium.Math.toDegrees(g.latitude), lo = Cesium.Math.toDegrees(g.longitude);
    const L = S.data.lv[S.p], t = S.t, T = sample(L.T, t, la, lo);
    if (!isFinite(T)) { el.textContent = 'GPV の範囲外（東経122〜148度・北緯23〜45度）'; return; }
    const w = windAt(L, t, la, lo), TD = sample(L.TD, t, la, lo), CC = sample(L.CC, t, la, lo), PR = sample(S.data.PR, t, la, lo);
    const fl = LEVELS.find(([p]) => p === S.p)?.[1] || '';
    el.innerHTML = `北緯${la.toFixed(1)}° 東経${lo.toFixed(1)}°　<b>${S.p}hPa（${fl}付近）</b><br>` +
      `風 ${w ? `${String(Math.round(w.dir / 10) * 10).padStart(3, '0')}°/${Math.round(w.spd)}kt` : '—'}　気温 ${T.toFixed(0)}℃` +
      (isFinite(TD) ? `　湿数 ${(T - TD).toFixed(0)}℃` : '') + (isFinite(CC) ? `　雲量 ${Math.round(CC)}%` : '') +
      `<br>地上の降水 ${isFinite(PR) ? PR.toFixed(1) : '—'}mm/h` + (S.mode === '3d' ? '<br><span style="color:#9fb3c8">（3D では地表の位置の値。高さはボタンで選ぶ）</span>' : '');
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  const api = {
    get on() { return !P.hidden; },
    async setVisible(on) {
      P.hidden = !on;
      window.dispatchEvent(new CustomEvent('aw:gpv', { detail: on }));
      if (on) { legend(); place(); await reloadIfNew(); await load(); place(); } else clearAll();
    },
  };
  return api;
}
