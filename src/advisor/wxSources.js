// リアルタイム気象の取得
//   ・高層風格子: Open-Meteo（気象庁 MSM/GSM = jma_seamless）… 気圧面の風・ジオポテンシャル高度
//   ・レーダー:   気象庁 高解像度降水ナウキャスト（タイル画像の色から降水強度 mm/h を読む）
//   ・SIGMET:     NOAA Aviation Weather Center の国際SIGMET（福岡FIR = RJJJ）
//   ・衛星/天気図: 気象庁（表示用）

export const LEVELS = [700, 600, 500, 400, 300, 250, 200];   // hPa（およそ FL100 / 140 / 180 / 240 / 300 / 340 / 390）
const OM = 'https://api.open-meteo.com/v1/forecast';
const JMA_NOWC = 'https://www.jma.go.jp/bosai/jmatile/data/nowc';
const JMA_SAT = 'https://www.jma.go.jp/bosai/himawari/data/satimg';
import { awcFetch } from '../wxPanels/awc.js';

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
}

// ---------------- 高層風格子 ----------------
/** bbox {s,n,w,e}・格子間隔 step(度)・取得時間数 hours */
export async function fetchUpperGrid(bbox, { step = 1, hours = 12, chunk = 90, parallel = 4 } = {}) {
  const lats = [], lons = [];
  for (let la = Math.floor(bbox.s); la <= Math.ceil(bbox.n) + 1e-9; la += step) lats.push(+la.toFixed(3));
  for (let lo = Math.floor(bbox.w); lo <= Math.ceil(bbox.e) + 1e-9; lo += step) lons.push(+lo.toFixed(3));
  const pts = lats.flatMap((la, i) => lons.map((lo, j) => ({ la, lo, i, j })));
  const vars = LEVELS.flatMap(p => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]);
  const blocks = [];
  for (let s = 0; s < pts.length; s += chunk) blocks.push(pts.slice(s, s + chunk));
  const results = new Array(blocks.length);
  let next = 0;
  async function worker() {
    while (next < blocks.length) {
      const b = next++, blk = blocks[b];
      const url = `${OM}?latitude=${blk.map(p => p.la).join(',')}&longitude=${blk.map(p => p.lo).join(',')}` +
        `&hourly=${vars.join(',')}&models=jma_seamless&wind_speed_unit=ms&timezone=GMT&forecast_hours=${hours}`;
      const j = await getJSON(url);
      results[b] = Array.isArray(j) ? j : [j];
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  const flat = results.flat();
  const times = flat[0].hourly.time;
  const mk = () => times.map(() => LEVELS.map(() => lats.map(() => lons.map(() => 0))));
  const spd = mk(), dir = mk(), z = mk();
  pts.forEach((p, n) => {
    const h = flat[n].hourly;
    times.forEach((_, t) => LEVELS.forEach((lev, k) => {
      spd[t][k][p.i][p.j] = h[`wind_speed_${lev}hPa`][t] ?? 0;
      dir[t][k][p.i][p.j] = h[`wind_direction_${lev}hPa`][t] ?? 0;
      z[t][k][p.i][p.j] = h[`geopotential_height_${lev}hPa`][t] ?? (44331 * (1 - (lev / 1013.25) ** 0.1903));
    }));
  });
  return { lats, lons, levels: LEVELS, times: times.map(s => s.endsWith('Z') ? s : s + 'Z'), spd, dir, z, source: 'Open-Meteo（気象庁 MSM/GSM）' };
}

// ---------------- レーダー（降水ナウキャスト） ----------------
// 気象庁の降水強度の配色（mm/h）。タイルの色を最も近い配色に当てはめる
const RAIN_COLORS = [
  [[242, 242, 255], 0.5], [[160, 210, 255], 3], [[33, 140, 255], 7.5], [[0, 65, 255], 15],
  [[250, 245, 0], 25], [[255, 153, 0], 40], [[255, 40, 0], 65], [[180, 0, 104], 90],
];
export function rainFromRGB(r, g, b, a) {
  if (a < 40) return 0;
  let best = 0, bd = 1e9;
  for (const [c, v] of RAIN_COLORS) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return bd < 2500 ? best : 0;
}
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;

function loadImg(url) {
  return new Promise((ok, ng) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => ok(im); im.onerror = () => ng(new Error('tile ' + url)); im.src = url;
  });
}

/** 最新のレーダー時刻と、bbox を覆う降水強度ラスタ（mm/h）を返す */
export async function fetchRadar(bbox, { zoom = 6 } = {}) {
  const times = await getJSON(`${JMA_NOWC}/targetTimes_N1.json`);
  const obs = times.filter(t => t.basetime === t.validtime && (t.elements || ['hrpns']).includes('hrpns'))
    .sort((a, b) => (a.basetime < b.basetime ? 1 : -1))[0] || times[0];
  const tmpl = `${JMA_NOWC}/${obs.basetime}/none/${obs.validtime}/surf/hrpns/{z}/{x}/{y}.png`;
  const x0 = Math.floor(lon2x(bbox.w, zoom)), x1 = Math.floor(lon2x(bbox.e, zoom));
  const y0 = Math.floor(lat2y(bbox.n, zoom)), y1 = Math.floor(lat2y(bbox.s, zoom));
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const url = tmpl.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
    jobs.push(loadImg(url).then(im => ctx.drawImage(im, (x - x0) * 256, (y - y0) * 256)).catch(() => null));
  }
  await Promise.all(jobs);
  const px = ctx.getImageData(0, 0, W, H).data;
  const rain = new Float32Array(W * H);
  for (let n = 0; n < W * H; n++) rain[n] = rainFromRGB(px[n * 4], px[n * 4 + 1], px[n * 4 + 2], px[n * 4 + 3]);
  return { zoom, x0, y0, W, H, rain, time: obs.validtime, tileUrl: tmpl, source: '気象庁 降水ナウキャスト' };
}

/** 地点の周囲 radiusNM の最大降水強度 */
export function radarMaxNear(radar, lat, lon, radiusNM = 10) {
  if (!radar) return 0;
  const px = (lon2x(lon, radar.zoom) - radar.x0) * 256, py = (lat2y(lat, radar.zoom) - radar.y0) * 256;
  const nmPerPx = (360 / (2 ** radar.zoom * 256)) * 60 * Math.cos(lat * Math.PI / 180);
  const r = Math.max(1, Math.round(radiusNM / nmPerPx));
  let mx = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const x = Math.round(px + dx), y = Math.round(py + dy);
    if (x < 0 || y < 0 || x >= radar.W || y >= radar.H) continue;
    const v = radar.rain[y * radar.W + x]; if (v > mx) mx = v;
  }
  return mx;
}

// ---------------- SIGMET ----------------
const num = v => (v == null || v === '' ? null : +v);
/** 福岡FIR（RJJJ）と bbox に掛かる国際SIGMET */
export async function fetchSigmets(bbox) {
  const raw = await awcFetch('isigmet?format=json', 'json');
  const list = Array.isArray(raw) ? raw : (raw.features || raw.data || []);
  const out = [];
  for (const s0 of list) {
    const s = s0.properties ? { ...s0.properties, coords: s0.geometry?.coordinates?.[0]?.map(([lon, lat]) => ({ lat, lon })) } : s0;
    const coords = (s.coords || []).map(c => ({ lat: +c.lat, lon: +c.lon })).filter(c => isFinite(c.lat) && isFinite(c.lon));
    if (coords.length < 3) continue;
    const inBox = coords.some(c => c.lat >= bbox.s - 3 && c.lat <= bbox.n + 3 && c.lon >= bbox.w - 3 && c.lon <= bbox.e + 3);
    const fir = String(s.firId || s.icaoId || '');
    if (!inBox && !/RJJJ|RJTD/.test(fir)) continue;
    const hazard = String(s.hazard || '').toUpperCase();
    out.push({
      id: s.seriesId || s.isigmetId || `${fir}-${s.validTimeFrom}`,
      fir, hazard, qualifier: String(s.qualifier || '').toUpperCase(),
      baseFt: num(s.base) ?? 0, topFt: num(s.top) ?? 60000, topKnown: num(s.top) != null, baseKnown: num(s.base) != null,
      from: num(s.validTimeFrom) ? new Date(num(s.validTimeFrom) * 1000) : null,
      to: num(s.validTimeTo) ? new Date(num(s.validTimeTo) * 1000) : null,
      coords, raw: s.rawSigmet || '',
    });
  }
  return { list: out, source: 'NOAA Aviation Weather Center（国際SIGMET）' };
}

export function pointInPoly(lat, lon, coords) {
  let c = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const a = coords[i], b = coords[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}

// ---------------- 表示用（衛星・天気図） ----------------
export async function latestHimawari(band = 'B13/TBB') {
  const times = await getJSON(`${JMA_SAT}/targetTimes_fd.json`);
  const t = times[times.length - 1];
  return { url: `${JMA_SAT}/${t.basetime}/fd/${t.validtime}/${band}/{z}/{x}/{y}.jpg`, time: t.validtime };
}
export async function latestWeatherMaps() {
  const j = await getJSON('https://www.jma.go.jp/bosai/weather_map/data/list.json');
  const pick = arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
  const near = j.near || j;
  const now = pick(near.now), ft24 = pick(near.ft24), ft48 = pick(near.ft48);
  const u = f => (f ? `https://www.jma.go.jp/bosai/weather_map/data/png/${f}` : null);
  return { now: u(now), ft24: u(ft24), ft48: u(ft48) };
}
export const FBJP_URL = 'https://www.data.jma.go.jp/airinfo/data/pict/fbjp/fbjp.png';

/** 時刻の書式 20261003123000 → 10/03 1230UTC */
export const fmtJmaTime = s => (s && s.length >= 12 ? `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 12)}UTC` : s || '');
