// 京都大学 生存圏研究所（RISH）の気象庁 GPV アーカイブから GSM（全球モデル）を読む（2026-10-18）
//   http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original/YYYY/MM/DD/
//     Z__C_RJTD_YYYYMMDDhh0000_GSM_GPV_Rgl_FDddhh_grib2.bin（全球 0.5 度、予報時間 ddhh＝日・時。6 時間ごと）
//   ・フォルダは「初期時刻の UTC の日付」。アーカイブへの掲載は 1 日 1 回（日本時間の朝 9 時すぎに前日分）なので、
//     いちばん新しい初期時刻は 6〜30 時間前になる（予報は 132 時間先まで、12UTC は 264 時間先まで）
//   ・RISH は https でなく、ブラウザから直接は読めない（CORS）。開発時は Vite の中継（/aeroweather-insight/rish）、
//     公開サイトは Cloudflare Workers の中継（tools/wx-proxy-worker.js の /rish、VITE_WX_PROXY）を通す
//   ・1 ファイル約 33MB。ブラウザの Cache Storage に入れて、同じ日のうちは読み直さない。メモリには 3 ファイルまで
//   ・利用は研究・教育目的（RISH のアーカイブの利用条件に従う）
import { indexGrib2, sample } from './grib2.js';

const RISH = 'http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original';
const CACHE = 'aw-rish-gsm-v1';
const H = 3600e3;

export function rishBase() {
  const env = import.meta.env || {};
  if (env.DEV) return `${env.BASE_URL || '/aeroweather-insight/'}rish`;
  if (env.VITE_WX_PROXY) return `${String(env.VITE_WX_PROXY).replace(/\/$/, '')}/rish`;
  return null;
}
const status = detail => { try { window.dispatchEvent(new CustomEvent('aw:gpvsrc', { detail })); } catch { /* なし */ } };

// ---------- 初期時刻と予報時間の一覧（フォルダの一覧から）----------
let runsCache = null;   // { at, runs: [{ init(ms), dir, fds:Set(時間) }] }
const pad = n => String(n).padStart(2, '0');
const dayDir = d => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
export async function listRuns() {
  if (runsCache && Date.now() - runsCache.at < 10 * 60e3) return runsCache.runs;
  const base = rishBase();
  if (!base) throw new Error('RISH の中継がありません');
  const runs = new Map();
  const today = new Date();
  for (let k = 0; k < 3; k++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - k));
    let t;
    try {
      const r = await fetch(`${base}/${dayDir(d)}/`, { cache: 'no-store' });
      if (!r.ok) continue;
      t = await r.text();
    } catch { continue; }
    for (const m of t.matchAll(/Z__C_RJTD_(\d{4})(\d\d)(\d\d)(\d\d)0000_GSM_GPV_Rgl_FD(\d\d)(\d\d)_grib2\.bin/g)) {
      const init = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
      const r = runs.get(init) || runs.set(init, { init, dir: dayDir(new Date(init)), fds: new Set() }).get(init);
      r.fds.add(+m[5] * 24 + +m[6]);
    }
    if (runs.size && k >= 1) break;   // 新しい初期時刻が見つかったら、それより前の日は見なくてよい
  }
  const list = [...runs.values()].filter(r => r.fds.has(0)).sort((a, b) => b.init - a.init);
  if (!list.length) throw new Error('RISH に GSM が見つかりません');
  runsCache = { at: Date.now(), runs: list };
  return list;
}

const fileName = (init, fh) => {
  const d = new Date(init);
  return `Z__C_RJTD_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}0000_GSM_GPV_Rgl_FD${pad(Math.floor(fh / 24))}${pad(fh % 24)}_grib2.bin`;
};

// ---------- ファイルの読み込み（Cache Storage → 中継）。同じファイルは 1 回だけ ----------
const mem = new Map();        // url → Promise<{ bytes, idx }>（新しく使った順）
const MEM_MAX = 3;
async function fromCache(url) {
  try { const c = await caches.open(CACHE); const r = await c.match(url); return r ? await r.arrayBuffer() : null; } catch { return null; }
}
async function toCache(url, buf) {
  try {
    const c = await caches.open(CACHE);
    await c.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
    // 古いもの（2 日より前の初期時刻）は消す
    const old = Date.now() - 2 * 24 * H;
    for (const req of await c.keys()) {
      const m = req.url.match(/RJTD_(\d{4})(\d\d)(\d\d)(\d\d)0000_GSM/);
      if (m && Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) < old) await c.delete(req);
    }
  } catch { /* 入らなくても続ける */ }
}
export function loadFile(run, fh) {
  const url = `${rishBase()}/${run.dir}/${fileName(run.init, fh)}`;
  if (mem.has(url)) { const p = mem.get(url); mem.delete(url); mem.set(url, p); return p; }
  const p = (async () => {
    let buf = await fromCache(url);
    if (!buf) {
      status({ state: 'loading', file: fileName(run.init, fh) });
      const r = await fetch(url);
      if (!r.ok) throw new Error(`RISH ${r.status}`);
      buf = await r.arrayBuffer();
      if (buf.byteLength < 1e5) throw new Error('RISH のファイルが小さすぎます');
      toCache(url, buf);
    }
    const idx = indexGrib2(buf);
    if (!idx.length) throw new Error('GRIB2 を読めません');
    status({ state: 'ready', file: fileName(run.init, fh) });
    return { bytes: new Uint8Array(buf), idx };
  })();
  p.catch(() => mem.delete(url));
  mem.set(url, p);
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
  return p;
}

// ---------- 要素の取り出し ----------
// 名前 → [分野, 種類, 番号, 第一固定面の種類]
export const ELEM = {
  T: [0, 0, 0, 100], RH: [0, 1, 1, 100], U: [0, 2, 2, 100], V: [0, 2, 3, 100], W: [0, 2, 8, 100], Z: [0, 3, 5, 100],
  PMSL: [0, 3, 1, 101], PS: [0, 3, 0, 1], T2: [0, 0, 0, 103], RH2: [0, 1, 1, 103], U10: [0, 2, 2, 103], V10: [0, 2, 3, 103],
  CC: [0, 6, 1, 1], CCL: [0, 6, 3, 1], CCM: [0, 6, 4, 1], CCH: [0, 6, 5, 1], PR: [0, 1, 8, 1],
};
function findField(idx, key, lv) {
  const [d, c, n, lt] = ELEM[key];
  return idx.find(f => f.disc === d && f.cat === c && f.num === n && f.lt === lt && (lt !== 100 || f.lv === lv));
}

/**
 * 地点・時刻ごとの値
 * @param need [[要素, 気圧面 or null], …]
 * @param pts  [[lat, lon], …]
 * @param times [ms, …]（1 時間ごとなど。予報時間の間は時間で直線補間）
 * @returns { init, values: Map('要素|気圧面' → Float32Array(times × pts)、無い所は NaN) }
 */
export async function gsmValues(need, pts, times) {
  const runs = await listRuns();
  const run = runs[0];
  const fds = [...run.fds].sort((a, b) => a - b), last = fds.at(-1);
  // 時刻ごとに、前後の予報時間と重み
  const plan = times.map(t => {
    const fh = (t - run.init) / H;
    if (fh < 0 || fh > last) return null;
    let a = fds[0];
    for (const f of fds) if (f <= fh) a = f;
    const b = fds.find(f => f >= fh) ?? a;
    return { a, b, w: b === a ? 0 : (fh - a) / (b - a) };
  });
  const files = [...new Set(plan.filter(Boolean).flatMap(p => [p.a, p.b]))].sort((a, b) => a - b);
  const values = new Map(need.map(([k, lv]) => [`${k}|${lv ?? ''}`, new Float32Array(times.length * pts.length).fill(NaN)]));
  // 予報時間ごとに 1 ファイルずつ読み、その場で地点の値を取り出す（ファイルは持ち続けない）
  const at = new Map();   // fh → Map(key → Float32Array(pts))
  for (const fh of files) {
    const { bytes, idx } = await loadFile(run, fh);
    const m = new Map();
    for (const [k, lv] of need) {
      const f = findField(idx, k, lv), a = new Float32Array(pts.length).fill(NaN);
      if (f) for (let n = 0; n < pts.length; n++) { const v = sample(bytes, f, pts[n][0], pts[n][1]); if (v != null) a[n] = v; }
      m.set(`${k}|${lv ?? ''}`, a);
    }
    at.set(fh, m);
  }
  plan.forEach((p, ti) => {
    if (!p) return;
    for (const [key, out] of values) {
      const A = at.get(p.a)?.get(key), B = at.get(p.b)?.get(key);
      if (!A || !B) continue;
      for (let n = 0; n < pts.length; n++) out[ti * pts.length + n] = A[n] * (1 - p.w) + B[n] * p.w;
    }
  });
  return { init: run.init, values };
}
