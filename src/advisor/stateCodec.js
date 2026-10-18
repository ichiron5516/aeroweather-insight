// 経路アドバイスの評価結果（候補経路・高度プロファイル・気象データ）を保存できる形（JSON）にする／元に戻す
//   ・同じものを指している積乱雲・悪天予想図の範囲は番号で持つ（重複して大きくならないように）
//   ・関数（地形・雲頂の検索など）は保存できないので、使った値を各点に書き込んでおく（地形の高さ elevFt など）
//   ・晴天乱気流の指数（tiField）は保存せず、読み込むときに高層風の格子から計算し直す
import { computeTI } from './turbulence.js';

const P_KEYS = ['lat', 'lon', 'd', 'near', 'kind', 'segFrom', 'segTo', 'alt', 'level', 'tMin', 'radarMax', 'convTop', 'msaFt', 'elevFt'];
const round = (v, k = 5) => (typeof v === 'number' ? Math.round(v * 10 ** k) / 10 ** k : v);

export function encodeState({ ranked, sel, wx, dep, arr, departure, minFL, maxFL, advice, status }) {
  const bands = wx.fcstBands || [], bIdx = new Map(bands.map((b, i) => [b, i]));
  const cbs = wx.cbs || [], cIdx = new Map(cbs.map((c, i) => [c, i]));
  const encProf = prof => prof.map(p => {
    const o = {};
    for (const k of P_KEYS) if (p[k] !== undefined && p[k] !== null) o[k] = round(p[k]);
    if (o.elevFt === undefined && wx.elevAt) o.elevFt = Math.round(wx.elevAt(p.lat, p.lon));
    o.eto = p.eto.getTime();
    if (p.cbNear) o.cb = { i: cIdx.get(p.cbNear.b), d: round(p.cbNear.d, 2) };
    if (p.fcst?.length) o.f = p.fcst.map(b => bIdx.get(b)).filter(i => i != null);
    return o;
  });
  const encPlan = b => {
    if (!b) return null;
    const pIdx = new Map((b.prof || []).map((p, i) => [p, i]));
    return {
      fl: b.fl, hazardScore: b.hazardScore, minutes: b.minutes, step: !!b.step, manual: !!b.manual, levelsUsed: b.levelsUsed || null,
      hazards: b.hazards, steps: b.steps || [],
      segs: (b.segs || []).map(s => [pIdx.get(s.a), pIdx.get(s.b), s.cls || null]),
      prof: b.prof ? encProf(b.prof) : null,
    };
  };
  return {
    format: 'aeroweather-state', version: 1,
    dep, arr, departure: departure.getTime(), minFL, maxFL, sel, advice, status,
    ranked: ranked.map(r => ({
      cand: r.cand, full: r.full, distanceNM: r.distanceNM, extraNM: r.extraNM, east: r.east, magCourse: r.magCourse,
      byFL: r.byFL, best: encPlan(r.best), constBest: r.constBest ? { fl: r.constBest.fl, hazardScore: r.constBest.hazardScore } : null,
      excluded: r.excluded, score: r.score, level: r.level,
      // 断面図で高度を手動で変えたとき用：空港の標高・使える高度、推奨（自動）の計画
      planCtx: r.planCtx || null,
      autoBest: r.autoBest ? { fl: r.autoBest.fl, steps: (r.autoBest.steps || []).map(x => ({ to: x.to, d0: round(x.d0, 3) })) } : null,
    })),
    wx: {
      grid: wx.grid || null,
      sigmets: (wx.sigmets || []).map(g => ({ ...g, from: g.from ? g.from.getTime() : null, to: g.to ? g.to.getTime() : null })),
      cbs, fcstBands: bands, fc: wx.fc ? { ...wx.fc, sigwx: wx.fc.sigwx ? { ...wx.fc.sigwx, issue: +wx.fc.sigwx.issue, valid: +wx.fc.sigwx.valid } : null } : null,
    },
  };
}

export function decodeState(st) {
  if (st?.format !== 'aeroweather-state') throw new Error('評価結果のデータがありません');
  const wx = {
    grid: st.wx.grid, sigmets: st.wx.sigmets.map(g => ({ ...g, from: g.from ? new Date(g.from) : null, to: g.to ? new Date(g.to) : null })),
    cbs: st.wx.cbs || [], fcstBands: st.wx.fcstBands || [], fc: st.wx.fc,
  };
  if (wx.fc?.sigwx) wx.fc.sigwx = { ...wx.fc.sigwx, issue: new Date(wx.fc.sigwx.issue), valid: new Date(wx.fc.sigwx.valid) };
  if (wx.grid) { try { wx.tiField = computeTI(wx.grid); } catch (e) { console.warn('[restore] TI', e); } }
  // 地形の高さは各点に保存した値を使う（断面図）
  const decProf = prof => prof.map(o => {
    const p = { ...o, eto: new Date(o.eto) };
    delete p.cb; delete p.f;
    if (o.cb && wx.cbs[o.cb.i]) p.cbNear = { b: wx.cbs[o.cb.i], d: o.cb.d };
    if (o.f) p.fcst = o.f.map(i => wx.fcstBands[i]).filter(Boolean);
    return p;
  });
  const decPlan = b => {
    if (!b) return null;
    const prof = b.prof ? decProf(b.prof) : [];
    return { ...b, prof, segs: (b.segs || []).map(([a, c, cls]) => ({ a: prof[a], b: prof[c], cls })) };
  };
  return {
    dep: st.dep, arr: st.arr, departure: new Date(st.departure), minFL: st.minFL, maxFL: st.maxFL, sel: st.sel, advice: st.advice, status: st.status,
    wx,
    ranked: st.ranked.map(r => ({ ...r, best: decPlan(r.best), constBest: r.constBest || decPlan(r.best) })),
  };
}
