// 空港データベース（public/data/nav/airport_db.json）の空港を地図に表示する
//   ・METAR・TAF を出している空港（航空路を表示している国すべて。NOAA AWC の地点一覧から）は小さな白丸。
//     クリックすると METAR（過去6時間）・TAF・今後の気象解説を表示。地点一覧はブラウザに30日間とっておく
//   ・空港ピン＋ラベル（IATA・空港名）、近づくと滑走路も表示
//   ・ピンをクリックすると、空港パネルに滑走路と最新の METAR/TAF（NOAA AWC）を表示
//   ・パネルのタブで SID・STAR・APPROACH を選び、地図に表示できる（aptProcedures.js）
//   ・白丸・空港ピンにマウスを載せると、空港名（ICAO・IATA・名前・国、METAR/TAF の有無）を札で出す
//   ・中国・韓国・北朝鮮・台湾・香港・マカオ・日本の白丸は、漢字の名前も出す（aptKanji.js。Wikidata から引いて30日とっておく）
import * as Cesium from 'cesium';
import { inSatDisk, wrapLon } from './satDisk.js';
import { awcFetch } from './wxPanels/awc.js';
import { createProcedureView, PROC_CSS } from './aptProcedures.js';
import { loadAirportDb } from './dbLoader.js';
import { kanjiNames, KANJI_RE } from './aptKanji.js';


export async function initAirportsLayer(viewer, { dataUrl = null } = {}) {
  const ds = new Cesium.CustomDataSource('dbAirports');
  viewer.dataSources.add(ds);
  // main.js の再読込（dataSources.removeAll）で消えたら付け直す
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => viewer.dataSources.add(ds), 0); });

  let db;
  // 日本（public/data/nav/airport_db.json）＋海外（public/data/intl/）
  try { db = dataUrl ? await (await fetch(dataUrl)).json() : await loadAirportDb(); } catch (e) { console.warn('[airports]', e); return null; }
  const short = s => s.replace(/（.*?）/g, '').replace(/国際空港|空港|飛行場/g, '');

  for (const a of Object.values(db.airports)) {
    ds.entities.add({
      id: `db-${a.icao}`,
      position: Cesium.Cartesian3.fromDegrees(a.arp.lon, a.arp.lat),
      point: { pixelSize: 9, color: Cesium.Color.fromCssColorString('#4fc3f7'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: `${a.iata || a.icao} ${short(a.nameJa || a.nameEn || '')}`, font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
      properties: { kind: 'dbAirport', icao: a.icao },
    });
    // 滑走路（近づいたときだけ）
    const done = new Set();
    for (const r of a.runways) {
      if (!r.threshold || !r.departureEnd || done.has(r.reciprocal)) continue;
      done.add(r.id);
      ds.entities.add({
        polyline: { positions: Cesium.Cartesian3.fromDegreesArray([r.threshold.lon, r.threshold.lat, r.departureEnd.lon, r.departureEnd.lat]),
          width: 5, clampToGround: true, material: Cesium.Color.fromCssColorString('#eceff1'),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 250000) },
      });
    }
  }

  // ---- METAR・TAF を出している空港（小さな白丸） ----
  //   対象（2026-10-18 から）：衛星画像（ひまわり全球画像）が地図に表示される範囲（satDisk.js の円。
  //   衛星の真下から 81 度＝地球のふちまで。およそ東経60度〜西経138度・南緯81度〜北緯81度）にある、METAR か TAF を出しているすべての空港。
  //   インド・中央アジア・シベリア・アラスカ西部・ハワイ・オーストラリア・ニュージーランド・南太平洋の島々なども入る
  //   （2026-10-17 までは 東経78〜169度・南緯22度〜北緯56度の四角）
  const COUNTRY = { NZ: 'ニュージーランド', PH: 'ハワイ', PA: 'アラスカ', PF: 'アラスカ', PP: 'アラスカ', PM: 'ミッドウェー', PJ: 'ジョンストン島',
    PL: 'キリバス', NF: 'フィジー', NW: 'ニューカレドニア', NV: 'バヌアツ', NS: 'サモア', NC: 'クック諸島', NI: 'ニウエ', NL: 'ウォリス・フツナ',
    NT: '仏領ポリネシア', OP: 'パキスタン', OA: 'アフガニスタン', UT: '中央アジア', UC: 'キルギス', YB: 'オーストラリア', RJ: '日本', RO: '日本', RK: '韓国', ZK: '北朝鮮', ZM: 'モンゴル', RC: '台湾', VH: '香港', VM: 'マカオ',
    VT: 'タイ', WS: 'シンガポール', VV: 'ベトナム', RP: 'フィリピン', WM: 'マレーシア', WB: 'マレーシア', VD: 'カンボジア', VL: 'ラオス',
    WA: 'インドネシア', WI: 'インドネシア', WR: 'インドネシア', WQ: 'インドネシア', WP: '東ティモール', VY: 'ミャンマー', VG: 'バングラデシュ',
    VE: 'インド', VI: 'インド', VA: 'インド', VO: 'インド', VN: 'ネパール', VQ: 'ブータン', VC: 'スリランカ', VR: 'モルディブ',
    UA: 'カザフスタン', PG: 'グアム・北マリアナ', PT: 'ミクロネシア', PK: 'マーシャル諸島', PW: 'ウェーク島', AY: 'パプアニューギニア',
    AG: 'ソロモン諸島', AN: 'ナウル', NG: 'キリバス' };
  const SPECIAL = { WBSB: 'ブルネイ', PTRO: 'パラオ', PTKR: 'パラオ' };
  const countryOf = id => SPECIAL[id] || COUNTRY[id.slice(0, 2)] || (id[0] === 'Z' ? '中国' : id[0] === 'U' ? 'ロシア' : id[0] === 'Y' ? 'オーストラリア' : '');
  const stations = new Map();
  async function loadStations() {
    const KEY = 'aw.wxStations.v5', DAYS = 30;          // v5：範囲を地球のふち（衛星の真下から 81 度）まで広げた（前の一覧は使わない）
    try { for (const v of [1, 2, 3, 4]) localStorage.removeItem(`aw.wxStations.v${v}`); } catch { /* なし */ }
    try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.t < DAYS * 864e5 && c.list?.length) return c.list; } catch { /* なし */ }
    const res = new Map();
    // 10度ごとに区切って地点一覧を取る（1回に返る数に上限 400 があるため、多い所は4つに分ける）
    let failed = 0, gate = 0;
    async function q(la0, lo0, la1, lo1, depth = 0) {
      // 一度に多く問い合わせると断られることがあるので、失敗したら少し待って3回まで問い合わせ直す
      let j;
      for (let t = 0; ; t++) {
        // AWC は1分あたりの回数に上限（約100回）があるので、間を 0.7 秒以上あける（初回だけ。全部で2分ほど）
        const wait = gate - Date.now(); gate = Math.max(gate, Date.now()) + 700;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try { j = await awcFetch(`stationinfo?bbox=${la0},${lo0},${la1},${lo1}&format=json`, 'json'); break; }
        catch (e) { if (t >= 3) { failed++; throw e; } await new Promise(r => setTimeout(r, 1500 * (t + 1))); }
      }
      if (j.length >= 400 && depth < 3) {
        const lm = (la0 + la1) / 2, om = (lo0 + lo1) / 2;
        for (const b of [[la0, lo0, lm, om], [la0, om, lm, lo1], [lm, lo0, la1, om], [lm, om, la1, lo1]]) await q(...b, depth + 1);
        return;
      }
      for (const s of j) {
        if (!s.icaoId || !/^[A-Z]{4}$/.test(s.icaoId)) continue;
        if (!inSatDisk(+s.lat, +s.lon)) continue;
        const m = (s.siteType || []).includes('METAR'), t = (s.siteType || []).includes('TAF');
        if (m || t) res.set(s.icaoId, [s.icaoId, s.site, +(+s.lat).toFixed(4), +(+s.lon).toFixed(4), s.elev ?? null, m ? 1 : 0, t ? 1 : 0]);
      }
    }
    const jobs = [];
    // 10度ごとの四角のうち、衛星画像の円にかかるもの。180度より東は西経（−）にして問い合わせる
    for (let la = -90; la < 90; la += 10) for (let lo = 50; lo < 230; lo += 10) {
      let hit = false;
      for (let a = 0; a <= 4 && !hit; a++) for (let b = 0; b <= 4 && !hit; b++) hit = inSatDisk(la + a * 2.5, lo + b * 2.5);
      if (hit) jobs.push([la, wrapLon(lo), la + 10, wrapLon(lo) + 10]);
    }
    for (let i = 0; i < jobs.length; i += 2) await Promise.all(jobs.slice(i, i + 2).map(b => q(...b).catch(e => console.warn('[stations]', b, e.message))));
    const list = [...res.values()];
    // 取りこぼしがあるときは保存しない（次に開いたときにもう一度問い合わせる）
    if (list.length && !failed) try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), list })); } catch { /* 保存できなくても表示はする */ }
    else if (failed) console.warn(`[stations] ${failed} か所の範囲を読めませんでした（次に開いたときに読み直します）`);
    return list;
  }
  loadStations().then(list => {
    for (const [icao, site, lat, lon, elev, hasM, hasT] of list) {
      if (db.airports[icao]) continue;                 // 空港データベースの空港は青いピンで表示済み（クリックで同じ METAR・TAF）
      stations.set(icao, { icao, site, lat, lon, elev, hasM, hasT });
      ds.entities.add({
        id: `wx-${icao}`, position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: { pixelSize: 6, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#263238'), outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: icao, font: '11px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -10), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.2e6) },
        properties: { kind: 'wxStation', icao },
      });
    }
    console.log(`[stations] METAR・TAF の空港 ${stations.size} か所（白丸）`);
    // 漢字の名前（あとから届く。届くまでは英語の名前）
    kanjiNames([...stations.keys()].filter(i => KANJI_RE.test(i))).then(names => {
      for (const [icao, n] of Object.entries(names)) { const s = stations.get(icao); if (s) s.kanji = n; }
    }).catch(e => console.warn('[apt kanji]', e));
  }).catch(e => console.warn('[stations]', e));

  // ---- クリックで空港パネル（METAR 6時間・TAF・今後の気象解説） ----
  const st = document.createElement('style');
  st.textContent = `
#awApt{position:absolute;top:50px;right:382px;width:400px;max-width:calc(100vw - 760px);min-width:300px;max-height:calc(100vh - 240px);overflow:auto;z-index:24;
  background:rgba(20,30,45,.97);color:#fff;font:13px/1.55 "Meiryo",sans-serif;border-radius:8px;padding:12px 14px;border-top:4px solid #4fc3f7;display:none}
#awApt h2{font-size:16px;margin:0 22px 2px 0}#awApt .sub{font-size:11.5px;color:#9fb3c8}
#awApt h3{font-size:12.5px;color:#8fd0ff;margin:12px 0 4px}
#awApt .x{position:absolute;right:10px;top:8px;background:none;border:none;color:#aaa;font-size:18px;cursor:pointer}
#awApt ul{margin:0;padding-left:18px}#awApt li{margin:2px 0}
#awApt .caution li{color:#ffcc80}
#awApt pre{white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.4);padding:6px 8px;border-radius:4px;font:12px ui-monospace,Menlo,monospace;margin:0}
#awApt .mt{display:grid;grid-template-columns:auto 1fr;gap:3px 8px;align-items:start}
#awApt .cat{font:600 10.5px "Meiryo",sans-serif;border-radius:8px;padding:0 6px;margin-top:2px;white-space:nowrap}
#awApt .VFR{background:#2e7d32}#awApt .MVFR{background:#1565c0}#awApt .IFR{background:#c62828}#awApt .LIFR{background:#8e24aa}
#infoPanel,#commentPanel{right:382px!important}`+PROC_CSS;
  document.head.appendChild(st);
  const AP = Object.assign(document.createElement('div'), { id: 'awApt' });
  document.body.appendChild(AP);
  const mt = await import('./wxPanels/metarTaf.js');
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const ul = (arr, cls = '') => `<ul class="${cls}">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const proc = createProcedureView(viewer, db);
  let seq = 0, tab = 'WX';   // 最後に開いたタブ（別の空港を開いても同じタブで開く）
  async function showAirport(a) {
    const my = ++seq;
    if (a.station) tab = 'WX';
    const cnt = a.station ? {} : proc.counts(a);
    const rw = a.runways.filter((r, i, arr) => !arr.slice(0, i).some(x => x.id === r.reciprocal))
      .map(r => `RWY ${r.id}/${r.reciprocal || '—'} ${r.lengthM}m`).join('　');
    AP.innerHTML = `<button class="x" aria-label="閉じる">×</button>
      <h2>${a.icao}${a.iata ? ` / ${a.iata}` : ''}　${esc(a.nameJa)}</h2>
      <div class="sub">${a.station ? `${a.nameEn ? `${esc(a.nameEn)}<br>` : ''}${esc(a.city)}・${a.elevationFt != null ? `標高 ${a.elevationFt}ft・` : ''}${[a.hasM ? 'METAR' : '', a.hasT ? 'TAF' : ''].filter(Boolean).join('・')} を発表（NOAA AWC の地点一覧）`
        : `${esc(a.city)}・標高 ${a.elevationFt}ft・${rw}<br>AIP ${a.aipEffective}`}</div>
      <div class="tabs">${[['WX', 'METAR・TAF', null], ...(a.station ? [] : ['SID', 'STAR', 'APPROACH'].map(t => [t, t, cnt[t]]))]
        .map(([k, t, n]) => `<button data-tab="${k}"${k === tab ? ' class="on"' : ''}>${t}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
      <div id="awAptW"${tab === 'WX' ? '' : ' style="display:none"'}>
        <h3>今後の気象解説</h3><div id="awAptB">METAR・TAF を取得しています…</div>
        <h3>METAR（過去6時間）</h3><div id="awAptM">取得中…</div>
        <h3>TAF</h3><pre id="awAptT">取得中…</pre>
        <div class="sub" style="margin-top:8px">出典：NOAA Aviation Weather Center。解説は METAR・TAF からの自動生成（教育用）。</div>
      </div>
      <div id="awAptP"${tab === 'WX' ? ' style="display:none"' : ''}></div>`;
    AP.querySelector('.x').onclick = () => { AP.style.display = 'none'; viewer.selectedEntity = undefined; proc.close(); };
    if (a.station) proc.close(); else proc.open(a, AP.querySelector('#awAptP'));
    const setTab = t => {
      tab = t;
      AP.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      AP.querySelector('#awAptW').style.display = t === 'WX' ? '' : 'none';
      AP.querySelector('#awAptP').style.display = t === 'WX' ? 'none' : '';
      if (t !== 'WX') proc.setTab(t);
    };
    AP.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
    if (tab !== 'WX' && !a.station) proc.setTab(tab);
    AP.style.display = 'block';
    const [mres, tres] = await Promise.allSettled([
      awcFetch(`metar?ids=${a.icao}&format=raw&hours=6`),
      awcFetch(`taf?ids=${a.icao}&format=raw`),
    ]);
    if (my !== seq) return;
    const metars = mres.status === 'fulfilled' ? mres.value.split(/\n+/).map(x => x.trim()).filter(Boolean) : [];
    metars.sort((x, y) => (/\b(\d{6})Z/.exec(y)?.[1] || '').localeCompare(/\b(\d{6})Z/.exec(x)?.[1] || ''));
    const taf = tres.status === 'fulfilled' && tres.value ? tres.value : null;
    AP.querySelector('#awAptM').innerHTML = metars.length
      ? `<div class="mt">${metars.map(m => { const c = mt.parseMetar(m).cat; return `<span class="cat ${c}">${c}</span><pre>${esc(m)}</pre>`; }).join('')}</div>`
      : (mres.status === 'fulfilled' ? '過去6時間の METAR はありません。' : '取得できませんでした。');
    AP.querySelector('#awAptT').textContent = taf || (tres.status === 'fulfilled' ? 'TAF は発表されていません。' : '取得できませんでした。');
    const b = mt.briefing(a, metars, taf);
    AP.querySelector('#awAptB').innerHTML = `<b>現況</b>${ul(b.now)}${b.trend.length ? `<b>この6時間の推移</b>${ul(b.trend)}` : ''}<b>今後（TAF）</b>${ul(b.forecast)}<b>注意点</b>${ul(b.cautions, 'caution')}`;
  }
  // 空港のクリックを先に受け取る所（経路作成 BOX で路線を決めている間など）。fn({kind, icao}) が true を返すと空港パネルは開かない
  const pickHooks = [];
  let hintFn = null;
  viewer.selectedEntityChanged.addEventListener(entity => {
    const kind = entity?.properties?.kind?.getValue?.();
    if ((kind === 'wxStation' || kind === 'dbAirport') && pickHooks.some(fn => fn({ kind, icao: entity.properties.icao.getValue() }) === true)) {
      setTimeout(() => { if (viewer.selectedEntity === entity) viewer.selectedEntity = undefined; }, 0);   // 同じ空港をもう一度押しても届くように
      return;
    }
    if (kind === 'wxStation') {
      const s = stations.get(entity.properties.icao.getValue()); if (!s) return;
      // 空港データベースにない空港：滑走路・手順はなし。METAR・TAF だけ
      showAirport({ station: true, icao: s.icao, iata: '', nameJa: s.kanji || s.site.trim(), nameEn: s.kanji ? s.site.trim() : '', city: countryOf(s.icao),
        elevationFt: s.elev != null ? Math.round(s.elev * 3.28084) : null, runways: [], hasM: s.hasM, hasT: s.hasT });
      return;
    }
    if (kind !== 'dbAirport') return;
    showAirport(db.airports[entity.properties.icao.getValue()]);
  });

  // ---- マウスを載せた空港の名前（白丸・空港ピン・事例の空港） ----
  const tipEl = document.createElement('div');
  tipEl.id = 'awAptTip';
  tipEl.style.cssText = 'position:absolute;z-index:40;pointer-events:none;display:none;background:rgba(20,30,45,.95);color:#fff;' +
    'border:1px solid #8fd0ff;border-radius:6px;padding:4px 9px;font:12px/1.45 "Meiryo",sans-serif;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,.45)';
  document.body.append(tipEl);
  const aptTip = entity => {
    const P = entity?.properties, kind = P?.kind?.getValue?.();
    if (kind === 'wxStation') {
      const s = stations.get(P.icao.getValue()); if (!s) return null;
      const wx = [s.hasM && 'METAR', s.hasT && 'TAF'].filter(Boolean).join('・');
      const hint = hintFn?.();
      if (hint) return `<b>${esc(s.icao)}</b>　${esc(s.kanji || s.site.trim())}<br><span style="color:#ffe082">${esc(hint)}（SID・STAR なし・直行で接続）</span>`;
      return `<b>${esc(s.icao)}</b>　${s.kanji ? `${esc(s.kanji)}<br><span style="color:#cfe3f5">${esc(s.site.trim())}</span>` : esc(s.site.trim())}<br><span style="color:#9fb3c8">${esc(countryOf(s.icao))}${wx ? '・' + wx : ''}${s.elev != null ? `・標高 ${Math.round(s.elev * 3.28084).toLocaleString()}ft` : ''}　クリックで METAR・TAF</span>`;
    }
    if (kind === 'dbAirport') {
      const a = db.airports[P.icao.getValue()]; if (!a) return null;
      const hint = hintFn?.();
      if (hint) return `<b>${esc(a.icao)}${a.iata ? ' / ' + esc(a.iata) : ''}</b>　${esc(a.nameJa || '')}<br><span style="color:#ffe082">${esc(hint)}</span>`;
      return `<b>${esc(a.icao)}${a.iata ? ' / ' + esc(a.iata) : ''}</b>　${esc(a.nameJa || '')}${a.nameEn ? `<br><span style="color:#cfe3f5">${esc(a.nameEn)}</span>` : ''}` +
        `<br><span style="color:#9fb3c8">${esc(a.city || '')}${a.elevationFt != null ? `${a.city ? '・' : ''}標高 ${a.elevationFt.toLocaleString()}ft` : ''}　クリックで滑走路・METAR・TAF</span>`;
    }
    if (kind === 'airport') {                                // 事例表示の空港（main.js）
      const icao = P.icao?.getValue?.() || '', name = entity.name || P.name?.getValue?.() || '';
      return `<b>${esc(icao)}</b>　${esc(name)}`;
    }
    return null;
  };
  let lastMove = null, pending = false;
  const hoverAt = () => {
    pending = false;
    const m = lastMove; if (!m) return;
    let html = null;
    try {
      // 白丸は小さいので、少し外れていても拾う（周り 7px）
      html = aptTip(viewer.scene.pick(m.pos, 7, 7)?.id);
    } catch { /* 描画の途中などで拾えないときは出さない */ }
    if (!html) { tipEl.style.display = 'none'; viewer.canvas.style.cursor = ''; return; }
    tipEl.innerHTML = html; tipEl.style.display = 'block';
    const rc = viewer.canvas.getBoundingClientRect(), tw = tipEl.offsetWidth;
    const x = rc.left + m.pos.x + 14, y = rc.top + m.pos.y - 12 - tipEl.offsetHeight;
    tipEl.style.left = `${Math.min(x, window.innerWidth - tw - 6)}px`; tipEl.style.top = `${Math.max(4, y)}px`;
    viewer.canvas.style.cursor = 'pointer';
  };
  const hh = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  hh.setInputAction(mv => {
    lastMove = { pos: Cesium.Cartesian2.clone(mv.endPosition) };
    if (!pending) { pending = true; requestAnimationFrame(hoverAt); }   // 1コマに1回だけ調べる
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  viewer.canvas.addEventListener('pointerleave', () => { lastMove = null; tipEl.style.display = 'none'; });
  viewer.canvas.addEventListener('pointerdown', () => { tipEl.style.display = 'none'; });

  // 白丸の空港を、経路の出発・到着に使える形にする（滑走路・SID・STAR はなし。経路とは直行で結ぶ）
  const stAirports = new Map();
  function station(icao) {
    if (stAirports.has(icao)) return stAirports.get(icao);
    const s = stations.get(icao); if (!s) return null;
    const a = { icao, iata: '', nameJa: s.kanji || s.site.trim(), nameEn: s.site.trim(), city: countryOf(icao), station: true,
      arp: { lat: s.lat, lon: s.lon }, elevationFt: s.elev != null ? Math.round(s.elev * 3.28084) : 0,
      runways: [], sids: [], stars: [], sidTransitions: [], starTransitions: [], approaches: [] };
    if (s.kanji) stAirports.set(icao, a);              // 漢字の名前が届く前のものは覚えない（届いたら作り直す）
    return a;
  }
  return {
    /** 白丸の空港（METAR・TAF だけの空港）を、滑走路・SID・STAR のない空港として返す。なければ null */
    station,
    /** 空港（青いピン・白丸）のクリックを受け取る関数を登録 */
    onPick(fn) { pickHooks.push(fn); },
    /** マウスを載せた空港の札に出す一言を返す関数（null を返すといつもの札） */
    setClickHint(fn) { hintFn = fn; },
    /** 事例表示中は、事例側で表示している空港（hide の ICAO）を隠す */
    setCaseMode(on, hide = []) {
      for (const e of ds.entities.values) {
        const icao = e.properties?.icao?.getValue?.();
        if (icao) e.show = !(on && hide.includes(icao));
      }
    },
  };
}
