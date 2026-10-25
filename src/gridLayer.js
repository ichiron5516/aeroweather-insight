// 緯度・経度の線（2026-10-18）
//   ・カメラの高さで間隔を変える（遠い：10° → 5° → 2° → 1° → 近い：30'）
//   ・見えている範囲だけ線を引き、カメラが止まるたびに引き直す（地形に沿わせる clampToGround）
//   ・画面の真ん中を通る経線の上に緯度、緯線の上に経度の目盛りを出す。0°・赤道・180° と 5 の倍数の線は少し太く
import * as Cesium from 'cesium';

const STEPS = [[8.0e6, 10], [3.0e6, 5], [1.2e6, 2], [4.0e5, 1], [0, 0.5]];
const fmt = (v, pos, neg) => {
  const a = Math.abs(v), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 60);
  const h = v > 1e-9 ? pos : v < -1e-9 ? neg : '';
  return m ? `${d}°${String(m).padStart(2, '0')}'${h}` : `${d}°${h}`;
};
const lonText = v => { let x = ((v + 540) % 360) - 180; if (Math.abs(Math.abs(x) - 180) < 1e-9) return '180°'; return fmt(x, 'E', 'W'); };
const latText = v => fmt(v, 'N', 'S');

export function createGridLayer(viewer) {
  const ds = new Cesium.CustomDataSource('latlon-grid');
  viewer.dataSources.add(ds);
  ds.show = false;
  // main.js の再読込（高度の倍率を変えたときなどの dataSources.removeAll）で消えたら付け直す（2026-10-25。消えたままで表示できなかった）
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => { if (!viewer.dataSources.contains(ds)) viewer.dataSources.add(ds); }, 0); });
  let on = false, lastKey = '', remove = null;

  const LINE = Cesium.Color.fromCssColorString('#cfe8ff').withAlpha(0.45);
  const MAJOR = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.75);
  const SPECIAL = Cesium.Color.fromCssColorString('#ffd54f').withAlpha(0.85);

  function viewRect() {
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    const c = viewer.camera.positionCartographic;
    if (!r) return { w: -180, e: 180, s: -80, n: 80, lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
    let w = Cesium.Math.toDegrees(r.west), e = Cesium.Math.toDegrees(r.east);
    if (e < w) e += 360;                        // 日付変更線をまたぐ
    return { w, e, s: Math.max(-85, Cesium.Math.toDegrees(r.south)), n: Math.min(85, Cesium.Math.toDegrees(r.north)) };
  }
  function centerLL() {
    const canvas = viewer.scene.canvas;
    const p = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const c = p ? Cesium.Cartographic.fromCartesian(p) : viewer.camera.positionCartographic;
    return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
  }

  function rebuild() {
    if (!on) return;
    const h = viewer.camera.positionCartographic.height;
    const step = STEPS.find(([alt]) => h >= alt)[1];
    const R = viewRect(), C = centerLL();
    // 少し広めに引いておく（動かしてすぐ端が切れないように）
    const pad = step * 2;
    const w = Math.floor((R.w - pad) / step) * step, e = Math.ceil((R.e + pad) / step) * step;
    const s = Math.max(-80, Math.floor((R.s - pad) / step) * step), n = Math.min(80, Math.ceil((R.n + pad) / step) * step);
    const key = [step, w, e, s, n, Math.round(C.lon / step), Math.round(C.lat / step)].join(',');
    if (key === lastKey) return;
    lastKey = key;
    ds.entities.suspendEvents();
    ds.entities.removeAll();
    const big = v => Math.abs(v % (step >= 5 ? 30 : step >= 2 ? 10 : 5)) < 1e-9;
    const nLon = Math.round((e - w) / step), nLat = Math.round((n - s) / step);
    if (nLon > 400 || nLat > 400) { ds.entities.resumeEvents(); return; }
    // 経線
    for (let i = 0; i <= nLon; i++) {
      const lon = w + i * step, x = ((lon + 540) % 360) - 180;
      const sp = Math.abs(x) < 1e-9 || Math.abs(Math.abs(x) - 180) < 1e-9;
      ds.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([lon, s, lon, (s + n) / 2, lon, n]),
        width: sp || big(lon) ? 1.6 : 1, material: sp ? SPECIAL : big(lon) ? MAJOR : LINE,
        clampToGround: true, arcType: Cesium.ArcType.GEODESIC,
      } });
    }
    // 緯線（等緯度なので RHUMB。長いときは 30° ごとに区切る）
    for (let j = 0; j <= nLat; j++) {
      const lat = s + j * step, sp = Math.abs(lat) < 1e-9;
      const pts = [];
      for (let lon = w; lon < e; lon += 30) pts.push(lon, lat);
      pts.push(e, lat);
      ds.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(pts),
        width: sp || big(lat) ? 1.6 : 1, material: sp ? SPECIAL : big(lat) ? MAJOR : LINE,
        clampToGround: true, arcType: Cesium.ArcType.RHUMB,
      } });
    }
    // 目盛り：画面の真ん中に近い経線・緯線の上
    const lab = { font: '12px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, pixelOffset: new Cesium.Cartesian2(4, -4),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT, verticalOrigin: Cesium.VerticalOrigin.BOTTOM };
    let cLon = Math.round(C.lon / step) * step; while (cLon < w) cLon += 360; while (cLon > e) cLon -= 360;
    const cLat = Math.max(s, Math.min(n, Math.round(C.lat / step) * step));
    for (let j = 0; j <= nLat; j++) {
      const lat = s + j * step;
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(cLon, lat), label: { ...lab, text: latText(lat) } });
    }
    for (let i = 0; i <= nLon; i++) {
      const lon = w + i * step;
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(lon, cLat), label: { ...lab, text: lonText(lon) } });
    }
    ds.entities.resumeEvents();
    viewer.scene.requestRender();
  }

  return {
    get on() { return on; },
    setVisible(v) {
      on = !!v; ds.show = on;
      if (on) { lastKey = ''; rebuild(); remove ||= viewer.camera.moveEnd.addEventListener(rebuild); }
      else if (remove) { remove(); remove = null; }
      viewer.scene.requestRender();
    },
  };
}
