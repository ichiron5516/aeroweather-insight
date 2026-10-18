// 台風進路予想図（気象庁の台風情報 JSON から描く）
//   https://www.jma.go.jp/bosai/typhoon/data/targetTc.json … 発表中の台風の一覧
//   …/data/TCxxxx/forecast.json       … 経路・中心・予報円・暴風警戒域・強風域の形
//   …/data/TCxxxx/specifications.json … 中心気圧・最大風速・進路・強風域／暴風域の半径など
//   形の円弧は [中心[緯度,経度], 半径m, [始まりの方位, 終わりの方位]]（方位は北から時計回り）。
import * as Cesium from 'cesium';

const BASE = 'https://www.jma.go.jp/bosai/typhoon/data';
const getJSON = async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

/** 発表中の台風（なければ空の配列） */
export async function fetchTyphoons() {
  const list = await getJSON(`${BASE}/targetTc.json`);
  const out = [];
  for (const t of list || []) {
    try {
      const [fc, sp] = await Promise.all([getJSON(`${BASE}/${t.tropicalCyclone}/forecast.json`), getJSON(`${BASE}/${t.tropicalCyclone}/specifications.json`)]);
      const title = fc.find(p => p.part === 'title') || {};
      const parts = fc.filter(p => p.part !== 'title').map(p => ({ ...p, spec: sp.find(s => s.advancedHours === p.advancedHours && s.part !== 'title') || {} }));
      out.push({ id: t.tropicalCyclone, number: t.typhoonNumber, category: t.category, issue: title.issue?.JST, name: title.name || {}, parts });
    } catch (e) { console.warn('[typhoon]', t.tropicalCyclone, e); }
  }
  return out;
}

// ---- 図形（球面上で、中心から方位・距離の点を求める） ----
const R = 6371000, D2R = Math.PI / 180;
function dest(lat, lon, brg, dist) {
  const d = dist / R, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / D2R, l2 / D2R];
}
const arcPts = ([lat, lon], r, a0 = 0, a1 = 360) => {
  const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 5)), out = [];
  for (let k = 0; k <= n; k++) out.push(dest(lat, lon, a0 + (a1 - a0) * k / n, r));
  return out;
};
const label = n => `台風${Number(String(n).slice(-2))}号`;
const jst = s => { const d = new Date(s); return `${d.getDate()}日${String(d.getHours()).padStart(2, '0')}時`; };

/** 1つの台風の図形（線・円）を、緯度経度の点列にまとめる */
function shapes(tc) {
  const S = { track: [], pre: [], gale: [], storm: [], circles: [], warn: [], centers: [], links: [] };
  for (const p of tc.parts) {
    if (p.advancedHours === 0) {
      S.track = p.track?.typhoon || []; S.pre = p.track?.preTyphoon || [];
      if (p.galeWarningArea) S.gale.push(arcPts(p.galeWarningArea.center, p.galeWarningArea.radius));
      for (const a of p.stormWarningArea?.arc || []) S.storm.push(arcPts(a[0], a[1], a[2][0], a[2][1]));
    } else {
      if (p.probabilityCircle) S.circles.push(arcPts(p.center, p.probabilityCircle.radius));
      for (const a of p.stormWarningArea?.arc || []) S.warn.push(arcPts(a[0], a[1], a[2][0], a[2][1]));
      for (const l of p.stormWarningArea?.line || []) S.warn.push(l);
    }
    if (p.center) S.centers.push({ at: p.center, h: p.advancedHours, t: p.validtime?.JST, spec: p.spec });
  }
  S.links = S.centers.map(c => c.at);
  return S;
}

// ---- 一覧用の図（ひまわり赤外の上に描く。メルカトル） ----
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2 * 2 ** z * 256;
const loadImg = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ng; im.src = src; });

export async function typhoonCanvas(tcs, { irTiles = null, airports = [], z = 4 } = {}) {
  // 範囲：台風の経路・予報円と日本を含む
  let s = 24, n = 46, w = 122, e = 147;
  for (const tc of tcs) for (const ring of [...shapes(tc).circles, ...shapes(tc).gale]) for (const [la, lo] of ring) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  s -= 1; n += 1; w -= 1; e += 1;
  const X0 = lon2x(w, z), X1 = lon2x(e, z), Y0 = lat2y(n, z), Y1 = lat2y(s, z);
  const cv = document.createElement('canvas'); cv.width = Math.round(X1 - X0); cv.height = Math.round(Y1 - Y0);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0b141e'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (irTiles) {
    const jobs = [];
    for (let tx = Math.floor(X0 / 256); tx <= Math.floor(X1 / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor(Y1 / 256); ty++)
      jobs.push(loadImg(irTiles.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then(im => ctx.drawImage(im, tx * 256 - X0, ty * 256 - Y0)).catch(() => null));
    await Promise.all(jobs);
  }
  const P = ([la, lo]) => [lon2x(lo, z) - X0, lat2y(la, z) - Y0];
  const line = (pts, color, width = 2, dash = []) => { if (pts.length < 2) return; ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); pts.forEach((p, k) => { const [x, y] = P(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]); };
  const fill = (pts, color) => { ctx.fillStyle = color; ctx.beginPath(); pts.forEach((p, k) => { const [x, y] = P(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill(); };
  // 経緯線
  ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
  for (let lo = Math.ceil(w / 5) * 5; lo <= e; lo += 5) { const x = lon2x(lo, z) - X0; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
  for (let la = Math.ceil(s / 5) * 5; la <= n; la += 5) { const y = lat2y(la, z) - Y0; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
  for (const tc of tcs) {
    const S = shapes(tc);
    S.gale.forEach(r => { fill(r, 'rgba(255,214,0,0.18)'); line(r, '#ffd600', 1.5); });
    S.storm.forEach(r => { fill(r, 'rgba(255,40,40,0.35)'); line(r, '#ff3b3b', 1.5); });
    line(S.pre, '#cfd8dc', 1.5, [4, 3]); line(S.track, '#ffffff', 2);
    line(S.links, '#ffffff', 1.2, [5, 4]);
    S.circles.forEach(r => line(r, '#ffffff', 1.2, [5, 4]));
    S.warn.forEach(r => line(r, '#ff3b3b', 2));
    ctx.font = '600 11px Meiryo, sans-serif';
    for (const c of S.centers) {
      const [x, y] = P(c.at);
      ctx.fillStyle = c.h ? '#fff' : '#ff3b3b'; ctx.beginPath(); ctx.arc(x, y, c.h ? 2.5 : 4, 0, 7); ctx.fill();
      if (c.t) { const t = c.h ? jst(c.t) : `${label(tc.number)} ${c.spec.pressure || ''}hPa`; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(t, x + 6, y + 4); ctx.fillStyle = '#fff'; ctx.fillText(t, x + 6, y + 4); }
    }
  }
  ctx.font = '600 10px Meiryo, sans-serif';
  for (const a of airports) {
    const [x, y] = P([a.lat, a.lon]); if (x < 0 || y < 0 || x > cv.width || y > cv.height) continue;
    ctx.fillStyle = '#4fc3f7'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(a.iata, x + 4, y + 3); ctx.fillStyle = '#fff'; ctx.fillText(a.iata, x + 4, y + 3);
  }
  return cv;
}

// ---- 地図（地球儀）に描く ----
export function drawTyphoon3D(viewer, tcs) {
  const ds = new Cesium.CustomDataSource('typhoon');
  const pos = pts => pts.map(([la, lo]) => Cesium.Cartesian3.fromDegrees(lo, la, 3000));
  const C = c => Cesium.Color.fromCssColorString(c);
  const pl = (pts, color, width, dash = false) => pts.length > 1 && ds.entities.add({ polyline: { positions: pos(pts), width, arcType: Cesium.ArcType.GEODESIC,
    material: dash ? new Cesium.PolylineDashMaterialProperty({ color: C(color), dashLength: 14 }) : C(color) } });
  const poly = (pts, color) => ds.entities.add({ polygon: { hierarchy: pos(pts), material: C(color), height: 0 } });
  for (const tc of tcs) {
    const S = shapes(tc);
    S.gale.forEach(r => { poly(r, 'rgba(255,214,0,0.15)'); pl(r, '#ffd600', 2); });
    S.storm.forEach(r => { poly(r, 'rgba(255,40,40,0.32)'); pl(r, '#ff3b3b', 2); });
    pl(S.pre, '#cfd8dc', 2, true); pl(S.track, '#ffffff', 3);
    pl(S.links, '#ffffff', 2, true);
    S.circles.forEach(r => pl(r, '#ffffff', 2, true));
    S.warn.forEach(r => pl(r, '#ff3b3b', 3));
    for (const c of S.centers) {
      const sp = c.spec || {};
      const text = c.h ? `${jst(c.t)}（${c.h}時間後）${sp.pressure ? ` ${sp.pressure}hPa` : ''}${sp.maximumWind?.sustained?.kt ? ` 最大${sp.maximumWind.sustained.kt}kt` : ''}`
        : `${label(tc.number)}${tc.name.jp ? `（${tc.name.jp}）` : ''} ${sp.pressure || ''}hPa\n最大風速 ${sp.maximumWind?.sustained?.kt || '?'}kt・最大瞬間 ${sp.maximumWind?.gust?.kt || '?'}kt\n${sp.course || ''} ${sp.speed?.kt || ''}kt`;
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(c.at[1], c.at[0], 3000),
        point: { pixelSize: c.h ? 6 : 10, color: c.h ? Cesium.Color.WHITE : C('#ff3b3b'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text, font: c.h ? '12px Meiryo' : '700 13px Meiryo', fillColor: Cesium.Color.WHITE, showBackground: true,
          backgroundColor: C(c.h ? 'rgba(20,30,45,0.75)' : 'rgba(150,20,20,0.85)'), pixelOffset: new Cesium.Cartesian2(10, 0),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, c.h ? 6e6 : 2e7) } });
    }
  }
  viewer.dataSources.add(ds);
  return ds;
}

// ---- 文章（今の状況） ----
const km = (a, b) => { const p1 = a[0] * D2R, p2 = b[0] * D2R, dl = (b[1] - a[1]) * D2R; return 2 * R / 1000 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2)); };
export function typhoonText(tcs, airports = []) {
  if (!tcs.length) return ['現在、発表中の台風はありません。'];
  const out = [];
  for (const tc of tcs) {
    const now = tc.parts.find(p => p.advancedHours === 0) || {}, sp = now.spec || {};
    const gale = (sp.galeWarning || []).map(g => `${typeof g.area === 'string' ? g.area : g.area?.jp}側 ${g.range?.km}km`).join('・');
    const storm = (sp.stormWarning || []).map(g => `${typeof g.area === 'string' ? g.area : g.area?.jp} ${g.range?.km}km`).join('・');
    out.push(`<b>${label(tc.number)}${tc.name.jp ? `（${tc.name.jp}）` : ''}</b>：${now.validtime ? jst(now.validtime.JST) : ''}（日本時間）に${sp.location || ''}（北緯${now.center?.[0]}度・東経${now.center?.[1]}度）。` +
      `${sp.scale || ''}${sp.intensity ? `で${sp.intensity}` : ''}。中心気圧 ${sp.pressure}hPa、最大風速 ${sp.maximumWind?.sustained?.kt}kt（最大瞬間 ${sp.maximumWind?.gust?.kt}kt）。${sp.course || ''}へ ${sp.speed?.kt || '?'}kt で進む。`);
    if (storm || gale) out.push(`暴風域（風速50kt以上）：${storm || 'なし'}。強風域（風速30kt以上）：${gale || 'なし'}。`);
    const fc = tc.parts.filter(p => p.advancedHours > 0);
    if (fc.length) out.push('予報：' + fc.map(p => `${jst(p.validtime.JST)}（${p.advancedHours}時間後）${p.spec.location || ''} ${p.spec.pressure || ''}hPa`).join('、') + '。');
    // 空港への影響：暴風域・暴風警戒域（各時刻の円を、時刻の間はなめらかにつないだ範囲）に入るか
    const discs = [now, ...fc].map(p => {
      const arcs = p.stormWarningArea?.arc || [];
      if (!arcs.length || !p.center) return null;
      // その時刻の円＝中心がその時刻の中心にいちばん近い円弧
      const a = arcs.reduce((m, x) => (km(x[0], p.center) < km(m[0], p.center) ? x : m));
      return { c: a[0], r: a[1] / 1000, h: p.advancedHours, t: p.validtime?.JST };
    }).filter(Boolean);
    const hits = [];
    for (const a of airports) {
      const q = [a.lat, a.lon];
      let when = null;
      for (let k = 0; k < discs.length && !when; k++) {
        const A = discs[k], B = discs[k + 1] || A;
        for (let f = 0; f <= 1; f += 0.05) {
          const c = [A.c[0] + (B.c[0] - A.c[0]) * f, A.c[1] + (B.c[1] - A.c[1]) * f], r = A.r + (B.r - A.r) * f;
          if (km(c, q) <= r) { const d = f < 0.5 ? A : B; when = d.h ? `${jst(d.t)}ごろ` : '現在'; break; }
        }
      }
      if (when) hits.push(`${a.iata}（${when}）`);
    }
    out.push(hits.length ? `暴風警戒域にかかる可能性のある空港：${hits.join('・')}。欠航・ダイバートや代替空港の天候に注意。` : '表示している空港は、予報期間中に暴風警戒域にかかる見込みはない。');
  }
  return out;
}
