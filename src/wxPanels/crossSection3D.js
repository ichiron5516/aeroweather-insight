// 断面図（AXJP130/140 高層断面図、FXJP106/112 国内航空路予想断面図）を、地図の上に「縦の壁」として立てる
//   図の横軸（緯度 または 経路上の地点）を地図上の線に、縦軸（気圧）を高さに合わせて貼り付ける。
//   高さは画面の高度倍率（誇張表示は100倍＝元の図と同じ縦横比）に合わせる。実寸（1倍）のときも壁は100倍で立てる（平たくて読めないため）。図の黒い線を白く、白地を半透明の紺にして見やすくする。
//
//   図の中の位置（画素）は 2026-10 の実際の図で測ったもの：
//     FXJP106 … 2048×2545 の PNG。上段が 6時間予想（FXJP106）、下段が 12時間予想（FXJP112）。
//               縦軸は気圧（対数）で、左端の km 目盛から画素⇔高さの表を作った。横軸は地点（石垣〜札幌）。
//     AXJP140 … PDF 1ページ（150dpi で 1512×2059）。上段が東経140度、下段が東経130度の解析。
//               縦軸は ln(気圧) に比例（100hPa が y=170、1hPa の比 e 倍で 324.5 画素）、横軸は緯度（1度 47.27 画素、50°N が x=179）。
import * as Cesium from 'cesium';

const FT = 0.3048;
export const stdAlt = p => 44330.8 * (1 - (p / 1013.25) ** 0.190263);            // 標準大気の高度（m）
export const stdP = h => 1013.25 * (1 - h / 44330.8) ** (1 / 0.190263);         // 高度（m）→ 気圧

// ---------------- 図ごとの寸法 ----------------
// FXJP：上段の km 目盛（y 画素, km）。下段は y に +1203
const FX_KM = [[1150, 1], [1098, 2], [1045, 3], [990, 4], [934, 5], [877, 6], [818, 7], [758, 8], [696, 9], [632, 10],
  [566, 11], [500, 12], [433, 13], [366, 14], [300, 15], [233, 16], [221, 16.18]];
const FX_ST = [            // 地点名、緯度、経度、図の x 画素
  ['石垣', 24.34, 124.19, 322], ['那覇', 26.21, 127.65, 521], ['鹿児島', 31.80, 130.72, 828], ['福岡', 33.59, 130.45, 930],
  ['大阪', 34.69, 135.50, 1146], ['東京', 35.55, 139.78, 1321], ['仙台', 38.14, 140.92, 1457], ['札幌', 43.06, 141.35, 1679]];
const AX_ST = {             // 地点（緯度・経度）。図の横軸は緯度なので、経度は地点の間で補う
  140: [['ユジノサハリンスク', 46.92, 142.73], ['稚内', 45.42, 141.68], ['札幌', 43.06, 141.33], ['秋田', 39.72, 140.10],
    ['館野', 36.06, 140.13], ['八丈島', 33.12, 139.78], ['父島', 27.09, 142.18]],
  130: [['伊春', 47.73, 128.90], ['延吉', 42.87, 129.50], ['咸興', 39.93, 127.55], ['烏山', 37.10, 127.03], ['浦項', 36.03, 129.38],
    ['福岡', 33.58, 130.38], ['鹿児島', 31.55, 130.55], ['名瀬', 28.38, 129.50], ['南大東島', 25.83, 131.23]],
};
const AX_DPI = 150 / 72;
// 元の図の縦横比：FXJP は 経路約2,400km × 高さ16km を 1357×930 画素、AXJP は 約2,800km × 16km を 1205×747 画素に描いている
//   → 高さを約100倍にすると、壁が元の図と同じ形になる（25倍では横に4倍引き延ばされて読みにくい）
export const CHART_EXAG = 100;                 // 測った画像の倍率（PDF の 1pt あたりの画素）

export const SECTION_INFO = {
  fxjp: { panels: { 6: '6時間予想（FXJP106）', 12: '12時間予想（FXJP112）' } },
  axjp: { panels: { 140: '東経140度（AXJP140）', 130: '東経130度（AXJP130）' } },
};

/** 図の y 画素 ⇔ 高度（m）の変換と、横方向の地点（x 画素 → 緯度経度） */
export function layoutOf(kind, panel, s) {
  if (kind === 'fxjp') {
    const dy = panel === 12 ? 1203 : 0;
    const tab = FX_KM.map(([y, km]) => [(y + dy) * s, km * 1000]);
    const yOf = h => {                                    // 高度 → y（表の間は直線で補う）
      for (let i = 0; i < tab.length - 1; i++) {
        const [ya, ha] = tab[i], [yb, hb] = tab[i + 1];
        if (h >= ha && h <= hb) return ya + (yb - ya) * (h - ha) / (hb - ha);
      }
      return h < tab[0][1] ? tab[0][0] : tab.at(-1)[0];
    };
    return { hBot: 1000, hTop: 16180, yOf, anchors: FX_ST.map(([name, lat, lon, x]) => ({ name, lat, lon, x: x * s })) };
  }
  // AXJP：横軸は緯度（50°N〜24.5°N）
  const k = s / AX_DPI, dy = panel === 130 ? 994 : 0;
  const yOf = h => (170 + dy + 324.5 * Math.log(stdP(h) / 100)) * k;
  const st = AX_ST[panel];
  const lonAt = lat => {                                  // 緯度での経度（地点の間を直線で補う。端は一番端の地点の経度）
    if (lat >= st[0][1]) return st[0][2];
    for (let i = 0; i < st.length - 1; i++) if (lat <= st[i][1] && lat >= st[i + 1][1])
      return st[i][2] + (st[i + 1][2] - st[i][2]) * (st[i][1] - lat) / (st[i][1] - st[i + 1][1]);
    return st.at(-1)[2];
  };
  const xOf = lat => (179 + (50 - lat) * 47.27) * k;
  const lats = [50, ...st.map(x => x[1]), 24.5];
  const anchors = lats.map((lat, i) => ({ name: i && i < lats.length - 1 ? st[i - 1][0] : '', lat, lon: lonAt(lat), x: xOf(lat) }));
  return { hBot: stdAlt(1000), hTop: stdAlt(100), yOf, anchors };
}

/** 図（canvas / img）から、壁に貼る絵を作る（横は地点の範囲、縦は高さに比例するように並べ直す） */
function wallTexture(src, L, overlay = null, OH = 1400) {
  const x0 = L.anchors[0].x, x1 = L.anchors.at(-1).x;
  const OW = Math.min(4096, Math.round(x1 - x0));
  const cv = document.createElement('canvas'); cv.width = OW; cv.height = OH;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  for (let r = 0; r < OH; r++) {
    const h = L.hTop - (L.hTop - L.hBot) * (r + 0.5) / OH;
    ctx.drawImage(src, x0, L.yOf(h), x1 - x0, 1, 0, r, OW, 1);
  }
  // 細い線が遠くからでも消えないように、線を1画素ずつ太らせる（暗い方を残して重ね描き）
  const cp = document.createElement('canvas'); cp.width = OW; cp.height = OH; cp.getContext('2d').drawImage(cv, 0, 0);
  ctx.globalCompositeOperation = 'darken';
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) ctx.drawImage(cp, dx, dy);
  ctx.globalCompositeOperation = 'source-over';
  // 色付け（ジェット気流・圏界面・前線帯など）を同じ並べ方で読む
  let od = null;
  if (overlay) {
    const oc = document.createElement('canvas'); oc.width = OW; oc.height = OH;
    const ox = oc.getContext('2d');
    for (let r = 0; r < OH; r++) {
      const h = L.hTop - (L.hTop - L.hBot) * (r + 0.5) / OH;
      ox.drawImage(overlay, x0, L.yOf(h), x1 - x0, 1, 0, r, OW, 1);
    }
    od = ox.getImageData(0, 0, OW, OH).data;
  }
  // 黒い線 → 白、白地 → 濃い紺（ほぼ不透明。後ろの地図や雲が透けると線が読めないため）。色付けの所は地の色をその色にする
  const img = ctx.getImageData(0, 0, OW, OH), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.min(1, Math.max(0, (235 - (d[i] + d[i + 1] + d[i + 2]) / 3) / 120));
    let br = 14, bg = 28, bb = 48;
    if (od && od[i + 3]) { const f = od[i + 3] / 255 * 0.75; br += (od[i] - br) * f; bg += (od[i + 1] - bg) * f; bb += (od[i + 2] - bb) * f; }
    d[i] = br + (255 - br) * a; d[i + 1] = bg + (255 - bg) * a; d[i + 2] = bb + (255 - bb) * a; d[i + 3] = Math.round(255 * (0.82 + 0.18 * a));
  }
  ctx.putImageData(img, 0, 0);
  // 1,000ft ごとではなく 10,000ft ごとに薄い目盛線（壁の高さを読みやすく）
  ctx.strokeStyle = 'rgba(255,214,79,0.6)'; ctx.lineWidth = 2;
  for (let ft = 10000; ft <= 50000; ft += 10000) {
    const y = OH * (L.hTop - ft * FT) / (L.hTop - L.hBot);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(OW, y); ctx.stroke();
  }
  return cv;
}

/** 壁の形（地点の間を細かく分けて、下端と上端の2段の帯） */
function wallPrimitive(tex, L, scale) {
  const x0 = L.anchors[0].x, x1 = L.anchors.at(-1).x;
  const cols = [];
  for (let i = 0; i < L.anchors.length - 1; i++) {
    const a = L.anchors[i], b = L.anchors[i + 1], n = Math.max(2, Math.ceil(Math.hypot(b.lat - a.lat, b.lon - a.lon) / 0.25));
    for (let k = 0; k < n; k++) { const f = k / n; cols.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, x: a.x + (b.x - a.x) * f }); }
  }
  cols.push(L.anchors.at(-1));
  const pos = new Float64Array(cols.length * 6), st = new Float32Array(cols.length * 4), idx = [];
  cols.forEach((c, k) => {
    const lo = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, L.hBot * scale), hi = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, L.hTop * scale);
    pos.set([lo.x, lo.y, lo.z, hi.x, hi.y, hi.z], k * 6);
    const u = (c.x - x0) / (x1 - x0);
    st.set([u, 0, u, 1], k * 4);
    if (k) { const a = (k - 1) * 2, b = k * 2; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  });
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: new Uint16Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  const material = new Cesium.Material({
    fabric: { uniforms: { image: tex.toDataURL('image/png') },
      source: `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb * 0.2; m.emission = c.rgb; m.alpha = c.a;
        return m; }` },
  });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({ material, flat: true, translucent: true, faceForward: true, closed: false }),
    asynchronous: false,
  });
}

/**
 * 表示の管理
 *   getSource(kind) … 図の canvas / img と描画倍率 s（測った寸法に対する倍率）を返す async 関数
 */
export function createCrossSection3D(viewer, { getSource, onStatus }) {
  const group = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const cur = { kind: null, panels: [], title: '' };
  let srcCache = null;
  const scale = () => { const g = window.awGetAltScale?.() ?? 1; return g > 1 ? g : CHART_EXAG; };
  function draw() {
    group.removeAll();
    if (!cur.kind || !srcCache) return;
    const sc = scale(), labels = new Cesium.LabelCollection();
    for (const panel of cur.panels) {
      const L = layoutOf(cur.kind, panel, srcCache.s);
      group.add(wallPrimitive(wallTexture(srcCache.src, L, srcCache.overlay), L, sc));
      for (const a of L.anchors) {
        if (!a.name) continue;
        labels.add({ position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, L.hTop * sc + 8000 * Math.min(sc, 5)), text: a.name,
          font: '600 12px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE, showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(20,40,70,0.85)'), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY });
      }
      // 壁の端に高度の目盛（10,000ft ごと）
      const e = L.anchors[0];
      for (let ft = 10000; ft <= 50000; ft += 10000) labels.add({ position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, ft * FT * sc),
        text: `FL${ft / 100}`, font: '11px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffd54f'),
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.75)'),
        horizontalOrigin: Cesium.HorizontalOrigin.RIGHT, pixelOffset: new Cesium.Cartesian2(-6, 0), disableDepthTestDistance: Number.POSITIVE_INFINITY });
      const t = L.anchors[Math.floor(L.anchors.length / 2)];
      labels.add({ position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, L.hTop * sc + 30000 * Math.min(sc, 5)), text: SECTION_INFO[cur.kind].panels[panel],
        font: '700 13px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#1d2a3a'), showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('rgba(255,213,79,0.92)'), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    group.add(labels);
  }
  const statusText = () => `${cur.panels.map(p => SECTION_INFO[cur.kind].panels[p]).join('・')} を、図の線を白くした「壁」として表示しています。` +
    `壁の高さは ${scale()}倍（${scale() === CHART_EXAG ? '元の図と同じ縦横比' : '経路・雲と同じ倍率'}）。黄色い横線は FL100 ごと。高さは標準大気で気圧から換算。`;
  window.addEventListener('aw:altscale', () => { if (cur.kind) { draw(); onStatus?.(statusText()); } });
  return {
    get kind() { return cur.kind; },
    async show(kind, panels) {
      onStatus?.('断面図を地図の上に立てています…');
      srcCache = await getSource(kind);
      cur.kind = kind; cur.panels = panels; draw();
      onStatus?.(statusText());
    },
    hide() { cur.kind = null; group.removeAll(); onStatus?.(''); },
    /**
     * 真横から見るための視点。northRight = true なら北（または北側の端）が画面の右に来る向き。
     * 返り値 { sphere, heading, readable, widthM, heightM }。readable は図の文字が正しく読める面（表）から見ているか
     */
    sideView(panel, northRight = true) {
      if (!cur.kind || !srcCache) return null;
      const L = layoutOf(cur.kind, panel, srcCache.s), sc = scale();
      const pts = L.anchors.flatMap(a => [Cesium.Cartesian3.fromDegrees(a.lon, a.lat, L.hBot * sc), Cesium.Cartesian3.fromDegrees(a.lon, a.lat, L.hTop * sc)]);
      const sphere = Cesium.BoundingSphere.fromPoints(pts);
      const a = L.anchors[0], b = L.anchors.at(-1), r = Math.PI / 180;
      const brg = Math.atan2(Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r),
        Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r)) / r;
      // 壁の向き（a→b）に直角に見る。画面の右方向は「視線の向き＋90°」
      const toNorth = b.lat >= a.lat ? brg : brg + 180;       // 南の端 → 北の端の方位
      const diff = (x, y) => Math.abs(((x - y) % 360 + 540) % 360 - 180);
      let heading = brg - 90;                                 // この向きなら画面の右が a→b（図の表＝文字が読める）
      const rightIsNorth = diff(heading + 90, toNorth) < 90;
      if (rightIsNorth !== northRight) heading += 180;
      const readable = diff(heading, brg - 90) < 1;
      const widthM = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(a.lon, a.lat), Cesium.Cartesian3.fromDegrees(b.lon, b.lat));
      return { sphere, heading: ((heading % 360) + 360) % 360, readable, widthM, heightM: (L.hTop - L.hBot) * sc };
    },
  };
}

/** 断面の線（自動解析で使う地点の並び） */
export function sectionLine(kind, panel) {
  if (kind === 'fxjp') return FX_ST.map(([name, lat, lon]) => ({ name, lat, lon }));
  return AX_ST[panel].map(([name, lat, lon]) => ({ name, lat, lon }));
}
