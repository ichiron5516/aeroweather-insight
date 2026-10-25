// 磁気偏差（Variation）の等偏角線（2026-10-18）
//   ・WMM2025（magVar.js）で今日の日付の偏角を格子に計算し、マーチングスクエアで等偏角線を引く（航空図と同じ赤紫の破線）
//   ・間隔はカメラの高さで変える（遠い：5° → 2° → 近い：1°）。0°（無偏角線）は実線で太く
//   ・線の上に「8°W」「10°E」の目盛り。画面の下の真ん中に、画面の真ん中の偏差を出す
import * as Cesium from 'cesium';
import { declination, decimalYear, varText } from './magVar.js';

export function createVarLayer(viewer) {
  const ds = new Cesium.CustomDataSource('mag-variation');
  viewer.dataSources.add(ds);
  ds.show = false;
  // main.js の再読込（高度の倍率を変えたときなどの dataSources.removeAll）で消えたら付け直す（2026-10-25。消えたままで表示できなかった）
  // 2D・2.5D・3D を切り替えたら引き直す（2026-10-25）
  viewer.scene.morphComplete.addEventListener(() => {
    // 切り替え直後の視点（日本中心の世界全体など）が描かれてから引き直す
    const off = viewer.scene.postRender.addEventListener(() => { off(); lastKey = ''; if (on) rebuild(); });
    viewer.scene.requestRender();
  });
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => { if (!viewer.dataSources.contains(ds)) viewer.dataSources.add(ds); }, 0); });
  let on = false, lastKey = '', remove = null, removeTick = null;
  const COL = Cesium.Color.fromCssColorString('#e040fb');
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:34px;white-space:nowrap;z-index:20;padding:4px 8px;border-radius:6px;background:rgba(20,10,30,.78);border:1px solid #e040fb;color:#f3e5f5;font:12px "Meiryo",sans-serif;display:none;pointer-events:none';
  (viewer.container || document.body).appendChild(box);

  // 2D・2.5D では computeViewRectangle が地図のつながり（日付変更線の先）を正しく返さないため、画面の端の経緯度から決める（2026-10-25）
  function flatRect() {
    const D = Cesium.Math.toDegrees, cv = viewer.scene.canvas, W = cv.clientWidth, H = cv.clientHeight;
    const ll = (x, y) => { const p = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(x, y)); return p ? Cesium.Cartographic.fromCartesian(p) : null; };
    let c = ll(W / 2, H / 2);
    let span;
    if (viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
      // 2D はカメラの真下が画面の真ん中、カメラの高さ＝画面の横幅（m）。地図の切り替え直後でも正しい値になる
      const pc = viewer.camera.positionCartographic;
      c = pc; span = Math.max(pc.height, viewer.camera.frustum.right - viewer.camera.frustum.left) / (2 * Math.PI * 6378137) * 360;
    }
    if (!c) return { w: -180, e: 180, s: -80, n: 80 };
    if (span === undefined) { const a = ll(0, H / 2), b = ll(W, H / 2); span = a && b ? (((D(b.longitude) - D(a.longitude)) % 360 + 360) % 360 || 360) : 360; }
    span = Math.min(360, span * 1.1);
    const top = ll(W / 2, 0), bot = ll(W / 2, H);
    return { w: D(c.longitude) - span / 2, e: D(c.longitude) + span / 2, s: bot ? D(bot.latitude) - 5 : -85, n: top ? D(top.latitude) + 5 : 85 };
  }
  function viewRect() {
    if (viewer.scene.mode !== Cesium.SceneMode.SCENE3D) { const f = flatRect(); return { ...f, s: Math.max(-80, f.s), n: Math.min(84, f.n) }; }
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (!r) return { w: -180, e: 180, s: -80, n: 80 };
    let w = Cesium.Math.toDegrees(r.west), e = Cesium.Math.toDegrees(r.east);
    if (e < w) e += 360;
    return { w, e, s: Math.max(-80, Cesium.Math.toDegrees(r.south)), n: Math.min(84, Cesium.Math.toDegrees(r.north)) };
  }
  function centerLL() {
    const c = viewer.scene.canvas;
    const p = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2));
    if (!p) return null;
    const g = Cesium.Cartographic.fromCartesian(p);
    return { lon: Cesium.Math.toDegrees(g.longitude), lat: Cesium.Math.toDegrees(g.latitude) };
  }
  function showCenter() {
    const c = centerLL();
    box.textContent = c ? `画面中央の偏差（Variation）${varText(declination(c.lat, c.lon))}　WMM2025・${new Date().toISOString().slice(0, 10)}` : '偏差：地球を画面の真ん中に入れてください';
  }

  /** 格子 v（rows×cols）の等値線を、線分をつないだ折れ線の配列で返す */
  function contours(v, rows, cols, lat0, lon0, d, level) {
    const segs = [];
    const P = (i, j, i2, j2) => {   // 格子の辺の上の、level を通る点
      const a = v[i][j], b = v[i2][j2], t = (level - a) / (b - a);
      return [lon0 + (j + (j2 - j) * t) * d, lat0 + (i + (i2 - i) * t) * d];
    };
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = v[i][j], b = v[i][j + 1], c = v[i + 1][j + 1], e = v[i + 1][j];
      if (Math.max(a, b, c, e) - Math.min(a, b, c, e) > 90) continue;   // 磁極の近くの ±180° の切れ目
      const pts = [];
      if ((a < level) !== (b < level)) pts.push(P(i, j, i, j + 1));
      if ((b < level) !== (c < level)) pts.push(P(i, j + 1, i + 1, j + 1));
      if ((c < level) !== (e < level)) pts.push(P(i + 1, j + 1, i + 1, j));
      if ((e < level) !== (a < level)) pts.push(P(i + 1, j, i, j));
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]); }
    }
    // 端の点が同じ線分をつなぐ
    const key = p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const ends = new Map();
    segs.forEach((s, k) => { for (const p of s) { const q = key(p); (ends.get(q) || ends.set(q, []).get(q)).push(k); } });
    const used = new Uint8Array(segs.length), lines = [];
    for (let k = 0; k < segs.length; k++) {
      if (used[k]) continue;
      used[k] = 1;
      let line = [...segs[k]];
      for (const dir of [1, 0]) {
        for (;;) {
          const tip = dir ? line.at(-1) : line[0];
          const nx = (ends.get(key(tip)) || []).find(x => !used[x]);
          if (nx === undefined) break;
          used[nx] = 1;
          const s = segs[nx], p = key(s[0]) === key(tip) ? s[1] : s[0];
          dir ? line.push(p) : line.unshift(p);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function rebuild() {
    if (!on) return;
    showCenter();
    const hgt = viewer.camera.positionCartographic.height;
    const step = hgt > 8e6 ? 5 : hgt > 2.5e6 ? 2 : 1;
    const R = viewRect();
    const span = Math.max(R.e - R.w, R.n - R.s);
    const d = Math.max(0.25, Math.min(3, Math.round(span / 70 * 4) / 4 || 0.25));
    const w = Math.floor((R.w - 2 * d) / d) * d, e = Math.ceil((R.e + 2 * d) / d) * d;
    const s = Math.max(-80, Math.floor((R.s - 2 * d) / d) * d), n = Math.min(86, Math.ceil((R.n + 2 * d) / d) * d);
    const key = [step, d, w, e, s, n].join(',');
    if (key === lastKey) return;
    lastKey = key;
    const yr = decimalYear();
    const rows = Math.round((n - s) / d) + 1, cols = Math.round((e - w) / d) + 1;
    if (rows * cols > 60000) return;
    const v = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < rows; i++) {
      const row = new Float64Array(cols);
      for (let j = 0; j < cols; j++) { const x = declination(s + i * d, w + j * d, yr); row[j] = x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
      v.push(row);
    }
    ds.entities.suspendEvents();
    ds.entities.removeAll();
    const lab = { font: 'bold 12px "Meiryo", sans-serif', fillColor: COL.brighten(0.4, new Cesium.Color()), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY };
    for (let lv = Math.ceil(Math.max(lo, -60) / step) * step; lv <= Math.min(hi, 60); lv += step) {
      for (const line of contours(v, rows, cols, s, w, d, lv)) {
        const pts = line.filter((p, k) => k === 0 || Math.abs(p[0] - line[k - 1][0]) + Math.abs(p[1] - line[k - 1][1]) < d * 3);
        if (pts.length < 3) continue;
        const zero = lv === 0;
        ds.entities.add({ polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), clampToGround: false, width: zero ? 2.4 : 1.6,
          material: zero ? COL.withAlpha(0.95) : new Cesium.PolylineDashMaterialProperty({ color: COL.withAlpha(0.9), dashLength: 14 }),
        } });
        // 目盛り：線の長さに応じて 1〜3 か所
        const nLab = pts.length > 120 ? 3 : pts.length > 40 ? 2 : 1;
        for (let k = 1; k <= nLab; k++) {
          const p = pts[Math.floor(pts.length * k / (nLab + 1))];
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(p[0], p[1]), label: { ...lab, text: lv === 0 ? '0°' : `${Math.abs(lv)}°${lv > 0 ? 'E' : 'W'}` } });
        }
      }
    }
    // 線は地面に貼り付けず（clampToGround は作るのが遅く、2D の地図では日付変更線の東側に出なかった）、高さ 0 に引く。
    //   山などの地形に隠れる所も見えるように、隠れた部分も同じ色で描く（2026-10-25）
    for (const e of ds.entities.values) if (e.polyline) e.polyline.depthFailMaterial = e.polyline.material;
    ds.entities.resumeEvents();
    viewer.scene.requestRender();
  }

  return {
    get on() { return on; },
    setVisible(x) {
      on = !!x; ds.show = on; box.style.display = on ? 'block' : 'none';
      if (on) {
        lastKey = ''; rebuild();
        remove ||= viewer.camera.moveEnd.addEventListener(rebuild);
        removeTick ||= viewer.camera.changed.addEventListener(showCenter);
      } else {
        if (remove) { remove(); remove = null; }
        if (removeTick) { removeTick(); removeTick = null; }
      }
      viewer.scene.requestRender();
    },
  };
}
