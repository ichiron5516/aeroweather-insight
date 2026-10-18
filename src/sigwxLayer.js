// 国際悪天予想図（WAFS SIGWX：世界空域予報センターの高高度悪天予想）
//   出典：NOAA Aviation Weather Center が公開している WAFS SigWx の GeoJSON（https://aviationweather.gov/sigwx）
//     /data/products/autosigwx/YYYYMMDD/YYYYMMDD_HH_Fhh_sigwx_hi_{CB,TURB,ICING,JET,TROP,TC,VOLC,RAD}.geojson
//   ・6時間ごと（00・06・12・18UTC）の初期値から、6〜48時間先まで3時間ごとの予想。全球
//   ・高さは FL（100ft 単位）。「XXX」は図の下限より下まで広がっていることを示す
//     （積乱雲は地表付近から、乱気流・着氷は FL100 より下から、として描く）
//   ・aviationweather.gov は CORS がないため、開発時は vite.config.js の中継（/awcsig）、
//     公開サイトでは VITE_WX_PROXY の中継（tools/wx-proxy-worker.js の /sigwx/...）を通す
//   ・表示：「地図」＝地表に色分けした範囲と線。
//          「3D」＝国内悪天予想図（FBJP）の 3D と同じ見せ方（高度の倍率に合わせる）
//            積乱雲 … 雲底〜雲頂のもくもくした雲の柱（puffColumn）を範囲いっぱいに並べ、雲頂にかなとこ雲
//            乱気流 … 下限〜上限の半透明の層（並＝橙・強＝赤橙）。上面の縁を線で
//            着氷   … 下限〜上限の半透明の層（並＝水色・強＝青）
//            ジェット気流 … 中心の高さに太い管と流れの向きの矢印、下に薄い幕
//            雲の柱は数が多いと重いので、衛星画像（ひまわり全球画像）の範囲と、画面の中心から 4,500km 以内の積乱雲だけ立体にする
//            （それより遠くは枠だけ。2026-10-18 から衛星画像の範囲全体。画面の中心に近い積乱雲から順に柱を立てる）
//   ・primitive で描く（事例の切り替えで viewer.entities が消されても残るように）
import * as Cesium from 'cesium';
import { inSatDisk } from './satDisk.js';
import { puffColumn } from './wxPanels/puffColumn.js';
import { animeSky } from './wxPanels/cloudTop3D.js';

const KINDS = ['CB', 'TURB', 'ICING', 'JET', 'TROP', 'TC', 'VOLC', 'RAD'];
const STEPS = Array.from({ length: 15 }, (_, i) => 6 + i * 3);          // F06〜F48
const LOW_FL = 100;                                                      // 「XXX」の乱気流・着氷の下限として描く高さ
const TOP_FL = 600;
const ELEM = [['CB', '積乱雲'], ['TURB', '乱気流'], ['ICING', '着氷'], ['JET', 'ジェット気流'], ['TROP', '圏界面'], ['PT', '台風・火山']];
const COL = {
  CB: '#ff5252', TURBmoderate: '#ffb74d', TURBsevere: '#ff6e40', ICINGmoderate: '#4fc3f7', ICINGsevere: '#2979ff',
  JET: '#ce93d8', TROP: '#fff59d', TC: '#ff80ab', VOLC: '#ff9100', RAD: '#ffff00',
};
const EXT = { ISOL: '孤立', OCNL: '時々', FRQ: '頻繁', FREQ: '頻繁', EMBD: '埋没' };
const SEV = { moderate: '並', severe: '強' };

// ---------- 取得 ----------
function bases() {
  const env = import.meta.env || {};
  const out = [];
  if (env.DEV) out.push(`${String(env.BASE_URL || '/').replace(/\/$/, '')}/awcsig`);
  if (env.VITE_WX_PROXY) out.push(`${String(env.VITE_WX_PROXY).replace(/\/$/, '')}/sigwx`);
  out.push('https://aviationweather.gov/data/products/autosigwx');
  return out;
}
const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
const fileOf = (issue, step, kind) => `${ymd(issue)}/${ymd(issue)}_${p2(issue.getUTCHours())}_F${p2(step)}_sigwx_hi_${kind}.geojson`;
let workBase = null;
async function getJson(path) {
  let last;
  for (const b of workBase ? [workBase] : bases()) {
    try {
      const r = await fetch(`${b}/${path}`);
      if (r.status === 404) { workBase = b; const e = new Error('404'); e.notFound = true; throw e; }
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json(); workBase = b; return j;
    } catch (e) { if (e.notFound) throw e; last = e; }
  }
  throw new Error(`aviationweather.gov に接続できません（${last?.message || 'CORS'}）`);
}
/** 最新の初期値：AWC のページと同じく「今から6時間前」を6時間単位で切り捨て。なければ1つ前 */
function issueCandidates(now = Date.now()) {
  const t = Math.floor((now - 6 * 3600e3) / 21600e3) * 21600e3;
  return [new Date(t), new Date(t - 21600e3)];
}
const memo = new Map();                       // `${issue}|${step}` → { kind: features[] }
async function loadStep(issue, step) {
  const k = `${issue.getTime()}|${step}`;
  if (memo.has(k)) return memo.get(k);
  const res = {};
  await Promise.all(KINDS.map(async kind => {
    try { res[kind] = (await getJson(fileOf(issue, step, kind))).features || []; }
    catch (e) { if (kind === 'CB' || kind === 'TURB') throw e; res[kind] = []; }   // 主要な2つが読めなければ失敗
  }));
  memo.set(k, res);
  return res;
}

// ---------- 形の整理 ----------
const fl = v => (v == null || v === 'XXX' || v === '' ? null : +v);
const flText = v => (fl(v) == null ? 'XXX' : `FL${String(fl(v)).padStart(3, '0')}`);
/** 経度を連続に（-180〜180 をまたぐ所で 360 ずらす）。日付変更線の向こうに複製された同じ区域は1つにまとめる */
function unwrap(pts) {
  const out = []; let off = 0;
  pts.forEach(([x, y], i) => {
    if (i) { const d = x + off - out[i - 1][0]; if (d > 180) off -= 360; else if (d < -180) off += 360; }
    out.push([x + off, y]);
  });
  return out;
}
const keyOf = pts => {
  const n = pts.length, cx = pts.reduce((a, p) => a + p[0], 0) / n, cy = pts.reduce((a, p) => a + p[1], 0) / n;
  return `${Math.round(((cx % 360) + 540) % 360)}:${Math.round(cy)}`;
};
const centroid = pts => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
const closed = pts => pts.length > 3 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 0.5;

// ---------- 経路アドバイス（断面図・採点）用 ----------
/**
 * 指定の時刻に一番近い予想（F06〜F48）の、積乱雲・乱気流・着氷の範囲とジェット気流・圏界面を返す。
 *   areas: [{ kind:'CB'|'TURB'|'ICING', sev:'moderate'|'severe'|null, ext:'ISOL'…, base, top(FL), ring:[{lat,lon}] }]
 *   「XXX」（図の下限より下）は CB=地表付近、乱気流・着氷=FL100 として返す（baseKnown=false）
 *   jets:  [{ pts:[{lat,lon}], fl:[{lat,lon,fl,kt}] }]、trop: [{ pts:[{lat,lon}], fl }]
 */
export async function fetchSigwxFor(time = new Date()) {
  const t = time.getTime();
  let lastErr;
  for (const issue of issueCandidates()) {
    const step = STEPS.reduce((b, s) => (Math.abs(issue.getTime() + s * 3600e3 - t) < Math.abs(issue.getTime() + b * 3600e3 - t) ? s : b), STEPS[0]);
    let d;
    try { d = await loadStep(issue, step); } catch (e) { lastErr = e; continue; }
    const ll = pts => unwrap(pts).map(([lon, lat]) => ({ lat, lon }));
    const areas = [], seen = new Set();
    for (const kind of ['CB', 'TURB', 'ICING']) for (const f of d[kind] || []) {
      const g = f.geometry, raw = g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'LineString' ? g.coordinates : null;
      if (!raw || raw.length < 3) continue;
      const k = kind + keyOf(unwrap(raw)); if (seen.has(k)) continue; seen.add(k);
      const pr = f.properties || {};
      areas.push({ kind, sev: pr.severity || null, ext: pr.extent || null,
        base: fl(pr.base) ?? (kind === 'CB' ? 0 : LOW_FL), baseKnown: fl(pr.base) != null,
        top: fl(pr.top) ?? (kind === 'CB' ? 450 : 300), ring: ll(raw) });
    }
    const jets = (d.JET || []).filter(f => f.geometry?.type === 'LineString').map(f => ({
      pts: ll(f.geometry.coordinates),
      fl: (f.properties?.fleche || []).map(q => ({ lat: +q.lat, lon: +q.lon, fl: +q.height, kt: +q.speed })).filter(q => q.fl),
    }));
    const trop = (d.TROP || []).filter(f => f.geometry?.type === 'LineString' && fl(f.properties?.height))
      .map(f => ({ pts: ll(f.geometry.coordinates), fl: fl(f.properties.height) }));
    const valid = new Date(issue.getTime() + step * 3600e3);
    return { issue, step, valid, areas, jets, trop };
  }
  throw lastErr || new Error('国際悪天予想図を取得できません');
}

// ---------- 画面 ----------
const CSS = `
#awSigwx{position:absolute;right:10px;bottom:200px;width:300px;max-height:calc(100vh - 260px);overflow:auto;z-index:30;box-shadow:0 4px 16px rgba(0,0,0,.5);
  background:rgba(20,30,45,.95);color:#fff;font:12.5px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:8px 10px;border-left:4px solid #ff5252}
#awSigwx[hidden]{display:none}
#awSigwx h3{margin:0 0 4px;font-size:14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
#awSigwx h3 button,#awSigwx .row button,#awSigwx .tm button{font:11.5px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:2px 6px;cursor:pointer}
#awSigwx .row{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
#awSigwx .row button[aria-pressed="true"]{background:#1e5a8c;border-color:#fff}
#awSigwx .row .lbl{font-size:11px;color:#9fb3c8;align-self:center;margin-right:2px}
#awSigwx .tm{display:flex;align-items:center;gap:6px}
#awSigwx .tm input{flex:1}
#awSigwx .tm button{min-width:34px}
#awSigwx .vt{font-size:12px;color:#cfe3f5;font-variant-numeric:tabular-nums}
#awSigwx .lg{display:flex;flex-wrap:wrap;gap:2px 8px;font-size:11px;color:#cfe3f5;margin-top:4px}
#awSigwx .lg i{display:inline-block;width:14px;height:10px;border:1px solid #47617d;margin-right:3px;vertical-align:-1px}
#awSigwx .note,#awSigwx .st{font-size:11px;color:#9fb3c8}
#awSigwx .pt{font-size:12px;color:#fff;background:rgba(255,255,255,.06);border-radius:5px;padding:4px 6px;margin-top:4px;min-height:1.5em}`;

export function createSigwxPanel(viewer) {
  const scene = viewer.scene;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const P = Object.assign(document.createElement('div'), { id: 'awSigwx', hidden: true });
  P.innerHTML = `<h3 title="ドラッグで移動">国際悪天予想図（WAFS SIGWX） <button data-x>閉じる</button></h3>
    <div class="row"><span class="lbl">表示</span><button data-m="map" aria-pressed="true">地図</button><button data-m="3d" aria-pressed="false" title="下限〜上限の高さで立体表示（高度の倍率に合わせる）">3D</button></div>
    <div class="row" data-els>${ELEM.map(([k, l]) => `<button data-e="${k}" aria-pressed="true">${l}</button>`).join('')}</div>
    <div class="tm"><button data-play aria-label="再生">▶</button><input type="range" min="0" max="${STEPS.length - 1}" value="0" data-t aria-label="予想時刻"></div>
    <div class="vt" data-vt>—</div>
    <div class="lg">
      <span><i style="background:${COL.CB}"></i>積乱雲（雲頂）</span>
      <span><i style="background:${COL.TURBmoderate}"></i>乱気流 並</span><span><i style="background:${COL.TURBsevere}"></i>強</span>
      <span><i style="background:${COL.ICINGmoderate}"></i>着氷 並</span><span><i style="background:${COL.ICINGsevere}"></i>強</span>
      <span><i style="background:${COL.JET}"></i>ジェット（中心の高さ・風速）</span><span><i style="background:${COL.TROP}"></i>圏界面の高さ</span>
    </div>
    <div class="note">高さは FL。XXX は図の下限より下まで広がる意味（3D では積乱雲は地表付近から、乱気流・着氷は FL${LOW_FL} から描く）。3D の積乱雲は、衛星画像（ひまわり全球画像）の範囲と画面の中心から 4,500km 以内をもくもくした雲で表示（それより遠くは枠）。</div>
    <div class="pt" data-pt>範囲や線をクリックすると内容を表示します。</div>
    <div class="st" data-st></div>`;
  document.body.appendChild(P);
  const $ = s => P.querySelector(s);
  const S = { mode: 'map', els: new Set(ELEM.map(e => e[0])), i: 0, issue: null, data: null, prims: [], gen: 0, playing: false, timer: null };
  const say = t => { $('[data-st]').textContent = t; };
  const scale = () => window.awGetAltScale?.() ?? 1;
  const H = f => Math.min(f, TOP_FL) * 100 * 0.3048 * scale();
  const fmtT = dt => {
    const j = new Date(dt.getTime() + 9 * 3600e3);
    return `${p2(dt.getUTCMonth() + 1)}/${p2(dt.getUTCDate())} ${p2(dt.getUTCHours())}Z（日本時間 ${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p2(j.getUTCHours())}:00）`;
  };

  let ds = null;                                  // ジェット気流の管（entity）用
  function clear() {
    for (const p of S.prims) { if (!scene.primitives.remove(p)) scene.groundPrimitives.remove(p); }
    S.prims = [];
    if (ds) { const d = ds; ds = null; viewer.dataSources.remove(d, true); }
  }
  // main.js の再読込（dataSources.removeAll）で消えたら描き直す
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d && d === ds) { ds = null; if (!P.hidden && S.mode === '3d') setTimeout(draw, 0); } });
  const inRing = (x, y, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  /** 画面の中心（地表）の経緯度。宇宙を向いているときは null */
  function viewCenter() {
    const c = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
    if (!c) return null;
    const g = Cesium.Cartographic.fromCartesian(c);
    return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)];
  }
  const kmBetween = (a, b) => {
    const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180, dl = ((b[0] - a[0] + 540) % 360 - 180) * Math.PI / 180;
    return 6371 * Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl)));
  };
  const addP = p => { S.prims.push(p); return p; };
  const cc = c => Cesium.ColorGeometryInstanceAttribute.fromColor(c);
  const C = k => Cesium.Color.fromCssColorString(COL[k]);

  function polyGeom(pts, h0, h1) {
    const hier = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(pts.slice(0, -1).flat()));
    const g = h0 == null ? new Cesium.PolygonGeometry({ polygonHierarchy: hier, arcType: Cesium.ArcType.RHUMB })
      : new Cesium.PolygonGeometry({ polygonHierarchy: hier, height: h0, extrudedHeight: h1, arcType: Cesium.ArcType.RHUMB });
    try { return Cesium.PolygonGeometry.createGeometry(g) ? g : null; } catch { return null; }
  }

  function draw() {
    clear();
    animeSky(viewer, !P.hidden && S.mode === '3d' && !!S.data, 'sigwx');
    if (!S.data) return;
    const d = S.data, solid = S.mode === '3d';
    const vc = solid ? viewCenter() : null;
    let puffBudget = 900;                         // 雲の柱の上限（重くなりすぎないように。衛星画像の範囲全体に広げたので 450 → 900）
    const gLines = [], gFill = [], boxes = [], edges = [], lines3 = [];
    const labels = addP(scene.primitives.add(new Cesium.LabelCollection({ scene })));
    const lab = (lon, lat, h, text, col, far = 1.2e7) => labels.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, h), text, font: '12px "Meiryo", sans-serif', fillColor: col,
      outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, far) });

    // ---- 範囲（積乱雲・乱気流・着氷） ----
    const areas = [];
    for (const kind of ['CB', 'TURB', 'ICING']) {
      if (!S.els.has(kind)) continue;
      const seen = new Set();
      for (const f of d[kind] || []) {
        const g = f.geometry; if (!g) continue;
        const raw = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'LineString' ? g.coordinates : null;
        if (!raw || raw.length < 3) continue;
        const pts = unwrap(raw), k = keyOf(pts);
        if (seen.has(k)) continue; seen.add(k);
        const pr = f.properties || {};
        const ck = kind === 'CB' ? 'CB' : kind + (pr.severity === 'severe' ? 'severe' : 'moderate');
        areas.push({ kind, ck, pts, pr, ring: closed(pts) ? pts : [...pts, pts[0]] });
      }
    }
    // 雲の柱の上限に届いたときに近い所が欠けないよう、画面の中心に近い順に作る
    if (vc) areas.sort((p, q) => kmBetween(vc, centroid(p.pts)) - kmBetween(vc, centroid(q.pts)));
    for (const a of areas) {
      const col = C(a.ck), id = { awSigwx: a };
      const top = fl(a.pr.top) ?? (a.kind === 'CB' ? 450 : 300);
      const base = fl(a.pr.base) ?? (a.kind === 'CB' ? 0 : LOW_FL);
      if (solid) {
        const h0 = H(base), h1 = Math.max(H(top), h0 + 300 * scale());
        const [cx, cy] = centroid(a.pts);
        const near = !vc || inSatDisk(cy, cx) || kmBetween(vc, [cx, cy]) < 4500;
        if (a.kind === 'CB' && near && puffBudget > 0) {
          // 積乱雲：雲の柱を範囲いっぱいに並べる（範囲が広いほど間隔を広げ、1か所あたり最大 40 本）
          const xs = a.ring.map(p => p[0]), ys = a.ring.map(p => p[1]);
          const w0 = Math.min(...xs), e0 = Math.max(...xs), s0 = Math.min(...ys), n0 = Math.max(...ys);
          const area = (e0 - w0) * (n0 - s0);
          const step = Math.max(1.0, Math.sqrt(area / 40));
          const cells = [];
          for (let y = s0 + step / 2; y < n0; y += step) for (let x = w0 + step / 2; x < e0; x += step) if (inRing(x, y, a.ring)) cells.push([x, y]);
          if (!cells.length) cells.push(centroid(a.pts));
          const R = step * 111000 * Math.cos(cells[0][1] * Math.PI / 180) * 0.62;
          // 雲頂の少し下までを柱、雲頂でかなとこ雲（横に広がる）
          const zTop = h1, zCol = h0 + (h1 - h0) * 0.82;
          cells.forEach(([x, y], i) => {
            if (puffBudget-- <= 0) return;
            const p = puffColumn(x, y, h0, zCol, R, { seed: Math.round(x * 131 + y * 977) + i, anvil: { z: zTop, R: R * 1.45 } });
            p._awId = id; addP(scene.primitives.add(p));
          });
          // 範囲の枠（上面）
          edges.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(a.ring.flatMap(p => [p[0], p[1], zTop])), width: 2, arcType: Cesium.ArcType.RHUMB }),
            attributes: { color: cc(col.withAlpha(0.85)) } }));
        } else {
          const g = polyGeom(a.ring, h0, h1);
          if (g) {
            const alpha = a.kind === 'CB' ? 0.32 : a.pr.severity === 'severe' ? 0.34 : 0.22;
            boxes.push(new Cesium.GeometryInstance({ id, geometry: g, attributes: { color: cc(col.withAlpha(alpha)) } }));
            // 上面と下面の縁（層の厚さが分かるように）
            for (const [h, al] of [[h1, 0.95], [h0, 0.5]]) edges.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.PolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(a.ring.flatMap(p => [p[0], p[1], h])), width: h === h1 ? 2 : 1, arcType: Cesium.ArcType.RHUMB }),
              attributes: { color: cc(col.withAlpha(al)) } }));
          }
        }
      } else {
        const g = polyGeom(a.ring);
        if (g) gFill.push(new Cesium.GeometryInstance({ id, geometry: g, attributes: { color: cc(col.withAlpha(a.kind === 'CB' ? 0.22 : 0.18)) } }));
      }
      gLines.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(a.ring.flat()),
        width: a.kind === 'CB' ? 2.5 : 2, arcType: Cesium.ArcType.RHUMB }), attributes: { color: cc(col.withAlpha(0.95)) } }));
      const [x, y] = centroid(a.pts);
      const name = a.kind === 'CB' ? `CB ${EXT[a.pr.extent] || a.pr.extent || ''}` : `${a.kind === 'TURB' ? '乱' : '着氷'} ${SEV[a.pr.severity] || ''}`;
      lab(x, y, solid ? H(top) + 3000 * scale() : 3000, `${name}\n${flText(a.pr.top)}/${flText(a.pr.base)}`, col);
    }

    // ---- ジェット気流：中心の高さ（3D）・風速 ----
    if (S.els.has('JET')) for (const f of d.JET || []) {
      const g = f.geometry; if (g?.type !== 'LineString') continue;
      const pts = unwrap(g.coordinates), fls = (f.properties?.fleche || []).map(q => ({ ...q, lon: q.lon }));
      if (pts.length < 2) continue;
      // 各点の高さ：一番近い矢（fleche）の高さ
      const near = ([x, y]) => fls.reduce((b, q) => { const dd = Math.hypot(((q.lon - x + 540) % 360) - 180, q.lat - y); return dd < b.d ? { d: dd, q } : b; }, { d: 1e9, q: null }).q;
      const id = { awSigwx: { kind: 'JET', pts, pr: f.properties } };
      if (solid) {
        // 国内悪天予想図の 3D と同じ：中心の高さに太い管（幅約 80km）、上に流れの向きの矢印、下に薄い幕
        ds ||= (() => { const x = new Cesium.CustomDataSource('sigwx3d'); viewer.dataSources.add(x); return x; })();
        const hts = pts.map(p => { const q = near(p); return H(q ? q.height : 300); });
        const pos = pts.map((p, i) => Cesium.Cartesian3.fromDegrees(p[0], p[1], hts[i]));
        const tubeW = 80000, tubeH = Math.max(6000 * 0.3048 * scale(), 3000);
        const shape = []; for (let k = 0; k < 360; k += 20) shape.push(new Cesium.Cartesian2(tubeW / 2 * Math.cos(k * Math.PI / 180), tubeH / 2 * Math.sin(k * Math.PI / 180)));
        const fast = Math.max(...fls.map(q => +q.speed || 0)) >= 120;
        const tc = Cesium.Color.fromCssColorString(fast ? '#e53935' : '#ab47bc');
        ds.entities.add({ polylineVolume: { positions: pos, shape, cornerType: Cesium.CornerType.ROUNDED, material: tc.withAlpha(0.5), outline: false } }).awSigwx = id.awSigwx;
        ds.entities.add({ polyline: { positions: pos.map((p, i) => Cesium.Cartesian3.fromDegrees(pts[i][0], pts[i][1], hts[i] + tubeH / 2 + 500)),
          width: 22, arcType: Cesium.ArcType.NONE, material: new Cesium.PolylineArrowMaterialProperty(tc.darken(0.3, new Cesium.Color()).withAlpha(0.95)) } });
        lines3.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.WallGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()),
          maximumHeights: hts, minimumHeights: hts.map(() => 0) }), attributes: { color: cc(tc.withAlpha(0.08)) } }));
      }
      gLines.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), width: 3.5, arcType: Cesium.ArcType.RHUMB }),
        attributes: { color: cc(C('JET').withAlpha(solid ? 0.45 : 0.95)) } }));
      // 終点の矢じり
      const [a, b] = [pts.at(-2), pts.at(-1)], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = s => [b[0] - 1.6 * Math.cos(ang + s), b[1] - 1.6 * Math.sin(ang + s)];
      gLines.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray([...head(0.45), ...b, ...head(-0.45)]), width: 3.5 }),
        attributes: { color: cc(C('JET')) } }));
      for (const q of fls) lab(q.lon, q.lat, solid ? H(q.height) + 6000 * scale() : 3000, `${q.speed}kt FL${q.height}`, C('JET'), 9e6);
    }

    // ---- 圏界面の高さ ----
    if (S.els.has('TROP')) for (const f of d.TROP || []) {
      const g = f.geometry, h = fl(f.properties?.height);
      if (g?.type === 'Point') { lab(g.coordinates[0], g.coordinates[1], solid && h ? H(h) : 3000, `[${h ?? ''}]`, C('TROP'), 9e6); continue; }
      if (g?.type !== 'LineString') continue;
      const pts = unwrap(g.coordinates), id = { awSigwx: { kind: 'TROP', pts, pr: f.properties } };
      if (solid && h) lines3.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.PolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(pts.flatMap(p => [p[0], p[1], H(h)])), width: 1.5, arcType: Cesium.ArcType.RHUMB }),
        attributes: { color: cc(C('TROP').withAlpha(0.7)) } }));
      else gLines.push(new Cesium.GeometryInstance({ id, geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), width: 1.5, arcType: Cesium.ArcType.RHUMB }),
        attributes: { color: cc(C('TROP').withAlpha(0.7)) } }));
      // 線に沿って 20度ごとに高さの数字
      let last = -1e9;
      pts.forEach((p, i) => { if (Math.abs(p[0] - last) >= 20 || i === 0) { last = p[0]; lab(p[0], p[1], solid && h ? H(h) : 3000, `FL${h}`, C('TROP'), 7e6); } });
    }

    // ---- 台風・火山・放射性物質 ----
    if (S.els.has('PT')) for (const kind of ['TC', 'VOLC', 'RAD']) for (const f of d[kind] || []) {
      if (f.geometry?.type !== 'Point') continue;
      const [x, y] = f.geometry.coordinates, nm = f.properties?.name || '';
      lab(x, y, 3000, `${kind === 'TC' ? '🌀 台風' : kind === 'VOLC' ? '▲ 火山' : '☢ 放射性物質'} ${nm}`, C(kind));
    }

    if (gFill.length) addP(scene.groundPrimitives.add(new Cesium.GroundPrimitive({ geometryInstances: gFill,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }), asynchronous: true })));
    if (gLines.length) addP(scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({ geometryInstances: gLines,
      appearance: new Cesium.PolylineColorAppearance(), asynchronous: true })));
    if (boxes.length) addP(scene.primitives.add(new Cesium.Primitive({ geometryInstances: boxes,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }), asynchronous: true })));
    if (edges.length) addP(scene.primitives.add(new Cesium.Primitive({ geometryInstances: edges,
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }), asynchronous: true })));
    const pl = lines3.filter(x => x.geometry instanceof Cesium.PolylineGeometry), wl = lines3.filter(x => !(x.geometry instanceof Cesium.PolylineGeometry));
    if (pl.length) addP(scene.primitives.add(new Cesium.Primitive({ geometryInstances: pl, appearance: new Cesium.PolylineColorAppearance({ translucent: true }), asynchronous: true })));
    if (wl.length) addP(scene.primitives.add(new Cesium.Primitive({ geometryInstances: wl, appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }), asynchronous: true })));
  }

  async function show() {
    const gen = ++S.gen;
    try {
      if (!S.issue) {
        say('最新の初期値を探しています…');
        for (const is of issueCandidates()) {
          try { await loadStep(is, STEPS[0]); S.issue = is; break; } catch (e) { if (!e.notFound) throw e; }
        }
        if (!S.issue) throw new Error('最新の予想が見つかりません');
        // 今の時刻に一番近い予想を最初に出す
        const now = Date.now();
        S.i = STEPS.reduce((b, s, i) => (Math.abs(S.issue.getTime() + s * 3600e3 - now) < Math.abs(S.issue.getTime() + STEPS[b] * 3600e3 - now) ? i : b), 0);
        $('[data-t]').value = S.i;
      }
      say(`読み込んでいます…（${STEPS[S.i]}時間予想）`);
      const data = await loadStep(S.issue, STEPS[S.i]);
      if (gen !== S.gen) return;
      S.data = data; draw();
      const vt = new Date(S.issue.getTime() + STEPS[S.i] * 3600e3);
      $('[data-vt]').textContent = `${fmtT(vt)}　T+${STEPS[S.i]}h／初期値 ${p2(S.issue.getUTCDate())}日${p2(S.issue.getUTCHours())}Z`;
      const n = k => (data[k] || []).length;
      say(`積乱雲 ${n('CB')}・乱気流 ${n('TURB')}・着氷 ${n('ICING')}・ジェット ${n('JET')}（全球）。出典：WAFS SigWx（NOAA AWC）。教育用で、運航の判断には使えません。`);
    } catch (e) { if (gen === S.gen) say(`読み込めませんでした（${e.message}）`); console.warn('[SIGWX]', e); }
  }

  function play() {
    if (S.playing) return; S.playing = true; $('[data-play]').textContent = '❚❚';
    const tick = async () => { if (!S.playing) return; S.i = (S.i + 1) % STEPS.length; $('[data-t]').value = S.i; await show(); S.timer = setTimeout(tick, S.i === 0 ? 1800 : 1100); };
    tick();
  }
  function pause() { S.playing = false; clearTimeout(S.timer); $('[data-play]').textContent = '▶'; }

  P.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
    S.mode = b.dataset.m;
    P.querySelectorAll('[data-m]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (S.mode === '3d') {
      if (scale() === 1) await window.awSetExag?.(window.AW_EXAG > 1 ? window.AW_EXAG : 25);
      const c = Cesium.Cartographic.fromCartesian(viewer.camera.pickEllipsoid(new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2)) || Cesium.Cartesian3.fromDegrees(135, 34));
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0), 1500000),
        { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-28), 4500000), duration: 1.5 });
    }
    draw();
  });
  P.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const k = b.dataset.e;
    S.els.has(k) ? S.els.delete(k) : S.els.add(k);
    b.setAttribute('aria-pressed', S.els.has(k)); draw();
  });
  $('[data-t]').oninput = e => { pause(); S.i = +e.target.value; show(); };
  $('[data-play]').onclick = () => (S.playing ? pause() : play());
  $('[data-x]').onclick = () => api.setVisible(false);
  window.addEventListener('aw:altscale', () => { if (!P.hidden && S.mode === '3d') setTimeout(draw, 0); });
  // 3D の雲の柱は画面の中心の近くだけなので、視点が大きく動いたら描き直す
  let lastVc = null;
  viewer.camera.moveEnd.addEventListener(() => {
    if (P.hidden || S.mode !== '3d' || !S.data) return;
    const v = viewCenter(); if (!v) return;
    if (!lastVc || kmBetween(v, lastVc) > 1500) { lastVc = v; draw(); }
  });

  // クリックした範囲・線の内容
  const hd = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  hd.setInputAction(ev => {
    if (P.hidden || !S.data) return;
    const hits = scene.drillPick(ev.position, 6).map(h => h.id?.awSigwx || h.primitive?._awId?.awSigwx).filter(Boolean);
    const el = $('[data-pt]');
    if (!hits.length) return;
    el.innerHTML = [...new Set(hits)].slice(0, 3).map(a => {
      const pr = a.pr || {};
      if (a.kind === 'CB') return `<b style="color:${COL.CB}">積乱雲</b> ${EXT[pr.extent] || pr.extent || ''}（${pr.extent || ''}）　雲頂 ${flText(pr.top)}・雲底 ${flText(pr.base)}`;
      if (a.kind === 'TURB' || a.kind === 'ICING') return `<b style="color:${COL[a.ck]}">${a.kind === 'TURB' ? '乱気流（晴天乱気流を含む）' : '着氷'} ${SEV[pr.severity] || pr.severity || ''}</b>　${flText(pr.base)}〜${flText(pr.top)}`;
      if (a.kind === 'JET') return `<b style="color:${COL.JET}">ジェット気流</b>　` + (pr.fleche || []).map(q => `${q.speed}kt FL${q.height}`).join('、');
      if (a.kind === 'TROP') return `<b style="color:${COL.TROP}">圏界面</b>　FL${pr.height}`;
      return '';
    }).join('<br>');
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 見出しをドラッグしてパネルを動かす
  const h3 = $('h3');
  h3.onpointerdown = e => {
    if (e.target.closest('button')) return;
    const r = P.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    h3.setPointerCapture(e.pointerId);
    h3.onpointermove = m => {
      P.style.bottom = 'auto'; P.style.right = 'auto'; P.dataset.moved = '1';
      P.style.left = `${Math.max(0, Math.min(innerWidth - 60, m.clientX - ox))}px`;
      P.style.top = `${Math.max(0, Math.min(innerHeight - 40, m.clientY - oy))}px`;
    };
    h3.onpointerup = () => { h3.onpointermove = null; };
  };
  // 右下（右下のボタン群の上）。GPV のパネルが開いていれば、その左に並べる
  function place() {
    if (P.hidden || P.dataset.moved) return;
    const cb = document.getElementById('camButtons')?.getBoundingClientRect();
    const gpv = document.getElementById('awGpv');
    const shift = gpv && !gpv.hidden && !gpv.dataset.moved ? gpv.offsetWidth + 10 : 0;
    Object.assign(P.style, { left: 'auto', top: 'auto', right: `${10 + shift}px`, bottom: '40px', maxHeight: 'calc(100vh - 140px)' });
    if (!cb) return;
    const room = cb.top - 70;
    if (room >= Math.min(P.scrollHeight, 380)) { P.style.bottom = `${innerHeight - cb.top + 8}px`; P.style.maxHeight = `${room}px`; }
    else P.style.right = `${innerWidth - cb.left + 8 + shift}px`;
  }
  window.addEventListener('resize', place);
  window.addEventListener('aw:gpv', () => setTimeout(place, 0));

  const api = {
    get on() { return !P.hidden; },
    async setVisible(on) {
      P.hidden = !on;
      window.dispatchEvent(new CustomEvent('aw:sigwx', { detail: on }));
      if (on) {
        // 初期値が新しくなっていたら読み直す
        const latest = issueCandidates()[0];
        if (S.issue && S.issue.getTime() < latest.getTime()) { S.issue = null; memo.clear(); }
        place(); await show(); place();
      } else { pause(); S.gen++; clear(); animeSky(viewer, false, 'sigwx'); }
    },
  };
  return api;
}
