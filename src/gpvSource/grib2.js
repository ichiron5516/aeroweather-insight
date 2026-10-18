// GRIB2 の読み取り（気象庁 GSM の GPV 用。2026-10-18）
//   気象庁の GRIB2 は 1 つのメッセージの中に、第 3〜7 節（格子・プロダクト・資料表現・ビットマップ・資料）が
//   要素の数だけ繰り返して入っている。全部を展開せず、各要素の「どこに・どう詰めてあるか」だけを索引にし、
//   必要な地点の値だけを詰めたビット列から直接取り出す（単純圧縮＝資料表現テンプレート 5.0 だけ対応）
//   ・格子は等緯度経度（テンプレート 3.0）。GSM 全球は 0.5 度（720×361）と 1 度（360×181）
//   ・気圧面（第一固定面の種類 100）の値はヘクトパスカルに直して持つ

const u32 = (v, o) => v.getUint32(o);
const s32 = (v, o) => { const x = v.getUint32(o); return x & 0x80000000 ? -(x & 0x7fffffff) : x; };   // 符号と絶対値
const s16 = (v, o) => { const x = v.getUint16(o); return x & 0x8000 ? -(x & 0x7fff) : x; };
const sByte = b => (b & 0x80 ? -(b & 0x7f) : b);

/**
 * ファイル全体（ArrayBuffer）から要素の索引を作る
 * @returns [{ disc, cat, num, lt, lv（気圧面は hPa）, pdt, g:{ Ni, Nj, la1, lo1, dx, dy, scan }, R, E, D, nb, off }]
 */
export function indexGrib2(buf) {
  const v = new DataView(buf), b = new Uint8Array(buf), out = [];
  let i = 0;
  while (i + 16 <= b.length && b[i] === 0x47 && b[i + 1] === 0x52 && b[i + 2] === 0x49 && b[i + 3] === 0x42) {   // 'GRIB'
    const disc = b[i + 6], len = Number(v.getBigUint64(i + 8));
    let j = i + 16;
    const cur = { disc };
    while (j < i + len - 4) {
      const sl = u32(v, j), sn = b[j + 4];
      if (sl <= 0) break;
      if (sn === 3) {
        cur.g = {
          tpl: v.getUint16(j + 12), Ni: u32(v, j + 30), Nj: u32(v, j + 34),
          la1: s32(v, j + 46) / 1e6, lo1: s32(v, j + 50) / 1e6, la2: s32(v, j + 55) / 1e6, lo2: s32(v, j + 59) / 1e6,
          dx: s32(v, j + 63) / 1e6, dy: s32(v, j + 67) / 1e6, scan: b[j + 71],
        };
      } else if (sn === 4) {
        cur.pdt = v.getUint16(j + 7); cur.cat = b[j + 9]; cur.num = b[j + 10];
        cur.lt = b[j + 22];
        const sf = sByte(b[j + 23]), raw = u32(v, j + 24);
        const val = raw * 10 ** -sf;
        cur.lv = cur.lt === 100 ? Math.round(val / 100) : val;    // 気圧面は Pa → hPa
      } else if (sn === 5) {
        cur.drt = v.getUint16(j + 9); cur.R = v.getFloat32(j + 11); cur.E = s16(v, j + 15); cur.D = s16(v, j + 17); cur.nb = b[j + 19];
      } else if (sn === 6) {
        cur.bmp = b[j + 5];
      } else if (sn === 7) {
        if (cur.drt === 0 && cur.g?.tpl === 0 && (cur.bmp === 255 || cur.bmp == null)) out.push({ ...cur, off: j + 5 });
      }
      j += sl;
    }
    i += len;
  }
  return out;
}

/** k 番目の格子点の値 */
function valueAt(bytes, f, k) {
  const nb = f.nb;
  if (nb === 0) return f.R / 10 ** f.D;
  const bit = k * nb, p = f.off + (bit >>> 3), sh = bit & 7;
  // 最大 25 ビット＋ずれ 7 ビットまでは 4 バイトで足りる
  const w = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  const x = (w >>> (32 - sh - nb)) & ((2 ** nb) - 1);
  return (f.R + x * 2 ** f.E) / 10 ** f.D;
}

/** 緯度・経度の値（双一次補間）。範囲の外は null */
export function sample(bytes, f, lat, lon) {
  const g = f.g;
  // 走査：scan の 0x40 が立っていなければ北から南（j は下向き）
  const south = (g.scan & 0x40) !== 0;
  const fy = south ? (lat - g.la1) / g.dy : (g.la1 - lat) / g.dy;
  let fx = (((lon - g.lo1) % 360) + 360) % 360 / g.dx;
  if (fy < 0 || fy > g.Nj - 1) return null;
  const wrap = Math.round(360 / g.dx) === g.Ni;
  if (!wrap && fx > g.Ni - 1) return null;
  const i0 = Math.floor(fy), j0 = Math.floor(fx), ty = fy - i0, tx = fx - j0;
  const i1 = Math.min(i0 + 1, g.Nj - 1), j1 = wrap ? (j0 + 1) % g.Ni : Math.min(j0 + 1, g.Ni - 1);
  const v = (i, j) => valueAt(bytes, f, i * g.Ni + j);
  return (v(i0, j0) * (1 - tx) + v(i0, j1) * tx) * (1 - ty) + (v(i1, j0) * (1 - tx) + v(i1, j1) * tx) * ty;
}
