// 揺れリスクによる登録経路の採点と、最適な Route・巡航高度の推奨
import { tiAt, tiClass } from './turbulence.js';
import { radarMaxNear, pointInPoly } from './wxSources.js';

const W_SEV = { LGT: 1, MOD: 4, SEV: 12 };        // 1分あたりの重み
const W_TERRAIN = 200;                              // 山より低い巡航（実質的に選ばない）

/** 地点から最も近い「発達した積乱雲」（20NM以内）。{ b, d(NM) } */
export function nearCb(cbs, lat, lon, maxNM = 20) {
  let best = null;
  for (const b of cbs || []) {
    if (nmDist({ lat, lon }, b) - b.radiusKm / 1.852 > maxNM + 10) continue;   // 遠いものは先に除く
    for (const c of b.cells) { const d = nmDist({ lat, lon }, c); if (d <= maxNM && (!best || d < best.d)) best = { b, d }; }
  }
  return best;
}
export const DIST_PENALTY_PER_NM = 0.12;           // 最短候補より長い分の重み（1NMあたり）

const nmDist = (a, b) => {
  const R = 3440.065, r = Math.PI / 180, p1 = a.lat * r, p2 = b.lat * r, dl = (b.lon - a.lon) * r;
  return 2 * R * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
};
const bearing = (a, b) => {
  const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};

/** 経路を約 stepNM ごとに分割（各点は直前の地点名を持つ） */
export function densify(points, stepNM = 5) {
  const out = [];
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) { out.push({ lat: p.lat, lon: p.lon, d: 0, near: p.id, kind: p.kind }); continue; }
    const a = points[i - 1], seg = nmDist(a, p), n = Math.max(1, Math.ceil(seg / stepNM));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      out.push({ lat: a.lat + (p.lat - a.lat) * f, lon: a.lon + (p.lon - a.lon) * f, d: d + seg * f,
                 near: f < 0.5 ? a.id : p.id, kind: p.kind, segFrom: a.id, segTo: p.id });
    }
    d += seg;
  }
  return out;
}

/** 巡航高度に対する高度・時刻プロファイル（上昇 250ft/NM、降下 320ft/NM） */
export function profile(samples, cruiseFt, depElev = 0, arrElev = 0, departure = new Date()) {
  const D = samples.at(-1).d;
  let tMin = 0;
  return samples.map((s, i) => {
    const alt = Math.max(0, Math.min(cruiseFt, depElev + 250 * s.d, arrElev + 320 * (D - s.d)));
    if (i > 0) {
      const dd = s.d - samples[i - 1].d;
      const gs = alt < 10000 ? 250 : alt < cruiseFt - 500 ? 380 : 460;
      tMin += dd / gs * 60;
    }
    return { ...s, alt, tg: cruiseFt, level: alt >= cruiseFt - 1, tMin, eto: new Date(departure.getTime() + tMin * 60000) };
  });
}

/** 東行き(磁方位000-179)は奇数FL、西行きは偶数FL（RVSM 準拠、FL410 まで） */
export function allowedLevels(points, magVar = -8, minFL = 240, maxFL = 410) {
  const enr = points.filter(p => p.kind === 'ENROUTE');
  const a = enr[0] || points[0], b = enr.at(-1) || points.at(-1);
  const mag = (bearing(a, b) - magVar + 360) % 360;
  const east = mag < 180;
  const out = [];
  for (let fl = minFL; fl <= maxFL; fl += 10) if (((fl / 10) % 2 === 1) === east) out.push(fl);
  return { levels: out, east, magCourse: Math.round(mag) };
}

/**
 * 1経路×1高度の採点。wx = { grid, tiField, radar, sigmets }
 * 返り値: { score, hazardScore, minutes, hazards:[{type, cls, at, fl, value, minutes}] , segs:[{from,to,cls}] }
 */
export function scoreProfile(prof, wx) {
  const hz = new Map();      // 同じ種類・同じ区間はまとめる
  const segs = [];
  let hazardScore = 0;
  const tIndex = timeIndexer(wx);
  for (let i = 1; i < prof.length; i++) {
    const s = prof[i], dt = s.tMin - prof[i - 1].tMin;
    let worst = null;
    for (const { type, cls, value, label } of sampleHazards(s, s.alt, s.eto, wx, tIndex, s.level)) {
      hazardScore += (type === 'TERRAIN' ? W_TERRAIN : W_SEV[cls]) * dt;
      const key = `${type}|${cls}|${s.segFrom || s.near}-${s.segTo || ''}`;
      const h = hz.get(key) || { type, cls, from: s.segFrom || s.near, to: s.segTo || s.near, flMin: 1e9, flMax: 0, value: 0, minutes: 0, label, lat: s.lat, lon: s.lon };
      h.minutes += dt; h.flMin = Math.min(h.flMin, Math.round(s.alt / 100)); h.flMax = Math.max(h.flMax, Math.round(s.alt / 100));
      if (value > h.value) { h.value = value; h.lat = s.lat; h.lon = s.lon; h.label = label; }
      hz.set(key, h);
      if (!worst || W_SEV[cls] > W_SEV[worst]) worst = cls;
    }
    segs.push({ a: prof[i - 1], b: s, cls: worst });
  }
  const hazards = [...hz.values()].sort((x, y) => W_SEV[y.cls] * y.minutes - W_SEV[x.cls] * x.minutes);
  return { hazardScore: Math.round(hazardScore * 10) / 10, minutes: Math.round(prof.at(-1).tMin), hazards, segs };
}

/** 予報の時刻（高層風の格子）のうち、eto に一番近いものの番号 */
function timeIndexer(wx) {
  if (!wx.grid) return () => 0;
  const T = wx.grid.times.map(t => new Date(t).getTime());
  return eto => { let k = 0; for (let i = 1; i < T.length; i++) if (Math.abs(T[i] - eto) < Math.abs(T[k] - eto)) k = i; return k; };
}

/** 1地点・1高度で当たる揺れの要因（種類・強さ・値・説明） */
function sampleHazards(s, alt, eto, wx, tIndex, level = false) {
  const out = [];
  // 0) 地形：巡航（水平飛行）中に、経路の周りの最低高度より低い（上昇・降下中は SID/STAR に従うので見ない）
  if (level && s.msaFt && alt < s.msaFt) out.push({ type: 'TERRAIN', cls: 'SEV', value: s.msaFt - alt, label: `最低高度 ${s.msaFt.toLocaleString()}ft（周りの山）` });
  // 1) 晴天乱気流（風の鉛直シア×変形。700hPa＝約FL100 より上）
  if (wx.tiField && alt >= 8000) {
    const r = tiAt(wx.grid, wx.tiField, tIndex(eto), s.lat, s.lon, alt);
    const c = r && tiClass(r.ti);
    if (c) out.push({ type: 'CAT', cls: c.cls, value: r.ti, label: `TI ${r.ti.toFixed(1)}（${r.layer.lo}-${r.layer.hi}hPa）` });
  }
  // 2) 対流雲（レーダーエコー、経路の左右10NM）
  // 保存した評価（wx.radar がない）では、各点に残した値（radarMax・convTop）を使う
  if (wx.radar || s.radarMax != null) {
    const mm = s.radarMax ?? (s.radarMax = radarMaxNear(wx.radar, s.lat, s.lon, 10));
    let cls = mm >= 50 ? 'SEV' : mm >= 20 ? 'MOD' : mm >= 10 ? 'LGT' : null;
    if (cls) {
      // 雲頂（ひまわり赤外から推定）より十分高ければ雲の上を通過できる。分からないときは高さに関係なく評価
      const top = s.convTop !== undefined ? s.convTop : wx.convTop ? (s.convTop = wx.convTop(s.lat, s.lon)) : null;
      const tl = top ? `・雲頂FL${String(Math.round(top / 1000) * 10).padStart(3, '0')}` : '';
      if (top != null && alt >= top + 5000) cls = null;
      else if (top != null && alt >= top) cls = 'LGT';
      if (cls) out.push({ type: 'CONV', cls, value: mm, label: `エコー ${mm >= 80 ? '80以上' : mm} mm/h${tl}${top != null && alt >= top ? '（雲頂の上）' : ''}` });
    }
  }
  // 2b) 発達した積乱雲（強いエコー × 冷たい雲頂。20NM以内で雲頂より低い高度は回避対象）
  if (wx.cbs) {
    const n = s.cbNear === undefined ? (s.cbNear = nearCb(wx.cbs, s.lat, s.lon)) : s.cbNear;
    if (n) {
      const topFt = (n.b.top?.fl ?? 450) * 100;
      const lbl = `${n.b.sev === 'SEV' ? '非常に発達した' : '発達した'}積乱雲 雲頂FL${n.b.top ? String(n.b.top.fl).padStart(3, '0') : '?'}・${Math.round(n.d)}NM`;
      if (alt <= topFt + 5000) out.push({ type: 'CB', cls: n.b.sev === 'SEV' || n.d <= 10 ? 'SEV' : 'MOD', value: 20 - n.d, label: lbl });
      else if (n.d <= 10) out.push({ type: 'CB', cls: 'LGT', value: 20 - n.d, label: lbl + '（雲頂の上を通過）' });
    }
  }
  // 2c) 悪天予想図（国内 FBJP の CAT 域・積乱雲・雲中の揺れ、国際 SIGWX の積乱雲・乱気流）。範囲の中で下限〜上限の高度
  for (const b of s.fcst || []) {
    if (!b.cls || alt < b.base || alt > b.top) continue;
    out.push({ type: 'FCST', cls: b.cls, value: W_SEV[b.cls], label: b.label });
  }
  // 3) SIGMET（時間・高度・範囲が重なるもの）。札には対象の高度も付ける
  const sigFl = ft => (ft <= 0 ? 'SFC' : 'FL' + String(Math.round(ft / 100)).padStart(3, '0'));
  for (const g of wx.sigmets || []) {
    if (!['TS', 'TURB', 'MTW', 'CONVECTIVE', 'TC'].some(k => g.hazard.includes(k))) continue;
    if (g.from && eto < g.from || g.to && eto > g.to) continue;
    if (alt < g.baseFt || alt > g.topFt) continue;
    if (!pointInPoly(s.lat, s.lon, g.coords)) continue;
    out.push({ type: 'SIGMET', cls: g.qualifier.includes('SEV') || g.hazard.includes('TS') ? 'SEV' : 'MOD', value: 1, label: `SIGMET ${g.hazard}${g.qualifier ? ' ' + g.qualifier : ''}（${g.fir}・${sigFl(g.baseFt)}〜${g.topKnown === false ? '上限不明' : sigFl(g.topFt)}）` });
  }
  return out;
}

// ---------- 途中で高度を変える（ステップ上昇・降下）計画 ----------
//   経路の 5NM ごとの点で「その高度を保つ」か「別の高度へ上昇・降下を始める」かを選ぶ動的計画法。
//   上昇・降下は実際の傾き（約1000ft/分・1500ft/分）で、その途中の高さの揺れも数える。
//   揺れの予想空域（晴天乱気流・悪天予想図・SIGMET・積乱雲・雷雨）を、高度を変えて避けられる限り避ける。
const CHANGE_COST = 0.6;      // 高度変更1回の手間（揺れ評価の単位。弱い揺れ約40秒分）。避けられる揺れは避け、差がなければ変えない
const CHANGE_PER_FL = 0.01;   // 変える幅 1,000ft あたりの手間（大きな上下を少しだけ控える）
// 揺れを避けたうえで、できるだけ高い高度をとる：使える一番高い FL より 2,000ft 低いごとに、1NM あたり 0.004。
//   弱い揺れ（1分=約7.7NM で 1）の 1NM あたり 0.13 よりずっと小さいので、揺れを受けてまで高くはしない。
//   揺れが同じなら、高い高度・揺れ域を過ぎた後の上昇（例：100NM 以上残っていれば 4,000ft 上げる）を選ぶ
export const HIGH_PER_NM = 0.004;
/** 高度の低さの評価（計画の高度 tg が、使える一番高い FL より低い分×距離） */
export function altPenalty(prof, topFL) {
  let v = 0;
  for (let i = 1; i < prof.length; i++) v += (prof[i].d - prof[i - 1].d) * HIGH_PER_NM * Math.max(0, topFL * 100 - (prof[i].tg ?? prof[i].alt)) / 2000;
  return v;
}
export const CLIMB_FT_PER_NM = 130;  // 巡航中の上昇（約1000ft/分）
export const DESC_FT_PER_NM = 200;   // 巡航中の降下（約1500ft/分）
const gsOf = (alt, target) => (alt < 10000 ? 250 : alt < target - 500 ? 380 : 460);
const rampNM = (from, to) => Math.abs(to - from) * 100 / (to > from ? CLIMB_FT_PER_NM : DESC_FT_PER_NM);

/** 上昇・降下の制限（出発空港から 250ft/NM、到着空港まで 320ft/NM） */
const capper = (samples, depElev, arrElev) => {
  const D = samples.at(-1).d;
  return s => Math.min(depElev + 250 * s.d, arrElev + 320 * (D - s.d));
};

/**
 * 高度変更を整える：順番に並べ、上昇・降下の長さ（d1）を付け、前の変更と重ならないようにずらす。
 * 同じ高度への変更、経路の外に出る変更は除く。
 */
export function normalizeSteps(firstFL, steps, D) {
  const out = [];
  let cur = firstFL, last = 0;
  for (const s of [...steps].sort((a, b) => a.d0 - b.d0)) {
    if (s.to === cur) continue;
    const d0 = Math.max(s.d0, last), d1 = d0 + rampNM(cur, s.to);
    if (d1 > D) continue;
    out.push({ ...s, from: cur, to: s.to, d0, d1 });
    cur = s.to; last = d1;
  }
  return out;
}

/** 計画（最初の巡航高度＋途中の高度変更）から、高度・時刻のプロファイルを作る */
export function planProfile(samples, firstFL, steps, depElev = 0, arrElev = 0, departure = new Date()) {
  const cap = capper(samples, depElev, arrElev);
  const target = d => {
    let lv = firstFL * 100;
    for (const st of steps) {
      if (d >= st.d1) lv = st.to * 100;
      else if (d > st.d0) return lv + (st.to - st.from) * 100 * (d - st.d0) / (st.d1 - st.d0);
      else break;
    }
    return lv;
  };
  let tMin = 0;
  return samples.map((s, i) => {
    const tg = target(s.d), alt = Math.max(0, Math.min(tg, cap(s)));
    if (i > 0) tMin += (s.d - samples[i - 1].d) / gsOf(alt, tg) * 60;
    return { ...s, alt, tg, level: alt >= tg - 1 && Number.isInteger(tg / 100), tMin, eto: new Date(departure.getTime() + tMin * 60000) };
  });
}

/** 高度変更を始める地点の名前・位置と、変更の理由（元の高度のままだと当たる要因）を付ける */
function annotateSteps(steps, prof, wx) {
  const tIndex = timeIndexer(wx);
  steps.forEach((st, k) => {
    const p = prof.find(q => q.d >= st.d0) || prof.at(-1);
    Object.assign(st, { lat: p.lat, lon: p.lon, near: p.near, alt: st.to * 100 });
    // 理由：変更しなかった場合（元の高度のまま次の変更まで）に当たる一番強い要因
    const end = steps[k + 1]?.d0 ?? prof.at(-1).d;
    let why = null;
    for (const q of prof) {
      if (q.d < st.d0 || q.d > end) continue;
      const alt = q.alt < Math.min(st.from, st.to) * 100 - 1 ? q.alt : st.from * 100;   // 到着への降下などで下がっている所は実際の高度
      for (const h of sampleHazards(q, alt, q.eto, wx, tIndex, true)) if (!why || W_SEV[h.cls] > W_SEV[why.cls]) why = h;
    }
    st.why = why;
  });
  return steps;
}

/** 計画を採点して、推奨・手動のどちらでも使う形にする */
export function scorePlan(samples, firstFL, steps, wx, depElev, arrElev, departure, extra = {}) {
  const D = samples.at(-1).d;
  const st = normalizeSteps(firstFL, steps, D);
  const prof = planProfile(samples, firstFL, st, depElev, arrElev, departure);
  annotateSteps(st, prof, wx);
  const sc = scoreProfile(prof, wx);
  return { fl: firstFL, steps: st, levelsUsed: [...new Set([firstFL, ...st.map(s => s.to)])], ...sc, prof, step: st.length > 0, ...extra };
}

/**
 * 揺れの予想空域を可能な限り避ける高度の計画（動的計画法）。
 * levels: 使える FL（東行き奇数／西行き偶数）、base: 一定高度で一番よかった結果（通過時刻の目安に使う）
 */
export function stepPlan(samples, levels, wx, base, depElev = 0, arrElev = 0, departure = new Date()) {
  if (levels.length < 2 || samples.length < 3) return null;
  const N = samples.length, L = levels.length, tIndex = timeIndexer(wx), cap = capper(samples, depElev, arrElev);
  const caps = samples.map(cap);
  // 地点 i・高度 alt（1000ft 単位にまるめる）の、1点あたりの揺れ評価（覚えておいて使い回す）
  const memo = new Map();
  const costAt = (i, alt, target, level) => {
    if (i === 0) return 0;
    const a = Math.max(0, Math.min(Math.round(alt / 1000) * 1000, caps[i]));
    const key = `${i}|${a}|${level ? 1 : 0}|${a < target - 500 ? 1 : 0}`;
    let v = memo.get(key);
    if (v === undefined) {
      const s = samples[i], eto = base.prof[i]?.eto || departure, dt = (s.d - samples[i - 1].d) / gsOf(a, target) * 60;
      v = 0;
      for (const h of sampleHazards(s, a, eto, wx, tIndex, level)) v += (h.type === 'TERRAIN' ? W_TERRAIN : W_SEV[h.cls]) * dt;
      memo.set(key, v);
    }
    return v;
  };
  const stay = (i, j) => costAt(i, levels[j] * 100, levels[j] * 100, caps[i] >= levels[j] * 100 - 1)
    + (i ? (samples[i].d - samples[i - 1].d) * HIGH_PER_NM * (L - 1 - j) : 0);
  // V[i][j]：地点 i で高度 j を保っている状態までの最小の評価
  const V = Array.from({ length: N }, () => new Float64Array(L).fill(Infinity));
  const from = Array.from({ length: N }, () => new Int32Array(L * 2).fill(-1));   // [前の地点, 前の高度]
  for (let j = 0; j < L; j++) V[0][j] = 0;
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < L; j++) {
    const v = V[i][j]; if (!isFinite(v)) continue;
    // 1) そのまま
    const v1 = v + stay(i + 1, j);
    if (v1 < V[i + 1][j]) { V[i + 1][j] = v1; from[i + 1][j * 2] = i; from[i + 1][j * 2 + 1] = j; }
    // 2) 高度変更を始める（巡航中だけ。上昇・降下の終わりも巡航の範囲の中）
    const lv = levels[j] * 100;
    if (caps[i] < lv - 1) continue;
    for (let k = 0; k < L; k++) {
      if (k === j) continue;
      const to = levels[k] * 100, len = rampNM(levels[j], levels[k]), d0 = samples[i].d;
      let c = v + CHANGE_COST + CHANGE_PER_FL * Math.abs(levels[k] - levels[j]), e = i + 1;
      for (; e < N && samples[e].d < d0 + len; e++) c += costAt(e, lv + (to - lv) * (samples[e].d - d0) / len, Math.max(lv, to), false);
      if (e >= N || caps[e] < Math.max(lv, to) - 1) continue;
      c += stay(e, k);
      if (c < V[e][k]) { V[e][k] = c; from[e][k * 2] = i; from[e][k * 2 + 1] = j; }
    }
  }
  // たどり直して高度変更の列を作る
  let j = 0;
  for (let k = 1; k < L; k++) if (V[N - 1][k] < V[N - 1][j]) j = k;
  const steps = [];
  let i = N - 1;
  while (i > 0) {
    const pi = from[i][j * 2], pj = from[i][j * 2 + 1];
    if (pi < 0) break;
    if (pj !== j) steps.unshift({ from: levels[pj], to: levels[j], d0: samples[pi].d });
    i = pi; j = pj;
  }
  const firstFL = levels[j];
  if (!steps.length) return null;                     // 一定高度と同じ
  return scorePlan(samples, firstFL, steps, wx, depElev, arrElev, departure);
}

/** 経路の結果 r から、高度の計画を作り直すための材料（評価の点・空港の標高・使える高度） */
export function planContext(r, minFL = 100, maxFL = 410) {
  const strip = ({ alt, level, tMin, eto, ...s }) => s;
  const samples = r.samples || r.best.prof.map(strip);
  const prof = r.best.prof;
  const ctx = r.planCtx || {};
  const depEl = ctx.depEl ?? (prof[0].alt > 5000 ? 1e6 : prof[0].alt);
  const arrEl = ctx.arrEl ?? (prof.at(-1).alt > 5000 ? 1e6 : prof.at(-1).alt);
  let levels = ctx.levels;
  if (!levels) { levels = []; for (let fl = minFL; fl <= maxFL; fl += 10) if (((fl / 10) % 2 === 1) === !!r.east) levels.push(fl); }
  return { samples, depEl, arrEl, levels };
}

/** 断面図で手動に変えた高度の計画を採点する（r.best を置き換える値を返す） */
export function manualPlan(r, firstFL, steps, wx, departure, minFL, maxFL) {
  const c = planContext(r, minFL, maxFL);
  return scorePlan(c.samples, firstFL, steps, wx, c.depEl, c.arrEl, departure, { manual: true });
}

/** 揺れ評価から、経路の順位付けの値と区分を付け直す */
export function rescore(r, shortestNM) {
  r.extraNM = r.distanceNM - shortestNM;
  r.score = Math.round((r.best.hazardScore + r.extraNM * DIST_PENALTY_PER_NM) * 10) / 10;
  r.level = r.best.hazardScore < 2 ? 'good' : r.best.hazardScore < 15 ? 'caution' : 'avoid';
}

/** 高度の計画を短い文にする（例：FL330 → FL370（GYODA付近から） → FL350） */
export const levelPlanText = b => (!b.steps?.length ? `FL${b.fl}`
  : [`FL${b.fl}`, ...b.steps.map(s => `FL${s.to}（${s.near}付近から${s.to > s.from ? '上昇' : '降下'}）`)].join(' → ')) + (b.manual ? '［手動］' : '');

/**
 * 候補経路を採点して順位付け。
 * candidates: [{ id, label, route, category, ... }]、nav: createAeroNav の戻り値
 * opts: { dep, arr, departure(Date), minFL, maxFL }
 */
export function rankRoutes(nav, candidates, wx, opts) {
  const results = [];
  for (const c of candidates) {
    const full = nav.buildFullRoute(fullRouteArgs(opts.dep, opts.arr, c));
    if (full.errors.length || full.points.length < 2) continue;
    const D = nav.getAirport(opts.dep), A = nav.getAirport(opts.arr);
    // 国際線の入域・出域（空港ではない）側は、上昇・降下せず巡航高度のままとする
    const isAp = c => /^[A-Z]{4}$/.test(c || '');
    const depEl = D ? D.elevationFt || 0 : isAp(opts.dep) ? 0 : 1e6, arrEl = A ? A.elevationFt || 0 : isAp(opts.arr) ? 0 : 1e6;
    const samples = densify(full.points, 5);
    if (wx.radar) for (const s of samples) s.radarMax = radarMaxNear(wx.radar, s.lat, s.lon, 10);
    if (wx.cbs) for (const s of samples) s.cbNear = nearCb(wx.cbs, s.lat, s.lon);
    if (wx.convTop) for (const s of samples) if (s.radarMax >= 10) s.convTop = wx.convTop(s.lat, s.lon);
    if (wx.msaAt) for (const s of samples) s.msaFt = wx.msaAt(s.lat, s.lon);
    if (wx.fcstAt) for (const s of samples) s.fcst = wx.fcstAt(s.lat, s.lon);
    const { levels, east, magCourse } = allowedLevels(full.points, D?.magVar ?? -8,
      Math.min(Math.max(opts.minFL, c.minFL || 0), (c.maxFL || 999) - 20), Math.min(opts.maxFL, c.maxFL || 999));
    let best = null; const byFL = [];
    for (const fl of levels) {
      const prof = profile(samples, fl * 100, depEl, arrEl, opts.departure);
      const sc = scoreProfile(prof, wx);
      byFL.push({ fl, hazardScore: sc.hazardScore });
      // 揺れを避けたうえで高い高度：揺れ評価＋高度の低さの評価が一番小さい高度（揺れが同じなら高い方）
      const v = sc.hazardScore + altPenalty(prof, levels.at(-1));
      if (!best || v < best.v - 1e-9) best = { fl, ...sc, prof, v };
    }
    if (!best) continue;
    // 途中で高度を変えて、揺れの予想空域を避ける・揺れ域を過ぎたら高く上がる計画のほうがよければ、それを推奨にする
    const constBest = best;
    const st = stepPlan(samples, levels, wx, best, depEl, arrEl, opts.departure);
    if (st && st.hazardScore <= best.hazardScore + 0.05 && st.hazardScore + altPenalty(st.prof, levels.at(-1)) < best.v - 0.3) best = st;
    const r = { cand: c, full, distanceNM: full.distanceNM, east, magCourse, byFL, best, constBest, excluded: c.excluded || null,
      samples, planCtx: { depEl, arrEl, levels } };
    r.autoBest = best;                                  // 断面図で手動に変えた後、「推奨に戻す」で使う
    // 到着時刻の制限（ETA hhmm-hhmm, UTC）
    if (!r.excluded && c.etaWindow && !inWindow(best.prof.at(-1).eto, c.etaWindow)) r.excluded = `到着時刻の条件（ETA ${c.etaWindow.join('-')}Z）に合いません`;
    results.push(r);
  }
  if (!results.length) return [];
  const shortest = Math.min(...results.map(r => r.distanceNM));
  for (const r of results) rescore(r, shortest);
  results.sort((a, b) => (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || a.score - b.score);
  return results;
}

/** "2145","1344" のような UTC 時間帯（日付またぎ可）に入っているか */
export function inWindow(date, [from, to]) {
  const m = date.getUTCHours() * 60 + date.getUTCMinutes();
  const f = +from.slice(0, 2) * 60 + +from.slice(2), t = +to.slice(0, 2) * 60 + +to.slice(2);
  return f <= t ? m >= f && m <= t : m >= f || m <= t;
}

/** 登録経路の備考・時間制限を解釈する（FL制限・時間帯・機種・条件付き） */
export function routeConditions(r, departure, aircraft = 'JET') {
  const txt = [r.time, r.remarks].filter(Boolean).join(' ');
  const c = {};
  // City Pair Route：使用禁止・PPR・調整が必要などは推奨に使わない（理由はデータの restriction）
  if (r.restriction) c.excluded = r.restriction;
  let m = /FL(\d{3})\+/.exec(txt); if (m) c.minFL = +m[1];
  m = /FL(\d{3})-/.exec(txt); if (m) c.maxFL = +m[1];
  m = /(EOBT|ETD)\s*(\d{4})-(\d{4})/.exec(txt);
  if (m && !inWindow(departure, [m[2], m[3]])) c.excluded = `出発時刻の条件（${m[1]} ${m[2]}-${m[3]}Z）に合いません`;
  m = /ETA\s*(\d{4})-(\d{4})/.exec(txt); if (m) c.etaWindow = [m[1], m[2]];
  if (/for\s*(DH8D|PROP)/i.test(txt) && aircraft === 'JET') c.excluded = c.excluded || 'プロペラ機用の経路です';
  if (/for\s*JET/i.test(txt) && aircraft !== 'JET') c.excluded = c.excluded || 'ジェット機用の経路です';
  if (/停波|AIP\s*SUP|限る|NOTAM/.test(txt)) c.excluded = c.excluded || `条件付きの経路です（${r.remarks}）`;
  return c;
}

/** 全経路を作る引数。City Pair Route は SID・STAR・滑走路が決まっているので、それを使う */
export function fullRouteArgs(dep, arr, c) {
  const a = { dep, arr, route: c.route };
  if (c.category === 'company') {
    if (c.sid) { a.sid = c.sid; a.sidTransition = c.sidTransition || null; }
    if (c.star) a.star = c.star;
    if (c.depRwy) a.depRwy = c.depRwy;
    if (c.arrRwy) a.arrRwy = c.arrRwy;
  }
  return a;
}

const TYPE_JA = { CAT: '晴天乱気流', CONV: '対流雲（雷雨）', CB: '積乱雲', SIGMET: 'SIGMET', TERRAIN: '地形（山）', FCST: '悪天予想図' };
const CLS_JA = { LGT: '弱', MOD: '並', SEV: '強' };
export const hazardText = h =>
  `${TYPE_JA[h.type]}・${CLS_JA[h.cls]}：${h.from}${h.to && h.to !== h.from ? '–' + h.to : ''} FL${String(h.flMin).padStart(3, '0')}${h.flMax !== h.flMin ? '–' + String(h.flMax).padStart(3, '0') : ''}（${h.label}、約${Math.max(1, Math.round(h.minutes))}分）`;

/** 推奨の説明文 */
export function adviceText(ranked) {
  const ok = ranked.filter(r => !r.excluded);
  if (!ok.length) return ranked.length ? '条件（時間帯・高度・機種）に合う登録経路がありません。条件付きの経路を参考に、管制・運航管理と調整してください。' : '評価できる経路がありません。';
  const top = ok[0], base = ok.find(r => r.cand.category === 'standard') || ok[0];
  const lines = [];
  const name = r => r.cand.label;
  lines.push(`推奨: ${name(top)}・${levelPlanText(top.best)}（揺れ評価 ${top.best.hazardScore}、距離 ${top.distanceNM}NM${top.extraNM > 0 ? `、最短より +${Math.round(top.extraNM)}NM` : ''}）。`);
  if (top.best.steps?.length) {
    lines.push(`途中で高度を変えます（一定高度 FL${top.constBest.fl} のままだと揺れ評価 ${top.constBest.hazardScore}）：` +
      top.best.steps.map(s => `${s.near}付近から FL${s.to} へ${s.to > s.from ? '上昇' : '降下'}${s.why ? `（${TYPE_JA[s.why.type]}・${CLS_JA[s.why.cls]}を避ける）` : s.to > s.from ? '（揺れの予想空域を過ぎたので高い高度へ）' : ''}`).join('、') + '。');
  }
  if (!top.best.hazards.length) lines.push('この経路・高度では、評価した範囲で揺れの要因は見つかりませんでした。');
  else lines.push('残る要因: ' + top.best.hazards.slice(0, 2).map(hazardText).join(' / '));
  if (base !== top) {
    const worst = base.best.hazards[0];
    lines.push(`標準経路（${name(base)}・${levelPlanText(base.best)}）は揺れ評価 ${base.best.hazardScore}${worst ? `。主因: ${hazardText(worst)}` : ''}。`);
  }
  const exc = ranked.filter(r => r.excluded && r.score < top.score);
  if (exc.length) lines.push(`条件付き・時間外の経路のうち ${exc.length} 本は揺れ評価がより低い値です（一覧の下に表示）。`);
  const alt = top.best.steps?.length ? null : top.byFL.filter(x => x.fl !== top.best.fl).sort((a, b) => a.hazardScore - b.hazardScore)[0];
  if (alt) lines.push(`同じ経路の次点高度は FL${alt.fl}（揺れ評価 ${alt.hazardScore}）。`);
  return lines.join('\n');
}
