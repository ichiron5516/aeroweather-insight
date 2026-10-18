// 高層天気図（AUPQ78・AUPQ35・AUPA25・AUPA20）の等高線を読み取って、気圧面を 3D の波打つ面として表示する
//   850・700・500・300・250・200hPa。表示するのは「気圧面」と「風の矢羽根」だけ
//
//   1) 等高線の形：気象庁の PDF はベクトル図形なので、pdf.js で線をそのまま取り出す。
//      黒い実線のうち、太線（等高線の太線）と細い長い実線（細い等高線）を等高線とみなす。
//      点線（等温線・等風速線）は短い線の集まりなので除き、文字（数字・H・L）は小さいので除く。
//      PDF の座標 → 緯度経度 は chartOverlay.js の投影（ポーラーステレオ）で変換する
//   2) 等高線の値：図の数字（等高線の切れ目に書かれた「5700」など）も線で描かれているので、線の形を字の見本と比べて読む。
//      札の両側で切れている線にその値を付ける。数字の無い線は、同じ解析時刻の気象庁 GSM の高度（Open-Meteo 経由、2.5度ごと）を
//      線に沿って平均し、図の数字とのずれを差し引いて、等高線の間隔（850〜500hPa は 60m、300〜200hPa は 120m）の倍数に合わせる。
//      GSM が使えないとき（利用回数の上限など）は、数字の付いた線から面を作って値を決める
//   3) 面の形：等高線の値を格子（0.5度）に置き、その間をなめらかにつなぐ（ラプラス方程式で補間）
//   4) 表示：気圧面ごとに1色（850 緑・700 水色・500 青・300 紫・250 橙・200 赤）。高さは色ではなく、面の波打ちと陰影だけで表す。
//      等高線や数字は描かない。風は天気図の観測値の矢羽根を読み取って、面の上に置く（軸の向き＝風向、旗・羽根の数＝風速）
//      「波だけ」（既定）は、各緯度で東西に平均した高さを引いた偏差で波打たせる。南北の大きな傾きが消え、
//      気圧の谷・低圧部がくぼみ、峰が盛り上がりとして見える。「実際の高さ」に切り替えられる
//   5) 天気図の「L」「H」（低気圧・高気圧の中心）を読み取り、面の上に目印を立てる
//   6) 「波だけ」の偏差から、気圧の谷（赤の破線）・峰（黄の線）の軸を求めて面の上に引く
//   高さは画面の高度倍率と「起伏」の倍率に合わせる
import * as Cesium from 'cesium';
import { PROJ, projForward, projInverse } from './chartOverlay.js';
import { barbImage } from '../gpvLayer.js';

const JMA = 'https://www.jma.go.jp/bosai/numericmap/data/nwpmap';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168';
const OM = 'https://api.open-meteo.com/v1/forecast';
export const CHART_LEVELS = { aupq78: [850, 700], aupq35: [500, 300], aupa25: [250], aupa20: [200] };
const INTERVAL = { 850: 60, 700: 60, 500: 60, 300: 120, 250: 120, 200: 120 };
const LEVELS = [850, 700, 500, 300, 250, 200];
// 面を作る範囲と細かさ（0.5度）
const D = { w: 110, e: 160, s: 20, n: 60, d: 0.5 };
const DX = Math.round((D.e - D.w) / D.d) + 1, DY = Math.round((D.n - D.s) / D.d) + 1;
// GSM の高度（2.5度）と風（5度）
const M = { w: 110, e: 160, s: 20, n: 60, d: 2.5 };
const MX = Math.round((M.e - M.w) / M.d) + 1, MY = Math.round((M.n - M.s) / M.d) + 1;

let pdfjs = null;
const pdf = async () => (pdfjs ||= await import(/* @vite-ignore */ `${PDFJS}/pdf.min.mjs`).then(m => { m.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`; return m; }));

/** 解析時刻（天気図と同じ。15〜03UTC は 12UTC、03〜15UTC は 00UTC） */
export function analysisTime(now = new Date()) {
  const h = now.getUTCHours(), cyc = h >= 15 || h < 3 ? 12 : 0;
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cyc));
  if (t > now) t.setUTCDate(t.getUTCDate() - 1);
  return { t, cyc: String(cyc).padStart(2, '0') };
}

// ---------- 1) PDF から等高線と数字を取り出す ----------
export async function readPdf(chart, cyc) {
  const pj = await pdf();
  const doc = await pj.getDocument({ url: `${JMA}/${chart}_${cyc}.pdf`, withCredentials: false }).promise;
  const page = await doc.getPage(1), H = page.getViewport({ scale: 1 }).height;
  const ol = await page.getOperatorList(), O = pj.OPS;
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let ctm = [1, 0, 0, 1, 0, 0], color = '0,0,0', lw = 1; const stack = [];
  const lines = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i];
    if (f === O.save) stack.push([ctm, color, lw]);
    else if (f === O.restore) [ctm, color, lw] = stack.pop() || [ctm, color, lw];
    else if (f === O.transform) ctm = mul(ctm, a);
    else if (f === O.setStrokeRGBColor) color = typeof a[0] === 'string' ? a[0] : Array.from(a).join(',');
    else if (f === O.setLineWidth) lw = a[0];
    else if (f === O.constructPath) {
      const w = lw * Math.hypot(ctm[0], ctm[1]);
      const black = color === '0,0,0' || color === '#000000', white = color === '255,255,255' || color === '#ffffff';
      const thick = w > 1.0 && w < 1.25, thin = w > 0.5 && w < 0.65;          // 等高線の太線・細線、数字（ページ座標での線の太さ）
      const cls = white ? 'white' : black && thick ? 'thick' : black && thin ? 'thin' : null;
      if (!cls) continue;
      const [ops, xy] = a; let k = 0, cur = null;
      const P = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], H - (ctm[1] * x + ctm[3] * y + ctm[5])];
      for (const op of ops) {
        if (op === O.moveTo) { cur = [P(xy[k], xy[k + 1])]; cur.cls = cls; k += 2; lines.push(cur); }
        else if (op === O.lineTo) { cur?.push(P(xy[k], xy[k + 1])); k += 2; }
        else if (op === O.curveTo) { cur?.push(P(xy[k + 4], xy[k + 5])); k += 6; }
        else if (op === O.curveTo2 || op === O.curveTo3) { cur?.push(P(xy[k + 2], xy[k + 3])); k += 4; }
        else if (op === O.rectangle) k += 4;
        else if (op === O.closePath && cur?.length) cur.push(cur[0]);
      }
    }
  }
  const box = l => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
  // 大きさ 30 以上の線＝等高線（文字・矢羽根・点線の一片は小さい）。14 以下＝文字の画
  //   AUPQ の文字は、白い縁取り（同じ形の白い太線）の上に黒で描かれている。縁取りのある画だけを文字とみなす
  //   （点線の等温線などの短い線が数字に重なっても、別のものとして分けられる）。縁取りの無い AUPA は太い画だけを文字とみなす
  const kf = l => `${l[0][0].toFixed(1)},${l[0][1].toFixed(1)},${l.at(-1)[0].toFixed(1)},${l.at(-1)[1].toFixed(1)}`;
  const halo = new Set(lines.filter(l => l.cls === 'white' && l.length).map(kf));
  const big = [], small = [];
  for (const l of lines) {
    if (!l.length || l.cls === 'white') continue;
    const b = box(l), d = Math.hypot(b[2] - b[0], b[3] - b[1]);
    if (d > 30 && l.length >= 4) big.push(l);
    else if (d <= 14 && (halo.size ? halo.has(kf(l)) : l.cls === 'thick')) small.push({ s: l, b, cls: l.cls });
  }
  const barbs = readBarbs(lines.filter(l => l.cls === 'thin' && l.length >= 2));
  // 面（気圧面）ごとに分ける
  const out = {};
  for (const [lv, Pj] of Object.entries(PROJ[chart].panels)) {
    const [fx0, fy0, fx1, fy1] = Pj.frame;
    const inF = ([x, y]) => x >= fx0 + 1 && x <= fx1 - 1 && y >= fy0 + 1 && y <= fy1 - 1;
    // 枠の外に出た所で線を切る（別の面の線や、枠の外の部分を除く）
    const pieces = [];
    for (const l of big) { let cur = []; for (const q of l) { if (inF(q)) cur.push(q); else { if (cur.length >= 4) pieces.push(cur); cur = []; } } if (cur.length >= 4) pieces.push(cur); }
    const labels = readLabels(small.filter(g => inF([g.b[0], g.b[1]]) && inF([g.b[2], g.b[3]])));
    out[lv] = { proj: Pj, pieces, labels,
      marks: labels.marks.map(m => { const [la, lo] = projInverse(Pj, 1, m.cx, m.cy); return { ch: m.ch, lat: la, lon: lo }; }),
      barbs: barbs.filter(b => inF(b.st)).map(b => {
        const [la, lo] = projInverse(Pj, 1, ...b.st), [la2, lo2] = projInverse(Pj, 1, ...b.tip);
        const p1 = la * Math.PI / 180, p2 = la2 * Math.PI / 180, dl = (lo2 - lo) * Math.PI / 180;
        const dir = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
        return [la, lo, b.kt, dir];          // 軸は観測点から風上へ伸びる＝その向きが風向
      }) };
  }
  return out;
}

// ---- 図の矢羽根（観測値）を読む ----
//   矢羽根は、観測点から風上へ伸びる軸（長さ約13）＋旗（50kt）・長い羽根（10kt）・短い羽根（5kt）。
//   描く順番は「軸（観測点 → 先端）」のすぐ後に、その軸に付く旗・羽根が続く。
//   旗は、軸の上の同じ点から扇形に引いた線の重なり（塗りつぶしの代わり）で描かれている
function readBarbs(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], a = l[0], b = l[1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 12 || L > 14.5) continue;                     // 軸
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const onShaft = q => { const vx = q[0] - a[0], vy = q[1] - a[1], t = vx * ux + vy * uy; return Math.abs(-vx * uy + vy * ux) < 0.35 && t > -0.3 && t < L + 0.3; };
    const fans = new Set(); let kt = 0;
    // 軸の線の続き（旗の輪郭）は飛ばし、その後の線が軸の上から始まる間を、この矢羽根の部品とみなす
    let j = i + 1;
    for (; j < lines.length && j < i + 30; j++) {
      const m = lines[j], s0 = m[0];
      if (!onShaft(s0) && !onShaft(m.at(-1))) break;
      const len = Math.hypot(m.at(-1)[0] - s0[0], m.at(-1)[1] - s0[1]);
      if (m.length >= 3) fans.add(`${s0[0].toFixed(1)},${s0[1].toFixed(1)}`);   // 旗（扇形の線）
      else if (len >= 4.3) kt += 10;                                             // 長い羽根
      else if (len >= 2) kt += 5;                                                // 短い羽根
    }
    kt += 50 * fans.size;
    out.push({ st: a, tip: b, kt });
    i = j - 1;
  }
  return out;
}

// ---- 図の数字を読む ----
//   気象庁の天気図の文字は、線で描いた簡単な字体（幅は高さの 0.57）。字ごとの線の形（高さを 1 にした座標）を見本にする
const FONT = {
  0: [[[0, .857], [0, .143], [.143, 0], [.429, 0], [.571, .143], [.571, .857], [.429, 1], [.143, 1], [0, .857]]],
  1: [[[0, 1], [.286, 1]], [[.143, 1], [.143, 0], [0, .143]]],
  '1b': [[[.143, 1], [.143, 0], [0, .143]]],
  2: [[[.571, 1], [0, 1], [0, .857], [.571, .429], [.571, .143], [.429, 0], [.143, 0], [0, .143]]],
  3: [[[0, .857], [.143, 1], [.429, 1], [.571, .857], [.571, .571], [.429, .429], [.571, .286], [.571, .143], [.429, 0], [.143, 0], [0, .143]], [[.143, .429], [.429, .429]]],
  4: [[[.571, .714], [0, .714], [.429, 0], [.429, 1]]],
  5: [[[.571, 0], [0, 0], [0, .429], [.429, .429], [.571, .571], [.571, .857], [.429, 1], [.143, 1], [0, .857]]],
  6: [[[.571, 0], [0, .571], [0, .857], [.143, 1], [.429, 1], [.571, .857], [.571, .571], [.429, .429], [.143, .429]]],
  7: [[[0, 0], [.571, 0], [0, 1]]],
  8: [[[.571, .143], [.571, .286], [.429, .429]], [[.143, .429], [0, .571], [0, .857], [.143, 1], [.429, 1], [.571, .857], [.571, .571], [.429, .429], [.143, .429], [0, .286], [0, .143], [.143, 0], [.429, 0], [.571, .143]]],
  9: [[[0, 1], [.571, .429], [.571, .143], [.429, 0], [.143, 0], [0, .143], [0, .429], [.143, .571], [.429, .571]]],
  H: [[[0, 1], [0, 0]], [[.571, 0], [.571, 1]], [[.571, .429], [0, .429]]],
  L: [[[0, 0], [0, 1], [.571, 1]]],
};
const GW = 10, GH = 16;
function raster(segs) {                      // 高さ 1 の座標の線を 10×16 の升目に（1升ふくらませる）
  const g = new Uint8Array(GW * GH);
  for (const s of segs) for (let i = 0; i + 1 < s.length; i++) {
    const [a, b] = s[i], [c, d] = s[i + 1], n = Math.ceil(Math.hypot(c - a, d - b) * 40) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.round((a + (c - a) * k / n) * (GH - 1)), y = Math.round((b + (d - b) * k / n) * (GH - 1));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) g[yy * GW + xx] = 1; }
    }
  }
  return g;
}
const PROTO = Object.entries(FONT).map(([ch, segs]) => ({ ch: ch === '1b' ? '1' : ch, g: raster(segs), w: Math.max(...segs.flat().map(p => p[0])) }));
function classify(segs, b) {
  const h = Math.max(1e-6, b[3] - b[1]);
  const ns = segs.map(s => s.map(([x, y]) => [(x - b[0]) / h, (y - b[1]) / h]));
  const g = raster(ns), w = (b[2] - b[0]) / h;
  let best = null, bs = 0;
  for (const p of PROTO) {
    if (Math.abs(p.w - w) > 0.12) continue;
    let and = 0, or = 0; for (let k = 0; k < g.length; k++) { and += g[k] & p.g[k]; or += g[k] | p.g[k]; }
    const s = or ? and / or : 0; if (s > bs) { bs = s; best = p.ch; }
  }
  return { ch: bs >= CLS_MIN ? best : null, guess: best, score: bs, w };
}
const CLS_MIN = 0.5;
/** 文字の画（小さな線）を字にまとめ、横に並んだ字を数字の札にする */
export function readLabels(strokes) {
  // 重なる画を1つの字に
  const par = strokes.map((_, i) => i), f = i => (par[i] === i ? i : (par[i] = f(par[i])));
  const ov = (a, b, t) => a[0] - t <= b[2] && b[0] - t <= a[2] && a[1] - t <= b[3] && b[1] - t <= a[3];
  const cell = new Map(), key = (x, y) => `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
  strokes.forEach((s, i) => { const k = key(s.b[0], s.b[1]); (cell.get(k) || cell.set(k, []).get(k)).push(i); });
  strokes.forEach((s, i) => {
    const cx = Math.floor(s.b[0] / 10), cy = Math.floor(s.b[1] / 10);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of cell.get(`${cx + dx},${cy + dy}`) || []) if (j > i && s.cls === strokes[j].cls && ov(s.b, strokes[j].b, 0.3)) par[f(i)] = f(j);
  });
  const groups = new Map(); strokes.forEach((s, i) => { const r = f(i); (groups.get(r) || groups.set(r, []).get(r)).push(s); });
  const chars = [];
  for (const ss of groups.values()) {
    const b = [Math.min(...ss.map(s => s.b[0])), Math.min(...ss.map(s => s.b[1])), Math.max(...ss.map(s => s.b[2])), Math.max(...ss.map(s => s.b[3]))];
    const h = b[3] - b[1]; if (h < 4 || h > 12) continue;
    const c = classify(ss.map(s => s.s), b);
    readLabels.debug?.push({ ...c, b });
    if (c.ch) chars.push({ ch: c.ch, b, h, cy: (b[1] + b[3]) / 2 });
  }
  // 同じ高さ・同じ行で、すき間の小さい字をつなげる
  chars.sort((a, b) => a.b[0] - b.b[0]);
  const used = new Set(), labels = [], marks = [];
  for (let i = 0; i < chars.length; i++) {
    if (used.has(i)) continue;
    const row = [chars[i]]; used.add(i);
    for (let j = i + 1; j < chars.length; j++) {
      const last = row.at(-1), c = chars[j];
      if (c.b[0] - last.b[2] > last.h * 0.8) { if (c.b[0] - last.b[2] > last.h * 3) break; continue; }
      if (used.has(j) || Math.abs(c.cy - last.cy) > last.h * 0.25 || Math.abs(c.h - last.h) > last.h * 0.2 || c.b[0] < last.b[2] - 0.5) continue;
      row.push(c); used.add(j);
    }
    const str = row.map(c => c.ch).join('');
    if (/^\d{3,5}$/.test(str)) labels.push({ v: +str, cx: (row[0].b[0] + row.at(-1).b[2]) / 2, cy: row[0].cy, w: row.at(-1).b[2] - row[0].b[0], h: row[0].h });
    else if (str === 'H' || str === 'L') marks.push({ ch: str, cx: (row[0].b[0] + row[0].b[2]) / 2, cy: row[0].cy });   // 高気圧・低気圧の中心
  }
  labels.marks = marks;
  return labels;
}
// ---------- 2) GSM の高度・風（同じ解析時刻） ----------
async function fetchModel(t, onWait) {
  const key = `aw_upper_gsm2_${t.toISOString().slice(0, 13)}`;
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c?.Z) return c; } catch { /* 使えなければ取り直す */ }
  const hr = t.toISOString().slice(0, 13) + ':00';
  const get = async (pts, vars) => {
    const u = `${OM}?latitude=${pts.map(p => p[0]).join(',')}&longitude=${pts.map(p => p[1]).join(',')}&hourly=${vars.join(',')}` +
      `&models=jma_gsm&start_hour=${hr}&end_hour=${hr}&wind_speed_unit=kn&timezone=GMT`;
    for (let tries = 0; ; tries++) {
      const r = await fetch(u);
      if (r.ok) { const j = await r.json(); return Array.isArray(j) ? j : [j]; }
      const j = await r.json().catch(() => ({})), why = j.reason || '';
      if (/minutely/i.test(why) && tries < 3) { onWait?.(); await new Promise(ok => setTimeout(ok, 61e3)); continue; }
      throw new Error(/daily/i.test(why) ? 'Open-Meteo の1日の利用上限に達しました（日本時間の朝9時ごろに戻ります）'
        : /hourly/i.test(why) ? 'Open-Meteo の1時間の利用上限に達しました（次の正時を過ぎてから試してください）' : `Open-Meteo ${r.status} ${why}`);
    }
  };
  // 高度（2.5度ごと・6要素＝1地点1回）
  const pts = []; for (let i = 0; i < MY; i++) for (let j = 0; j < MX; j++) pts.push([M.s + i * M.d, M.w + j * M.d]);
  const Z = Object.fromEntries(LEVELS.map(p => [p, new Array(pts.length).fill(null)]));
  for (let s = 0; s < pts.length; s += 100) {
    const b = pts.slice(s, s + 100), res = await get(b, LEVELS.map(p => `geopotential_height_${p}hPa`));
    b.forEach((_, n) => LEVELS.forEach(p => { Z[p][s + n] = res[n].hourly?.[`geopotential_height_${p}hPa`]?.[0] ?? null; }));
  }
  const data = { Z };
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* 保存できなくても続ける */ }
  return data;
}
const modelZ = (Z, lat, lon) => {
  const x = (lon - M.w) / M.d, y = (lat - M.s) / M.d;
  if (x < 0 || y < 0 || x > MX - 1 || y > MY - 1) return NaN;
  const j0 = Math.min(MX - 2, Math.floor(x)), i0 = Math.min(MY - 2, Math.floor(y)), fx = x - j0, fy = y - i0;
  const g = (i, j) => Z[i * MX + j] ?? NaN;
  return (g(i0, j0) * (1 - fx) + g(i0, j0 + 1) * fx) * (1 - fy) + (g(i0 + 1, j0) * (1 - fx) + g(i0 + 1, j0 + 1) * fx) * fy;
};

const RANGE = { 850: [900, 1800], 700: [2400, 3400], 500: [4800, 6100], 300: [8000, 9900], 250: [9100, 11200], 200: [10400, 12700] };
/**
 * 等高線に値を付ける
 *   1) 図の数字：数字の札の両側で切れている線（札の近くに端がある線）にその値を付ける。端どうしが近い線は同じ線としてつなぐ
 *   2) 数字の付かなかった線：GSM の高度を線に沿って平均し、図の数字とのずれを差し引いて、間隔の倍数に合わせる。
 *      GSM が使えないときは、数字の付いた線だけで面を作り、その面の高さに合わせる
 */
function assignValues(pieces, labels, Pj, Z, I, p) {
  const [r0, r1] = RANGE[p];
  const lab = labels.filter(l => l.v % I === 0 && l.v >= r0 && l.v <= r1);
  const ll = pieces.map(l => l.map(([x, y]) => projInverse(Pj, 1, x, y)));
  // 端どうしが近い線をつなぐ
  const par = pieces.map((_, i) => i), f = i => (par[i] === i ? i : (par[i] = f(par[i])));
  const ends = pieces.flatMap((l, i) => [[l[0], i], [l.at(-1), i]]);
  for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
    if (ends[a][1] === ends[b][1]) continue;
    if (Math.hypot(ends[a][0][0] - ends[b][0][0], ends[a][0][1] - ends[b][0][1]) < 3) par[f(ends[a][1])] = f(ends[b][1]);
  }
  // 数字の札 → 近くに端がある線
  const votes = new Map();
  for (const L of lab) {
    const r = L.w / 2 + L.h * 1.2;
    for (const [q, i] of ends) if (Math.hypot(q[0] - L.cx, q[1] - L.cy) < r) {
      const g = f(i), m = votes.get(g) || new Map(); m.set(L.v, (m.get(L.v) || 0) + 1); votes.set(g, m);
    }
  }
  const val = new Map();
  for (const [g, m] of votes) val.set(g, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  const nLabeled = pieces.filter((_, i) => val.has(f(i))).length;
  // 数字の付かなかった線
  const med = arr => { const v = arr.filter(isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
  let how = 'label';
  if (Z) {
    const mz = pieces.map((_, i) => med(ll[i].map(([la, lo]) => modelZ(Z, la, lo))));
    const diffs = pieces.map((_, i) => (val.has(f(i)) && isFinite(mz[i]) ? mz[i] - val.get(f(i)) : NaN)).filter(isFinite);
    let bias = med(diffs);
    if (!isFinite(bias)) { const res = mz.filter(isFinite).map(m => m - Math.round(m / I) * I); bias = med(res); if (!isFinite(bias)) bias = 0; }
    pieces.forEach((_, i) => { const g = f(i); if (!val.has(g) && isFinite(mz[i])) val.set(g, Math.round((mz[i] - bias) / I) * I); });
    how = 'model';
  } else if (val.size) {
    const known = pieces.map((_, i) => (val.has(f(i)) ? { pts: ll[i], v: val.get(f(i)) } : null)).filter(Boolean);
    const fld = buildField(known, null, Pj);
    pieces.forEach((_, i) => { const g = f(i); if (!val.has(g)) { const m = med(ll[i].map(([la, lo]) => fieldAt(fld, la, lo))); if (isFinite(m)) val.set(g, Math.round(m / I) * I); } });
    how = 'interp';
  }
  const contours = pieces.map((_, i) => (val.has(f(i)) ? { pts: ll[i], v: val.get(f(i)), labeled: votes.has(f(i)) } : null)).filter(Boolean);
  return { contours, nLabeled, nAll: pieces.length, nLabels: lab.length, how };
}

// ---------- 3) 面（格子）を作る ----------
function buildField(contours, Z, Pj) {
  const N = DX * DY, h = new Float64Array(N), fixed = new Uint8Array(N), valid = new Uint8Array(N), sum = new Float64Array(N), cnt = new Uint16Array(N);
  const [fx0, fy0, fx1, fy1] = Pj.frame;
  for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
    const la = D.s + i * D.d, lo = D.w + j * D.d, k = i * DX + j;
    const [x, y] = projForward(Pj, 1, la, lo);
    const z = Z ? modelZ(Z, la, lo) : NaN;
    if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1 && (!Z || isFinite(z))) { valid[k] = 1; h[k] = Z ? z : NaN; }
  }
  // 等高線を 0.1度ごとに細かくして、近い格子点に値を置く
  for (const c of contours) for (let n = 0; n + 1 < c.pts.length; n++) {
    const [a0, b0] = c.pts[n], [a1, b1] = c.pts[n + 1], m = Math.max(1, Math.ceil(Math.max(Math.abs(a1 - a0), Math.abs(b1 - b0)) / 0.1));
    for (let q = 0; q < m; q++) {
      const la = a0 + (a1 - a0) * q / m, lo = b0 + (b1 - b0) * q / m;
      const i = Math.round((la - D.s) / D.d), j = Math.round((lo - D.w) / D.d);
      if (i < 0 || j < 0 || i >= DY || j >= DX) continue;
      const k = i * DX + j; if (!valid[k]) continue;
      sum[k] += c.v; cnt[k]++;
    }
  }
  for (let k = 0; k < N; k++) if (cnt[k]) { h[k] = sum[k] / cnt[k]; fixed[k] = 1; }
  // GSM が無いときは、等高線の値の平均から始める（なじませる回数を増やす）
  if (!Z) { let s0 = 0, c0 = 0; for (let k = 0; k < N; k++) if (fixed[k]) { s0 += h[k]; c0++; } const m0 = c0 ? s0 / c0 : 0; for (let k = 0; k < N; k++) if (valid[k] && !fixed[k]) h[k] = m0; }
  // 等高線のない所をなじませる（ガウス・ザイデル法＋過緩和。範囲の端は外へ同じ値が続くとみなす）
  for (let it = 0, n = Z ? 500 : 2500; it < n; it++) {
    for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
      const k = i * DX + j; if (!valid[k] || fixed[k]) continue;
      let s = 0, c = 0;
      if (j > 0 && valid[k - 1]) { s += h[k - 1]; c++; } if (j < DX - 1 && valid[k + 1]) { s += h[k + 1]; c++; }
      if (i > 0 && valid[k - DX]) { s += h[k - DX]; c++; } if (i < DY - 1 && valid[k + DX]) { s += h[k + DX]; c++; }
      if (c) h[k] += 1.7 * (s / c - h[k]);
    }
  }
  return { h, valid };
}

// ---------- 4) 描く ----------
/** 面の統計（最低・最高・平均、色に使う 5〜95% の範囲） */
function stats(field) {
  const v = []; for (let k = 0; k < field.h.length; k++) if (field.valid[k]) v.push(field.h[k]);
  v.sort((a, b) => a - b);
  const q = f => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
  return { lo: v[0], hi: v.at(-1), mean: v.reduce((a, b) => a + b, 0) / v.length, c0: q(0.05), c1: q(0.95) };
}
export const LEVEL_COLOR = { 850: '#43a047', 700: '#00acc1', 500: '#1e88e5', 300: '#8e24aa', 250: '#fb8c00', 200: '#e53935' };
async function surfacePrimitive(field, disp, alpha, css) {      // disp＝格子ごとの表示する高さ(m)、css＝その気圧面の色
  const { valid } = field, { lo, hi } = stats(field), h = disp;
  // 色の画像（格子1点＝1画素、北が上）。1色で塗り、北西から光を当てた陰影で波打ちを見せる（高さの色分けはしない）
  const base = Cesium.Color.fromCssColorString(css), rgb = [base.red * 255, base.green * 255, base.blue * 255];
  const cv = document.createElement('canvas'); cv.width = DX; cv.height = DY;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(DX, DY);
  const g = (i, j) => (i >= 0 && j >= 0 && i < DY && j < DX && valid[i * DX + j] ? h[i * DX + j] : NaN);
  const sh = new Float32Array(DX * DY);
  for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
    const k = i * DX + j; if (!valid[k]) continue;
    const ex = (isFinite(g(i, j + 1)) ? g(i, j + 1) : h[k]) - (isFinite(g(i, j - 1)) ? g(i, j - 1) : h[k]);
    const ny = (isFinite(g(i + 1, j)) ? g(i + 1, j) : h[k]) - (isFinite(g(i - 1, j)) ? g(i - 1, j) : h[k]);
    sh[k] = ex - ny;                                       // 北西から光（西・北に向いた斜面が明るい）→ 東へ上る所は暗く
  }
  const absv = []; for (let k = 0; k < sh.length; k++) if (valid[k]) absv.push(Math.abs(sh[k]));
  absv.sort((a, b) => a - b); const q = absv[Math.floor(absv.length * 0.95)] || 1;
  for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
    const k = i * DX + j, o = ((DY - 1 - i) * DX + j) * 4; if (!valid[k]) continue;
    const f = 0.78 - 0.32 * Math.max(-1, Math.min(1, sh[k] / q));
    img.data[o] = Math.min(255, rgb[0] * f + 20); img.data[o + 1] = Math.min(255, rgb[1] * f + 20); img.data[o + 2] = Math.min(255, rgb[2] * f + 20); img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const url = URL.createObjectURL(await new Promise(ok => cv.toBlob(ok, 'image/png')));
  // 格子の網
  const pos = [], st = [], idx = [], map = new Int32Array(DX * DY).fill(-1);
  for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
    const k = i * DX + j; if (!valid[k]) continue;
    const p = Cesium.Cartesian3.fromDegrees(D.w + j * D.d, D.s + i * D.d, h[k]);
    map[k] = pos.length / 3; pos.push(p.x, p.y, p.z); st.push((j + 0.5) / DX, (i + 0.5) / DY);
  }
  for (let i = 0; i < DY - 1; i++) for (let j = 0; j < DX - 1; j++) {
    const a = map[i * DX + j], b = map[i * DX + j + 1], c = map[(i + 1) * DX + j], d = map[(i + 1) * DX + j + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    idx.push(a, b, d, a, d, c);
  }
  const positions = new Float64Array(pos);
  let geom = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array(st) }),
    },
    indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });
  geom = Cesium.GeometryPipeline.computeNormal(geom);
  const prim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry: geom }),
    appearance: new Cesium.MaterialAppearance({ materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED, translucent: true, faceForward: true, closed: false,
      material: Cesium.Material.fromType('Image', { image: url, color: new Cesium.Color(1, 1, 1, alpha) }) }),
    asynchronous: false,
  });
  prim._url = url;
  return { prim, lo, hi };
}
/** 面の上の高さ（格子から内挿） */
function fieldAt(field, lat, lon) {
  const x = (lon - D.w) / D.d, y = (lat - D.s) / D.d;
  const j = Math.round(x), i = Math.round(y);
  if (i < 0 || j < 0 || i >= DY || j >= DX || !field.valid[i * DX + j]) return NaN;
  const j0 = Math.min(DX - 2, Math.floor(x)), i0 = Math.min(DY - 2, Math.floor(y)), fx = x - j0, fy = y - i0, g = (a, b) => field.h[a * DX + b];
  return (g(i0, j0) * (1 - fx) + g(i0, j0 + 1) * fx) * (1 - fy) + (g(i0 + 1, j0) * (1 - fx) + g(i0 + 1, j0 + 1) * fx) * fy;
}

/**
 * 表示する高さ（格子ごと）
 *   mode 'wave'   … 各緯度で東西に平均した高さを引いた「偏差」だけを波打ちにする（南北の大きな傾きを取り除く）。
 *                   谷・低圧部はくぼみ、峰は盛り上がりになる。面の基準の高さは、その気圧面の平均の高さ
 *   mode 'actual' … 実際の高さ（平均からのずれを強調）
 */
function displayHeights(field, mode, wave, k) {
  const { h, valid } = field, st = stats(field), out = new Float64Array(h.length);
  const zm = new Float64Array(DY);
  for (let i = 0; i < DY; i++) { let s0 = 0, c = 0; for (let j = 0; j < DX; j++) if (valid[i * DX + j]) { s0 += h[i * DX + j]; c++; } zm[i] = c ? s0 / c : st.mean; }
  // ずれ（偏差）を求め、細かい段差をならす（等高線の上に値を置いて作った面は、線の所で階段状になるため。0.5度の格子で3回ぼかす）
  let a = new Float64Array(h.length);
  for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) { const kk = i * DX + j; if (valid[kk]) a[kk] = h[kk] - (mode === 'wave' ? zm[i] : st.mean); }
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float64Array(h.length);
    for (let i = 0; i < DY; i++) for (let j = 0; j < DX; j++) {
      const kk = i * DX + j; if (!valid[kk]) continue;
      let s0 = 0, c = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= DY || jj >= DX || !valid[ii * DX + jj]) continue; s0 += a[ii * DX + jj]; c++; }
      b[kk] = s0 / c;
    }
    a = b;
  }
  for (let kk = 0; kk < h.length; kk++) if (valid[kk]) out[kk] = (st.mean + a[kk] * wave) * k;
  out.anom = a;
  return out;
}

/**
 * 気圧の谷・峰の軸（「波だけ」の偏差から）
 *   緯度ごとに東西方向を見て、まわり（±4度）でいちばん低い所＝谷、いちばん高い所＝峰の候補にする（偏差が ±20m 以上のもの）。
 *   隣の緯度の候補と経度 2.5度以内でつなぎ、南北に 5度以上続くものを軸とする
 */
function troughRidgeAxes(field, anom) {
  const { valid } = field, W = Math.round(4 / D.d), out = [];
  for (const kind of ['trough', 'ridge']) {
    const sgn = kind === 'trough' ? -1 : 1, rows = [];
    for (let i = 0; i < DY; i++) {
      const la = D.s + i * D.d, pts = [];
      if (la < 25 || la > 58) { rows.push(pts); continue; }
      for (let j = 0; j < DX; j++) {
        const kk = i * DX + j; if (!valid[kk] || sgn * anom[kk] < 20) continue;
        let ext = true;
        for (let d = -W; d <= W && ext; d++) { const jj = j + d; if (d && jj >= 0 && jj < DX && valid[i * DX + jj] && sgn * anom[i * DX + jj] > sgn * anom[kk]) ext = false; }
        if (ext) pts.push(D.w + j * D.d);
      }
      rows.push(pts);
    }
    // 南から北へつなぐ
    const open = [];
    for (let i = 0; i < DY; i++) {
      const la = D.s + i * D.d, used = new Set();
      for (const ch of open) {
        if (ch.done) continue;
        const last = ch.pts.at(-1);
        let best = null;
        rows[i].forEach((lo, n) => { if (!used.has(n) && Math.abs(lo - last[1]) <= 2.5 && (!best || Math.abs(lo - last[1]) < Math.abs(best[1] - last[1]))) best = [n, lo]; });
        if (best) { used.add(best[0]); ch.pts.push([la, best[1]]); } else ch.done = true;
      }
      rows[i].forEach((lo, n) => { if (!used.has(n)) open.push({ kind, pts: [[la, lo]] }); });
    }
    // 範囲の端（東経110・160度付近や、図の枠の近く）に沿う線は、端で切れた値の偏りなので除く
    const nearEdge = ([la, lo]) => { const j = Math.round((lo - D.w) / D.d), i = Math.round((la - D.s) / D.d), r = Math.round(2 / D.d);
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= DY || jj >= DX || !valid[ii * DX + jj]) return true; } return false; };
    for (const ch of open) if (ch.pts.length && ch.pts.at(-1)[0] - ch.pts[0][0] >= 5 && ch.pts.filter(nearEdge).length <= ch.pts.length / 3) out.push(ch);
  }
  return out;
}

// 海岸線（Natural Earth 1:50m、東アジア部分。public/data/coast/coast_east_asia.json）
let coastP = null;
function coastLines() {
  coastP ||= fetch(`${(import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')}data/coast/coast_east_asia.json`)
    .then(r => (r.ok ? r.json() : null)).then(j => j?.lines || null).catch(() => null);
  return coastP;
}

// ---------- 表示の管理 ----------
export function createUpperSurf3D(viewer, { onStatus } = {}) {
  const on = new Set();                 // 表示中の気圧面
  const built = {};                     // 気圧面 → { contours, field, proj }（解析時刻ごと）
  let model, modelErr = '', forT = null, prims = [], gen = 0, wave = 10, mode = 'wave', structure = false;
  const scale = () => window.awGetAltScale?.() ?? 1;
  const say = (chart, t) => onStatus?.(chart, t);

  async function prepare(chart) {
    const { t, cyc } = analysisTime();
    if (forT !== t.getTime()) { for (const k of Object.keys(built)) delete built[k]; model = undefined; forT = t.getTime(); }
    const need = CHART_LEVELS[chart].filter(p => !built[p]);
    if (!need.length) return t;
    say(chart, '天気図の等高線と数字を読み取っています…');
    const cs = await readPdf(chart, cyc);
    if (model === undefined) {
      say(chart, '矢羽根と、数字の無い等高線の値のため、同じ時刻の GSM を読み込んでいます…');
      try { model = await fetchModel(t, () => say(chart, 'Open-Meteo の1分あたりの回数制限に当たったため、1分待ってから続きを読みます…')); modelErr = ''; }
      catch (e) { model = null; modelErr = e.message; }
    }
    for (const p of need) {
      const { pieces, labels, proj } = cs[p];
      const r = assignValues(pieces, labels, proj, model?.Z[p] || null, INTERVAL[p], p);
      if (!r.contours.length) throw new Error(`${p}hPa の等高線の値を決められませんでした（図の数字が読めず、GSM も使えません${modelErr ? `：${modelErr}` : ''}）`);
      built[p] = { ...r, field: buildField(r.contours, model?.Z[p] || null, proj), wind: cs[p].barbs, marks: cs[p].marks };
    }
    return t;
  }

  function clear() { prims.forEach(x => { viewer.scene.primitives.remove(x); if (x._url) URL.revokeObjectURL(x._url); }); prims = []; }
  async function draw() {
    const my = ++gen; clear();
    if (!on.size) return;
    const k = scale(), barbs = new Cesium.BillboardCollection({ scene: viewer.scene });
    const labels = new Cesium.LabelCollection(), sticks = new Cesium.PolylineCollection();
    const made = [], lvData = [];
    for (const p of LEVELS.filter(x => on.has(x) && built[x])) {
      const b = built[p];
      // 起伏：「波だけ」は南北の傾きを除いた偏差を、「実際の高さ」は平均からのずれを、wave 倍にする
      const disp = displayHeights(b.field, mode, wave, k), at = (la, lo) => fieldAt({ h: disp, valid: b.field.valid }, la, lo);
      lvData.push({ p, at, field: b.field, anom: mode === 'wave' ? disp.anom : displayHeights(b.field, 'wave', 1, 1).anom });
      // 面を重ねるほど下の地図が隠れるので、枚数が多いほど薄くする（6枚で 0.2 前後）
      const alpha = structure ? 0.14 : Math.min(0.6, 0.55 / Math.pow(on.size, 0.6));
      const { prim } = await surfacePrimitive(b.field, disp, alpha, LEVEL_COLOR[p]);
      if (my !== gen) { viewer.scene.primitives.remove(prim); URL.revokeObjectURL(prim._url); return; }
      made.push(prim);
      // 風の矢羽根（天気図の観測値。面の高さに置く）。構造の表示中は、管と矢印が見やすいように出さない
      for (const [la, lo2, sp, dr] of structure ? [] : b.wind) {
        const z = at(la, lo2); if (!isFinite(z)) continue;
        barbs.add({ position: Cesium.Cartesian3.fromDegrees(lo2, la, z + 800 * k), image: barbImage(sp), rotation: -Cesium.Math.toRadians(dr), alignedAxis: Cesium.Cartesian3.UNIT_Z,
          scaleByDistance: new Cesium.NearFarScalar(5e5, 0.9, 8e6, 0.4), disableDepthTestDistance: Number.POSITIVE_INFINITY });
      }
      // 気圧の谷（赤の破線）・峰（黄の実線）の軸。「波だけ」のときだけ（実際の高さでは南北の傾きに埋もれて求められない）
      if (mode === 'wave' && !structure) for (const ax of troughRidgeAxes(b.field, disp.anom)) {
        const pos = ax.pts.map(([la, lo2]) => Cesium.Cartesian3.fromDegrees(lo2, la, at(la, lo2) + 600 * k)).filter((_, n) => isFinite(at(ax.pts[n][0], ax.pts[n][1])));
        if (pos.length < 2) continue;
        sticks.add({ positions: pos, width: ax.kind === 'trough' ? 4 : 3,
          material: ax.kind === 'trough' ? Cesium.Material.fromType('PolylineDash', { color: Cesium.Color.fromCssColorString('#ff5252'), dashLength: 16 })
            : Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString('#ffee58') }) });
      }
      // 低気圧（L）・高気圧（H）の中心：面のくぼみの底・盛り上がりの頂上に、短い棒を立てて目印を付ける
      for (const m of structure ? [] : b.marks) {
        const z = at(m.lat, m.lon); if (!isFinite(z)) continue;
        const top = z + 2500 * k, low = m.ch === 'L';
        const col = Cesium.Color.fromCssColorString(low ? '#ff3b3b' : '#3b8bff');
        sticks.add({ positions: [Cesium.Cartesian3.fromDegrees(m.lon, m.lat, z), Cesium.Cartesian3.fromDegrees(m.lon, m.lat, top)], width: 3,
          material: Cesium.Material.fromType('Color', { color: col }) });
        labels.add({ position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, top), text: m.ch, font: 'bold 26px Arial, sans-serif',
          fillColor: col, outlineColor: Cesium.Color.WHITE, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 8e6, 0.6) });
      }
    }
    if (structure) lastStructure = buildStructure(lvData, k, made, sticks, labels);
    // 海岸線（地上）。面を重ねても日本列島の位置が分かるように、明るい線で描く（半透明の面の下から透けて見える）
    const coast = await coastLines();
    if (my !== gen) return;
    if (coast) {
      const cl = new Cesium.PolylineCollection();
      for (const l of coast) cl.add({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(l.flatMap(([x, y]) => [x, y, 1500])), width: 1.6,
        material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString('#fff3b0').withAlpha(0.95) }) });
      prims.push(viewer.scene.primitives.add(cl));
    }
    made.forEach(x => prims.push(viewer.scene.primitives.add(x)));
    prims.push(viewer.scene.primitives.add(barbs), viewer.scene.primitives.add(sticks), viewer.scene.primitives.add(labels));
  }
  let lastStructure = null;

  /**
   * 谷・尾根の立体構造（気圧の谷の軸＝渦管、尾根の軸、収束場・発散場と下降流・上昇流）
   *   基準の高さ（500hPa、なければ 300hPa など）の谷・尾根の軸から、北緯30〜50度の代表の緯度を決め、
   *   その緯度で各気圧面の偏差がいちばん低い所（谷）・高い所（尾根）を探して、上下につないで管にする。
   *   谷の西側（尾根との間）＝上空の収束場で下降流、谷の東側＝発散場で上昇流（教科書の模式図と同じ考え方）
   */
  function buildStructure(lv, k, made, lines, labels) {
    if (lv.length < 2) return { note: '気圧面が2つ以上必要です' };
    const ref = lv.find(x => x.p === 500) || lv.find(x => x.p === 300) || lv[Math.floor(lv.length / 2)];
    const chains = troughRidgeAxes(ref.field, ref.anom);
    const cols = [];
    for (const ch of chains) {
      const lats = ch.pts.map(q => q[0]).sort((a, b) => a - b);
      const phi = Math.min(50, Math.max(30, lats[lats.length >> 1]));
      const c0 = ch.pts.reduce((a, q) => (Math.abs(q[0] - phi) < Math.abs(a[0] - phi) ? q : a));
      const i = Math.round((phi - D.s) / D.d), sgn = ch.kind === 'trough' ? -1 : 1;
      // 基準の高さから上下へ、前の高さの位置の近く（±6度）で谷・尾根を追う。
      //   範囲の端（2度以内）は使わない。谷・尾根がはっきりしない高さ（偏差 5m 未満）で止める
      const pos = {}, edge = Math.round(2 / D.d);
      const track = (x, center) => {
        let best = null;
        for (let j = Math.round((center - 6 - D.w) / D.d); j <= Math.round((center + 6 - D.w) / D.d); j++) {
          if (j < edge || j >= DX - edge || !x.field.valid[i * DX + j]) continue;
          let inside = true; for (let d = -edge; d <= edge && inside; d++) if (!x.field.valid[i * DX + j + d]) inside = false;
          if (!inside) continue;
          const v = sgn * x.anom[i * DX + j]; if (!best || v > best.v) best = { v, lon: D.w + j * D.d };
        }
        if (!best || best.v < 5) return null;
        // 端に張り付いた（探した範囲の端がいちばん低い／高い）ときは、はっきりした谷・尾根ではないので止める
        if (Math.abs(best.lon - center) >= 6 - D.d / 2) return null;
        return best.lon;
      };
      const ri = lv.indexOf(ref);
      pos[ref.p] = c0[1];
      for (let n = ri - 1, c = c0[1]; n >= 0; n--) { const l = track(lv[n], c); if (l == null) break; pos[lv[n].p] = c = l; }
      for (let n = ri + 1, c = c0[1]; n < lv.length; n++) { const l = track(lv[n], c); if (l == null) break; pos[lv[n].p] = c = l; }
      const pts = lv.filter(x => pos[x.p] != null).map(x => ({ p: x.p, lon: pos[x.p], z: x.at(phi, pos[x.p]) })).filter(q => isFinite(q.z));
      if (pts.length >= 2) cols.push({ kind: ch.kind, phi, pts });
    }
    // 管（地上から一番上の面まで）
    const circle = r => { const a = []; for (let d = 0; d < 360; d += 30) a.push(new Cesium.Cartesian2(r * Math.cos(d * Math.PI / 180), r * Math.sin(d * Math.PI / 180))); return a; };
    for (const c of cols) {
      const trough = c.kind === 'trough';
      const positions = [Cesium.Cartesian3.fromDegrees(c.pts[0].lon, c.phi, 0), ...c.pts.map(q => Cesium.Cartesian3.fromDegrees(q.lon, c.phi, q.z))];
      made.push(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineVolumeGeometry({ polylinePositions: positions, shapePositions: circle(trough ? 70000 : 90000), cornerType: Cesium.CornerType.ROUNDED,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(trough ? '#ec4f9a' : '#4fc3f7').withAlpha(trough ? 0.8 : 0.65)) } }),
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }), asynchronous: false,
      }));
      const mid = c.pts[Math.floor(c.pts.length / 2)], top = c.pts.at(-1);
      labels.add({ position: Cesium.Cartesian3.fromDegrees(mid.lon, c.phi, mid.z), text: trough ? '渦管（気圧の谷の軸）' : '気圧の尾根の軸',
        font: 'bold 15px Meiryo, sans-serif', fillColor: Cesium.Color.fromCssColorString(trough ? '#ffd1e8' : '#d6f2ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(14, 0), horizontalOrigin: Cesium.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      labels.add({ position: Cesium.Cartesian3.fromDegrees(top.lon, c.phi, top.z + 4000 * k), text: trough ? '気圧の谷' : '気圧の尾根',
        font: 'bold 17px Meiryo, sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    // 収束場・発散場と、下降流・上昇流（谷の軸の、一番上の面での位置の西側と東側）
    const topP = lv.at(-1).p, bottom = lv[0];
    const ring = (lon, lat, z, r) => { const a = []; for (let d = 0; d <= 360; d += 10) { const dl = r / 111000; a.push(Cesium.Cartesian3.fromDegrees(lon + dl * Math.sin(d * Math.PI / 180) / Math.cos(lat * Math.PI / 180), lat + dl * Math.cos(d * Math.PI / 180), z)); } return a; };
    const flows = [];
    for (const c of cols.filter(x => x.kind === 'trough')) {
      const tTop = c.pts.find(q => q.p === topP) || c.pts.at(-1);
      const ridges = cols.filter(x => x.kind === 'ridge').map(x => (x.pts.find(q => q.p === topP) || x.pts.at(-1)).lon);
      const west = ridges.filter(l => l < tTop.lon && tTop.lon - l < 35).sort((a, b) => b - a)[0] ?? tTop.lon - 12;
      const east = ridges.filter(l => l > tTop.lon && l - tTop.lon < 35).sort((a, b) => a - b)[0] ?? tTop.lon + 12;
      for (const [lon, down] of [[(west + tTop.lon) / 2, true], [(east + tTop.lon) / 2, false]]) {
        const zt = lv.at(-1).at(c.phi, lon), zb = bottom.at(c.phi, lon);
        if (!isFinite(zt) || !isFinite(zb)) continue;
        const col = Cesium.Color.fromCssColorString(down ? '#1e6fd9' : '#e8321f');
        const a = Cesium.Cartesian3.fromDegrees(lon, c.phi, zt - 1500 * k), b2 = Cesium.Cartesian3.fromDegrees(lon, c.phi, Math.max(0, zb - 3000 * k));
        lines.add({ positions: down ? [a, b2] : [b2, a], width: 28, material: Cesium.Material.fromType('PolylineArrow', { color: col.withAlpha(0.9) }) });
        lines.add({ positions: ring(lon, c.phi, zt, 260000), width: 4, material: Cesium.Material.fromType('PolylineDash', { color: col, dashLength: 10 }) });
        labels.add({ position: Cesium.Cartesian3.fromDegrees(lon, c.phi, zt + 2500 * k), text: down ? '収束場' : '発散場', font: 'bold 18px Meiryo, sans-serif',
          fillColor: col.brighten(0.3, new Cesium.Color()), outlineColor: Cesium.Color.WHITE, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY });
        labels.add({ position: Cesium.Cartesian3.fromDegrees(lon, c.phi, (zt + zb) / 2), text: down ? '下降流' : '上昇流', font: 'bold 16px Meiryo, sans-serif',
          fillColor: col.brighten(0.3, new Cesium.Color()), outlineColor: Cesium.Color.WHITE, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT, pixelOffset: new Cesium.Cartesian2(18, 0), disableDepthTestDistance: Number.POSITIVE_INFINITY });
        flows.push({ down, lon, phi: c.phi });
      }
    }
    const tilt = cols.filter(c => c.kind === 'trough').map(c => {
      const a = c.pts[0], b = c.pts.at(-1), d = b.lon - a.lon;
      return `谷（北緯${c.phi.toFixed(0)}度）：${a.p}hPa 東経${a.lon.toFixed(0)}度 → ${b.p}hPa 東経${b.lon.toFixed(0)}度（${Math.abs(d) < 1 ? 'ほぼ垂直' : d < 0 ? `上空ほど西へ ${Math.abs(d).toFixed(0)}度傾く` : `上空ほど東へ ${d.toFixed(0)}度傾く`}）`;
    });
    return { cols, flows, tilt };
  }
  window.addEventListener('aw:altscale', () => { if (on.size) setTimeout(draw, 0); });

  return {
    isOn: chart => CHART_LEVELS[chart].every(p => on.has(p)),
    get wave() { return wave; },
    get mode() { return mode; },
    /** 'wave'＝波だけ（南北の傾きを除く）、'actual'＝実際の高さ */
    async setMode(m) { mode = m; await draw(); },
    /** 起伏の強調の倍率（1・5・10・20） */
    async setWave(w) { wave = w; await draw(); },
    async show(chart) {
      try {
        await prepare(chart);
        CHART_LEVELS[chart].forEach(p => on.add(p));
        await draw();
        const t = CHART_LEVELS[chart].map(p => {
          const b = built[p], vs = b.contours.map(c => c.v);
          return `<span style="display:inline-block;width:12px;height:10px;background:${LEVEL_COLOR[p]};margin-right:3px;vertical-align:-1px"></span>` +
            `${p}hPa（${Math.min(...vs)}〜${Math.max(...vs)}m・矢羽根 ${b.wind.length}地点・L ${b.marks.filter(m => m.ch === 'L').length}・H ${b.marks.filter(m => m.ch === 'H').length}）`;
        }).join('　');
        say(chart, `${t}<br>面の形は天気図の等高線から作っています。「波だけ」では南北の傾きを除いた偏差を起伏×${wave}で表示（くぼみ＝気圧の谷・低圧部、盛り上がり＝峰）。赤の破線＝気圧の谷の軸、黄の線＝峰の軸。L・H は天気図の低気圧・高気圧の中心。矢羽根は天気図の観測値。`);
      } catch (e) { say(chart, `表示できませんでした（${e.message}）`); console.warn('[upper 3D]', e); throw e; }
    },
    async hide(chart) { CHART_LEVELS[chart].forEach(p => on.delete(p)); await draw(); say(chart, ''); },
    get on() { return on.size > 0; },
    get structure() { return structure; },
    /** 6つの気圧面をまとめて表示する（右下のボタンから） */
    async showAll(onProgress) {
      const errs = [];
      for (const chart of Object.keys(CHART_LEVELS)) {
        onProgress?.(`${chart.toUpperCase()} を読み取っています…`);
        try { await prepare(chart); CHART_LEVELS[chart].forEach(p => on.add(p)); } catch (e) { errs.push(`${chart.toUpperCase()}：${e.message}`); }
      }
      await draw();
      return { errs, summary: LEVELS.filter(p => built[p] && on.has(p)).map(p => ({ p, color: LEVEL_COLOR[p], wind: built[p].wind.length,
        L: built[p].marks.filter(m => m.ch === 'L').length, H: built[p].marks.filter(m => m.ch === 'H').length })) };
    },
    async hideAll() { on.clear(); structure = false; await draw(); },
    /** 谷・尾根の立体構造（渦管・尾根の軸・収束場・発散場・下降流・上昇流）を出す／消す */
    async setStructure(v) { structure = v; await draw(); return lastStructure; },
  };
}
