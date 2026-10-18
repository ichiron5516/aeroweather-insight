// 雲頂高度の推定と「発達した積乱雲」の判定（計算部分。画面やネットワークには触れない）
//
//   ■ 雲頂の輝度温度（TBB）
//     気象庁ホームページのひまわり赤外画像（B13/TBB）は白黒の画像で、温度そのものではない。
//     実際の画像で、晴れた海域（海面水温 ≈ 気温）と台風の厚い雲（雲頂 ≈ 圏界面の気温）を比べると、
//     明るさ 0（黒）≈ +40℃、255（白）≈ −80℃ のほぼ直線の対応になっていた（誤差 ±3℃ 程度）。
//
//   ■ 雲頂高度
//     厚い雲の雲頂はほぼ黒体なので「TBB ≈ 雲頂の気温」。その地点の気温の鉛直分布（数値予報）で
//     気温が TBB になる気圧を探し、標準大気で気圧高度（FL）に直す。
//     ・圏界面より冷たい（オーバーシュート）ときは圏界面の高さで頭打ち
//     ・薄い巻雲は下の熱が透けるので低めに出る（強いエコーと重なる場所＝厚い雲に限って使う）
//
//   ■ 発達した積乱雲
//     強いエコー（20mm/h以上）と冷たい雲頂（TBB −40℃以下 ≈ 夏はFL330〜360より上）が重なる場所。
//     50mm/h以上 または TBB −65℃以下 は「非常に発達」。

export const PROFILE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];

/** 赤外画像の明るさ（0〜255）→ 輝度温度（℃） */
export const tbbFromGray = g => 40 - g * 120 / 255;

/** 気圧（hPa）→ 標準大気の気圧高度（ft） */
export const pressureAltFt = p => 145366.45 * (1 - (p / 1013.25) ** 0.190284);

/**
 * TBB から雲頂の気圧高度を求める
 * @param prof [{ p, t }]（気圧の大きい順＝下から上）
 * @returns { fl, p, note }  note: 'over'（圏界面より冷たい）・'low'（下層の雲）・null
 */
export function topFromTbb(prof, tbb) {
  const L = prof.filter(x => x.t != null).sort((a, b) => b.p - a.p);
  if (L.length < 3) return null;
  // 圏界面：400hPa より上で気温が最も低い面
  const up = L.filter(x => x.p <= 400);
  const trop = up.reduce((m, x) => (x.t < m.t ? x : m), up[0] || L.at(-1));
  if (tbb <= trop.t) return { fl: Math.round(pressureAltFt(trop.p) / 1000) * 10, p: trop.p, note: 'over' };
  const i850 = L.findIndex(x => x.p <= 850);
  if (tbb >= L[Math.max(0, i850)].t) return { fl: Math.round(pressureAltFt(850) / 100), p: 850, note: 'low' };
  for (let i = Math.max(0, i850); i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (b.p < trop.p) break;
    if (a.t >= tbb && tbb >= b.t) {
      const f = a.t === b.t ? 0 : (a.t - tbb) / (a.t - b.t);
      const p = Math.exp(Math.log(a.p) + f * (Math.log(b.p) - Math.log(a.p)));
      return { fl: Math.round(pressureAltFt(p) / 1000) * 10, p: Math.round(p), note: null };   // FL は10単位に丸める
    }
  }
  return { fl: Math.round(pressureAltFt(trop.p) / 1000) * 10, p: trop.p, note: 'over' };
}

/** B×B マスにまとめる（降水は最大、TBB は平均） */
export function coarseGrid(rainR, tbbR, B = 4) {
  const W = Math.floor(rainR.W / B), H = Math.floor(rainR.H / B);
  const mx = new Float32Array(W * H), tb = new Float32Array(W * H).fill(NaN);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let m = 0, s = 0, n = 0;
    for (let y = j * B; y < j * B + B; y++) for (let x = i * B; x < i * B + B; x++) {
      const k = y * rainR.W + x;
      if (rainR.rain[k] > m) m = rainR.rain[k];
      if (tbbR && isFinite(tbbR.tbb[k])) { s += tbbR.tbb[k]; n++; }
    }
    mx[j * W + i] = m; if (n) tb[j * W + i] = s / n;
  }
  return { W, H, B, mx, tb, z: rainR.z, x0: rainR.x0, y0: rainR.y0 };
}

const px2lon = (x, z) => x / (256 * 2 ** z) * 360 - 180;
const px2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (256 * 2 ** z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
export const cellLatLon = (g, k) => {
  const x = k % g.W, y = (k / g.W) | 0;
  return { lat: px2lat(g.y0 + (y + 0.5) * g.B, g.z), lon: px2lon(g.x0 + (x + 0.5) * g.B, g.z) };
};
/** 低い順に並べたときの p 分位（外れ値に強い最低温度） */
const pct = (arr, p) => { const a = arr.filter(isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN; };

/**
 * 発達した積乱雲のマスを見つけ、つながったものを1つの積乱雲（群）にまとめる
 * @returns [{ lat, lon, radiusKm, maxMm, tbb, n, cells:[{lat,lon}], sev:'SEV'|'MOD' }]
 */
export function detectCb(g, { mmMin = 20, tbbMax = -40 } = {}) {
  const { W, H, mx, tb } = g;
  const on = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) on[k] = mx[k] >= mmMin && tb[k] <= tbbMax ? 1 : 0;
  const seen = new Uint8Array(W * H), out = [];
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || seen[s]) continue;
    const st = [s], idx = []; seen[s] = 1;
    while (st.length) {
      const k = st.pop(); idx.push(k);
      const x = k % W, y = (k / W) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {     // 1マスのすき間は同じ積乱雲群
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (on[q] && !seen[q]) { seen[q] = 1; st.push(q); }
      }
    }
    // 雲頂は、積乱雲のマスとその周り2マスの冷たい方から1割の値（かなとこ雲の頂）
    const around = [];
    for (const k of idx) { const x = k % W, y = (k / W) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) around.push(tb[ny * W + nx]); } }
    const cells = idx.map(k => cellLatLon(g, k));
    const lat = cells.reduce((s, c) => s + c.lat, 0) / cells.length, lon = cells.reduce((s, c) => s + c.lon, 0) / cells.length;
    const kmPerCell = 40075 * Math.cos(lat * Math.PI / 180) / (256 * 2 ** g.z) * g.B;
    const maxMm = Math.max(...idx.map(k => mx[k])), tbb = pct(around, 0.1);
    out.push({ lat, lon, n: idx.length, idx, cells, maxMm, tbb, radiusKm: Math.sqrt(idx.length / Math.PI) * kmPerCell + kmPerCell / 2,
      sev: maxMm >= 50 || tbb <= -65 ? 'SEV' : 'MOD' });
  }
  return out.sort((a, b) => a.tbb - b.tbb);
}

/** 雨域（radarMotionCore の雨域）ごとの推定雲頂：雨域のマスの冷たい方から1割の TBB */
export function cellTopTbb(g, idx) {
  return pct(idx.map(k => g.tb[k]), 0.1);
}

export const flText = top => !top ? '' : top.note === 'low' ? 'FL050以下（下層の雲）' : `FL${String(top.fl).padStart(3, '0')}${top.note === 'over' ? '以上（圏界面付近）' : ''}`;

/**
 * 3D 表示用：TBB から雲頂の気圧高度（ft、連続値）。下から上へ見て最初に気温が TBB になる高さ
 *   ・下層の気温より 6℃ 以上低くなければ「雲なし」（null）
 *   ・圏界面より冷たいときは圏界面の高さ
 */
export function topAltFt(prof, tbb) {
  const L = prof.filter(x => x.t != null).sort((a, b) => b.p - a.p);
  if (L.length < 3 || !isFinite(tbb)) return null;
  if (tbb > L[0].t - 6) return null;
  const up = L.filter(x => x.p <= 400);
  const trop = up.reduce((m, x) => (x.t < m.t ? x : m), up[0] || L.at(-1));
  if (tbb <= trop.t) return pressureAltFt(trop.p);
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (a.t >= tbb && tbb >= b.t) {
      const f = a.t === b.t ? 0 : (a.t - tbb) / (a.t - b.t);
      return pressureAltFt(Math.exp(Math.log(a.p) + f * (Math.log(b.p) - Math.log(a.p))));
    }
    if (b.p <= trop.p) break;
  }
  return pressureAltFt(Math.max(trop.p, L[0].p > 950 ? 950 : L[0].p));   // 逆転層などで交点がないとき
}
