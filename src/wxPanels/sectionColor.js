// 断面図（AXJP・FXJP）の色付け
//   図と同じ線に沿って、気象庁モデル（MSM/GSM、Open-Meteo 経由）の気圧面の値を取り、図の座標に合わせて色を塗る。
//   AXJP：
//     ジェット気流（風速 60kt 以上）… 薄い赤、100kt 以上 … 濃い赤
//     前線帯（等温線と等温位線が大きな角度で交わり、菱形のます目になる所、925〜300hPa）… 紫
//     圏界面 … 黄色の帯
//   FXJP（図の凡例に合わせる）：
//     太破線 WIND SHEAR（鉛直ウィンドシア 6kt/1000ft 以上）… ピンク
//     TROPOPAUSE（圏界面）… 黄色の帯
//     前線帯の一番低い相当温位線（太実線 EQV.P.T.）… その線を図の端から端まで紫でなぞる
//       （前線帯を見つけ、その中で一番低い相当温位を 5K 刻みに切り上げた値。例：315K）
//     湿域（湿数 3℃以下、図の波線）… 薄い緑
//     ※ジェット気流の赤は、ピンク（シア）とまぎらわしいので FXJP では塗らない（風速は図の細破線で読む）
//   図の線そのものを読み取って塗っているのではなく、モデルの値から塗っている。図の線と少しずれることがある。
import { layoutOf, stdAlt, stdP } from './crossSection3D.js';

const OM = 'https://api.open-meteo.com/v1/forecast';
const LV = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];

export const COLORS = {
  moist: { rgb: [150, 230, 150], label: '湿域（湿数3℃以下）' },
  jet: { rgb: [255, 140, 140], label: 'ジェット気流（60kt以上）' },
  jet100: { rgb: [200, 20, 30], label: '強いジェット気流（100kt以上）' },
  front: { rgb: [175, 110, 235], label: '前線帯（等温線と等温位線が菱形に交わる所）' },
  vws: { rgb: [255, 105, 190], label: 'ウィンドシア（太破線・6kt/1000ft以上）' },
  frontLine: { rgb: [150, 70, 230], label: '前線帯の一番低い相当温位線' },
  trop: { rgb: [255, 215, 0], label: '圏界面（TROPOPAUSE）' },
};
export const LAYERS = { axjp: ['jet', 'jet100', 'front', 'trop'], fxjp: ['moist', 'frontLine', 'vws', 'trop'] };
const FRONT_DEG = 22;                  // 前線帯とみなす、図の上での等温線と等温位線の交わる角度（度）
const JET_KT = 60, JET2_KT = 100, VWS_KT = 6, MOIST_DD = 3;
const THE_STEP = 5;                    // FXJP の相当温位線の間隔（K）。前線帯の下端の線はこの刻みに合わせる
const ALPHA = { jet100: 0.85, trop: 0.85, frontLine: 0.85, vws: 0.65 };   // 書いていないものは 0.6

const cache = new Map();
// Open-Meteo は「地点数 × 変数10個ごと」で回数を数え、1日の上限がある。
//   変数を絞り（高さは標準大気で気圧から求める）、必要な時刻だけ取り、結果はブラウザに3時間とっておく
export async function fetchPoints(pts, withRh, from, to) {
  const vars = LV.flatMap(l => ['wind_speed', 'wind_direction', 'temperature', ...(withRh ? ['relative_humidity'] : [])].map(v => `${v}_${l}hPa`));
  const h = d => d.toISOString().slice(0, 13) + ':00';
  const key = 'awSec1:' + pts.map(p => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join(';') + (withRh ? '|rh' : '') + `|${h(from)}|${h(to)}`;
  const c = cache.get(key); if (c) return c;
  try { const ls = JSON.parse(localStorage.getItem(key) || 'null'); if (ls && Date.now() - ls.at < 3 * 3600e3) { cache.set(key, ls.data); return ls.data; } } catch { /* 使えなくても続ける */ }
  const u = `${OM}?latitude=${pts.map(p => p.lat.toFixed(2)).join(',')}&longitude=${pts.map(p => p.lon.toFixed(2)).join(',')}&hourly=${vars.join(',')}` +
    `&models=jma_seamless&wind_speed_unit=kn&timezone=GMT&start_hour=${h(from)}&end_hour=${h(to)}`;
  for (let tries = 0; ; tries++) {
    const r = await fetch(u);
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      if (/Daily/i.test(j.reason || '')) throw new Error('Open-Meteo の1日の利用上限に達しました。明日になると色が付きます');
      if (tries < 3) { await new Promise(ok => setTimeout(ok, 20000 * (tries + 1))); continue; }   // 混雑時は待って取り直す
    }
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const j = await r.json(), arr = Array.isArray(j) ? j : [j];
    const data = arr.map(x => ({ hourly: x.hourly }));
    cache.set(key, data);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* 容量オーバーは無視 */ }
    return data;
  }
}

/** 図の線に沿った点（図の x 画素つき）。地点の間を約 stepKm ごとに分ける */
export function linePoints(L, stepKm = 100) {
  const out = [];
  for (let i = 0; i < L.anchors.length - 1; i++) {
    const a = L.anchors[i], b = L.anchors[i + 1];
    const d = Math.hypot((b.lat - a.lat) * 111, (b.lon - a.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
    const n = Math.max(1, Math.round(d / stepKm));
    for (let k = 0; k < n; k++) { const f = k / n; out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, x: a.x + (b.x - a.x) * f }); }
  }
  const z = L.anchors.at(-1); out.push({ lat: z.lat, lon: z.lon, x: z.x });
  // 点の間の距離（km、線に沿った累積）
  let s = 0; out.forEach((p, i) => { if (i) s += Math.hypot((p.lat - out[i - 1].lat) * 111, (p.lon - out[i - 1].lon) * 111 * Math.cos(p.lat * Math.PI / 180)); p.s = s; });
  return out;
}

/** (i, k) での等温線と等温位線の交わる角度（図の画素の座標で、0〜90度） */
function crossAngle(col, pts, L, i, k) {
  const NP = col.length, NL = LV.length;
  const i0 = Math.max(0, i - 1), i1 = Math.min(NP - 1, i + 1), k0 = Math.max(0, k - 1), k1 = Math.min(NL - 1, k + 1);
  const T = (j, m) => col[j][m].T, th = (j, m) => (col[j][m].T == null ? null : (col[j][m].T + 273.15) * (1000 / LV[m]) ** 0.2857);
  if ([T(i0, k), T(i1, k), T(i, k0), T(i, k1)].some(v => v == null)) return null;
  const dx = pts[i1].x - pts[i0].x, dy = L.yOf(stdAlt(LV[k1])) - L.yOf(stdAlt(LV[k0]));
  if (!dx || !dy) return null;
  const gT = [(T(i1, k) - T(i0, k)) / dx, (T(i, k1) - T(i, k0)) / dy];
  const gth = [(th(i1, k) - th(i0, k)) / dx, (th(i, k1) - th(i, k0)) / dy];
  const nT = Math.hypot(...gT), nth = Math.hypot(...gth);
  if (!nT || !nth) return null;
  const c = Math.abs(gT[0] * gth[0] + gT[1] * gth[1]) / (nT * nth);
  return Math.acos(Math.min(1, c)) * 180 / Math.PI;
}

const dewDep = (T, rh) => {
  if (T == null || !rh) return null;
  const a = 17.62, b = 243.12, g = Math.log(rh / 100) + a * T / (b + T);
  return T - b * g / (a - g);
};
/** 相当温位（K、Bolton 1980）。湿度がない高い所は温位で代用（水蒸気がほぼないので差はわずか） */
function thetaE(T, rh, p) {
  if (T == null) return null;
  const Tk = T + 273.15;
  if (!rh) return Tk * (1000 / p) ** 0.2857;
  const dd = dewDep(T, rh), Td = T - dd;
  const e = 6.112 * Math.exp(17.67 * Td / (Td + 243.5)), r = 0.622 * e / (p - e);
  const TL = 1 / (1 / (Td + 273.15 - 56) + Math.log(Tk / (Td + 273.15)) / 800) + 56;
  return Tk * (1000 / p) ** (0.2854 * (1 - 0.28 * r)) * Math.exp((3.376 / TL - 0.00254) * 1000 * r * (1 + 0.81 * r));
}
/**
 * 前線帯の一番低い相当温位線の値（K）。前線帯（菱形のます目になる所）のうち一番大きなかたまりを選び、
 *   その中（地表付近の 925hPa より下は除く）で一番低い相当温位を THE_STEP 刻みに切り上げる。前線帯がなければ null
 */
function frontLineValue(F) {
  const NP = F.front.length, NL = LV.length, seen = new Set(), key = (i, k) => i * NL + k;
  const isF = (i, k) => i >= 0 && i < NP && k >= 0 && k < NL && LV[k] <= 850 && (F.front[i][k] ?? 0) >= FRONT_DEG;
  let best = [];
  for (let i = 0; i < NP; i++) for (let k = 0; k < NL; k++) {
    if (!isF(i, k) || seen.has(key(i, k))) continue;
    const comp = [], st = [[i, k]]; seen.add(key(i, k));
    while (st.length) {
      const [a, b] = st.pop(); comp.push([a, b]);
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a2 = a + da, b2 = b + db;
        if (isF(a2, b2) && !seen.has(key(a2, b2))) { seen.add(key(a2, b2)); st.push([a2, b2]); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  const vals = best.map(([a, b]) => F.thetaE[a][b]).filter(v => v != null);
  if (!vals.length) return null;
  return Math.ceil(Math.min(...vals) / THE_STEP) * THE_STEP;
}

/** 列（線上の点）× 気圧面 の値と、塗るための量を計算する */
export function fieldsAt(pts, raw, valid, L) {
  const iso = valid.toISOString().slice(0, 13) + ':00';
  const t = raw[0].hourly.time.indexOf(iso);
  if (t < 0) return null;
  const col = pts.map((p, n) => LV.map(l => {
    const H = raw[n].hourly, g = k => H[`${k}_${l}hPa`]?.[t] ?? null;
    return { p: l, spd: g('wind_speed'), dir: g('wind_direction'), T: g('temperature'), rh: g('relative_humidity'), z: stdAlt(l) };
  }));
  const NL = LV.length, NP = pts.length;
  const F = { jet: [], front: [], moist: [], vws: [], thetaE: [] };
  // 隣り合う2つの気圧面の間の鉛直シア（風の差 ÷ 高度差、kt/1000ft）
  const uv = q => [-q.spd * Math.sin(q.dir * Math.PI / 180), -q.spd * Math.cos(q.dir * Math.PI / 180)];
  const shear = (lo, hi) => {
    if (!lo || !hi || [lo.spd, hi.spd, lo.dir, hi.dir].some(v => v == null) || hi.z - lo.z < 100) return null;
    const [ua, va] = uv(lo), [ub, vb] = uv(hi);
    return Math.hypot(ub - ua, vb - va) / ((hi.z - lo.z) / 0.3048 / 1000);
  };
  for (let i = 0; i < NP; i++) {
    F.jet.push([]); F.front.push([]); F.moist.push([]); F.vws.push([]); F.thetaE.push([]);
    for (let k = 0; k < NL; k++) {
      const x = col[i][k];
      F.jet[i].push(x.spd);
      const dd = dewDep(x.T, x.rh); F.moist[i].push(dd == null ? null : -dd);     // 大きいほど湿っている
      F.thetaE[i].push(thetaE(x.T, x.rh, LV[k]));
      // 前線帯：図の上で、等温線と等温位線が交わる角度（度）。ふだんはどちらもほぼ水平で平行に近く、
      //   前線帯では等温位線が傾いて込み合い、等温線と大きな角度で交わって菱形のます目になる
      F.front[i].push(LV[k] < 300 || LV[k] > 925 ? null : crossAngle(col, pts, L, i, k));
      // 鉛直シア：すぐ下の層・すぐ上の層のうち強い方（2層まとめて差を取ると、細いシアの層が薄まって図の太破線より小さく出るため）
      const a = shear(col[i][k - 1], x), b = shear(x, col[i][k + 1]);
      F.vws[i].push(a == null && b == null ? null : Math.max(a ?? 0, b ?? 0));
    }
  }
  // 前線帯は「角度が大きい」だけでなく、等温位線が込み合っている（温位の変化が大きい）所に限り、
  //   ぽつんと1マスだけのものは除く（モデルのでこぼこで出る小さな交差を拾わない）
  const gth = (i, k) => {
    const th = (j, m) => (col[j]?.[m]?.T == null ? null : (col[j][m].T + 273.15) * (1000 / LV[m]) ** 0.2857);
    const i0 = Math.max(0, i - 1), i1 = Math.min(NP - 1, i + 1), k0 = Math.max(0, k - 1), k1 = Math.min(NL - 1, k + 1);
    const a = [th(i0, k), th(i1, k), th(i, k0), th(i, k1)]; if (a.some(v => v == null)) return null;
    const dx = pts[i1].x - pts[i0].x, dy = L.yOf(stdAlt(LV[k1])) - L.yOf(stdAlt(LV[k0]));
    return Math.hypot((a[1] - a[0]) / dx, (a[3] - a[2]) / dy);
  };
  const G = F.front.map((c, i) => c.map((v, k) => (v == null ? null : gth(i, k))));
  const gs = G.flat().filter(v => v != null).sort((a, b) => a - b), gMed = gs[gs.length >> 1] || 0;
  const ok = (i, k) => { const v = F.front[i]?.[k], g = G[i]?.[k]; return v != null && v >= FRONT_DEG && g != null && g >= gMed; };
  F.front = F.front.map((c, i) => c.map((v, k) => (v == null ? null
    : ok(i, k) && (ok(i - 1, k) || ok(i + 1, k) || ok(i, k - 1) || ok(i, k + 1)) ? v : 0)));
  // 圏界面（500hPa より上で、気温減率が 2℃/km 以下になり、その上の層でも 3℃/km 以下が続く最初の高さ。気圧で返す）
  //   気圧面の間で減率が 2℃/km をまたぐ所を、層の中で直線に補って高さを決める（気圧面の高さに張り付かないように）
  F.tropP = col.map(c => {
    const lapse = k => { const a = c[k], b = c[k + 1]; return [a?.T, b?.T].some(v => v == null) ? null : (a.T - b.T) / ((b.z - a.z) / 1000); };
    for (let k = 0; k < NL - 1; k++) {
      if (c[k].p > 500) continue;
      const g = lapse(k), gUp = k + 1 < NL - 1 ? lapse(k + 1) : null;
      if (g == null || g > 2 || (gUp != null && gUp > 3)) continue;
      const gDn = k > 0 ? lapse(k - 1) : null;
      if (gDn == null || gDn <= 2) return c[k].p;
      // 下の層（減率 gDn）から この層（g）へ 2℃/km をまたぐ位置を、2つの層の真ん中の高さの間で補う
      const zDn = (c[k - 1].z + c[k].z) / 2, zUp = (c[k].z + c[k + 1].z) / 2;
      return stdP(zDn + (zUp - zDn) * (gDn - 2) / (gDn - g));
    }
    return null;
  });
  return F;
}

/** 1パネルぶんの色を overlay（図と同じ大きさの canvas）に塗る。F.lineV … 紫でなぞる相当温位（K、FXJP のみ） */
function paintPanel(octx, kind, panel, s, pts, F) {
  const L = layoutOf(kind, panel, s);                       // 縦（気圧 ⇔ 画素）の変換だけ使う
  const x0 = pts[0].x, x1 = pts.at(-1).x, yTop = L.yOf(stdAlt(100)), yBot = L.yOf(L.hBot);
  const CELL = Math.max(2, Math.round(3 * s));               // 低い解像度で計算して、なめらかに拡大する
  const LW = Math.ceil((x1 - x0) / CELL), LH = Math.ceil((yBot - yTop) / CELL);
  const lc = document.createElement('canvas'); lc.width = LW; lc.height = LH;
  const lx = lc.getContext('2d'), img = lx.createImageData(LW, LH), d = img.data;
  // y → 気圧（yOf を逆に引く）
  const hOfY = y => { let lo = L.hBot, hi = stdAlt(100); for (let n = 0; n < 30; n++) { const m = (lo + hi) / 2; if (L.yOf(m) > y) lo = m; else hi = m; } return (lo + hi) / 2; };
  const lnLV = LV.map(Math.log);
  const xs = pts.map(p => p.x);
  // 列ごと（図の x）の地点の番号と割合、行ごと（図の y）の気圧面の番号と割合を先に求めておく
  const colI = new Int32Array(LW), colF = new Float32Array(LW), rowK = new Int32Array(LH), rowF = new Float32Array(LH);
  for (let cx = 0, i = 0; cx < LW; cx++) {
    const x = x0 + (cx + 0.5) * CELL;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    colI[cx] = i; colF[cx] = Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i])));
  }
  for (let r = 0; r < LH; r++) {
    const lp = Math.log(stdP(hOfY(yTop + (r + 0.5) * CELL)));
    let k = 0; while (k < LV.length - 2 && lp < lnLV[k + 1]) k++;
    rowK[r] = k; rowF[r] = Math.min(1, Math.max(0, (lnLV[k] - lp) / (lnLV[k] - lnLV[k + 1])));
  }
  const val = (G, i, fi, k, fk) => {
    const g = (a, b) => G[a]?.[b];
    const v = [g(i, k), g(i + 1, k), g(i, k + 1), g(i + 1, k + 1)];
    const w = [(1 - fi) * (1 - fk), fi * (1 - fk), (1 - fi) * fk, fi * fk];
    let s2 = 0, ws = 0; v.forEach((q, n) => { if (q != null) { s2 += q * w[n]; ws += w[n]; } });
    return ws > 0.3 ? s2 / ws : null;
  };
  // 圏界面の高さ（ます目の行）を列ごとに
  const tropRow = new Float32Array(LW).fill(NaN);
  for (let cx = 0; cx < LW; cx++) {
    const i = colI[cx], fi = colF[cx], tp = [F.tropP[i], F.tropP[i + 1]];
    const p = tp[0] != null && tp[1] != null ? Math.exp(Math.log(tp[0]) * (1 - fi) + Math.log(tp[1]) * fi) : (tp[0] ?? tp[1]);
    if (p) tropRow[cx] = (L.yOf(stdAlt(p)) - yTop) / CELL;
  }
  // 紫の線：相当温位を ます目ごとに求め、値 F.lineV からの距離（ます目の数）が線の太さの半分以内の所を塗る
  const useLine = LAYERS[kind].includes('frontLine') && F.lineV != null && F.thetaE;
  const TE = useLine ? new Float32Array(LW * LH).fill(NaN) : null;
  if (useLine) for (let cx = 0; cx < LW; cx++) for (let r = 0; r < LH; r++) {
    const v = val(F.thetaE, colI[cx], colF[cx], rowK[r], rowF[r]); if (v != null) TE[r * LW + cx] = v;
  }
  const lineHalf = Math.max(1.5, 7 * s / CELL);              // 線の太さの半分（ます目）。元の図で約14画素の帯
  const onLine = (cx, r) => {
    const v = TE[r * LW + cx]; if (Number.isNaN(v)) return false;
    if (!Number.isNaN(tropRow[cx]) && r < tropRow[cx]) return false;   // 圏界面より上（成層圏）はなぞらない
    const g = (a, b) => { const q = TE[b * LW + a]; return Number.isNaN(q) ? v : q; };
    const gx = (g(Math.min(LW - 1, cx + 1), r) - g(Math.max(0, cx - 1), r)) / 2;
    const gy = (g(cx, Math.min(LH - 1, r + 1)) - g(cx, Math.max(0, r - 1))) / 2;
    const gr = Math.hypot(gx, gy);
    return gr > 1e-6 ? Math.abs(v - F.lineV) / gr <= lineHalf : Math.abs(v - F.lineV) < 0.05;
  };
  const rule = { jet: v => v >= JET_KT, jet100: v => v >= JET2_KT, front: v => v >= FRONT_DEG, moist: v => v >= -MOIST_DD, vws: v => v >= VWS_KT };
  const tropHalf = Math.max(2, 8 * s / CELL);
  for (let cx = 0; cx < LW; cx++) {
    const i = colI[cx], fi = colF[cx];
    for (let r = 0; r < LH; r++) {
      const k = rowK[r], fk = rowF[r];
      let R = 0, G2 = 0, B = 0, A = 0;
      const add = name => { const c = COLORS[name].rgb, a = ALPHA[name] ?? 0.6; R = R * (1 - a) + c[0] * a; G2 = G2 * (1 - a) + c[1] * a; B = B * (1 - a) + c[2] * a; A = A + (1 - A) * a; };
      for (const name of LAYERS[kind]) {
        if (name === 'trop') { if (!Number.isNaN(tropRow[cx]) && Math.abs(r - tropRow[cx]) <= tropHalf) add('trop'); continue; }
        if (name === 'frontLine') { if (useLine && onLine(cx, r)) add('frontLine'); continue; }
        const v = val(F[name === 'jet100' ? 'jet' : name], i, fi, k, fk);
        if (v != null && rule[name](v)) add(name);
      }
      if (A > 0) { const o = (r * LW + cx) * 4; d[o] = R / A; d[o + 1] = G2 / A; d[o + 2] = B / A; d[o + 3] = A * 255; }
    }
  }
  lx.putImageData(img, 0, 0);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(lc, x0, yTop, LW * CELL, LH * CELL);
}

/**
 * 図（canvas / img、測った寸法に対する倍率 s）に合わせた色付けの canvas を作る。
 *   init … 図の時刻（AXJP は解析時刻、FXJP は初期時刻）
 *   返り値 { overlay, colored, found, lines }。colored は元の図に色を掛け合わせたもの（一覧・拡大表示用）
 *   lines … FXJP の紫でなぞった相当温位（K）。{ 6: 315, 12: 315 } のように予想時間ごと（前線帯がなければ null）
 */
export async function colorSection(kind, src, s, init) {
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  const overlay = document.createElement('canvas'); overlay.width = W; overlay.height = H;
  const octx = overlay.getContext('2d');
  const panels = kind === 'fxjp' ? [6, 12] : [140, 130];
  const found = new Set(), lines = {};
  const t0 = kind === 'fxjp' ? new Date(init.getTime() + 6 * 3600e3) : init, t1 = kind === 'fxjp' ? new Date(init.getTime() + 12 * 3600e3) : init;
  for (const panel of panels) {
    const L = layoutOf(kind, panel, s);
    // AXJP の枠は 50°N〜24.5°N だが、値が描かれているのは観測地点の範囲だけなので、地点の間だけ塗る
    if (kind === 'axjp') L.anchors = L.anchors.slice(1, -1);
    const pts = linePoints(L);
    const raw = await fetchPoints(pts, kind === 'fxjp', t0, t1);
    const valid = kind === 'fxjp' ? new Date(init.getTime() + panel * 3600e3) : init;
    const F = fieldsAt(pts, raw, valid, L);
    if (!F) continue;
    if (kind === 'fxjp') { F.lineV = frontLineValue(F); lines[panel] = F.lineV; if (F.lineV != null) found.add('frontLine'); }
    paintPanel(octx, kind, panel, s, pts, F);
    if (F.jet.flat().some(v => v >= JET_KT)) found.add('jet');
    if (F.jet.flat().some(v => v >= JET2_KT)) found.add('jet100');
    if (F.front.flat().some(v => v >= FRONT_DEG)) found.add('front');
    if (F.vws.flat().some(v => v >= VWS_KT)) found.add('vws');
    if (F.tropP.some(v => v != null)) found.add('trop');
  }
  // 一覧・拡大用：元の図に色を「掛け合わせる」（黒い線は黒のまま、白地だけ色が付く）
  const colored = document.createElement('canvas'); colored.width = W; colored.height = H;
  const cx = colored.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H); cx.drawImage(src, 0, 0);
  cx.globalCompositeOperation = 'multiply'; cx.drawImage(overlay, 0, 0); cx.globalCompositeOperation = 'source-over';
  return { overlay, colored, found, lines };
}

/** 凡例の HTML。lines（colorSection の返り値）を渡すと、紫でなぞった相当温位の値も書く */
export function legendHtml(kind, lines = null) {
  return LAYERS[kind].map(n => {
    const c = COLORS[n].rgb;
    let label = COLORS[n].label;
    if (n === 'frontLine' && lines) {
      const t = Object.entries(lines).map(([p, v]) => `${p}h ${v == null ? '前線帯なし' : v + 'K'}`).join(' / ');
      label += `（${t}）`;
    }
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="display:inline-block;width:12px;height:12px;border-radius:2px;background:rgb(${c.join(',')})"></i>${label}</span>`;
  }).join('');
}
