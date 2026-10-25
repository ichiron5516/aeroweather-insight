// 画面の割り付け（iPad 11 インチの横向き 1,194×834 に合わせる。2026-10-19、ボタンの整理 2026-10-25）
//   ・画面の左端にアイコンの列（上から「天気図」「経路」「表示」「設定」）。押したものだけ、その右に引き出し（1 列）を出す。
//     もう一度押すとしまう。同時に出す引き出しは 1 つだけ。開いたときは「天気図」の引き出しを出す
//       天気図 … 天気図・画像の一覧（#awWx。chartsPanel.js が作る）。図を押すと地図に重ね、いくつでも重ねられる。
//                一番上に「重ねている図」（重ねた順の番号・×で外す）。数値予報（GPV）・解析の線・国際悪天（SIGWX）・海洋もここで重ねる
//       経路   … 上に揺れ回避 経路アドバイス（#awAdv）、下に経路を作る（#awRB）
//       表示   … 「視点」「高度」「地図の線」を折りたたみで（中身は地図上部のプルダウンと同じ。どちらで操作しても同じ状態）、一番下に凡例
//       設定   … AIP 取込だけ
//   ・地図の上部に「視点」「高度」「地図の線」の 3 つのプルダウン
//       視点     … 全体（日本全体を真上から）・北から・東から・南から・西から・北西／北東／南西／南東斜め（衛星視点は全体と同じなので出さない）
//       高度     … 倍率（実寸・×25・×50・×75・×100）、地形・空域の 3D（山・空域）、天気図の 3D（気圧面・雲頂・国内悪天・国際悪天・GPV・断面図）
//       地図の線 … 緯度経度線・Variation・航法データ、空域（FIR・ACC・管制区・制限・訓練・ADIZ）、空港（青丸・白丸）
//   ・ボタンの処理は index.html・各ファイルのボタン（画面には出さない #awSrc に移す）を押して行う。押したときの処理は変わらない
//   ・ほかのファイルは window.awLayout.insets() で、地図が見えている範囲（左右に隠れている幅）を知る
const KEY = 'aw.layout.v4';
const RAIL = 56;
const drawerW = () => (window.innerWidth < 1300 ? 224 : 280);

const ICON = {
  wx: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 15l4.5-4.5 4 4 2.5-2.5 6 6"/><circle cx="15.5" cy="9.5" r="1.6"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17.2c5-1 2.5-6.5 8-9.2"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M12 4l9 4.5-9 4.5-9-4.5z"/><path d="M3 12.5l9 4.5 9-4.5"/><path d="M3 16.5l9 4.5 9-4.5"/></svg>',
  set: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2" class="f"/><circle cx="15" cy="12" r="2" class="f"/><circle cx="8" cy="18" r="2" class="f"/></svg>',
};
const TABS = [['wx', '天気図', '天気図・画像（押すと地図に重ねる）'], ['route', '経路', '揺れ回避 経路アドバイス・経路を作る'], ['show', '表示', '視点・高度・地図の線'], ['set', '設定', 'AIP 取込']];

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
/* ---- 画面に出さない元のボタン（押したときの処理はここから行う） ---- */
#awSrc{display:none !important}
/* ---- 引き出し（どれも同じ場所・同じ幅。1 列） ---- */
.awDrw,#awWx{position:absolute !important;left:var(--awRail) !important;top:0 !important;bottom:0 !important;right:auto !important;
  width:var(--awDW) !important;max-width:none !important;max-height:none !important;box-sizing:border-box;z-index:44 !important;
  border-radius:0 !important;border-right:1px solid #2b3f55;transition:transform .2s ease,visibility .2s}
.awDrw{overflow-y:auto;overflow-x:hidden;background:rgba(16,25,37,.97);color:#fff;font:12.5px/1.5 "Meiryo",sans-serif;padding:8px 8px 40px;-webkit-overflow-scrolling:touch}
.awDrw.awOff,#awWx.awOff{transform:translateX(calc(-100% - var(--awRail)));visibility:hidden}
.awDrw .awH{font:600 14px "Meiryo",sans-serif;margin:2px 2px 6px}
.awDrw .awSec{font:600 11.5px "Meiryo",sans-serif;color:#8fd0ff;margin:12px 2px 4px;padding-top:6px;border-top:1px solid #2b3f55}
.awDrw button{font:12px/1.35 "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:6px;
  padding:7px 9px;cursor:pointer;min-height:34px;touch-action:manipulation}
.awDrw button:hover{border-color:#8fd0ff}
.awDrw button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
/* 設定の引き出し：AIP 取込だけ */
#awDrwSet #aipBtn{width:100%;text-align:left}
#awDrwSet #aipBtn.on{background:#5d3a00;border-color:#ffb74d}
/* ---- プルダウン・折りたたみの中身（地図上部と「表示」の引き出しで共通） ---- */
.awMenu{font:12.5px/1.4 "Meiryo",sans-serif;color:#fff}
.awMenu .mh{font-size:10.5px;color:#8fd0ff;margin:8px 2px 3px}
.awMenu .mh:first-child{margin-top:0}
.awMenu .ck{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;text-align:left;background:none !important;border:none !important;
  color:#fff;font:12.5px/1.35 "Meiryo",sans-serif;padding:5px 4px !important;min-height:32px;border-radius:5px;cursor:pointer;touch-action:manipulation}
.awMenu .ck:hover{background:rgba(143,208,255,.1) !important}
.awMenu .ck .bx{flex:none;width:16px;height:16px;border:1.5px solid #8fa9c4;border-radius:3px;box-sizing:border-box;position:relative}
.awMenu .ck[aria-checked="true"] .bx{background:#4fc3f7;border-color:#4fc3f7}
.awMenu .ck[aria-checked="true"] .bx::after{content:"";position:absolute;left:4px;top:0;width:4px;height:9px;border:solid #0b141e;border-width:0 2px 2px 0;transform:rotate(45deg)}
.awMenu .ck .ld{color:#ffd54f;font-size:11px}
.awMenu .ck:disabled{opacity:.45;cursor:default}
.awMenu .sub{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 4px 27px}
.awMenu .sub button,.awMenu .seg button,.awMenu .grid button{font:11.5px "Meiryo",sans-serif !important;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;
  padding:4px 7px !important;min-height:28px;cursor:pointer;white-space:nowrap;touch-action:manipulation}
.awMenu .sub button[aria-pressed="true"],.awMenu .seg button[aria-pressed="true"],.awMenu .grid button[aria-pressed="true"]{background:#1e5a8c;border-color:#fff}
.awMenu .sub button:disabled{opacity:.4;cursor:default}
.awMenu .seg{display:flex;width:100%}
.awMenu .seg button{flex:1;border-radius:0;margin:0;min-width:0;padding:6px 2px !important;text-align:center}
.awMenu .seg button+button{border-left:none}
.awMenu .seg button:first-child{border-radius:6px 0 0 6px}
.awMenu .seg button:last-child{border-radius:0 6px 6px 0}
.awMenu .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
.awMenu .grid button{min-height:36px;padding:6px 2px !important;text-align:center;white-space:normal}
.awMenu .grid span{display:block}
.awMenu .navLg{display:flex;flex-direction:column;gap:2px;margin:0 0 4px 27px;font-size:10.5px;color:#e0e0e0}
.awMenu .navLg i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin:0 3px 0 2px}
/* ---- 地図上部のプルダウン ---- */
#awTop{position:absolute;top:6px;right:84px;z-index:50;display:flex;gap:5px;align-items:flex-start}
#awTop>.dd{position:relative}
#awTop>.dd>button{background:rgba(20,30,45,.94);color:#fff;border:1px solid #8fd0ff;border-radius:7px;font:12.5px "Meiryo",sans-serif;
  padding:7px 11px;cursor:pointer;min-height:36px;white-space:nowrap;touch-action:manipulation}
#awTop>.dd>button:hover{background:#1e3a5f}
#awTop>.dd>button[aria-expanded="true"]{background:#1e5a8c;border-color:#fff}
#awTop>.dd>button .cv{display:inline-block;margin-left:5px;font-size:10px;opacity:.85}
#awTop .pop{position:absolute;right:0;top:calc(100% + 5px);width:272px;max-height:calc(100vh - 70px);overflow-y:auto;background:rgba(16,25,37,.98);
  border:1px solid #47617d;border-radius:9px;padding:9px 9px 10px;box-shadow:0 6px 20px rgba(0,0,0,.5);box-sizing:border-box}
#awTop .pop[hidden]{display:none}
#awTopSt{position:absolute;top:50px;right:84px;z-index:29;max-width:min(460px,calc(100vw - var(--awL) - 100px));display:flex;flex-direction:column;gap:4px;pointer-events:none}
#awTopSt>div{background:rgba(20,30,45,.88);border-radius:6px;padding:4px 8px;font:11px/1.5 "Meiryo",sans-serif !important;color:#e6f2ff !important;text-shadow:none !important;text-align:left !important;max-width:none !important}
#awTopSt>div:empty{display:none}
#awTopSt i{display:inline-block;width:11px;height:9px;margin:0 3px 0 6px;vertical-align:-1px;border:1px solid #fff}
/* ---- 表示の引き出し：折りたたみ ---- */
#awDrwShow .acc{border:1px solid #2b3f55;border-radius:8px;margin:0 0 6px;overflow:hidden}
#awDrwShow .acc>.ah{display:flex;align-items:center;gap:6px;width:100%;background:#13243a !important;border:none !important;border-radius:0 !important;
  font:600 13px "Meiryo",sans-serif;color:#fff;padding:9px 10px !important;min-height:40px;text-align:left}
#awDrwShow .acc>.ah .sm{margin-left:auto;font:400 11.5px "Meiryo",sans-serif;color:#8fd0ff;white-space:nowrap}
#awDrwShow .acc>.ah .ar{font-size:10px;color:#9fb3c8;transition:transform .15s}
#awDrwShow .acc.open>.ah .ar{transform:rotate(90deg)}
#awDrwShow .acc>.ab{padding:8px}
#awDrwShow .acc:not(.open)>.ab{display:none}
#awDrwShow [data-legsec] button{width:100%;text-align:left}
/* ---- 経路の引き出し：上に経路アドバイス、下に経路を作る ---- */
#awDrwRoute{padding:0 !important;display:flex;flex-direction:column}
#awDrwRoute #awRB,#awDrwRoute #awAdv{position:static !important;width:auto !important;max-width:none !important;max-height:none !important;
  left:auto !important;right:auto !important;top:auto !important;bottom:auto !important;border-radius:0 !important;overflow:visible !important;transform:none !important;opacity:1 !important;flex:none}
#awDrwRoute #awAdv{order:1;padding:8px 10px;font-size:12.5px;background:none}
#awDrwRoute .awGap{order:2;flex:1 1 auto;min-height:16px}
#awDrwRoute #awRB{order:3;border-left:none !important;border-top:1px solid #47617d;padding:8px 10px 40px;background:rgba(10,17,26,.6)}
#awDrwRoute .awStep{display:none}
#awDrwRoute button{white-space:normal}
#awDrwRoute #awAdv .row{gap:5px}
#awDrwRoute #awAdv label{flex:1 1 90px}
#awDrwRoute select,#awDrwRoute input,#awDrwRoute textarea{max-width:100%;min-width:0;box-sizing:border-box}
#awDrwRoute #awAdv label select{width:100%}
#awDrwRoute #awAdv button.go{flex:1 1 100%;min-height:36px}
#awDrwRoute #awAdv .tg{flex:1 1 40%}
/* ---- 天気図の引き出し（#awWx）：見本は小さめ・1 列。押すと地図に重ねる ---- */
#awWx{padding:8px 8px 40px !important;background:rgba(16,25,37,.97) !important;border-left:none !important;border-right:1px solid #2b3f55 !important;box-shadow:none !important}
#awWx h2{font-size:14px !important}
#awWx .awGrpSel{width:100%;margin:0 0 6px;background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:6px;font:12.5px "Meiryo",sans-serif;padding:6px 8px;min-height:34px}
#awWx .grp{margin:10px 0 4px !important}
#awWx .it{margin-bottom:12px !important;padding-bottom:8px;border-bottom:1px solid #1f3043}
#awWx .it .row{flex-direction:column !important;gap:5px !important}
#awWx .it .main{order:0;width:100%;position:relative}
#awWx .it .side{order:1;width:100% !important}
#awWx .it .side{flex-direction:row !important;flex-wrap:wrap;gap:4px !important}
#awWx .it .side button{width:auto !important;flex:1 1 auto;font-size:11.5px !important;padding:5px 7px !important;min-height:30px;text-align:center !important}
#awWx .it .side .sep{display:none}
#awWx .th{aspect-ratio:4/3;cursor:pointer;box-sizing:border-box;border:2px solid transparent;border-radius:6px}
#awWx .it .meta{cursor:pointer}
#awWx .meta{flex-direction:column;gap:0 !important}
#awWx .meta b{font-size:12px !important}
#awWx .it.awOn .th{border-color:#4fc3f7}
#awWx .it .awNum{display:none;position:absolute;left:5px;top:5px;z-index:2;min-width:20px;height:20px;border-radius:10px;background:#4fc3f7;color:#0b141e;
  font:700 12px/20px "Meiryo",sans-serif;text-align:center;padding:0 5px;box-sizing:border-box;pointer-events:none}
#awWx .it.awOn .awNum{display:block}
#awWx .awHideG{display:none !important}
/* 地図に重ねるのは図を押して行う。3D の切り替えは地図上部の「高度」で行う */
#awWx [data-ov],#awWx [data-combo],#awWx [data-liftmode],#awWx [data-xs3d],#awWx [data-fb3d]{display:none !important}
/* 重ねている図 */
#awStack{background:#0b1622;border:1px solid #2b3f55;border-radius:8px;padding:6px 7px;margin:0 0 8px}
#awStack .sh{font:600 11.5px "Meiryo",sans-serif;color:#8fd0ff;display:flex;justify-content:space-between;align-items:center}
#awStack .sh button{font:11px "Meiryo",sans-serif;color:#cfe3f5;background:none;border:1px solid #47617d;border-radius:5px;padding:2px 7px;cursor:pointer}
#awStack .awChips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
#awStack .awChips:empty::before{content:"図を押すと地図に重ねます。いくつでも重ねられます";font-size:11px;color:#9fb3c8}
#awStack .awChip{display:inline-flex;align-items:center;gap:4px;background:#1e3a5f;border:1px solid #4fc3f7;border-radius:6px;padding:2px 3px 2px 6px;font:11.5px "Meiryo",sans-serif;color:#fff}
#awStack .awChip b{font-weight:700;color:#4fc3f7}
#awStack .awChip button{background:none;border:none;color:#cfe3f5;font-size:13px;line-height:1;padding:2px 4px;cursor:pointer;min-height:0}
/* 図のない項目（数値予報・解析の線・国際悪天・海洋）：押すと重ねる／外す */
#awWx .awRow{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;text-align:left;background:#0f1c2b;border:1px solid #47617d;border-radius:6px;
  color:#fff;font:12.5px/1.35 "Meiryo",sans-serif;padding:7px 9px;min-height:36px;margin:0 0 5px;cursor:pointer;touch-action:manipulation}
#awWx .awRow:hover{border-color:#8fd0ff}
#awWx .awRow[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
#awWx .awRow .n{margin-left:auto;min-width:20px;height:20px;border-radius:10px;background:#4fc3f7;color:#0b141e;font:700 12px/20px "Meiryo",sans-serif;text-align:center;padding:0 5px;box-sizing:border-box}
#awWx .awRow[aria-pressed="false"] .n{display:none}
#awWx .awRow .ld{color:#ffd54f;font-size:11px}
#awWx .it.awRowIt{border-bottom:none;padding-bottom:0;margin-bottom:0 !important}
#awWx #awSeaSt,#awWx #awAnSt{font:11px/1.5 "Meiryo",sans-serif;color:#cfe3f5;margin:0 2px 8px}
#awWx #awSeaSt:empty,#awWx #awAnSt:empty{display:none}
/* GPV・国際悪天のパネル：「地図／3D」は天気図の引き出しと地図上部の「高度」で選ぶので出さない */
#awGpv h3+.row,#awSigwx h3+.row{display:none !important}
/* ---- 地図の上に残すもの ---- */
#legend{left:auto !important;right:8px !important;bottom:82px !important;z-index:31 !important;font-size:11.5px !important;line-height:1.75 !important;max-width:calc(100vw - var(--awL) - 30px)}
body:not(.awLegOn) #legend{display:none !important}
#titleBar{left:calc(var(--awL) + 8px) !important;top:8px !important;padding:5px 10px !important;transition:left .2s ease}
#titleBar h1{font-size:14px !important}
#titleBar .sub{font-size:10px !important;margin-top:1px !important}
/* 左に隠れる分だけ、地図の上のものを右へずらす */
.cesium-viewer-animationContainer{left:var(--awL) !important;transition:left .2s ease}
.cesium-viewer-timelineContainer{left:calc(var(--awL) + 169px) !important;transition:left .2s ease}
.cesium-viewer-bottom{left:calc(var(--awL) + 172px) !important}
/* 断面図：地図の右下に、地図の 4 分の 1 くらいの大きさで出す（3D がよく見えるように。2026-10-19）。「拡大」で大きくしたときは地図の幅いっぱい */
#awSec{left:auto !important;right:8px !important;transform:none !important;bottom:36px !important;min-width:0 !important;
  width:calc((100vw - var(--awL)) * 0.52) !important;height:44vh !important}
#awSec.big{left:calc(var(--awL) + 8px) !important;right:8px !important;width:auto !important;height:min(62vh,640px) !important}
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
function save(s) { try { localStorage.setItem(KEY, JSON.stringify({ grp: s.grp, acc: s.acc, view: s.view })); } catch { /* 覚えられなくても動く */ } }
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initLayout() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const $ = id => document.getElementById(id);
  const q = s => document.querySelector(s);
  const isPressed = el => !!el && (el.classList.contains('on') || el.getAttribute('aria-pressed') === 'true');
  const loading = el => !!el && /読み込み中|読込中/.test(el.textContent || '');
  const saved = load() || {};
  const S = {
    open: 'wx',                        // 出している引き出し（null＝どれも出さない）。開いたときはいつも「天気図」
    grp: saved.grp, view: saved.view || '全体',
    acc: saved.acc === undefined ? null : saved.acc,   // 表示の引き出しで最後に開いていた折りたたみ（最初はどれも閉じる）
    leg: false,
    apt: { dbAirport: true, wxStation: false },       // 最初は青丸空港だけ
    gpv: { map: false, d3: false }, sw: { map: false, d3: false },   // GPV・国際悪天：天気図の引き出し（地図）と「高度」（3D）
    order: [],                         // 重ねている図（重ねた順）
  };

  // ---- 画面に出さない元のボタンの置き場 ----
  const src = Object.assign(document.createElement('div'), { id: 'awSrc' });
  document.body.appendChild(src);
  const stash = el => { if (el && el.parentElement !== src) src.appendChild(el); };
  ['camButtons'].forEach(id => stash($(id)));

  // ---- アイコンの列 ----
  const rail = Object.assign(document.createElement('div'), { id: 'awRail' });
  rail.innerHTML = TABS.map(([k, t, tip]) => `<button data-tab="${k}" aria-pressed="false" title="${tip}">${ICON[k]}<span>${t}</span></button>`).join('');
  document.body.appendChild(rail);
  rail.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.open = S.open === b.dataset.tab ? null : b.dataset.tab; apply(); });

  // ---- 引き出し（経路・表示・設定。天気図は #awWx をそのまま使う） ----
  const mk = (id, html) => { const d = Object.assign(document.createElement('div'), { id, className: 'awDrw awOff' }); d.innerHTML = html; document.body.appendChild(d); return d; };
  const dRoute = mk('awDrwRoute', '<div class="awGap"></div>');
  const dShow = mk('awDrwShow', '<div class="awH">表示</div><div data-acc></div><div data-legsec><div class="awSec">凡例</div><button data-leg aria-pressed="false" title="地図の右下に凡例を出す・しまう">凡例を表示</button></div>');
  const dSet = mk('awDrwSet', '<div class="awH">設定</div><div class="awSec">データ</div><div data-slot="data"></div>');
  dSet.querySelector('[data-slot="data"]').appendChild($('aipBtn'));

  // =====================================================================
  //  視点・高度・地図の線（地図上部のプルダウンと、表示の引き出しの折りたたみで共通）
  // =====================================================================
  const click = sel => () => { const b = typeof sel === 'string' ? q(sel) : sel(); b?.click(); };
  // 視点：3×3 の盤（方角の並び）。押すとすぐ移動
  const VIEWS = [
    ['nw', '北西斜め', '北西から南東を斜めに見下ろす', '[data-view="nw"]'], ['n', '北から', '北から南を見る', '[data-view="n"]'], ['ne', '北東斜め', '北東から南西を斜めに見下ろす', '[data-view="ne"]'],
    ['w', '西から', '西から東を見る', '[data-view="w"]'], ['all', '全体', '日本全体を真上から', '[data-cam="all"]'], ['e', '東から', '東から西を見る', '[data-view="e"]'],
    ['sw', '南西斜め', '南西から北東を斜めに見下ろす', '[data-view="sw"]'], ['s', '南から', '南から北を見る', '[data-view="s"]'], ['se', '南東斜め', '南東から北西を斜めに見下ろす', '[data-view="se"]'],
  ];
  const EXAG = [[1, '実寸'], [25, '×25'], [50, '×50'], [75, '×75'], [100, '×100']];
  // チェックの項目：k（名前）、l（表示）、t（説明）、on()（今の状態）、set()（押したとき）、busy()（読み込み中）
  const btn = sel => () => q(sel);
  const ck = (k, l, t, el, extra = {}) => ({ k, l, t, on: () => isPressed(el()), set: () => el()?.click(), busy: () => loading(el()), dis: () => !el(), ...extra });
  // GPV・国際悪天：地図（天気図の引き出し）と 3D（高度）。両方選んだときは 3D だけ
  const PANEL = { gpv: ['awGpv', 'gpvBtn', 'aw:gpv'], sw: ['awSigwx', 'sigwxBtn', 'aw:sigwx'] };
  const panelOpen = k => { const p = $(PANEL[k][0]); return !!p && !p.hidden; };
  function syncPanel(k) {
    const f = S[k], want = f.map || f.d3, mode = f.d3 ? '3d' : 'map', p = $(PANEL[k][0]);
    if (want && !panelOpen(k)) $(PANEL[k][1])?.click();
    if (!want && panelOpen(k)) $(PANEL[k][1])?.click();
    if (want) { const m = p?.querySelector(`[data-m="${mode}"]`); if (m && m.getAttribute('aria-pressed') !== 'true') m.click(); }
    soon();
  }
  for (const k of Object.keys(PANEL)) window.addEventListener(PANEL[k][2], e => { if (!e.detail) { S[k].map = false; S[k].d3 = false; } soon(); });
  const panelCk = (k, which, kk, l, t) => ({ k: kk, l, t, on: () => panelOpen(k) && S[k][which], set: () => { S[k][which] = !(panelOpen(k) && S[k][which]); if (!panelOpen(k)) S[k][which === 'map' ? 'd3' : 'map'] = false; syncPanel(k); } });

  const ALT3D = [
    { h: '地形・空域' },
    ck('mtn', '山を強調', '標高2,000m以上の山を、高度の倍率に合わせて立体表示', () => $('mountainBtn')),
    ck('as3d', '空域を3D', '「地図の線」で選んだ空域を、AIP の下限〜上限の高さで立体表示', () => $('asSolid')),
    { h: '天気図の3D' },
    ck('up3d', '気圧面3D', '850〜200hPa の気圧面を、高層天気図の等高線から立体表示', btn('#upper3dBtns [data-u="on"]'),
      { subs: [['struct', '谷・尾根の構造'], ['mode', ''], ['wave', '']] }),
    ck('ct3d', '衛星の雲頂3D', 'ひまわり赤外の雲頂温度から雲頂の高さを求めて、雲を立体で表示', () => $('ct3dBtn')),
    ck('fb3d', '国内悪天3D（FBJP）', '国内悪天予想図のジェット気流・CAT・揺れのある雲を、読み取った高さで立体表示', btn('[data-fb3d]')),
    panelCk('sw', 'd3', 'sw3d', '国際悪天3D（SIGWX）', '国際悪天予想図（WAFS SIGWX）を、下限〜上限の高さで立体表示'),
    panelCk('gpv', 'd3', 'gpv3d', 'GPV 3D（全高度）', '数値予報（GPV）の6つの高さを、それぞれの高度に板として積み重ねる'),
    ck('ax3d', '断面図3D（AXJP）', '高層断面図（AXJP）を、地図の上に縦の壁として立てる', btn('[data-xs3d="axjp"]')),
    ck('fx3d', '断面図3D（FXJP）', '断面図（FXJP）を、地図の上に縦の壁として立てる', btn('[data-xs3d="fxjp"]')),
  ];
  const LINES = [
    { h: '線・目盛り' },
    ck('grid', '緯度経度線', '緯度・経度の線と目盛り。近づくほど細かくなる', () => $('gridBtn')),
    ck('var', 'Variation', '磁気偏差（偏角）の等偏角線。WMM2025 で今日の値を計算', () => $('varBtn')),
    ck('nav', '航法データ（航空路・Waypoint・VOR）', '航空路・Waypoint・VOR/DME・TACAN。記号や航空路をクリックすると詳細', () => $('navBtn'), { navLg: true }),
    { h: '空域' },
    { k: 'fir', l: 'FIR', t: 'FIR（飛行情報区）の境界。アジアの FIR と、AIP の福岡FIR・仁川FIR',
      on: () => /OFF/.test($('firBtn')?.textContent || '') || isPressed(q('[data-as="fir"]')),
      busy: () => loading(q('[data-as="fir"]')),
      set() { const want = !this.on(); if (/OFF/.test($('firBtn')?.textContent || '') !== want) $('firBtn')?.click(); if (isPressed(q('[data-as="fir"]')) !== want) q('[data-as="fir"]')?.click(); } },
    ck('sector', 'ACCセクター', '東京・福岡・神戸ACC と 仁川・大邱ACC のセクター。重なるので高さの帯を切り替えて見る', btn('[data-as="sector"]'), { band: true }),
    ck('cta', '管制区', '航空交通管制区（ENR 2.1）。韓国は TMA・管制圏', btn('[data-as="cta"]')),
    ck('restricted', '制限・警戒', '飛行制限区域・空域制限（ENR 5.1）', btn('[data-as="restricted"]')),
    ck('jsdf', '軍・自衛隊訓練', '自衛隊の訓練／試験空域・超音速飛行空域・回廊（ENR 5.2）。韓国の軍訓練空域', btn('[data-as="jsdf"]')),
    ck('civil', '民間訓練', '民間訓練試験空域（ENR 5.3）。韓国の CATA', btn('[data-as="civil"]')),
    ck('adiz', 'ADIZ', '防空識別圏（JADIZ・KADIZ）', btn('[data-as="adiz"]')),
    { h: '空港' },
    { k: 'aptDb', l: '青丸空港', t: '空港データベースの空港（青い丸・名前・滑走路）', on: () => S.apt.dbAirport, set: () => setApt('dbAirport') },
    { k: 'aptWx', l: '白丸空港（METAR・TAF）', t: 'METAR・TAF を出している空港（白い小さな丸）。クリックで METAR・TAF', on: () => S.apt.wxStation, set: () => setApt('wxStation') },
  ];
  function setApt(kind) { S.apt[kind] = !S.apt[kind]; window.awAirports?.setVisible(kind, S.apt[kind]); refresh(); }
  window.addEventListener('aw:airports-ready', () => { for (const k of Object.keys(S.apt)) window.awAirports?.setVisible(k, S.apt[k]); });
  if (window.awAirports) for (const k of Object.keys(S.apt)) window.awAirports.setVisible(k, S.apt[k]);

  const ckHtml = it => it.h ? `<div class="mh">${it.h}</div>`
    : `<button class="ck" data-k="${it.k}" role="menuitemcheckbox" aria-checked="false" title="${esc(it.t)}"><span class="bx"></span><span>${esc(it.l)} <span class="ld"></span></span></button>`
      + (it.subs ? `<div class="sub" data-subs="${it.k}">${it.subs.map(([u]) => `<button data-u2="${u}"></button>`).join('')}</div>` : '')
      + (it.band ? '<div class="sub"><button data-band title="ACCセクターの高さの帯を切り替え"></button></div>' : '')
      + (it.navLg ? '<div class="navLg" data-navlg hidden></div>' : '');
  const SECTIONS = {
    view: { title: '視点', html: () => `<div class="grid">${VIEWS.map(v => v ? `<button data-v="${v[0]}" title="${v[2]}">${v[1]}</button>` : '<span></span>').join('')}</div>` },
    alt: { title: '高度', html: () => `<div class="mh">高度の倍率</div><div class="seg">${EXAG.map(([s, l]) => `<button data-x="${s}" title="${s === 1 ? '高度を実寸（1倍）で表示' : `高度を${s}倍に強調して表示`}">${l}</button>`).join('')}</div>`
      + ALT3D.map(ckHtml).join('')
      + '<div class="mh">衛星画像の貼り方（3D のとき）</div><div class="seg"><button data-lift="lift" title="衛星の雲を雲頂の高さに持ち上げる（地表には本当の位置を薄く残す）">雲頂の高さ</button><button data-lift="ground" title="衛星の雲を地表に貼る">地表に貼る</button></div>' },
    lines: { title: '地図の線', html: () => LINES.map(ckHtml).join('') },
  };
  const ALL = [...ALT3D, ...LINES].filter(x => x.k);
  const byK = k => ALL.find(x => x.k === k);
  // 中身を作って、押したときの処理をつける（同じ中身を何か所に作ってもよい）
  function build(kind, box) {
    box.classList.add('awMenu'); box.dataset.menu = kind;
    box.innerHTML = SECTIONS[kind].html();
    box.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !box.contains(b)) return;
      if (b.dataset.v) { const v = VIEWS.find(x => x && x[0] === b.dataset.v); S.view = v[1]; save(S); click(v[3])(); closePops(); refresh(); return; }
      if (b.dataset.x) { q(`#exagGroup [data-exag="${b.dataset.x}"]`)?.click(); soon(); return; }
      if (b.dataset.lift) { const l = q('#awWx [data-liftmode]'); if (l && (l.getAttribute('aria-pressed') === 'true') !== (b.dataset.lift === 'lift')) l.click(); soon(); return; }
      if (b.dataset.u2) { q(`#upper3dBtns [data-u="${b.dataset.u2}"]`)?.click(); soon(); return; }
      if (b.hasAttribute('data-band')) { $('asBand')?.click(); soon(); return; }
      if (b.dataset.k) { byK(b.dataset.k)?.set(); soon(); }
    });
    return box;
  }
  const count = list => list.filter(x => x.k && x.on()).length;
  const summary = {
    view: () => S.view,
    alt: () => { const sc = window.awGetAltScale?.() ?? 1, n = count(ALT3D); return (sc === 1 ? '実寸' : `×${sc}`) + (n ? `・3D ${n}` : ''); },
    lines: () => { const n = count(LINES); return n ? String(n) : 'なし'; },
  };

  // ---- 地図上部のプルダウン ----
  const top = Object.assign(document.createElement('div'), { id: 'awTop' });
  top.innerHTML = Object.entries(SECTIONS).map(([k, s]) => `<div class="dd" data-dd="${k}"><button aria-expanded="false" aria-haspopup="true" title="${s.title}"><span class="tl">${s.title}</span> <span class="sv"></span><span class="cv">▼</span></button><div class="pop" hidden></div></div>`).join('');
  document.body.appendChild(top);
  top.querySelectorAll('.dd').forEach(dd => {
    const b = dd.querySelector(':scope>button'), pop = dd.querySelector('.pop');
    build(dd.dataset.dd, pop);
    b.onclick = e => { e.stopPropagation(); const open = pop.hidden; closePops(); pop.hidden = !open; b.setAttribute('aria-expanded', open); if (open) refresh(); };
  });
  function closePops() { top.querySelectorAll('.dd').forEach(dd => { dd.querySelector('.pop').hidden = true; dd.querySelector(':scope>button').setAttribute('aria-expanded', 'false'); }); }
  document.addEventListener('pointerdown', e => { if (!top.contains(e.target)) closePops(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePops(); });
  // 3D の説明（気圧面3D の凡例・雲頂3D の状態）は地図上部の下に出す
  const topSt = Object.assign(document.createElement('div'), { id: 'awTopSt' });
  document.body.appendChild(topSt);

  // ---- 表示の引き出し：折りたたみ（1 つ開くとほかは閉じる） ----
  const accBox = dShow.querySelector('[data-acc]');
  accBox.innerHTML = Object.entries(SECTIONS).map(([k, s]) => `<div class="acc" data-ac="${k}"><button class="ah" aria-expanded="false"><span class="ar">▶</span>${s.title}<span class="sm"></span></button><div class="ab"></div></div>`).join('');
  accBox.querySelectorAll('.acc').forEach(a => {
    build(a.dataset.ac, a.querySelector('.ab'));
    a.querySelector('.ah').onclick = () => { S.acc = S.acc === a.dataset.ac ? null : a.dataset.ac; save(S); syncAcc(); refresh(); };
  });
  function syncAcc() { accBox.querySelectorAll('.acc').forEach(a => { const o = a.dataset.ac === S.acc; a.classList.toggle('open', o); a.querySelector('.ah').setAttribute('aria-expanded', o); }); }
  syncAcc();

  // ---- 凡例（事例表示のときだけ使える。main.js がリアルタイム表示では隠す） ----
  const legSet = dShow.querySelector('[data-leg]'), lgEl = $('legend');
  legSet.onclick = () => { S.leg = !S.leg; apply(); };
  const syncLegAvail = () => { dShow.querySelector('[data-legsec]').style.display = lgEl && lgEl.style.display !== 'none' ? '' : 'none'; };
  if (lgEl) new MutationObserver(syncLegAvail).observe(lgEl, { attributes: true, attributeFilter: ['style'] });
  syncLegAvail();

  // =====================================================================
  //  天気図の引き出し：押すと重ねる・重ねている図の一覧
  // =====================================================================
  const SHORT = { sfc: '地上', sfc24: '地上24h', aupq78: 'AUPQ78', aupq35: 'AUPQ35', aupa25: 'AUPA25', aupa20: 'AUPA20',
    fxfe502: 'FXFE502', fxfe5782: 'FXFE5782', fxjp854: 'FXJP854', fupa252: 'FUPA252', fupa302: 'FUPA302', fupa502: 'FUPA502',
    axjp: 'AXJP', fxjp: 'FXJP', typhoon: '台風', fbjp: 'FBJP', vis: '可視', ir: '赤外', radar: 'レーダー', radarIntl: '海外レーダー' };
  // 図のない項目（数値予報・解析の線・国際悪天・海洋）
  const ROWS = [];             // { k, l, on(), set(), busy(), grp }
  function setupWx() {
    const P = $('awWx'); if (!P || P.dataset.awGrp) return;
    const dash = $('awWxDash');
    if (!P.querySelector('.it') || !dash) return;
    P.dataset.awGrp = '1';
    stash(dash);                                       // 元の「気象」のボタン（ここから押す）
    for (const id of ['upper3dSt', 'ct3dSt']) { const e = $(id); if (e) topSt.appendChild(e); }
    // 図のない項目を、種類ごとに一覧の後ろ（国際悪天は FBJP の後ろ）に足す
    const anBtns = [...dash.querySelectorAll('[data-an]')], seaBtns = [...dash.querySelectorAll('[data-sea]')];
    const rowCk = (k, l, t, el) => ({ k, l, t, on: () => isPressed(el()), set: () => el()?.click(), busy: () => loading(el()) || !!el()?.disabled });
    const swRow = { ...panelCk('sw', 'map', 'w:sw', '国際悪天予想図（SIGWX）', '国際悪天予想図（WAFS SIGWX：積乱雲・乱気流・着氷・ジェット気流・圏界面）を地図に重ねる'), busy: () => false };
    const gpvRow = { ...panelCk('gpv', 'map', 'w:gpv', 'GPV（風・気温・湿り・雲量・降水量）', '数値予報（GPV）の選んだ高さを地図に重ねる。高さ・要素はパネルで選ぶ'), busy: () => false };
    const anRows = anBtns.map(b => rowCk(`w:an:${b.dataset.an}`, b.textContent.trim(), b.title, () => b));
    const seaRows = seaBtns.map(b => rowCk(`w:sea:${b.dataset.sea}`, b.dataset.sea === 'sst' ? '海面水温' : '海流', b.title, () => b));
    ROWS.push(swRow, gpvRow, ...anRows, ...seaRows);
    const rowHtml = r => `<button class="awRow" data-row="${r.k}" aria-pressed="false" title="${esc(r.t)}"><span>${esc(r.l)} <span class="ld"></span></span><span class="n"></span></button>`;
    const grpEl = g => Object.assign(document.createElement('div'), { className: 'grp', textContent: g });
    const itEl = (rows, extra = '') => { const d = document.createElement('div'); d.className = 'it awRowIt'; d.innerHTML = rows.map(rowHtml).join('') + extra; return d; };
    const fb = P.querySelector('.it[data-id="fbjp"]');
    if (fb) fb.after(itEl([swRow]));
    P.append(grpEl('数値予報・解析'), itEl([gpvRow, ...anRows]));
    const anSt = $('awAnSt'); if (anSt) P.lastElementChild.appendChild(anSt);
    P.append(grpEl('海洋'), itEl(seaRows));
    const seaSt = $('awSeaSt'); if (seaSt) P.lastElementChild.appendChild(seaSt);
    P.addEventListener('click', e => {
      const b = e.target.closest('[data-row]'); if (!b) return;
      ROWS.find(r => r.k === b.dataset.row)?.set(); soon();
    });
    // 図の番号（重ねた順）を出す場所
    P.querySelectorAll('.it[data-id] .main').forEach(m => m.insertAdjacentHTML('afterbegin', '<span class="awNum"></span>'));
    // 一番上：重ねている図
    const stack = Object.assign(document.createElement('div'), { id: 'awStack' });
    stack.innerHTML = '<div class="sh"><span>重ねている図（<span data-sn>0</span>）</span><button data-clear title="重ねている図をすべて外す">すべて外す</button></div><div class="awChips"></div>';
    stack.addEventListener('click', e => {
      const x = e.target.closest('[data-off]'); if (x) { offKey(x.dataset.off); soon(); return; }
      if (e.target.closest('[data-clear]')) { [...S.order].forEach(offKey); soon(); }
    });
    // 種類で絞り込む（すべて／地上／高層…）
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
    ($('awWxU') || P.querySelector('h2')).after(stack, sel);
    filt();
    P.classList.toggle('awOff', S.open !== 'wx');
    refresh();
  }
  // 重ねているもの：天気図（chartsPanel.js）＋図のない項目
  function activeKeys() {
    const c = (window.awCharts?.active?.() || []).map(id => `c:${id}`);
    return [...c, ...ROWS.filter(r => r.on()).map(r => r.k)];
  }
  const labelOf = k => k.startsWith('c:') ? (SHORT[k.slice(2)] || k.slice(2)) : (ROWS.find(r => r.k === k)?.l.replace(/（.*$/, '') || k);
  function offKey(k) {
    if (k.startsWith('c:')) { window.awCharts?.off?.(k.slice(2)); return; }
    const r = ROWS.find(x => x.k === k); if (r?.on()) r.set();
  }

  // ---- 経路の 2 つのパネル（advisor.js・routeBuilder.js が後から作る） ----
  function moveRoute() {
    const rb = $('awRB'), adv = $('awAdv');
    if (adv && adv.parentElement !== dRoute) dRoute.prepend(adv);
    if (rb && rb.parentElement !== dRoute) dRoute.appendChild(rb);
  }
  function adopt() { moveRoute(); setupWx(); stash($('camButtons')); }

  // =====================================================================
  //  表示を今の状態に合わせる（プルダウン・折りたたみ・天気図の引き出し）
  // =====================================================================
  let rq = 0;
  function soon() { cancelAnimationFrame(rq); rq = requestAnimationFrame(refresh); clearTimeout(soon.t); soon.t = setTimeout(refresh, 600); }
  function refresh() {
    if (!VIEWS.some(v => v[1] === S.view)) S.view = '全体';     // 前に選んだ視点がなくなったとき（衛星視点など）
    // チェックの項目
    document.querySelectorAll('.awMenu [data-k]').forEach(b => {
      const it = byK(b.dataset.k); if (!it) return;
      b.setAttribute('aria-checked', !!it.on());
      const ld = b.querySelector('.ld'); if (ld) ld.textContent = it.busy?.() ? '読み込み中…' : '';
      b.disabled = !!it.dis?.();
    });
    // 視点・倍率・貼り方
    const sc = window.awGetAltScale?.() ?? 1;
    document.querySelectorAll('.awMenu [data-v]').forEach(b => b.setAttribute('aria-pressed', VIEWS.find(x => x && x[0] === b.dataset.v)?.[1] === S.view));
    document.querySelectorAll('.awMenu [data-x]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.x === sc));
    const lm = q('#awWx [data-liftmode]'), lift = !lm || lm.getAttribute('aria-pressed') === 'true';
    document.querySelectorAll('.awMenu [data-lift]').forEach(b => b.setAttribute('aria-pressed', (b.dataset.lift === 'lift') === lift));
    // 気圧面3D の細かい設定（谷・尾根の構造・波だけ・起伏）：元のボタンの文字と状態をそのまま
    document.querySelectorAll('.awMenu [data-u2]').forEach(b => {
      const s0 = q(`#upper3dBtns [data-u="${b.dataset.u2}"]`);
      b.textContent = s0?.textContent.trim() || ''; b.disabled = !s0 || s0.disabled; b.setAttribute('aria-pressed', isPressed(s0));
      b.title = s0?.title || '';
    });
    document.querySelectorAll('.awMenu [data-subs]').forEach(d => { d.hidden = !byK(d.dataset.subs)?.on(); });
    document.querySelectorAll('.awMenu [data-band]').forEach(b => { const s0 = $('asBand'); b.textContent = s0?.textContent || ''; b.disabled = !s0 || s0.disabled; b.parentElement.hidden = !byK('sector').on(); });
    document.querySelectorAll('.awMenu [data-navlg]').forEach(d => { const on = byK('nav').on(), lg = $('navLegend'); d.hidden = !on; if (on && lg && d.dataset.done !== '1') { d.innerHTML = lg.innerHTML; d.dataset.done = '1'; } });
    // 見出しの短い状態
    top.querySelectorAll('.dd').forEach(dd => { dd.querySelector('.sv').textContent = dd.dataset.dd === 'view' ? `：${summary.view()}` : summary[dd.dataset.dd](); });
    accBox.querySelectorAll('.acc').forEach(a => { a.querySelector('.sm').textContent = summary[a.dataset.ac](); });
    // 天気図の引き出し：重ねている図（重ねた順の番号）
    const act = activeKeys();
    S.order = S.order.filter(k => act.includes(k)); for (const k of act) if (!S.order.includes(k)) S.order.push(k);
    const num = k => S.order.indexOf(k) + 1;
    const P = $('awWx');
    if (P) {
      P.querySelectorAll('.it[data-id]').forEach(it => {
        const k = `c:${it.dataset.id}`, n = num(k);
        it.classList.toggle('awOn', n > 0);
        const e = it.querySelector('.awNum'); if (e) e.textContent = n || '';
      });
      P.querySelectorAll('[data-row]').forEach(b => {
        const r = ROWS.find(x => x.k === b.dataset.row); if (!r) return;
        const on = !!r.on(); b.setAttribute('aria-pressed', on);
        b.querySelector('.n').textContent = on ? num(r.k) : '';
        b.querySelector('.ld').textContent = r.busy?.() ? '読み込み中…' : '';
      });
      const stk = $('awStack');
      if (stk) {
        stk.querySelector('[data-sn]').textContent = S.order.length;
        stk.querySelector('[data-clear]').hidden = !S.order.length;
        const html = S.order.map((k, i) => `<span class="awChip"><b>${i + 1}</b>${esc(labelOf(k))}<button data-off="${k}" aria-label="${esc(labelOf(k))}を外す" title="外す">×</button></span>`).join('');
        const ch = stk.querySelector(".awChips"); if (ch.dataset.h !== html) { ch.innerHTML = html; ch.dataset.h = html; }
      }
    }
    // 設定の AIP 取込・凡例
    legSet.setAttribute('aria-pressed', !!S.leg); legSet.textContent = S.leg ? '凡例をしまう' : '凡例を表示';
  }
  for (const ev of ['aw:altscale', 'aw:chartsel', 'aw:mountains', 'aw:clouds', 'aw:ct3d', 'aw:gpv', 'aw:sigwx', 'aw:charts-ready', 'aw:airports-ready'])
    window.addEventListener(ev, () => setTimeout(soon, 0));
  // 元のボタンの文字・状態が変わったら（読み込み中→表示中など）合わせる
  new MutationObserver(soon).observe(src, { subtree: true, attributes: true, characterData: true, childList: true, attributeFilter: ['class', 'aria-pressed', 'disabled'] });

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
    save(S);
    refresh();
    window.dispatchEvent(new CustomEvent('aw:layout', { detail: { open: S.open } }));
  }
  // パネルは後から作られるので、しばらくの間はできたら移す
  const iv = setInterval(adopt, 500);
  setTimeout(() => clearInterval(iv), 60e3);
  window.addEventListener('aw:charts-ready', () => setTimeout(() => { adopt(); refresh(); }, 0));
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
    refresh,
  };
}
