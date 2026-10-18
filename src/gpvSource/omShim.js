// Open-Meteo の問い合わせを、京都大学 RISH の気象庁 GSM で答える（2026-10-18）
//   アプリの各所（GPV・解析3D・断面図・天気図ガイド・経路アドバイスなど）は Open-Meteo の書式
//   （https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&hourly=…）で問い合わせている。
//   installGpvRouter() で fetch を包み、その URL を RISH の GSM（rishGsm.js）で計算した同じ形の JSON で返す。
//   RISH を読めないとき（中継が無い・止まっている・時刻が範囲の外）は、これまでどおり Open-Meteo に問い合わせる
//   ・データ源の切り替え：localStorage 'aw.gpvSource'＝'rish'（既定）／'openmeteo'
//   ・対応する変数：気圧面（1000〜10hPa）の temperature・relative_humidity（300hPa まで）・dew_point・wind_speed・
//     wind_direction・geopotential_height・vertical_velocity・cloud_cover（相対湿度から推定）、
//     地上の pressure_msl・surface_pressure・temperature_2m・relative_humidity_2m・dew_point_2m・wind_speed_10m・
//     wind_direction_10m・cloud_cover（_low/_mid/_high）・precipitation（6 時間の降水量を 1 時間あたりに直す）
//   ・models=jma_seamless（MSM と GSM の組み合わせ）も GSM で答える
import { gsmValues, listRuns, rishBase } from './rishGsm.js';

const H = 3600e3;
const OM_FORECAST = /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/;
const OM_META = /^https:\/\/api\.open-meteo\.com\/data\/jma_(gsm|msm|seamless)\/static\/meta\.json/;
export const gpvSource = () => { try { return localStorage.getItem('aw.gpvSource') || 'rish'; } catch { return 'rish'; } };
export function setGpvSource(s) { try { localStorage.setItem('aw.gpvSource', s); } catch { /* なし */ } }
let lastUsed = null;   // 'rish' | 'openmeteo'
export const gpvLastUsed = () => lastUsed;

const iso = t => new Date(t).toISOString().slice(0, 16);
const parseIso = s => Date.parse(/Z$/.test(s) ? s : s + 'Z');
const dewPoint = (T, rh) => {               // ℃、%
  if (!(rh > 0)) return NaN;
  const a = 17.62, b = 243.12, g = Math.log(rh / 100) + a * T / (b + T);
  return b * g / (a - g);
};
// 気圧面の雲量（％）：相対湿度から（Sundqvist の式。臨界湿度は下層 85％・上層 70％）
const cloudFromRh = (rh, p) => {
  const c = p >= 700 ? 0.85 : p >= 400 ? 0.78 : 0.7, r = Math.min(1, rh / 100);
  return r <= c ? 0 : 100 * (1 - Math.sqrt((1 - r) / (1 - c)));
};
const SPEED = { kn: 1.943844, ms: 1, kmh: 3.6, mph: 2.236936 };

/** 変数名 → 必要な GSM の要素と、値の計算 */
function plan(name) {
  let m = name.match(/^(temperature|relative_humidity|dew_point|wind_speed|wind_direction|geopotential_height|vertical_velocity|cloud_cover)_(\d+)hPa$/);
  if (m) {
    const p = +m[2], v = m[1];
    const need = { temperature: [['T', p]], relative_humidity: [['RH', p]], dew_point: [['T', p], ['RH', p]], wind_speed: [['U', p], ['V', p]],
      wind_direction: [['U', p], ['V', p]], geopotential_height: [['Z', p]], vertical_velocity: [['W', p]], cloud_cover: [['RH', p]] }[v];
    const calc = {
      temperature: g => g('T', p) - 273.15,
      relative_humidity: g => g('RH', p),
      dew_point: g => dewPoint(g('T', p) - 273.15, g('RH', p)),
      wind_speed: (g, u) => Math.hypot(g('U', p), g('V', p)) * u,
      wind_direction: g => (Math.atan2(-g('U', p), -g('V', p)) * 180 / Math.PI + 360) % 360,
      geopotential_height: g => g('Z', p),
      vertical_velocity: g => g('W', p),
      cloud_cover: g => cloudFromRh(g('RH', p), p),
    }[v];
    return { need, calc };
  }
  const S = {
    pressure_msl: [[['PMSL']], g => g('PMSL') / 100],
    surface_pressure: [[['PS']], g => g('PS') / 100],
    temperature_2m: [[['T2']], g => g('T2') - 273.15],
    relative_humidity_2m: [[['RH2']], g => g('RH2')],
    dew_point_2m: [[['T2'], ['RH2']], g => dewPoint(g('T2') - 273.15, g('RH2'))],
    wind_speed_10m: [[['U10'], ['V10']], (g, u) => Math.hypot(g('U10'), g('V10')) * u],
    wind_direction_10m: [[['U10'], ['V10']], g => (Math.atan2(-g('U10'), -g('V10')) * 180 / Math.PI + 360) % 360],
    cloud_cover: [[['CC']], g => g('CC')],
    cloud_cover_low: [[['CCL']], g => g('CCL')],
    cloud_cover_mid: [[['CCM']], g => g('CCM')],
    cloud_cover_high: [[['CCH']], g => g('CCH')],
    precipitation: [[['PR']], g => { const x = g('PR'); return Number.isFinite(x) ? x / 6 : 0; }],
  }[name];
  return S ? { need: S[0].map(([k]) => [k, null]), calc: S[1] } : null;
}

/** URL の時刻の指定 → 1 時間ごとの時刻の並び（ms） */
function timesOf(q, now = Date.now()) {
  const hour0 = Math.floor(now / H) * H;
  if (q.get('start_hour') && q.get('end_hour')) {
    const a = parseIso(q.get('start_hour')), b = parseIso(q.get('end_hour'));
    const out = []; for (let t = a; t <= b && out.length < 400; t += H) out.push(t); return out;
  }
  if (q.get('forecast_hours')) return Array.from({ length: Math.min(400, +q.get('forecast_hours')) }, (_, i) => hour0 + i * H);
  const day0 = Math.floor(now / (24 * H)) * 24 * H;
  const past = +(q.get('past_days') || 0), fdays = +(q.get('forecast_days') || 7);
  const out = []; for (let t = day0 - past * 24 * H; t < day0 + fdays * 24 * H; t += H) out.push(t); return out;
}

async function answerForecast(url) {
  const q = new URL(url).searchParams;
  const lats = (q.get('latitude') || '').split(',').map(Number), lons = (q.get('longitude') || '').split(',').map(Number);
  if (!lats.length || lats.length !== lons.length || lats.some(x => !Number.isFinite(x))) throw new Error('地点が読めません');
  const pts = lats.map((la, i) => [la, lons[i]]);
  const unit = SPEED[q.get('wind_speed_unit') || 'kmh'] ?? 3.6;
  const isCurrent = !!q.get('current');
  const names = (q.get(isCurrent ? 'current' : 'hourly') || '').split(',').filter(Boolean);
  const plans = names.map(n => [n, plan(n)]);
  const need = []; const seen = new Set();
  for (const [, p] of plans) for (const [k, lv] of p?.need || []) { const key = `${k}|${lv ?? ''}`; if (!seen.has(key)) { seen.add(key); need.push([k, lv]); } }
  const now = Date.now();
  const times = isCurrent ? [Math.floor(now / 900e3) * 900e3] : timesOf(q, now);
  const { values } = await gsmValues(need, pts, times);
  // 求める時刻がまったく範囲に入らないときは Open-Meteo に任せる
  const any = need.length ? values.values().next().value.some(Number.isFinite) : true;
  if (!any) throw new Error('RISH の予報の範囲の外です');
  const NP = pts.length;
  const out = pts.map(([la, lo], n) => {
    const g0 = ti => (k, lv) => values.get(`${k}|${lv ?? ''}`)?.[ti * NP + n];
    const series = {};
    for (const [name, p] of plans) {
      series[name] = times.map((_, ti) => {
        if (!p) return null;
        const v = p.calc(g0(ti), unit);
        return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
      });
    }
    const base = { latitude: la, longitude: lo, generationtime_ms: 0, utc_offset_seconds: 0, timezone: 'GMT', timezone_abbreviation: 'GMT', elevation: 0, source: 'RISH GSM' };
    if (isCurrent) return { ...base, current: { time: iso(times[0]), interval: 900, ...Object.fromEntries(names.map(nm => [nm, series[nm][0]])) } };
    return { ...base, hourly: { time: times.map(iso), ...series } };
  });
  return out.length === 1 ? out[0] : out;
}

/**
 * Open-Meteo の変数名で、地点×時刻の値を直接もらう（JSON を作らない。広い格子を読むとき用）
 * @returns { init, data: Map(変数名 → Float32Array(times.length × pts.length)、無い所は NaN) }
 */
export async function rishGrid(names, pts, times, { wind = 'kn' } = {}) {
  const unit = SPEED[wind] ?? 1.943844;
  const plans = names.map(n => [n, plan(n)]);
  const need = [], seen = new Set();
  for (const [, p] of plans) for (const [k, lv] of p?.need || []) { const key = `${k}|${lv ?? ''}`; if (!seen.has(key)) { seen.add(key); need.push([k, lv]); } }
  const { init, values } = await gsmValues(need, pts, times);
  const NP = pts.length, NT = times.length, data = new Map();
  for (const [name, p] of plans) {
    const out = new Float32Array(NT * NP).fill(NaN);
    if (p) for (let k = 0; k < NT * NP; k++) {
      const v = p.calc((key, lv) => values.get(`${key}|${lv ?? ''}`)?.[k], unit);
      if (Number.isFinite(v)) out[k] = v;
    }
    data.set(name, out);
  }
  return { init, data };
}

async function answerMeta() {
  const run = (await listRuns())[0];
  return { last_run_initialisation_time: run.init / 1000, last_run_modification_time: run.init / 1000 + 6 * 3600, last_run_availability_time: run.init / 1000 + 6 * 3600, temporal_resolution_seconds: 6 * 3600, source: 'RISH GSM' };
}

const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', 'X-AW-Source': 'rish' } });

/** fetch を包んで、Open-Meteo の問い合わせを RISH で答える */
export function installGpvRouter() {
  if (window.__awGpvRouter) return;
  const orig = window.fetch.bind(window);
  window.__awGpvRouter = orig;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (gpvSource() === 'rish' && rishBase() && (OM_FORECAST.test(url) || OM_META.test(url))) {
      try {
        const r = json(OM_META.test(url) ? await answerMeta() : await answerForecast(url));
        lastUsed = 'rish';
        window.dispatchEvent(new CustomEvent('aw:gpvsrc', { detail: { state: 'used', source: 'rish' } }));
        return r;
      } catch (e) {
        console.warn('[RISH GSM] Open-Meteo に切り替え：', e.message || e);
      }
    }
    if (OM_FORECAST.test(url)) { lastUsed = 'openmeteo'; window.dispatchEvent(new CustomEvent('aw:gpvsrc', { detail: { state: 'used', source: 'openmeteo' } })); }
    return orig(input, init);
  };
}
