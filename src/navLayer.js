// 航法データ（日本国内の航空路・Waypoint・VOR/DME・TACAN など）を地図に表示する
//   データ：public/data/nav/nav_db.json（AIP Japan ENR 3.1 / 3.3 / 4.1 / 4.3 ＋ AD2 の手順地点）
//   ・航空路：RNAV と従来型を色分けした地表の線。区間をクリックすると MEA・距離・磁方位
//   ・無線施設：VOR 系は六角形、TACAN は菱形、DME は四角
//   ・Waypoint：義務位置通報点は塗りつぶし▲、任意通報点は白抜き△、航空路にない手順地点（SID/STAR）は小さな灰色△
//   ・地点名と航空路名は、近づいたときだけ表示する（全国表示で文字が重ならないように）
//   線・記号・文字は primitive で描く（事例の切り替えで viewer.entities / dataSources が消されても残るように）
import * as Cesium from 'cesium';
import { loadNavDb } from './dbLoader.js';

const URL = `${(import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')}data/nav/nav_db.json`;

const COLOR = {
  rnav: '#80cbc4',       // RNAV 航空路（Y・Z・T など）
  conv: '#ce93d8',       // 従来型航空路（A・B・G・R・V など）
  navaid: '#64ffda',
  compulsory: '#ffffff',
  waypoint: '#e0e0e0',
  terminal: '#9e9e9e',
  airport: '#4fc3f7',
};

// ---- 記号（canvas で描いて billboard の画像にする） ----
function icon(kind) {
  const s = 24, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d'), m = s / 2;
  g.lineWidth = 2; g.lineJoin = 'round';
  const poly = (n, r, rot = 0) => {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + i * 2 * Math.PI / n;
      g[i ? 'lineTo' : 'moveTo'](m + r * Math.cos(a), m + r * Math.sin(a));
    }
    g.closePath();
  };
  const halo = () => { g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 4; g.stroke(); g.lineWidth = 2; };
  switch (kind) {
    case 'vor': case 'vordme': case 'vortac':
      if (kind !== 'vor') {                        // DME／TACAN 併設は外枠の四角
        g.beginPath(); g.rect(2, 2, s - 4, s - 4); halo(); g.strokeStyle = COLOR.navaid; g.stroke();
      }
      poly(6, kind === 'vor' ? 9 : 7.5); halo(); g.strokeStyle = COLOR.navaid; g.stroke();
      g.beginPath(); g.arc(m, m, 2, 0, 7); g.fillStyle = COLOR.navaid; g.fill();
      break;
    case 'tacan':
      poly(4, 9); halo(); g.strokeStyle = COLOR.navaid; g.stroke();
      g.beginPath(); g.arc(m, m, 2, 0, 7); g.fillStyle = COLOR.navaid; g.fill();
      break;
    case 'dme':
      g.beginPath(); g.rect(5, 5, s - 10, s - 10); halo(); g.strokeStyle = COLOR.navaid; g.stroke();
      g.beginPath(); g.arc(m, m, 2, 0, 7); g.fillStyle = COLOR.navaid; g.fill();
      break;
    case 'compulsory':
      poly(3, 8, -Math.PI / 2); halo(); g.fillStyle = COLOR.compulsory; g.fill();
      break;
    case 'waypoint':
      poly(3, 7, -Math.PI / 2); halo(); g.strokeStyle = COLOR.waypoint; g.stroke();
      break;
    case 'terminal':
      poly(3, 5, -Math.PI / 2); halo(); g.strokeStyle = COLOR.terminal; g.stroke();
      break;
    case 'airport':
      g.beginPath(); g.arc(m, m, 6, 0, 7); halo(); g.strokeStyle = COLOR.airport; g.stroke();
      g.beginPath(); g.arc(m, m, 2.5, 0, 7); g.fillStyle = COLOR.airport; g.fill();
      break;
  }
  return c;
}

function navaidKind(t) {
  if (!t) return 'vor';
  if (t.includes('VOR') && t.includes('TACAN')) return 'vortac';
  if (t.includes('VOR') && t.includes('DME')) return 'vordme';
  if (t.includes('VOR')) return 'vor';
  if (t.includes('TACAN')) return 'tacan';
  if (t.includes('DME')) return 'dme';
  return 'vor';
}

// 種類ごとの表示距離（カメラからの距離 m）：記号、文字
const RANGE = {
  navaid:     { icon: 9e6,   label: 1.6e6, font: 'bold 12px "Meiryo", sans-serif' },
  airport:    { icon: 9e6,   label: 1.6e6, font: 'bold 12px "Meiryo", sans-serif' },
  compulsory: { icon: 6e6,   label: 8e5,   font: 'bold 11px "Meiryo", sans-serif' },
  waypoint:   { icon: 4e6,   label: 3.2e5, font: '11px "Meiryo", sans-serif' },
  terminal:   { icon: 1.5e6, label: 1.6e5, font: '10px "Meiryo", sans-serif' },
  airway:     { label: 5e5 },
};

export function createNavLayer(viewer) {
  const prims = [];
  let on = false, loaded = null, stats = null, popup = null, clickHandler = null;
  const pickHooks = [];

  async function load() {
    const db = await loadNavDb();          // 日本＋海外（public/data/intl/）をまとめたもの
    if (!Object.keys(db.fixes).length) throw new Error('航法データを読めません');
    const F = db.fixes, A = db.airways;
    const scene = viewer.scene;

    // 航空路が通る地点（義務通報点・任意通報点と、手順だけの地点を分けるため）
    const through = {};
    for (const [d, a] of Object.entries(A)) for (const p of a.points) (through[p] ||= []).push(d);

    // ---- 航空路（区間ごとに instance を作り、クリックで区間の情報を出す） ----
    const inst = { rnav: [], conv: [] };
    const awLabels = new Cesium.LabelCollection({ scene });
    let segCount = 0;
    for (const [d, a] of Object.entries(A)) {
      const key = a.type === 'RNAV' ? 'rnav' : 'conv';
      for (let i = 0; i < a.points.length - 1; i++) {
        const p = F[a.points[i]], q = F[a.points[i + 1]];
        if (!p || !q) continue;
        const seg = a.segments[i] || {};
        inst[key].push(new Cesium.GeometryInstance({
          id: { awNav: 'airway', d, country: a.country, type: a.type, from: a.points[i], to: a.points[i + 1], ...seg },
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray([p.lon, p.lat, q.lon, q.lat]),
            width: key === 'rnav' ? 2 : 2.4,
          }),
        }));
        segCount++;
        // 航空路名は区間の中ほどに（短い区間は省く）
        if ((seg.nm ?? 99) >= 15) {
          awLabels.add({
            position: Cesium.Cartesian3.fromDegrees((p.lon + q.lon) / 2, (p.lat + q.lat) / 2),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            text: a.designator || d, font: '10px "Meiryo", sans-serif',
            fillColor: Cesium.Color.fromCssColorString(COLOR[key]), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true, backgroundColor: new Cesium.Color(0.08, 0.12, 0.18, 0.75),
            backgroundPadding: new Cesium.Cartesian2(3, 1),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, RANGE.airway.label),
          });
        }
      }
    }
    for (const [key, list] of Object.entries(inst)) {
      if (!list.length) continue;
      prims.push(scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
        geometryInstances: list,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(COLOR[key]).withAlpha(0.85) }),
        }),
      })));
    }

    // ---- 地点（無線施設・Waypoint・空港） ----
    const icons = {};
    const img = k => (icons[k] ||= icon(k));
    const bbs = new Cesium.BillboardCollection({ scene });
    const lbs = new Cesium.LabelCollection({ scene });
    const count = { navaid: 0, compulsory: 0, waypoint: 0, terminal: 0, airport: 0 };
    // 文字が重ならないよう、重要な地点を後から描く（上に重なる）
    const order = { terminal: 0, waypoint: 1, compulsory: 2, navaid: 3, airport: 4 };
    const items = Object.entries(F).map(([id, f]) => {
      let cls, ic;
      if (f.type === 'navaid') { cls = 'navaid'; ic = navaidKind(f.navaidType); }
      else if (f.type === 'airport') { cls = 'airport'; ic = 'airport'; }
      else if (f.reporting === 'COMPULSORY') { cls = 'compulsory'; ic = 'compulsory'; }
      else if (through[id]) { cls = 'waypoint'; ic = 'waypoint'; }
      else { cls = 'terminal'; ic = 'terminal'; }
      return { id, f, cls, ic };
    }).sort((a, b) => order[a.cls] - order[b.cls]);

    for (const { id, f, cls, ic } of items) {
      count[cls]++;
      const R = RANGE[cls];
      const position = Cesium.Cartesian3.fromDegrees(f.lon, f.lat);
      bbs.add({
        position, image: img(ic), id: { awNav: 'fix', id, cls, ...f, airways: through[id] || [] },
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: cls === 'terminal' ? 0.8 : 1,
        scaleByDistance: new Cesium.NearFarScalar(3e5, 1, 5e6, 0.55),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, R.icon),
      });
      const text = cls === 'navaid' ? `${id}${f.freq ? ' ' + f.freq.replace('MHz', '') : ''}`
        : cls === 'airport' ? `${id}${f.iata ? '/' + f.iata : ''}` : (f.ident || id);
      lbs.add({
        position, text, font: R.font,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        fillColor: Cesium.Color.fromCssColorString(COLOR[cls === 'navaid' ? 'navaid' : cls]),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(10, -10),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, R.label),
      });
    }
    prims.push(scene.primitives.add(bbs), scene.primitives.add(lbs), scene.primitives.add(awLabels));
    stats = { ...count, airways: Object.keys(A).length, segments: segCount };
    console.log('[nav] 表示件数', stats);

    // ---- クリックで情報（航法レイヤを表示しているときだけ） ----
    popup = Object.assign(document.createElement('div'), { id: 'awNavPop' });
    Object.assign(popup.style, {
      position: 'absolute', zIndex: 31, display: 'none', pointerEvents: 'auto',
      background: 'rgba(20,30,45,0.96)', color: '#fff', font: '12px/1.55 "Meiryo", sans-serif',
      border: '1px solid #64ffda', borderRadius: '6px', padding: '6px 26px 6px 10px', maxWidth: '300px',
    });
    document.body.appendChild(popup);
    popup.addEventListener('click', e => { if (e.target.dataset.x != null) popup.style.display = 'none'; });

    clickHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    clickHandler.setInputAction(ev => {
      if (!on) return;
      const hit = scene.drillPick(ev.position, 5).map(p => p.id).find(x => x && x.awNav);
      if (!hit) { popup.style.display = 'none'; return; }
      // 経路作成中などは、クリックした地点・航空路を受け取る側に渡す（true が返ればポップアップは出さない）
      if (pickHooks.some(fn => fn(hit) === true)) { popup.style.display = 'none'; return; }
      popup.innerHTML = describe(hit) + '<span data-x style="position:absolute;right:7px;top:3px;cursor:pointer;color:#aaa;font-size:15px">×</span>';
      const W = scene.canvas.clientWidth;
      popup.style.left = Math.min(ev.position.x + 14, W - 310) + 'px';
      popup.style.top = (ev.position.y + 14) + 'px';
      popup.style.display = 'block';
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    prims.forEach(x => { x.show = on; });
  }

  function describe(h) {
    const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const dm = (v, p, n) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? p : n}`;
    if (h.awNav === 'airway') {
      const rows = [
        `<b style="color:${h.type === 'RNAV' ? COLOR.rnav : COLOR.conv};font-size:14px">${esc(h.d.split('~')[0])}</b>　${h.type === 'RNAV' ? 'RNAV航空路' : '従来型航空路'}${h.country ? `（${esc(h.country)}）` : ''}`,
        `区間：${esc(h.from)} → ${esc(h.to)}`,
      ];
      if (h.nm != null) rows.push(`距離：${h.nm} NM${h.trk != null ? `　磁方位：${String(h.trk).padStart(3, '0')}°` : ''}`);
      if (h.mea) rows.push(`MEA：${esc(h.mea)}${h.upper ? `　上限：${esc(h.upper)}` : ''}`);
      return rows.join('<br>');
    }
    const kindJa = { navaid: h.navaidType || '無線施設', airport: '空港', compulsory: '義務位置通報点',
      waypoint: '任意位置通報点', terminal: '手順上の地点（SID/STAR など）' }[h.cls];
    const rows = [`<b style="font-size:14px">${esc(h.ident || h.id)}</b>${h.country ? `<span style="color:#9fb3c8">（${esc(h.country)}）</span>` : ''}　${esc(h.nameJa || h.name || '')}`, esc(kindJa)];
    if (h.freq) rows.push(`周波数：${esc(h.freq)}`);
    rows.push(`${dm(h.lat, 'N', 'S')}　${dm(h.lon, 'E', 'W')}`);
    if (h.airways?.length) rows.push(`航空路：${h.airways.map(esc).join('・')}`);
    return rows.join('<br>');
  }

  return {
    get on() { return on; },
    get stats() { return stats; },
    /** 地点・航空路がクリックされたときに呼ぶ関数を登録（fn(hit) が true を返すと情報ポップアップを出さない） */
    onPick(fn) { pickHooks.push(fn); },
    async setVisible(v) {
      on = v;
      if (v && !loaded) loaded = load().catch(e => { loaded = null; throw e; });
      if (v) await loaded;
      prims.forEach(x => { x.show = on; });
      if (!on && popup) popup.style.display = 'none';
    },
  };
}
