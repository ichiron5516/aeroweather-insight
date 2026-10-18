// 断面図（AXJP130/140、FXJP106/112）の「今の状況」の自動解析
//   図と同じ線（地点の並び）に沿って、気象庁 MSM/GSM の気圧面の値（Open-Meteo 経由）を取り、
//   ジェット気流・鉛直シア（CAT の目安）・湿った層（雲）と着氷・0℃高度・圏界面を文章にする。
//   図そのものを読み取ったものではないので、図と見比べて使う。
import { sectionLine } from './crossSection3D.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const LV = [925, 850, 700, 600, 500, 400, 300, 250, 200, 150];
const VARS = ['wind_speed', 'wind_direction', 'temperature', 'relative_humidity', 'geopotential_height'];
const cache = new Map();

/** 地点の間を約 step km ごとに分けた点（各点は近くの地点名を持つ） */
function densifyLine(st, stepKm = 120) {
  const out = [];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    const d = Math.hypot((b.lat - a.lat) * 111, (b.lon - a.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
    const n = Math.max(1, Math.round(d / stepKm));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      out.push({ lat: +(a.lat + (b.lat - a.lat) * f).toFixed(2), lon: +(a.lon + (b.lon - a.lon) * f).toFixed(2),
        place: f < 0.25 ? a.name : f > 0.75 ? b.name : `${a.name}〜${b.name}` });
    }
  }
  const z = st.at(-1); out.push({ lat: z.lat, lon: z.lon, place: z.name });
  return out;
}

const hh = t => new Date(t).toISOString().slice(0, 13) + ':00';
/** 線上の各点・各時刻の気圧面の値 */
async function fetchLine(pts, hours) {
  const key = pts.map(p => `${p.lat},${p.lon}`).join(';') + '|' + hours.join(',');
  const c = cache.get(key); if (c && Date.now() - c.at < 10 * 60e3) return c.data;
  const vars = LV.flatMap(l => VARS.map(v => `${v}_${l}hPa`));
  const u = `${OM}?latitude=${pts.map(p => p.lat).join(',')}&longitude=${pts.map(p => p.lon).join(',')}&hourly=${vars.join(',')}` +
    `&models=jma_seamless&wind_speed_unit=kn&timezone=GMT&start_hour=${hh(Math.min(...hours))}&end_hour=${hh(Math.max(...hours))}`;   // 使う時刻の間だけ（2026-10-18。RISH の GSM でも重くならないように）
  const r = await fetch(u); if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json(), arr = Array.isArray(j) ? j : [j];
  const times = arr[0].hourly.time;
  const data = hours.map(h => {
    const iso = h.toISOString().slice(0, 13) + ':00', t = times.indexOf(iso);
    if (t < 0) return null;
    return pts.map((p, n) => LV.map(l => {
      const H = arr[n].hourly, g = k => H[`${k}_${l}hPa`]?.[t];
      return { p: l, spd: g('wind_speed'), dir: g('wind_direction'), T: g('temperature'), rh: g('relative_humidity'), z: g('geopotential_height') };
    }));
  });
  cache.set(key, { at: Date.now(), data });
  return data;
}

const fl = zm => Math.round(zm / 0.3048 / 1000) * 10;            // 高度（m）→ FL（10単位）
const FLs = v => `FL${String(v).padStart(3, '0')}`;
const dewDep = (T, rh) => {                                       // 湿数（気温−露点）
  if (T == null || !rh) return null;
  const a = 17.62, b = 243.12, g = Math.log(rh / 100) + a * T / (b + T);
  return T - b * g / (a - g);
};
const uv = x => [-x.spd * Math.sin(x.dir * Math.PI / 180), -x.spd * Math.cos(x.dir * Math.PI / 180)];

/** 1時刻ぶんの断面の解析文 */
// 図ごとの線の呼び方
const HINT = {
  fxjp: { jet: '図の等風速線（細い破線）', shear: '図の太い破線（WIND SHEAR）と比べる。', wet: '図のスカラップ線', temp: '図の細い実線（気温）', trop: '図の ☆ 印の線' },
  axjp: { jet: '図の等風速線（太い破線、20ktごと）', shear: '図では等風速線が上下に込み合う所。', wet: '図の各地点の T−Td の値', temp: '図の等温線（細い実線、5℃ごと）', trop: '図の圏界面の記号' },
};
function describe(pts, prof, kind) {
  const H = HINT[kind];
  const out = [];
  // ジェット気流（400hPa より上の最大風速）
  let jet = null;
  prof.forEach((col, i) => col.forEach(x => { if (x.p <= 400 && x.spd != null && x.z != null && (!jet || x.spd > jet.spd)) jet = { ...x, i }; }));
  if (jet) out.push(jet.spd >= 80
    ? `ジェット気流：最大 ${Math.round(jet.spd)}kt（${pts[jet.i].place}、${jet.p}hPa＝${FLs(fl(jet.z))}付近）。${H.jet}の中心と比べる。`
    : `強いジェット気流はない（最大 ${Math.round(jet.spd)}kt、${pts[jet.i].place}・${FLs(fl(jet.z))}付近）。`);
  // 鉛直シア（隣り合う気圧面の風の差 ÷ 高度差）。6kt/1000ft 以上は並以上の CAT の目安
  const sh = [];
  prof.forEach((col, i) => {
    for (let k = 0; k < col.length - 1; k++) {
      const a = col[k], b = col[k + 1];
      if ([a.spd, b.spd, a.dir, b.dir, a.z, b.z].some(v => v == null) || b.z - a.z < 100) continue;
      const [ua, va] = uv(a), [ub, vb] = uv(b);
      const v = Math.hypot(ub - ua, vb - va) / ((b.z - a.z) / 0.3048 / 1000);
      if (b.p >= 150 && a.z > 4500 && v >= 6) sh.push({ i, v, lo: fl(a.z), hi: fl(b.z) });
    }
  });
  if (sh.length) {
    sh.sort((x, y) => y.v - x.v);
    const places = [...new Set([...sh].sort((x, y) => x.i - y.i).map(s => pts[s.i].place))];
    if (places.length > 4) places.splice(1, places.length - 2, '…');
    const lo = Math.min(...sh.map(s => s.lo)), hi = Math.max(...sh.map(s => s.hi));
    out.push(`鉛直シア 6kt/1000ft 以上（並以上の晴天乱気流の目安）：${places.join('・')}の ${FLs(lo)}〜${FLs(hi)}。最大 ${sh[0].v.toFixed(1)}kt/1000ft（${pts[sh[0].i].place}、${FLs(sh[0].lo)}〜${FLs(sh[0].hi)}）。${H.shear}`);
  } else out.push('鉛直シアが 6kt/1000ft を超える所は見当たらない（晴天乱気流の心配は小さい）。');
  // 湿った層（湿数3℃以下 ≒ 雲）と着氷（0〜−20℃）
  const wet = [], ice = [];
  prof.forEach((col, i) => col.forEach(x => {
    const dd = dewDep(x.T, x.rh);
    if (dd != null && dd <= 3 && x.z != null) { wet.push({ i, f: fl(x.z) }); if (x.T <= 0 && x.T >= -20) ice.push({ i, f: fl(x.z) }); }
  }));
  const span = arr => {
    const ps = [...new Set(arr.map(w => pts[w.i].place))];
    return `${ps.length > 4 ? `${ps[0]}〜${ps.at(-1)}の各地` : ps.join('・')}、${FLs(Math.min(...arr.map(w => w.f)))}〜${FLs(Math.max(...arr.map(w => w.f)))}`;
  };
  out.push(wet.length ? `湿った層（湿数3℃以下＝雲が多い。${H.wet}）：${span(wet)}。` : '湿数3℃以下の湿った層はほとんどない（雲は少なめ）。');
  if (ice.length) out.push(`着氷に注意（湿っていて 0〜−20℃）：${span(ice)}。上昇・降下中に通過する。`);
  // 0℃高度
  const fz = [];                                   // [点の番号, 高度m]
  prof.forEach((col, i) => {
    for (let k = 0; k < col.length - 1; k++) {
      const a = col[k], b = col[k + 1];
      if (a.T == null || b.T == null || a.z == null || b.z == null) continue;
      if (a.T >= 0 && b.T < 0) { fz.push([i, a.z + (b.z - a.z) * a.T / (a.T - b.T)]); break; }
    }
  });
  if (fz.length) {
    const ft = v => (Math.round(v / 0.3048 / 100) * 100).toLocaleString();
    const hi = fz.reduce((m, x) => (x[1] > m[1] ? x : m)), lo = fz.reduce((m, x) => (x[1] < m[1] ? x : m));
    out.push(`0℃高度：${ft(lo[1])}ft（${pts[lo[0]].place}）〜${ft(hi[1])}ft（${pts[hi[0]].place}）。${H.temp}の 0 の線。`);
  }
  // 圏界面（400hPa より上で、気温がほとんど下がらなくなる高さ）
  const tp = [];                                   // [点の番号, FL]
  prof.forEach((col, i) => {
    for (let k = 0; k < col.length - 1; k++) {
      const a = col[k], b = col[k + 1];
      if (a.p > 400 || [a.T, b.T, a.z, b.z].some(v => v == null)) continue;
      if ((a.T - b.T) / ((b.z - a.z) / 1000) < 2) { tp.push([i, fl(a.z)]); break; }
    }
  });
  if (tp.length) {
    const hi = tp.reduce((m, x) => (x[1] > m[1] ? x : m)), lo = tp.reduce((m, x) => (x[1] < m[1] ? x : m));
    out.push(`圏界面（おおよそ）：${hi[1] === lo[1] ? `${FLs(hi[1])}付近` : `${FLs(lo[1])}（${pts[lo[0]].place}）〜${FLs(hi[1])}（${pts[hi[0]].place}）`}。${H.trop}。気圧面の間隔が粗いので目安。`);
  }
  return out;
}

/** 断面図の「今の状況」。kind = 'fxjp'（予想）/ 'axjp'（解析）。init は図の初期時刻（Date, UTC） */
export async function sectionText(kind, init) {
  const panels = kind === 'fxjp' ? [[6, '6時間予想（FXJP106）'], [12, '12時間予想（FXJP112）']] : [[140, '東経140度（AXJP140）'], [130, '東経130度（AXJP130）']];
  const lines = [];
  for (const [panel, name] of panels) {
    const pts = densifyLine(sectionLine(kind, panel));
    const valid = kind === 'fxjp' ? new Date(init.getTime() + panel * 3600e3) : init;
    const [prof] = await fetchLine(pts, [valid]);
    const vt = `${String(valid.getUTCDate()).padStart(2, '0')}日${String(valid.getUTCHours()).padStart(2, '0')}Z`;
    if (!prof) { lines.push(`<b>${name}</b>：${vt} のモデル値を取得できませんでした。`); continue; }
    lines.push(`<b>${name}・${vt}</b>`, ...describe(pts, prof, kind));
  }
  return lines;
}
