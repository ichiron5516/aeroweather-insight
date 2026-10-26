// 国内悪天予想図（FBJP）の画像から、ジェット気流・CAT（晴天乱気流）域・雲域（積乱雲・揺れのある雲）を読み取る
//
//   気象庁の FBJP は画像（1525×1130）で、数値データは公開されていない。そこで色で要素を分けて読む：
//     ・ジェット気流 … 濃い緑（0,60,0）の太い線。近くの緑の「FL ○○○」を数字として読む
//     ・CAT 域      … えんじ色（153,0,51）の破線で囲まれた範囲。近くの「320/280」（上限/下限）を読む
//     ・雲域        … 灰色（60,60,60）の波形の輪郭。引き出し線でつながった黒枠の説明（例 ISOL CB 430/020）を読む
//                     枠の中に赤い雷マークがあれば積乱雲
//   数字は、画面のフォントで描いた 0〜9 の見本と形を比べて読む（簡単な文字認識）。
//   画素 → 緯度経度 は chartOverlay.js の投影（ポーラーステレオ）で変換する。
import { PROJ, projInverse } from './chartOverlay.js';

const MAP = { x0: 346, y0: 42, x1: 1478, y1: 1088 };            // 地図の枠（左の凡例は除く）

// ---------------- 画素の分類 ----------------
const isGreen = (r, g, b) => g > r + 25 && g > b + 25 && r < 130;
const isMaroon = (r, g, b) => r > 100 && g < 90 && b > 20 && b < 130 && r > b + 40;
const isGray = (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r >= 30 && r < 150;    // 灰色の線・文字（にじみ含む）
const isBlack = (r, g, b) => r < 35 && g < 35 && b < 35;
const isRed = (r, g, b) => r > 170 && g < 60 && b < 60;

/** 条件に合う画素の連結成分（8近傍）。返り値 [{ n, x0, y0, x1, y1, px:[k...] }] */
function components(W, H, test, box = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 }) {
  const lab = new Int32Array(W * H).fill(-1), out = [];
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const s = y * W + x; if (lab[s] >= 0 || !test(s)) continue;
    const st = [s], px = []; lab[s] = out.length;
    let x0 = x, x1 = x, y0 = y, y1 = y;
    while (st.length) {
      const k = st.pop(); px.push(k);
      const cx = k % W, cy = (k / W) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx < box.x0 || ny < box.y0 || nx > box.x1 || ny > box.y1) continue;
        const q = ny * W + nx; if (lab[q] < 0 && test(q)) { lab[q] = out.length; st.push(q); }
      }
    }
    out.push({ n: px.length, x0, y0, x1, y1, px });
  }
  return { comps: out, lab };
}

// ---------------- 数字の読み取り ----------------
const GW = 10, GH = 14;
let TPL = null;
function templates() {
  if (TPL) return TPL;
  TPL = [];
  const fonts = ['"DejaVu Sans"', 'Verdana', 'Arial', '"Segoe UI"', 'Tahoma', 'sans-serif'];
  for (const f of fonts) for (let d = 0; d <= 9; d++) {
    const c = document.createElement('canvas'); c.width = 48; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 48, 64);
    g.fillStyle = '#000'; g.font = `48px ${f}`; g.textBaseline = 'top'; g.fillText(String(d), 6, 4);
    const px = g.getImageData(0, 0, 48, 64).data, ink = new Float32Array(48 * 64);
    let x0 = 99, x1 = -1, y0 = 99, y1 = -1;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 48; x++) { const v = 1 - px[(y * 48 + x) * 4] / 255; ink[y * 48 + x] = v; if (v > 0.3) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
    if (x1 < 0) continue;
    TPL.push({ d, ar: (x1 - x0 + 1) / (y1 - y0 + 1), v: resample(ink, 48, x0, y0, x1, y1) });
  }
  return TPL;
}
/** 範囲を GW×GH に縮めた濃さ */
function resample(ink, W, x0, y0, x1, y1) {
  const out = new Float32Array(GW * GH), w = x1 - x0 + 1, h = y1 - y0 + 1;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    let s = 0, n = 0;
    const ya = y0 + (j * h) / GH, yb = y0 + ((j + 1) * h) / GH, xa = x0 + (i * w) / GW, xb = x0 + ((i + 1) * w) / GW;
    for (let y = Math.floor(ya); y < Math.ceil(yb); y++) for (let x = Math.floor(xa); x < Math.ceil(xb); x++) { s += ink[y * W + x] || 0; n++; }
    out[j * GW + i] = n ? s / n : 0;
  }
  return out;
}
/** 1文字（画素の成分）を数字として読む。{ d, score } score が小さいほど確か */
function readDigit(c, W, inkOf) {
  const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
  const ink = new Float32Array(w * h);
  for (const k of c.px) { const x = k % W - c.x0, y = ((k / W) | 0) - c.y0; ink[y * w + x] = inkOf(k); }
  const v = resample(ink, w, 0, 0, w - 1, h - 1), ar = w / h;
  let best = null;
  for (const t of templates()) {
    let s = 0; for (let i = 0; i < v.length; i++) s += Math.abs(v[i] - t.v[i]);
    s = s / v.length + Math.abs(ar - t.ar) * 0.35;
    if (!best || s < best.score) best = { d: t.d, score: s };
  }
  return best;
}
/**
 * 数字の並び（例 430）を探す。glyph = 数字の大きさの成分
 * @returns [{ v, x0, y0, x1, y1, cx, cy }]
 */
function readNumbers(W, H, test, inkOf, box, { minH = 8, maxH = 18 } = {}) {
  const { comps } = components(W, H, test, box);
  const gl = comps.filter(c => { const h = c.y1 - c.y0 + 1, w = c.x1 - c.x0 + 1; return h >= minH && h <= maxH && w >= 2 && w <= h * 0.95 && c.n >= 8; })
    .map(c => ({ ...c, r: readDigit(c, W, inkOf) }))
    .filter(c => c.r.score < 0.24)
    .sort((a, b) => a.x0 - b.x0);
  // 同じ行で、間があまり空いていない文字をつなげる
  const used = new Set(), nums = [];
  for (const g of gl) {
    if (used.has(g)) continue;
    const run = [g]; used.add(g);
    for (;;) {
      const last = run.at(-1), h = last.y1 - last.y0 + 1;
      const nx = gl.find(q => !used.has(q) && q.x0 > last.x0 && q.x0 - last.x1 <= h * 0.6 && Math.abs((q.y0 + q.y1) / 2 - (last.y0 + last.y1) / 2) < h * 0.35);
      if (!nx) break; run.push(nx); used.add(nx);
    }
    if (run.length < 3) continue;                           // 高度は3けた（FL）
    const s = run.slice(0, 3).map(q => q.r.d).join('');
    const x0 = Math.min(...run.map(q => q.x0)), x1 = Math.max(...run.map(q => q.x1)), y0 = Math.min(...run.map(q => q.y0)), y1 = Math.max(...run.map(q => q.y1));
    nums.push({ v: +s, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  return nums;
}
/** 斜めに書かれた数字：切り出して少しずつ回し、3けたの数が読めた角度の値を使う */
function readRotated(W, H, test, box, lo = 150, hi = 600) {
  const pad = 8, bw = box.x1 - box.x0 + 1 + pad * 2, bh = box.y1 - box.y0 + 1 + pad * 2;
  const src = document.createElement('canvas'); src.width = bw; src.height = bh;
  const sg = src.getContext('2d'), im = sg.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const gx = x + box.x0 - pad, gy = y + box.y0 - pad, k = (y * bw + x) * 4;
    const on = gx >= 0 && gy >= 0 && gx < W && gy < H && test(gy * W + gx);
    im.data[k] = im.data[k + 1] = im.data[k + 2] = on ? 0 : 255; im.data[k + 3] = 255;
  }
  sg.putImageData(im, 0, 0);
  const S = Math.ceil(Math.hypot(bw, bh)) + 4;
  for (const deg of [0, -8, 8, -15, 15, -22, 22, -30, 30, -38, 38]) {
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
    g.translate(S / 2, S / 2); g.rotate(-deg * Math.PI / 180); g.drawImage(src, -bw / 2, -bh / 2);
    const d = g.getImageData(0, 0, S, S).data;
    const nums = readNumbers(S, S, k => d[k * 4] < 140, k => 1 - d[k * 4] / 255, { x0: 0, y0: 0, x1: S - 1, y1: S - 1 });
    const n = nums.find(q => q.v >= lo && q.v <= hi);
    if (n) return n.v;
  }
  return null;
}

/** 上下に重なった数字の組（分数：上が上限、下が下限） */
function fractions(nums) {
  const out = [], used = new Set();
  for (const a of nums) for (const b of nums) {
    if (a === b || used.has(a) || used.has(b)) continue;
    const dy = b.cy - a.cy, h = a.y1 - a.y0 + 1;
    if (dy > h * 0.9 && dy < h * 2.6 && Math.abs(a.cx - b.cx) < h * 1.2) { out.push({ top: a.v, base: b.v, x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2, a, b }); used.add(a); used.add(b); }
  }
  return out;
}

// ---------------- 面（閉じた輪郭の内側） ----------------
/** 線の画素（mask）で囲まれた内側の領域。gap 画素までのすき間（破線）は閉じる */
function enclosed(W, H, mask, box, gap, minArea, { frame = false, extra = null, edges = null } = {}) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const wall = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[(y + box.y0) * W + x + box.x0] || extra?.[(y + box.y0) * W + x + box.x0]) {
    for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
      if (dx * dx + dy * dy > gap * gap) continue;
      const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < bw && ny < bh) wall[ny * bw + nx] = 1;
    }
  }
  if (frame) {
    // 地図の枠も壁にする（枠からはみ出す範囲も閉じる）。いちばん大きな残り＝外側
    for (let x = 0; x < bw; x++) { wall[x] = 1; wall[(bh - 1) * bw + x] = 1; }
    for (let y = 0; y < bh; y++) { wall[y * bw] = 1; wall[y * bw + bw - 1] = 1; }
    const { comps } = components(bw, bh, k => !wall[k]);
    comps.sort((a, b) => b.n - a.n);
    // 前線も壁にしたとき（edges あり）：地図の端ではない辺に接するかけらは雲域の外（前線で外側が分かれるため）（2026-10-19）
    if (edges) {
      const outside = c => (c.x0 <= 1 && !edges.l) || (c.x1 >= bw - 2 && !edges.r) || (c.y0 <= 1 && !edges.t) || (c.y1 >= bh - 2 && !edges.b);
      return comps.filter(c => !outside(c) && c.n >= minArea && c.n < bw * bh * 0.3).map(c => ({ ...c, bw, ox: box.x0, oy: box.y0, gap }));
    }
    return comps.slice(1).filter(c => c.n >= minArea && c.n < bw * bh * 0.3).map(c => ({ ...c, bw, ox: box.x0, oy: box.y0, gap }));
  }
  // 外側から塗る
  const out = new Uint8Array(bw * bh), st = [];
  for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
  for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
  while (st.length) { const k = st.pop(); if (out[k] || wall[k]) continue; out[k] = 1; const x = k % bw, y = (k / bw) | 0; if (x > 0) st.push(k - 1); if (x < bw - 1) st.push(k + 1); if (y > 0) st.push(k - bw); if (y < bh - 1) st.push(k + bw); }
  // 外でも壁でもない所＝内側（成分ごと）。壁の分だけ外へ広げて元の大きさに近づける
  const { comps } = components(bw, bh, k => !out[k] && !wall[k]);
  return comps.filter(c => c.n >= minArea).map(c => ({ ...c, bw, ox: box.x0, oy: box.y0, gap }));
}
/**
 * 前線で分かれた雲域のかけらをまとめる（2026-10-19）
 *   2 つのかけらの一番近い点どうしを結ぶ線が灰色の線（雲域の輪郭）を通らなければ、同じ雲域とみなす
 */
function mergeAcrossFront(parts, grayMask, W) {
  if (parts.length < 2) return parts;
  const glob = r => r.px.map(k => ((k / r.bw) | 0) + r.oy) .map((y, i) => y * W + (r.px[i] % r.bw) + r.ox);
  const G = parts.map(glob);
  const rim = parts.map((r, i) => {
    const s = new Set(G[i]), out = [];
    for (const k of G[i]) if (!s.has(k - 1) || !s.has(k + 1) || !s.has(k - W) || !s.has(k + W)) out.push(k);
    return out;
  });
  const par = parts.map((_, i) => i), f = i => (par[i] === i ? i : (par[i] = f(par[i])));
  // 一番近い点どうしだけで調べると、前線が雲域の輪郭を横切るあたり（灰色の線のすぐそば）を選んでしまい、まとめられないことがある。
  //   そこで近い点の組（18 画素以内）をいくつも調べ、どれか 1 つでも灰色の線を通らずに結べれば同じ雲域とする（2026-10-26）
  const crossesGray = (pa, pb) => {
    const x0 = pa % W, y0 = (pa / W) | 0, x1 = pb % W, y1 = (pb / W) | 0, n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let t = 0; t <= n; t++) { const x = Math.round(x0 + (x1 - x0) * t / n), y = Math.round(y0 + (y1 - y0) * t / n);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) if (grayMask[(y + dy) * W + x + dx]) return true; }
    return false;
  };
  for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
    const cand = [];
    for (let i = 0; i < rim[a].length; i += 2) { const ka = rim[a][i], xa = ka % W, ya = (ka / W) | 0;
      for (let j = 0; j < rim[b].length; j += 2) { const kb = rim[b][j], d = (kb % W - xa) ** 2 + (((kb / W) | 0) - ya) ** 2; if (d <= 18 * 18) cand.push([d, ka, kb]); } }
    if (!cand.length) continue;
    cand.sort((p, q) => p[0] - q[0]);
    const tries = cand.length <= 40 ? cand : Array.from({ length: 40 }, (_, i) => cand[Math.floor(i * (cand.length - 1) / 39)]);
    if (tries.some(([, pa, pb]) => !crossesGray(pa, pb))) par[f(a)] = f(b);
  }
  const by = new Map(); parts.forEach((r, i) => { const k = f(i); (by.get(k) || by.set(k, []).get(k)).push(r); });
  return [...by.values()].map(list => list.length === 1 ? list[0] : { ...list[0], n: list.reduce((s2, r) => s2 + r.n, 0), px: list.flatMap(r => r.px) });
}
/** 領域の輪郭を、重心からの放射方向の一番外側で近似（72方向） */
function outline(reg) {
  const { bw, ox, oy, gap } = reg;
  let sx = 0, sy = 0; for (const k of reg.px) { sx += k % bw; sy += (k / bw) | 0; }
  const cx = sx / reg.n, cy = sy / reg.n, N = 72, far = new Float32Array(N);
  for (const k of reg.px) {
    const dx = k % bw - cx, dy = ((k / bw) | 0) - cy, a = Math.atan2(dy, dx);
    const i = Math.round(((a + Math.PI) / (2 * Math.PI)) * N) % N, d = Math.hypot(dx, dy);
    if (d > far[i]) far[i] = d;
  }
  for (let i = 0; i < N; i++) if (!far[i]) far[i] = (far[(i + N - 1) % N] + far[(i + 1) % N]) / 2;
  return Array.from({ length: N }, (_, i) => {
    const a = (i / N) * 2 * Math.PI - Math.PI, d = far[i] + gap * 0.8;
    return { x: ox + cx + Math.cos(a) * d, y: oy + cy + Math.sin(a) * d };
  });
}

/** 前線で分かれた雲域の輪郭：かけら（前線の分だけ欠けている）と、それを囲む灰色の線の画素から放射方向の一番外側をとる（2026-10-26） */
function outlineWithEdge(reg, edge, W) {
  const { bw, ox, oy } = reg, pts = [];
  for (const k of reg.px) pts.push([k % bw + ox, ((k / bw) | 0) + oy]);
  for (const k of edge) pts.push([k % W, (k / W) | 0]);
  let cx = 0, cy = 0; for (const [x, y] of pts) { cx += x; cy += y; } cx /= pts.length; cy /= pts.length;
  const N = 72, far = new Float32Array(N);
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy, i = Math.round(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * N) % N, d = Math.hypot(dx, dy);
    if (d > far[i]) far[i] = d;
  }
  for (let i = 0; i < N; i++) if (!far[i]) far[i] = (far[(i + N - 1) % N] + far[(i + 1) % N]) / 2;
  return Array.from({ length: N }, (_, i) => { const a = (i / N) * 2 * Math.PI - Math.PI; return { x: cx + Math.cos(a) * far[i], y: cy + Math.sin(a) * far[i] }; });
}

// ---------------- 本体 ----------------
export function parseFbjp(src) {
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0);
  const D = ctx.getImageData(0, 0, W, H).data;
  const P = PROJ.fbjp, ll = (x, y) => { const [lat, lon] = projInverse(P, 1, x, y); return { lat, lon }; };
  const px = (k, f) => f(D[k * 4], D[k * 4 + 1], D[k * 4 + 2]);
  const inkGray = k => 1 - (D[k * 4] + D[k * 4 + 1] + D[k * 4 + 2]) / 765;
  const res = { jets: [], cats: [], clouds: [], notes: [] };

  // ===== ジェット気流 =====
  const green = k => px(k, isGreen);
  const greenNums = readNumbers(W, H, green, k => (255 - D[k * 4 + 1] * 0.5 - D[k * 4] * 0.5) / 255, MAP);
  const { comps: gcomps } = components(W, H, green, MAP);
  const segs = [];
  for (const c of gcomps) {
    if (c.n < 250 || Math.max(c.x1 - c.x0, c.y1 - c.y0) < 60) continue;      // 線（文字は除く）
    // 主軸方向に区切って、横断方向の中央値をつなぐ
    let mx = 0, my = 0; for (const k of c.px) { mx += k % W; my += (k / W) | 0; } mx /= c.n; my /= c.n;
    let sxx = 0, syy = 0, sxy = 0; for (const k of c.px) { const dx = k % W - mx, dy = ((k / W) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
    const bins = new Map();
    for (const k of c.px) { const dx = k % W - mx, dy = ((k / W) | 0) - my, t = dx * ux + dy * uy, n = -dx * uy + dy * ux, b = Math.round(t / 8); (bins.get(b) || bins.set(b, []).get(b)).push(n); }
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const line = keys.filter(b => bins.get(b).length >= 2).map(b => { const v = bins.get(b).sort((p, q) => p - q), n = v[v.length >> 1], t = b * 8; return { x: mx + t * ux - n * uy, y: my + t * uy + n * ux }; });
    if (line.length >= 5) segs.push({ line, comp: c });
  }
  // 切れた線（矢羽根や文字で途切れる）を、端どうしが近いものでつなぐ
  const parent = segs.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i].line, B = segs[j].line, ends = [[A[0], B[0]], [A[0], B.at(-1)], [A.at(-1), B[0]], [A.at(-1), B.at(-1)]];
    if (ends.some(([p, q]) => Math.hypot(p.x - q.x, p.y - q.y) < 70)) parent[find(i)] = find(j);
  }
  const chains = new Map();
  segs.forEach((sg, i) => { const r = find(i); (chains.get(r) || chains.set(r, []).get(r)).push(sg); });
  // 線ではない緑の小さなかたまり（文字）を、近いものどうしでまとめる（斜めの「FL 370」など）
  const glyphs = gcomps.filter(c => c.n >= 6 && c.n < 250 && Math.max(c.x1 - c.x0, c.y1 - c.y0) < 30);
  const gp = glyphs.map((_, i) => i), gf = i => (gp[i] === i ? i : (gp[i] = gf(gp[i])));
  for (let i = 0; i < glyphs.length; i++) for (let j = i + 1; j < glyphs.length; j++) {
    const a = glyphs[i], b = glyphs[j];
    const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)), dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
    if (dx < 9 && dy < 9) gp[gf(i)] = gf(j);
  }
  const groups = new Map();
  glyphs.forEach((g, i) => { const r = gf(i), b = groups.get(r) || { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 }; b.x0 = Math.min(b.x0, g.x0); b.y0 = Math.min(b.y0, g.y0); b.x1 = Math.max(b.x1, g.x1); b.y1 = Math.max(b.y1, g.y1); b.n++; groups.set(r, b); });
  const labels = [];
  for (const b of groups.values()) {
    if (b.n < 4) continue;                                            // 「F」「L」「3」「7」「0」
    const up = greenNums.find(nm => nm.cx >= b.x0 - 4 && nm.cx <= b.x1 + 4 && nm.cy >= b.y0 - 4 && nm.cy <= b.y1 + 4 && nm.v >= 150 && nm.v <= 600);
    const v = up ? up.v : readRotated(W, H, green, b);
    if (v) labels.push({ v, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  }
  for (const list of chains.values()) {
    const all = list.flatMap(sg => sg.line);
    // 全体の主軸に沿って並べ直す
    let mx = 0, my = 0; for (const p of all) { mx += p.x; my += p.y; } mx /= all.length; my /= all.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of all) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
    all.sort((p, q) => ((p.x - mx) * ux + (p.y - my) * uy) - ((q.x - mx) * ux + (q.y - my) * uy));
    if (all.length < 8) continue;
    // 線に沿った FL の札（線から 80 画素以内）。複数あれば位置ごとに使い分ける
    const near = labels.map(l => { let bi = 0, bd = 1e9; all.forEach((p, i) => { const d = Math.hypot(p.x - l.x, p.y - l.y); if (d < bd) { bd = d; bi = i; } }); return { ...l, d: bd, at: bi }; }).filter(l => l.d < 80);
    const fls = all.map((_, i) => { if (!near.length) return null; return near.reduce((a, b) => (Math.abs(b.at - i) < Math.abs(a.at - i) ? b : a)).v; });
    res.jets.push({ pts: all.map(p => ll(p.x, p.y)), fls, fl: near[0]?.v ?? null, labels: near.map(l => ({ v: l.v, ...ll(l.x, l.y) })) });
  }

  // ===== CAT 域 =====
  const maroonMask = new Uint8Array(W * H);
  for (let y = MAP.y0; y <= MAP.y1; y++) for (let x = MAP.x0; x <= MAP.x1; x++) { const k = y * W + x; if (px(k, isMaroon)) maroonMask[k] = 1; }
  const catNums = readNumbers(W, H, k => maroonMask[k] === 1, k => maroonMask[k], MAP);
  const catFr = fractions(catNums);
  // CAT 域の北側の境界はジェット気流の線に沿っていることが多く、緑の線が上に描かれてえんじ色の破線が隠れる。
  //   そこで緑の線も壁にして囲みを閉じる。ただし緑の線と地図の枠だけで囲まれた所（ジェット気流の北側など）は CAT ではないので、
  //   境界の 3 割以上がえんじ色の破線のものだけを CAT 域とする
  const greenMask = new Uint8Array(W * H);
  for (let y = MAP.y0; y <= MAP.y1; y++) for (let x = MAP.x0; x <= MAP.x1; x++) { const k = y * W + x; if (px(k, isGreen)) greenMask[k] = 1; }
  const nearMaroon = (x, y, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && maroonMask[yy * W + xx]) return true; } return false; };
  const catAreas = enclosed(W, H, maroonMask, MAP, 6, 1500, { frame: true, extra: greenMask }).filter(r => {
    const inR = new Set(r.px);
    let edge = 0, mar = 0;
    for (const k of r.px) {
      const x = k % r.bw, y = (k / r.bw) | 0;
      if (inR.has(k - 1) && inR.has(k + 1) && inR.has(k - r.bw) && inR.has(k + r.bw)) continue;   // 内側の画素
      const gx = x + r.ox, gy = y + r.oy;
      if (gx <= MAP.x0 + 1 || gx >= MAP.x1 - 1 || gy <= MAP.y0 + 1 || gy >= MAP.y1 - 1) continue;  // 地図の枠に接する所は数えない
      edge++; if (nearMaroon(gx, gy, r.gap + 3)) mar++;
    }
    return edge > 0 && mar / edge >= 0.3;
  }).map(r => ({ r, poly: outline(r) }));
  for (const a of catAreas) {
    const cx = a.poly.reduce((s, p) => s + p.x, 0) / a.poly.length, cy = a.poly.reduce((s, p) => s + p.y, 0) / a.poly.length;
    const f = catFr.map(fr => ({ fr, d: Math.min(...a.poly.map(p => Math.hypot(p.x - fr.x, p.y - fr.y))) })).sort((p, q) => p.d - q.d)[0];
    res.cats.push({ poly: a.poly.map(p => ll(p.x, p.y)), top: f?.fr.top ?? null, base: f?.fr.base ?? null, center: ll(cx, cy) });
  }

  // ===== 雲域（灰色の波形の輪郭）と説明の枠 =====
  // 黒い枠：左右の縦線の組（同じ高さ範囲）＋上下の横線がおおむねある
  const vRuns = [];
  for (let x = MAP.x0; x <= MAP.x1; x++) {
    let run = 0;
    for (let y = MAP.y0; y <= MAP.y1 + 1; y++) {
      if (y <= MAP.y1 && px(y * W + x, isBlack)) run++;
      else { if (run >= 30) vRuns.push({ x, y0: y - run, y1: y - 1 }); run = 0; }
    }
  }
  const hcov = (y, x0, x1) => { let n = 0; for (let x = x0; x <= x1; x++) if (px(y * W + x, isBlack) || px((y - 1) * W + x, isBlack) || px((y + 1) * W + x, isBlack)) n++; return n / (x1 - x0 + 1); };
  const boxes = [];
  for (const L of vRuns) for (const R of vRuns) {
    if (R.x - L.x < 50 || R.x - L.x > 320) continue;
    if (Math.abs(L.y0 - R.y0) > 4 || Math.abs(L.y1 - R.y1) > 4) continue;
    const y0 = Math.min(L.y0, R.y0), y1 = Math.max(L.y1, R.y1);
    if (hcov(y0, L.x, R.x) < 0.6 || hcov(y1, L.x, R.x) < 0.6) continue;
    // いちばん内側の組だけ（右の縦線は、左から一番近いもの）
    if (vRuns.some(M => M.x > L.x + 3 && M.x < R.x - 3 && Math.abs(M.y0 - y0) <= 4 && Math.abs(M.y1 - y1) <= 4)) continue;
    if (boxes.some(q => Math.abs(q.x0 - L.x) < 4 && Math.abs(q.y0 - y0) < 4)) continue;
    boxes.push({ x0: L.x, y0, x1: R.x, y1 });
  }
  // 説明の札：枠線が一部しか描かれていないこともあるので、灰色の「分数」（上限/下限）のまとまりで探す
  const grayNums = readNumbers(W, H, k => px(k, isGray) || px(k, isBlack), inkGray, MAP);
  const allFr = fractions(grayNums);
  const cl = allFr.map((_, i) => i), cf = i => (cl[i] === i ? i : (cl[i] = cf(cl[i])));
  for (let i = 0; i < allFr.length; i++) for (let j = i + 1; j < allFr.length; j++)
    if (Math.abs(allFr[i].x - allFr[j].x) < 70 && Math.abs(allFr[i].y - allFr[j].y) < 80) cl[cf(i)] = cf(j);
  const groupsF = new Map(); allFr.forEach((f, i) => { const r = cf(i); (groupsF.get(r) || groupsF.set(r, []).get(r)).push(f); });
  const tags = [];
  for (const list of groupsF.values()) {
    list.sort((p2, q) => p2.y - q.y || p2.x - q.x);
    // 札の左端：黒い枠の縦線があればそこ。無ければ分数から 115 画素左まで（文字 OVC AC AS などの幅）
    const fx0 = Math.min(...list.map(f => Math.min(f.a.x0, f.b.x0))), ty0 = Math.min(...list.map(f => f.a.y0)) - 22, ty1 = Math.max(...list.map(f => f.b.y1));
    let left = fx0 - 115;
    for (let x = fx0 - 1; x > fx0 - 200 && x > MAP.x0; x--) {
      let n = 0; for (let y = ty0; y <= ty1; y++) if (px(y * W + x, isBlack)) n++;
      if (n > (ty1 - ty0 + 1) * 0.8) { left = x + 2; break; }
    }
    let bx = { x0: left - 2, x1: Math.max(...list.map(f => Math.max(f.a.x1, f.b.x1))) + 22,
      y0: Math.min(...list.map(f => f.a.y0)) - 28, y1: Math.max(...list.map(f => f.b.y1)) + 26 };
    const frame = boxes.find(q => q.x0 <= list[0].x && q.x1 >= list[0].x && q.y0 <= list[0].y && q.y1 >= list[0].y);
    if (frame) bx = { ...frame };
    else {
      // 枠線の上辺・下辺・右辺をさがして合わせる（説明の文字が分数の上に2行あることもある）
      const hBlack = (y, x0, x1) => { let n = 0; for (let x = x0; x <= x1; x++) if (px(y * W + x, isBlack)) n++; return n / (x1 - x0 + 1); };
      const vBlack = (x, y0, y1) => { let n = 0; for (let y = y0; y <= y1; y++) if (px(y * W + x, isBlack)) n++; return n / (y1 - y0 + 1); };
      for (let y = bx.y0 + 20; y > bx.y0 - 110 && y > MAP.y0; y--) if (hBlack(y, bx.x0 + 4, bx.x1 - 30) > 0.5) { bx.y0 = y; break; }
      for (let y = bx.y1 - 10; y < bx.y1 + 60 && y < MAP.y1; y++) if (hBlack(y, bx.x0 + 4, bx.x1 - 30) > 0.5) { bx.y1 = y; break; }
      for (let x = bx.x1 - 20; x < bx.x1 + 40 && x < MAP.x1; x++) if (vBlack(x, bx.y0 + 4, bx.y1 - 4) > 0.6) { bx.x1 = x; break; }
    }
    bx.x0 = Math.max(MAP.x0, bx.x0); bx.y0 = Math.max(MAP.y0, bx.y0); bx.x1 = Math.min(MAP.x1, bx.x1); bx.y1 = Math.min(MAP.y1, bx.y1);
    let red = 0; for (let y = bx.y0; y <= bx.y1; y++) for (let x = bx.x0; x <= bx.x1; x++) if (px(y * W + x, isRed)) red++;
    tags.push({ ...bx, cb: red > 15, fr: list });
  }
  boxes.length = 0; boxes.push(...tags);
  // 灰色の線（輪郭と引き出し線）。枠の中の文字は除く
  const inBox = (x, y) => boxes.some(b => x >= b.x0 - 1 && x <= b.x1 + 1 && y >= b.y0 - 1 && y <= b.y1 + 1);
  const grayMask = new Uint8Array(W * H);
  for (let y = MAP.y0; y <= MAP.y1; y++) for (let x = MAP.x0; x <= MAP.x1; x++) { const k = y * W + x; if (px(k, isGray) && !inBox(x, y)) grayMask[k] = 1; }
  // 雲域：灰色の線で囲まれた内側
  //   前線（赤・青の太い線）が雲域の輪郭を横切ると、灰色の輪郭が途切れて閉じない（2026-10-19）。そこで
  //   ・近くにある灰色の線のかけらを 1 つのまとまりにし、
  //   ・前線の線も壁として足して、輪郭＋前線で囲まれた内側を雲域にする（前線で 2 つに分かれた雲は、同じ札の雲として扱う）
  const isFront = (r, g, b) => (r > 150 && g < 70 && b < 70) || (b > 150 && r < 60 && g < 60);
  const frontMask = new Uint8Array(W * H);
  for (let y = MAP.y0; y <= MAP.y1; y++) for (let x = MAP.x0; x <= MAP.x1; x++) { const k = y * W + x; if (px(k, isFront) && !inBox(x, y)) frontMask[k] = 1; }
  const regions = [];
  const { comps: lines0 } = components(W, H, k => grayMask[k] === 1, MAP);
  const lines = lines0.filter(c => c.n >= 60);
  const lp = lines.map((_, i) => i), lf = i => (lp[i] === i ? i : (lp[i] = lf(lp[i])));
  const NEAR = 14;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (a.x0 - NEAR > b.x1 || b.x0 - NEAR > a.x1 || a.y0 - NEAR > b.y1 || b.y0 - NEAR > a.y1) continue;
    // 線の端どうしが近いか（画素で確かめる。間引いて調べる）
    const bs = new Set(); for (const k of b.px) bs.add(((k % W) / 4 | 0) + ',' + (((k / W) | 0) / 4 | 0));
    let near = false;
    for (let t = 0; t < a.px.length && !near; t += 2) { const k = a.px[t], gx = (k % W) / 4 | 0, gy = ((k / W) | 0) / 4 | 0;
      for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (bs.has((gx + dx) + ',' + (gy + dy))) { near = true; break; } }
    if (near) lp[lf(i)] = lf(j);
  }
  const cgroups = new Map(); lines.forEach((c, i) => { const r = lf(i); (cgroups.get(r) || cgroups.set(r, []).get(r)).push(c); });
  let gid = 0;
  for (const g of cgroups.values()) {
    gid++;
    if (g.reduce((s, c) => s + c.n, 0) < 150) continue;
    const c = { x0: Math.min(...g.map(q => q.x0)), y0: Math.min(...g.map(q => q.y0)), x1: Math.max(...g.map(q => q.x1)), y1: Math.max(...g.map(q => q.y1)) };
    const m = new Uint8Array(W * H); for (const q of g) for (const k of q.px) m[k] = 1;
    const box = { x0: Math.max(MAP.x0, c.x0 - 8), y0: Math.max(MAP.y0, c.y0 - 8), x1: Math.min(MAP.x1, c.x1 + 8), y1: Math.min(MAP.y1, c.y1 + 8) };
    const atEdge = c.x0 <= MAP.x0 + 3 || c.y0 <= MAP.y0 + 3 || c.x1 >= MAP.x1 - 3 || c.y1 >= MAP.y1 - 3;   // 地図の端で切れた雲域
    // 前線は、灰色の線がかけらに分かれているときだけ壁にする（1 本で閉じている雲域には使わない）
    const extra = g.length > 1 ? frontMask : null;
    // 前線を壁にすると、前線の三角・半円の記号で内側が小さく分かれる。灰色の線をまたがずに隣り合うかけらは 1 つの雲にまとめる
    const edges = extra && atEdge ? { l: c.x0 <= MAP.x0 + 3, r: c.x1 >= MAP.x1 - 3, t: c.y0 <= MAP.y0 + 3, b: c.y1 >= MAP.y1 - 3 } : null;
    // 前線（と移動方向の矢印・温暖前線の半円）を壁にすると、小さな雲域は内側がいくつもの小さなかけらになる。
    //   小さなかけらも残してまとめ、まとめた後の大きさで判定する（以前は 900 画素未満を捨てていて、小さな雲域が消えていた。2026-10-26）
    let parts = enclosed(W, H, m, box, 3, extra ? 20 : 900, { frame: atEdge, extra, edges });
    if (extra) parts = mergeAcrossFront(parts, grayMask, W).filter(r => r.n >= 300);
    for (const r of parts) {
      r.gid = gid;
      // 輪郭の画素：内側に接する灰色の線
      const edge = new Set();
      for (const k of r.px) { const x = k % r.bw + r.ox, y = ((k / r.bw) | 0) + r.oy;
        for (let d = 1; d <= 5; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { const q = (y + dy) * W + x + dx; if (grayMask[q]) edge.add(q); } }
      // 前線の内側だけの区画（輪郭の灰色の線にほとんど接していない）は雲域ではない
      if (extra && edge.size < 40) continue;
      regions.push({ r, poly: extra ? outlineWithEdge(r, edge, W) : outline(r), edge });
    }
  }
  // 枠ごとに、灰色の線をたどった距離（引き出し線は、つながる雲域の輪郭に最初に届く）
  // 矢じりの先と輪郭の間の小さなすき間を越えられるよう、線を2画素太らせてたどる
  const grayD = new Uint8Array(W * H);
  for (let y = MAP.y0 + 2; y <= MAP.y1 - 2; y++) for (let x = MAP.x0 + 2; x <= MAP.x1 - 2; x++) {
    if (!grayMask[y * W + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) grayD[(y + dy) * W + x + dx] = 1;
  }
  for (const b of boxes) for (let y = b.y0 + 3; y <= b.y1 - 3; y++) for (let x = b.x0 + 3; x <= b.x1 - 3; x++) grayD[y * W + x] = 0;   // 札の中は通らない
  const dist = boxes.map(b => {
    const d = new Int32Array(W * H).fill(-1), q = [];
    for (let y = Math.max(MAP.y0, b.y0 - 12); y <= Math.min(MAP.y1, b.y1 + 12); y++) for (let x = Math.max(MAP.x0, b.x0 - 12); x <= Math.min(MAP.x1, b.x1 + 12); x++) {
      if (x > b.x0 + 2 && x < b.x1 - 2 && y > b.y0 + 2 && y < b.y1 - 2) continue;
      const k = y * W + x; if (grayD[k] && d[k] < 0) { d[k] = 0; q.push(k); }
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h], x = k % W, y = (k / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = (y + dy) * W + x + dx; if (grayD[n] && d[n] < 0) { d[n] = d[k] + 1; q.push(n); } }
    }
    return d;
  });
  // 札ごとに「最初に届く雲域」を選ぶ（引き出し線の先）。札が来ない雲域は、いちばん近い札
  const dR = regions.map(R => boxes.map((b, i) => { let m = Infinity; for (const k of R.edge) { const v = dist[i][k]; if (v >= 0 && v < m) m = v; } return m; }));
  const owner = new Map();
  boxes.forEach((b, i) => {
    let bi = -1; regions.forEach((_, r) => { if (dR[r][i] < Infinity && (bi < 0 || dR[r][i] < dR[bi][i])) bi = r; });
    if (bi >= 0 && (!owner.has(bi) || dR[bi][i] < dR[bi][owner.get(bi)])) owner.set(bi, i);
  });
  regions.forEach((R, r) => {
    let i = owner.get(r);
    if (i == null) { let m = Infinity; boxes.forEach((_, j) => { if (dR[r][j] < m) { m = dR[r][j]; i = j; } }); }
    // 引き出し線が前線などで途切れて、どの札ともつながらないとき：雲域から 220 画素以内の一番近い札（2026-10-19）
    if (i == null) {
      let m = 220;
      boxes.forEach((b2, j) => { for (const p of R.poly) { const dx = Math.max(b2.x0 - p.x, 0, p.x - b2.x1), dy = Math.max(b2.y0 - p.y, 0, p.y - b2.y1), d = Math.hypot(dx, dy); if (d < m) { m = d; i = j; } } });
    }
    const b = i != null ? boxes[i] : null;
    const cx = R.poly.reduce((s2, p) => s2 + p.x, 0) / R.poly.length, cy = R.poly.reduce((s2, p) => s2 + p.y, 0) / R.poly.length;
    const fr = b?.fr?.[0];
    // 札の分数は上から 雲（CB など）・乱気流・着氷 の順。乱気流の高さ（揺れが予想される高度）も持っておく
    const tb = b?.fr?.[1];
    // 積乱雲：札に赤い雷マークがある、または雲が下層（FL060 以下）から上層（FL250 以上）まで続く（ISOL CB 360/020 など。雷マークの無い札もあるため。2026-10-26）
    const cb = !!b?.cb || (fr?.top >= 250 && fr?.base != null && fr.base <= 60);
    res.clouds.push({ poly: R.poly.map(p => ll(p.x, p.y)), center: ll(cx, cy), cb, top: fr?.top ?? null, base: fr?.base ?? null, linked: !!b,
      box: i ?? null, group: R.r.gid, area: R.r.n,
      turb: tb?.top ? { top: tb.top, base: tb.base ?? fr?.base ?? null } : null });
  });
  res.boxes = boxes.map(b => ({ cb: b.cb, fr: b.fr.map(f => [f.top, f.base]) }));
  res.debug = { greenNums: greenNums.map(n => n.v), catFr: catFr.map(f => [f.top, f.base]) };
  return res;
}
