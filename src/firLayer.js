// FIR（飛行情報区）の境界線
//   データ：public/data/fir/fir_asia.geojson
//     VATSpy Data Project（VATSIM のシミュレーター管制用、CC BY-SA 4.0）の境界を、FIR ごとにまとめ直したもの。
//     ・福岡FIR は、VATSIM で分けられている東京・神戸・福岡の管制区と洋上部分を合わせて作った
//     ・中国は国内の FIR 区分（北京・上海・広州など）を省略し、外側の境界だけを描く
//     ・2026-10-18：気象衛星の画像の範囲（インド・中央アジア・ロシア東部・アラスカ・ハワイ・オセアニア）まで広げた。
//       オーストラリアは国内の区分（メルボルン・ブリスベン）を省略して外側だけ。日付変更線をまたぐ FIR は経度を 180 度より
//       大きい値でつないで 1 つの形にしてある（日付変更線の上に余計な線が出ないように）
//     公式の FIR 境界（各国の AIP）とは細部が異なるため、教育用の目安として表示する
//   線と文字は primitive で描く（事例の切り替えや高度の倍率変更で viewer.entities / dataSources が消されても残るように）
import * as Cesium from 'cesium';

const URL = `${(import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')}data/fir/fir_asia.geojson`;
const STYLE = {
  jp: { color: '#4fc3f7', width: 3, font: 'bold 14px "Meiryo", sans-serif', alpha: 0.95 },     // 福岡FIR
  other: { color: '#ffcc80', width: 1.6, font: '12px "Meiryo", sans-serif', alpha: 0.8 },
};

/** 直線（経緯度で直線）を細かく分ける。緯線に沿った境界（例：北緯21度）が地図上でも緯線に沿うように */
function densify(ring, stepDeg = 0.5) {
  const out = [];
  for (let k = 0; k < ring.length - 1; k++) {
    const [x0, y0] = ring[k], [x1, y1] = ring[k + 1];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / stepDeg));
    for (let i = 0; i < n; i++) out.push(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
  }
  out.push(...ring.at(-1));
  return out;
}

export function createFirLayer(viewer) {
  const prims = [];
  let on = false, loaded = null;

  async function load() {
    const r = await fetch(URL);
    if (!r.ok) throw new Error(`FIR の境界データを読めません（${r.status}）`);
    const gj = await r.json();
    const groups = { jp: [], other: [] };
    const labels = new Cesium.LabelCollection({ scene: viewer.scene });
    for (const f of gj.features) {
      const p = f.properties, key = p.kind === 'jp' ? 'jp' : 'other', st = STYLE[key];
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) {      // 内側の輪（飛び地など）も境界として描く
        groups[key].push(new Cesium.GeometryInstance({ geometry: new Cesium.GroundPolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray(densify(ring)), width: st.width }) }));
      }
      const [lx, ly] = p.label;
      labels.add({
        position: Cesium.Cartesian3.fromDegrees(lx, ly, 3000),
        text: p.icao ? `${p.en} ${p.sfx || 'FIR'}（${p.icao}）\n${p.ja}` : p.ja,
        font: st.font, fillColor: Cesium.Color.fromCssColorString(st.color), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(5e6, 1, 2.5e7, 0.15),   // 遠くから見たときは薄くする（文字が重なるため）
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1, 8e6, 0.75),
      });
    }
    for (const [key, inst] of Object.entries(groups)) {
      if (!inst.length) continue;
      const st = STYLE[key];
      prims.push(viewer.scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
        geometryInstances: inst,
        appearance: new Cesium.PolylineMaterialAppearance({ material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(st.color).withAlpha(st.alpha) }) }),
      })));
    }
    prims.push(viewer.scene.primitives.add(labels));
    prims.forEach(x => { x.show = on; });
  }

  return {
    get on() { return on; },
    async setVisible(v) {
      on = v;
      if (v && !loaded) loaded = load().catch(e => { loaded = null; throw e; });
      if (v) await loaded;
      prims.forEach(x => { x.show = on; });
    },
  };
}
