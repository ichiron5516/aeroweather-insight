// 国内悪天予想図（FBJP）の 3D 表示
//   ・ジェット気流 … 読み取った FL の高さに、赤い太い管と矢印（流れの向き＝西→東）。下に薄い幕を垂らして高さを見やすく
//   ・CAT 域      … 帯の北側の縁を上限（例 FL310）、南側の縁を下限（例 FL230）にして、北から南へ斜めに下がる板（ジェット気流の下の前線帯の形）
//   ・雲域        … 揺れが予想される高度（札の乱気流の下限〜上限）を、同じ太さのもくもくした雲の柱（立体）で。
//                   積乱雲の雲頂がそれより高ければ、上に横へ広がるかなとこ雲
//   高さは画面の高度倍率（1倍／100倍）に合わせる
//   ジェット気流の FL の札が読めないとき（札が線に重なって斜めに書かれ、矢羽根や CAT 域の線と重なる場合など）は、
//   数値予報（気象庁 GSM・Open-Meteo 経由）で、その線の上の風が一番強い高さを FL にする（「推定」と表示。2026-10-17）
import * as Cesium from 'cesium';
import { parseFbjp } from './fbjpParse.js';
import { sprites, bbSize } from './animeSprites.js';
import { puffColumn } from './puffColumn.js';
import { animeSky } from './cloudTop3D.js';

const FT = 0.3048;
const inPoly = (lat, lon, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
};
const fl3 = v => String(v).padStart(3, '0');

function build(res, scale, camPos) {
  const pc = new Cesium.PrimitiveCollection();
  const ds = new Cesium.CustomDataSource('fbjp3d');
  const SP = sprites();

  // ---- ジェット気流 ----
  for (const j of res.jets) {
    if (!j.fl) continue;
    // 西から東へ（矢印の向き）
    let idx = j.pts.map((p, i) => i);
    if (j.pts[0].lon > j.pts.at(-1).lon) idx = idx.reverse();
    const pos = [], hts = [];
    for (const i of idx) { const h = (j.fls[i] || j.fl) * 100 * FT * scale; pos.push(Cesium.Cartesian3.fromDegrees(j.pts[i].lon, j.pts[i].lat, h)); hts.push(h); }
    // 太い管（横幅約80km・厚さ約6,000ft。高度の倍率に合わせて厚くする）と、その上に向きを示す矢印
    const tubeW = 80000, tubeH = Math.max(6000 * FT * scale, 3000);
    const shape = []; for (let a = 0; a < 360; a += 20) shape.push(new Cesium.Cartesian2(tubeW / 2 * Math.cos(a * Math.PI / 180), tubeH / 2 * Math.sin(a * Math.PI / 180)));
    ds.entities.add({ polylineVolume: { positions: pos, shape, cornerType: Cesium.CornerType.ROUNDED,
      material: Cesium.Color.fromCssColorString('#e53935').withAlpha(0.55), outline: false } });
    ds.entities.add({ polyline: { positions: pos.map(p => { const c = Cesium.Cartographic.fromCartesian(p); return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + tubeH / 2 + 500); }),
      width: 28, arcType: Cesium.ArcType.NONE, material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.fromCssColorString('#b71c1c').withAlpha(0.95)) } });
    ds.entities.add({ wall: { positions: idx.map(i => Cesium.Cartesian3.fromDegrees(j.pts[i].lon, j.pts[i].lat)), maximumHeights: hts, minimumHeights: hts.map(() => 0),
      material: Cesium.Color.fromCssColorString('#e53935').withAlpha(0.1), outline: false } });
    for (const l of j.labels.length ? j.labels : [{ v: j.fl, lat: j.pts[idx[idx.length >> 1]].lat, lon: j.pts[idx[idx.length >> 1]].lon }]) {
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(l.lon, l.lat, l.v * 100 * FT * scale + 12000 * Math.min(scale, 5)),
        label: { text: `ジェット気流 FL${fl3(l.v)}${j.est === 'guess' ? '（FL不明・仮の高さ）' : j.est ? '（推定）' : ''}`, font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffd6d6'),
          showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(110,15,15,0.88)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
  }

  // ---- CAT 域：北側の縁＝上限、南側の縁＝下限。北から南へ斜めに下がる板 ----
  //   CAT 域は細長い帯（ジェット気流に沿って南西〜北東など）なので、緯度ではなく「帯を横切る向き」で高さを決める。
  //   帯の長い向き（主軸）に直角な向きのうち北寄りの方を「北側」とし、北側の縁で上限、南側の縁で下限になるようにする
  for (const c of res.cats) {
    if (!c.top || !c.base) continue;
    const la0 = c.poly.reduce((a, p) => a + p.lat, 0) / c.poly.length, lo0 = c.poly.reduce((a, p) => a + p.lon, 0) / c.poly.length;
    const kx = Math.cos(la0 * Math.PI / 180);
    const xy = c.poly.map(p => [(p.lon - lo0) * kx, p.lat - la0]);            // おおよその平面座標（度）
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of xy) { sxx += x * x; syy += y * y; sxy += x * y; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);                         // 帯の長い向き
    let nx = -Math.sin(ang), ny = Math.cos(ang); if (ny < 0) { nx = -nx; ny = -ny; }   // 帯を横切る向き（北寄り）
    const nOf = xy.map(([x, y]) => x * nx + y * ny), nMin = Math.min(...nOf), nMax = Math.max(...nOf);
    const span = (c.top - c.base) * 100, half = 1000;                          // 板の厚さ ±1,000ft
    const hOf = i => c.base * 100 + span * ((nOf[i] - nMin) / Math.max(1e-6, nMax - nMin));   // 南側の縁＝下限 → 北側の縁＝上限
    const hi = c.poly.map((_, i) => Math.min(c.top * 100, hOf(i) + half) * FT * scale);
    const lw = c.poly.map((_, i) => Math.max(c.base * 100, hOf(i) - half) * FT * scale);
    const idx = new Map(c.poly.map((p, i) => [p, i]));
    const up = p => hi[idx.get(p)], lo = p => lw[idx.get(p)];
    const ring = [...c.poly, c.poly[0]];
    const col = Cesium.Color.fromCssColorString('#ff4fa8');            // ピンク
    ds.entities.add({ polygon: { hierarchy: c.poly.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, up(p))), perPositionHeight: true, material: col.withAlpha(0.45) } });
    ds.entities.add({ polygon: { hierarchy: c.poly.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, lo(p))), perPositionHeight: true, material: col.withAlpha(0.3) } });
    ds.entities.add({ wall: { positions: ring.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat)), maximumHeights: ring.map(up), minimumHeights: ring.map(lo), material: col.withAlpha(0.35) } });
    // 上面の縁を線で（斜めの板の形が分かるように）
    ds.entities.add({ polyline: { positions: ring.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, up(p))), width: 2, arcType: Cesium.ArcType.NONE, material: col.withAlpha(0.95) } });
    const np = c.poly.reduce((a, b) => (b.lat > a.lat ? b : a));
    ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(np.lon, np.lat, c.top * 100 * FT * scale + 10000 * Math.min(scale, 5)),
      label: { text: `CAT FL${fl3(c.base)}〜${fl3(c.top)}`, font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.fromCssColorString('#ffe3f1'),
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(150,40,95,0.88)'), disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }

  // ---- 雲域：積乱雲と、揺れのある雲の層 ----
  const bb = pc.add(new Cesium.BillboardCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
  const queue = [];
  // 前線で 2 つに分かれた雲域など、同じ札の雲が複数あるときは、札（高さの説明）は一番大きい雲にだけ出す（2026-10-19）
  const labelOf = new Map();
  for (const c of res.clouds) if (c.box != null && (!labelOf.has(c.box) || (c.area || 0) > (labelOf.get(c.box).area || 0))) labelOf.set(c.box, c);
  for (const c of res.clouds) {
    const top = (c.top || (c.cb ? 400 : 150)) * 100, base = (c.base || 20) * 100;
    const lats = c.poly.map(p => p.lat), lons = c.poly.map(p => p.lon);
    const s0 = Math.min(...lats), n0 = Math.max(...lats), w0 = Math.min(...lons), e0 = Math.max(...lons);
    const step = c.cb ? 0.9 : 0.6;
    // 雲の大きさは図の雲域（もこもこの線で囲まれた範囲）に合わせる。高さの倍率で横に広げると、雲域の外まで雲がはみ出すため
    const Dm = Math.max(30000, Math.min((n0 - s0) * 111000, (e0 - w0) * 111000 * Math.cos((s0 + n0) / 2 * Math.PI / 180)));
    const cells = [];
    for (let la = s0 + step / 2; la < n0; la += step) for (let lo = w0 + step / 2; lo < e0; lo += step) if (inPoly(la, lo, c.poly)) cells.push([la, lo]);
    if (!cells.length) cells.push([c.center.lat, c.center.lon]);          // 小さな雲域は中心に1つ
    // 揺れが予想される高度（札の乱気流の下限〜上限。無ければ雲の下限〜上限）は、同じ太さの雲の柱にする
    //   雲の絵（横に広い雲の層）を同じ幅で縦に積み重ねる。積乱雲の雲頂がそれより高ければ、上にかなとこ雲
    const tTop = (c.turb?.top || c.top || (c.cb ? 400 : 150)) * 100, tBase = (c.turb?.base ?? c.base ?? 20) * 100;
    // 立体の雲の柱（puffColumn）：揺れの高度帯は同じ太さ、表面に丸いこぶ。積乱雲の雲頂が上なら、かなとこ雲を付ける
    let k = 0;
    for (const [la, lo] of cells) {
      const cellM = Math.min(Dm, step * 111000 * Math.cos(la * Math.PI / 180));
      const R = Math.min(Dm, cellM * 1.3) / 2, z0 = Math.max(0, tBase) * FT * scale, z1 = tTop * FT * scale;
      const anvil = c.cb && top > tTop + 2000 ? { z: top * FT * scale, R: Math.min(Dm * 0.6, R * 1.4) } : null;
      pc.add(puffColumn(lo, la, z0, z1, R, { seed: Math.round(la * 1000 + lo * 7) + k++, anvil }));
    }
    const cl = c.center;
    if (c.box != null && labelOf.get(c.box) !== c) continue;
    ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(cl.lon, cl.lat, top * FT * scale + 15000 * Math.min(scale, 5)),
      label: { text: (c.cb ? `積乱雲 FL${fl3(c.base || 20)}〜${fl3(c.top || 400)}` : `揺れのある雲 FL${fl3(c.base || 0)}〜${fl3(c.top || 0)}`) + (c.turb ? `\n揺れ FL${fl3(c.turb.base ?? 0)}〜${fl3(c.turb.top)}` : ''), font: '600 13px "Meiryo", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#33475b'), showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('rgba(255,255,255,0.88)'),
        disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  }
  if (camPos) queue.sort((a, b) => Cesium.Cartesian3.distanceSquared(b.pos, camPos) - Cesium.Cartesian3.distanceSquared(a.pos, camPos));
  for (const q of queue) { const b = bb.add({ position: q.pos, ...bbSize(q.w, q.h), sizeInMeters: true, verticalOrigin: q.origin }); b.setImage(q.s.id, q.s.cv); }
  return { pc, ds };
}

/** 表示の管理 */
/**
 * FL の札を読めなかったジェット気流に、数値予報の「風が一番強い高さ」から FL を付ける
 *   線の上の3点（両端寄り・中央）で 400〜150hPa の風速と高さを取り、一番強い気圧面の前後3点を放物線で結んで山の高さを求める
 */
const LV = [400, 300, 250, 200, 150];
async function estimateJetFl(jets) {
  const pick = j => [0.2, 0.5, 0.8].map(f => j.pts[Math.min(j.pts.length - 1, Math.round((j.pts.length - 1) * f))]);
  const pts = jets.flatMap(pick);
  const vars = LV.flatMap(p => [`wind_speed_${p}hPa`, `geopotential_height_${p}hPa`]).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map(p => p.lat.toFixed(2)).join(',')}&longitude=${pts.map(p => p.lon.toFixed(2)).join(',')}` +
    `&current=${vars}&models=jma_seamless&wind_speed_unit=kn`;
  const r = await fetch(url); if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  let J = await r.json(); if (!Array.isArray(J)) J = [J];
  const peakFt = c => {
    const v = LV.map(p => c?.[`wind_speed_${p}hPa`]), z = LV.map(p => c?.[`geopotential_height_${p}hPa`]);
    if (v.some(x => x == null) || z.some(x => x == null)) return null;
    let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i;
    if (v[k] < 50) return null;                                       // 50kt 未満はジェット気流とみなさない
    let h = z[k];
    if (k > 0 && k < v.length - 1) {                                   // 前後の気圧面と放物線で結び、風速の山の高さ
      const d = v[k - 1] - 2 * v[k] + v[k + 1];
      if (d < 0) { const t = 0.5 * (v[k - 1] - v[k + 1]) / d; h = t < 0 ? z[k] + t * (z[k] - z[k - 1]) : z[k] + t * (z[k + 1] - z[k]); }
    }
    return h / FT;
  };
  jets.forEach((j, n) => {
    const hs = J.slice(n * 3, n * 3 + 3).map(x => peakFt(x.current)).filter(x => x != null);
    if (!hs.length) return;
    const fl = Math.round(hs.reduce((a, b) => a + b, 0) / hs.length / 1000) * 10;   // 1,000ft 単位（FL○○0）
    Object.assign(j, { fl, fls: j.pts.map(() => fl), est: true });
  });
}

export function createFbjp3D(viewer, { getImageUrl, onStatus }) {
  let on = false, res = null, cur = null, forUrl = null;
  const scale = () => (window.awGetAltScale?.() ?? 1);
  const clear = () => {
    if (cur) { const c = cur; cur = null; viewer.scene.primitives.remove(c.pc); viewer.dataSources.remove(c.ds, true); }
  };
  const draw = () => {
    clear(); animeSky(viewer, on, 'fbjp');
    if (!on || !res) return;
    cur = build(res, scale(), viewer.camera.positionWC);
    viewer.scene.primitives.add(cur.pc); viewer.dataSources.add(cur.ds);
  };
  async function load() {
    const url = getImageUrl(); if (!url) throw new Error('悪天予想図をまだ取得していません');
    if (url === forUrl && res) return;
    onStatus?.('悪天予想図を読み取っています…');
    const im = await new Promise((ok, ng) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = () => ng(new Error('画像を取得できません')); i.src = url; });
    res = parseFbjp(im); forUrl = url;
    if (res.jets.some(j => !j.fl)) await estimateJetFl(res.jets.filter(j => !j.fl)).catch(e => console.warn('[fbjp] jet FL', e));
    // 数値予報も使えないとき（通信できない・回数制限）は、読めたほかのジェット気流の FL、なければ FL350 を仮の高さにして描く
    const known = res.jets.filter(j => j.fl && !j.est).map(j => j.fl);
    for (const j of res.jets) if (!j.fl) {
      const fl = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length / 10) * 10 : 350;
      Object.assign(j, { fl, fls: j.pts.map(() => fl), est: 'guess' });
    }
  }
  const summary = () => {
    const j = res.jets.filter(x => x.fl), c = res.cats.filter(x => x.top), cl = res.clouds;
    return `読み取り結果：ジェット気流 ${j.length}本（${j.map(x => [...new Set(x.fls.filter(Boolean))].map(fl3).join('→') + (x.est === 'guess' ? '（札が読めず、仮の高さ）' : x.est ? '（札が読めず数値予報から推定）' : '')).join('・') || '—'}）、` +
      `CAT ${c.length}か所（${c.map(x => `${fl3(x.base)}〜${fl3(x.top)}`).join('・') || '—'}）、` +
      `雲域 ${cl.length}か所（積乱雲 ${cl.filter(x => x.cb).length}）。図の文字を自動で読んでいるため、元の図と見比べてください。`;
  };
  window.addEventListener('aw:altscale', () => { if (on) draw(); });
  // 雲は立体（puffColumn）なので、視点を動かしても描き直さない
  // main.js の再読込（dataSources.removeAll）で消えたら描き直す
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (cur && d === cur.ds && on) setTimeout(draw, 0); });
  return {
    get on() { return on; },
    async show() { on = true; await load(); draw(); onStatus?.(summary()); },
    hide() { on = false; draw(); onStatus?.(''); },
    async refresh() { if (on) { forUrl = null; await load(); draw(); onStatus?.(summary()); } },
  };
}
