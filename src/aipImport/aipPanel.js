// AIP 取り込みパネル（2026-10-18）：AIP をアップロードして、航法データ・空港データを更新する
//   ① eAIP（各国の Web 版 AIP）の HTML …… アプリの中で読む（eaipParse.js）。1ページずつ保存した .html でも、まとめてダウンロードした .zip でもよい
//      eAIP の URL からも読める（eaipFetch.js。目次から ENR と空港のページを探し、読む空港を選んでから読み込む。2026-10-18）
//      読むのは ENR 4.1（無線施設）・4.4（地点）・3.x（航空路）・AD 2（空港：位置・標高・磁差・滑走路）
//   ② DB ファイル（.json）…… アプリの中で読めない形式（画像の PDF など）を別に解析して作ったもの（nav_db.json・airport_db.json・
//      airspace_db.json、または このパネルで書き出したもの）
//   読んだ内容は、前のデータとの違い（地点・航空路・空港の増減）を見てから「取り込む」。ブラウザの中にしまい、再読み込みで反映する
//   取り込んだ空港は青い空港ピン（滑走路・METAR・TAF）になり、地点・航空路は「航法データ表示」と経路作成に使える
import { parseEaip, nmBetween } from './eaipParse.js';
import { unzip } from './zip.js';
import { discoverEaip, fetchPages, fetchVia, prefixToCode } from './eaipFetch.js';
import { listPackages, putPackage, deletePackage, getPackage } from './aipStore.js';
import { countries, loadAirportDb } from '../dbLoader.js';

const CSS = `
#awAip{position:absolute;top:60px;right:390px;width:440px;max-width:calc(100vw - 20px);max-height:calc(100vh - 120px);overflow:auto;z-index:45;
  background:rgba(20,30,45,.98);color:#fff;font:12.5px/1.55 "Meiryo",sans-serif;border-radius:8px;padding:12px 14px;border-top:4px solid #ffb74d;display:none;
  box-shadow:0 6px 24px rgba(0,0,0,.5)}
#awAip h2{font-size:15px;margin:0 24px 6px 0}#awAip h3{font-size:12.5px;color:#ffcc80;margin:12px 0 4px}
#awAip .x{position:absolute;right:10px;top:8px;background:none;border:none;color:#aaa;font-size:18px;cursor:pointer}
#awAip .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0}
#awAip input[type=text]{background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:5px;font:12px "Meiryo",sans-serif;padding:3px 6px}
#awAip button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 9px;cursor:pointer}
#awAip button:disabled{opacity:.4;cursor:default}
#awAip button.main{background:#b26a00;border-color:#ffb74d;font-weight:600;padding:5px 12px}
#awAip .drop{border:2px dashed #47617d;border-radius:8px;padding:12px;text-align:center;color:#9fb3c8;cursor:pointer;margin:6px 0}
#awAip .drop.over{border-color:#ffb74d;color:#ffe0b2;background:rgba(255,183,77,.08)}
#awAip .sub{font-size:11px;color:#9fb3c8}
#awAip .ok{color:#69f0ae}#awAip .warn{color:#ffcc80}#awAip .err{color:#ff8a80}
#awAip ul{margin:2px 0;padding-left:18px}#awAip li{margin:1px 0}
#awAip details{margin:3px 0}#awAip summary{cursor:pointer;color:#cfe3f5}
#awAip table{border-collapse:collapse;width:100%;font-size:11.5px}#awAip td,#awAip th{border-bottom:1px solid #2b3f55;padding:3px 4px;text-align:left;vertical-align:top}
#awAip th{color:#8fd0ff;font-weight:400}
#awAip .apk{max-height:230px;overflow:auto;border:1px solid #2b3f55;border-radius:6px;margin-top:4px}
#awAip .apk label{display:flex;gap:6px;align-items:flex-start;padding:2px 6px;border-bottom:1px solid #1d2c3d;cursor:pointer}
#awAip .apk label:hover{background:#16293d}#awAip .apk .st{margin-left:auto;font-size:10.5px;white-space:nowrap}
#awAip .tagW{color:#eceff1}#awAip .tagB{color:#4fc3f7}#awAip .tagN{color:#69f0ae}
`;
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
const getJson = u => fetch(BASE + u).then(r => (r.ok ? r.json() : null)).catch(() => null);
const count = p => ({
  navaid: Object.values(p.nav?.fixes || {}).filter(f => f.type === 'navaid').length,
  point: Object.values(p.nav?.fixes || {}).filter(f => f.type !== 'navaid').length,
  airway: Object.keys(p.nav?.airways || {}).length,
  airport: Object.keys(p.airports?.airports || {}).length,
  airspace: (p.airspace?.items || []).length,
});
const countText = c => [c.navaid && `無線施設 ${c.navaid}`, c.point && `地点 ${c.point}`, c.airway && `航空路 ${c.airway}`, c.airport && `空港 ${c.airport}`, c.airspace && `空域 ${c.airspace}`].filter(Boolean).join('・') || '（なし）';

/** 今のデータ（同じ国コードの、取り込み済み → なければアプリに入っている国別データ）との違い */
async function diffWith(pkg) {
  const old = (await getPackage(pkg.code).catch(() => null)) || await (async () => {
    const c = (await countries()).find(x => x.code === pkg.code); if (!c) return null;
    const [nav, airports, airspace] = await Promise.all([c.nav && getJson(`data/intl/${c.nav}`), c.airports && getJson(`data/intl/${c.airports}`), c.airspace && getJson(`data/intl/${c.airspace}`)]);
    return { code: c.code, name: c.name, nav, airports, airspace, builtin: true };
  })();
  if (!old) return { html: '<div class="sub">この国のデータはまだありません（新しく追加）。</div>' };
  const out = [];
  const keys = (a, b) => { const A = new Set(Object.keys(a || {})), B = new Set(Object.keys(b || {})); return { add: [...B].filter(k => !A.has(k)), del: [...A].filter(k => !B.has(k)), both: [...B].filter(k => A.has(k)) }; };
  if (pkg.nav) {
    const f = keys(old.nav?.fixes, pkg.nav.fixes);
    const moved = f.both.filter(k => nmBetween(old.nav.fixes[k], pkg.nav.fixes[k]) > 0.5);
    const a = keys(old.nav?.airways, pkg.nav.airways);
    const chg = a.both.filter(k => old.nav.airways[k].points.join(' ') !== pkg.nav.airways[k].points.join(' '));
    const li = (t, arr) => (arr.length ? `<li>${t} ${arr.length}：${esc(arr.slice(0, 30).join(' '))}${arr.length > 30 ? ' …' : ''}</li>` : '');
    out.push(`<b>航法データ</b><ul>${li('地点の追加', f.add)}${li('地点の削除', f.del)}${li('位置の変更（0.5NM 超）', moved)}${li('航空路の追加', a.add)}${li('航空路の削除', a.del)}${li('航空路の地点の変更', chg)}` +
      `${!f.add.length && !f.del.length && !moved.length && !a.add.length && !a.del.length && !chg.length ? '<li>変更なし</li>' : ''}</ul>`);
  } else if (old.nav) out.push('<div class="sub">航法データ：今回は読んでいないので、今のデータのまま</div>');
  if (pkg.airports) {
    const k = keys(old.airports?.airports, pkg.airports.airports);
    const rw = k.both.filter(i => (old.airports.airports[i].runways || []).map(r => r.id).join() !== (pkg.airports.airports[i].runways || []).map(r => r.id).join());
    const lost = k.both.filter(i => (old.airports.airports[i].sids || []).length && !(pkg.airports.airports[i].sids || []).length);
    out.push(`<b>空港（選んだ ${Object.keys(pkg.airports.airports).length}）</b><ul>${k.add.length ? `<li>追加 ${k.add.length}：${esc(k.add.join(' '))}</li>` : ''}${k.del.length ? `<li>今のデータにあって今回選んでいない空港 ${k.del.length}：${esc(k.del.join(' '))}（今のまま残ります）</li>` : ''}` +
      `${rw.length ? `<li>滑走路の変更：${esc(rw.join(' '))}</li>` : ''}${lost.length ? `<li class="warn">SID・STAR がなくなる空港：${esc(lost.join(' '))}（今のデータには SID・STAR があります。HTML からは SID・STAR を読めないため）</li>` : ''}</ul>`);
  }
  return { html: `<div class="sub">比べた相手：${old.builtin ? 'アプリに入っている' : '前に取り込んだ'} ${esc(old.name || old.code)} のデータ</div>${out.join('')}`, old };
}

/** 今のアプリの空港の状態：{ ICAO: 'blue-proc'（青丸・SID/STAR あり）| 'blue'（青丸）| 'white'（白丸）} */
async function airportStatus() {
  const st = {};
  try { for (const k of Object.keys(localStorage)) if (/^aw\.wxStations\.v\d+$/.test(k)) for (const r of JSON.parse(localStorage.getItem(k)).list || []) st[r[0]] = 'white'; } catch { /* なし */ }
  try { const db = await loadAirportDb(); for (const [k, a] of Object.entries(db.airports)) st[k] = (a.sids?.length || a.stars?.length) ? 'blue-proc' : 'blue'; } catch { /* なし */ }
  return st;
}
/**
 * 青丸にする空港を選ぶ一覧（2026-10-18）。all：読んだ空港すべて、sel：選んでいる ICAO の Set（書き換える）
 *   初めは「アプリにない空港・白丸の空港・SID/STAR のない青丸」を選んだ状態にする（SID・STAR のある空港は、置き換えると SID・STAR がなくなるので外す）
 */
function airportPicker(el, all, sel, status, onChange) {
  const list = Object.values(all).sort((a, b) => a.icao.localeCompare(b.icao));
  const tag = i => ({ white: ['tagW', '今は白丸'], blue: ['tagB', '今は青丸'], 'blue-proc': ['tagB', '今は青丸・SID/STAR あり'] }[status[i]] || ['tagN', 'アプリにない']);
  el.innerHTML = `<div class="row"><b>青丸にする空港</b><span class="sub" data-n></span></div>
    <div class="row"><button data-a="all">すべて選ぶ</button><button data-a="none">すべて外す</button><button data-a="white">白丸の空港だけ</button>
      <input type="text" data-f placeholder="絞り込み（ICAO・名前）" size="16"></div>
    <div class="apk">${list.map(a => { const [c, t] = tag(a.icao); return `<label data-i="${esc(a.icao)}"><input type="checkbox" value="${esc(a.icao)}"${sel.has(a.icao) ? ' checked' : ''}>
      <span><b>${esc(a.icao)}</b> ${esc(a.nameJa && a.nameJa !== a.nameEn ? a.nameJa + '・' : '')}${esc(a.nameEn)}<br><span class="sub">滑走路 ${esc(a.runways.map(r => r.id).join(' ') || 'なし')}${a.elevationFt != null ? `・標高 ${Math.round(a.elevationFt)}ft` : ''}</span></span>
      <span class="st ${c}">${t}</span></label>`; }).join('')}</div>
    <div class="warn" data-w></div>`;
  const say = () => {
    el.querySelector('[data-n]').textContent = `　${sel.size} / ${list.length} 空港`;
    const lost = [...sel].filter(i => status[i] === 'blue-proc');
    el.querySelector('[data-w]').textContent = lost.length ? `${lost.join(' ')} は今 SID・STAR があります。取り込むと SID・STAR のない空港に置き換わります。` : '';
    onChange?.();
  };
  el.querySelectorAll('input[type=checkbox]').forEach(b => b.onchange = () => { b.checked ? sel.add(b.value) : sel.delete(b.value); say(); });
  el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    sel.clear();
    for (const a of list) if (b.dataset.a === 'all' || (b.dataset.a === 'white' && status[a.icao] === 'white')) sel.add(a.icao);
    el.querySelectorAll('input[type=checkbox]').forEach(x => { x.checked = sel.has(x.value); });
    say();
  });
  el.querySelector('[data-f]').oninput = e => {
    const f = e.target.value.trim().toUpperCase();
    el.querySelectorAll('label[data-i]').forEach(l => { l.style.display = !f || l.textContent.toUpperCase().includes(f) ? '' : 'none'; });
  };
  say();
}
/** 選んだ空港だけを空港データにする */
const applySelection = (pkg, sel) => {
  if (!pkg.airportsAll) return;
  pkg.airports = { ...(pkg.airports || { meta: {}, waypoints: {}, index: { byIata: {} } }), airports: Object.fromEntries(Object.entries(pkg.airportsAll).filter(([k]) => sel.has(k))) };
  pkg.selectedAirports = [...sel];
};

export function initAipPanel(btn) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const P = Object.assign(document.createElement('div'), { id: 'awAip' }); document.body.appendChild(P);
  P.innerHTML = `<button class="x" aria-label="閉じる">×</button>
    <h2>📥 AIP 取り込み（データベースの更新）</h2>
    <div class="sub">各国の eAIP（Web 版 AIP）の HTML か、別に作った DB ファイル（.json）を読み込んで、航法データ（無線施設・地点・航空路）と空港（位置・標高・滑走路）を足したり更新したりします。取り込んだ空港は青い空港ピンになります。</div>
    <h3>① 読み込む</h3>
    <div class="row"><label>国コード <input type="text" data-cc maxlength="3" size="4" placeholder="RU" list="awAipCc" style="text-transform:uppercase"></label>
      <label>国名 <input type="text" data-cn size="14" placeholder="ロシア"></label><datalist id="awAipCc"></datalist></div>
    <div class="drop" data-drop>ここにファイルをドラッグ、または押して選ぶ<br><span class="sub">eAIP の HTML（ENR 3.x・4.1・4.4・AD 2 のページ。複数可）、eAIP の zip、DB ファイル（.json）</span></div>
    <input type="file" data-file multiple accept=".html,.htm,.xhtml,.zip,.json" hidden>
    <div class="row"><input type="text" data-url placeholder="または eAIP の URL（例 https://aip.caat.or.th/2026-10-29-AIRAC/html/index-en-GB.html）" style="flex:1;min-width:200px"><button data-disc>目次を読む</button></div>
    <div data-urlres></div>
    <div data-result></div>
    <h3>② 取り込み済み（このブラウザ）</h3>
    <div data-list class="sub">読み込み中…</div>
    <div class="row" data-reloadrow hidden><span class="warn">変更はアプリを開き直すと反映されます。</span><button class="main" data-reload>今すぐ開き直す</button></div>
    <div class="sub" style="margin-top:8px">SID・STAR・進入方式と空域（ENR 2.1・5.x）は、多くの国で図（PDF）にしかないため HTML からは読みません。取り込んだ空港は SID・STAR のない空港として、経路の最初・最後の地点と直行で結びます。必要なときは図を解析した DB ファイル（.json）を読み込んでください。教育用のデータで、実運航には使えません。</div>`;
  const q = s => P.querySelector(s), res = q('[data-result]');
  let pending = null;
  q('.x').onclick = () => { P.style.display = 'none'; btn.classList.remove('on'); };
  btn.onclick = () => { const on = P.style.display !== 'block'; P.style.display = on ? 'block' : 'none'; btn.classList.toggle('on', on); if (on) refreshList(); };
  countries().then(cs => { q('#awAipCc').innerHTML = cs.map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join(''); });
  q('[data-cc]').addEventListener('change', async () => {
    const cc = q('[data-cc]').value.trim().toUpperCase(), c = (await countries()).find(x => x.code === cc);
    if (c && !q('[data-cn]').value) q('[data-cn]').value = c.name;
  });

  // ---------- ファイル ----------
  const drop = q('[data-drop]'), input = q('[data-file]');
  drop.onclick = () => input.click();
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); readFiles([...e.dataTransfer.files]); });
  input.onchange = () => { readFiles([...input.files]); input.value = ''; };

  // ---------- URL から ----------
  const ures = q('[data-urlres]');
  q('[data-url]').addEventListener('keydown', e => { if (e.key === 'Enter') q('[data-disc]').click(); });
  q('[data-disc]').onclick = async () => {
    const url = q('[data-url]').value.trim(); if (!url) return;
    const b = q('[data-disc]'); b.disabled = true;
    ures.innerHTML = '<div class="sub">目次を読んでいます…</div>';
    try {
      if (/\.zip(\?|$)/i.test(url)) {                               // zip の URL：まるごと読む
        ures.innerHTML = '<div class="sub">zip を読み込んでいます（大きいと時間がかかります）…</div>';
        const ents = await unzip(await fetchVia(url, 'buffer'), n => WANT(n) || /\.json$/i.test(n));
        ures.innerHTML = '';
        await readFiles([], { html: ents.filter(e => !/\.json$/i.test(e.name)).map(e => ({ name: e.name.split('/').pop(), text: new TextDecoder('utf-8').decode(e.bytes) })),
          json: ents.filter(e => /\.json$/i.test(e.name)).map(e => ({ name: e.name, text: new TextDecoder('utf-8').decode(e.bytes) })) });
        return;
      }
      const d = await discoverEaip(url);
      if (!q('[data-cc]').value.trim()) {
        const cc = prefixToCode(d.prefix); q('[data-cc]').value = cc;
        const c = (await countries()).find(x => x.code === cc); if (c && !q('[data-cn]').value) q('[data-cn]').value = c.name;
      }
      const status = await airportStatus();
      const sel = new Set(d.airports.filter(a => status[a.icao] !== 'blue-proc').map(a => a.icao));
      const tag = i => ({ white: ['tagW', '今は白丸'], blue: ['tagB', '今は青丸'], 'blue-proc': ['tagB', '今は青丸・SID/STAR あり'] }[status[i]] || ['tagN', 'アプリにない']);
      ures.innerHTML = `<div class="ok">目次が見つかりました（${esc(d.prefix)}・${esc(d.lang)}）</div>
        <label class="row"><input type="checkbox" data-enr checked> 地点・航空路（ENR ${esc([...new Set(d.enr.map(e => e.no))].join('・'))}）を読む</label>
        ${d.airports.length ? `<div class="row"><b>読む空港（AD 2）</b><span class="sub" data-n></span></div>
        <div class="row"><button data-a="all">すべて選ぶ</button><button data-a="none">すべて外す</button><button data-a="white">白丸の空港だけ</button><input type="text" data-f placeholder="絞り込み" size="12"></div>
        <div class="apk">${d.airports.map(a => { const [c, t] = tag(a.icao); return `<label data-i="${esc(a.icao)}"><input type="checkbox" value="${esc(a.icao)}"${sel.has(a.icao) ? ' checked' : ''}><span><b>${esc(a.icao)}</b> ${esc(a.name)}</span><span class="st ${c}">${t}</span></label>`; }).join('')}</div>`
        : '<div class="warn">目次に空港（AD 2）のページが見つかりませんでした。地点・航空路だけ読みます</div>'}
        <div class="row" style="margin-top:6px"><button class="main" data-go>読み込む</button><span class="sub" data-prog></span></div>`;
      const say = () => { const n = ures.querySelector('[data-n]'); if (n) n.textContent = `　${sel.size} / ${d.airports.length} 空港（1空港 約0.3〜1MB）`; };
      ures.querySelectorAll('.apk input').forEach(x => x.onchange = () => { x.checked ? sel.add(x.value) : sel.delete(x.value); say(); });
      ures.querySelectorAll('[data-a]').forEach(x => x.onclick = () => {
        sel.clear(); for (const a of d.airports) if (x.dataset.a === 'all' || (x.dataset.a === 'white' && status[a.icao] === 'white')) sel.add(a.icao);
        ures.querySelectorAll('.apk input').forEach(c => { c.checked = sel.has(c.value); }); say();
      });
      const f = ures.querySelector('[data-f]');
      if (f) f.oninput = () => { const v = f.value.trim().toUpperCase(); ures.querySelectorAll('label[data-i]').forEach(l => { l.style.display = !v || l.textContent.toUpperCase().includes(v) ? '' : 'none'; }); };
      say();
      ures.querySelector('[data-go]').onclick = async () => {
        const go = ures.querySelector('[data-go]'), prog = ures.querySelector('[data-prog]'); go.disabled = true;
        const urls = [...(ures.querySelector('[data-enr]').checked ? d.enr : []), ...d.airports.filter(a => sel.has(a.icao))];
        if (!urls.length) { prog.textContent = '読むページがありません'; go.disabled = false; return; }
        const { files, errors } = await fetchPages(urls, (a, n) => { prog.textContent = `ページを読み込んでいます ${a} / ${n}`; });
        prog.textContent = errors.length ? `読めなかったページ ${errors.length}：${errors.slice(0, 3).join('／')}` : '';
        go.disabled = false;
        if (files.length) await readFiles([], { html: files, selected: [...sel] });
      };
    } catch (e) { console.warn('[aip url]', e); ures.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    finally { b.disabled = false; }
  };

  const WANT = n => /\.(x?html?)$/i.test(n) && /(ENR|AD)[\s_-]*\d/i.test(n.split('/').pop());
  async function readFiles(list, pre = {}) {
    res.innerHTML = '<div class="sub">読み込んでいます…</div>';
    try {
      const html = [...(pre.html || [])], json = [...(pre.json || [])];
      for (const f of list) {
        if (/\.zip$/i.test(f.name)) {
          const ents = await unzip(await f.arrayBuffer(), n => WANT(n) || /\.json$/i.test(n));
          for (const e of ents) (/\.json$/i.test(e.name) ? json : html).push({ name: e.name.split('/').pop(), text: new TextDecoder('utf-8').decode(e.bytes) });
        } else if (/\.json$/i.test(f.name)) json.push({ name: f.name, text: await f.text() });
        else html.push({ name: f.name, text: await f.text() });
      }
      let cc = q('[data-cc]').value.trim().toUpperCase(), cn = q('[data-cn]').value.trim();
      let pkg = null, report = null;
      // DB ファイル（.json）
      for (const j of json) {
        let d; try { d = JSON.parse(j.text); } catch { continue; }
        if (d.format === 'aeroweather-aip-package') { pkg = { ...d }; cc = d.code; cn = d.name; continue; }
        pkg ||= { files: [] };
        if (d.fixes || d.airways) pkg.nav = d;
        if (d.airports) pkg.airports = d;
        if (d.items) pkg.airspace = d;
        (pkg.files ||= []).push(j.name);
        if (!cc && d.meta?.country) cc = d.meta.country;
      }
      // eAIP の HTML
      if (html.length) {
        if (!cc) {                                              // ファイル名の頭（例 RK-ENR-4.1-en-GB.html の RK）を仮の国コードに
          const m = /^([A-Z]{2})[-_](?:ENR|AD)/i.exec(html[0].name); cc = m ? m[1].toUpperCase() : '';
        }
        if (!cc) throw new Error('国コードを入れてください（2文字。例 RU・MN・AU）');
        let kanji = {}; try { kanji = JSON.parse(localStorage.getItem('aw.aptKanji.v1') || '{}').names || {}; } catch { /* なし */ }
        const r = parseEaip(html, { code: cc, countryName: cn, kanji });
        report = r.report;
        pkg ||= { files: [] };
        if (Object.keys(r.nav.fixes).length) pkg.nav = r.nav;
        if (Object.keys(r.airports.airports).length) pkg.airports = r.airports;
        pkg.files = [...(pkg.files || []), ...report.used.map(x => x.split(' → ')[0])];
        pkg.eff ||= report.eff;
      }
      if (!pkg || (!pkg.nav && !pkg.airports && !pkg.airspace)) throw new Error('読めるデータがありませんでした' + (report?.warnings.length ? '：' + report.warnings.join('／') : ''));
      if (!cc) throw new Error('国コードを入れてください（2文字）');
      Object.assign(pkg, { format: 'aeroweather-aip-package', version: 1, code: cc, name: cn || cc });
      q('[data-cc]').value = cc; if (cn) q('[data-cn]').value = cn;
      if (pre.selected && pkg.airports) pkg.selectedAirports = pre.selected.filter(i => pkg.airports.airports[i]);   // URL から読んだときは、そこで選んだ空港
      pending = pkg;
      // 青丸にする空港を選ぶ（読んだ空港すべてを airportsAll に残し、選んだ空港だけを airports に）
      if (pkg.airports && !pkg.airportsAll) pkg.airportsAll = pkg.airports.airports;
      const status = await airportStatus();
      const sel = new Set(pkg.selectedAirports || Object.keys(pkg.airportsAll || {}).filter(i => status[i] !== 'blue-proc'));
      applySelection(pkg, sel);
      const d = await diffWith(pkg);
      res.innerHTML = `<div class="ok">読めました：${esc(cc)} ${esc(pkg.name)}${pkg.eff ? `（有効日 ${esc(pkg.eff)}）` : ''}</div>
        <div>${esc(countText(count(pkg)))}</div>
        ${report ? `<details><summary>読んだページ ${report.used.length}${report.skipped.length ? `・使わなかったファイル ${report.skipped.length}` : ''}</summary><ul>${report.used.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${report.skipped.length ? `<div class="sub">使わなかった：${esc(report.skipped.slice(0, 40).join('、'))}${report.skipped.length > 40 ? ' …' : ''}</div>` : ''}</details>` : ''}
        ${report?.warnings.length ? `<div class="warn">注意</div><ul class="warn">${report.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${pkg.airportsAll ? '<div data-pick style="margin-top:6px"></div>' : ''}
        <h3>前のデータとの違い</h3><div data-diff>${d.html}</div>
        <div class="row" style="margin-top:6px"><button class="main" data-save>この内容で取り込む</button><button data-export title="この内容を DB ファイル（.json）としてダウンロード。public/data/intl/ に入れてアプリに組み込むときや、別の端末で読み込むときに使う">ファイルに書き出す</button></div>`;
      if (pkg.airportsAll) airportPicker(res.querySelector('[data-pick]'), pkg.airportsAll, sel, status, async () => {
        applySelection(pkg, sel);
        res.querySelector('[data-diff]').innerHTML = (await diffWith(pkg)).html;
      });
      res.querySelector('[data-save]').onclick = async () => {
        applySelection(pkg, sel);
        pkg.stats = count(pkg);
        await putPackage(pkg);
        res.innerHTML = `<div class="ok">${esc(cc)} ${esc(pkg.name)} を取り込みました。</div>`;
        pending = null; q('[data-reloadrow]').hidden = false; refreshList();
      };
      res.querySelector('[data-export]').onclick = () => download(pkg);
    } catch (e) {
      console.warn('[aip import]', e);
      res.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }
  function download(pkg) {
    const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `aip_${pkg.code}_${(pkg.eff || new Date().toISOString().slice(0, 10)).replace(/\W/g, '')}.json` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function refreshList() {
    const L = await listPackages(), el = q('[data-list]');
    if (!L.length) { el.innerHTML = 'まだありません。'; return; }
    el.innerHTML = `<table><tr><th>国</th><th>中身</th><th>取り込んだ日</th><th></th></tr>${L.map(p => `<tr>
      <td>${esc(p.code)} ${esc(p.name)}${p.eff ? `<br><span class="sub">有効日 ${esc(p.eff)}</span>` : ''}</td><td>${esc(countText(p.stats || count(p)))}</td>
      <td>${esc(p.created ? new Date(p.created).toLocaleDateString('ja-JP') : '')}</td>
      <td>${p.airportsAll ? `<button data-ap="${esc(p.code)}" title="青丸にする空港を選び直す">空港</button> ` : ''}<button data-ex="${esc(p.code)}">書き出し</button> <button data-del="${esc(p.code)}">削除</button></td></tr>`).join('')}</table>
      <div data-repick></div>`;
    el.querySelectorAll('[data-ap]').forEach(b => b.onclick = async () => {
      const pkg = await getPackage(b.dataset.ap), box = el.querySelector('[data-repick]');
      const sel = new Set(pkg.selectedAirports || Object.keys(pkg.airports?.airports || {}));
      box.innerHTML = `<h3>${esc(pkg.code)} ${esc(pkg.name)}：青丸にする空港を選び直す</h3><div data-pick></div><div class="row"><button class="main" data-ok>この選び方で保存</button><button data-cancel>やめる</button></div>`;
      airportPicker(box.querySelector('[data-pick]'), pkg.airportsAll, sel, await airportStatus());
      box.querySelector('[data-cancel]').onclick = () => { box.innerHTML = ''; };
      box.querySelector('[data-ok]').onclick = async () => {
        applySelection(pkg, sel); pkg.stats = count(pkg); await putPackage(pkg);
        box.innerHTML = ''; q('[data-reloadrow]').hidden = false; refreshList();
      };
    });
    el.querySelectorAll('[data-ex]').forEach(b => b.onclick = async () => download(await getPackage(b.dataset.ex)));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'もう一度押すと削除'; return; }
      await deletePackage(b.dataset.del); q('[data-reloadrow]').hidden = false; refreshList();
    });
  }
  q('[data-reload]').onclick = () => location.reload();
  return { open: () => { P.style.display = 'block'; refreshList(); }, get pending() { return pending; } };
}
