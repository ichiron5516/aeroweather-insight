// レーダーエコーの動きの解析（計算部分。画面やネットワークには触れない）
//
//   1. 最新の降水強度（mm/h）を約8km四方のマスにまとめ、つながった雨域を見つける
//   2. 雨域ごとに、30分前・60分前の図を少しずつずらして重ね、いちばんよく重なるずれ量を探す
//      （ブロックマッチング。ずれ量 ÷ 時間 = 移動の速さと向き）
//   3. 面積・強さを60分前の同じ雨域と比べ、発達・衰弱を判定する
//   4. このまま進んだときの1〜2時間後の位置と、近づく空港を求める
//
//   入力のラスタは Webメルカトル（ズーム z）の画素。x0, y0 はラスタ左上の世界座標（画素）

export const lon2px = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
export const lat2px = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 256 * 2 ** z;
export const px2lon = (x, z) => x / (256 * 2 ** z) * 360 - 180;
export const px2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (256 * 2 ** z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };

const R = Math.PI / 180;
export const distKm = (la1, lo1, la2, lo2) => {
  const a = Math.sin((la2 - la1) * R / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin((lo2 - lo1) * R / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
};
export const bearing = (la1, lo1, la2, lo2) => {
  const y = Math.sin((lo2 - lo1) * R) * Math.cos(la2 * R);
  const x = Math.cos(la1 * R) * Math.sin(la2 * R) - Math.sin(la1 * R) * Math.cos(la2 * R) * Math.cos((lo2 - lo1) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
};
export const DIR16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
export const dirName = deg => DIR16[Math.round(deg / 22.5) % 16];

/** 画素のラスタ → B×B のマス（最大値と平均の強さ） */
export function coarsen(r, B) {
  const W = Math.floor(r.W / B), H = Math.floor(r.H / B);
  const mx = new Float32Array(W * H), lv = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let m = 0, s = 0;
    for (let y = j * B; y < j * B + B; y++) for (let x = i * B; x < i * B + B; x++) {
      const v = r.rain[y * r.W + x]; if (v > m) m = v; s += Math.log2(1 + v);
    }
    mx[j * W + i] = m; lv[j * W + i] = s / (B * B);
  }
  return { W, H, mx, lv, B, z: r.z, x0: r.x0, y0: r.y0 };
}

/** つながった雨域（すき間1マスまでは同じ雨域とみなす） */
export function findCells(c, { thr = 3, minCells = 12, maxCount = 6 } = {}) {
  const { W, H, mx, lv } = c;
  const on = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) on[k] = mx[k] >= thr ? 1 : 0;
  const lab = new Int32Array(W * H).fill(-1);
  const cells = [];
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || lab[s] >= 0) continue;
    const id = cells.length, st = [s], idx = []; lab[s] = id;
    while (st.length) {
      const k = st.pop(); idx.push(k);
      const x = k % W, y = (k / W) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (on[q] && lab[q] < 0) { lab[q] = id; st.push(q); }
      }
    }
    let sx = 0, sy = 0, sw = 0, m = 0, at = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const k of idx) {
      const x = k % W, y = (k / W) | 0, w = lv[k];
      sx += x * w; sy += y * w; sw += w; if (mx[k] > m) { m = mx[k]; at = k; }
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    cells.push({ id, idx, n: idx.length, cx: sx / sw, cy: sy / sw, max: m, maxAt: at, sum: sw, bb: [x0, y0, x1, y1] });
  }
  return { cells: cells.filter(k => k.n >= minCells).sort((a, b) => b.sum - a.sum).slice(0, maxCount), lab };
}

/** 雨域の重心・面積などを緯度経度・km で */
function cellGeo(c, k) {
  const gx = c.x0 + (k.cx + 0.5) * c.B, gy = c.y0 + (k.cy + 0.5) * c.B;
  const lat = px2lat(gy, c.z), lon = px2lon(gx, c.z);
  const kmPerPx = 40075 * Math.cos(lat * R) / (256 * 2 ** c.z);
  return { lat, lon, kmPerCell: kmPerPx * c.B, areaKm2: k.n * (kmPerPx * c.B) ** 2 };
}

/**
 * ずれ量の探索：最新の雨域（テンプレート）を、dt 分前の図の中で一番よく重なる位置を探す
 *   戻り値 u, v … dt の間に東向き・南向きに動いたマス数（小数）
 */
export function matchShift(cur, prev, k, maxShift) {
  const { W, H } = cur;
  const [bx0, by0, bx1, by1] = k.bb, pad = 2;
  const tpl = [];
  for (let y = Math.max(0, by0 - pad); y <= Math.min(H - 1, by1 + pad); y++)
    for (let x = Math.max(0, bx0 - pad); x <= Math.min(W - 1, bx1 + pad); x++) tpl.push([x, y, cur.lv[y * W + x]]);
  const S = 2 * maxShift + 1, score = new Float32Array(S * S).fill(Infinity);
  let best = Infinity, bu = 0, bv = 0;
  for (let v = -maxShift; v <= maxShift; v++) for (let u = -maxShift; u <= maxShift; u++) {
    let s = 0, n = 0;
    for (const [x, y, a] of tpl) {
      const px = x - u, py = y - v; if (px < 0 || py < 0 || px >= W || py >= H) continue;
      s += Math.abs(a - prev.lv[py * W + px]); n++;
    }
    if (n < tpl.length * 0.7) continue;
    const sc = s / n + 0.0004 * (u * u + v * v);          // 同じくらいなら小さい動きを選ぶ
    score[(v + maxShift) * S + (u + maxShift)] = sc;
    if (sc < best) { best = sc; bu = u; bv = v; }
  }
  // 放物線で小数点以下を補間
  const at = (u, v) => score[(v + maxShift) * S + (u + maxShift)];
  const sub = (a, b, c) => (isFinite(a) && isFinite(c) && a + c - 2 * b > 1e-6 ? 0.5 * (a - c) / (a + c - 2 * b) : 0);
  const fu = Math.abs(bu) < maxShift ? sub(at(bu - 1, bv), best, at(bu + 1, bv)) : 0;
  const fv = Math.abs(bv) < maxShift ? sub(at(bu, bv - 1), best, at(bu, bv + 1)) : 0;
  // 対比：ずらさないときとの差（小さすぎると動きがはっきりしない）
  const zero = at(0, 0);
  return { u: bu + fu, v: bv + fv, score: best, gain: isFinite(zero) ? zero - best : 0, atEdge: Math.abs(bu) === maxShift || Math.abs(bv) === maxShift };
}

/** 60分前の同じ雨域（動いた分を戻した場所）の強さの合計 */
function pastSum(cur, prev, k, u, v) {
  let s = 0, m = 0;
  const { W, H } = cur, ru = Math.round(u), rv = Math.round(v);
  for (const q of k.idx) {
    const px = q % W - ru, py = ((q / W) | 0) - rv;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    s += prev.lv[py * W + px]; m = Math.max(m, prev.mx[py * W + px]);
  }
  return { s, m };
}

/**
 * 雨域ごとの移動・発達を求める
 * @param frames [{ time: Date, c: coarsen() の結果 }]（新しい順。[0] が最新）
 * @param airports [{ icao, iata, nameJa, lat, lon }]
 */
export function analyzeCells(frames, airports = [], { maxKmh = 120, cellOpts } = {}) {
  const now = frames[0], { cells } = findCells(now.c, cellOpts);
  const out = [];
  for (const k of cells) {
    const g = cellGeo(now.c, k);
    const est = [];
    for (const f of frames.slice(1)) {
      const dtMin = (now.time - f.time) / 60000; if (dtMin < 15 || dtMin > 90) continue;
      const maxShift = Math.ceil(maxKmh * dtMin / 60 / g.kmPerCell) + 1;
      const m = matchShift(now.c, f.c, k, maxShift);
      // ずれ量（マス）→ km/h。東向き u・南向き v
      const kmh = { e: m.u * g.kmPerCell / (dtMin / 60), s: m.v * g.kmPerCell / (dtMin / 60) };
      est.push({ dtMin, ...m, kmh, f });
    }
    if (!est.length) { out.push({ ...g, idx: k.idx, n: k.n, max: k.max, motion: null }); continue; }
    // 長い間隔（60分）を重く。30分と60分の推定が食い違うときは信頼度を下げる
    const wsum = est.reduce((s, e) => s + e.dtMin, 0);
    const ve = est.reduce((s, e) => s + e.kmh.e * e.dtMin, 0) / wsum, vs = est.reduce((s, e) => s + e.kmh.s * e.dtMin, 0) / wsum;
    const spread = est.length > 1 ? Math.hypot(est[0].kmh.e - est.at(-1).kmh.e, est[0].kmh.s - est.at(-1).kmh.s) : 0;
    const speed = Math.hypot(ve, vs);
    const conf = est.some(e => e.atEdge) ? 'low' : spread > Math.max(15, speed * 0.5) ? 'low' : spread > Math.max(8, speed * 0.3) ? 'mid' : 'high';
    // 発達・衰弱（60分前に一番近い図と比べる）
    const e60 = est.reduce((a, b) => (Math.abs(b.dtMin - 60) < Math.abs(a.dtMin - 60) ? b : a));
    const ps = pastSum(now.c, e60.f.c, k, e60.u, e60.v);
    const ratio = ps.s > 0 ? k.sum / ps.s : 9;
    const trend = ratio >= 1.25 ? 'grow' : ratio <= 0.8 ? 'decay' : 'steady';
    // 1時間あたりの緯度経度の変化
    const dLat = -vs / 111.2, dLon = ve / (111.2 * Math.cos(g.lat * R));
    const at = h => ({ lat: g.lat + dLat * h, lon: g.lon + dLon * h });
    // 近づく空港：雨域を円（面積から半径）とみなし、2時間先までの通り道に入る空港
    const rad = Math.sqrt(g.areaKm2 / Math.PI) * 0.8 + 10;
    const apts = [];
    for (const a of airports) {
      const d0 = distKm(g.lat, g.lon, a.lat, a.lon);
      let best = { d: d0, h: 0 };
      for (let h = 0.25; h <= 2.0001; h += 0.25) { const p = at(h); const d = distKm(p.lat, p.lon, a.lat, a.lon); if (d < best.d) best = { d, h }; }
      if (best.d <= rad) apts.push({ a, h: best.h, now: d0 <= rad * 0.7 });
    }
    apts.sort((x, y) => x.h - y.h);
    out.push({
      ...g, idx: k.idx, n: k.n, max: k.max,
      motion: { ve, vs, speed, dir: (Math.atan2(ve, -vs) / R + 360) % 360, conf, lags: est.map(e => e.dtMin) },
      trend, ratio, at1: at(1), at2: at(2), apts: apts.slice(0, 3),
    });
  }
  return out;
}

/** 解説の文章 */
export function motionText(cells, placeName, { time } = {}) {
  if (!cells.length) return ['日本付近に、動きを追えるまとまった降水エコーはない。'];
  const L = [];
  const fmt = d => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  const circ = '①②③④⑤⑥⑦⑧';
  const mm = v => (v >= 80 ? '80mm/h以上' : v >= 50 ? '50mm/h以上' : v >= 30 ? '30mm/h以上' : v >= 20 ? '20mm/h以上' : v >= 10 ? '10mm/h程度' : v >= 5 ? '5mm/h程度' : '弱い雨');
  cells.forEach((c, i) => {
    const area = c.areaKm2 >= 10000 ? `約${Math.round(c.areaKm2 / 10000)}万km²` : `約${Math.round(c.areaKm2 / 100) * 100}km²`;
    let s = `${circ[i] || '・'} ${placeName(c.lat, c.lon)}の雨域（${area}、${c.max >= 5 ? '最大' + mm(c.max) : '弱い雨のみ'}）：`;
    const m = c.motion;
    if (!m) s += '動きを推定できませんでした。';
    else if (m.speed < 8) s += 'ほぼ停滞。';
    else {
      s += `${dirName(m.dir)}へ時速約${Math.round(m.speed / 5) * 5}km（${Math.round(m.speed / 1.852)}kt）で移動。`;
      if (m.conf === 'low') s += '（形の変化が大きく、動きの推定は不確か）';
    }
    s += c.trend === 'grow' ? '1時間前より発達（強まり・広がり）。' : c.trend === 'decay' ? '1時間前より衰弱傾向。' : '';
    // 雲頂（ひまわり赤外の輝度温度から推定）と発達した積乱雲
    if (c.top) s += `推定雲頂 ${c.top.note === 'low' ? 'FL050以下' : 'FL' + String(c.top.fl).padStart(3, '0') + (c.top.note === 'over' ? '以上' : '')}（雲頂温度${Math.round(c.tbb)}℃）。`;
    if (c.cbs?.length) {
      const top = c.cbs.reduce((a, b) => (a.top && b.top && b.top.fl > a.top.fl ? b : a));
      const sev = c.cbs.some(b => b.sev === 'SEV');
      s += `${sev ? '非常に発達した' : '発達した'}積乱雲あり（${c.cbs.length > 1 ? c.cbs.length + 'か所、' : ''}雲頂${top.top ? 'FL' + String(top.top.fl).padStart(3, '0') + (top.top.note === 'over' ? '以上' : '') : '不明'}・最大${mm(Math.max(...c.cbs.map(b => b.maxMm)))}）。雷・強い乱気流・ひょうに注意し、20NM以上離して回避。`;
    }
    if (m && m.speed >= 8) s += `このまま進むと1時間後は${placeName(c.at1.lat, c.at1.lon)}。`;
    if (c.apts?.length) {
      s += c.apts.map(p => p.now ? `${p.a.iata} ${p.a.nameJa.replace(/（.*?）|国際空港|空港/g, '')}は現在雨域内` :
        p.h === 0 ? `${p.a.iata} ${p.a.nameJa.replace(/（.*?）|国際空港|空港/g, '')}は雨域の縁にかかっている` :
        `${p.a.iata} ${p.a.nameJa.replace(/（.*?）|国際空港|空港/g, '')}に約${p.h < 1 ? Math.round(p.h * 60) + '分' : p.h.toFixed(1).replace('.0', '') + '時間'}後に接近${time ? `（${fmt(new Date(time.getTime() + p.h * 3.6e6))}頃）` : ''}`).join('、') + '。';
    }
    L.push(s);
  });
  return L;
}
