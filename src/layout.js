// 画面の割り付け（iPad など小さい画面向け。2026-10-18）
//   ・左のパネル（揺れ回避 経路アドバイス ＋ 経路を作る）と右のパネル（天気図・画像）を、画面の端のつまみ（タブ）で
//     しまう・出す。しまった状態はブラウザに覚えておく
//   ・右下のボタン群と、天気図の一覧の上にあったボタン（衛星・レーダー〜解析3D）を 1 つの「操作パネル」にまとめ、
//     「⚙ 操作パネル」でたためる（2026-10-18 夜）
//   ・幅 1,300px 未満（iPad 11 インチの横向き 1,194px など）は、パネルを少し細くし、初めて開いたときは右のパネルをしまっておく
//   ・幅 1,000px 未満（iPad の縦向きなど）は、左右のパネルを同時には出さない（片方を出すと、もう片方をしまう）
//   ・幅 1,300px 未満では、右のパネルと操作パネルも同時には出さない（どちらも右下にかかるため）。初めは操作パネルをたたんでおく
const KEY = 'aw.layout.v2';
const NARROW = 1300, VERY_NARROW = 1000;

const CSS = `
@media (max-width:${NARROW - 1}px){
  #awAdv{width:300px !important;font-size:12.5px}
  #awRB{width:300px !important}
  #awWx{width:330px !important}
  #camButtons button{padding:6px 8px !important;font-size:11.5px !important}
}
#awAdv,#awRB,#awWx{transition:transform .25s ease,opacity .25s ease}
body.awHideL #awAdv,body.awHideL #awRB{transform:translateX(calc(-100% - 24px));opacity:0;pointer-events:none}
body.awHideR #awWx{transform:translateX(calc(100% + 24px));opacity:0;pointer-events:none}
.awTab{position:absolute;top:50%;z-index:30;transform:translateY(-50%);writing-mode:vertical-rl;text-orientation:upright;
  font:600 12px "Meiryo",sans-serif;color:#fff;background:rgba(20,30,45,.92);border:1px solid #8fd0ff;padding:10px 5px;cursor:pointer;
  letter-spacing:2px;box-shadow:0 0 6px rgba(0,0,0,.5);transition:left .25s ease,right .25s ease;touch-action:manipulation}
.awTab:hover{background:#1e3a5f}
#awTabL{left:0;border-left:none;border-radius:0 8px 8px 0;border-color:#00e676}
#awTabR{right:0;border-right:none;border-radius:8px 0 0 8px;border-color:#4fc3f7}
#awCamFold{align-self:flex-end;font-weight:600 !important;border-color:#ffd54f !important}
#camButtons{background:rgba(12,20,30,.9);border:1px solid #2b3f55;border-radius:8px;padding:6px 8px;
  max-height:calc(100vh - 110px);overflow-y:auto;overflow-x:hidden;max-width:min(700px,calc(100vw - 20px));box-sizing:border-box}
body.awHideCam #camButtons{background:none;border:none;padding:0;overflow:visible}
body.awHideCam #camButtons .btnRow:not(#awCamFoldRow),body.awHideCam #camButtons #awWxDash{display:none !important}
#camButtons .btnRow{flex-wrap:wrap;justify-content:flex-end}
#camButtons #awWxDash{position:static;margin:0 0 4px;padding:2px 0 6px;background:none;border-bottom:1px solid #2b3f55;align-self:stretch;max-width:none}
#camButtons #awWxDash .dr{justify-content:flex-end}
#camButtons #awWxDash .dl{text-align:right;color:#8fd0ff}
`;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 覚えられなくても動く */ } }

export function initLayout() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const narrow = () => window.innerWidth < NARROW, veryNarrow = () => window.innerWidth < VERY_NARROW;
  const S = load() || { L: true, R: !narrow(), cam: !narrow() };   // true＝出す
  if (veryNarrow() && S.L && S.R) S.R = false;
  if (narrow() && S.R && S.cam) S.cam = false;

  const tabL = document.createElement('button'); tabL.id = 'awTabL'; tabL.className = 'awTab';
  const tabR = document.createElement('button'); tabR.id = 'awTabR'; tabR.className = 'awTab';
  document.body.append(tabL, tabR);

  // 右下のボタン群のたたむボタン
  const cam = document.getElementById('camButtons');
  let fold = null;
  if (cam) {
    const row = document.createElement('div'); row.className = 'btnRow'; row.id = 'awCamFoldRow';
    fold = document.createElement('button'); fold.id = 'awCamFold';
    row.appendChild(fold); cam.prepend(row);
    fold.onclick = () => { S.cam = !S.cam; if (S.cam && narrow()) S.R = false; apply(); };
  }
  // 天気図の一覧の上のボタン（awWxDash。chartsPanel.js が作る）を操作パネルに移す（できるまで待つ）
  function moveDash() {
    const d = document.getElementById('awWxDash'), frow = document.getElementById('awCamFoldRow');
    if (d && cam && frow && d.parentElement !== cam) {
      cam.insertBefore(d, frow.nextSibling);
      // 「天気図」の段（地上・AUPQ・レーダー・海外レーダーなど。右の一覧と同じなので隠していた）も、操作パネルでは出す
      const cr = document.getElementById('chartBtns')?.closest('.btnRow');
      if (cr) { cr.style.display = ''; d.after(cr); }
      window.dispatchEvent(new Event('resize'));
    }
  }

  // つまみの位置：パネルが出ているときはパネルのすぐ外側、しまっているときは画面の端
  function place() {
    moveDash();
    const adv = document.getElementById('awAdv'), wx = document.getElementById('awWx');
    tabL.style.display = adv ? '' : 'none'; tabR.style.display = wx ? '' : 'none';
    // offsetLeft・offsetWidth は動き（transform）の途中でも変わらないので、動きが終わるのを待たずに正しい位置になる
    tabL.style.left = S.L && adv ? `${adv.offsetLeft + adv.offsetWidth + 2}px` : '0px';
    tabR.style.right = S.R && wx ? `${window.innerWidth - wx.offsetLeft + 2}px` : '0px';
  }
  function apply() {
    document.body.classList.toggle('awHideL', !S.L);
    document.body.classList.toggle('awHideR', !S.R);
    document.body.classList.toggle('awHideCam', !S.cam);
    tabL.textContent = S.L ? '◀ しまう' : '▶ 経路';
    tabL.title = S.L ? '左のパネル（経路アドバイス・経路を作る）をしまう' : '左のパネル（経路アドバイス・経路を作る）を出す';
    tabR.textContent = S.R ? 'しまう ▶' : '天気図 ◀';
    tabR.title = S.R ? '右のパネル（天気図・画像）をしまう' : '右のパネル（天気図・画像）を出す';
    if (fold) { fold.textContent = S.cam ? '⚙ 操作パネル ▼' : '⚙ 操作パネル ▲'; fold.title = S.cam ? '操作パネル（視点・レイヤ・衛星・レーダー・数値予報・解析3D など）をたたむ' : '操作パネル（視点・レイヤ・衛星・レーダー・数値予報・解析3D など）を出す'; }
    save(S);
    // 動きが終わってから位置を合わせる
    place(); setTimeout(place, 300); setTimeout(place, 700);
  }
  tabL.onclick = () => { S.L = !S.L; if (S.L && veryNarrow()) S.R = false; apply(); };
  tabR.onclick = () => { S.R = !S.R; if (S.R && veryNarrow()) S.L = false; if (S.R && narrow()) S.cam = false; apply(); };
  let rz = 0;
  window.addEventListener('resize', e => {
    if (!e.isTrusted) return;                              // moveDash が出した resize は無視（繰り返さないように）
    clearTimeout(rz); rz = setTimeout(() => { if (veryNarrow() && S.L && S.R) S.R = false; if (narrow() && S.R && S.cam) S.cam = false; apply(); }, 150);
  });
  // パネルは後から作られる（天気図の一覧は読み込みの後）ので、できたら位置を合わせ直す
  // パネルの動き（しまう・出す）が終わったら位置を合わせる
  document.addEventListener('transitionend', e => { if (e.target?.id === 'awAdv' || e.target?.id === 'awWx') place(); });
  const iv = setInterval(place, 1000);
  setTimeout(() => clearInterval(iv), 30e3);
  apply();
  // ほかの所から使う（例：経路を評価したら左のパネルを出す）
  window.awLayout = { show(side) { if (side === 'L') { S.L = true; if (veryNarrow()) S.R = false; } else { S.R = true; if (veryNarrow()) S.L = false; } apply(); } };
}
