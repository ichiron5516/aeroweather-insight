// ひまわり赤外画像（雲頂の輝度温度）と数値予報の気温分布から雲頂高度を推定し、
// レーダーの強いエコーと重ねて「発達した積乱雲」を見つける（取得部分）。計算は cbCore.js
import { tbbFromGray, topFromTbb, coarseGrid, detectCb, PROFILE_LEVELS } from './cbCore.js';

const SAT = 'https://www.jma.go.jp/bosai/himawari/data/satimg';
const OM = 'https://api.open-meteo.com/v1/forecast';
const loadImg = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ng; im.src = src; });

/** 最新の日本域ひまわり赤外（B13）。ズーム6（約2km/画素）まであり、約2.5分ごとに更新 */
export async function latestIrTime() {
  const L = await (await fetch(`${SAT}/targetTimes_jp.json`, { cache: 'no-store' })).json();
  return L.at(-1);
}

/** タイルを貼り合わせた明るさ（0〜255）。範囲外（真っ白 255）や取得できないタイルは -1 */
async function grayMosaic(area, t, z, tx0, ty0, nx, ny, want = null) {
  const W = nx * 256, H = ny * 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const got = new Uint8Array(nx * ny);
  await Promise.all(Array.from({ length: nx * ny }, (_, n) => {
    const i = n % nx, j = (n / nx) | 0;
    if (want && !want(tx0 + i, ty0 + j)) return null;     // 画像のない所のタイルは取りに行かない
    return loadImg(`${SAT}/${t.basetime}/${area}/${t.validtime}/B13/TBB/${z}/${tx0 + i}/${ty0 + j}.jpg`)
      .then(im => { ctx.drawImage(im, i * 256, j * 256); got[n] = 1; }).catch(() => null);
  }));
  const px = ctx.getImageData(0, 0, W, H).data, g = new Int16Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!got[((y / 256) | 0) * nx + ((x / 256) | 0)]) continue;
    const k = y * W + x, v = px[k * 4];
    // 日本域画像の範囲外は真っ白（255）で塗られている。実際の雲は 250 程度まで
    g[k] = v >= 253 && px[k * 4 + 1] >= 253 && px[k * 4 + 2] >= 253 ? -1 : v;
  }
  return { W, H, g };
}

/**
 * レーダーのラスタと同じタイル範囲で、雲頂輝度温度（℃）のラスタを作る
 *   日本域（ズーム6・約2.5分ごと）を使い、その範囲外は全球画像（ズーム5）で補う
 * @param r { W, H, z, x0, y0 }（x0, y0 は世界座標の画素。256 の倍数）
 */
export async function irRasterLike(r, t, { jpBox = null } = {}) {
  t ||= await latestIrTime();
  const tx0 = r.x0 / 256, ty0 = r.y0 / 256, nx = r.W / 256, ny = r.H / 256;
  // jpBox：日本域画像のある範囲（経緯度）。指定したときは、その範囲にかかるタイルだけ日本域画像を取る（広い範囲用）
  const n2 = 2 ** r.z, tlon = x => x / n2 * 360 - 180, tlat = y => 180 / Math.PI * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / n2));
  const want = jpBox ? (x, y) => tlon(x + 1) > jpBox.w && tlon(x) < jpBox.e && tlat(y) > jpBox.s && tlat(y + 1) < jpBox.n : null;
  const jp = await grayMosaic('jp', t, r.z, tx0, ty0, nx, ny, want);
  const tbb = new Float32Array(r.W * r.H).fill(NaN);
  let missing = 0;
  for (let k = 0; k < tbb.length; k++) { if (jp.g[k] >= 0) tbb[k] = tbbFromGray(jp.g[k]); else missing++; }
  if (missing) {
    try {
      const L = await (await fetch(`${SAT}/targetTimes_fd.json`, { cache: 'no-store' })).json();
      const tf = L.at(-1), z5 = r.z - 1;
      const fx0 = Math.floor(tx0 / 2), fy0 = Math.floor(ty0 / 2), fx1 = Math.floor((tx0 + nx - 1) / 2), fy1 = Math.floor((ty0 + ny - 1) / 2);
      const fd = await grayMosaic('fd', tf, z5, fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1);
      for (let y = 0; y < r.H; y++) for (let x = 0; x < r.W; x++) {
        const k = y * r.W + x; if (isFinite(tbb[k])) continue;
        const gx = ((r.x0 + x) >> 1) - fx0 * 256, gy = ((r.y0 + y) >> 1) - fy0 * 256;
        const v = fd.g[gy * fd.W + gx]; if (v >= 0) tbb[k] = tbbFromGray(v);
      }
    } catch (e) { console.warn('[cloud top] fd', e); }
  }
  if (!tbb.some(isFinite)) throw new Error('ひまわり赤外画像を取得できません');
  return { W: r.W, H: r.H, tbb, time: t.validtime };
}

// ---- 気温の鉛直分布 ----
//   Open-Meteo は1時間あたりの利用回数に上限がある（超えると 429）。
//   同じ地点・同じ時間帯（1時間）の分布は、メモリとブラウザ保存領域に取っておいて使い回す。
//   取得できないときは「標準大気を緯度でずらした分布」で代用し、profileSource で分かるようにする。
// 気温の分布はゆっくり変わるので3時間使い回す（2026-10-17：1時間 → 3時間。アジア全域の雲頂3Dで問い合わせが増え、
//   Open-Meteo の1日の上限（約1万地点）を超えたため）
const TTL = 3 * 60 * 60 * 1000, LS = 'awProf1';
const mem = new Map();
let store = {};
try { store = JSON.parse(localStorage.getItem(LS) || '{}'); } catch { store = {}; }
const keyOf = p => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
const fresh = e => e && Date.now() - e.at < TTL;
export const profileSource = { model: 0, fallback: 0 };

/** 標準大気をもとにした目安の分布（秋の日本付近。地上気温と圏界面の高さを緯度で変える） */
export function standardProfile(lat) {
  const a = Math.abs(lat), t0 = 28 - 0.55 * Math.max(0, a - 20), ht = 17 - 0.18 * Math.max(0, a - 20);   // ℃・km
  return PROFILE_LEVELS.map(p => {
    const h = 44.3308 * (1 - (p / 1013.25) ** 0.190263);                                                 // km
    return { p, t: Math.round((t0 - 6.0 * Math.min(h, ht)) * 10) / 10 };
  });
}

/** 地点ごとの気温の鉛直分布（気象庁 MSM/GSM・Open-Meteo 経由。1時間は使い回し） */
export async function fetchProfiles(points) {
  if (!points.length) return [];
  const out = new Array(points.length), need = [];
  points.forEach((p, i) => {
    const k = keyOf(p), e = mem.get(k) || store[k];
    if (fresh(e)) out[i] = e.v; else need.push(i);
  });
  if (need.length) {
    const vars = PROFILE_LEVELS.map(p => `temperature_${p}hPa`).join(',');
    let failed = false;
    for (let s = 0; s < need.length && !failed; s += 50) {
      const b = need.slice(s, s + 50).map(i => points[i]);
      try {
        const url = `${OM}?latitude=${b.map(p => p.lat.toFixed(2)).join(',')}&longitude=${b.map(p => p.lon.toFixed(2)).join(',')}&current=${vars}&models=jma_seamless`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        const j = await res.json();
        (Array.isArray(j) ? j : [j]).forEach((r, n) => {
          const v = PROFILE_LEVELS.map(p => ({ p, t: r.current?.[`temperature_${p}hPa`] ?? null }));
          const i = need[s + n]; out[i] = v;
          const e = { at: Date.now(), v }; mem.set(keyOf(points[i]), e); store[keyOf(points[i])] = e;
        });
      } catch (e) { failed = true; console.warn('[profiles] Open-Meteo', e.message); }
    }
    try {                                                    // 古いものを捨てて保存
      for (const k of Object.keys(store)) if (!fresh(store[k])) delete store[k];
      localStorage.setItem(LS, JSON.stringify(store));
    } catch { /* 保存できなくても続ける */ }
  }
  let fb = 0;
  points.forEach((p, i) => { if (out[i]) profileSource.model++; else { out[i] = standardProfile(p.lat); profileSource.fallback++; fb++; } });
  out.fallback = fb;                                         // 標準大気で代用した地点の数
  return out;
}

/**
 * 降水ラスタ（mm/h）から、雲頂の情報と発達した積乱雲を求める
 * @param rainR { W, H, rain, z, x0, y0 }（タイル境界にそろったラスタ）
 * @param extraPoints 雲頂を求めたい追加の地点 [{ lat, lon, tbb }]（雨域ごと など）
 */
export async function analyzeCloudTops(rainR, extraPoints = []) {
  const ir = await irRasterLike(rainR);
  const g = coarseGrid(rainR, ir, 4);
  const cbs = detectCb(g);
  const extra = typeof extraPoints === 'function' ? extraPoints(g) : extraPoints;
  const pts = [...cbs.map(c => ({ lat: c.lat, lon: c.lon, tbb: c.tbb })), ...extra];
  const profs = await fetchProfiles(pts);
  pts.forEach((p, i) => { p.top = isFinite(p.tbb) ? topFromTbb(profs[i], p.tbb) : null; });
  cbs.forEach((c, i) => { c.top = pts[i].top; });
  return { grid: g, cbs, extra: pts.slice(cbs.length), irTime: ir.time, profFallback: profs.fallback || 0 };
}

/** 気象庁ナウキャストのラスタ（advisor の fetchRadar 形式：x0, y0 がタイル番号）を共通形式に */
export const fromAdvisorRadar = r => ({ W: r.W, H: r.H, rain: r.rain, z: r.zoom, x0: r.x0 * 256, y0: r.y0 * 256 });
