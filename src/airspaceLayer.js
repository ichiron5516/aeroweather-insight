// 空域（AIP Japan ENR から作った public/data/airspace/airspace_db.json ＋ 海外 public/data/intl/ の国別データ）を地図に表示する
//   区分：FIR（福岡FIR）・ACCセクター・管制区・制限／警戒区域・自衛隊訓練空域（回廊・超音速空域を含む）・民間訓練試験空域・防空識別圏
//   ・区分ごとに表示を切り替える（右下の「空域」の段のボタン）
//   ・地図に面（薄い塗り）と境界線と名前を描く
//   ・「3D」をオンにすると、AIP の下限〜上限の高さで箱を描く（高度の倍率に合わせる。UNL は FL600 で切る）
//     ACCセクターは高さの帯ごとに積み重ね、管制区は下限の高さに薄い板、FIR・ADIZ は FL600 までの壁で描く
//   ・地図（2D）では ACCセクターが高さで重なるので、「FL335未満」「FL335以上」を切り替えて見る
//   ・区域をクリックすると、名前・高度・時間・管轄などを表示
//   線・面・文字は primitive で描く（事例の切り替えで viewer.entities / dataSources が消されても残るように）
import * as Cesium from 'cesium';
import { loadAirspaceDb } from './dbLoader.js';

const URL = `${(import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')}data/airspace/airspace_db.json`;
export const LAYERS = [
  ['fir', 'FIR'], ['sector', 'ACCセクター'], ['cta', '管制区'], ['restricted', '制限・警戒区域'],
  ['jsdf', '自衛隊訓練空域'], ['civil', '民間訓練空域'], ['adiz', 'ADIZ'],
];
const UNL_FT = 60000;          // 上限なし（UNL）を立体で描くときの高さ
const ACC_COLOR = { '東京ACC': '#4fc3f7', '福岡ACC': '#81c784', '神戸ACC': '#ffb74d', '福岡ACC（洋上）': '#b0bec5', 'Incheon ACC': '#ba68c8', 'Daegu ACC': '#f48fb1' };
function colorOf(o) {
  switch (o.layer) {
    case 'fir': return '#4fc3f7';
    case 'sector': return ACC_COLOR[o.unit] || '#90a4ae';
    case 'cta': return o.kind === 'tma' ? '#4dd0e1' : o.kind === 'ctr' ? '#80deea' : o.lower >= 2000 ? '#9575cd' : o.lower >= 1000 ? '#7986cb' : '#64b5f6';
    case 'restricted': return o.kind === 'warning' ? '#ffa726' : o.kind === 'prohibited' ? '#c62828' : o.kind === 'danger' ? '#ff7043' : '#ef5350';
    case 'jsdf': return o.kind === 'corridor' ? '#ce93d8' : o.kind === 'supersonic' ? '#f06292' : o.kind === 'low' ? '#ffd54f' : o.kind === 'moa' ? '#ffab91' : '#ff8a65';
    case 'civil': return '#4db6ac';
    case 'adiz': return '#e57373';
    default: return '#ffffff';
  }
}
const FILL_ALPHA = { fir: 0, sector: 0.07, cta: 0.04, restricted: 0.22, jsdf: 0.14, civil: 0.16, adiz: 0 };
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const altText = ft => (ft == null ? 'UNL' : ft === 0 ? 'SFC' : ft >= 14000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${ft.toLocaleString()}ft`);

function centroid(ring) {
  let x = 0, y = 0;
  const n = ring.length - 1 || 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

export function createAirspaceLayer(viewer) {
  const scene = viewer.scene;
  const S = { db: null, on: new Set(), band: 'low', solid: false, prims: {}, loading: null, popup: null };
  const scale = () => window.awGetAltScale?.() ?? 1;

  async function load() {
    if (S.db) return S.db;
    S.loading ||= loadAirspaceDb().then(d => { if (!d.items.length) throw new Error('空域データを読めません'); return d; })
      .then(d => (S.db = d)).catch(e => { S.loading = null; throw e; });
    return S.loading;
  }

  // ACC セクターは選んだ高さの帯だけ
  const inBand = p => S.solid || (S.band === 'low' ? (p.lower ?? 0) < 33500 : (p.upper == null || p.upper > 33500));
  function partsOf(key) {
    const res = [];
    for (const o of S.db.items) {
      if (o.layer !== key) continue;
      o.parts.forEach((p, i) => { if (key !== 'sector' || inBand(p)) res.push({ o, p, i }); });
    }
    return res;
  }

  function polygonGeometry(p, h0, h1) {
    const hier = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(p.ring.slice(0, -1).flat()),
      p.hole ? [new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(p.hole.slice(0, -1).flat()))] : []);
    const g = h0 == null ? new Cesium.PolygonGeometry({ polygonHierarchy: hier })
      : new Cesium.PolygonGeometry({ polygonHierarchy: hier, height: h0, extrudedHeight: h1 });
    try { return Cesium.PolygonGeometry.createGeometry(g) ? g : null; } catch { return null; }   // 自己交差などで面が作れない区域は線だけ
  }

  function build(key) {
    clear(key);
    const list = [];
    const col = o => Cesium.Color.fromCssColorString(colorOf(o));
    const items = partsOf(key);
    const walls = [];
    // ---- 境界線（地表）----
    const lines = items.map(({ o, p, i }) => new Cesium.GeometryInstance({
      id: { awAs: o.id, part: i },
      geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(p.ring.flat()), width: key === 'fir' ? 3 : key === 'cta' ? 1.2 : 2 }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(key === 'cta' ? 0.6 : 0.9)) },
    }));
    // ADIZ は線（外側線・内側線）
    if (key === 'adiz') for (const o of S.db.items.filter(x => x.layer === 'adiz')) for (const [k, l] of (o.lines || []).entries()) {
      lines.push(new Cesium.GeometryInstance({ id: { awAs: o.id, part: -1 - k },
        geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray([...l.pts, l.pts[0]].flat()), width: l.dash ? 1.5 : 2.5 }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(l.dash ? 0.6 : 0.95)) } }));
    }
    if (lines.length) list.push(scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: lines, appearance: new Cesium.PolylineColorAppearance(), asynchronous: true })));
    // ---- 面：地図では薄い塗り、3D では下限〜上限の箱 ----
    const a = FILL_ALPHA[key];
    const k = scale(), H = ft => Math.min(ft ?? UNL_FT, UNL_FT) * 0.3048 * k;
    if (S.solid) {
      const box = [], edge = [];
      const add = (o, p, i, h0, h1, alpha) => {
        const g = polygonGeometry(p, h0, h1);
        if (!g) return;
        box.push(new Cesium.GeometryInstance({ id: { awAs: o.id, part: i }, geometry: g,
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(alpha)) } }));
        // 箱の稜線（上下の輪郭と縦の線）
        const hier = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(p.ring.slice(0, -1).flat()));
        edge.push(new Cesium.GeometryInstance({ id: { awAs: o.id, part: i },
          geometry: new Cesium.PolygonOutlineGeometry({ polygonHierarchy: hier, height: h0, extrudedHeight: h1 }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(0.75)) } }));
      };
      for (const { o, p, i } of items) {
        if (key === 'cta' && !o.kind) add(o, p, i, H(p.lower), H(p.lower) + 300 * k, 0.10);       // 下限の高さに薄い板
        else if (key === 'cta') add(o, p, i, H(p.lower ?? 0), H(p.upper), 0.10);                       // 海外の TMA・管制圏は下限〜上限の箱
        else if (key === 'fir') {                                                                   // 地表〜FL600 の壁
          walls.push({ o, p, i });
        } else add(o, p, i, H(p.lower ?? 0), H(p.upper), key === 'sector' ? 0.08 : Math.max(0.16, a));
      }
      if (box.length) list.push(scene.primitives.add(new Cesium.Primitive({ geometryInstances: box,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }), asynchronous: true })));
      if (edge.length && key !== 'cta') list.push(scene.primitives.add(new Cesium.Primitive({ geometryInstances: edge,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), asynchronous: true })));
      // FIR・ADIZ：境界に沿った半透明の壁
      const wl = [];
      for (const { o, p } of walls) wl.push({ o, pts: p.ring });
      if (key === 'adiz') for (const o of S.db.items.filter(x => x.layer === 'adiz')) for (const l of o.lines || []) wl.push({ o, pts: [...l.pts, l.pts[0]] });
      const wi = wl.map(({ o, pts }) => new Cesium.GeometryInstance({ id: { awAs: o.id, part: 0 },
        geometry: new Cesium.WallGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()),
          minimumHeights: pts.map(() => 0), maximumHeights: pts.map(() => H(null)) }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(0.13)) } }));
      if (wi.length) list.push(scene.primitives.add(new Cesium.Primitive({ geometryInstances: wi,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }), asynchronous: true })));
    } else if (a > 0) {
      const inst = items.map(({ o, p, i }) => {
        const g = polygonGeometry(p);
        return g && new Cesium.GeometryInstance({ id: { awAs: o.id, part: i }, geometry: g,
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(col(o).withAlpha(a)) } });
      }).filter(Boolean);
      if (inst.length) list.push(scene.groundPrimitives.add(new Cesium.GroundPrimitive({ geometryInstances: inst,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }), asynchronous: true })));
    }
    // ---- 名前（区域ごとに1つ。ACCセクター・制限区域などは高度も）----
    const labels = new Cesium.LabelCollection({ scene });
    const seen = new Set();
    for (const { o, p } of items) {
      if (key === 'cta' && !o.kind) continue;
      const tag = (key === 'sector' && !S.solid) || key === 'cta' ? o.id : `${o.id}:${p.label || ''}:${S.solid ? p.lower : ''}`;
      if (seen.has(tag)) continue; seen.add(tag);
      const [x, y] = centroid(p.ring);
      const name = key === 'cta' ? o.name : key === 'sector' ? (o.short || o.id) : key === 'fir' ? (o.short || 'FUKUOKA FIR') : (p.label && o.parts.length > 1 ? p.label : o.name.replace(/（.*?）$/, ''));
      const hz = S.solid && !['fir', 'adiz'].includes(key) ? Math.min(p.upper ?? UNL_FT, UNL_FT) * 0.3048 * scale() + 2000 : 2000;
      labels.add({ position: Cesium.Cartesian3.fromDegrees(x, y, hz), text: `${name}\n${key === 'cta' ? `${altText(o.lower)}–${altText(o.upper)}` : `${altText(p.lower)}–${altText(p.upper)}`}`,
        font: `${key === 'sector' ? 'bold 13px' : '11px'} "Meiryo", sans-serif`, fillColor: col(o), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, key === 'sector' || key === 'fir' ? 9e6 : key === 'civil' ? 9e5 : 3e6) });
    }
    list.push(scene.primitives.add(labels));
    S.prims[key] = list;
  }
  function clear(key) {
    for (const p of S.prims[key] || []) { scene.primitives.remove(p) || scene.groundPrimitives.remove(p); }
    delete S.prims[key];
  }
  const redraw = () => { for (const k of S.on) build(k); };

  // ---- クリックで情報 ----
  S.popup = Object.assign(document.createElement('div'), { id: 'awAsPop' });
  Object.assign(S.popup.style, { position: 'absolute', zIndex: 31, display: 'none', background: 'rgba(20,30,45,0.96)', color: '#fff',
    font: '12px/1.55 "Meiryo", sans-serif', border: '1px solid #ef9a9a', borderRadius: '6px', padding: '6px 26px 6px 10px', maxWidth: '340px' });
  document.body.appendChild(S.popup);
  S.popup.addEventListener('click', e => { if (e.target.dataset.x != null) S.popup.style.display = 'none'; });
  const hd = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  hd.setInputAction(ev => {
    if (!S.on.size || !S.db) return;
    const hits = scene.drillPick(ev.position, 8).map(h => h.id).filter(x => x && x.awAs);
    if (!hits.length) { S.popup.style.display = 'none'; return; }
    // 小さい区域を優先（大きな FIR・管制区より、中にある制限区域などを先に）
    const ord = { restricted: 0, jsdf: 1, civil: 2, sector: 3, cta: 4, adiz: 5, fir: 6 };
    const items = [...new Map(hits.map(h => [`${h.awAs}:${h.part}`, h])).values()]
      .map(h => ({ h, o: S.db.items.find(x => x.id === h.awAs) })).filter(x => x.o)
      .sort((a, b) => ord[a.o.layer] - ord[b.o.layer]).slice(0, 3);
    S.popup.innerHTML = items.map(({ h, o }) => {
      const p = o.parts[h.part];
      const rows = [`<b style="color:${colorOf(o)};font-size:13.5px">${esc(o.name)}${p?.label && o.parts.length > 1 ? `　${esc(p.label)}` : ''}</b>`];
      if (p) rows.push(`高度：${altText(p.lower)} 〜 ${altText(p.upper)}${o.agl ? '（地表から）' : ''}`);
      for (const [k, v] of Object.entries(o.info || {})) rows.push(`${esc(k)}：${esc(v)}`);
      if (p?.freq) rows.push(`周波数：${esc(p.freq)}`);
      if (p?.note) rows.push(`<span style="color:#ffcc80">${esc(p.note)}</span>`);
      rows.push(`<span style="color:#9fb3c8">出典：AIP Japan ${esc(o.src)}</span>`);
      return rows.join('<br>');
    }).join('<hr style="border:none;border-top:1px solid #2c4258;margin:5px 0">') +
      '<span data-x style="position:absolute;right:7px;top:3px;cursor:pointer;color:#aaa;font-size:15px">×</span>';
    S.popup.style.left = Math.min(ev.position.x + 14, scene.canvas.clientWidth - 350) + 'px';
    S.popup.style.top = Math.min(ev.position.y + 14, scene.canvas.clientHeight - 200) + 'px';
    S.popup.style.display = 'block';
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  // 高度の倍率を変えたら立体を描き直す
  window.addEventListener('aw:altscale', () => { if (S.solid) setTimeout(redraw, 0); });

  return {
    isOn: k => S.on.has(k),
    get band() { return S.band; }, get solid() { return S.solid; },
    async toggle(key) {
      await load();
      if (S.on.has(key)) { S.on.delete(key); clear(key); } else { S.on.add(key); build(key); }
      if (!S.on.size) S.popup.style.display = 'none';
      return S.on.has(key);
    },
    setBand(b) { S.band = b; if (S.on.has('sector')) build('sector'); },
    setSolid(v) { S.solid = v; redraw(); },
    counts() { return S.db ? Object.fromEntries(LAYERS.map(([k]) => [k, S.db.items.filter(o => o.layer === k).length])) : null; },
  };
}
