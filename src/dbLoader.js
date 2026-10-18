// 航法・空港・空域データベースの読み込み（日本＋海外の国別データを1つにまとめる）
//   日本：public/data/nav/nav_db.json・airport_db.json、public/data/airspace/airspace_db.json
//   海外：public/data/intl/index.json に載っている国（例 kr/）の nav_db.json・airport_db.json・airspace_db.json
//   ・同じ名前の地点が離れた場所にあるときは、海外側を「名前~国コード」で持つ（表示は ident）
//   ・同じ名前の航空路は、端がつながっていれば1本にし、つながらなければ「名前~国コード」で別に持つ（表示は designator）
//   ・読み込みは一度だけ（どのモジュールから呼んでも同じものを返す）
//   ・AIP 取り込みパネルでブラウザにしまった国別データも足す（2026-10-18。同じ国コードなら置き換え）
//   ・空域は index.json の airspaceExtra（補足データ）も足す（2026-10-18）
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
const get = u => fetch(BASE + u).then(r => (r.ok ? r.json() : null)).catch(() => null);
let IDX = null;
export const countries = () => (IDX ||= get('data/intl/index.json').then(x => x?.countries || []));
// AIP 取り込みパネル（src/aipImport/）でブラウザにしまった国別データ。同じ国コードの public/data/intl/ のデータは、その種類だけ置き換える
let PKG = null;
export const userPackages = () => (PKG ||= import('./aipImport/aipStore.js').then(m => m.listPackages()).catch(() => []));
async function intl(kind) {
  const list = await countries(), pk = (await userPackages()).filter(p => p[kind]);
  // 航法・空域は国ごと置き換え、空港は足す（同じ ICAO は取り込んだ方を使う。選ばなかった空港は今のまま）
  const own = new Set(kind === 'airports' ? [] : pk.map(p => p.code));
  const res = await Promise.all(list.filter(c => c[kind] && !own.has(c.code)).map(async c => ({ c, db: await get(`data/intl/${c[kind]}`) })));
  return [...res.filter(x => x.db), ...pk.map(p => ({ c: { code: p.code, name: p.name, user: true }, db: p[kind] }))];
}
const nm = (a, b) => {
  const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
};

let NAV = null;
export function loadNavDb() {
  return (NAV ||= (async () => {
    const base = (await get('data/nav/nav_db.json')) || { fixes: {}, airways: {} };
    const F = { ...base.fixes }, A = { ...base.airways };
    for (const { c, db } of await intl('nav')) {
      const cc = c.code, ren = {};
      for (const [id, f] of Object.entries(db.fixes)) {
        const o = F[id];
        if (!o) F[id] = { ...f, country: cc };
        else if (nm(o, f) > 5) { ren[id] = `${id}~${cc}`; F[ren[id]] = { ...f, ident: id, country: cc }; }
      }
      for (const [d, a] of Object.entries(db.airways)) {
        const pts = a.points.map(p => ren[p] || p), seg = a.segments || [];
        const o = A[d];
        if (!o) { A[d] = { ...a, points: pts }; continue; }
        // 途中の地点まで重なっているとき（例 B202：タイの UBL–PAK とラオスの UBL–PAK–BOMPA）はつながず別に持つ。
        // 全部含まれていれば何もしない。つなぎ方は aeroNavCore.js が同じ名前の航空路を網として探す
        const shared = pts.filter(p => o.points.includes(p)).length;
        if (shared === pts.length) continue;
        if (shared > 1) { A[`${d}~${cc}`] = { ...a, points: pts, designator: d }; continue; }
        if (o.points.at(-1) === pts[0]) A[d] = { ...o, points: [...o.points, ...pts.slice(1)], segments: [...(o.segments || []), ...seg] };
        else if (pts.at(-1) === o.points[0]) A[d] = { ...o, points: [...pts, ...o.points.slice(1)], segments: [...seg, ...(o.segments || [])] };
        else if (o.points.at(-1) === pts.at(-1)) A[d] = { ...o, points: [...o.points, ...[...pts].reverse().slice(1)], segments: [...(o.segments || []), ...[...seg].reverse()] };
        else if (o.points[0] === pts[0]) A[d] = { ...o, points: [...[...pts].reverse(), ...o.points.slice(1)], segments: [...[...seg].reverse(), ...(o.segments || [])] };
        else A[`${d}~${cc}`] = { ...a, points: pts, designator: d };
      }
    }
    return { ...base, fixes: F, airways: A };
  })());
}

let APT = null;
export function loadAirportDb() {
  return (APT ||= (async () => {
    const base = (await get('data/nav/airport_db.json')) || { airports: {}, waypoints: {}, index: { byIata: {} } };
    const db = { ...base, airports: { ...base.airports }, waypoints: { ...base.waypoints }, index: { ...base.index, byIata: { ...(base.index?.byIata || {}) } } };
    for (const { c, db: x } of await intl('airports')) {
      for (const [k, a] of Object.entries(x.airports)) db.airports[k] = { ...a, country: c.code };
      // 同じ名前の手順の地点が離れた場所にあるとき（例 NYLON：成田とシンガポール）は「名前~国コード」で別に持つ
      for (const [k, w] of Object.entries(x.waypoints || {})) {
        const o = db.waypoints[k];
        if (!o) db.waypoints[k] = w;
        else if (o.lat != null && w.lat != null && nm(o, w) > 5) db.waypoints[`${k}~${c.code}`] = { ...w, ident: k, country: c.code };
      }
      Object.assign(db.index.byIata, x.index?.byIata || {});
    }
    return db;
  })());
}

let ASP = null;
export function loadAirspaceDb() {
  return (ASP ||= (async () => {
    const base = (await get('data/airspace/airspace_db.json')) || { items: [] };
    const items = [...base.items];
    for (const { c, db } of await intl('airspace')) for (const o of db.items) items.push({ ...o, country: c.code });
    // 補足データ（airspaceExtra：FIR・ACC・米国の特別使用空域・ADIZ など。tools/intl/common/airspace_extra.py）。
    // 同じ id がすでにあれば（AIP から作った方を優先して）足さない
    const ids = new Set(items.map(o => `${o.country || 'JP'}|${o.id}`));
    const list = await countries();
    const ex = await Promise.all(list.filter(c => c.airspaceExtra).map(async c => ({ c, db: await get(`data/intl/${c.airspaceExtra}`) })));
    for (const { c, db } of ex) for (const o of db?.items || []) if (!ids.has(`${c.code}|${o.id}`)) items.push({ ...o, country: c.code });
    return { ...base, items };
  })());
}
