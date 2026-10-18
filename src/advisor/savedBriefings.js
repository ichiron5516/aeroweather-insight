// 保存した経路（ブリーフィング）の一覧（経路アドバイスの「📂 保存一覧」）
//   「💾 保存」でダウンロードした HTML と同じものを、ブラウザの中（IndexedDB）にも残しておく。
//   一覧ではチェックで選んで
//     ・表示：アプリの画面に、保存した時の評価結果（候補経路・推奨高度・揺れの要因・3D・断面図）をそのまま出す。
//             2件以上選んだときは、1件目（一番新しいもの）を表示し、ほかの経路は比べるために水色の線で重ねる
//     ・削除：選んだものをまとめて削除（2回押す）
//   各行の「開く」はブリーフィング（天気図つき）を新しいタブで、「ファイル」はもう一度ダウンロード。
//   別の端末で保存したファイルは「ファイルを読み込む」で一覧に加えられる。
//   ブラウザの中の保存なので、端末・ブラウザごとに別。ブラウザのデータを消すと一覧も消える（ダウンロードしたファイルは残る）。
import * as Cesium from 'cesium';

const DB = 'aeroweather', STORE = 'briefings';
function openDb() {
  return new Promise((ok, ng) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { ng(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => ok(req.result); req.onerror = () => ng(req.error);
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((ok, ng) => {
    const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
    const r = fn(st);
    t.oncomplete = () => ok(r?.result); t.onerror = () => ng(t.error);
  });
}
export const putBriefing = rec => tx('readwrite', st => st.put(rec));
export const deleteBriefing = id => tx('readwrite', st => st.delete(id));
export const listBriefings = () => tx('readonly', st => st.getAll());

const scriptJson = (html, id) => {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  return m ? JSON.parse(m[1]) : null;
};
/** ブリーフィングの HTML から、一覧用のデータ・評価結果・天気図を取り出す */
export function parseBriefingHtml(html) {
  const data = scriptJson(html, 'aw-briefing-data');
  if (!data || data.format !== 'aeroweather-briefing') throw new Error('AeroWeather のブリーフィングのファイルではありません');
  return { data, state: scriptJson(html, 'aw-briefing-state'), charts: scriptJson(html, 'aw-briefing-charts') || [] };
}
/** 一覧に残す記録（HTML 本体＋一覧に出す項目） */
export function recordOf(html, data, name) {
  const r = data.routes[data.selected] || data.routes[0] || {};
  return {
    id: `${data.created}|${data.dep}|${data.arr}`, created: data.created, name,
    dep: data.dep, arr: data.arr, departure: data.departure, label: r.label, distanceNM: r.distanceNM, fl: r.fl, steps: r.steps || [],
    minutes: r.minutes, hazardScore: r.hazardScore, level: r.level, count: data.routes.length,
    sizeKB: Math.round(html.length / 1024), canRestore: html.includes('id="aw-briefing-state"'), html,
  };
}

const CSS = `
#awSaved{position:absolute;top:80px;left:364px;z-index:27;width:420px;max-width:calc(100vw - 20px);max-height:calc(100vh - 200px);overflow:auto;
  background:rgba(20,30,45,.97);color:#fff;font:13px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:10px 12px;border-left:4px solid #8fd0ff;box-shadow:0 6px 24px rgba(0,0,0,.5)}
#awSaved[hidden]{display:none}
#awSaved h3{margin:0 0 6px;font-size:14px;display:flex;align-items:center;gap:6px}
#awSaved h3 span{margin-right:auto}
#awSaved button,#awSaved label.imp{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 9px;cursor:pointer}
#awSaved button:hover:not(:disabled),#awSaved label.imp:hover{border-color:#8fd0ff}
#awSaved button:disabled{opacity:.4;cursor:default}
#awSaved button.pri{background:#1e5a8c;border-color:#8fd0ff;font-weight:600}
#awSaved button.del{border-color:#c62828}
#awSaved .bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 6px;position:sticky;top:-10px;background:rgba(20,30,45,.97);padding:4px 0}
#awSaved .bar .cnt{font-size:11.5px;color:#9fb3c8;margin-right:auto}
#awSaved .flt input{width:100%;box-sizing:border-box;font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 6px}
#awSaved ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
#awSaved li{border:1px solid #2b3f55;border-radius:6px;padding:6px 8px;display:grid;grid-template-columns:auto 1fr;gap:0 8px;cursor:pointer}
#awSaved li.chk{border-color:#8fd0ff;background:rgba(143,208,255,.08)}
#awSaved li.cur{box-shadow:inset 3px 0 0 #00e676}
#awSaved li input{margin-top:3px;width:16px;height:16px}
#awSaved .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
#awSaved .nm{font:700 13px ui-monospace,Menlo,monospace;white-space:nowrap}
#awSaved .s{font-size:11.5px;color:#9fb3c8}
#awSaved .a{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
#awSaved .a button{padding:1px 8px;font-size:11.5px}
#awSaved .b{display:inline-block;border-radius:9px;padding:0 7px;font-size:11px;font-weight:600}
#awSaved .good{background:#2e7d32}#awSaved .caution{background:#b58900}#awSaved .avoid{background:#c62828}
#awSaved .empty,#awSaved .msg{color:#9fb3c8;font-size:12px}
#awSaved li.empty{display:block;cursor:default}
`;
const LEVEL_JA = { good: '揺れ小', caution: '揺れ注意', avoid: '揺れ大' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const p2 = n => String(n).padStart(2, '0');
export const utcText = iso => { const d = new Date(iso); return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z`; };
export const jstText = iso => { const d = new Date(new Date(iso).getTime() + 9 * 3600e3); return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const planText = r => [`FL${r.fl}`, ...(r.steps || []).map(s => `FL${s.to}`)].join('→');

/**
 * 一覧パネル。
 *   onShow(rec, parsed): 1件を画面に表示する（advisor.js）
 *   getAltScale: 高度の倍率、anchor: パネルの左に置く要素
 */
export function createSavedPanel(viewer, { getAltScale = () => 1, anchor = null, onShow = null } = {}) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const el = document.createElement('div'); el.id = 'awSaved'; el.hidden = true;
  el.innerHTML = `<h3><span>📂 保存した経路</span><label class="imp" title="ダウンロードしたブリーフィング（.html）を一覧に加える">ファイルを読み込む<input type="file" accept=".html,text/html" multiple hidden></label><button data-x title="閉じる">✕</button></h3>
    <div class="flt"><input type="search" placeholder="空港・経路名で絞り込み（例 RJBB RCTP）"></div>
    <div class="bar"><span class="cnt"></span><button data-b="all">すべて選択</button><button data-b="show" class="pri" disabled>表示</button><button data-b="del" class="del" disabled>削除</button></div>
    <div class="msg"></div><ul></ul>
    <p class="s" style="margin-top:8px">チェックで選んで「表示」「削除」。2件以上を表示すると、1件目を画面に出し、ほかの経路は水色の線で重ねます。保存はこのブラウザの中（端末ごとに別）。</p>`;
  document.body.append(el);
  const ul = el.querySelector('ul'), msg = el.querySelector('.msg'), q = el.querySelector('input[type=search]'), cnt = el.querySelector('.cnt');
  const bShow = el.querySelector('[data-b=show]'), bDel = el.querySelector('[data-b=del]'), bAll = el.querySelector('[data-b=all]');
  const ds = new Cesium.CustomDataSource('savedRoutes'); viewer.dataSources.add(ds);
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => { viewer.dataSources.add(ds); drawOverlays(); }, 0); });
  let items = [], checked = new Set(), overlays = [], current = null;

  async function refresh() {
    try { items = (await listBriefings()).sort((a, b) => b.created.localeCompare(a.created)); msg.textContent = ''; }
    catch (e) { items = []; msg.textContent = `一覧を読み込めません（${e.message || e}）。プライベートブラウズでは保存できないことがあります。`; }
    for (const id of [...checked]) if (!items.some(x => x.id === id)) checked.delete(id);
    renderList();
  }
  const visible = () => {
    const words = q.value.trim().toUpperCase().split(/\s+/).filter(Boolean);
    return items.filter(x => words.every(w => `${x.dep} ${x.arr} ${x.label} ${x.name}`.toUpperCase().includes(w)));
  };
  function renderList() {
    const list = visible();
    ul.innerHTML = list.length ? list.map(x => `<li data-id="${esc(x.id)}" class="${checked.has(x.id) ? 'chk' : ''} ${current === x.id ? 'cur' : ''}">
      <input type="checkbox" ${checked.has(x.id) ? 'checked' : ''} aria-label="選ぶ">
      <div><div class="t"><b>${esc(x.dep)} → ${esc(x.arr)}　${esc(x.label || '')}</b><span class="nm">${Math.round(x.distanceNM || 0).toLocaleString()} NM</span></div>
      <div class="s">評価 ${esc(jstText(x.created))}（${esc(utcText(x.created).slice(11))}）・出発 ${esc(utcText(x.departure).slice(5))} 想定</div>
      <div class="s">${esc(planText(x))}・約${x.minutes}分 <span class="b ${x.level}">${LEVEL_JA[x.level] || ''} ${x.hazardScore}</span>・候補 ${x.count} 本・${(x.sizeKB / 1024).toFixed(1)}MB${x.canRestore ? '' : '・画面表示は不可（古い形式）'}${current === x.id ? '・<b style="color:#69f0ae">表示中</b>' : ''}</div>
      <div class="a"><button data-a="open">ブリーフィングを開く</button><button data-a="file">ファイル</button></div></div></li>`).join('')
      : `<li class="empty">${items.length ? '条件に合う保存がありません' : 'まだ保存がありません。経路を評価して「💾 保存」を押すと、ここに並びます。'}</li>`;
    const n = checked.size;
    cnt.textContent = n ? `${n} 件を選択` : `${items.length} 件`;
    bShow.disabled = !n; bDel.disabled = !n;
    bAll.textContent = list.length && list.every(x => checked.has(x.id)) ? '選択を外す' : 'すべて選択';
    bDel.textContent = '削除'; delete bDel.dataset.sure;
  }
  // 比べるために重ねる経路（水色の線・地点名）
  function drawOverlays() {
    ds.entities.removeAll();
    const k = getAltScale();
    for (const x of overlays) {
      const r = x.data.routes[x.data.selected] || x.data.routes[0];
      const h = (r.fl || 300) * 100 * 0.3048 * k, pts = r.points, n = pts.length, edge = Math.max(1, Math.min(3, Math.floor(n / 4)));
      const alt = i => (i === 0 || i === n - 1 ? 0 : i < edge || i >= n - edge ? h * 0.5 : h);
      ds.entities.add({ polyline: { positions: pts.map((p, i) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, alt(i))), width: 4,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#8fd0ff'), dashLength: 18 }) } });
      const mid = pts[Math.floor(n / 2)];
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat, h), label: {
        text: `比較：${x.dep}→${x.arr} ${r.label}\n評価 ${jstText(x.created)}・${Math.round(r.distanceNM)} NM・${planText(r)}`,
        font: '600 12px Meiryo', fillColor: Cesium.Color.fromCssColorString('#002b3d'), showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('rgba(143,208,255,0.9)'), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
  }
  const download = x => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([x.html], { type: 'text/html' })), download: x.name || 'AeroWeather_briefing.html' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  ul.addEventListener('click', e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const x = items.find(i => i.id === li.dataset.id); if (!x) return;
    const b = e.target.closest('button[data-a]');
    if (b?.dataset.a === 'open') { const w = window.open(URL.createObjectURL(new Blob([x.html], { type: 'text/html' })), '_blank'); if (!w) download(x); return; }
    if (b?.dataset.a === 'file') { download(x); return; }
    // 行（またはチェック）を押すと選択の切り替え
    if (checked.has(x.id)) checked.delete(x.id); else checked.add(x.id);
    renderList();
  });
  bAll.onclick = () => {
    const list = visible(), all = list.length && list.every(x => checked.has(x.id));
    for (const x of list) all ? checked.delete(x.id) : checked.add(x.id);
    renderList();
  };
  bShow.onclick = async () => {
    const sel = items.filter(x => checked.has(x.id));            // 新しい順
    if (!sel.length) return;
    const main = sel.find(x => x.canRestore) || sel[0];
    msg.textContent = '';
    try {
      const parsed = parseBriefingHtml(main.html);
      if (!parsed.state) throw new Error('このファイルには評価結果のデータが入っていません（古い形式）。「ブリーフィングを開く」で見てください');
      overlays = sel.filter(x => x !== main).map(x => ({ ...x, data: parseBriefingHtml(x.html).data }));
      drawOverlays();
      current = main.id;
      await onShow?.(main, parsed, overlays.length);
      renderList();
    } catch (e) { console.warn('[saved] show', e); msg.textContent = `表示できませんでした：${e.message || e}`; }
  };
  bDel.onclick = async () => {
    if (!bDel.dataset.sure) { bDel.dataset.sure = '1'; bDel.textContent = `${checked.size} 件を削除（もう一度押す）`; setTimeout(() => { if (bDel.dataset.sure) { delete bDel.dataset.sure; bDel.textContent = '削除'; } }, 3500); return; }
    const ids = [...checked];
    for (const id of ids) await deleteBriefing(id);
    overlays = overlays.filter(x => !ids.includes(x.id)); drawOverlays();
    checked.clear(); await refresh();
    msg.textContent = `${ids.length} 件を削除しました`;
  };
  q.addEventListener('input', renderList);
  el.querySelector('[data-x]').onclick = () => { el.hidden = true; };
  el.querySelector('input[type=file]').onchange = async e => {
    let n = 0; const ng = [];
    for (const f of e.target.files) {
      try { const html = await f.text(), { data } = parseBriefingHtml(html); await putBriefing(recordOf(html, data, f.name)); n++; }
      catch (err) { ng.push(`${f.name}（${err.message}）`); }
    }
    e.target.value = '';
    await refresh();
    msg.textContent = `${n} 件を読み込みました${ng.length ? `。読み込めなかったファイル：${ng.join('、')}` : ''}`;
  };
  window.addEventListener('aw:altscale', () => drawOverlays());
  return {
    get open() { return !el.hidden; },
    async toggle() {
      el.hidden = !el.hidden;
      if (!el.hidden) {
        const a = anchor?.getBoundingClientRect();
        if (a && innerWidth - a.right > 440) { el.style.left = `${a.right + 8}px`; el.style.top = `${Math.max(10, a.top)}px`; }
        else { el.style.left = '10px'; el.style.top = '80px'; }
        await refresh();
      }
    },
    /** 保存した直後に呼ぶ（一覧に加える） */
    async add(html, data, name) { await putBriefing(recordOf(html, data, name)); if (!el.hidden) refresh(); },
    /** 保存したものの表示をやめる（比較の線も消す） */
    clearShown() { current = null; overlays = []; drawOverlays(); if (!el.hidden) renderList(); },
  };
}
