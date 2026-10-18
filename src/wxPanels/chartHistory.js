// 高層天気図・高層断面図（PDF）の過去のコマを、ブラウザの中（IndexedDB）に記録してためる（2026-10-17）
//   気象庁が公開しているのは、図ごとに最新の 00UTC と 12UTC の2枚だけ（aupq35_00.pdf・aupq35_12.pdf など、名前は固定）。
//   過去の高層天気図の公開場所はないため、アプリを開くたびに2枚の PDF を取って保存し、最大72時間（7コマ）までためて動画にする。
//   ・解析時刻は、ファイルの更新時刻（Last-Modified）から決める（00UTC の図は 01〜04UTC ごろ、12UTC の図は 13〜16UTC ごろ更新）
//   ・アプリを開かなかった時間帯のコマは抜ける。ブラウザのデータを消すと、ためた分も消える
const DB = 'aw-chart-history', ST = 'pdf', KEEP_MS = 72 * 3600e3;
let dbp = null;
function db() {
  return (dbp ||= new Promise((ok, ng) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(ST, { keyPath: 'key' }); s.createIndex('id', 'id'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
  }));
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, ng) => { const t = d.transaction(ST, mode); const res = fn(t.objectStore(ST)); t.oncomplete = () => ok(res?.result ?? res); t.onerror = () => ng(t.error); }); };
const getAll = id => tx('readonly', s => s.index('id').getAll(id));

/** ファイルの更新時刻 → 解析時刻（ms）。cyc は '00' または '12' */
function analysisTime(lastModified, cyc) {
  const lm = new Date(lastModified); if (isNaN(lm)) return null;
  let t = Date.UTC(lm.getUTCFullYear(), lm.getUTCMonth(), lm.getUTCDate(), +cyc);
  if (t > lm.getTime()) t -= 864e5;                       // 更新が解析時刻より前（日付をまたいだ）なら前の日
  return t;
}

const urls = new Map();                                   // 図ごとに作った blob URL（作り直すときに捨てる）
/**
 * 最新の 00UTC・12UTC の PDF を記録し、72時間分のコマ（古い順）を返す
 * @param id 図の名前（aupq35 など）、base 'https://…/aupq35'（_00.pdf・_12.pdf を付けて取る）
 * @returns [{ t（ms）, url（PDF の blob URL） }]
 */
export async function chartHistory(id, base) {
  let have = [];
  try { have = await getAll(id); } catch (e) { console.warn('[chart history] db', e); }
  const known = new Set(have.map(r => r.t));
  await Promise.all(['00', '12'].map(async cyc => {
    try {
      const h = await fetch(`${base}_${cyc}.pdf`, { method: 'HEAD', cache: 'no-store' });
      if (!h.ok) return;
      const t = analysisTime(h.headers.get('last-modified'), cyc);
      if (t == null || known.has(t)) return;
      const buf = await (await fetch(`${base}_${cyc}.pdf`, { cache: 'no-store' })).arrayBuffer();
      const rec = { key: `${id}|${t}`, id, t, buf };
      have.push(rec); known.add(t);
      await tx('readwrite', s => s.put(rec)).catch(e => console.warn('[chart history] save', e));
    } catch (e) { console.warn('[chart history]', id, cyc, e); }
  }));
  if (!have.length) return [];
  have.sort((a, b) => a.t - b.t);
  const newest = have.at(-1).t;
  const old = have.filter(r => newest - r.t > KEEP_MS);
  if (old.length) tx('readwrite', s => old.forEach(r => s.delete(r.key))).catch(() => {});
  for (const u of urls.get(id) || []) URL.revokeObjectURL(u);
  const keep = have.filter(r => newest - r.t <= KEEP_MS);
  const out = keep.map(r => ({ t: r.t, url: URL.createObjectURL(new Blob([r.buf], { type: 'application/pdf' })) }));
  urls.set(id, out.map(f => f.url));
  return out;
}
