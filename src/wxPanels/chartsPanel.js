// 右側の「天気図・画像」一覧（常時表示）
//   地上天気図、850/700・500/300・250・200hPa 高層天気図、断面図（AXJP・FXJP）、国内悪天予想図、衛星（可視・赤外）、レーダー
//   図をクリックすると、その下に解説が開き、図そのものを地図（日本）に縮尺を合わせて重ねる。
//   衛星とレーダーは「地図に重ねる」で常時重ねておくこともできる。
import * as Cesium from 'cesium';
import { GUIDES, analyze } from './chartGuide.js';
import { PROJ, warpChart, addChartLayer, removeChartLayer } from './chartOverlay.js';
import { radarFrames, satFrames, createRadarAnim } from './radarAnim.js';
import { analyzeRadarMotion, drawMotion, clearMotion } from './radarMotion.js';
import { dirName } from './radarMotionCore.js';
import { createCloudTop3D, LEGEND as CT_LEGEND, CB_ALPHA } from './cloudTop3D.js';
import { createSeaLayer, SST_LEGEND } from './seaLayer.js';
import { createAnalysis3D, ITEMS as AN_ITEMS } from './analysis3D.js';
// 解析3D のボタンの説明
const AN_TIPS = {
  jet: '300〜200hPa で風が一番強い高さに、60kt 以上の帯（60kt はごく薄い赤、100kt 以上は赤、強いほど濃い赤）と中心の軸（滑らかな半透明の管と、中の赤い矢印・最大風速と FL）',
  llj: '850hPa（約 FL050）の 30kt 以上の帯と 40kt 以上の軸（緑）。梅雨期の大雨・下層の揺れの目安',
  front: '気温の差が大きい所（前線帯）を、300hPa 付近（北）から南側の地上付近まで傾いた紫の面で。上の高さほど寒気側へずれる',
  moist: '850・700hPa の湿数（気温−露点）3℃以下の湿域（緑）。AUPQ78 の網かけと同じ基準',
  trop: '気温の下がり方が 2℃/km 以下になる最初の高さ（圏界面の目安）を黄色の面で',
  cold: '500・850hPa の −6℃ 以下を青のグラデーション（低いほど濃い青）。線は 500hPa −30℃（大雪の目安）・−36℃・−6℃、850hPa −6℃（平地で雪の目安）',
  ridge: '500hPa の等高線（60m ごと）と、気圧の谷（太い茶色の点線）・峰（黄土色）の軸',
};
import { chartHistory } from './chartHistory.js';
import { createRadarEcho3D, ECHO_LEGEND, ECHO_LEGEND_ANIME } from './radarEcho3D.js';
import { createFbjp3D } from './fbjp3D.js';
import { createUpperSurf3D, CHART_LEVELS } from './upperSurf3D.js';
import { createCrossSection3D, SECTION_INFO } from './crossSection3D.js';
import { colorSection, legendHtml } from './sectionColor.js';
// 天気図の色塗り（断面図 AXJP・FXJP のモデル値による色付け、AUPQ78 の湿域の塗り）は使わない。戻すときは true に
const PAINT_CHARTS = false;
import { CloudOnlyImageryProvider, CLOUD_ONLY } from './cloudOnly.js';
import { createSatLift } from './satLift3D.js';
import { analyzeSatMotion, satMotionShort, drawSatMotion, clearSatMotion } from './satMotion.js';
import { intlFrames, composeIntl, IntlRadarImageryProvider, intlText, INTL_GUIDE, INTL_RECT, analyzeIntlMotion, intlMotionShort, drawIntlMotion, clearIntlMotion } from './intlRadar.js';
import { fetchTyphoons, typhoonCanvas, drawTyphoon3D, typhoonText } from './typhoon.js';
GUIDES.radarIntl = INTL_GUIDE;
const SECTION_TITLE = Object.fromEntries(Object.entries(SECTION_INFO).map(([k, v]) => [k, v.panels]));

const JMA = 'https://www.jma.go.jp/bosai';
const SAT = `${JMA}/himawari/data/satimg`;
const NOWC = `${JMA}/jmatile/data/nowc`;
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168';
const BOX = { w: 122.5, e: 147.0, s: 23.5, n: 46.0 };     // 一覧の画像の範囲（北海道〜沖縄）

const CSS = `
#awWx{position:absolute;top:50px;right:10px;bottom:190px;width:400px;max-width:calc(100vw - 20px);z-index:20;overflow:auto;background:rgba(20,30,45,.95);color:#fff;
  font:13px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:10px 12px;border-right:4px solid #4fc3f7}
#awWx h2{font-size:15px;margin:0;display:flex;justify-content:space-between;align-items:center;gap:8px}
#awWx h2 button,#awWx .acts button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:2px 8px;cursor:pointer}
#awWx .acts button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
#awWx .upd{font-size:11px;color:#9fb3c8;margin:2px 0 8px}
#awWx .grp{font-size:12px;color:#8fd0ff;margin:12px 0 6px;font-weight:600}
#awWx .it{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
#awWx .th{width:100%;aspect-ratio:4/3;background:#0b141e;border:1px solid #2b3f55;border-radius:6px;overflow:hidden;cursor:zoom-in;display:grid;place-items:center;color:#9fb3c8;font-size:11px}
#awWx .th img,#awWx .th canvas{width:100%;height:100%;object-fit:contain;display:block}
#awWx .meta{display:flex;justify-content:space-between;gap:6px;align-items:baseline}
#awWx .meta b{font-size:12.5px}#awWx .meta span{font-size:11px;color:#9fb3c8;white-space:nowrap}
#awWx .acts{display:flex;gap:6px}
#awWx .row{display:flex;gap:8px;align-items:flex-start}
#awWx .side{flex:none;width:96px;display:flex;flex-direction:column;gap:4px}
#awWx .side .acts{flex-direction:column;gap:4px}
#awWx .side button{font:11.5px/1.3 "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 6px;cursor:pointer;width:100%;text-align:left;white-space:normal}
#awWx .side button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
#awWx .side .sep{height:1px;background:#2b3f55;margin:2px 0}
#awWx .main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
#awWx .hw{background:rgba(143,208,255,.06);border:1px solid #2b3f55;border-radius:6px;padding:8px 10px;font-size:12.5px;line-height:1.6}
#awWx .hw[hidden]{display:none}#awWx .hw h4{margin:6px 0 2px;font-size:12px;color:#8fd0ff}#awWx .hw h4:first-child{margin-top:0}
#awWx .hw ul{margin:0;padding-left:16px}#awWx .hw li{margin:2px 0}
#awWx .it.sel .th{border-color:#4fc3f7;box-shadow:0 0 0 2px #4fc3f7}
#awWx .it.sel .meta b{color:#8fd0ff}
#awWx .gd{background:rgba(255,255,255,.05);border:1px solid #2b3f55;border-radius:6px;padding:8px 10px;font-size:12.5px;line-height:1.6}
#awWx .gd[hidden]{display:none}
#awWx .gd .tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
#awWx .gd .tools button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:2px 8px;cursor:pointer}
#awWx .gd .tools button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
#awWx .gd .tools label{display:flex;align-items:center;gap:4px;font-size:11.5px;color:#9fb3c8}
#awWx .gd .tools input[type=range]{width:90px}
#awWx .gd .ovs{font-size:11px;color:#9fb3c8;margin-bottom:4px}
#awWx .gd h4{margin:8px 0 2px;font-size:12px;color:#8fd0ff}
#awWx .gd ul{margin:0;padding-left:16px}#awWx .gd li{margin:2px 0}
#awWx .gd .now li{color:#ffe082}
#awWx .ct3d .lg{display:flex;height:8px;border-radius:3px;overflow:hidden;margin-top:4px}#awWx .ct3d .lg span{flex:1}
#awWx .ct3d .lgl{display:flex;font-size:10px;color:#9fb3c8}#awWx .ct3d .lgl span{flex:1}
#awWx .ct3d .sty{margin:4px 0 2px}#awWx .ct3d .sty button{font:11.5px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:1px 8px;cursor:pointer}
#awWx .ct3d .note2{font-size:11px;color:#cfe3f5;line-height:1.45}
#awWx .mv{font-size:11.5px;color:#ffe082;line-height:1.45}
#awWx .gd .note{font-size:10.5px;color:#9fb3c8;margin-top:6px}
#awWxModal{position:fixed;inset:16px;z-index:50;background:rgba(10,16,24,.97);border-radius:10px;display:none;flex-direction:column;color:#fff;font:13px "Meiryo",sans-serif}
#awWxModal .bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;gap:10px}
#awWxModal .bar a{color:#8fd0ff}
#awWxModal .bar button{font:inherit;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 10px;cursor:pointer}
#awWxModal .main{flex:1;min-height:0;display:grid;grid-template-columns:1fr 360px;gap:12px;padding:0 12px 12px}
#awWxModal .body{overflow:auto;display:grid;place-items:center;min-width:0}
#awWxModal .guide{overflow:auto;background:rgba(255,255,255,.04);border:1px solid #2b3f55;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.65}
#awWxModal .guide h4{margin:10px 0 4px;font-size:12.5px;color:#8fd0ff}#awWxModal .guide h4:first-child{margin-top:0}
#awWxModal .guide ul{margin:0;padding-left:18px}#awWxModal .guide li{margin:3px 0}
#awWxModal .guide .now li{color:#ffe082}
#awWxModal .guide .note{font-size:11px;color:#9fb3c8;margin-top:10px}
@media (max-width:900px){#awWxModal .main{grid-template-columns:1fr;grid-template-rows:1fr auto}#awWxModal .guide{max-height:40vh}}
#awWxModal .body img,#awWxModal .body canvas{max-width:100%;max-height:100%;background:#fff}
#awWxModal iframe{width:100%;height:100%;border:0;background:#fff}
`;

// ---------- 共通 ----------
const getJSON = async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); };
const fmtJ = s => (s && s.length >= 12 ? `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}Z` : '');
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z * 256;
const loadImg = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ng; im.src = src; });

/** タイル画像を貼り合わせ、北海道〜沖縄の範囲に切り出したキャンバス（空港の位置を重ねる） */
async function composeTiles(tmpl, z, airports, { bg = '#0b141e' } = {}) {
  const X0 = lon2x(BOX.w, z), X1 = lon2x(BOX.e, z), Y0 = lat2y(BOX.n, z), Y1 = lat2y(BOX.s, z);
  const cv = document.createElement('canvas'); cv.width = Math.round(X1 - X0); cv.height = Math.round(Y1 - Y0);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
  const jobs = [];
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor(X1 / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor(Y1 / 256); ty++) {
    const u = tmpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
    jobs.push(loadImg(u).then(im => ctx.drawImage(im, tx * 256 - X0, ty * 256 - Y0)).catch(() => null));
  }
  await Promise.all(jobs);
  // 経緯線と空港
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
  for (let lo = 125; lo <= 145; lo += 5) { const x = lon2x(lo, z) - X0; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
  for (let la = 25; la <= 45; la += 5) { const y = lat2y(la, z) - Y0; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
  ctx.font = `600 ${z >= 5 ? 12 : 10}px Meiryo, sans-serif`;
  for (const a of airports) {
    const x = lon2x(a.lon, z) - X0, y = lat2y(a.lat, z) - Y0;
    ctx.fillStyle = '#4fc3f7'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(a.iata, x + 5, y + 4);
    ctx.fillStyle = '#fff'; ctx.fillText(a.iata, x + 5, y + 4);
  }
  return cv;
}

let pdfjs = null;
// AUPQ78 の湿域（T−Td<3℃）は、図では小さな点の並び（約5pt 間隔の格子）で描かれている。
//   一度 3 倍で描いて点の位置（PDF の座標）を拾い、どの倍率で描いた図にも濃い緑で塗る
const WET_GRID = 4.97;                       // 点の間隔（pt）
const wetCache = new Map();
async function wetDots(url) {
  if (wetCache.has(url)) return wetCache.get(url);
  const S = 3, cv = await renderPdf(url, S), W = cv.width, H = cv.height;
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H); for (let k = 0; k < W * H; k++) dark[k] = (d[k * 4] + d[k * 4 + 1] + d[k * 4 + 2]) / 3 < 150 ? 1 : 0;
  const seen = new Uint8Array(W * H), cand = [];
  for (let k = 0; k < W * H; k++) {
    if (!dark[k] || seen[k]) continue;
    const q = [k]; seen[k] = 1; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, big = false;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % W, y = (c / W) | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (q.length > 16) { big = true; }
      for (const n of [c - 1, c + 1, c - W, c + W, c - W - 1, c - W + 1, c + W - 1, c + W + 1]) if (n >= 0 && n < W * H && dark[n] && !seen[n]) { seen[n] = 1; q.push(n); }
    }
    if (!big && x1 - x0 <= 3 && y1 - y0 <= 3) cand.push([(x0 + x1) / 2 / S, (y0 + y1) / 2 / S]);
  }
  // 格子の間隔で隣に点がある所だけを湿域の点とする（文字の点や記号を除く）
  const key = (x, y) => `${Math.round(x / 2)},${Math.round(y / 2)}`, idx = new Map();
  for (const p of cand) { const kk = key(...p); (idx.get(kk) || idx.set(kk, []).get(kk)).push(p); }
  const near = (x, y) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const p of idx.get(`${Math.round(x / 2) + dx},${Math.round(y / 2) + dy}`) || []) if (Math.hypot(p[0] - x, p[1] - y) < 1.2) return true; return false; };
  const dots = cand.filter(([x, y]) => near(x + WET_GRID, y) || near(x - WET_GRID, y) || near(x, y + WET_GRID) || near(x, y - WET_GRID));
  wetCache.set(url, dots);
  return dots;
}
/** 描いた図（倍率 scale）に、湿域を濃い緑で塗る（黒い線・文字は黒のまま残る「掛け合わせ」） */
function paintWet(cv, scale, dots) {
  const g = cv.getContext('2d'), w = WET_GRID * scale;
  g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(40,150,60)';
  for (const [x, y] of dots) g.fillRect((x - WET_GRID / 2) * scale, (y - WET_GRID / 2) * scale, w + 0.5, w + 0.5);
  g.restore();
}
async function renderPdf(url, scale, { wet = false } = {}) {
  if (wet) { const cv = await renderPdf(url, scale); try { paintWet(cv, scale, await wetDots(url)); } catch (e) { console.warn('[wet]', e); } return cv; }
  pdfjs ||= await import(/* @vite-ignore */ `${PDFJS}/pdf.min.mjs`).then(m => { m.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`; return m; });
  const doc = await pdfjs.getDocument({ url, withCredentials: false }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
  // 描画が止まったとき（タブが裏にある等）は諦めて代替表示にする
  // intent:'print' … 画面の描画周期（requestAnimationFrame）を使わないので、タブが裏でも止まらない
  await Promise.race([page.render({ canvasContext: cv.getContext('2d'), viewport: vp, intent: 'print' }).promise,
    new Promise((_, ng) => setTimeout(() => ng(new Error('render timeout')), 20000))]);
  return cv;
}

/** 高層天気図の最新の解析時刻（00UTC / 12UTC、公開まで約3時間） */
const fmtInit = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}UTC`;
function upperCycle(now = new Date()) {
  const h = now.getUTCHours();
  return h >= 15 || h < 3 ? '12' : '00';
}

// ---------- パネル ----------
export function initChartsPanel(viewer, { airports = [] } = {}) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const P = Object.assign(document.createElement('div'), { id: 'awWx' });
  const MD = Object.assign(document.createElement('div'), { id: 'awWxModal' });
  MD.innerHTML = `<div class="bar"><b id="awWxMT"></b><span><a id="awWxML" target="_blank" rel="noopener">元の画像を開く</a>　<button id="awWxMC">閉じる</button></span></div><div class="main"><div class="body" id="awWxMB"></div><div class="guide" id="awWxMG"></div></div>`;
  document.body.append(P, MD);
  MD.querySelector('#awWxMC').onclick = () => { MD.style.display = 'none'; MD.querySelector('#awWxMB').innerHTML = ''; MD.querySelector('#awWxMG').innerHTML = ''; };

  const layers = {};       // 地図に重ねたレイヤ
  const rect = Cesium.Rectangle.fromDegrees(118, 20, 152, 48);

  // 一覧の定義（取得関数は {src | canvas, time, open, tiles} を返す）
  const items = [
    { grp: '地上', id: 'sfc', title: '地上天気図（実況・72時間）', get: async () => {
      // 過去72時間の実況（3〜6時間ごと。気象庁の一覧にある分）を、古い順に並べて動画にする
      const j = await getJSON(`${JMA}/weather_map/data/list.json`);
      const tOf = f => /_(\d{14})_MET/.exec(f)?.[1];
      const all = [...(j.near?.now || [])].sort((a, b) => tOf(a).localeCompare(tOf(b)));
      const f = all.at(-1), t = tOf(f);
      const ms = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
      const frames = all.filter(x => ms(t) - ms(tOf(x)) <= 72 * 3600e3).map(x => ({ src: `${JMA}/weather_map/data/png/${x}`, t: tOf(x) }));
      return { src: `${JMA}/weather_map/data/png/${f}`, time: t ? fmtJ(t) : '', frames };
    } },
    { grp: '地上', id: 'sfc24', title: '地上天気図（24時間予想）', get: async () => {
      const j = await getJSON(`${JMA}/weather_map/data/list.json`);
      const f = [...(j.near?.ft24 || [])].sort().at(-1);
      const t = /_(\d{14})_MET/.exec(f)?.[1];
      return { src: `${JMA}/weather_map/data/png/${f}`, time: t ? `${fmtJ(t)} 初期値` : '' };
    } },
    ...[['aupq78', '850hPa・700hPa 高層天気図（AUPQ78）'], ['aupq35', '500hPa・300hPa 高層天気図（AUPQ35）'],
        ['aupa25', '250hPa 高層天気図（AUPA25）'], ['aupa20', '200hPa 高層天気図（AUPA20）']].map(([code, title]) => ({
      grp: '高層', id: code, title, pdf: true, get: async () => {
        const cyc = upperCycle();
        // 過去のコマ：アプリを開くたびに記録してためる（最大72時間。chartHistory.js）
        const frames = await chartHistory(code, `${JMA}/numericmap/data/nwpmap/${code}`).catch(() => []);
        return { pdf: `${JMA}/numericmap/data/nwpmap/${code}_${cyc}.pdf`, time: `${cyc}UTC 解析`, frames };
      } })),
    ...[['fxfe502', '極東 500hPa高度・渦度／地上気圧・降水量 12・24時間予想（FXFE502）'],
        ['fxfe5782', '極東 500hPa気温・700hPa湿数／850hPa気温・風・700hPa上昇流 12・24時間予想（FXFE5782）'],
        ['fxjp854', '日本 850hPa相当温位・風 12・24・36・48時間予想（FXJP854）'],
        ['fupa252', '250hPa 24時間予想（FUPA252、アジア太平洋）'], ['fupa302', '300hPa 24時間予想（FUPA302、アジア太平洋）'],
        ['fupa502', '500hPa 24時間予想（FUPA502、アジア太平洋）']].map(([code, title]) => ({
      grp: '予想図', id: code, title, pdf: true, get: async () => {
        const cyc = upperCycle(), now = new Date();
        const init = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), +cyc));
        if (init > now) init.setUTCDate(init.getUTCDate() - 1);
        return { pdf: `${JMA}/numericmap/data/nwpmap/${code}_${cyc}.pdf`, time: `${fmtInit(init)} 初期値`, init };
      } })),
    { grp: '断面図', id: 'axjp', section: true, title: '高層断面図 東経140度・130度（AXJP140/130）', pdf: true, get: async () => {
      const cyc = upperCycle(), now = new Date();
      const init = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), +cyc));
      if (init > now) init.setUTCDate(init.getUTCDate() - 1);
      const frames = await chartHistory('axjp140', `${JMA}/numericmap/data/nwpmap/axjp140`).catch(() => []);
      return { pdf: `${JMA}/numericmap/data/nwpmap/axjp140_${cyc}.pdf`, time: `${fmtInit(init)} 解析`, init, frames };
    } },
    { grp: '断面図', id: 'fxjp', section: true, title: '国内航空路 6・12時間予想断面図（FXJP106/112）', get: async () => {
      // 初期時刻は3時間ごと。公開は約2時間15分後。新しい図がまだなければ一つ前の時刻にする
      const step = 3 * 3600e3;
      let init = new Date(Math.floor((Date.now() - 2.25 * 3600e3) / step) * step);
      for (let k = 0; k < 2; k++) {
        const u = `https://www.data.jma.go.jp/airinfo/data/pict/nwp/fxjp106_${String(init.getUTCHours()).padStart(2, '0')}.png`;
        try {
          const h = await fetch(u, { method: 'HEAD', cache: 'no-store' });
          const lm = new Date(h.headers.get('last-modified') || 0);
          if (h.ok && lm >= init) return { src: `${u}?t=${init.getTime()}`, time: `${fmtInit(init)} 初期値`, init };
        } catch { /* 時刻が確かめられないときは前の時刻を試す */ }
        init = new Date(init.getTime() - step);
      }
      throw new Error('最新の図が見つかりません');
    } },
    { grp: '台風', id: 'typhoon', title: '台風進路予想図（気象庁）', get: async () => {
      const [tcs, t] = await Promise.all([fetchTyphoons(), getJSON(`${SAT}/targetTimes_fd.json`).then(a => a.at(-1)).catch(() => null)]);
      const iss = tcs[0]?.issue ? new Date(tcs[0].issue) : null;
      return { typhoon: true, tcs, irTiles: t ? `${SAT}/${t.basetime}/fd/${t.validtime}/B13/TBB/{z}/{x}/{y}.jpg` : null,
        time: tcs.length ? `${iss ? `${iss.getMonth() + 1}/${iss.getDate()} ${String(iss.getHours()).padStart(2, '0')}:${String(iss.getMinutes()).padStart(2, '0')} 発表（日本時間）` : ''}` : '発表中の台風なし' };
    } },
    { grp: '航空', id: 'fbjp', title: '国内悪天予想図（FBJP）', get: async () => ({ src: `https://www.data.jma.go.jp/airinfo/data/pict/fbjp/fbjp.png?t=${Date.now()}`, time: '最新' }) },
    { grp: '衛星・レーダー', id: 'vis', title: '衛星 可視画像', overlay: true, get: async () => {
      const frames = await satFrames('B03/ALBD'), t = frames.at(-1);
      return { tiles: t.tiles, time: fmtJ(t.time) + '（夜間は暗くなります）', maxLevel: 5, frames };
    } },
    { grp: '衛星・レーダー', id: 'ir', title: '衛星 赤外画像', overlay: true, get: async () => {
      const frames = await satFrames('B13/TBB'), t = frames.at(-1);
      return { tiles: t.tiles, time: fmtJ(t.time), maxLevel: 5, frames };
    } },
    { grp: '衛星・レーダー', id: 'radar', title: 'レーダーエコー（降水強度・6時間）', overlay: true, get: async () => {
      const frames = await radarFrames();            // 過去6時間・10分ごと
      const t = frames.at(-1);
      return { tiles: t.tiles, time: fmtJ(t.time), maxLevel: 10, frames };
    } },
    { grp: '衛星・レーダー', id: 'radarIntl', title: '海外レーダー（東アジア・東南アジア・西太平洋・最大6時間）', overlay: true, get: async () => {
      const frames = await intlFrames();             // 最大6時間・20分ごと（RainViewer。公開は2時間分、それより前は端末に記録した分）
      const t = frames.at(-1);
      return { tiles: t.tiles, time: fmtJ(t.time), maxLevel: 6, frames, intl: true };
    } },
  ];
  const state = {};

  // 図の左に縦に並べるボタン（いつも表示）
  const ANIM_IDS = ['vis', 'ir', 'radar', 'radarIntl'];
  const IMG_ANIM_IDS = ['sfc', 'aupq78', 'aupq35', 'aupa25', 'aupa20', 'axjp'];   // 画像・PDF の天気図の動画（imgAnim）
  function sideHtml(i) {
    const b = [];
    if (i.overlay) {
      b.push(`<button data-ov="${i.id}" aria-pressed="false">地図に重ねる</button>`);
      if (i.id === 'vis' || i.id === 'ir') b.push('<button data-liftmode aria-pressed="true" title="3D（高度を誇張）のとき、衛星の雲を雲頂の高さに持ち上げるか、地表に貼るかを切り替える。持ち上げた雲は高い所にあるので、斜めから見ると地表の位置からずれて見える（真上から見ると重なる）。地表には本当の位置を薄く残す">3D：雲頂の高さ</button>');
      if (ANIM_IDS.includes(i.id)) b.push('<button data-combo aria-pressed="false" title="衛星画像（赤外。可視を重ねていれば可視）・レーダーエコー（気象庁）・海外レーダーを一緒に地図に重ね、同じ時刻で再生する。下から 衛星の雲 → 海外レーダー → 気象庁のレーダー の順（3D のときは衛星の雲を雲頂の高さに持ち上げる）">衛星・レーダーを重ねる</button>');
    }
    if (i.section) {
      b.push(`<button data-xs3d="${i.id}" aria-pressed="false" title="断面図を、地図の上に縦の壁として立てて表示">3Dで表示</button>`);
      if (i.id === 'fxjp') b.push('<button data-xsp="6" aria-pressed="true">6時間</button><button data-xsp="12" aria-pressed="false">12時間</button>');
      else b.push('<button data-xsa="both" aria-pressed="true">両方</button><button data-xsa="140" aria-pressed="false">140°E</button><button data-xsa="130" aria-pressed="false">130°E</button>');
      b.push(`<button data-xsside="${i.id}" data-north="right" title="壁を真横から見る（北が右）">真横から（北が右）</button>`);
      if (i.id === 'axjp') b.push('<button data-xsside="axjp" data-north="left" title="元の図と同じ向き（北が左）。図の文字が読める">真横から（北が左）</button>');
    }
    if (i.id === 'fbjp') b.push('<button data-fb3d aria-pressed="false" title="ジェット気流・CAT・揺れのある雲を、読み取った高さで立体表示">3Dで表示</button>');
    if (b.length) b.push('<div class="sep"></div>');
    b.push(`<button data-how="${i.id}" aria-pressed="false" title="この図の見方と、航空での見どころ">見方・見どころ</button>`);
    b.push(`<button data-zoomi="${i.id}" title="大きく表示">拡大</button>`);
    return b.join('');
  }
  // 図の下に出す状態表示（動きの解析・色の凡例・3D の説明など）
  function statusHtml(i) {
    let h = '';
    if (i.id === 'radar') h += '<div class="mv" id="awRadarMv"></div>';
    if (i.id === 'radarIntl') h += '<div class="mv" id="awIntlMv"></div>';
    if (i.id === 'vis' || i.id === 'ir') h += '<div class="mv" data-satmv></div>';
    if (i.section) h += `<div class="mv" id="awXsCol-${i.id}" style="font-size:11px"></div><div class="mv" id="awXs3dSt-${i.id}"></div>`;
    if (i.id === 'fbjp') h += '<div class="mv" id="awFb3dSt"></div>';
    // 雲・エコーの3D表示（雲頂の高さで3D・エコーを3D）はやめた。雲の3Dは悪天予想図（FBJP）の「3Dで表示」だけ
    return h;
  }

  P.innerHTML = `<h2>天気図・画像 <button id="awWxR">最新に更新</button></h2><div class="upd" id="awWxU"></div>` +
    [...new Set(items.map(i => i.grp))].map(g => `<div class="grp">${g}</div>` + items.filter(i => i.grp === g).map(i => `
      <div class="it" data-id="${i.id}">
        <div class="row">
          <div class="side">${sideHtml(i)}</div>
          <div class="main">
            <div class="th" id="awTh-${i.id}" title="クリックで自動解析と地図への重ね表示">読み込み中…</div>
            ${ANIM_IDS.includes(i.id) || IMG_ANIM_IDS.includes(i.id) ? `<div class="rp" id="awAnimBar-${i.id}"></div>` : ''}
            <div class="meta"><b>${i.title}</b><span id="awTm-${i.id}"></span></div>
          </div>
        </div>
        ${statusHtml(i)}
        <div class="hw" id="awHw-${i.id}" hidden></div>
        <div class="gd" id="awGd-${i.id}" hidden></div>
      </div>`).join('')).join('');
  buildDash();

  // 「気象の表示」の段（2026-10-17）：画面右下にあった気象のボタンを、この一覧の上にまとめる。
  //   右下は地図の操作（視点・向き・高度・空域・航法・FIR・山）だけにする。
  //   ボタンは index.html の要素をそのまま移すので、押したときの処理（main.js・このファイル）は変わらない
  function buildDash() {
    const st3 = document.createElement('style');
    st3.textContent = `#awWxDash{position:sticky;top:-10px;z-index:3;margin:0 -12px 6px;padding:6px 12px 7px;background:rgba(20,30,45,.98);border-bottom:1px solid #2b3f55}
      #awWxDash .dr{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:2px 0}
      #awWxDash .dl{font-size:10.5px;color:#8fd0ff;width:64px;flex:none}
      #awWxDash button{font:11.5px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 8px;cursor:pointer;white-space:nowrap}
      #awWxDash button:hover{border-color:#8fd0ff}
      #awWxDash button.on,#awWxDash button[aria-pressed="true"]{background:#1e3a5f;border-color:#4fc3f7}
      #awWxDash button:disabled{opacity:.45;cursor:default}
      #awWxDash #upper3dBtns{display:flex;flex-wrap:wrap;gap:4px}
      #awWxDash #upper3dSt,#awWxDash #ct3dSt{font:11px/1.5 "Meiryo",sans-serif;color:#cfe3f5;text-shadow:none;text-align:left;max-width:none;margin-top:3px}
      #awWxDash #upper3dSt:empty,#awWxDash #ct3dSt:empty{display:none}`;
    document.head.appendChild(st3);
    const D = document.createElement('div'); D.id = 'awWxDash';
    D.innerHTML = `<div class="dr" data-r="sat"><span class="dl">衛星・レーダー</span><button data-combo aria-pressed="false" title="衛星画像（赤外。可視を重ねていれば可視）・レーダーエコー（気象庁）・海外レーダーを一緒に地図に重ね、同じ時刻で再生する">衛星・レーダーを重ねる</button></div>
      <div class="dr" data-r="sigwx"><span class="dl">悪天予想図</span></div>
      <div class="dr" data-r="gpv"><span class="dl">数値予報</span></div>
      <div class="dr" data-r="upper"><span class="dl">高層3D</span></div>
      <div class="dr" data-r="sea"><span class="dl">海洋</span><button data-sea="sst" aria-pressed="false" title="海面水温（NASA GIBS・GHRSST MUR、約1km・毎日）を地図に重ねる。マウスを載せた所の水温を表示">🌊 海面水温</button><button data-sea="cur" aria-pressed="false" title="日本付近〜西太平洋の主な海流（黒潮・親潮・対馬海流など）の平均的な流れを、矢印と名前で表示（暖流は赤、寒流は青）">海流名</button></div>
      <div id="awSeaSt" style="font-size:11px;color:#cfe3f5;margin-top:3px"></div>
      <div class="dr" data-r="an"><span class="dl" title="数値予報（気象庁 GSM の解析）から、天気図で読む構造を自動で求めて立体で表示">解析3D</span>${AN_ITEMS.map(([k, t]) => `<button data-an="${k}" aria-pressed="false" title="${AN_TIPS[k]}">${t}</button>`).join('')}</div>
      <div id="awAnSt" style="font-size:11px;color:#cfe3f5;margin-top:3px"></div>`;
    P.querySelector('#awWxU').after(D);
    const $id = id => document.getElementById(id), row = r => D.querySelector(`[data-r="${r}"]`);
    const move = (id, r) => { const e = $id(id); if (e) row(r).appendChild(e); return e; };
    // 右下の段（元の場所）。移した後に空になる段は隠す
    const rowOf = id => $id(id)?.closest('#camButtons .btnRow');
    const oldRows = ['fbjpLayerBtn', 'upper3dBtns', 'chartBtns'].map(rowOf);
    move('ct3dBtn', 'sat');
    move('fbjpLayerBtn', 'sigwx'); move('sigwxBtn', 'sigwx');
    move('gpvBtn', 'gpv');
    move('upper3dBtns', 'upper');
    for (const id of ['upper3dSt', 'ct3dSt']) { const e = $id(id); if (e) D.appendChild(e); }
    oldRows.forEach(r => { if (r) r.style.display = 'none'; });     // 「レイヤ」（事例用のボタンだけ）・「高層3D」・「天気図」（一覧と同じ）
    const lbl = rowOf('mountainBtn')?.querySelector('.rowLabel'); if (lbl) lbl.textContent = '地図';
    // 海洋：海面水温・海流名
    const stEl = D.querySelector('#awSeaSt');
    const say = () => {
      const t = [sea.sstOn && seaMsg, sea.currentsOn && '海流：平均的な流れの模式図（赤＝暖流、青＝寒流）。実際の流路（黒潮の大蛇行など）は海面水温の図で確かめる'].filter(Boolean);
      stEl.innerHTML = t.join('<br>') + (sea.sstOn ? `<br><img src="${SST_LEGEND}" alt="海面水温の凡例（℃）" style="width:100%;max-width:330px;background:#fff;border-radius:4px;margin-top:3px">` : '');
    };
    let seaMsg = '';
    const sea = createSeaLayer(viewer, { onStatus: t => { seaMsg = t; say(); } });
    D.querySelectorAll('[data-sea]').forEach(b => b.onclick = async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      const now = b.dataset.sea === 'sst' ? await sea.setSst(on) : sea.setCurrents(on);
      b.setAttribute('aria-pressed', now); say();
    });
    // 解析3D：ジェット気流・下層ジェット・前線帯・湿域・圏界面・寒気・500hPa の谷・峰
    const anSt = D.querySelector('#awAnSt');
    const an = createAnalysis3D(viewer, { onStatus: t => { anSt.textContent = t; } });
    D.querySelectorAll('[data-an]').forEach(b => b.onclick = async () => {
      const want = b.getAttribute('aria-pressed') !== 'true';
      b.disabled = true;
      try { b.setAttribute('aria-pressed', await an.set(b.dataset.an, want)); } finally { b.disabled = false; }
    });
  }

  // レーダーの6時間アニメーション（一覧の図と地図の両方を動かす）
  const radarThumb = P.querySelector('#awTh-radar');
  const anim = createRadarAnim(viewer, {
    rect, thumbEl: radarThumb, barEl: P.querySelector('#awAnimBar-radar'),
    compose: tiles => composeTiles(tiles, 5, airports, { bg: '#1b2633' }), stepMs: [280, 1500],   // 37コマあるので速めに
    onTime: (t, latest) => { const tm = P.querySelector('#awTm-radar'); if (tm) tm.textContent = fmtJ(t) + (latest ? '' : '（過去）'); syncTimes('radar', t); },
  });
  // 衛星（可視・赤外）の6時間アニメーション。地図には雲だけを残して重ねる（z5 まで・範囲は切らない）
  const anims = { radar: anim };
  for (const id of ['vis', 'ir']) {
    anims[id] = createRadarAnim(viewer, {
      thumbEl: P.querySelector(`#awTh-${id}`), barEl: P.querySelector(`#awAnimBar-${id}`),
      compose: tiles => composeTiles(tiles, 4, airports, { bg: '#0b141e' }), stepMs: [500, 1500],
      makeProvider: f => new CloudOnlyImageryProvider({ url: f.tiles, maximumLevel: 5, minimumLevel: 0, credit: new Cesium.Credit('気象庁'), cloud: CLOUD_ONLY[id] }),
      onTime: (t, latest) => { const tm = P.querySelector(`#awTm-${id}`); if (tm) tm.textContent = fmtJ(t) + (latest ? '' : '（過去）'); setTimeout(syncLift, 0); syncTimes(id, t); },
    });
  }
  // レーダーと衛星を同時に重ねているときは、同じ時刻（その時刻より前で一番近いコマ）にそろえる
  //   どちらかの再生バーを動かす・再生すると、もう一方がついてくる
  var syncing = false;
  function syncTimes(from, t) {
    if (syncing || !anims[from]?.onMap) return;
    syncing = true;
    try {
      for (const id of ['radar', 'vis', 'ir', 'radarIntl']) {
        if (id === from || !anims[id]?.onMap) continue;
        const fr = anims[id].frames || [];
        let k = -1; fr.forEach((f, i) => { if (f.time <= t) k = i; });
        if (k >= 0 && anims[id].current?.time !== fr[k].time) anims[id].setFrame(k);
      }
    } finally { syncing = false; }
  }
  // 3D（高度倍率 > 1）のときは、地表に貼った衛星画像の代わりに、雲頂の高さに持ち上げた画像を出す（立体の雲・経路と位置を合わせる）
  const lift = createSatLift(viewer);
  let liftOrder = [];                         // 最後に重ねた衛星の種類を優先
  function syncLift() {
    const on = ['vis', 'ir'].filter(id => anims[id]?.onMap);
    liftOrder = liftOrder.filter(id => on.includes(id)); for (const id of on) if (!liftOrder.includes(id)) liftOrder.push(id);
    const id = liftOrder.at(-1), sc = window.awGetAltScale?.() ?? 1, up = sc > 1 && !!id && liftMode === 'lift';
    // 持ち上げた雲は高度倍率のぶん高い所にあるため、斜めから見ると地表の位置から手前・上にずれて見える。
    //   地表の画像を薄く残して、雲の本当の位置（真下）を示す
    for (const k of ['vis', 'ir']) anims[k]?.setHidden?.(up ? (k === id ? 0.35 : true) : false);
    if (up) lift.show(anims[id].current, id); else lift.hide();
    P.querySelectorAll('[data-liftmode]').forEach(b => { b.setAttribute('aria-pressed', liftMode === 'lift'); b.textContent = liftMode === 'lift' ? '3D：雲頂の高さ' : '3D：地表に貼る'; });
  }
  let liftMode = 'lift';                      // 3D のときの衛星の雲：'lift'＝雲頂の高さに持ち上げる、'ground'＝地表に貼る
  P.querySelectorAll('[data-liftmode]').forEach(b => { b.onclick = () => { liftMode = liftMode === 'lift' ? 'ground' : 'lift'; syncLift(); }; });
  // 衛星の雲の動きと種類（自動解析）。衛星を地図に重ねている間は矢印も出す
  let satMotionRes = null, satMotionP = null;
  const satArrows = () => { if (satMotionRes && (anims.vis.onMap || anims.ir.onMap)) drawSatMotion(viewer, satMotionRes); else clearSatMotion(viewer); };
  function startSatMotion(frames) {
    const els = P.querySelectorAll('[data-satmv]');
    els.forEach(e => { e.textContent = '雲の動きと種類を解析しています…'; });
    satMotionP = analyzeSatMotion(frames, airports).then(res => {
      satMotionRes = res;
      els.forEach(e => { e.textContent = satMotionShort(res); });
      satArrows();
      document.querySelectorAll('[data-sat-motion]').forEach(fillSatMotion);
      return res;
    }).catch(e => { els.forEach(x => { x.textContent = `雲の動きを解析できません（${e.message}）`; }); throw e; });
    satMotionP.catch(() => {});
  }
  function fillSatMotion(u) {
    if (!satMotionP) { u.innerHTML = li(['衛星画像を読み込み中です。']); return; }
    satMotionP.then(res => {
      u.innerHTML = li([`（ひまわりの赤外画像の、最新と${res.lags.join('分前・')}分前を比べて雲域ごとの動きを推定。雲の種類は雲頂温度・雲頂の凸凹・広さ${res.day ? '・可視画像の明るさ（雲の厚さ）' : ''}から判別。地図の矢印の先は、このまま進んだときの2時間後の位置）`,
        ...res.lines,
        `<span style="color:#9fb3c8">${res.day ? '' : '夜間は可視画像がないため、下層雲（積雲・層積雲・霧）の解析は休み、巻雲と厚い雲の区別も赤外だけの推定で不確か。'}雲頂の高さは雲頂温度を標準大気に当てはめた目安。種類の判別は自動の簡易推定で、地上・上空の実況や SIGMET と合わせて確認する。</span>`]);
    }).catch(e => { u.innerHTML = li([`解析できませんでした（${e.message}）。`]); });
  }
  for (const id of ['vis', 'ir']) {
    const a = anims[id], so = a.showOnMap, ho = a.hideFromMap;
    a.showOnMap = (...x) => { const r = so(...x); setTimeout(syncLift, 0); satArrows(); return r; };
    a.hideFromMap = (...x) => { const r = ho(...x); setTimeout(syncLift, 0); satArrows(); return r; };
  }
  window.addEventListener('aw:altscale', () => setTimeout(syncLift, 0));
  // 海外レーダー（RainViewer）の2時間アニメーション。配信元の回数制限（毎分100回）があるので、地図のレイヤは表示するコマだけ作る
  anims.radarIntl = createRadarAnim(viewer, {
    thumbEl: P.querySelector('#awTh-radarIntl'), barEl: P.querySelector('#awAnimBar-radarIntl'),
    compose: tiles => composeIntl(tiles, 3), stepMs: [500, 1500], lazy: true,
    makeProvider: f => new IntlRadarImageryProvider({ url: f.tiles, maximumLevel: 6 }),
    onLayerAdded: () => restack(),            // 衛星の雲より上、気象庁のレーダーより下
    onTime: (t, latest) => { const tm = P.querySelector('#awTm-radarIntl'); if (tm) tm.textContent = fmtJ(t) + (latest ? '' : '（過去）'); syncTimes('radarIntl', t); },
  });
  // 海外レーダーの雨域の動き（地図に重ねている間は矢印も出す）
  let intlMotionRes = null, intlMotionP = null;
  {
    const a = anims.radarIntl, so = a.showOnMap, ho = a.hideFromMap;
    a.showOnMap = (...x) => { const r = so(...x); if (intlMotionRes) drawIntlMotion(viewer, intlMotionRes); return r; };
    a.hideFromMap = (...x) => { const r = ho(...x); clearIntlMotion(viewer); return r; };
  }
  function startIntlMotion(frames) {
    const mvEl = P.querySelector('#awIntlMv');
    if (mvEl) mvEl.textContent = '海外エコーの動きを解析しています…';
    intlMotionP = analyzeIntlMotion(frames).then(res => {
      intlMotionRes = res;
      if (mvEl) mvEl.textContent = intlMotionShort(res);
      if (anims.radarIntl.onMap) drawIntlMotion(viewer, res);
      document.querySelectorAll('[data-intl-motion]').forEach(fillIntlMotion);
      return res;
    }).catch(e => { if (mvEl) mvEl.textContent = `海外エコーの動きを解析できません（${e.message}）`; throw e; });
    intlMotionP.catch(() => {});
  }
  function fillIntlMotion(u) {
    if (!intlMotionP) { u.innerHTML = li(['海外レーダーを読み込み中です。']); return; }
    intlMotionP.then(res => {
      const n = anims.radarIntl.frames?.length || 0;
      u.innerHTML = li([`（動きは${res.lags.join('分前・')}分前の図との比較から推定。地図の矢印の先は、このまま進んだときの2時間後の位置。橙の矢印は発達中。日本付近は国内のレーダーの解析を参照）`,
        ...res.lines, `<span style="color:#9fb3c8">再生できるのは ${n} コマ（20分ごと・約${Math.round(Math.max(0, n - 1) * 20 / 60 * 10) / 10}時間分）。配信元（RainViewer）が公開しているのは過去2時間分のため、それより前は、このアプリを開いている間に記録した分だけ（最大6時間）。</span>`]);
    }).catch(e => { u.innerHTML = li([`解析できませんでした（${e.message}）。`]); });
  }
  const btnOn = { radar: false, vis: false, ir: false, radarIntl: false };   // 「地図に重ねる」ボタンで重ねているか
  let radarBtnOn = false;                    // 「地図に重ねる」ボタンで重ねているか（レーダー）
  // エコーの動きの解析（最新・30分前・60分前を比べる）
  let motionRes = null, motionP = null;
  const motionShort = res => {
    if (!res.cells.length) return 'エコーの動き：まとまった雨域なし';
    return 'エコーの動き：' + res.cells.slice(0, 3).map((c, k) => `${'①②③'[k]}${!c.motion ? '不明' : c.motion.speed < 8 ? '停滞' : `${dirName(c.motion.dir)}へ${Math.round(c.motion.speed / 5) * 5}km/h`}`).join('・') +
      '（詳しくは図をクリック）';
  };
  function startMotion(frames) {
    const mvEl = P.querySelector('#awRadarMv');
    if (mvEl) mvEl.textContent = 'エコーの動きを解析しています…';
    motionP = analyzeRadarMotion(frames, airports).then(res => {
      motionRes = res;
      if (mvEl) mvEl.textContent = motionShort(res);
      if (anim.onMap) drawMotion(viewer, res);
      if (echo3d?.on) echo3d.refresh().catch(() => {});
      if (ct3d?.on) ct3d.show().catch(() => {});
      P.querySelectorAll('[data-motion]').forEach(fillMotion);
      MD.querySelectorAll('[data-motion]').forEach(fillMotion);
      return res;
    }).catch(e => { if (mvEl) mvEl.textContent = `エコーの動きを解析できません（${e.message}）`; throw e; });
    motionP.catch(() => {});
  }
  function fillMotion(u) {
    if (!motionP) { u.innerHTML = li(['レーダーを読み込み中です。']); return; }
    motionP.then(res => {
      const cbLine = res.cbError ? `雲頂高度は推定できませんでした（${res.cbError}）。`
        : res.cbs.length ? `発達した積乱雲（20mm/h以上のエコー × 雲頂温度−40℃以下）：${res.cbs.length}か所。地図に雲頂の高さまでの円柱で表示（赤＝非常に発達）。`
        : '発達した積乱雲（20mm/h以上のエコー × 雲頂温度−40℃以下）は見つかりません。';
      u.innerHTML = li([`（動きは${res.lags.join('分前・')}分前の図との比較から推定。地図の矢印の先は、このまま進んだときの2時間後の位置。橙の矢印は発達中）`, cbLine, ...res.lines,
        `<span style="color:#9fb3c8">推定雲頂＝ひまわり赤外（${res.irTime ? fmtJ(res.irTime) : '—'}）の雲頂温度を、気象庁モデルの気温の鉛直分布に当てはめた気圧高度。厚い雲向けの推定で誤差は±FL30〜60程度。薄い巻雲は低めに出る。</span>`]);
    })
      .catch(e => { u.innerHTML = li([`解析できませんでした（${e.message}）。`]); });
  }
  const showRadarMap = alpha => { anim.showOnMap(alpha); if (motionRes) drawMotion(viewer, motionRes); };
  const hideRadarMap = () => { anim.hideFromMap(); clearMotion(viewer); };

  // 画像・PDF の天気図の動画：一覧の図と、地図に重ねている図の両方を動かす
  //   地上天気図の実況：気象庁の一覧にある過去72時間（3〜6時間ごと）
  //   高層天気図（AUPQ78・AUPQ35・AUPA25・AUPA20）・高層断面図（AXJP）：ブラウザに記録してためた分（12時間ごと・最大72時間）
  const imgAnims = {};
  function imgAnim(i, r, thumbImg, { pdf = false } = {}) {
    imgAnims[i.id]?.stop();
    const bar = P.querySelector(`#awAnimBar-${i.id}`); if (!bar) return;
    const F = r.frames, last = F.length - 1;
    const label = f => (pdf ? `${fmtInit(new Date(f.t))} 解析` : fmtJ(f.t));
    if (F.length < 2) {
      bar.innerHTML = `<span class="ld">動画：記録した ${F.length} コマ（アプリを開くたびに 00UTC・12UTC の図をためます。最大72時間）</span>`;
      imgAnims[i.id] = { stop() {} };
      return;
    }
    const imgs = pdf ? null : F.map(f => { const im = new Image(); im.crossOrigin = 'anonymous'; im.src = f.src; return im; });   // 先に読み込んでおく
    const thumbs = new Map(), hiRes = new Map(), warpCache = new Map();
    const thumbOf = n => { if (!thumbs.has(n)) thumbs.set(n, renderPdf(F[n].url, 0.6)); return thumbs.get(n); };
    const srcOf = async n => {                             // 地図に重ねる元の図
      if (!pdf) { const im = imgs[n]; if (!im.complete || !im.naturalWidth) await new Promise((ok, ng) => { im.onload = ok; im.onerror = ng; }); return im; }
      if (!hiRes.has(n)) { hiRes.set(n, renderPdf(F[n].url, PDF_SCALE)); if (hiRes.size > 3) hiRes.delete(hiRes.keys().next().value); }
      return hiRes.get(n);
    };
    let k = last, timer = null, seq = 0;
    bar.innerHTML = `<button data-a="prev" title="1つ前">◀</button><button data-a="play" title="再生／停止">▶</button><button data-a="next" title="1つ後">▶|</button>
      <input type="range" min="0" max="${last}" value="${last}" title="時刻"><span class="tl"></span>`;
    const rng = bar.querySelector('input'), pb = bar.querySelector('[data-a="play"]'), tl = bar.querySelector('.tl');
    async function overlay(n) {                           // 地図に重ねているときは、そのコマに入れ替える（新しい図を出してから古い図を消す）
      if (sel.id !== i.id || !sel.layer || sel.layer._awRadar || sel.layer._awSat || sel.layer._awTyphoon) return;
      const pj = PROJ[i.id]; if (!pj) return;
      const P2 = pj.panels ? pj.panels[sel.level] : pj;
      const my = ++sel.seq;
      try {
        const key = `${n}|${sel.style}|${sel.level}`;
        let w = warpCache.get(key);
        if (!w) {
          w = warpChart(await srcOf(n), P2, { s: pdf ? PDF_SCALE : 1, outW: pdf ? 2048 : 1600, style: sel.style });
          warpCache.set(key, w); if (warpCache.size > 8) warpCache.delete(warpCache.keys().next().value);
        }
        const lay = await addChartLayer(viewer, w, { alpha: sel.alpha });
        if (my !== sel.seq || sel.id !== i.id) { removeChartLayer(viewer, lay); return; }
        const old = sel.layer; sel.layer = lay; anim.raise();
        setTimeout(() => removeChartLayer(viewer, old), 250);
      } catch (e) { console.warn('[chart anim]', i.id, e); }
    }
    async function show(n) {
      const my = ++seq;
      k = Math.max(0, Math.min(last, n));
      const f = F[k];
      rng.value = k; tl.textContent = `${k + 1}/${F.length}`;
      const tm = P.querySelector(`#awTm-${i.id}`); if (tm) tm.textContent = label(f) + (k === last ? '' : '（過去）');
      if (pdf) {
        const cv = await thumbOf(k).catch(() => null); if (my !== seq) return;
        if (cv) { const th = P.querySelector(`#awTh-${i.id}`); const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height; c2.getContext('2d').drawImage(cv, 0, 0); th.replaceChildren(c2); }
        Object.assign(state[i.id], { pdf: f.url, time: label(f), raw: null, colored: null, overlay: null });
        if (i.section && xsKind === i.id) xs3d.show(i.id, xsPanels(i.id)).catch(() => {});   // 断面図の3D（壁）もそのコマに
      } else {
        thumbImg.src = f.src;
        Object.assign(state[i.id], { src: f.src, time: fmtJ(f.t) });
      }
      await overlay(k);
    }
    const stop = () => { clearTimeout(timer); timer = null; pb.textContent = '▶'; };
    const tick = async () => { await show(k >= last ? 0 : k + 1); if (timer) timer = setTimeout(tick, k === last ? 2000 : (pdf ? 1300 : 900)); };   // 最新のコマで少し止める
    pb.onclick = () => { if (timer) stop(); else { pb.textContent = '❚❚'; if (k === last) { timer = -1; show(0).then(() => { if (timer) timer = setTimeout(tick, 1300); }); } else timer = setTimeout(tick, 600); } };
    bar.querySelector('[data-a="prev"]').onclick = () => { stop(); show(k - 1); };
    bar.querySelector('[data-a="next"]').onclick = () => { stop(); show(k + 1); };
    rng.oninput = () => { stop(); show(+rng.value); };
    tl.textContent = `${F.length}/${F.length}`;
    const tm = P.querySelector(`#awTm-${i.id}`); if (tm && pdf) tm.textContent = label(F[last]);
    imgAnims[i.id] = { stop };
  }

  async function load(i) {
    const th = P.querySelector(`#awTh-${i.id}`), tm = P.querySelector(`#awTm-${i.id}`);
    try {
      const r = await i.get(); state[i.id] = r; tm.textContent = r.time || '';
      if (r.src) {
        const im = new Image(); im.alt = i.title; im.crossOrigin = 'anonymous'; im.src = r.src;
        // 一時的に取れないことがあるので、1回だけ取り直す
        im.onerror = () => { if (!im._retry) { im._retry = 1; setTimeout(() => { im.src = r.src + (r.src.includes('?') ? '&' : '?') + 'r=' + Date.now(); }, 2000); } else th.textContent = '画像を取得できません'; };
        th.replaceChildren(im);
        if (r.frames?.length > 1) imgAnim(i, r, im);
      } else if (r.tiles) {
        const cv = r.intl ? await composeIntl(r.tiles, 3) : await composeTiles(r.tiles, i.id === 'radar' ? 5 : 4, airports, { bg: i.id === 'radar' ? '#1b2633' : '#0b141e' });
        th.replaceChildren(cv);
        if (i.id === 'radar') { anim.setFrames(r.frames, cv); startMotion(r.frames); return; }
        if (i.id === 'ir' && r.frames) { anims.ir.setFrames(r.frames, cv); startSatMotion(r.frames); return; }
        if (i.id === 'radarIntl' && r.frames) { anims.radarIntl.setFrames(r.frames, cv); startIntlMotion(r.frames); return; }
        if (anims[i.id] && r.frames) { anims[i.id].setFrames(r.frames, cv); return; }
        if (layers[i.id]) addOverlay(i, true);
      } else if (r.pdf) {
        try { th.replaceChildren(await renderPdf(r.pdf, 0.6, { wet: PAINT_CHARTS && i.id === 'aupq78' })); } catch { th.textContent = 'PDF（クリックで表示）'; }
        if (r.frames?.length) imgAnim(i, r, null, { pdf: true });
      } else if (r.typhoon) {
        if (r.tcs.length) th.replaceChildren(await typhoonCanvas(r.tcs, { irTiles: r.irTiles, airports }));
        else th.textContent = '現在、発表中の台風はありません';
        if (sel.id === 'typhoon') applyOverlay(i);
      }
      if (PAINT_CHARTS && i.section) colorize(i);
    } catch (e) { th.textContent = '取得できません'; tm.textContent = ''; console.warn('[charts]', i.id, e); }
  }
  // 断面図の色付け（モデル値から。AXJP：ジェット気流・前線帯・圏界面、FXJP：ウィンドシア・圏界面・前線帯の下端の相当温位線・湿域）
  const loadImg = url => new Promise((ok, ng) => { const x = new Image(); x.crossOrigin = 'anonymous'; x.onload = () => ok(x); x.onerror = () => ng(new Error('画像を取得できません')); x.src = url; });
  async function rawSection(id) {
    const r = state[id]; if (!r) throw new Error('図をまだ取得していません');
    if (!r.raw) {
      if (id === 'axjp') { r.raw = await renderPdf(r.pdf, 3); r.s = 3; }
      else { r.raw = await loadImg(r.src); r.s = r.raw.naturalWidth / 2048; }
    }
    return r;
  }
  async function colorize(i) {
    const st = P.querySelector(`#awXsCol-${i.id}`);
    try {
      if (st) st.textContent = '色を付けています…';
      const r = await rawSection(i.id);
      const c = await colorSection(i.id, r.raw, r.s, r.init);
      if (state[i.id] !== r) return;                              // 待っている間に更新された
      r.colored = c.colored; r.overlay = c.overlay;
      const th = P.querySelector(`#awTh-${i.id}`), k = 640 / c.colored.width;
      const small = document.createElement('canvas'); small.width = 640; small.height = Math.round(c.colored.height * k);
      small.getContext('2d').drawImage(c.colored, 0, 0, small.width, small.height);
      th.replaceChildren(small);
      if (st) st.innerHTML = legendHtml(i.id, c.lines);
      if (xsKind === i.id) xs3d.show(i.id, xsPanels(i.id)).catch(() => {});
    } catch (e) { if (st) st.textContent = `色を付けられませんでした（${e.message}）`; console.warn('[charts color]', i.id, e); }
  }
  async function loadAll() {
    P.querySelector('#awWxU').textContent = `${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新（出典：気象庁）`;
    await Promise.all(items.map(load));
    fb3d?.refresh().catch(() => {});
    if (xsKind) xs3d.show(xsKind, xsPanels(xsKind)).catch(() => {});
    // 選んでいる図があれば、最新の図で重ね直す
    if (sel.id) { const i = items.find(x => x.id === sel.id); for (const k of Object.keys(hiCache)) delete hiCache[k]; if (i && !state[i.id]?.tiles) applyOverlay(i); }
  }

  // ---------- 解説（図の下に開く／拡大表示の両方で使う） ----------
  const li = a => a.map(x => `<li>${x}</li>`).join('');
  // 見方・見どころ（固定の解説）
  function howHtml(i) {
    const gd = GUIDES[i.id] || { what: [], air: [] };
    return `<h4>この図の見方</h4><ul>${li(gd.what)}</ul><h4>航空での見どころ</h4><ul>${li(gd.air)}</ul>`;
  }
  // 自動解析（図をクリックしたとき）
  function nowHtml(i) {
    return `${i.id === 'radar' ? '<h4>エコーの動き（自動解析）</h4><ul class="now" data-motion><li>解析しています…</li></ul>' : ''}${i.id === 'radarIntl' ? '<h4>エコーの動き（自動解析）</h4><ul class="now" data-intl-motion><li>解析しています…</li></ul>' : ''}${i.id === 'vis' || i.id === 'ir' ? '<h4>雲の動きと種類（自動解析）</h4><ul class="now" data-sat-motion><li>解析しています…</li></ul>' : ''}
      <h4>今の状況（自動解析）</h4><ul class="now" data-now><li>解析しています…</li></ul>
      <div class="note">今の状況は、気象庁 MSM/GSM の格子値（Open-Meteo 経由）・レーダー・SIGMET・台風情報から自動で作った文章です。図そのものを読み取ったものではないため、図と見比べて確認してください。</div>`;
  }
  const guideHtml = i => howHtml(i) + nowHtml(i);       // 拡大表示では両方
  function runAnalysis(i, box) {
    const r = state[i.id] || {};
    const radarCanvas = state.radar?.tiles ? () => composeTiles(state.radar.tiles, 5, []) : null;
    const tilesCanvas = r.tiles ? () => composeTiles(r.tiles, 5, []) : null;
    const put = lines => { const u = box.querySelector('[data-now]'); if (u) u.innerHTML = li(lines); };
    box.querySelectorAll('[data-motion]').forEach(fillMotion);
    box.querySelectorAll('[data-intl-motion]').forEach(fillIntlMotion);
    box.querySelectorAll('[data-sat-motion]').forEach(fillSatMotion);
    (i.id === 'typhoon' ? Promise.resolve(typhoonText(r.tcs || [], airports)) : i.id === 'radarIntl' ? (r.tiles ? intlText(r.tiles, r.time) : Promise.resolve(['海外レーダーを取得できませんでした。'])) : analyze(i.id, { tilesCanvas: i.id === 'radar' ? radarCanvas : tilesCanvas, radarCanvas, init: r.init }))
      .then(lines => put(lines.length ? lines : ['自動解析の対象外です。']))
      .catch(e => put([`自動解析できませんでした（${e.message}）。`]));
  }

  // 拡大表示
  async function openModal(i) {
    const r = state[i.id]; if (!r) return;
    const B = MD.querySelector('#awWxMB'), link = MD.querySelector('#awWxML');
    MD.querySelector('#awWxMT').textContent = `${i.title}　${r.time || ''}`;
    MD.style.display = 'flex'; B.textContent = '読み込み中…';
    const G = MD.querySelector('#awWxMG');
    G.innerHTML = guideHtml(i); runAnalysis(i, G);
    if (r.src && !r.colored) { link.href = r.src; const im = new Image(); im.src = r.src; B.replaceChildren(im); }
    else if (r.intl) { link.href = 'https://www.rainviewer.com/map.html'; B.replaceChildren(await composeIntl(r.tiles, 4)); }
    else if (r.tiles) { link.href = r.tiles.replace('{z}/{x}/{y}', '4/14/6'); B.replaceChildren(await composeTiles(r.tiles, Math.min(6, r.maxLevel || 6), airports)); }
    else if (r.typhoon) { B.replaceChildren(await typhoonCanvas(r.tcs, { irTiles: r.irTiles, airports, z: 5 })); link.href = 'https://www.jma.go.jp/bosai/map.html#contents=typhoon'; }
    else if (r.colored) { link.href = r.pdf || r.src; B.replaceChildren(r.colored); }
    else if (r.pdf) {
      link.href = r.pdf;
      try { B.replaceChildren(await renderPdf(r.pdf, 2.2, { wet: PAINT_CHARTS && i.id === 'aupq78' })); }
      catch { B.innerHTML = `<iframe src="${r.pdf}" title="${i.title}"></iframe>`; }
    }
  }

  // ---------- 図を選ぶ：下に解説を開き、地図に重ねる ----------
  const PDF_SCALE = 3;                       // 地図に重ねる PDF の描画倍率（細かい字も読めるように）
  const sel = { id: null, layer: null, level: null, style: 'light', alpha: 0.9, seq: 0 };   // 衛星は雲だけ残すので、濃さは高めでも地形が見える
  const hiCache = {};                        // 高解像度で描いた PDF / 画像（url ごと）

  async function sourceFor(i) {
    const r = state[i.id];
    const key = r.src || r.pdf;
    if (hiCache[key]) return hiCache[key];
    let src;
    if (r.src) {
      src = await new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ng(new Error('画像を取得できません')); im.src = r.src; });
    } else src = await renderPdf(r.pdf, PDF_SCALE, { wet: PAINT_CHARTS && i.id === 'aupq78' });
    for (const k of Object.keys(hiCache)) delete hiCache[k];   // 古いものは捨てる（メモリ節約）
    return (hiCache[key] = src);
  }

  function clearSelLayer() {
    if (!sel.layer) return;
    if (sel.layer._awTyphoon) { const ds = sel.layer._awTyphoon; sel.layer = null; viewer.dataSources.remove(ds, true); return; }
    if (sel.layer._awRadar) { if (!radarBtnOn) hideRadarMap(); }
    else if (sel.layer._awSat) { if (!btnOn[sel.layer._awSat]) anims[sel.layer._awSat].hideFromMap(); }
    else if (sel.layer._awTiles) viewer.imageryLayers.remove(sel.layer, true); else removeChartLayer(viewer, sel.layer);
    sel.layer = null;
  }

  async function applyOverlay(i) {
    const my = ++sel.seq;
    const box = P.querySelector(`#awGd-${i.id}`), st = box.querySelector('.ovs');
    const say = t => { if (my === sel.seq && st) st.textContent = t; };
    clearSelLayer();
    const r = state[i.id];
    if (!r) { say('図を取得できていないため、地図に重ねられません。'); return; }
    if (i.id === 'radar') {                  // レーダー：6時間分のコマを重ね、再生バーで動かす
      if (radarBtnOn) { anim.setAlpha(sel.alpha); say('地図に重ねています。上の ▶ で6時間分を再生できます。'); return; }
      showRadarMap(sel.alpha); sel.layer = { _awRadar: true };
      say('地図に重ねました。上の ▶ で過去6時間（10分ごと）を再生できます。');
      return;
    }
    if (anims[i.id]) {                       // 衛星：6時間分のコマを雲だけにして重ね、再生バーで動かす
      if (btnOn[i.id]) { anims[i.id].setAlpha(sel.alpha); say('地図に重ねています。上の ▶ で6時間分を再生できます。'); return; }
      anims[i.id].showOnMap(sel.alpha); anim.raise(); sel.layer = { _awSat: i.id };
      if (i.id === 'radarIntl') {
        say(`地図に重ねました（気象庁と同じ配色）。上の ▶ で過去${Math.round(Math.max(0, (anims.radarIntl.frames?.length || 1) - 1) * 20 / 60 * 10) / 10}時間（20分ごと）を再生できます。矢印は雨域の動き（先端＝2時間後の位置）。配信元の公開は2時間分のため、それより前はアプリを開いている間に記録した分（最大6時間）。日本付近は気象庁のレーダーを重ねると、そちらが上になります。`);
        const R = INTL_RECT, c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
        // いまの視点が日本付近だけなら、海外の空港まで見える範囲に引く
        if (c.height < 4e6) viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(R.w + 10, R.s + 10, R.e - 2, R.n - 8), duration: 1.5 });
        return;
      }
      say('地図に重ねました（雲のない所は透明）。上の ▶ で過去6時間（20分ごと）を再生できます。');
      return;
    }
    if (i.section) { say('断面図は地図に平らに重ねる図ではないため、「3Dで表示」で地図の上に縦の壁として立てて見ます。'); return; }
    if (i.id === 'typhoon') {                // 台風：経路・予報円・暴風警戒域・強風域を地図に描く
      if (!r.tcs.length) { say('発表中の台風はありません。'); return; }
      sel.layer = { _awTyphoon: drawTyphoon3D(viewer, r.tcs) };
      say('地図に描きました（白い破線の円＝予報円、赤い線＝暴風警戒域、赤＝暴風域、黄＝強風域）。');
      let w = 180, e = 0, so = 90, n = -90;
      for (const tc of r.tcs) for (const p of tc.parts) for (const [la, lo] of [p.center, ...(p.track?.typhoon || [])].filter(Boolean)) { w = Math.min(w, lo); e = Math.max(e, lo); so = Math.min(so, la); n = Math.max(n, la); }
      viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(w, 128) - 3, Math.min(so, 26) - 3, Math.max(e, 142) + 4, Math.max(n, 38) + 3), duration: 1.5 });
      return;
    }
    const pj = PROJ[i.id]; if (!pj) { say('この図は地図に重ねられません。'); return; }
    const P2 = pj.panels ? pj.panels[sel.level] : pj;
    say(r.pdf ? 'PDF を高解像度で描いています…' : '図を地図の座標に合わせています…');
    try {
      const src = await sourceFor(i);
      if (my !== sel.seq) return;
      const warped = warpChart(src, P2, { s: r.pdf ? PDF_SCALE : 1, outW: r.pdf ? 3072 : 2048, style: sel.style });
      const lay = await addChartLayer(viewer, warped, { alpha: sel.alpha });
      if (my !== sel.seq) { removeChartLayer(viewer, lay); return; }
      sel.layer = lay;
      anim.raise();
      const b = warped.box;
      say(`地図に重ねました（${Math.round(b.s)}〜${Math.round(b.n)}°N・${Math.round(b.w)}〜${Math.round(b.e)}°E の範囲。図の経緯線・海岸線が地図と重なります）。`);
    } catch (e) { say(`地図に重ねられませんでした（${e.message}）。`); console.warn('[charts overlay]', i.id, e); }
  }

  function openGuide(i) {
    const box = P.querySelector(`#awGd-${i.id}`);
    const pj = PROJ[i.id], levels = pj?.panels ? (pj.order || Object.keys(pj.panels).sort((a, b) => b - a)) : null;
    if (levels && !levels.includes(String(sel.level))) sel.level = levels[0];
    box.innerHTML = `<div class="tools">
        ${levels && levels.length > 1 ? levels.map(l => `<button data-lv="${l}" aria-pressed="${String(sel.level) === l}">${pj.labels?.[l] || l + 'hPa'}</button>`).join('') : ''}
        <label>濃さ <input type="range" min="0.2" max="1" step="0.05" value="${sel.alpha}" data-al></label>
        ${pj ? `<button data-st aria-pressed="${sel.style === 'raw'}">${sel.style === 'raw' ? '原図の色' : '線だけ表示'}</button>` : ''}
        <button data-close>閉じる</button>
      </div><div class="ovs"></div>${nowHtml(i)}`;
    box.hidden = false;
    box.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => {
      sel.level = b.dataset.lv;
      box.querySelectorAll('[data-lv]').forEach(x => x.setAttribute('aria-pressed', x === b));
      applyOverlay(i);
    });
    box.querySelector('[data-al]').oninput = e => {
      sel.alpha = +e.target.value;
      if (anims[i.id]) { anims[i.id].setAlpha(sel.alpha); return; }
      const lay = sel.layer || layers[i.id]; if (lay) lay.alpha = sel.alpha;
    };
    const stb = box.querySelector('[data-st]');
    if (stb) stb.onclick = () => {
      sel.style = sel.style === 'raw' ? 'light' : 'raw';
      stb.setAttribute('aria-pressed', sel.style === 'raw'); stb.textContent = sel.style === 'raw' ? '原図の色' : '線だけ表示';
      applyOverlay(i);
    };
    box.querySelector('[data-close]').onclick = () => unselect();
    runAnalysis(i, box);
  }

  function unselect() {
    sel.seq++;
    clearSelLayer();
    if (sel.id) {
      const it = P.querySelector(`.it[data-id="${sel.id}"]`);
      it?.classList.remove('sel');
      const box = P.querySelector(`#awGd-${sel.id}`); if (box) { box.hidden = true; box.innerHTML = ''; }
    }
    sel.id = null;
    window.dispatchEvent(new Event('aw:chartsel'));
  }

  function select(i) {
    if (sel.id === i.id) { unselect(); return; }
    unselect();
    sel.id = i.id;
    const it = P.querySelector(`.it[data-id="${i.id}"]`);
    it.classList.add('sel');
    openGuide(i);
    applyOverlay(i);
    it.scrollIntoView({ block: 'start', behavior: 'smooth' });
    window.dispatchEvent(new Event('aw:chartsel'));
  }
  // 右下の「天気図」ボタン（main.js）から使う：図を選んで地図に表示する／もう一度で消す
  window.awCharts = {
    list: items.map(i => ({ id: i.id, title: i.title, grp: i.grp })),
    toggle: id => { const i = items.find(x => x.id === id); if (i) select(i); },
    get selected() { return sel.id; },
  };
  // 経路アドバイスの「💾 保存」から使う：一覧のすべての天気図を、その時点の画像・PDF として取り込む
  //   画像（PNG）・PDF はそのまま、衛星・レーダー（地図タイル）は東アジアの範囲を1枚の画像につなぐ（Web メルカトル）
  window.awCharts.snapshotAll = async (onStep = () => {}) => {
    const out = [];
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, ng) => setTimeout(() => ng(new Error('時間切れ')), ms))]);
    const blobOf = async url => { const r = await withTimeout(fetch(url, { mode: 'cors' }), 25000); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); };
    const b64 = b => new Promise((ok, ng) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = () => ng(fr.error); fr.readAsDataURL(b); });
    const BOX = { vis: [95, -10, 160, 55], ir: [95, -10, 160, 55], radar: [122, 23, 150, 47], radarIntl: [90, -12, 171, 45] };
    async function mosaic(tmpl, id, maxLevel = 6) {
      const [w, s0, e, n] = BOX[id] || [100, 0, 155, 50];
      const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
      const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
      let z = Math.min(maxLevel, 7);
      while (z > 2 && (tx(e, z) - tx(w, z) + 1) * (ty(s0, z) - ty(n, z) + 1) > 48) z--;
      const x0 = tx(w, z), x1 = tx(e, z), y0 = ty(n, z), y1 = ty(s0, z);
      const cv = document.createElement('canvas'); cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
      const g = cv.getContext('2d'); g.fillStyle = id.startsWith('radar') ? '#ffffff' : '#000000'; g.fillRect(0, 0, cv.width, cv.height);
      let okN = 0;
      const jobs = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(new Promise(done => {
        const im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = () => { g.drawImage(im, (x - x0) * 256, (y - y0) * 256); okN++; done(); }; im.onerror = () => done();
        im.src = tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      }));
      await withTimeout(Promise.all(jobs), 30000).catch(() => {});
      if (!okN) throw new Error('地図タイルを取得できません');
      const lon = x => x / 2 ** z * 360 - 180, lat = y => { const k = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(k)); };
      const url = cv.toDataURL(id.startsWith('radar') ? 'image/png' : 'image/jpeg', 0.85);
      return { b64: url.split(',')[1], mime: url.slice(5, url.indexOf(';')), bbox: [lon(x0), lat(y1 + 1), lon(x1 + 1), lat(y0)], zoom: z };
    }
    for (const i of items) {
      onStep(`天気図を取り込んでいます：${i.title}`);
      const rec = { id: i.id, title: i.title, grp: i.grp };
      try {
        const r = state[i.id] && (state[i.id].src || state[i.id].pdf || state[i.id].tiles || state[i.id].typhoon) ? state[i.id] : await withTimeout(i.get(), 25000);
        rec.time = r.time || '';
        if (r.src) { const bl = await blobOf(r.src); Object.assign(rec, { kind: 'image', mime: bl.type || 'image/png', b64: await b64(bl), url: r.src }); }
        else if (r.pdf) { const bl = await blobOf(r.pdf); Object.assign(rec, { kind: 'pdf', mime: 'application/pdf', b64: await b64(bl), url: r.pdf }); }
        else if (r.tiles) Object.assign(rec, { kind: 'image', ...(await mosaic(r.tiles, i.id, r.maxLevel || 6)), note: '地図タイルを東アジアの範囲でつないだもの（Web メルカトル）' });
        else if (r.typhoon) Object.assign(rec, { kind: 'json', json: r.tcs || [] });
        else continue;
      } catch (e) { rec.error = e.message || String(e); }
      out.push(rec);
    }
    return out;
  };
  window.dispatchEvent(new Event('aw:charts-ready'));
  P.querySelectorAll('.th').forEach(th => th.onclick = () => select(items.find(i => i.id === th.closest('.it').dataset.id)));
  // 見方・見どころ（ボタンで開け閉め）
  P.querySelectorAll('[data-how]').forEach(b => b.onclick = () => {
    const i = items.find(x => x.id === b.dataset.how), box = P.querySelector(`#awHw-${i.id}`);
    const on = box.hidden;
    if (on) box.innerHTML = howHtml(i);
    box.hidden = !on; b.setAttribute('aria-pressed', on);
  });
  P.querySelectorAll('[data-zoomi]').forEach(b => b.onclick = () => openModal(items.find(x => x.id === b.dataset.zoomi)));

  // 衛星画像は雲のない所（黒い地面・海）を透明にして、下の地形が見えるようにする
  //   全球（fd）のタイルは z5 までしかない（z6 は 404 で穴が開く）ので z5 まで読み、それより細かくは拡大して使う。範囲も切らない
  function satProvider(id, r) {
    const opt = CLOUD_ONLY[id] ? { url: r.tiles, maximumLevel: r.maxLevel || 5, minimumLevel: 0, credit: new Cesium.Credit('気象庁') }
      : { url: r.tiles, maximumLevel: r.maxLevel || 6, minimumLevel: 0, rectangle: rect, credit: new Cesium.Credit('気象庁') };
    return CLOUD_ONLY[id] ? new CloudOnlyImageryProvider({ ...opt, cloud: CLOUD_ONLY[id] }) : new Cesium.UrlTemplateImageryProvider(opt);
  }
  // 地図に重ねる
  // 重ねる順：下から 衛星の雲（可視・赤外）→ 海外レーダー → 気象庁のレーダー（日本付近は気象庁が上）
  function restack() {
    for (const id of ['vis', 'ir', 'radarIntl']) if (anims[id]?.onMap) anims[id].raise();
    anim.raise();
  }
  function addOverlay(i, refresh = false) {
    const r = state[i.id]; if (!r?.tiles) return;
    if (i.id === 'radar') { radarBtnOn = true; showRadarMap(); restack(); return; }
    if (anims[i.id]) { btnOn[i.id] = true; anims[i.id].showOnMap(0.9); restack(); return; }
    if (layers[i.id]) viewer.imageryLayers.remove(layers[i.id], true);
    const lay = viewer.imageryLayers.addImageryProvider(satProvider(i.id, r));
    lay.alpha = i.id === 'radar' ? 0.8 : 0.9;
    layers[i.id] = lay;
    anim.raise();
  }
  P.querySelectorAll('[data-ov]').forEach(b => b.onclick = () => {
    const i = items.find(x => x.id === b.dataset.ov);
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on); b.textContent = on ? '地図から外す' : '地図に重ねる';
    if (sel.id === i.id) clearSelLayer();   // 選択中の重ね表示と二重にならないように
    setTimeout(() => window.dispatchEvent(new Event('aw:chartsel')), 0);   // 右下のボタンの色を合わせる
    if (i.id === 'radar') {
      if (on) addOverlay(i); else { radarBtnOn = false; hideRadarMap(); }
      return;
    }
    if (anims[i.id]) { if (on) addOverlay(i); else { btnOn[i.id] = false; anims[i.id].hideFromMap(); } return; }
    if (on) addOverlay(i); else if (layers[i.id]) { viewer.imageryLayers.remove(layers[i.id], true); delete layers[i.id]; }
  });

  // 「衛星・レーダーを重ねる」：衛星画像・レーダーエコー（気象庁）・海外レーダーを一緒に地図に重ねる（同じ時刻で再生）
  //   衛星の雲は赤外（可視をすでに重ねていれば可視）。ボタンで重ねたものだけを、もう一度押したときに外す
  const combos = [...P.querySelectorAll('[data-combo]')];
  let comboAdded = [];
  const isOn = id => P.querySelector(`[data-ov="${id}"]`)?.getAttribute('aria-pressed') === 'true';
  const press = (id, want) => { const b = P.querySelector(`[data-ov="${id}"]`); if (b && isOn(id) !== want) b.onclick(); };
  // 右下の「レーダー」「海外レーダー」ボタン（main.js）から使う：選択（1つだけ）ではなく「地図に重ねる」で出し入れするので、
  // 気象庁のレーダーと海外レーダーを同時に表示できる（2026-10-18）
  window.awCharts.overlay = id => { press(id, !isOn(id)); window.dispatchEvent(new Event('aw:chartsel')); };
  window.awCharts.overlayOn = isOn;
  const setCombo = on => combos.forEach(b => { b.setAttribute('aria-pressed', on); b.textContent = on ? '重ねるのをやめる' : '衛星・レーダーを重ねる'; });
  combos.forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    setCombo(on);
    if (on) {
      const sat = isOn('vis') ? 'vis' : 'ir';
      comboAdded = [sat, 'radarIntl', 'radar'].filter(id => !isOn(id));
      for (const id of comboAdded) press(id, true);
      restack();
      setTimeout(() => { restack(); syncTimes('radar', anims.radar.current?.time); }, 300);
      // 日本付近だけを見ていたら、海外レーダーの範囲（東アジア・東南アジア）が見えるように引く
      const R = INTL_RECT, c = Cesium.Cartographic.fromCartesian(viewer.camera.position);
      if (c.height < 4e6) viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(R.w + 10, R.s + 10, R.e - 2, R.n - 8), duration: 1.5 });
    } else {
      for (const id of comboAdded) press(id, false);
      comboAdded = [];
    }
  });

  // 雲頂の高さで 3D（ひまわり赤外 × 気温の鉛直分布）
  const ct3d = createCloudTop3D(viewer, { getRadar: () => motionP, onStatus: t => { const e = P.querySelector('#awCt3dSt'); if (e) e.textContent = t; window.dispatchEvent(new CustomEvent('aw:ct3d', { detail: t })); } });
  const ctBtn = P.querySelector('[data-ct3d]');
  if (ctBtn) ctBtn.onclick = async () => {
    const on = ctBtn.getAttribute('aria-pressed') !== 'true';
    ctBtn.setAttribute('aria-pressed', on); ctBtn.textContent = on ? '3Dを消す' : '雲頂の高さで3D';
    P.querySelector('#awCt3d').hidden = !on;
    if (on) {
      // 高さが分かるように高度を誇張して（経路の立体表示と同じ倍率）、日本付近を南から斜めに見る
      if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);
      await ct3d.show();
      if (Cesium.Math.toDegrees(viewer.camera.pitch) < -75) viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(135.5, 34.5, 400000), 1200000),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), 3600000), duration: 2 });
    } else ct3d.hide();
  };

  // レーダーエコーの 3D（降水強度の柱・高さは推定エコー頂）
  const echo3d = createRadarEcho3D(viewer, { getResult: () => motionP, onStatus: t => { const e = P.querySelector('#awEcho3dSt'); if (e) e.textContent = t; } });
  const e3Btn = P.querySelector('[data-echo3d]');
  if (e3Btn) e3Btn.onclick = async () => {
    const on = e3Btn.getAttribute('aria-pressed') !== 'true';
    e3Btn.setAttribute('aria-pressed', on); e3Btn.textContent = on ? '3Dを消す' : 'エコーを3D';
    P.querySelector('#awEcho3d').hidden = !on;
    if (on) {
      if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);
      try { await echo3d.show(); } catch (e) { P.querySelector('#awEcho3dSt').textContent = `3D にできませんでした（${e.message}）`; }
      if (Cesium.Math.toDegrees(viewer.camera.pitch) < -75) viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(135.5, 34.5, 400000), 1200000),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), 3600000), duration: 2 });
    } else echo3d.hide();
  };

  // 悪天予想図の 3D（図を読み取って、ジェット気流・CAT・雲域を立体に）
  const fb3d = createFbjp3D(viewer, { getImageUrl: () => state.fbjp?.src, onStatus: t => { const e = P.querySelector('#awFb3dSt'); if (e) e.textContent = t; } });
  const fbBtn = P.querySelector('[data-fb3d]');
  if (fbBtn) fbBtn.onclick = async () => {
    const on = fbBtn.getAttribute('aria-pressed') !== 'true';
    fbBtn.setAttribute('aria-pressed', on); fbBtn.textContent = on ? '3Dを消す' : '3Dで表示';
    if (on) {
      if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);
      try { await fb3d.show(); } catch (e) { P.querySelector('#awFb3dSt').textContent = `3D にできませんでした（${e.message}）`; }
      if (Cesium.Math.toDegrees(viewer.camera.pitch) < -75) viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(136.5, 35, 400000), 1200000),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-22), 3600000), duration: 2 });
    } else fb3d.hide();
  };

  // 高層天気図の気圧面を 3D（等高線を読み取って、波打つ面と矢羽根に）。操作は画面右下の「高層3D」の列のボタンで行う
  initUpper3DButtons();
  function initUpper3DButtons() {
    const box = document.getElementById('upper3dBtns'), stEl = document.getElementById('upper3dSt');
    if (!box) return;
    const st2 = document.createElement('style');
    st2.textContent = `#upper3dBtns{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:3px}
      #camButtons #upper3dBtns button{padding:4px 8px;font-size:11.5px}
      #camButtons #upper3dBtns button.on{background:#1e5a8c;border-color:#fff}
      #camButtons #upper3dBtns button:disabled{opacity:.45;cursor:default}
      #upper3dSt{max-width:640px;font:11px/1.5 "Meiryo",sans-serif;color:#e6f2ff;text-shadow:0 0 4px #000,0 0 2px #000;text-align:right}
      #upper3dSt i{display:inline-block;width:11px;height:9px;margin:0 3px 0 6px;vertical-align:-1px;border:1px solid #fff}`;
    document.head.appendChild(st2);
    const surf3d = createUpperSurf3D(viewer, {});
    box.innerHTML = `<button data-u="on" title="850・700・500・300・250・200hPa の気圧面を、天気図（AUPQ78・AUPQ35・AUPA25・AUPA20）の等高線から立体表示">気圧面3D</button>
      <button data-u="struct" disabled title="気圧の谷の軸（渦管）・尾根の軸・収束場と発散場・下降流と上昇流を立体で表示">谷・尾根の構造</button>
      <button data-u="mode" disabled title="波だけ：南北の傾きを除いた偏差で波打たせ、谷・尾根・低圧部を見やすくする／実際の高さ：そのままの高さ">表示：波だけ</button>
      <button data-u="wave" disabled title="起伏を何倍に強調するか。押すたびに ×1→×5→×10→×20">起伏 ×10</button>`;
    const B = k => box.querySelector(`[data-u="${k}"]`);
    const say = h => { if (stEl) stEl.innerHTML = h; };
    let legend = '';
    const setLegend = sum => {
      legend = sum.map(x => `<i style="background:${x.color}"></i>${x.p}`).join('') + 'hPa';
    };
    // 南から北を見る（西が左。谷の軸が上空ほど西＝左へ傾くのが見える向き）。高さの倍率に合わせて全体が入る距離にする
    const view = (res = null) => {
      const k = window.awGetAltScale?.() ?? 1, H = 12000 * k;
      if (res?.cols?.length) {
        // 構造を見るときは、谷の軸の南から、横に近い低い角度で（模式図と同じ、西が左・東が右の見え方）
        const t = res.cols.find(c => c.kind === 'trough') || res.cols[0];
        const lon = t.pts.reduce((a, q) => a + q.lon, 0) / t.pts.length;
        viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon - 4, t.phi - 3, H * 0.45), Math.max(800000, H * 0.8)),
          { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-8), Math.max(1700000, H * 5.5)), duration: 2 });
        return;
      }
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(142, 38, H * 0.4), Math.max(1000000, H * 0.9)),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-12), Math.max(4600000, H * 3.2)), duration: 2 });
    };
    B('on').onclick = async () => {
      const on = !surf3d.on;
      if (!on) {
        await surf3d.hideAll(); B('on').classList.remove('on'); B('struct').classList.remove('on');
        ['struct', 'mode', 'wave'].forEach(k => { B(k).disabled = true; }); say(''); return;
      }
      B('on').disabled = true;
      if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG > 1 ? window.AW_EXAG : 25);
      const r = await surf3d.showAll(t => say(t));
      B('on').disabled = false;
      if (!r.summary.length) { say(`表示できませんでした（${r.errs.join('、')}）`); return; }
      B('on').classList.add('on'); ['struct', 'mode', 'wave'].forEach(k => { B(k).disabled = false; });
      setLegend(r.summary);
      say(`${legend}　L＝低気圧・H＝高気圧の中心（天気図から）。矢羽根は天気図の観測値。${r.errs.length ? `<br>読めなかった図：${r.errs.join('、')}` : ''}`);
      view();
    };
    B('struct').onclick = async () => {
      const v = !surf3d.structure;
      if (v && surf3d.mode !== 'wave') { await surf3d.setMode('wave'); B('mode').textContent = '表示：波だけ'; }
      const res = await surf3d.setStructure(v);
      B('struct').classList.toggle('on', v);
      if (!v) { say(`${legend}　L＝低気圧・H＝高気圧の中心（天気図から）。矢羽根は天気図の観測値。`); return; }
      say(`${legend}<br>桃の管＝渦管（気圧の谷の軸）、水色の管＝気圧の尾根の軸。谷の西側＝収束場（青・下降流）、東側＝発散場（赤・上昇流）。<br>` +
        (res?.tilt?.length ? res.tilt.join('<br>') : '谷の軸が見つかりませんでした（谷が弱いか、範囲の外です）'));
      view(res);
    };
    B('mode').onclick = async () => {
      const m = surf3d.mode === 'wave' ? 'actual' : 'wave';
      if (m === 'actual' && surf3d.structure) { await surf3d.setStructure(false); B('struct').classList.remove('on'); }
      B('mode').textContent = m === 'wave' ? '表示：波だけ' : '表示：実際の高さ';
      await surf3d.setMode(m);
    };
    B('wave').onclick = async () => {
      const W = [1, 5, 10, 20], w = W[(W.indexOf(surf3d.wave) + 1) % W.length];
      B('wave').textContent = `起伏 ×${w}`;
      await surf3d.setWave(w);
    };
  }

  // 断面図の 3D（図を縦の壁として、断面の線の上に立てる）
  const xsSt = id => P.querySelector(`#awXs3dSt-${id}`);
  let xsKind = null, xsPanel = 6, axPanel = 'both';
  const xs3d = createCrossSection3D(viewer, {
    onStatus: t => { if (xsKind) { const e = xsSt(xsKind); if (e) e.textContent = t; } },
    getSource: async kind => {
      const r = await rawSection(kind);
      return { src: r.raw, s: r.s, overlay: r.overlay || null };
    },
  });
  const xsPanels = kind => (kind === 'axjp' ? (axPanel === 'both' ? [140, 130] : [+axPanel]) : [xsPanel]);
  async function showXs(kind, fly = true) {
    P.querySelectorAll('[data-xs3d]').forEach(b => { const on = b.dataset.xs3d === kind; b.setAttribute('aria-pressed', on); b.textContent = on ? '3Dを消す' : '3Dで表示'; });
    P.querySelectorAll('[id^="awXs3dSt-"]').forEach(e => { e.textContent = ''; });
    xsKind = kind;
    if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);
    try { await xs3d.show(kind, xsPanels(kind)); } catch (e) { const el = xsSt(kind); if (el) el.textContent = `3D にできませんでした（${e.message}）`; return false; }
    if (fly) flyXs(kind);
    return true;
  }
  // 断面を真横に近い角度から見る（AXJP は南北の線なので西寄りから、FXJP は南東から）
  function flyXs(kind) {
    const tall = true;
    const c = kind === 'axjp' ? [135, 37] : [133, 34.5];
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(c[0], c[1], tall ? 800000 : 200000), tall ? 1600000 : 1300000),
      { offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(kind === 'axjp' ? 80 : -25), Cesium.Math.toRadians(tall ? -8 : -15), tall ? 4200000 : 3000000), duration: 2 });
  }
  P.querySelectorAll('[data-xs3d]').forEach(b => b.onclick = () => {
    if (b.getAttribute('aria-pressed') === 'true') {
      b.setAttribute('aria-pressed', 'false'); b.textContent = '3Dで表示'; xs3d.hide(); xsKind = null; return;
    }
    showXs(b.dataset.xs3d);
  });
  // AXJP：140°E・130°E のどちらを立てるか（真横から見るときは1枚ずつ）
  const setAx = v => {
    axPanel = v;
    P.querySelectorAll('[data-xsa]').forEach(x => x.setAttribute('aria-pressed', x.dataset.xsa === v));
  };
  P.querySelectorAll('[data-xsa]').forEach(b => b.onclick = () => {
    setAx(b.dataset.xsa);
    if (xsKind === 'axjp') xs3d.show('axjp', xsPanels('axjp')).catch(() => {});
  });
  // 真横から見る：壁に直角・水平に近い視線で、壁全体が画面（左右のパネルの間）に収まる距離から
  P.querySelectorAll('[data-xsside]').forEach(b => b.onclick = async () => {
    const kind = b.dataset.xsside, northRight = b.dataset.north === 'right';
    if (kind === 'axjp' && axPanel === 'both') setAx('140');            // 2枚が重なるので1枚にする
    if (xsKind !== kind || xs3d.kind !== kind) { if (!(await showXs(kind, false))) return; }
    else await xs3d.show(kind, xsPanels(kind));
    const panel = xsPanels(kind)[0], v = xs3d.sideView(panel, northRight);
    if (!v) return;
    const W = viewer.canvas.clientWidth || window.innerWidth, H = viewer.canvas.clientHeight || window.innerHeight;
    const adv = document.getElementById('awAdv');
    const lp = adv && adv.offsetParent ? adv.getBoundingClientRect().right + 10 : 0;
    const rp = W - P.getBoundingClientRect().left + 10;
    const gap = W - lp - rp, narrow = gap < 400, vis = narrow ? 1 : gap / W;
    const fr = viewer.camera.frustum, asp = W / H;
    const fovx = asp >= 1 ? fr.fov : 2 * Math.atan(Math.tan(fr.fov / 2) * asp), fovy = asp >= 1 ? 2 * Math.atan(Math.tan(fr.fov / 2) / asp) : fr.fov;
    const range = 1.12 * Math.max(v.widthM / 2 / Math.tan(fovx * vis / 2), v.heightM / 2 / Math.tan(fovy / 2));
    viewer.camera.flyToBoundingSphere(v.sphere, {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(v.heading), Cesium.Math.toRadians(-2), range), duration: 2,
      complete: () => {
        if (narrow) return;
        const shift = ((lp - rp) / 2 / W) * 2 * range * Math.tan(fovx / 2);   // 左右のパネルの間の中央へ
        if (Math.abs(shift) > 1) viewer.camera.moveLeft(shift);
      },
    });
    const el = xsSt(kind);
    if (el) el.textContent = `${SECTION_TITLE[kind][panel]}を真横から見ています（北が${northRight ? '右' : '左'}）。` +
      (v.readable ? '' : '壁の裏側から見ているため、図の文字は左右反転しています。文字を読むときは「真横から（北が左）」。') +
      '地図をドラッグすると視点が変わります。';
  });
  P.querySelectorAll('[data-xsp]').forEach(b => b.onclick = () => {
    xsPanel = +b.dataset.xsp;
    P.querySelectorAll('[data-xsp]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (xsKind === 'fxjp') xs3d.show('fxjp', [xsPanel]).catch(() => {});
  });

  // 3D の絵柄（アニメ風 ⇄ 高さ・強さの色分け）。雲とエコーで共通
  let style3d = 'anime';
  P.querySelectorAll('[data-style]').forEach(b => b.onclick = () => {
    style3d = style3d === 'anime' ? 'color' : 'anime';
    P.querySelectorAll('[data-style]').forEach(x => { x.textContent = style3d === 'anime' ? '絵柄：雲の絵' : '絵柄：色分け'; x.setAttribute('aria-pressed', style3d === 'anime'); });
    P.querySelectorAll('[data-lg]').forEach(x => { x.hidden = x.dataset.lg !== style3d; });
    ct3d.setStyle(style3d); echo3d.setStyle(style3d);
  });

  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => {
    if (d.name === 'typhoon' && sel.id === 'typhoon' && sel.layer?._awTyphoon === d) {
      setTimeout(() => { if (sel.id === 'typhoon' && state.typhoon?.tcs?.length) sel.layer = { _awTyphoon: drawTyphoon3D(viewer, state.typhoon.tcs) }; }, 0);
    }
  });
  // 「雲の強調」ボタン（右下・main.js）：雲頂の高さで3D（アニメ風の雲・積乱雲は半透明）＋レーダーエコー（色の柱と地図）、高度25倍（初期値）
  const pressed = b => b?.getAttribute('aria-pressed') === 'true';
  const cloudEmph = {
    get on() { return ct3d.on; },
    busy: false,
    async set(want) {
      if (this.busy) return; this.busy = true;
      window.dispatchEvent(new Event('aw:clouds'));
      try {
        const ov = P.querySelector('[data-ov="radar"]');
        if (want) {
          if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);
          if (style3d !== 'anime') P.querySelector('[data-style]')?.click();      // 白い積乱雲の絵で
          for (let k = 0; k < 40 && !state.radar?.tiles; k++) await new Promise(r => setTimeout(r, 500));   // レーダーの読み込み待ち
          if (ov && !pressed(ov)) ov.click();
          // 積乱雲は半透明にして、中にレーダーエコーの色の柱（降水の強さ・高さは推定エコー頂）を見せる
          ct3d.setCbAlpha(0.5);
          echo3d.setStyle('color');
          if (ctBtn && !pressed(ctBtn)) await ctBtn.onclick();
          if (e3Btn && !pressed(e3Btn)) await e3Btn.onclick();
        } else {
          if (ctBtn && pressed(ctBtn)) await ctBtn.onclick();
          if (e3Btn && pressed(e3Btn)) await e3Btn.onclick();
          if (ov && pressed(ov)) ov.click();
          ct3d.setCbAlpha(CB_ALPHA); echo3d.setStyle(style3d);
        }
      } finally { this.busy = false; window.dispatchEvent(new Event('aw:clouds')); }
    },
  };
  window.awCloudEmphasis = cloudEmph;
  // 右下「衛星雲頂3D」ボタン（main.js）：ひまわり赤外の雲頂温度から雲頂の高さを求め、アニメ風の雲で描く。
  //   レーダーエコーがある所は積乱雲（雷の光つき）。エコーの解析が終わると、自動で積乱雲を描き直す
  window.awCloudTop3D = {
    get on() { return ct3d.on; },
    async set(want) {
      if (want) {
        if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG || 25);   // 高さが分かるように誇張
        ct3d.setStyle('anime'); ct3d.setCbAlpha(CB_ALPHA);
        await ct3d.show();
        if (Cesium.Math.toDegrees(viewer.camera.pitch) < -75) viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(135.5, 34.5, 400000), 1200000),
          { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), 3600000), duration: 2 });
      } else ct3d.hide();
      window.dispatchEvent(new Event('aw:clouds'));
      return ct3d.on;
    },
  };
  ctBtn?.addEventListener('click', () => setTimeout(() => window.dispatchEvent(new Event('aw:clouds')), 0));
  P.querySelector('#awWxR').onclick = loadAll;
  loadAll();
  setInterval(loadAll, 10 * 60 * 1000);      // 10分ごとに更新
  return { reload: loadAll, select: id => { const i = items.find(x => x.id === id); if (i) select(i); }, unselect };
}
