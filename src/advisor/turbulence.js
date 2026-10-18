// 晴天乱気流(CAT)指数 — Ellrod TI1 = 鉛直ウィンドシア(VWS) × 水平変形(DEF)
//   単位 1e-7 s^-2。目安: 4以上=弱、8以上=並、12以上=強（Ellrod & Knapp 1992）
//   気圧面の風（風速・風向）とジオポテンシャル高度の格子から、隣り合う気圧面の間の層ごとに計算する。

const R_EARTH = 6371000;
const FT = 3.28084;

export const TI_LEVELS = [
  { min: 12, cls: 'SEV', label: '強' },
  { min: 8, cls: 'MOD', label: '並' },
  { min: 4, cls: 'LGT', label: '弱' },
];
export const tiClass = ti => TI_LEVELS.find(l => ti >= l.min) || null;

/**
 * grid: { lats:[...], lons:[...], levels:[500,400,300,250,200], times:[ISO...],
 *         spd[t][k][i][j] (m/s), dir[t][k][i][j] (deg), z[t][k][i][j] (m) }
 * 返り値: { layers:[{lo,hi}], ti[t][layer][i][j], zlo[t][layer][i][j](ft), zhi(ft) }
 */
export function computeTI(grid) {
  const { lats, lons, levels, times } = grid;
  const NI = lats.length, NJ = lons.length;
  const dphi = (lats[1] - lats[0]) * Math.PI / 180;
  const dlam = (lons[1] - lons[0]) * Math.PI / 180;
  const layers = [];
  for (let k = 0; k + 1 < levels.length; k++) layers.push({ lo: levels[k], hi: levels[k + 1] });
  const out = { layers, ti: [], zlo: [], zhi: [] };
  for (let t = 0; t < times.length; t++) {
    const uv = levels.map((_, k) => {
      const u = [], v = [];
      for (let i = 0; i < NI; i++) {
        u.push([]); v.push([]);
        for (let j = 0; j < NJ; j++) {
          const s = grid.spd[t][k][i][j], d = grid.dir[t][k][i][j] * Math.PI / 180;
          u[i].push(-s * Math.sin(d)); v[i].push(-s * Math.cos(d));
        }
      }
      return { u, v };
    });
    const TIt = [], ZL = [], ZH = [];
    layers.forEach((_, L) => {
      const a = uv[L], b = uv[L + 1];
      const za = grid.z[t][L], zb = grid.z[t][L + 1];
      const ti = [], zl = [], zh = [];
      for (let i = 0; i < NI; i++) {
        ti.push([]); zl.push([]); zh.push([]);
        for (let j = 0; j < NJ; j++) {
          const dz = Math.max(50, zb[i][j] - za[i][j]);
          const vws = Math.hypot(b.u[i][j] - a.u[i][j], b.v[i][j] - a.v[i][j]) / dz;
          // 層平均風の水平変形（中心差分、端は片側差分）
          const U = (ii, jj) => (a.u[ii][jj] + b.u[ii][jj]) / 2, V = (ii, jj) => (a.v[ii][jj] + b.v[ii][jj]) / 2;
          const i0 = Math.max(0, i - 1), i1 = Math.min(NI - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(NJ - 1, j + 1);
          const dx = R_EARTH * Math.cos(lats[i] * Math.PI / 180) * dlam * (j1 - j0);
          const dy = R_EARTH * dphi * (i1 - i0);
          const dudx = (U(i, j1) - U(i, j0)) / dx, dvdx = (V(i, j1) - V(i, j0)) / dx;
          const dudy = (U(i1, j) - U(i0, j)) / dy, dvdy = (V(i1, j) - V(i0, j)) / dy;
          const def = Math.hypot(dudx - dvdy, dvdx + dudy);
          ti[i].push(Math.round(vws * def * 1e7 * 10) / 10);
          zl[i].push(za[i][j] * FT); zh[i].push(zb[i][j] * FT);
        }
      }
      TIt.push(ti); ZL.push(zl); ZH.push(zh);
    });
    out.ti.push(TIt); out.zlo.push(ZL); out.zhi.push(ZH);
  }
  return out;
}

function bilinear(arr, lats, lons, lat, lon) {
  const fi = (lat - lats[0]) / (lats[1] - lats[0]), fj = (lon - lons[0]) / (lons[1] - lons[0]);
  if (fi < 0 || fj < 0 || fi > lats.length - 1 || fj > lons.length - 1) return null;
  const i = Math.min(Math.floor(fi), lats.length - 2), j = Math.min(Math.floor(fj), lons.length - 2);
  const a = fi - i, b = fj - j;
  return arr[i][j] * (1 - a) * (1 - b) + arr[i + 1][j] * a * (1 - b) + arr[i][j + 1] * (1 - a) * b + arr[i + 1][j + 1] * a * b;
}

/** 任意地点・高度(ft)・時刻index の TI。該当層がなければ null */
export function tiAt(grid, tiField, t, lat, lon, altFt) {
  const { lats, lons } = grid;
  for (let L = tiField.layers.length - 1; L >= 0; L--) {
    const lo = bilinear(tiField.zlo[t][L], lats, lons, lat, lon);
    const hi = bilinear(tiField.zhi[t][L], lats, lons, lat, lon);
    if (lo == null) return null;
    const top = L === tiField.layers.length - 1 ? hi + 3000 : hi;   // 最上層は上に3,000ftまで延長
    if (altFt >= lo && altFt <= top) return { ti: bilinear(tiField.ti[t][L], lats, lons, lat, lon), layer: tiField.layers[L] };
  }
  return null;
}

/** 層平均の風（ノット・風向）— 表示用 */
export function windAt(grid, t, k, lat, lon) {
  const s = bilinear(grid.spd[t][k], grid.lats, grid.lons, lat, lon);
  if (s == null) return null;
  return { kt: Math.round(s * 1.94384), dir: Math.round(bilinear(grid.dir[t][k], grid.lats, grid.lons, lat, lon)) };
}
export { bilinear };
