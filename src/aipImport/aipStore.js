// AIP 取り込みパネルで作った国別データを、ブラウザの中（IndexedDB）にしまう（2026-10-18）
//   1か国 1件：{ code, name, eff, created, files:[], nav, airports, airspace, stats }
//   dbLoader.js がアプリの起動時に読み、public/data/intl/ の国別データと同じように足す（同じ国コードなら置き換える）
const DB = 'aw-aip-import', ST = 'pkg';
let dbp = null;
function db() {
  return (dbp ||= new Promise((ok, ng) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'code' });
      r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
    } catch (e) { ng(e); }
  }));
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, ng) => { const t = d.transaction(ST, mode); const q = fn(t.objectStore(ST)); t.oncomplete = () => ok(q?.result); t.onerror = () => ng(t.error); }); };
/** しまってある国の一覧 */
export const listPackages = () => tx('readonly', s => s.getAll()).catch(() => []);
export const getPackage = code => tx('readonly', s => s.get(code));
export const putPackage = pkg => tx('readwrite', s => s.put({ ...pkg, created: pkg.created || new Date().toISOString() }));
export const deletePackage = code => tx('readwrite', s => s.delete(code));
