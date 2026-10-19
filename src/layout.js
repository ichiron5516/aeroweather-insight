// 画面の割り付け（iPad 11 インチの横向き 1,194×834 に合わせる。2026-10-19）
//   ・画面の左端にアイコンの列（上から「天気図」「経路」「表示」「設定」）。押したものだけ、その右に引き出し（1 列）を出す。
//     もう一度押すとしまう。同時に出す引き出しは 1 つだけ。開いたときは「天気図」の引き出しを出す
//       天気図 … 天気図・画像の一覧（#awWx。chartsPanel.js が作る）。見本は小さめ・1 列。上の「種類」で絞り込める
//       経路   … 経路を作る（#awRB）と 揺れ回避 経路アドバイス（#awAdv）を 1 つの引き出しに縦に並べる
//       表示   … 気象（衛星・レーダー、悪天予想図、数値予報、高層3D、海洋、解析3D）、地図（山・FIR・Variation・緯度経度線）、
//                航空（空域・航法・青丸空港・白丸空港）の表示のオン・オフ
//       設定   … 視点・向き・高度の倍率・AIP 取込・凡例（凡例は事例表示のときだけ）
//   ・地図の上に残すのは、右上の「全体・真上・斜め」、左上の推奨経路の 1 行（評価の後）、右下の「凡例」（事例表示のときだけ）
//   ・ボタンは index.html・各ファイルの要素をそのまま移すので、押したときの処理は変わらない
//   ・ほかのファイルは window.awLayout.insets() で、地図が見えている範囲（左右に隠れている幅）を知る
const KEY = 'aw.layout.v3';
const RAIL = 56;
const drawerW = () => (window.innerWidth < 1300 ? 224 : 280);

const ICON = {
  wx: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 15l4.5-4.5 4 4 2.5-2.5 6 6"/><circle cx="15.5" cy="9.5" r="1.6"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17.2c5-1 2.5-6.5 8-9.2"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M12 4l9 4.5-9 4.5-9-4.5z"/><path d="M3 12.5l9 4.5 9-4.5"/><path d="M3 16.5l9 4.5 9-4.5"/></svg>',
  set: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2" class="f"/><circle cx="15" cy="12" r="2" class="f"/><circle cx="8" cy="18" r="2" class="f"/></svg>',
};
const TABS = [['wx', '天気図', '天気図・画像'], ['route', '経路', '経路を作る・揺れ回避 経路アドバイス'], ['show', '表示', '表示するもの（気象・地図・航空）'], ['set', '設定', '視点・向き・高度・AIP 取込・凡例']];

const CSS = `
:root{--awRail:${RAIL}px;--awDW:224px;--awL:${RAIL}px}
/* ---- 左端のアイコンの列 ---- */
#awRail{position:absolute;left:0;top:0;bottom:0;width:var(--awRail);z-index:45;background:rgba(10,17,26,.97);border-right:1px solid #2b3f55;
  display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:8px;box-sizing:border-box}
#awRail button{width:50px;height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:1px solid transparent;
  border-radius:9px;color:#9fb3c8;font:600 11px "Meiryo",sans-serif;cursor:pointer;padding:0;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
#awRail button svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#awRail button svg .f{fill:rgba(10,17,26,1)}
#awRail button:hover{color:#fff}
#awRail button[aria-pressed="true"]{background:#1e5a8c;border-color:#8fd0ff;color:#fff}
/* ---- 引き出し（どれも同じ場所・同じ幅。1 列） ---- */
.awDrw,#awWx{position:absolute !important;left:var(--awRail) !important;top:0 !important;bottom:0 !important;right:auto !important;
  width:var(--awDW) !important;max-width:none !important;max-height:none !important;box-sizing:border-box;z-index:44 !important;
  border-radius:0 !important;border-right:1px solid #2b3f55;transition:transform .2s ease,visibility .2s}
.awDrw{overflow-y:auto;overflow-x:hidden;background:rgba(16,25,37,.97);color:#fff;font:12.5px/1.5 "Meiryo",sans-serif;padding:8px 8px 40px;-webkit-overflow-scrolling:touch}
.awDrw.awOff,#awWx.awOff{transform:translateX(calc(-100% - var(--awRail)));visibility:hidden}
.awDrw .awH{font:600 14px "Meiryo",sans-serif;margin:2px 2px 6px;display:flex;align-items:center;justify-content:space-between}
.awDrw .awSec{font:600 11.5px "Meiryo",sans-serif;color:#8fd0ff;margin:12px 2px 4px;padding-top:6px;border-top:1px solid #2b3f55}
.awDrw .awSec:first-of-type{border-top:none;margin-top:4px;padding-top:0}
.awDrw .awSub{font-size:10.5px;color:#9fb3c8;margin:6px 2px 2px}
.awDrw .awCol{display:flex;flex-direction:column;gap:4px}
.awDrw .awCol>button,.awDrw .awCol .dr>button,.awDrw .awCol #upper3dBtns>button{width:100%;text-align:left;box-sizing:border-box}
.awDrw button{font:12px/1.35 "Meiryo",sans-serif !important;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:6px;
  padding:7px 9px !important;cursor:pointer;white-space:normal !important;min-height:34px;touch-action:manipulation}
.awDrw button:hover{border-color:#8fd0ff}
.awDrw button.on,.awDrw button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
.awDrw button:disabled{opacity:.45;cursor:default}
/* 表示の引き出しの「気象」（awWxDash を 1 列にする） */
.awDrw #awWxDash{position:static !important;margin:0 !important;padding:0 !important;background:none !important;border:none !important}
.awDrw #awWxDash .dr{display:flex !important;flex-direction:column;align-items:stretch !important;gap:4px;margin:0 0 6px !important}
.awDrw #awWxDash .dl{width:auto !important;font-size:10.5px !important;color:#9fb3c8 !important;text-align:left !important;margin:4px 2px 0}
.awDrw #awWxDash #upper3dBtns{display:flex !important;flex-direction:column;gap:4px}
.awDrw #upper3dSt,.awDrw #ct3dSt,.awDrw #awSeaSt,.awDrw #awAnSt{font:11px/1.5 "Meiryo",sans-serif !important;color:#cfe3f5 !important;text-shadow:none !important;text-align:left !important;max-width:none !important;margin:0 2px 6px}
.awDrw #upper3dSt:empty,.awDrw #ct3dSt:empty,.awDrw #awSeaSt:empty,.awDrw #awAnSt:empty{display:none}
.awDrw #asRow{display:flex !important;flex-direction:column;align-items:stretch !important;gap:4px}
.awDrw #asRow>button{width:100%;text-align:left}
.awDrw #asRow .rowLabel{display:none}
.awDrw #asBand,.awDrw #asSolid{border-style:dashed}
.awDrw #asRow button.on{background:#5c1f2b;border-color:#ef9a9a}
.awDrw #navBtn.on{background:#134e4a;border-color:#64ffda}
.awDrw #gridBtn.on{background:#1f3b57;border-color:#cfe8ff}
.awDrw #varBtn.on{background:#3d1450;border-color:#e040fb}
.awDrw #mountainBtn.on{background:#3b2f1e;border-color:#ffcc80}
.awDrw #ct3dBtn.on{background:#2a3f5c;border-color:#fff}
.awDrw #navLegend{display:none;flex-direction:column;align-items:flex-start;gap:2px;background:rgba(0,0,0,.25);border-radius:6px;padding:4px 8px;font:10.5px "Meiryo",sans-serif;color:#e0e0e0}
.awDrw #navLegend.on{display:flex}
.awDrw #navLegend i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin:0 3px 0 2px}
/* 設定の引き出し：高度の倍率はつながったボタン 1 本 */
.awDrw #exagGroup{display:flex;width:100%}
.awDrw #exagGroup .exagLabel{display:none}
.awDrw #exagGroup button{flex:1;border-radius:0;margin:0;padding:7px 2px !important;text-align:center;min-width:0}
.awDrw #exagGroup button+button{border-left:none}
.awDrw #exagGroup button:first-of-type{border-radius:6px 0 0 6px}
.awDrw #exagGroup button:last-of-type{border-radius:0 6px 6px 0}
.awDrw #exagGroup button.on{background:#1e5a8c;border-color:#fff;font-weight:700}
/* 使わないボタン（事例専用）はどこに移しても隠す */
[data-cam="dep"],[data-cam="turb"],[data-cam="arr"],[data-cam="hero"]{display:none !important}
/* 元の右下のボタン群は、移した後の残り（隠しているボタン・天気図の段）だけなので出さない */
#camButtons{display:none !important}
/* ---- 経路の引き出し：経路を作る ＋ 経路アドバイスを縦に並べる ---- */
#awDrwRoute{padding:0 0 40px}
#awDrwRoute #awRB,#awDrwRoute #awAdv{position:static !important;width:auto !important;max-width:none !important;max-height:none !important;
  left:auto !important;right:auto !important;top:auto !important;bottom:auto !important;border-radius:0 !important;overflow:visible !important;transform:none !important;opacity:1 !important}
#awDrwRoute #awRB{border-left:none !important;border-bottom:1px solid #2b3f55;padding:8px 10px}
#awDrwRoute #awAdv{padding:8px 10px;font-size:12.5px;background:none}
#awDrwRoute .awStep{display:inline-block;background:#1e5a8c;color:#fff;border-radius:9px;font:700 11px "Meiryo",sans-serif;padding:0 7px;margin-right:6px;vertical-align:1px}
#awDrwRoute #awAdv .row{gap:5px}
#awDrwRoute #awAdv label{flex:1 1 90px}
#awDrwRoute select,#awDrwRoute input,#awDrwRoute textarea{max-width:100%;min-width:0;box-sizing:border-box}
#awDrwRoute #awAdv label select{width:100%}
#awDrwRoute #awAdv button.go{flex:1 1 100%;min-height:36px}
#awDrwRoute #awAdv .tg{flex:1 1 40%}
/* ---- 天気図の引き出し（#awWx）：見本は小さめ・1 列。ボタンは見本の下に横に並べる ---- */
#awWx{padding:8px 8px 40px !important;background:rgba(16,25,37,.97) !important;border-left:none !important;border-right:1px solid #2b3f55 !important;box-shadow:none !important}
#awWx h2{font-size:14px !important}
#awWx .awGrpSel{width:100%;margin:0 0 6px;background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:6px;font:12.5px "Meiryo",sans-serif;padding:6px 8px;min-height:34px}
#awWx .grp{margin:10px 0 4px !important}
#awWx .it{margin-bottom:12px !important;padding-bottom:8px;border-bottom:1px solid #1f3043}
#awWx .it .row{flex-direction:column !important;gap:5px !important}
#awWx .it .main{order:0;width:100%}
#awWx .it .side{order:1;width:100% !important}
#awWx .it .side .acts{flex-direction:row !important;flex-wrap:wrap}
#awWx .it .side{flex-direction:row !important;flex-wrap:wrap;gap:4px !important}
#awWx .it .side button{width:auto !important;flex:1 1 auto;font-size:11.5px !important;padding:5px 7px !important;min-height:30px;text-align:center !important}
#awWx .it .side .sep{display:none}
#awWx .th{aspect-ratio:4/3}
#awWx .meta{flex-direction:column;gap:0 !important}
#awWx .meta b{font-size:12px !important}
#awWx .awHideG{display:none !important}
/* ---- 地図の上に残すもの ---- */
#awQuick{position:absolute;top:5px;right:164px;z-index:30;display:flex;gap:4px}
#awQuick button,#awLegBtn{background:rgba(20,30,45,.92);color:#fff;border:1px solid #8fd0ff;border-radius:7px;font:12px "Meiryo",sans-serif;padding:7px 11px;cursor:pointer;min-height:34px;touch-action:manipulation}
#awQuick button:hover,#awLegBtn:hover{background:#1e3a5f}
#awLegBtn{position:absolute;right:8px;bottom:36px;z-index:30}
#awLegBtn[aria-pressed="true"]{background:#1e3a5f;border-color:#fff}
#legend{left:auto !important;right:8px !important;bottom:82px !important;z-index:31 !important;font-size:11.5px !important;line-height:1.75 !important;max-width:calc(100vw - var(--awL) - 30px)}
body:not(.awLegOn) #legend{display:none !important}
#awRec{position:absolute;left:calc(var(--awL) + 8px);top:56px;z-index:30;max-width:min(560px,calc(100vw - var(--awL) - 120px));display:none;
  background:rgba(20,30,45,.94);color:#fff;border:1px solid #00e676;border-radius:8px;padding:6px 10px;font:12.5px/1.4 "Meiryo",sans-serif;cursor:pointer;transition:left .2s ease}
#awRec.on{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#awRec b{font:700 13px ui-monospace,Menlo,monospace}
#awRec .b{border-radius:9px;padding:0 8px;font-size:11px;font-weight:600}
#awRec .good{background:#2e7d32}#awRec .caution{background:#b58900}#awRec .avoid{background:#c62828}
#awRec .s{color:#b2dfdb;font-size:11.5px}
#titleBar{left:calc(var(--awL) + 8px) !important;top:8px !important;padding:5px 10px !important;transition:left .2s ease}
#titleBar h1{font-size:14px !important}
#titleBar .sub{font-size:10px !important;margin-top:1px !important}
/* 左に隠れる分だけ、地図の上のものを右へずらす */
.cesium-viewer-animationContainer{left:var(--awL) !important;transition:left .2s ease}
.cesium-viewer-timelineContainer{left:calc(var(--awL) + 169px) !important;transition:left .2s ease}
.cesium-viewer-bottom{left:calc(var(--awL) + 172px) !important}
#awSec{left:calc(var(--awL) + (100vw - var(--awL)) / 2) !important;width:min(960px,calc(100vw - var(--awL) - 20px)) !important;min-width:0 !important}
#awSec.big{width:calc(100vw - var(--awL) - 20px) !important}
#profilePanel{left:calc(var(--awL) + (100vw - var(--awL)) / 2) !important}
#awSavedBanner{left:calc(var(--awL) + (100vw - var(--awL)) / 2) !important}
#awSaved{left:calc(var(--awL) + 10px) !important}
#fbjpPanel{left:calc(var(--awL) + 10px) !important}
#fbjpPanel img{width:min(520px,calc(100vw - var(--awL) - 40px)) !important}
#awApt{top:52px !important;right:8px !important;max-width:calc(100vw - var(--awL) - 20px) !important;width:min(400px,calc(100vw - var(--awL) - 20px)) !important;min-width:0 !important;max-height:calc(100vh - 150px) !important}
#awAip{top:52px !important;right:8px !important;max-width:calc(100vw - var(--awL) - 20px) !important}
.panel{top:52px !important;right:8px !important;max-width:calc(100vw - var(--awL) - 30px)}
`;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 覚えられなくても動く */ } }

export function initLayout() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const $ = id => document.getElementById(id);
  const S = load() || { leg: false };
  S.open = 'wx';                       // open：出している引き出し（null＝どれも出さない）。開いたときはいつも「天気図」（2026-10-19）

  // ---- アイコンの列 ----
  const rail = Object.assign(document.createElement('div'), { id: 'awRail' });
  rail.innerHTML = TABS.map(([k, t, tip]) => `<button data-tab="${k}" aria-pressed="false" title="${tip}">${ICON[k]}<span>${t}</span></button>`).join('');
  document.body.appendChild(rail);
  rail.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.open = S.open === b.dataset.tab ? null : b.dataset.tab; apply(); });

  // ---- 引き出し（経路・表示・設定。天気図は #awWx をそのまま使う） ----
  const mk = (id, html) => { const d = Object.assign(document.createElement('div'), { id, className: 'awDrw awOff' }); d.innerHTML = html; document.body.appendChild(d); return d; };
  const dRoute = mk('awDrwRoute', '');
  const dShow = mk('awDrwShow', `<div class="awH">表示</div>
    <div class="awSec">気象</div><div class="awCol" data-slot="wx"><div class="awSub" data-wait>読み込み中…</div></div>
    <div class="awSec">地図</div><div class="awCol" data-slot="map"></div>
    <div class="awSec">航空</div>
    <div class="awSub">空港</div><div class="awCol" data-slot="apt">
      <button data-apt="dbAirport" aria-pressed="true" title="空港データベースの空港（青い丸・名前・滑走路）。SID・STAR・進入方式のある空港">● 青丸空港</button>
      <button data-apt="wxStation" aria-pressed="true" title="METAR・TAF を出している空港（白い小さな丸）。クリックで METAR・TAF">○ 白丸空港（METAR・TAF）</button>
    </div>
    <div class="awSub">空域</div><div class="awCol" data-slot="as"></div>
    <div class="awSub">航法</div><div class="awCol" data-slot="nav"></div>`);
  const dSet = mk('awDrwSet', `<div class="awH">設定</div>
    <div class="awSec">視点</div><div class="awCol" data-slot="cam"></div>
    <div class="awSec">向き</div><div class="awCol" data-slot="view"></div>
    <div class="awSec">高度の倍率</div><div class="awCol" data-slot="exag"></div>
    <div class="awSec">データ</div><div class="awCol" data-slot="data"></div>
    <div data-legsec><div class="awSec">凡例</div><div class="awCol"><button data-leg aria-pressed="false" title="地図の右下に凡例を出す・しまう">凡例を表示</button></div></div>`);
  const slot = (d, k) => d.querySelector(`[data-slot="${k}"]`);
  const put = (d, k, el) => { if (el) slot(d, k).appendChild(el); };

  // index.html のボタンを引き出しに移す（押したときの処理はそのまま）
  [...document.querySelectorAll('#camButtons [data-cam]')].forEach(b => put(dSet, 'cam', b));
  [...document.querySelectorAll('#camButtons [data-view]')].forEach(b => put(dSet, 'view', b));
  put(dSet, 'exag', $('exagGroup'));
  put(dSet, 'data', $('aipBtn'));
  for (const id of ['mountainBtn', 'firBtn', 'varBtn', 'gridBtn']) put(dShow, 'map', $(id));
  put(dShow, 'as', $('asRow'));
  put(dShow, 'nav', $('navBtn')); put(dShow, 'nav', $('navLegend'));

  // 気象のボタン（awWxDash）は chartsPanel.js が後から作るので、できたら移す
  function moveDash() {
    const d = $('awWxDash');
    if (d && d.parentElement !== slot(dShow, 'wx')) {
      dShow.querySelector('[data-wait]')?.remove();
      slot(dShow, 'wx').appendChild(d);
      for (const id of ['upper3dSt', 'ct3dSt']) { const e = $(id); if (e && !d.contains(e)) d.appendChild(e); }
    }
  }
  // 経路の 2 つのパネルも後から作られる（advisor.js・routeBuilder.js）
  function moveRoute() {
    const rb = $('awRB'), adv = $('awAdv');
    if (rb && rb.parentElement !== dRoute) {
      dRoute.prepend(rb);
      const h = rb.querySelector('h2'); if (h && !h.querySelector('.awStep')) h.insertAdjacentHTML('afterbegin', '<span class="awStep">1</span>');
    }
    if (adv && adv.parentElement !== dRoute) {
      dRoute.appendChild(adv);
      const h = adv.querySelector('h2'); if (h && !h.querySelector('.awStep')) h.insertAdjacentHTML('afterbegin', '<span class="awStep">2</span>');
      watchRec(adv);
    }
  }
  // 天気図の一覧：「種類」で絞り込む（すべて／地上／高層…）
  function setupWx() {
    const P = $('awWx'); if (!P || P.dataset.awGrp) return;
    if (!P.querySelector('.it')) return;
    P.dataset.awGrp = '1';
    let g = '';
    for (const el of P.children) { if (el.classList.contains('grp')) { g = el.textContent.trim(); el.dataset.g = g; } else if (el.classList.contains('it')) el.dataset.g = g; }
    const groups = [...new Set([...P.querySelectorAll('.grp')].map(e => e.dataset.g))];
    const sel = Object.assign(document.createElement('select'), { className: 'awGrpSel', title: '表示する天気図の種類' });
    sel.innerHTML = ['すべて', ...groups].map(x => `<option>${x}</option>`).join('');
    sel.value = groups.includes(S.grp) ? S.grp : 'すべて';
    const filt = () => {
      S.grp = sel.value; save(S);
      P.querySelectorAll('.grp,.it').forEach(e => e.classList.toggle('awHideG', sel.value !== 'すべて' && e.dataset.g !== sel.value));
    };
    sel.onchange = filt;
    ($('awWxU') || P.querySelector('h2')).after(sel);
    filt();
    P.classList.toggle('awOff', S.open !== 'wx');
  }
  function adopt() { moveDash(); moveRoute(); setupWx(); }

  // ---- 空港（青丸・白丸）の表示 ----
  S.apt ||= { dbAirport: true, wxStation: true };
  const aptBtns = dShow.querySelectorAll('[data-apt]');
  const syncApt = () => aptBtns.forEach(b => b.setAttribute('aria-pressed', S.apt[b.dataset.apt] !== false));
  aptBtns.forEach(b => b.onclick = () => {
    const k = b.dataset.apt; S.apt[k] = S.apt[k] === false; save(S); syncApt();
    window.awAirports?.setVisible(k, S.apt[k]);
  });
  syncApt();
  // 空港レイヤ（airportsLayer.js）ができたら、覚えている表示に合わせる
  window.addEventListener('aw:airports-ready', () => { for (const k of Object.keys(S.apt)) window.awAirports?.setVisible(k, S.apt[k] !== false); });

  // ---- 地図の上：右上の視点ボタン・右下の凡例・左下の推奨経路 ----
  const quick = Object.assign(document.createElement('div'), { id: 'awQuick' });
  quick.innerHTML = '<button data-q="[data-cam=&quot;all&quot;]" title="日本全体を真上から">全体</button><button data-q="[data-view=&quot;top&quot;]" title="今見ている所を真上から">真上</button><button data-q="[data-view=&quot;se&quot;]" title="南東から北西を斜めに見下ろす">斜め</button>';
  quick.querySelectorAll('[data-q]').forEach(b => b.onclick = () => document.querySelector(b.dataset.q)?.click());
  const legBtn = Object.assign(document.createElement('button'), { id: 'awLegBtn', textContent: '凡例', title: '凡例を出す・しまう' });
  const legSet = dSet.querySelector('[data-leg]');
  const toggleLeg = () => { S.leg = !S.leg; apply(); };
  legBtn.onclick = toggleLeg; legSet.onclick = toggleLeg;
  const rec = Object.assign(document.createElement('div'), { id: 'awRec', title: 'クリックで経路の引き出しを開く' });
  rec.onclick = () => { S.open = 'route'; apply(); };
  document.body.append(quick, legBtn, rec);
  // 凡例（index.html の #legend）は事例表示のときだけ使う（main.js がリアルタイム表示では隠す）。使えるときだけボタンを出す
  const lgEl = $('legend');
  const syncLegAvail = () => {
    const ok = !!lgEl && lgEl.style.display !== 'none';
    legBtn.style.display = ok ? '' : 'none';
    dSet.querySelector('[data-legsec]').style.display = ok ? '' : 'none';
  };
  if (lgEl) new MutationObserver(syncLegAvail).observe(lgEl, { attributes: true, attributeFilter: ['style'] });
  syncLegAvail();

  // 推奨経路の 1 行：経路アドバイスの候補一覧（選んでいる経路）から作る
  function watchRec(adv) {
    const upd = () => {
      const li = adv.querySelector('#awList li[aria-current="true"]');
      if (!li) { rec.classList.remove('on'); return; }
      const name = (li.querySelector('.top b')?.textContent.trim() || '').replace(/^\d+\.\s*/, '');
      const badge = li.querySelector('.top .b'), sub = li.querySelector('.sub span')?.textContent.trim() || '';
      const dep = adv.querySelector('#awDep')?.value || '', arr = adv.querySelector('#awArr')?.value || '';
      rec.innerHTML = `<span>${dep} → ${arr}</span><b>${name}</b>${badge ? `<span class="${badge.className}">${badge.textContent}</span>` : ''}<span class="s">${sub}</span>`;
      rec.classList.add('on');
    };
    new MutationObserver(upd).observe(adv, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] });
    upd();
  }

  // ---- 出し入れ ----
  function apply() {
    adopt();
    document.documentElement.style.setProperty('--awDW', `${drawerW()}px`);
    document.documentElement.style.setProperty('--awL', `${RAIL + (S.open ? drawerW() : 0)}px`);
    rail.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', S.open === b.dataset.tab));
    dRoute.classList.toggle('awOff', S.open !== 'route');
    dShow.classList.toggle('awOff', S.open !== 'show');
    dSet.classList.toggle('awOff', S.open !== 'set');
    $('awWx')?.classList.toggle('awOff', S.open !== 'wx');
    document.body.classList.toggle('awLegOn', !!S.leg);
    legBtn.setAttribute('aria-pressed', !!S.leg); legSet.setAttribute('aria-pressed', !!S.leg);
    legSet.textContent = S.leg ? '凡例をしまう' : '凡例を表示';
    save(S);
    window.dispatchEvent(new CustomEvent('aw:layout', { detail: { open: S.open } }));
  }
  // パネルは後から作られるので、しばらくの間はできたら移す
  const iv = setInterval(adopt, 500);
  setTimeout(() => clearInterval(iv), 60e3);
  window.addEventListener('aw:charts-ready', () => setTimeout(adopt, 0));
  let rz = 0;
  window.addEventListener('resize', e => { if (!e.isTrusted) return; clearTimeout(rz); rz = setTimeout(apply, 150); });
  apply();

  window.awLayout = {
    rail: true,
    /** 地図が見えている範囲：左右に隠れている幅（px） */
    insets() { return { left: RAIL + (S.open ? drawerW() : 0), right: 0 }; },
    /** 引き出しを出す。'L'／'route' … 経路、'R'／'wx' … 天気図、'show'・'set' */
    show(side) { S.open = side === 'L' ? 'route' : side === 'R' ? 'wx' : side; apply(); },
    hide() { S.open = null; apply(); },
    get open() { return S.open; },
  };
}
