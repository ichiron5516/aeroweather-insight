// 海面水温（SST）と海流（2026-10-17 追加）
//   ・海面水温：NASA GIBS の GHRSST L4 MUR（約1km・毎日・衛星と観測を合わせた解析値。前日分が最新）。
//     タイルの色は GIBS の色表（GHRSST_Sea_Surface_Temperature）で、−0℃〜32℃ を 0.15℃ ごと。
//     地図に重ねている間は、マウスを載せた所の水温（℃）を札で出す（タイルの色を色表で水温に戻す）
//   ・海流：日本付近〜西太平洋の主な海流の平均的な流れ（模式図）を矢印と名前で出す。暖流は赤、寒流は青。
//     実際の流路（黒潮の大蛇行など）は日によって変わるので、海面水温の図と合わせて見る
import * as Cesium from 'cesium';

const LAYER = 'GHRSST_L4_MUR_Sea_Surface_Temperature';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const TMS = 'GoogleMapsCompatible_Level7';
const TILE = `${GIBS}/${LAYER}/default/default/${TMS}/{z}/{y}/{x}.png`;   // default＝最新の日
const COLORMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/GHRSST_Sea_Surface_Temperature.xml';
export const SST_LEGEND = 'https://gibs.earthdata.nasa.gov/legends/GHRSST_Sea_Surface_Temperature_H.svg';

/** 最新の日付（GIBS に問い合わせ。取れなければ null） */
async function latestDate() {
  try {
    const now = new Date(), from = new Date(now - 20 * 864e5).toISOString().slice(0, 10), to = now.toISOString().slice(0, 10);
    const x = await (await fetch(`${GIBS}/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${LAYER}&TILEMATRIXSET=${TMS}&TimeRange=${from}/${to}`)).text();
    const d = (x.match(/<Domain>([^<]*)<\/Domain>/) || [])[1] || '';
    const m = d.match(/(\d{4}-\d{2}-\d{2})(?:\/P1D)?\s*$/) || d.match(/.*(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** 色表（rgb → 水温の範囲の中央） */
let cmapP = null;
function colormap() {
  return (cmapP ||= fetch(COLORMAP).then(r => r.text()).then(x => {
    const out = [];
    for (const m of x.matchAll(/<ColorMapEntry ([^>]*)\/>/g)) {
      const a = m[1], rgb = (a.match(/rgb="(\d+),(\d+),(\d+)"/) || []).slice(1).map(Number), v = a.match(/value="\[([^,]+),([^)\]]+)[)\]]"/);
      if (!v || rgb.length < 3) continue;
      const lo = parseFloat(v[1]), hi = parseFloat(v[2]);
      out.push({ rgb, v: isFinite(lo) && isFinite(hi) ? (lo + hi) / 2 : isFinite(lo) ? lo : hi });
    }
    return out;
  }).catch(() => []));
}
const nearest = (cm, r, g, b) => {
  let best = null, e0 = 1e9;
  for (const c of cm) { const e = (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2; if (e < e0) { e0 = e; best = c; } }
  return e0 < 300 ? best : null;                                       // 色表にない色（縁のにじみなど）は読まない
};

// ---------- 海流（平均的な流れの模式図） ----------
//   pts：[経度, 緯度] を流れの向きの順。label：名前を置く点の番号
export const CURRENTS = [
  { name: '黒潮', kind: 'warm', label: 5, pts: [[123.0, 17.5], [122.6, 21.0], [122.4, 23.5], [124.5, 25.8], [127.0, 27.6], [129.3, 29.6], [131.5, 31.0], [133.8, 32.4], [136.0, 33.1], [138.5, 34.0], [140.6, 35.2]] },
  { name: '黒潮続流', kind: 'warm', label: 2, pts: [[140.6, 35.2], [143.0, 35.8], [146.5, 36.0], [150.5, 36.4], [155.0, 36.6], [160.0, 37.2]] },
  { name: '北太平洋海流', kind: 'warm', label: 1, pts: [[160.0, 37.2], [164.0, 38.5], [168.5, 39.5]] },
  { name: '対馬海流', kind: 'warm', label: 3, pts: [[126.5, 28.5], [127.0, 31.0], [128.6, 33.2], [130.2, 34.6], [133.0, 35.9], [135.8, 36.9], [138.2, 38.4], [139.4, 40.2], [139.8, 41.4]] },
  { name: '津軽暖流', kind: 'warm', label: 1, pts: [[139.8, 41.4], [140.6, 41.6], [141.4, 41.5], [142.0, 41.0], [142.2, 40.0]] },
  { name: '宗谷暖流', kind: 'warm', label: 2, pts: [[139.8, 41.4], [140.6, 43.5], [141.4, 45.3], [142.3, 45.6], [143.5, 44.8], [145.0, 44.1]] },
  { name: '台湾暖流', kind: 'warm', label: 1, pts: [[117.8, 23.0], [119.6, 24.8], [121.0, 26.8], [122.6, 28.8]] },
  { name: '北赤道海流', kind: 'warm', label: 1, pts: [[168.0, 13.0], [155.0, 13.5], [143.0, 14.0], [132.0, 14.0], [125.5, 14.0]] },
  { name: 'ミンダナオ海流', kind: 'warm', label: 1, pts: [[126.8, 12.0], [127.2, 9.0], [127.0, 6.5]] },
  { name: '北赤道反流', kind: 'warm', label: 2, pts: [[129.0, 5.0], [137.0, 5.5], [146.0, 6.0], [156.0, 6.5], [168.0, 7.0]] },
  { name: '黒潮反流', kind: 'warm', label: 1, pts: [[150.0, 23.5], [142.0, 23.0], [134.0, 22.5], [127.0, 22.0]], thin: true },
  { name: '親潮', kind: 'cold', label: 2, pts: [[151.0, 46.0], [148.0, 43.8], [145.8, 42.3], [143.6, 41.2], [142.6, 39.6], [141.9, 37.6]] },
  { name: '東カムチャツカ海流', kind: 'cold', label: 1, pts: [[164.0, 55.0], [160.0, 51.5], [156.0, 49.0], [151.0, 46.0]] },
  { name: 'リマン海流', kind: 'cold', label: 2, pts: [[140.5, 50.5], [140.0, 47.5], [137.5, 45.0], [134.5, 42.7], [131.5, 41.2], [129.8, 39.5]] },
  { name: '北朝鮮寒流', kind: 'cold', label: 1, pts: [[129.8, 39.5], [129.6, 37.5], [129.7, 36.2]], thin: true },
  { name: '中国沿岸流', kind: 'cold', label: 1, pts: [[122.4, 31.5], [121.5, 28.6], [120.0, 25.6], [117.5, 23.4]], thin: true, note: '冬に強い' },
];

export function createSeaLayer(viewer, { onStatus } = {}) {
  let sst = null, date = null, cur = null;
  // ---- 海面水温 ----
  async function showSst() {
    if (sst) return;
    const provider = new Cesium.UrlTemplateImageryProvider({ url: TILE, maximumLevel: 7, minimumLevel: 0, hasAlphaChannel: true,
      credit: new Cesium.Credit('海面水温：NASA GIBS / GHRSST L4 MUR（JPL）') });
    sst = viewer.imageryLayers.addImageryProvider(provider, 1);       // 地図のすぐ上（雲・レーダーより下）
    sst.alpha = 0.8;
    onStatus?.('海面水温を読み込んでいます…');
    date ||= await latestDate();
    onStatus?.(`海面水温：${date ? date.replace(/-/g, '/') + '（世界時）の解析' : '最新の解析'}・約1km（NASA GIBS / GHRSST MUR）。地図にマウスを載せると水温を表示`);
    colormap();
  }
  function hideSst() { if (sst) { viewer.imageryLayers.remove(sst, true); sst = null; } tip.style.display = 'none'; onStatus?.(''); }

  // ---- マウスを載せた所の水温 ----
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;z-index:40;pointer-events:none;display:none;background:rgba(20,30,45,.92);color:#fff;border:1px solid #4fc3f7;' +
    'border-radius:5px;padding:2px 7px;font:12px "Meiryo",sans-serif;white-space:nowrap';
  document.body.append(tip);
  const ZS = 6, tiles = new Map();
  const tileData = (x, y) => {
    const k = `${x}/${y}`;
    if (!tiles.has(k)) {
      tiles.set(k, new Promise(ok => {
        const im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); ok(g.getImageData(0, 0, 256, 256).data); };
        im.onerror = () => ok(null);
        im.src = TILE.replace('{z}', ZS).replace('{x}', x).replace('{y}', y);
      }));
      if (tiles.size > 60) tiles.delete(tiles.keys().next().value);
    }
    return tiles.get(k);
  };
  let pending = false, last = null;
  const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  h.setInputAction(mv => {
    if (!sst) return;
    last = Cesium.Cartesian2.clone(mv.endPosition);
    if (pending) return; pending = true;
    requestAnimationFrame(async () => {
      pending = false;
      const p = last && viewer.camera.pickEllipsoid(last);
      if (!p) { tip.style.display = 'none'; return; }
      const g = Cesium.Cartographic.fromCartesian(p), lon = Cesium.Math.toDegrees(g.longitude), lat = Cesium.Math.toDegrees(g.latitude);
      const n = 2 ** ZS, fx = (lon + 180) / 360 * n, fy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
      const x = Math.floor(fx), y = Math.floor(fy);
      const [d, cm] = await Promise.all([tileData(((x % n) + n) % n, y), colormap()]);
      if (!sst || !d || !cm.length) { tip.style.display = 'none'; return; }
      const k = (Math.min(255, Math.floor((fy - y) * 256)) * 256 + Math.min(255, Math.floor((fx - x) * 256))) * 4;
      const c = d[k + 3] > 0 ? nearest(cm, d[k], d[k + 1], d[k + 2]) : null;
      if (!c) { tip.style.display = 'none'; return; }
      const rc = viewer.canvas.getBoundingClientRect();
      tip.textContent = `海面水温 ${c.v < 0 ? '0℃未満' : c.v >= 32 ? '32℃以上' : c.v.toFixed(1) + '℃'}`;
      tip.style.left = `${rc.left + last.x + 14}px`; tip.style.top = `${rc.top + last.y + 16}px`; tip.style.display = 'block';
    });
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // ---- 海流 ----
  function showCurrents() {
    if (cur) return;
    cur = new Cesium.CustomDataSource('oceanCurrents');
    viewer.dataSources.add(cur);
    for (const c of CURRENTS) {
      const warm = c.kind === 'warm', col = Cesium.Color.fromCssColorString(warm ? '#ff7043' : '#29b6f6');
      cur.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights(c.pts.flatMap(([lo, la]) => [lo, la, 300])),
        width: c.thin ? 9 : 14, arcType: Cesium.ArcType.GEODESIC,
        material: new Cesium.PolylineArrowMaterialProperty(col.withAlpha(c.thin ? 0.7 : 0.85)) } });
      const [lo, la] = c.pts[Math.min(c.label, c.pts.length - 1)];
      cur.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, 300), label: {
        text: `${c.name}${c.note ? `（${c.note}）` : ''}`, font: '700 13px "Meiryo", sans-serif',
        fillColor: Cesium.Color.WHITE, showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString(warm ? 'rgba(160,45,20,0.85)' : 'rgba(10,80,140,0.85)'),
        backgroundPadding: new Cesium.Cartesian2(6, 3), pixelOffset: new Cesium.Cartesian2(0, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 1.2e7, 0.75),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.6e7) },
        description: `${c.name}（${warm ? '暖流' : '寒流'}）。平均的な流れの模式図` });
    }
    viewer.scene.requestRender?.();
  }
  function hideCurrents() { const c = cur; cur = null; if (c) viewer.dataSources.remove(c, true); }
  // main.js の再読込（dataSources.removeAll）で消えたら付け直す
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === cur) { cur = null; setTimeout(showCurrents, 0); } });

  return {
    get sstOn() { return !!sst; },
    get currentsOn() { return !!cur; },
    async setSst(on) { if (on) await showSst(); else hideSst(); return !!sst; },
    setCurrents(on) { if (on) showCurrents(); else hideCurrents(); return !!cur; },
  };
}
