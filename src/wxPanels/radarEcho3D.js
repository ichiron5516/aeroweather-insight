// レーダーエコーの 3D 表示
//   降水強度（気象庁ナウキャスト）を約8km四方の柱にし、色は降水強度、高さは推定したエコー頂。
//   エコー頂は気象庁のデータ（有料配信）が使えないため、ひまわり赤外の雲頂高度から推定する：
//     エコー頂 ≈ 雲頂 − 3000ft（降水粒子は雲頂より少し下まで。最低 5000ft）
//     赤外で雲頂が取れないときは、降水の強さから仮の高さ（弱い雨 8000ft 〜 猛烈な雨 FL400）
import * as Cesium from 'cesium';
import { topAltFt, cellLatLon } from '../advisor/cbCore.js';
import { profileField, BOX, animeSky } from './cloudTop3D.js';
import { sprites, bbSize } from './animeSprites.js';

// アニメ風のときの色（気象庁の配色をやわらかくしたもの）
const ANIME = [[80, '#d86bd8'], [50, '#ff6b6b'], [30, '#ffb347'], [20, '#ffe066'], [10, '#4a86ff'], [5, '#6fb4ff'], [1, '#a8d8ff'], [0.4, '#e8f4ff']];
export const ECHO_LEGEND_ANIME = ANIME.slice().reverse().map(([mm, css]) => ({ mm, css }));
const animeOf = mm => (ANIME.find(([v]) => mm >= v) || ANIME.at(-1))[1];

/** アニメ風：雨の幕の絵を、エコー頂の高さで縦に立てる（いつも鉛直を向く） */
export function echoAnime(cols, altScale = 1, camPos = null) {
  const SP = sprites().rain;
  const bb = new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
  const q = cols.map((c, k) => {
    const lon = (c.rect[0] + c.rect[2]) / 2, lat = (c.rect[1] + c.rect[3]) / 2;
    const hM = c.echoFt * 0.3048 * altScale, w = (c.rect[2] - c.rect[0]) * 111000 * Math.cos(lat * Math.PI / 180) * 1.7;
    return { c, k, hM, w, pos: Cesium.Cartesian3.fromDegrees(lon, lat, hM / 2) };
  });
  if (camPos) q.sort((a, b) => Cesium.Cartesian3.distanceSquared(b.pos, camPos) - Cesium.Cartesian3.distanceSquared(a.pos, camPos));
  for (const { c, k, hM, w, pos } of q) {
    const s = SP[k % SP.length];
    const b = bb.add({ position: pos, ...bbSize(w, hM), sizeInMeters: true,
      alignedAxis: Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cesium.Cartesian3()),
      color: Cesium.Color.fromCssColorString(animeOf(c.mm)).withAlpha(c.mm >= 20 ? 0.95 : c.mm >= 5 ? 0.7 : 0.45) });
    b.setImage(s.id, s.cv);
  }
  return bb;
}

// 気象庁の降水強度の配色（mm/h の下限 → 色）
const RAIN = [[80, '#b40068'], [50, '#ff2800'], [30, '#ff9900'], [20, '#faf500'], [10, '#0041ff'], [5, '#218cff'], [1, '#a0d2ff'], [0.4, '#f2f2ff']];
export const ECHO_LEGEND = RAIN.slice().reverse().map(([mm, css]) => ({ mm, css }));
const colorOf = mm => (RAIN.find(([v]) => mm >= v) || RAIN.at(-1))[1];
const fallbackFt = mm => (mm >= 50 ? 40000 : mm >= 20 ? 30000 : mm >= 10 ? 22000 : mm >= 5 ? 15000 : 8000);

/** 解析結果（radarMotion の grid：降水の最大値 mx と雲頂温度 tb のマス）から柱のリストを作る */
export async function buildEchoColumns(grid) {
  const profAt = await profileField(BOX);
  const cols = [];
  const { W, H, B, z, x0, y0 } = grid;
  const px2lon = x => x / (256 * 2 ** z) * 360 - 180;
  const px2lat = y => { const n = Math.PI - 2 * Math.PI * y / (256 * 2 ** z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
  for (let k = 0; k < W * H; k++) {
    const mm = grid.mx[k]; if (mm < 0.4) continue;
    const { lat, lon } = cellLatLon(grid, k);
    const tb = grid.tb[k];
    const top = isFinite(tb) ? topAltFt(profAt(lat, lon), tb) : null;
    const echoFt = top ? Math.max(5000, top - 3000) : fallbackFt(mm);
    const x = k % W, y = (k / W) | 0;
    cols.push({ mm, echoFt, fromIr: !!top,
      rect: [px2lon(x0 + x * B), px2lat(y0 + (y + 1) * B), px2lon(x0 + (x + 1) * B), px2lat(y0 + y * B)] });
  }
  return cols;
}

export function echoPrimitive(cols, altScale = 1) {
  const inst = cols.map(c => new Cesium.GeometryInstance({
    geometry: new Cesium.RectangleGeometry({
      rectangle: Cesium.Rectangle.fromDegrees(...c.rect), height: 0, extrudedHeight: c.echoFt * 0.3048 * altScale,
      vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT, granularity: Cesium.Math.toRadians(1) }),
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.fromCssColorString(colorOf(c.mm)).withAlpha(c.mm >= 20 ? 0.8 : c.mm >= 5 ? 0.55 : 0.35)) },
  }));
  return new Cesium.Primitive({ geometryInstances: inst, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), asynchronous: true });
}

/** 表示の管理 */
export function createRadarEcho3D(viewer, { getResult, onStatus }) {
  let prim = null, cols = null, on = false, forTime = null, style = 'anime';
  const scale = () => (window.awGetAltScale?.() ?? 1);
  const draw = () => {
    if (prim) { viewer.scene.primitives.remove(prim); prim = null; }
    animeSky(viewer, on && style === 'anime', 'echo');
    if (on && cols?.length) prim = viewer.scene.primitives.add(style === 'anime' ? echoAnime(cols, scale(), viewer.camera.positionWC) : echoPrimitive(cols, scale()));
  };
  async function update() {
    const res = await getResult();
    if (!res?.grid) { onStatus?.('雲頂の解析ができていないため、3D にできません。'); return; }
    if (forTime !== res.time) {
      onStatus?.('エコーの柱を作っています…');
      cols = await buildEchoColumns(res.grid); forTime = res.time;
    }
    draw();
    const ir = cols.filter(c => c.fromIr).length, hi = cols.filter(c => c.echoFt >= 30000);
    const t = res.time;
    onStatus?.(cols.length ? `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}Z のエコー ${cols.length}マス（約8km四方）。` +
      `推定エコー頂が FL300 以上：${hi.length}マス。高さは雲頂（ひまわり赤外）から推定${ir < cols.length ? `（${cols.length - ir}マスは降水の強さから仮の高さ）` : ''}。`
      : '日本付近に降水エコーはありません。');
  }
  window.addEventListener('aw:altscale', () => { if (on) draw(); });
  viewer.camera.moveEnd.addEventListener(() => { if (on && style === 'anime') draw(); });
  return {
    get on() { return on; },
    setStyle(v) { style = v; if (on) draw(); },
    async show() { on = true; await update(); },
    hide() { on = false; draw(); onStatus?.(''); },
    async refresh() { if (on) await update(); },
  };
}
