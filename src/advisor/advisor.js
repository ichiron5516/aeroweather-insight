// 揺れ回避 経路アドバイザー（AeroWeather Insight 用）
//   main.js から  initAdvisor(viewer)  を呼ぶと、画面左に「経路アドバイス」ボタンとパネルを追加する。
//   リアルタイムの高層風（晴天乱気流指数）・レーダーエコー・SIGMET で登録経路を採点し、
//   揺れの少ない Route と巡航高度を推奨して 3D 表示する。
import { loadAirportDb, loadNavDb } from '../dbLoader.js';
import * as Cesium from 'cesium';
import { createAeroNav } from './aeroNavCore.js';
import { computeTI, tiClass } from './turbulence.js';
import { fetchUpperGrid, fetchRadar, fetchSigmets, latestHimawari, latestWeatherMaps, FBJP_URL, fmtJmaTime } from './wxSources.js';
import { rankRoutes, adviceText, hazardText, routeConditions, levelPlanText, densify, fullRouteArgs, manualPlan, planContext, rescore } from './scoring.js';
import { initAirportsLayer } from '../airportsLayer.js';
import { createRouteBuilder } from './routeBuilder.js';
import { initChartsPanel } from '../wxPanels/chartsPanel.js';
import { analyzeCloudTops, fromAdvisorRadar } from './cbDetect.js';
import { topAltFt, cellLatLon } from './cbCore.js';
import { profileField, BOX } from '../wxPanels/cloudTop3D.js';
import { fetchForecastCharts, forecastBands, bandsAt } from './fcstCharts.js';
import { createRouteSection } from './routeSection.js';
import { saveBriefing } from './briefingExport.js';
import { createSavedPanel } from './savedBriefings.js';
import { decodeState } from './stateCodec.js';
import { createSavedView } from './savedView.js';
import { flightPerf, perfText, hm, yenText, FUEL_YEN_PER_L } from './aircraftPerf.js';
// A321XLR で運航した場合の飛行時間・燃料・CO2（経路の高度計画ごとに一度だけ計算して覚える。2026-10-18）
const perfMemo = new WeakMap();
const perfOf = r => {
  const b = r?.best; if (!b?.prof) return null;
  if (!perfMemo.has(b)) { let p = null; try { p = flightPerf(b.prof, 'A321XLR'); } catch (e) { console.warn('[advisor] perf', e); } perfMemo.set(b, p); }
  return perfMemo.get(b);
};
const n0 = v => Math.round(v).toLocaleString('en-US');

/**
 * 雨域の雲頂の高さ（ft）を調べる関数を作る。地点の周り rNM 以内で 10mm/h 以上の降水があるマスのうち、一番高い雲頂。
 *   雲頂が分からない・該当するマスがない → null（高さで避けられるか不明）
 *   雨は強いが雲頂が暖かい（低い雲）→ 10000ft とみなす
 */
/**
 * 経路の周り（左右約5NM）の一番高い地形から、巡航してよい最低高度（ft）を求める関数を作る。
 *   地形は Cesium World Terrain を約2NM間隔で読む。最低高度 = 最高標高 + 2,000ft（3,000ft未満の所は +1,000ft）
 */
const TG = 0.04;                                    // 地形を読む格子（度）
async function terrainFinder(viewer, routes) {
  const tp = viewer.terrainProvider;
  if (!tp || tp instanceof Cesium.EllipsoidTerrainProvider) return null;
  const keys = new Set();
  for (const pts of routes) for (const q of densify(pts, 5))
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++)
      keys.add(`${Math.round(q.lat / TG) + di},${Math.round(q.lon / TG) + dj}`);
  const list = [...keys].map(k => k.split(',').map(Number));
  const carts = list.map(([i, j]) => Cesium.Cartographic.fromDegrees(j * TG, i * TG));
  await Cesium.sampleTerrain(tp, 9, carts);
  const H = new Map(list.map(([i, j], n) => [`${i},${j}`, Math.max(0, carts[n].height || 0)]));
  const fn = (lat, lon) => {
    const i0 = Math.round(lat / TG), j0 = Math.round(lon / TG);
    let mx = 0;
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) mx = Math.max(mx, H.get(`${i0 + di},${j0 + dj}`) ?? 0);
    const ft = mx * 3.28084;
    return Math.ceil((ft + (ft >= 3000 ? 2000 : 1000)) / 100) * 100;
  };
  // 断面図用：地点の真下の標高（ft）。周り（±1マス）の一番高い所
  fn.elevFt = (lat, lon) => {
    const i0 = Math.round(lat / TG), j0 = Math.round(lon / TG);
    let mx = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) mx = Math.max(mx, H.get(`${i0 + di},${j0 + dj}`) ?? 0);
    return mx * 3.28084;
  };
  return fn;
}

async function convTopFinder(grid) {
  const profAt = await profileField(BOX);
  const cells = [];
  for (let k = 0; k < grid.W * grid.H; k++) {
    if (grid.mx[k] < 10) continue;
    const { lat, lon } = cellLatLon(grid, k), tb = grid.tb[k];
    const top = isFinite(tb) ? (topAltFt(profAt(lat, lon), tb) ?? 10000) : null;
    cells.push({ lat, lon, top });
  }
  return (lat, lon, rNM = 10) => {
    const c = Math.cos(lat * Math.PI / 180), r = (rNM + 4) / 60;     // マスの大きさ（約10km）の分だけ広めに
    let mx = 0;
    for (const q of cells) {
      if (Math.abs(q.lat - lat) > r || Math.abs(q.lon - lon) * c > r) continue;
      if (Math.hypot(q.lat - lat, (q.lon - lon) * c) > r) continue;
      if (q.top == null) return null;
      mx = Math.max(mx, q.top);
    }
    return mx || null;                                              // 見つからなければ不明扱い
  };
}

// 初期画面：北海道〜沖縄（先島諸島まで）を真上から
export const JAPAN_RECT = Cesium.Rectangle.fromDegrees(122.5, 23.8, 146.5, 45.8);

const CSS = `
#awAdv{position:absolute;top:80px;left:10px;bottom:150px;z-index:22;width:340px;max-width:calc(100vw - 20px);overflow:auto;
  background:rgba(20,30,45,.95);color:#fff;font:13px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:12px 14px;border-left:4px solid #00e676}
#awAdv h2{font-size:15px;margin:0 0 8px}
#awAdv h3{font-size:12px;margin:12px 0 4px;color:#8fd0ff;font-weight:600}
#awAdv .row{display:flex;gap:6px;flex-wrap:wrap;align-items:end}
#awAdv label{display:flex;flex-direction:column;font-size:11px;color:#9fb3c8;gap:2px;flex:1 1 80px}
#awAdv select,#awAdv button{font:inherit;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:4px 6px}
#awAdv button{cursor:pointer}
#awAdv button.save{font-weight:600;padding:6px 12px;border-color:#8fd0ff}
#awAdv button.save:disabled{opacity:.45;cursor:default}
#awAdv button.go{background:#00a152;border-color:#00e676;font-weight:600;padding:6px 14px}
#awAdv button.tg[aria-pressed="true"]{background:#1e3a5f;border-color:#8fd0ff}
#awAdv .x{float:right;background:none;border:none;color:#aaa;font-size:16px;cursor:pointer}
#awAdv .st{font-size:11px;color:#9fb3c8;display:grid;grid-template-columns:auto 1fr;gap:1px 8px}
#awAdv .st .ok{color:#69f0ae}#awAdv .st .ng{color:#ff8a80}#awAdv .st .wait{color:#ffd54f}
#awAdv .advice{white-space:pre-wrap;background:rgba(0,230,118,.08);border:1px solid rgba(0,230,118,.4);border-radius:6px;padding:8px;font-size:12.5px}
#awAdv ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
#awAdv li{border:1px solid #2b3f55;border-radius:6px;padding:6px 8px;cursor:pointer}
#awAdv li[aria-current="true"]{border-color:#00e676;background:rgba(0,230,118,.07)}
#awAdv li .top{display:flex;gap:8px;align-items:baseline;justify-content:space-between}
#awAdv li .rt{font:12px ui-monospace,Menlo,monospace;color:#cfe3f5;word-break:break-word}
#awAdv .b{display:inline-block;border-radius:9px;padding:0 8px;font-size:11px;font-weight:600;white-space:nowrap}
#awAdv .good{background:#2e7d32}#awAdv .caution{background:#b58900}#awAdv .avoid{background:#c62828}
#awAdv .hz{font-size:11.5px;color:#ffcc80;margin-top:2px}
#awAdv .pf{font-size:11.5px;color:#b2dfdb;margin-top:2px}
#awAdv .charts{display:flex;gap:6px;flex-wrap:wrap}
#awAdv .charts a{flex:1 1 150px;color:#8fd0ff;font-size:11px;text-decoration:none}
#awAdv .charts img{width:100%;border-radius:4px;background:#fff;display:block}
#awAdv .note{font-size:10.5px;color:#9fb3c8;margin-top:10px}
#awAdv li .nm{font:700 15px ui-monospace,Menlo,monospace;color:#fff;white-space:nowrap}
#awAdv li .sub{display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:11.5px;color:#9fb3c8;margin-top:1px}
#awAdv li{user-select:none;-webkit-user-select:none}
#awAdv .hint{font-size:10.5px;color:#9fb3c8;font-weight:400}
`;

// SIGMET の説明（箱をクリックしたときの札）
const SG_HAZ = { TS: '雷雨（積乱雲）', TSGR: '雷雨（ひょうを伴う）', TURB: '乱気流', MTW: '山岳波', ICE: '着氷', VA: '火山灰', TC: '台風（熱帯低気圧）', DS: '砂じん嵐', SS: '砂じん嵐', RDOACT: '放射性物質' };
const SG_QUAL = { EMBD: '雲に埋もれた（EMBD）', OBSC: '見えにくい（OBSC）', FRQ: '頻繁（FRQ）', SQL: 'スコールライン（SQL）', ISOL: '孤立した（ISOL）', OCNL: '時々（OCNL）', SEV: '強い（SEV）', MOD: '並（MOD）', HVY: '強い（HVY）' };
const escH = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function sigmetHtml(g) {
  const fl = ft => (ft <= 0 ? 'SFC' : 'FL' + String(Math.round(ft / 100)).padStart(3, '0'));
  const hhmm = d => (d ? `${String(d.getUTCDate()).padStart(2, '0')}日 ${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z` : '');
  const haz = SG_HAZ[g.hazard] || g.hazard || '不明';
  const qual = String(g.qualifier || '').split(/\s+/).filter(Boolean).map(q => SG_QUAL[q] || q).join('・');
  return [`<b style="color:#ea80fc;font-size:13.5px">SIGMET　${escH(haz)}</b>`,
    qual && `程度：${escH(qual)}`,
    `高度：${fl(g.baseFt)} 〜 ${g.topKnown === false ? '上限不明' : fl(g.topFt)}`,
    (g.from || g.to) && `有効：${hhmm(g.from)} 〜 ${hhmm(g.to)}`,
    g.fir && `FIR：${escH(g.fir)}`,
    g.raw && `<pre style="white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.35);padding:5px 6px;border-radius:4px;font:11px ui-monospace,Menlo,monospace;margin:4px 0 0">${escH(g.raw)}</pre>`,
  ].filter(Boolean).join('<br>');
}
const RISK_COL = { null: null, LGT: '#ffee58', MOD: '#ffa726', SEV: '#ef5350' };
const LEVEL_JA = { good: '揺れ小', caution: '揺れ注意', avoid: '揺れ大' };

// 開いたときの地図：日本の地上天気図（気象庁。chartOverlay.js の PROJ.sfc）の枠が、左の引き出しの右側にちょうど収まる大きさ（2026-10-19）
//   天気図の枠の周り（四隅と各辺の途中）の緯度経度。ポーラーステレオ図法の枠を、東経140度の真上から見下ろして合わせる
const SFC_FRAME = [[90.18, 44.88], [106.16, 54.23], [131.1, 59.65], [159.66, 58.23], [181.06, 50.87], [170.46, 40.54], [163.93, 30.16],
  [159.62, 20.38], [156.58, 11.43], [146.96, 13.4], [136.94, 13.73], [127.09, 12.38], [117.96, 9.55], [114.15, 17.9], [108.89, 26.87], [101.36, 36.11]];
function startView(viewer) {
  const cam = viewer.camera, sc = viewer.scene;
  const W = viewer.canvas.clientWidth || window.innerWidth, H = viewer.canvas.clientHeight || window.innerHeight;
  const L = Math.min(W * 0.6, window.awLayout?.insets?.().left || 0);
  const box = { x0: L + 6, x1: W - 6, y0: 6, y1: H - 34 };          // 下は時刻の帯の分をあける
  const pts = SFC_FRAME.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la));
  cam.setView({ destination: Cesium.Cartesian3.fromDegrees(140, 36, 9.0e6), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  for (let it = 0; it < 12; it++) {
    const ws = pts.map(p => Cesium.SceneTransforms.worldToWindowCoordinates(sc, p));
    const h = cam.positionCartographic.height;
    if (ws.some(w => !w)) { cam.moveBackward(h * 0.3); continue; }
    const xs = ws.map(w => w.x), ys = ws.map(w => w.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const f = Math.max((bx1 - bx0) / (box.x1 - box.x0), (by1 - by0) / (box.y1 - box.y0));
    const mpp = 2 * h * Math.tan(cam.frustum.fovy / 2) / H;                   // 1px あたりの距離（地面の近くでおおよそ）
    const dx = (bx0 + bx1) / 2 - (box.x0 + box.x1) / 2, dy = (by0 + by1) / 2 - (box.y0 + box.y1) / 2;
    if (Math.abs(dx) > 1) cam.moveRight(dx * mpp);
    if (Math.abs(dy) > 1) cam.moveDown(dy * mpp);
    if (Math.abs(f - 1) > 0.005) cam.moveBackward(h * (f - 1));
    if (Math.abs(f - 1) < 0.005 && Math.abs(dx) < 2 && Math.abs(dy) < 2) break;
  }
}

export async function initAdvisor(viewer, { dataBase = `${import.meta.env.BASE_URL}data/nav/` } = {}) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  // main.js の初期カメラより後に適用する。開いたときは日本の地上天気図の枠が、左の引き出しに隠れない範囲にちょうど収まるようにする（2026-10-19）
  setTimeout(() => { try { startView(viewer); } catch (e) { console.warn('[advisor] startView', e); viewer.camera.setView({ destination: JAPAN_RECT }); } }, 0);

  // 空港データベースの空港を表示。事例表示中は、事例側の空港（関西・新千歳など）のピンを隠す
  const airportsReady = initAirportsLayer(viewer);
  const hookCase = () => {
    const cb = document.getElementById('caseBtn');
    if (!cb) return setTimeout(hookCase, 300);
    cb.addEventListener('click', async () => {
      const on = cb.textContent.includes('閉じる');
      const hide = on ? Object.keys(await (await fetch('./data/metar_taf.json')).json()) : [];
      (await airportsReady)?.setCaseMode(on, hide);
      if (!on) viewer.camera.flyTo({ destination: JAPAN_RECT, duration: 2.0 });
    });
    // 「全体」ボタン（リアルタイム表示中）も北海道〜沖縄の表示にそろえる
    document.querySelector('[data-cam="all"]')?.addEventListener('click', () => {
      if (!cb.textContent.includes('閉じる')) setTimeout(() => viewer.camera.flyTo({ destination: JAPAN_RECT, duration: 2.0 }), 0);
    });
  };
  hookCase();
  const panel = Object.assign(document.createElement('div'), { id: 'awAdv' });
  document.body.append(panel);

  const S = { nav: null, ranked: [], sel: 0, wx: {}, altScale: 1, layers: { cat: true, sigmet: true, cb: true, fcst: true, wpt: true, awy: true, all: true },
            };
  const ds = new Cesium.CustomDataSource('advisor');
  viewer.dataSources.add(ds);
  // main.js の再読込（dataSources.removeAll）で消えたら付け直す
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => { viewer.dataSources.add(ds); render(); }, 0); });
  // SIGMET の箱をクリック → 説明（種類・高度・有効時刻・電文）を札で出す。ほかの所をクリックしたら消す
  const sgPop = Object.assign(document.createElement('div'), { id: 'awSgPop' });
  Object.assign(sgPop.style, { position: 'absolute', zIndex: 32, display: 'none', background: 'rgba(20,30,45,0.96)', color: '#fff',
    font: '12px/1.55 "Meiryo", sans-serif', border: '1px solid #e040fb', borderRadius: '6px', padding: '6px 26px 6px 10px', maxWidth: '360px' });
  document.body.appendChild(sgPop);
  sgPop.addEventListener('click', e => { if (e.target.dataset.x != null) sgPop.style.display = 'none'; });
  new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction(ev => {
    const hits = [...new Set(viewer.scene.drillPick(ev.position, 6).map(h => h.id).filter(x => x?.awSigmet).map(x => x.awSigmet))];
    if (!hits.length) { sgPop.style.display = 'none'; return; }
    sgPop.innerHTML = hits.slice(0, 3).map(sigmetHtml).join('<hr style="border:none;border-top:1px solid #4a2d5c;margin:5px 0">') +
      '<span data-x style="position:absolute;right:7px;top:3px;cursor:pointer;color:#aaa;font-size:15px">×</span>';
    const W = viewer.scene.canvas.clientWidth, H = viewer.scene.canvas.clientHeight;
    sgPop.style.display = 'block';
    sgPop.style.left = Math.max(10, Math.min(ev.position.x + 14, W - sgPop.offsetWidth - 10)) + 'px';
    sgPop.style.top = Math.max(10, Math.min(ev.position.y + 14, H - sgPop.offsetHeight - 10)) + 'px';
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const get = async f => { const r = await fetch(dataBase + f); if (!r.ok) throw new Error(f); return r.json(); };
  try {
    const [airportDb, navDb, routeDb, company] = await Promise.all([loadAirportDb(), loadNavDb(), get('route_db.json'),
      get('company_routes.json').catch(() => null)]);
    // City Pair Route（company_routes.json）を足す。削除日（validTo）を過ぎたものは使わない
    const today = new Date().toISOString().slice(0, 10);
    const co = (company?.routes || []).filter(r => !r.validTo || r.validTo >= today);
    S.nav = createAeroNav({ airportDb, navDb, routeDb: { ...routeDb, routes: [...routeDb.routes, ...co] } });
  } catch (e) {
    panel.textContent = '航法データ（public/data/nav/）を読み込めませんでした。'; console.warn('[advisor]', e); return;
  }

  const aps = S.nav.listAirports().sort((a, b) => a.icao.localeCompare(b.icao));
  initChartsPanel(viewer, { airports: aps });
  const opt = (v, t, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`;
  // 国際線の悪天回避登録経路：出発便は「出域の航空路」、到着便は「入域の航空路」を、到着・出発の欄で選ぶ
  const intl = S.nav.data.routeDb.routes.filter(r => r.intl && r.status === 'ok');
  const intlGroups = kind => [...new Set(intl.filter(r => r.intl === kind).map(r => (kind === 'departure' ? r.dest : r.dep)))].sort().map(code => {
    const rs = intl.filter(r => r.intl === kind && (kind === 'departure' ? r.dest : r.dep) === code);
    const pts = [...new Set(rs.map(r => (kind === 'departure' ? r.fixes.at(-1) : r.fixes[0])))];
    const aps2 = [...new Set(rs.map(r => (kind === 'departure' ? r.dep : r.dest)))].map(c => ({ RJAA: '成田', RJTT: '羽田', RJBB: '関西' }[c] || c));
    return { code, label: `${code} ${kind === 'departure' ? '出域' : '入域'}（${pts.join('・')}／${aps2.join('・')}）` };
  });
  // 空港データ（AIP）がない空港（今は無し。羽田は AIP から追加済み）。SID・STAR なしで、経路の始点・終点から表示する
  const NO_DATA = [{ icao: 'RJTT', label: 'HND 羽田（空港データなし）' }].filter(a => !aps.some(x => x.icao === a.icao));   // 空港DBに入ったら外す
  const apOpts = sel => aps.map(a => opt(a.icao, `${a.iata || a.icao} ${a.nameJa || a.nameEn || ''}`, a.icao === sel)).join('') + NO_DATA.map(a => opt(a.icao, a.label)).join('');
  // 先頭の「未選択」は「クリア」の後の状態（2026-10-19）
  const NONE = '<option value="">— 未選択 —</option>';
  const depOptions = () => NONE + `<optgroup label="空港">${apOpts('RJBB')}</optgroup>` +
    `<optgroup label="国際線の到着便（入域する航空路）">${intlGroups('arrival').map(g => opt(g.code, g.label)).join('')}</optgroup>`;
  const arrOptions = () => NONE + `<optgroup label="空港">${apOpts('RJCC')}</optgroup>` +
    `<optgroup label="国際線の出発便（出域する航空路）">${intlGroups('departure').map(g => opt(g.code, g.label)).join('')}</optgroup>`;
  panel.innerHTML = `
    <h2>揺れ回避 経路アドバイス</h2>
    <div class="row">
      <label>出発<select id="awDep">${depOptions()}</select></label>
      <label>到着<select id="awArr">${arrOptions()}</select></label>
    </div>
    <div class="row" style="margin-top:6px">
      <label>出発時刻<select id="awT">${[0, 1, 2, 3, 4, 6, 8].map(h => opt(h, h ? `${h}時間後` : '今すぐ', !h)).join('')}</select></label>
      <label>最低FL<select id="awMin">${[100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300].map(f => opt(f, 'FL' + f, f === 240)).join('')}</select></label>
      <label>最高FL<select id="awMax">${[250, 270, 290, 310, 330, 350, 370, 390, 410].map(f => opt(f, 'FL' + f, f === 390)).join('')}</select></label>
      <button class="go" id="awGo">評価する</button>
      <button class="save" id="awSave" disabled title="評価の結果（経路・高度・揺れの要因）、3D 画面、断面図、天気図を1つのファイルに保存">💾 保存</button>
      <button class="save" id="awClear" disabled title="評価の結果（候補経路・アドバイス・地図の経路と悪天の表示・断面図）を消して、評価する前の状態に戻す">🧹 クリア</button>
      <button class="save" id="awList2" title="保存した経路の一覧（開く・地図に表示・削除）">📂 保存一覧</button>
    </div>
    <h3>気象データ</h3><div class="st" id="awSt"><span>—</span><span>「評価する」で最新データを取得します</span></div>
    <h3>アドバイス</h3><div class="advice" id="awAdvice">出発・到着を選んで「評価する」を押すと、登録経路（AIC標準経路・悪天回避登録経路など）を揺れのリスクで比べ、推奨の経路と高度を表示します。</div>
    <h3>候補経路 <span class="hint">（クリックで選択・ダブルクリックで3Dと断面図）</span></h3><div id="awGc" style="font-size:12px;color:#cfe3f5;margin:-2px 0 4px"></div><ol id="awList"></ol>
    <h3>表示</h3>
    <div class="row">
      <button class="tg" data-l="cat" aria-pressed="true">乱気流域</button>
      <button class="tg" data-l="sigmet" aria-pressed="true">SIGMET</button>
      <button class="tg" data-l="cb" aria-pressed="true">積乱雲</button>
      <button class="tg" data-l="fcst" aria-pressed="true">悪天予想図</button>
      <button class="tg" data-l="all" aria-pressed="true">全候補</button>
      <button class="tg" data-l="wpt" aria-pressed="true" title="選んだ経路の地点名と通過高度（3Dと断面図）">Waypoint</button>
      <button class="tg" data-l="awy" aria-pressed="true" title="選んだ経路の航空路名・SID・STAR・直行（3Dと断面図）">Airway</button>
    </div>
    <div class="note">揺れ評価 = 晴天乱気流（Ellrod指数・気象庁MSM/GSM）、対流雲（レーダーエコー・経路左右10NM）、発達した積乱雲（強いエコー×ひまわり赤外の冷たい雲頂。20NM以内で推定雲頂＋5000ftより低いと強）、SIGMET（TS/TURB/MTW）を、通過する時間（分）×強さで合計した値。距離が延びる分も加味して順位付け。教育用の簡易評価であり、実運航の判断には使用できません。</div>`;
  const $ = id => panel.querySelector('#' + id);

  panel.querySelectorAll('.tg').forEach(b => b.onclick = () => {
    const k = b.dataset.l; S.layers[k] = !S.layers[k]; b.setAttribute('aria-pressed', S.layers[k]); render();
    if (k === 'wpt' || k === 'awy') section.setLayers({ wpt: S.layers.wpt, awy: S.layers.awy });
  });
  $('awGo').onclick = () => evaluate();
  // 保存：評価の結果・3D 画面・断面図・天気図を HTML ファイル1つに
  const saved = createSavedPanel(viewer, { getAltScale: () => window.awGetAltScale?.() ?? 1, anchor: panel, onShow: (rec, parsed, nCmp) => showSaved(rec, parsed, nCmp) });
  const savedView = createSavedView({ onExit: () => exitSaved() });
  const routeLabel = () => { const r = S.ranked[S.sel]; return r ? `${$('awDep').value} → ${$('awArr').value}　${r.cand.label}　${Math.round(r.distanceNM).toLocaleString()} NM・${levelPlanText(r.best)}・揺れ評価 ${r.best.hazardScore}` : ''; };
  const setSelectValue = (sel, v) => {
    if (![...sel.options].some(o => o.value === v)) { const a = S.nav.getAirport(v); sel.add(new Option(a ? `${a.icao} ${a.nameJa}${a.station ? '（SID・STARなし）' : ''}` : v, v)); }
    sel.value = v;
  };
  /** 保存した評価を、そのまま画面に出す（候補経路・アドバイス・3D・断面図。気象データは保存した時のもの） */
  async function showSaved(rec, parsed, nCmp = 0) {
    const d = decodeState(parsed.state);
    S.ranked = d.ranked; S.sel = Math.min(d.sel || 0, d.ranked.length - 1); S.wx = d.wx;
    Object.assign(S, { departure: d.departure, minFL: d.minFL, maxFL: d.maxFL });
    setSelectValue($('awDep'), d.dep); setSelectValue($('awArr'), d.arr);
    for (const k of Object.keys(status)) delete status[k];
    Object.assign(status, d.status || {});
    $('awSt').innerHTML = Object.entries(status).map(([n, s]) => `<span>${n}</span><span class="${s.cls}">${s.txt}</span>`).join('');
    $('awAdvice').textContent = `${d.advice || ''}\n（保存したデータ：評価 ${new Date(rec.created).toISOString().slice(0, 16).replace('T', ' ')}Z${nCmp ? `。ほか ${nCmp} 件の経路を水色の線で重ねています` : ''}）`;
    $('awSave').disabled = true; $('awClear').disabled = false;
    renderList(); render();
    savedView.show(rec, parsed.charts, routeLabel());
    if (section.open) showSection();
    flyToPoints(S.ranked[S.sel].full.points);
  }
  /** 保存データの表示をやめる（評価の結果を消して、いまの表示に戻す） */
  function exitSaved() {
    savedView.hide(); saved.clearShown(); section.hide();
    S.ranked = []; S.wx = {}; render();
    $('awList').innerHTML = ''; $('awGc').textContent = '';
    for (const k of Object.keys(status)) delete status[k];
    $('awSt').innerHTML = '<span>—</span><span>「評価する」で最新データを取得します</span>';
    $('awAdvice').textContent = '出発・到着を選んで「評価する」を押すと、登録経路を揺れのリスクで比べ、推奨の経路と高度を表示します。';
    $('awSave').disabled = true; $('awClear').disabled = true;
  }
  // 「クリア」：評価の結果を全部消す（保存データの表示中なら、その表示もやめる）（2026-10-18）
  //   出発・到着の指定も消して、経路を作るパネルを最初の状態（空港のクリックは METAR・TAF だけ）に戻す（2026-10-19）
  $('awClear').onclick = () => {
    exitSaved();
    $('awDep').value = ''; $('awArr').value = '';
    builder.reset();
  };
  $('awList2').onclick = () => saved.toggle();
  $('awSave').onclick = async () => {
    if (!S.ranked.length || savedView.on) return;
    const b = $('awSave'), label = b.textContent; b.disabled = true;
    try {
      const res = await saveBriefing({
        viewer, ranked: S.ranked, sel: S.sel, wx: S.wx, dep: $('awDep').value, arr: $('awArr').value,
        departure: S.departure, minFL: S.minFL, maxFL: S.maxFL, advice: $('awAdvice').textContent, status, section,
      }, t => { b.textContent = t; });
      try { await saved.add(res.html, res.data, res.name); } catch (e) { console.warn('[advisor] saved list', e); }
      const miss = res.charts.filter(c => !c.embedded).map(c => c.title);
      b.textContent = `保存しました（${res.sizeKB.toLocaleString()}KB）`;
      if (miss.length) b.title = `取り込めなかった天気図（リンクのみ）：${miss.join('、')}`;
    } catch (e) { console.warn('[advisor] save', e); b.textContent = '保存できませんでした'; }
    setTimeout(() => { b.textContent = label; b.disabled = !S.ranked.length; }, 2500);
  };

  // ---------- 断面図（候補経路のダブルクリックで、画面下の中央に出す） ----------
  //   断面図の「✏ FL変更」で途中の高度を変えると、その計画で揺れ評価を計算し直し、一覧・3D・アドバイスにも反映する
  const section = createRouteSection({ onEdit: pl => applyPlan(pl), onReset: () => resetPlan() });
  function applyPlan(pl, manual = true) {
    const r = S.ranked[S.sel]; if (!r) return;
    try {
      const nb = manualPlan(r, pl.fl, pl.steps, S.wx, S.departure || new Date(), S.minFL, S.maxFL);
      nb.manual = manual;
      r.best = nb;
    } catch (e) { console.warn('[advisor] manual plan', e); return; }
    afterPlanChange(r);
  }
  function resetPlan() {
    const r = S.ranked[S.sel]; if (!r?.autoBest) return;
    if (r.autoBest.prof) { r.best = r.autoBest; afterPlanChange(r); }
    else applyPlan({ fl: r.autoBest.fl, steps: r.autoBest.steps || [] }, false);    // 保存データ：推奨の計画を計算し直す
  }
  function afterPlanChange(r) {
    rescore(r, Math.min(...S.ranked.map(x => x.distanceNM)));
    renderList(); render(false);
    section.refresh(r, S.wx, S.wx.fc, sectionHead(r), planContext(r, S.minFL, S.maxFL));
    const auto = r.autoBest?.hazardScore;
    const note = r.best.manual
      ? `\n\n【手動の高度計画（断面図で変更）】${r.cand.label}・${levelPlanText(r.best)}：揺れ評価 ${r.best.hazardScore}${auto != null ? `（自動の推奨計画では ${auto}）` : ''}` +
        (r.best.hazards.length ? `\n残る要因: ${r.best.hazards.slice(0, 2).map(hazardText).join(' / ')}` : '\nこの高度計画では、評価した範囲で揺れの要因は見つかりませんでした。')
      : '';
    $('awAdvice').textContent = (gcText() ? gcText() + '\n\n' : '') + adviceText(S.ranked) + note + perfNote() + (S.departure ? `\n（出発 ${S.departure.toISOString().slice(11, 16)}Z 想定）` : '');
    if (savedView.on) savedView.setRoute(routeLabel());
  }

  // ---------- 経路を作る BOX（アプリを開いたときから左下に出す。空港のクリックで路線を決める） ----------
  const PANEL_BOTTOM = getComputedStyle(panel).bottom;
  const builder = createRouteBuilder(viewer, {
    nav: S.nav,
    // 登録・削除の後：視点は動かさずに評価をやり直し、登録した経路を選んだ状態にする
    onSaved: route => evaluate({ keepView: true, select: route?.route }),
    // BOX の分だけ、アドバイスパネルの下端を上げる
    onResize: h => { panel.style.bottom = h ? `${h + 20}px` : PANEL_BOTTOM; },
    // 地図のクリックで路線が決まったら、アドバイスパネルの出発・到着の欄も合わせる
    onRoute: (dep, arr) => { setSelectValue($('awDep'), dep); setSelectValue($('awArr'), arr); },
  });
  const hookNav = () => (window.awNav ? window.awNav.onPick(hit => builder.onPick(hit)) : setTimeout(hookNav, 300));
  hookNav();
  airportsReady.then(l => { l?.onPick(h => builder.onAirport(h)); l?.setClickHint(() => builder.clickHint()); });
  // 白丸の空港（空港DBにない空港）も、滑走路・SID・STAR のない空港として出発・到着に使えるようにする
  airportsReady.then(l => { if (l?.station) S.nav.setAirportFallback(c => l.station(c)); });
  builder.start();
  // アドバイスパネルの出発・到着の欄を変えたとき（どちらも空港なら）経路作成 BOX の路線も合わせる
  for (const id of ['awDep', 'awArr']) $(id).addEventListener('change', () => {
    const d = $('awDep').value, a = $('awArr').value;
    if (S.nav.getAirport(d) && S.nav.getAirport(a) && d !== a) builder.show(d, a);
  });

  // ---------- 状態表示 ----------
  const status = {};
  const setSt = (k, cls, txt) => {
    status[k] = { cls, txt };
    $('awSt').innerHTML = Object.entries(status).map(([n, s]) => `<span>${n}</span><span class="${s.cls}">${s.txt}</span>`).join('');
  };

  // ---------- 評価 ----------
  async function evaluate({ keepView = false, select = null } = {}) {
    if (savedView.on) { savedView.hide(); saved.clearShown(); }       // 保存データの表示中なら、最新の評価に切り替える
    const dep = $('awDep').value, arr = $('awArr').value;
    if (!dep || !arr) { $('awAdvice').textContent = '出発と到着を選んでから「評価する」を押してください（上の欄で選ぶか、左下の「経路を作り始める」から地図の空港をクリック）。'; return; }
    if (!keepView) flyToPoints(airportPts());          // まず出発〜到着の範囲を表示
    const departure = new Date(Date.now() + (+$('awT').value) * 3600e3);
    const opts = { dep, arr, departure, minFL: +$('awMin').value, maxFL: +$('awMax').value };
    // 候補: 登録経路（AIC・回避・自作）。同じ経路文字列は1本にまとめる
    const seen = new Map();
    for (const r of S.nav.findRoutes(dep, arr)) {
      if (r.status !== 'ok') continue;
      const tag = r.category === 'standard' ? `AIC標準${r.time ? '（' + r.time + '）' : ''}${r.remarks ? '・' + r.remarks : ''}`
        : r.category === 'avoidance' ? `悪天回避 No.${r.no}${r.remarks ? '（' + r.remarks + '）' : ''}`
        : r.category === 'company' ? `No.${String(r.no).padStart(2, '0')}${r.time ? '（' + r.time + '）' : ''}${r.remarks ? '・' + r.remarks : ''}`
        : `自作 ${r.name || ''}`;
      if (seen.has(r.route)) { seen.get(r.route).label += ' ／ ' + tag; continue; }
      seen.set(r.route, { ...r, label: tag, ...routeConditions(r, departure) });
    }
    const cands = [...seen.values()];
    if (!cands.length) {
      $('awAdvice').textContent = `${dep}→${arr} の登録経路がありません。左下の「経路を作る」で地点・航空路をクリックして経路を作り、登録すると候補に加わります。`;
      $('awList').innerHTML = ''; $('awGc').textContent = ''; S.ranked = []; render(); builder.show(dep, arr); return;
    }
    $('awGo').disabled = true; $('awSave').disabled = true; $('awAdvice').textContent = '最新の気象データを取得しています…';
    Object.assign(S, { departure, minFL: opts.minFL, maxFL: opts.maxFL });
    // 範囲
    let s = 90, n = -90, w = 180, e = -180;
    const fullOf = c => S.nav.buildFullRoute(fullRouteArgs(dep, arr, c));
    for (const c of cands) for (const p of fullOf(c).points) {
      s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon);
    }
    const bbox = { s: s - 1.5, n: n + 1.5, w: w - 1.5, e: e + 1.5 };
    ['高層風', 'レーダー', 'SIGMET', '悪天予想図'].forEach(k => setSt(k, 'wait', '取得中…'));
    const wx = {};
    // 地形による最低高度（山岳地帯を低い高度で飛ばないように）
    try { wx.msaAt = await terrainFinder(viewer, cands.map(c => fullOf(c).points)); wx.elevAt = wx.msaAt?.elevFt; }
    catch (e) { console.warn('[advisor] terrain', e); }
    // 悪天予想図は飛行の中ほどの時刻（一番短い候補を 420kt で飛ぶとして）の予想を使う
    const midTime = new Date(departure.getTime() + Math.min(...cands.map(c => fullOf(c).distanceNM || 0)) / 420 * 0.5 * 3600e3);
    await Promise.all([
      // 国際線などで範囲が広いときは格子を2度ごとにして、取得量（Open-Meteo の利用回数）を抑える
      fetchUpperGrid(bbox, { hours: 12, step: (bbox.n - bbox.s) * (bbox.e - bbox.w) > 400 ? 2 : 1 }).then(g => {
        wx.grid = g; wx.tiField = computeTI(g);
        setSt('高層風', 'ok', `${g.source} ${g.times[0].slice(5, 16).replace('T', ' ')}Z〜 格子${g.lats.length}×${g.lons.length}`);
      }).catch(err => setSt('高層風', 'ng', `取得できません（晴天乱気流は評価外）: ${err.message}`)),
      fetchRadar(bbox).then(r => { wx.radar = r; setSt('レーダー', 'ok', `${r.source} ${fmtJmaTime(r.time)}`); })
        .catch(err => setSt('レーダー', 'ng', `取得できません（対流雲は評価外）: ${err.message}`)),
      fetchSigmets(bbox).then(x => { wx.sigmets = x.list; setSt('SIGMET', 'ok', `${x.list.length}件（福岡FIR周辺）`); })
        .catch(err => setSt('SIGMET', 'ng', `取得できません: ${err.message}`)),
      // 悪天予想図：国内（FBJP の画像を読み取る）と国際（WAFS SIGWX）。範囲の中・下限〜上限の高度を揺れの要因にする
      fetchForecastCharts(midTime).then(fc => {
        wx.fc = fc; wx.fcstBands = forecastBands(fc);
        if (wx.fcstBands.length || fc.fbjp || fc.sigwx) wx.fcstAt = (lat, lon) => bandsAt(wx.fcstBands, lat, lon);
        const parts = [];
        if (fc.fbjp) parts.push(`国内 CAT ${fc.fbjp.cats.length}・雲域 ${fc.fbjp.clouds.length}`); else parts.push(`国内 取得できません（${fc.fbjpError}）`);
        if (fc.sigwx) parts.push(`国際 ${fc.sigwx.valid.toISOString().slice(11, 13)}Z 予想（積乱雲 ${fc.sigwx.areas.filter(a => a.kind === 'CB').length}・乱気流 ${fc.sigwx.areas.filter(a => a.kind === 'TURB').length}）`);
        else parts.push(`国際 取得できません（${fc.sigwxError}）`);
        setSt('悪天予想図', fc.fbjp || fc.sigwx ? 'ok' : 'ng', parts.join('／'));
      }).catch(err => setSt('悪天予想図', 'ng', `取得できません: ${err.message}`)),
    ]);
    // 発達した積乱雲：レーダーの強いエコー × ひまわり赤外の冷たい雲頂（雲頂高度つき）
    if (wx.radar) {
      setSt('積乱雲', 'wait', '雲頂高度を推定中…');
      try {
        const ct = await analyzeCloudTops(fromAdvisorRadar(wx.radar));
        wx.cbs = ct.cbs;
        try { wx.convTop = await convTopFinder(ct.grid); } catch (e) { console.warn('[advisor] convTop', e); }
        setSt('積乱雲', 'ok', `${ct.cbs.length}か所（ひまわり赤外 ${fmtJmaTime(ct.irTime)}・雲頂温度−40℃以下 × 20mm/h以上）`);
      } catch (err) { setSt('積乱雲', 'ng', `判定できません: ${err.message}`); }
    }
    S.wx = wx;
    S.ranked = rankRoutes(S.nav, cands, wx, opts);
    S.sel = Math.max(0, select ? S.ranked.findIndex(r => r.cand.route === select) : 0);
    $('awGo').disabled = false; $('awSave').disabled = !S.ranked.length; $('awClear').disabled = !S.ranked.length;
    if (!wx.grid && !wx.radar && !wx.sigmets) {
      $('awAdvice').textContent = '気象データを1つも取得できなかったため評価できません。通信状態を確認してください。';
    } else {
      $('awAdvice').textContent = (gcText() ? gcText() + '\n\n' : '') + adviceText(S.ranked) + perfNote() + `\n（出発 ${departure.toISOString().slice(11, 16)}Z 想定）`;
    }
    renderList(); render();
    if (section.open) showSection();                            // 断面図を出していれば、新しい結果で描き直す
    if (!keepView && !section.open) flyToPoints(S.ranked[S.sel].full.points);   // 結果は真上から（立体表示は候補経路をダブルクリックしたとき）
    builder.show(dep, arr);
  }

  /** 高度を誇張する（main.js の「高度100倍」ボタンと同じ処理。すでに誇張中なら何もしない）。今は使っていない（誇張はボタンだけで行う） */
  async function ensureExag() {
    if (S.altScale !== 1) return;
    S.altScale = window.AW_EXAG || 25;
    try { await window.awSetExag?.(window.AW_EXAG || 25); } catch (e) { console.warn('[advisor] exag', e); }
  }

  /** 選んでいる経路の、A321XLR で運航した場合の目安（アドバイス文の後ろに付ける） */
  function perfNote() {
    const r = S.ranked[S.sel], p = perfOf(r);
    return p ? `\n\n${r.cand.label}・${levelPlanText(r.best)}：${perfText(p)}` : '';
  }
  /** 経路を選び直したときに、アドバイス文の目安の部分だけ差し替える */
  function refreshPerfNote() {
    const el = $('awAdvice'), t = el.textContent, k = t.indexOf('【Airbus'), i = k < 0 ? -1 : t.lastIndexOf('\n\n', k), j = t.lastIndexOf('\n（出発');
    if (!S.ranked.length || i < 0) return;
    el.textContent = t.slice(0, i) + perfNote() + (j > i ? t.slice(j) : '');
  }
  // 出発空港〜到着空港の大圏距離（空港の標点 ARP の間。地球を半径 3,440.065NM の球として）（2026-10-18）
  function gcNM() {
    const a = S.nav.getAirport($('awDep').value)?.arp, b = S.nav.getAirport($('awArr').value)?.arp;
    if (!a || !b) return null;
    const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.sqrt(h));
  }
  const gcText = () => { const g = gcNM(); return g == null ? '' : `大圏距離（${$('awDep').value}→${$('awArr').value}）${Math.round(g).toLocaleString()} NM（${Math.round(g * 1.852).toLocaleString()} km）`; };
  function renderList() {
    const g = gcNM();
    $('awGc').textContent = S.ranked.length && g != null ? gcText() + '。各経路の％は大圏距離に対する遠回りの割合' : '';
    // 各経路：距離（NM、SID・STAR を含む全経路）を大きく。経路の文字列・SID・STAR は出さない
    $('awList').innerHTML = S.ranked.map((r, i) => `
      <li data-i="${i}" aria-current="${i === S.sel}"${r.excluded ? ' style="opacity:.6"' : ''}>
        <div class="top"><b>${r.excluded ? '—' : i + 1 + '.'} ${r.cand.label}</b><span class="b ${r.level}">${LEVEL_JA[r.level]} ${r.best.hazardScore}</span></div>
        <div class="sub"><span>${r.best.manual ? "" : "推奨"}${levelPlanText(r.best)}・${perfOf(r) ? hm(perfOf(r).minutes) : `約${r.best.minutes}分`}${r.extraNM > 0 ? `（最短 +${Math.round(r.extraNM)}NM）` : '（最短）'}</span><span class="nm">${Math.round(r.distanceNM).toLocaleString()} NM${gcNM() ? `<small style="font-weight:normal;opacity:.8">（+${Math.max(0, Math.round((r.distanceNM / gcNM() - 1) * 100))}％）</small>` : ''}</span></div>
        ${perfOf(r) ? `<div class="pf" title="Airbus A321XLR で運航した場合の目安（上層風は考えない。地上走行を含む。ドラム缶は 200L＝160kg、CO2 は燃料 1kg あたり 3.16kg、燃料代はジェット燃料を灯油と同じくらいとして 1L ${FUEL_YEN_PER_L}円）">A321XLR：燃料 ${n0(Math.round(perfOf(r).blockKg / 10) * 10)}kg（${n0(Math.round(perfOf(r).blockLb / 10) * 10)}lbs）・ドラム缶 約${Math.round(perfOf(r).drums)}本・燃料代 ${yenText(perfOf(r).yen)}・CO2 ${(perfOf(r).co2Kg / 1000).toFixed(1)}t</div>` : ''}
        ${r.excluded ? `<div class="hz" style="color:#9fb3c8">対象外: ${r.excluded}</div>` : ''}
        ${r.best.hazards.slice(0, 3).map(h => `<div class="hz">${hazardText(h)}</div>`).join('')}
      </li>`).join('');
  }
  // 候補をクリック → 選んだ経路の色・太さを変える（視点は変えない）。
  // ダブルクリック（iPad はダブルタップ）→ 3D（高度を誇張して横から斜めに見る）と、画面下の中央に断面図
  let lastTap = { i: -1, t: 0 };
  const selectRoute = i => {
    S.sel = i;
    $('awList').querySelectorAll('li').forEach(li => li.setAttribute('aria-current', +li.dataset.i === i));
    refreshPerfNote();
    render(false);
    if (section.open) showSection();
    if (savedView.on) savedView.setRoute(routeLabel());
  };
  $('awList').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const i = +li.dataset.i, now = Date.now();
    const dbl = lastTap.i === i && now - lastTap.t < 400;
    lastTap = dbl ? { i: -1, t: 0 } : { i, t: now };
    if (i !== S.sel) selectRoute(i);
    if (dbl) open3D();
  });
  async function open3D() {
    const r = S.ranked[S.sel]; if (!r) return;
    showSection();
    await ensureExag();
    flyRoute3D(r);
  }
  const sectionHead = r => `${$('awDep').value} → ${$('awArr').value}（大圏 ${Math.round(gcNM() ?? 0).toLocaleString()} NM）　${r.cand.label}　${Math.round(r.distanceNM).toLocaleString()} NM・${levelPlanText(r.best)}・揺れ評価 ${r.best.hazardScore}` +
    (perfOf(r) ? `　A321XLR ${hm(perfOf(r).minutes)}・燃料 ${n0(Math.round(perfOf(r).blockKg / 10) * 10)}kg（${yenText(perfOf(r).yen)}）` : '');
  function showSection() {
    const r = S.ranked[S.sel]; if (!r) return;
    let ctx = null;
    try { ctx = planContext(r, S.minFL, S.maxFL); } catch (e) { console.warn('[advisor] plan context', e); }
    section.show(r, S.wx, S.wx.fc, sectionHead(r), ctx);
  }


  // ---------- 3D描画 ----------
  const M = ft => ft * 0.3048 * S.altScale;
  // 高度の表示：転移高度（14,000ft）以上は FL、それより下は ft
  const altText = ft => (ft >= 14000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${(Math.round(ft / 100) * 100).toLocaleString()}ft`);

  // 全経路の点を「同じ航空路（または SID・STAR・直行）で続く区間」にまとめる
  function airwayGroups(full) {
    const pts = full.points, out = [];
    const nameOf = p => {
      if (p.kind === 'SID' || p.kind === 'SID_TRANSITION') return { name: full.sid ? `${full.sid}${full.sidTransition ? ` (${full.sidTransition})` : ''}` : 'SID', type: 'SID' };
      if (p.kind === 'STAR') return { name: full.star || 'STAR', type: 'STAR' };
      if (p.kind === 'ENROUTE' && p.via) return p.via === 'DCT' ? { name: 'DCT', type: 'DCT' } : { name: p.via.replace(/\?$/, ''), type: 'AWY' };
      return null;
    };
    for (let i = 1; i < pts.length; i++) {
      // 区間 i-1 → i の名前は、到着側の点がどう結ばれたかで決まる（STAR の最初の区間は直前の経路の続き）
      let n = nameOf(pts[i]);
      if (pts[i].kind === 'runway') n = nameOf(pts[i - 1]);
      if (!n) continue;
      const last = out.at(-1);
      if (last && last.name === n.name && last.pts.at(-1) === pts[i - 1]) last.pts.push(pts[i]);
      else out.push({ ...n, pts: [pts[i - 1], pts[i]] });
    }
    return out;
  }
  const LEG_STYLE = {
    AWY: { fg: '#1a1300', bg: 'rgba(255,213,79,0.92)' },
    SID: { fg: '#002a33', bg: 'rgba(128,222,234,0.92)' },
    STAR: { fg: '#002a33', bg: 'rgba(128,222,234,0.92)' },
    DCT: { fg: '#e0e6ec', bg: 'rgba(60,72,88,0.75)' },
  };
  function addLegLabels(g, prof) {
    const d = (a, b) => Math.hypot(b.lat - a.lat, (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180)) * 60;
    const legs = []; let tot = 0;
    for (let i = 1; i < g.pts.length; i++) { const L = d(g.pts[i - 1], g.pts[i]); legs.push(L); tot += L; }
    if (tot < 5) return;
    // 長い航空路は約250NMごとに繰り返す
    const n = Math.max(1, Math.round(tot / 250)), st = LEG_STYLE[g.type];
    for (let k = 0; k < n; k++) {
      let want = tot * (k + 0.5) / n, i = 0;
      while (i < legs.length - 1 && want > legs[i]) { want -= legs[i]; i++; }
      const f = legs[i] ? want / legs[i] : 0, a = g.pts[i], b = g.pts[i + 1];
      const lat = a.lat + (b.lat - a.lat) * f, lon = a.lon + (b.lon - a.lon) * f;
      const q = prof.reduce((m, s) => (Math.hypot(s.lat - lat, s.lon - lon) < Math.hypot(m.lat - lat, m.lon - lon) ? s : m));
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, M(q.alt)),
        label: { text: g.name, font: `${g.type === 'DCT' ? '' : '700 '}12px Meiryo`, fillColor: Cesium.Color.fromCssColorString(st.fg),
          showBackground: true, backgroundColor: Cesium.Color.fromCssColorString(st.bg), backgroundPadding: new Cesium.Cartesian2(6, 3),
          pixelOffset: new Cesium.Cartesian2(0, 16), verticalOrigin: Cesium.VerticalOrigin.TOP,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1, 1e7, 0.8),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, g.type === 'DCT' ? 5e6 : 1.2e7) },
        description: g.type === 'AWY' ? `航空路 ${g.name}（${g.pts[0].id} → ${g.pts.at(-1).id}）` : `${g.type} ${g.name}` });
    }
  }

  function render(fly = false) {
    ds.entities.removeAll();
    if (!S.ranked.length) return;
    // 乱気流域（並以上）: 出発1時間後の時刻で表示
    if (S.layers.cat && S.wx.tiField) {
      const g = S.wx.grid, T = S.wx.tiField;
      const pr = S.ranked[S.sel].best.prof, mid = (pr[0].eto.getTime() + pr.at(-1).eto.getTime()) / 2;
      const t = Math.min(g.times.length - 1, Math.max(0, Math.round((mid - new Date(g.times[0]).getTime()) / 3.6e6)));
      const cells = [];
      T.layers.forEach((lay, L) => g.lats.forEach((la, i) => g.lons.forEach((lo, j) => {
        const ti = T.ti[t][L][i][j], c = tiClass(ti);
        if (c && c.cls !== 'LGT') cells.push({ la, lo, ti, c, z0: T.zlo[t][L][i][j], z1: T.zhi[t][L][i][j], lay });
      })));
      cells.sort((a, b) => b.ti - a.ti).slice(0, 300).forEach(k => ds.entities.add({
        rectangle: { coordinates: Cesium.Rectangle.fromDegrees(k.lo - 0.5, k.la - 0.5, k.lo + 0.5, k.la + 0.5),
          height: M(k.z0), extrudedHeight: M(k.z1),
          material: Cesium.Color.fromCssColorString(k.c.cls === 'SEV' ? '#ef5350' : '#ffa726').withAlpha(0.18), outline: false },
        description: `晴天乱気流 ${k.c.label} TI ${k.ti}（${k.lay.lo}-${k.lay.hi}hPa）`,
      }));
    }
    // SIGMET：対象の高度（下限〜上限）の箱だけを出す。説明（種類・高度・有効時刻・電文）は、箱をクリックしたときに出す（2026-10-19）
    if (S.layers.sigmet) for (const g of S.wx.sigmets || []) {
      const pos = Cesium.Cartesian3.fromDegreesArray(g.coords.flatMap(c => [c.lon, c.lat]));
      const topFt = Math.min(g.topFt, 50000);
      const col = Cesium.Color.fromCssColorString('#e040fb');
      const e = ds.entities.add({
        polygon: { hierarchy: pos, height: M(g.baseFt), extrudedHeight: M(topFt), perPositionHeight: false,
          material: col.withAlpha(0.15), outline: true, outlineColor: col },
      });
      e.awSigmet = g;
    }
    // 悪天予想図（選んだ経路にかかる範囲だけ）：下限〜上限の半透明の箱。国内＝FBJP、国際＝SIGWX
    if (S.layers.fcst && S.wx.fcstBands?.length) {
      const used = new Set();
      for (const p of S.ranked[S.sel].best.prof) for (const b of p.fcst || []) used.add(b);
      const FC = { CAT: '#c2185b', CB: '#ff5252', TURB: '#ff9100', CLOUD: '#b0bec5', ICING: '#4fc3f7' };
      for (const b of used) {
        const col = Cesium.Color.fromCssColorString(FC[b.kind] || '#ffffff');
        const ctr = b.ring.reduce((a, q) => ({ lat: a.lat + q.lat / b.ring.length, lon: a.lon + q.lon / b.ring.length }), { lat: 0, lon: 0 });
        ds.entities.add({
          polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(b.ring.flatMap(q => [q.lon, q.lat])), height: M(b.base), extrudedHeight: M(Math.min(b.top, 50000)),
            perPositionHeight: false, material: col.withAlpha(b.kind === 'CLOUD' ? 0.08 : 0.14), outline: true, outlineColor: col.withAlpha(0.8) },
          position: Cesium.Cartesian3.fromDegrees(ctr.lon, ctr.lat, M(Math.min(b.top, 50000))),
          label: { text: b.label.replace(/^(国内|国際)悪天予想図 /, b.src === 'FBJP' ? '国内悪天予想 ' : '国際悪天予想 '), font: '600 12px Meiryo', fillColor: col.brighten(0.3, new Cesium.Color()),
            showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6e6) },
          description: b.label,
        });
      }
    }
    // 発達した積乱雲（地上から推定雲頂までの円柱。高度倍率に合わせる）
    if (S.layers.cb) for (const b of S.wx.cbs || []) {
      const top = M((b.top?.fl ?? 450) * 100), col = Cesium.Color.fromCssColorString(b.sev === 'SEV' ? '#ff1744' : '#ff9100');
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, top / 2),
        cylinder: { length: top, topRadius: b.radiusKm * 1000, bottomRadius: b.radiusKm * 1000, material: col.withAlpha(0.22), outline: true, outlineColor: col },
        description: `発達した積乱雲 推定雲頂 FL${b.top?.fl ?? '?'}（雲頂温度 ${Math.round(b.tbb)}℃）・最大 ${b.maxMm}mm/h` });
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, top), label: {
        text: `積乱雲 頂FL${b.top ? String(b.top.fl).padStart(3, '0') : '?'}`, font: '600 12px Meiryo', fillColor: col.brighten(0.4, new Cesium.Color()),
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3.5e6) } });
    }
    // 候補経路（選択中は太く、区間ごとに揺れの強さで色分け）
    S.ranked.forEach((r, i) => {
      const sel = i === S.sel;
      if (!sel && !S.layers.all) return;
      const base = sel ? '#00e676' : '#90a4ae';
      let run = [], runCls;
      const flush = () => {
        if (run.length < 2) return;
        const col = Cesium.Color.fromCssColorString(RISK_COL[runCls] || base).withAlpha(sel ? 1 : 0.45);
        ds.entities.add({ polyline: { positions: run.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, M(p.alt))), width: sel ? 6 : 2,
          material: sel ? new Cesium.PolylineOutlineMaterialProperty({ color: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 }) : col } });
      };
      for (const sg of r.best.segs) {
        const c = sg.cls || null;
        if (run.length && c !== runCls) { flush(); run = [run.at(-1)]; }
        if (!run.length) run.push(sg.a);
        run.push(sg.b); runCls = c;
      }
      flush();
      if (sel) {
        // 地点ラベル（地点名と、そこを通過する高度）
        const prof = r.best.prof;
        const near = (lat, lon) => prof.reduce((m, q) => (Math.hypot(q.lat - lat, q.lon - lon) < Math.hypot(m.lat - lat, m.lon - lon) ? q : m));
        if (S.layers.wpt) for (const p of r.full.points.filter(p => p.kind !== 'runway' && p.kind !== 'airport')) {
          const q = near(p.lat, p.lon);
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, M(q.alt)),
            point: { pixelSize: 6, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
            label: { text: `${p.id}\n${altText(q.alt)}`, font: '11px Meiryo', pixelOffset: new Cesium.Cartesian2(8, -8), fillColor: Cesium.Color.WHITE,
              horizontalOrigin: Cesium.HorizontalOrigin.LEFT, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.7)'),
              // 国際線の全体を見る距離でも出す（遠いほど少し小さく）
              scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1, 8e6, 0.75), disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 9e6) } });
        }
        // 上昇終了（TOC）・降下開始（TOD）
        const firstLv = r.best.fl * 100, lastLv = r.best.steps?.length ? r.best.steps.at(-1).to * 100 : firstLv;
        const toc = prof.findIndex(q => q.alt >= firstLv - 50), tod = prof.findLastIndex(q => q.alt >= lastLv - 50);
        for (const [i, name] of [[toc, 'TOC'], [tod, 'TOD']]) {
          if (i < 0) continue;
          const q = prof[i];
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat, M(q.alt)),
            point: { pixelSize: 8, color: Cesium.Color.fromCssColorString('#b388ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
            label: { text: `${name} ${altText(q.alt)}`, font: '700 12px Meiryo', fillColor: Cesium.Color.fromCssColorString('#1d0b3a'),
              showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(179,136,255,0.92)'), backgroundPadding: new Cesium.Cartesian2(6, 3),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -12),
              disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4e6) },
            description: name === 'TOC' ? `上昇終了（${q.near}付近）` : `降下開始（${q.near}付近）` });
        }
        // 航空路名・SID/STAR 名（区間の途中に表示）
        if (S.layers.awy) for (const g of airwayGroups(r.full)) addLegLabels(g, r.best.prof);
        // 高度変更（ステップ上昇・降下）を始める所
        for (const st of r.best.steps || []) {
          const up = st.to > st.from;
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(st.lon, st.lat, M(st.from * 100)),
            point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(up ? '#40c4ff' : '#ffab40'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY },
            label: { text: `${up ? '▲' : '▼'} FL${st.from}→FL${st.to}${st.why ? `\n${{ CAT: '晴天乱気流', CONV: '雷雨', CB: '積乱雲', SIGMET: 'SIGMET', TERRAIN: '山', FCST: '悪天予想図の範囲' }[st.why.type]}を避ける` : ''}`,
              font: '700 12px Meiryo', fillColor: Cesium.Color.fromCssColorString(up ? '#002b3d' : '#3d2200'),
              showBackground: true, backgroundColor: Cesium.Color.fromCssColorString(up ? 'rgba(64,196,255,0.92)' : 'rgba(255,171,64,0.92)'),
              backgroundPadding: new Cesium.Cartesian2(6, 4), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -14),
              disableDepthTestDistance: Number.POSITIVE_INFINITY },
            description: `${st.near}付近から FL${st.from} → FL${st.to} へ${up ? '上昇' : '降下'}${st.why ? `（${st.why.label}）` : ''}` });
        }
        // 主な揺れ要因の位置に注記
        for (const h of r.best.hazards.slice(0, 3)) {
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, M(h.flMax * 100) + 1500),
            label: { text: `${h.type === 'CAT' ? 'CAT' : h.type === 'CONV' ? '雷雨' : h.type === 'CB' ? '積乱雲' : h.type === 'TERRAIN' ? '山' : h.type === 'FCST' ? '悪天予想' : 'SIGMET'} ${{ LGT: '弱', MOD: '並', SEV: '強' }[h.cls]}`,
              font: '600 13px Meiryo', fillColor: Cesium.Color.fromCssColorString(RISK_COL[h.cls]), showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
        }
      }
    });
    if (fly) flyRoute3D(S.ranked[S.sel]);
  }

  // 選んだ経路を、横（経路の進行方向に直角）から斜めに見下ろす立体表示にする
  function flyRoute3D(r) {
    try {
      const prof = r.best.prof;
      const pos = prof.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, M(p.alt)));
      const sphere = Cesium.BoundingSphere.fromPoints(pos);
      // 出発→到着の方位。カメラは経路の南側から北寄りを向く
      const a = prof[0], b = prof.at(-1);
      const brg = Math.atan2(Math.sin((b.lon - a.lon) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180),
        Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
        Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lon - a.lon) * Math.PI / 180));
      let h = brg - Math.PI / 2;
      if (Math.cos(h) < 0) h = brg + Math.PI / 2;
      // 左右のパネルの間に収まる距離と、見える範囲の中央へのずらし量
      const W = viewer.canvas.clientWidth || window.innerWidth;
      const ins = window.awLayout?.insets?.();                // 左のアイコンの列と引き出し（layout.js）
      const lp = ins ? ins.left + 10 : (panel.getBoundingClientRect().right || 360) + 10;
      const rpEl = document.getElementById('awWx');
      const rp = ins ? ins.right + 10 : rpEl ? W - rpEl.getBoundingClientRect().left + 10 : 360;
      const narrow = W - lp - rp < 400;                         // 画面が狭いときはパネルを考慮しない
      const vis = narrow ? 1 : Math.max(0.5, (W - lp - rp) / W);
      // 下の断面図の分だけ、縦に見える範囲が狭くなる
      const secEl = document.getElementById('awSec'), Hc = viewer.canvas.clientHeight || window.innerHeight;
      const secH = secEl && !secEl.hidden ? secEl.getBoundingClientRect().height + 50 : 0;
      const visH = Math.max(0.35, 1 - secH / Hc);
      const range = Math.max(150000, sphere.radius * 2.4 / Math.min(vis, visH));
      viewer.camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(h, Cesium.Math.toRadians(-32), range), duration: 2.0,
        complete: () => {
          const fr = viewer.camera.frustum, asp = fr.aspectRatio || 1.6;
          // 断面図に隠れないよう、経路を上に寄せる
          if (secH) {
            const fovy = asp >= 1 ? 2 * Math.atan(Math.tan(fr.fov / 2) / asp) : fr.fov;
            viewer.camera.moveDown(secH / 2 / Hc * 2 * range * Math.tan(fovy / 2));
          }
          if (narrow) return;
          const fovx = asp >= 1 ? fr.fov : 2 * Math.atan(Math.tan(fr.fov / 2) * asp);
          const widthM = 2 * range * Math.tan(fovx / 2);
          const shift = ((lp - rp) / 2 / W) * widthM;            // 見える範囲の中央に経路が来るように
          if (Math.abs(shift) > 1) viewer.camera.moveLeft(shift);
        },
      });
    } catch (e) { console.warn('[advisor] camera3d', e); flyToPoints(r.full.points); }
  }

  // 出発空港〜到着空港（＋経路）を、左右のパネルに隠れないように真上から表示
  function flyToPoints(pts) {
    try { flyToPointsInner(pts); } catch (e) { console.warn('[advisor] camera', e); }
  }
  function flyToPointsInner(pts) {
    if (!pts.length) return;
    const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
    let w = Math.min(...lons) - 0.8, e = Math.max(...lons) + 0.8, s = Math.min(...lats) - 0.8, n = Math.max(...lats) + 0.8;
    const W = viewer.canvas.clientWidth || window.innerWidth;
    const ins = window.awLayout?.insets?.();                  // 左のアイコンの列と引き出し（layout.js）
    const lp = ins ? ins.left + 10 : (panel.getBoundingClientRect().right || 360) + 10;
    const rpEl = document.getElementById('awWx');
    const rp = ins ? ins.right + 10 : rpEl ? W - rpEl.getBoundingClientRect().left + 10 : 360;
    if (W < 600) {                                            // 画面が狭い・非表示のときはパネルを考慮しない
      viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n), duration: 1.5 }); return;
    }
    const vis = Math.max(0.25, (W - lp - rp) / W);           // パネルの間に見える割合
    const span = (e - w) / vis, cx = (w + e) / 2;
    const shift = ((rp - lp) / 2 / W) * span;                  // 見える範囲の中央に寄せる
    w = cx - span / 2 + shift; e = cx + span / 2 + shift;
    viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n), duration: 1.5 });
  }
  const airportPts = () => [$('awDep').value, $('awArr').value].map(c => S.nav.getAirport(c)).filter(Boolean).map(a => a.arp);

  return {
    setAltScale(s) { S.altScale = s; render(); },
    evaluate, get results() { return S.ranked; },
  };
}
