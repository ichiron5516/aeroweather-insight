// 悪天予想図（国内 FBJP・国際 WAFS SIGWX）を経路アドバイスに取り込む
//   ・FBJP … 気象庁の画像を fbjpParse.js で読み取った CAT 域・雲域（積乱雲・揺れのある雲）
//   ・SIGWX … NOAA AWC の WAFS 高高度悪天予想（積乱雲・乱気流・着氷・ジェット気流・圏界面）。飛行の中ほどの時刻に近い予想
//   採点（scoring.js）では、経路上の点がこれらの範囲の中で、高度が下限〜上限に入っていれば「悪天予想図」の要因とする。
//   断面図（routeSection.js）では、経路上の各点で、どの高度帯に何が予想されているかを帯で描く。
import { parseFbjp } from '../wxPanels/fbjpParse.js';
import { fetchSigwxFor } from '../sigwxLayer.js';
import { FBJP_URL } from './wxSources.js';

/** 国内悪天予想図（画像）を読み取る */
export async function fetchFbjp() {
  const im = await new Promise((ok, ng) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => ok(i); i.onerror = () => ng(new Error('画像を取得できません'));
    i.src = `${FBJP_URL}?t=${Date.now()}`;
  });
  return parseFbjp(im);
}

/** 両方の悪天予想図を取る（片方だけでも返す）。time は飛行の中ほどの時刻 */
export async function fetchForecastCharts(time) {
  const [a, b] = await Promise.allSettled([fetchFbjp(), fetchSigwxFor(time)]);
  return {
    fbjp: a.status === 'fulfilled' ? a.value : null, fbjpError: a.status === 'rejected' ? a.reason.message : null,
    sigwx: b.status === 'fulfilled' ? b.value : null, sigwxError: b.status === 'rejected' ? b.reason.message : null,
  };
}

// ---------- 範囲の判定 ----------
function inRing(lat, lon, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}
// SIGWX は経度を連続にしてある（180度を超えることがある）ので、±360 も試す
const inArea = (lat, lon, ring) => inRing(lat, lon, ring) || inRing(lat, lon + 360, ring) || inRing(lat, lon - 360, ring);
const bbox = ring => {
  let s = 90, n = -90, w = 1e9, e = -1e9;
  for (const p of ring) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  return { s, n, w, e };
};
const inBox = (lat, lon, b) => lat >= b.s && lat <= b.n && [lon, lon + 360, lon - 360].some(x => x >= b.w && x <= b.e);
const nmDist = (a, b) => {
  const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
};
const fl3 = v => String(Math.round(v)).padStart(3, '0');
const EXT = { ISOL: '孤立', OCNL: '時々', FRQ: '頻繁', FREQ: '頻繁', EMBD: '埋没' };

/**
 * 悪天予想図の範囲を、判定しやすい形（帯の一覧）にまとめる。
 *   積乱雲の範囲は「その中のどこかに積乱雲がある」という意味なので弱めに数える（孤立・時々＝弱、頻繁・埋没＝並）。
 *   実際の積乱雲はレーダー・ひまわりの判定（CONV・CB）で強く数える。
 *   band = { src:'FBJP'|'SIGWX', kind:'CAT'|'CB'|'TURB'|'CLOUD'|'ICING', cls:'LGT'|'MOD'|'SEV'|null（採点しない）, base, top(ft), label, ring, box }
 */
export function forecastBands(fc) {
  const out = [];
  if (!fc) return out;
  const add = (o) => { if (o.ring?.length >= 3 && o.top > o.base) out.push({ ...o, box: bbox(o.ring) }); };
  const f = fc.fbjp;
  if (f) {
    for (const c of f.cats || []) {
      const base = (c.base ?? 250) * 100, top = (c.top ?? 400) * 100;
      add({ src: 'FBJP', kind: 'CAT', cls: 'MOD', base, top, ring: c.poly,
        label: `国内悪天予想図 CAT FL${fl3(base / 100)}〜${fl3(top / 100)}${c.base == null || c.top == null ? '（高度は推定）' : ''}` });
    }
    for (const c of f.clouds || []) {
      // 雲中の揺れの高度が書いてある雲は、揺れはそちらで数える（積乱雲の範囲は表示だけ。二重に数えない）
      if (c.cb) add({ src: 'FBJP', kind: 'CB', cls: c.turb?.top ? null : 'LGT', base: (c.base ?? 20) * 100, top: (c.top ?? 400) * 100, ring: c.poly,
        label: `国内悪天予想図 積乱雲 FL${fl3(c.base ?? 20)}〜${fl3(c.top ?? 400)}` });
      if (c.turb?.top) add({ src: 'FBJP', kind: 'TURB', cls: 'MOD', base: (c.turb.base ?? c.base ?? 0) * 100, top: c.turb.top * 100, ring: c.poly,
        label: `国内悪天予想図 雲中の揺れ FL${fl3(c.turb.base ?? c.base ?? 0)}〜${fl3(c.turb.top)}` });
      else if (!c.cb && c.top) add({ src: 'FBJP', kind: 'CLOUD', cls: null, base: (c.base ?? 0) * 100, top: c.top * 100, ring: c.poly,
        label: `国内悪天予想図 雲域 FL${fl3(c.base ?? 0)}〜${fl3(c.top)}` });
    }
  }
  const g = fc.sigwx;
  if (g) {
    for (const a of g.areas) {
      const sev = a.sev === 'severe';
      if (a.kind === 'CB') add({ src: 'SIGWX', kind: 'CB', cls: ['FRQ', 'FREQ', 'EMBD'].includes(a.ext) ? 'MOD' : 'LGT', base: a.base * 100, top: a.top * 100, ring: a.ring,
        label: `国際悪天予想図 積乱雲 ${EXT[a.ext] || a.ext || ''} ${a.baseKnown ? 'FL' + fl3(a.base) : 'XXX'}〜FL${fl3(a.top)}` });
      else if (a.kind === 'TURB') add({ src: 'SIGWX', kind: 'TURB', cls: sev ? 'SEV' : 'MOD', base: a.base * 100, top: a.top * 100, ring: a.ring,
        label: `国際悪天予想図 乱気流 ${sev ? '強' : '並'} ${a.baseKnown ? 'FL' + fl3(a.base) : 'XXX'}〜FL${fl3(a.top)}` });
      else if (a.kind === 'ICING') add({ src: 'SIGWX', kind: 'ICING', cls: null, base: a.base * 100, top: a.top * 100, ring: a.ring,
        label: `国際悪天予想図 着氷 ${sev ? '強' : '並'} ${a.baseKnown ? 'FL' + fl3(a.base) : 'XXX'}〜FL${fl3(a.top)}` });
    }
  }
  return out;
}

/** 地点の上空にかかっている帯（高度は問わない） */
export const bandsAt = (bands, lat, lon) => (bands || []).filter(b => inBox(lat, lon, b.box) && inArea(lat, lon, b.ring));

/** 地点から折れ線までの距離（NM）と、一番近い所の番号（線分の始点） */
function lineDist(p, pts) {
  const k = Math.cos(p.lat * Math.PI / 180);
  let bd = 1e9, bi = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] || a;
    // 経度を地点の近くにそろえる（SIGWX は 180度を超えることがある）
    const ax = ((a.lon - p.lon + 540) % 360 - 180) * k, ay = a.lat - p.lat;
    const bx = ((b.lon - p.lon + 540) % 360 - 180) * k, by = b.lat - p.lat;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t) * 60;
    if (d < bd) { bd = d; bi = t < 0.5 ? i : Math.min(i + 1, pts.length - 1); }
  }
  return { d: bd, i: bi };
}

/** 地点から 60NM 以内を通るジェット気流の中心（FL・風速）。国内（FBJP）と国際（SIGWX）の両方 */
export function jetsNear(fc, lat, lon, maxNM = 60) {
  const out = [], p = { lat, lon };
  for (const j of fc?.fbjp?.jets || []) {
    if (!j.fl && !j.fls?.some(Boolean)) continue;
    const { d, i } = lineDist(p, j.pts);
    if (d <= maxNM) out.push({ src: 'FBJP', fl: j.fls?.[i] || j.fl, kt: null, d });
  }
  for (const j of fc?.sigwx?.jets || []) {
    if (!j.fl.length) continue;
    const { d } = lineDist(p, j.pts);
    if (d > maxNM) continue;
    const q = j.fl.reduce((a, b) => (nmDist(p, b) < nmDist(p, a) ? b : a));
    out.push({ src: 'SIGWX', fl: q.fl, kt: q.kt, d });
  }
  return out;
}

/** 地点の圏界面の高さ（FL。SIGWX の圏界面の線のうち一番近いもの、300NM 以内） */
export function tropAt(fc, lat, lon) {
  let best = null;
  for (const t of fc?.sigwx?.trop || []) {
    const { d } = lineDist({ lat, lon }, t.pts);
    if (d < 300 && (!best || d < best.d)) best = { d, fl: t.fl };
  }
  return best?.fl ?? null;
}
