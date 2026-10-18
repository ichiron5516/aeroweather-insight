import * as Cesium from 'cesium';
import { installGpvRouter } from './gpvSource/omShim.js';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { initAdvisor } from './advisor/advisor.js';
import { initAipPanel } from './aipImport/aipPanel.js';
import { createMountains3D } from './mountains3D.js';
import { createFirLayer } from './firLayer.js';
import { createGridLayer } from './gridLayer.js';
import { createVarLayer } from './varLayer.js';
import { createNavLayer } from './navLayer.js';
import { createAirspaceLayer } from './airspaceLayer.js';
import { createGpvPanel } from './gpvLayer.js';
import { createSigwxPanel } from './sigwxLayer.js';
import { CloudOnlyImageryProvider, CLOUD_ONLY } from './wxPanels/cloudOnly.js';

// GPV（Open-Meteo の書式の問い合わせ）を京都大学 RISH の気象庁 GSM で答える。読めなければ Open-Meteo（2026-10-18）
installGpvRouter();

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_ION_TOKEN;
const viewer = new Cesium.Viewer('cesiumContainer', {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  timeline: true,
  animation: true,
  infoBox: false,
  selectionIndicator: true,
  baseLayerPicker: false,   // 右上の地図（レイヤ）切替ボタンは使わない
});
window.viewer = viewer;   // 開発用：Consoleからカメラ位置を取得するため
window.Cesium = Cesium;   // 同上

// ---- 揺れ回避 経路アドバイス（リアルタイム気象で登録経路を採点） ----
const advisorReady = initAdvisor(viewer);
// AIP 取り込みパネル（「航法」の段の「📥 AIP取込」）
initAipPanel(document.getElementById('aipBtn'));

// ---- 高度誇張モード ----
const EXAG_CHOICES = [25, 50, 75, 100];   // 選べる誇張倍率（右下の「高度」ボタン）
let ALT_EXAG = 25;                        // 誇張するときの倍率（最後に選んだもの。初期値25。3D 表示はすべてこの倍率から始める）
window.AW_EXAG = ALT_EXAG;                // 実寸から自動で誇張に切り替える処理（雲・山・天気図）もこの倍率を使う
let ALT_SCALE = 1;                    // 1 = 実寸、ALT_EXAG = 誇張
let CASE_MODE = false;   // false = リアルタイム（初期画面）、true = 2026-07-06 関西→新千歳の事例を表示
let fbjpOn = false;        // 予想図レイヤの表示状態
let fbjpItems = [];       // FBJP由来の表示物のリスト
let curtainEntity = null;
let routePts = [];   // ホバー用：経路の点（座標と高度）
let curtainOn = false;   // 現在の表示状態を記憶
let upperItems = [];      // 高層解析の表示物リスト
let upperOn = true;   // 親スイッチは廃止（常にON、表示は levelOn で制御）
const AZ = m => m * ALT_SCALE;        // 高度にこれを通す

// ---- Step 1: 飛行経路 ----
async function loadFlightRoute() {
  const res = await fetch('./data/flight_route.json');
  const flight = await res.json();
  const positions = flight.route.flatMap(p => [p.lon, p.lat, AZ(p.alt_m)]);
  // ホバー表示用に各点を記録（AZ適用済みの3D座標と実高度のペア）
  routePts = flight.route.map(p => ({
    cart: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, AZ(p.alt_m)),
    alt_m: p.alt_m,
    phase: p.phase,
  }));

  viewer.entities.add({
    name: flight.name,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
      width: 5,
      material: new Cesium.PolylineGlowMaterialProperty({
        color: Cesium.Color.CYAN, glowPower: 0.25 }),
    },
  });

  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
      width: 2,
      material: Cesium.Color.WHITE.withAlpha(0.4),
      clampToGround: true,
    },
  });
  // 経路のカーテン（高度の誤読防止用の壁）
  curtainEntity = viewer.entities.add({
    name: '経路カーテン',
    show: curtainOn,
    wall: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
      material: new Cesium.StripeMaterialProperty({
        evenColor: Cesium.Color.CYAN.withAlpha(0.28),
        oddColor: Cesium.Color.CYAN.withAlpha(0.06),
        repeat: 160,                       // 縞の本数（経路全長に対して）
        orientation: Cesium.StripeOrientation.VERTICAL,
      }),
      outline: true,
      outlineColor: Cesium.Color.CYAN.withAlpha(0.5),
    },
  });
}

// ---- Step 2: 空港ピン ----
const riskColor = {
  low: Cesium.Color.LIME,
  medium: Cesium.Color.YELLOW,
  high: Cesium.Color.RED,
};
const riskLabel = { low: 'リスク低', medium: '注意', high: '警戒' };

async function loadAirports() {
  const res = await fetch('./data/metar_taf.json');
  const airports = await res.json();

  for (const [icao, ap] of Object.entries(airports)) {
    viewer.entities.add({
      id: `airport-${icao}`,
      name: ap.name,
      position: Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 0),
      point: {
        pixelSize: 14,
        color: riskColor[ap.risk] ?? Cesium.Color.WHITE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${icao} ${ap.shortName ?? ''}`,
        font: 'bold 15px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -24),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      },
      properties: { kind: 'airport', icao, ...ap },
    });
  }
}

// ---- Step 3: 前線・雲域 ----
async function loadWeather() {
  const fronts = await Cesium.GeoJsonDataSource.load('./data/fronts.geojson', {
    clampToGround: true,
  });
  viewer.dataSources.add(fronts);
  fronts.show = fbjpOn;
  fbjpItems.push(fronts);

  for (const e of fronts.entities.values) {
    const type = e.properties?.type?.getValue();
    if (type === 'cold_front' && e.polyline) {
      e.polyline.material = Cesium.Color.fromCssColorString('#1565c0');
      e.polyline.width = 5;
    }
    if (type === 'warm_front' && e.polyline) {
      e.polyline.material = Cesium.Color.fromCssColorString('#c62828');
      e.polyline.width = 5;
    }
    if (type === 'stationary_front' && e.polyline) {
      e.show = false;

      const degs = e.polyline.positions.getValue().map(p => {
        const c = Cesium.Cartographic.fromCartesian(p);
        return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
      });

      const pts = [];
      for (let i = 0; i < degs.length - 1; i++) {
        const N = 4;
        for (let k = 0; k < N; k++) {
          pts.push([
            degs[i][0] + (degs[i + 1][0] - degs[i][0]) * k / N,
            degs[i][1] + (degs[i + 1][1] - degs[i][1]) * k / N,
          ]);
        }
      }
      pts.push(degs[degs.length - 1]);

      for (let i = 0; i < pts.length - 1; i++) {
        const seg = viewer.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
            ]),
            width: 5,
            material: i % 2 === 0
              ? Cesium.Color.fromCssColorString('#c62828')
              : Cesium.Color.fromCssColorString('#1565c0'),
            clampToGround: true,
          },
        });
        seg.show = fbjpOn;
        fbjpItems.push(seg);
      }
    }
    if (type === 'high_center') {
      e.billboard = undefined;
      e.point = new Cesium.PointGraphics({
        pixelSize: 16,
        color: Cesium.Color.BLUE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      });
      e.label = new Cesium.LabelGraphics({
        text: 'H ' + e.properties.label.getValue(),
        font: 'bold 14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -26),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      });
    }
    if (type === 'low_center') {
      e.billboard = undefined;
      e.point = new Cesium.PointGraphics({
        pixelSize: 16,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      });
      e.label = new Cesium.LabelGraphics({
        text: 'L ' + e.properties.label.getValue(),
        font: 'bold 14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -26),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      });
    }
  }

  const clouds = await Cesium.GeoJsonDataSource.load('./data/clouds.geojson');
  viewer.dataSources.add(clouds);
  clouds.show = fbjpOn;
  fbjpItems.push(clouds);

  for (const e of clouds.entities.values) {
    if (!e.polygon) continue;
    const base = e.properties.base_m.getValue();
    const top = e.properties.top_m.getValue();
    e.polygon.height = AZ(base);
    e.polygon.extrudedHeight = AZ(top);
    e.polygon.material = Cesium.Color.WHITE.withAlpha(0.15);
    e.polygon.outline = true;
    e.polygon.outlineColor = Cesium.Color.WHITE.withAlpha(0.4);
  }
}

// ---- Step 4: ジェット気流・乱気流域 ----
function ellipseShape(width, height, granularity = 24) {
  const shape = [];
  for (let i = 0; i < granularity; i++) {
    const angle = (i / granularity) * 2 * Math.PI;
    shape.push(new Cesium.Cartesian2(
      Math.cos(angle) * width,
      Math.sin(angle) * height
    ));
  }
  return shape;
}

async function loadUpperAir() {
  const res = await fetch('./data/jetstream.geojson');
  const jet = await res.json();

  for (const f of jet.features) {
    const alt = f.properties.alt_m;
    const coords = f.geometry.coordinates;

    const controlPoints = coords.map(c =>
      Cesium.Cartesian3.fromDegrees(c[0], c[1], alt)
    );
    const times = controlPoints.map((_, i) => i / (controlPoints.length - 1));
    const spline = new Cesium.CatmullRomSpline({ times, points: controlPoints });

    const smooth = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const pos = spline.evaluate(t);
      const carto = Cesium.Cartographic.fromCartesian(pos);
      carto.height = AZ(alt + Math.sin(t * Math.PI * 5) * 600);
      smooth.push(Cesium.Cartographic.toCartesian(carto));
    }

    // チューブ状のジェット気流
    const tube = viewer.entities.add({
      name: f.properties.label,
      polylineVolume: {
        positions: smooth,
        shape: ellipseShape(40000, 1200 * (ALT_SCALE === 1 ? 1 : 5)),
        material: Cesium.Color.MEDIUMPURPLE.withAlpha(0.4),
        outline: false,
      },
    });
    tube.show = fbjpOn;
    fbjpItems.push(tube);

    // 中心の矢印線
    const arrow = viewer.entities.add({
      polyline: {
        positions: smooth,
        width: 12,
        material: new Cesium.PolylineArrowMaterialProperty(
          Cesium.Color.MEDIUMPURPLE.withAlpha(0.9)
        ),
      },
    });
    arrow.show = fbjpOn;
    fbjpItems.push(arrow);

    // ラベル
    const mid = coords[Math.floor(coords.length / 2)];
    const jlabel = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1], AZ(alt + 2000)),
      label: {
        text: f.properties.label,
        font: 'bold 13px sans-serif',
        fillColor: Cesium.Color.PLUM,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      },
    });
    jlabel.show = fbjpOn;
    fbjpItems.push(jlabel);
  }

  const res2 = await fetch('./data/turbulence.json');
  const turb = await res2.json();

  for (const a of turb.areas) {
    const topZ = AZ(a.alt_top_m);
    const bottomZ = AZ(a.alt_bottom_m);

    const cyl = viewer.entities.add({
      name: a.label,
      position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, (topZ + bottomZ) / 2),
      cylinder: {
        length: topZ - bottomZ,
        topRadius: a.radius_x_m,
        bottomRadius: a.radius_x_m,
        material: Cesium.Color.ORANGE.withAlpha(0.3),
        outline: true,
        outlineColor: Cesium.Color.ORANGE.withAlpha(0.6),
        numberOfVerticalLines: 8,
      },
      label: {
        text: `⚠ ${a.severity} 乱気流 FL330-370`,
        font: 'bold 13px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -20),
        fillColor: Cesium.Color.ORANGE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    cyl.show = fbjpOn;
    fbjpItems.push(cyl);
  }
}

// ---- Step 5: 教育用コメント（！マーカー） ----
async function loadComments() {
  const res = await fetch('./data/comments.json');
  const data = await res.json();

  for (const c of data.comments) {
    const marker = viewer.entities.add({
      id: `comment-${c.id}`,
      name: c.title,
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, AZ(c.alt_m)),
      point: {
        pixelSize: 18,
        color: Cesium.Color.GOLD,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '！',
        font: 'bold 16px sans-serif',
        fillColor: Cesium.Color.BLACK,
        style: Cesium.LabelStyle.FILL,
        eyeOffset: new Cesium.Cartesian3(0, 0, -100),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { kind: 'comment', ...c },
    });
    if (c.id.startsWith('u')) {
      // コメントIDから対応する気圧面のflを引き当てる
      const flMap = { u850: 50, u700: 100, u500: 180, u300: 300, u200: 390 };
      marker.__fl = flMap[c.id] ?? 300;
      marker.show = false;           // 初期は全面OFFなので非表示で開始
      upperItems.push(marker);
    } else {
      marker.show = fbjpOn;          // 予想図グループ（c1〜c3）
      fbjpItems.push(marker);
    }
  }
}

// ---- FL基準リング（高度目盛り） ----
let flRingItems = [];
let flRingOn = false;

function loadFlRings() {
  const west = 132, south = 32, east = 146, north = 44;

  for (const fl of [50, 100, 180, 300, 340, 390]) {
    const alt = AZ(fl * 30.48);
    const ring = viewer.entities.add({
      show: flRingOn,
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
        height: alt,
        material: Cesium.Color.WHITE.withAlpha(0.03),
        outline: true,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
      },
    });
    const lbl = viewer.entities.add({
      show: flRingOn,
      position: Cesium.Cartesian3.fromDegrees(west + 0.3, north - 0.3, alt),
      label: {
        text: `FL${String(fl).padStart(3, '0')}`,
        font: 'bold 13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    flRingItems.push(ring, lbl);
  }
}

document.getElementById('flRingBtn').onclick = () => {
  flRingOn = !flRingOn;
  flRingItems.forEach(item => { item.show = flRingOn; });
  document.getElementById('flRingBtn').textContent =
    flRingOn ? '高度目盛OFF' : '高度目盛ON';
};

// ---- FIR（飛行情報区）の境界線 ----
const firLayer = createFirLayer(viewer);
document.getElementById('firBtn').onclick = async () => {
  const b = document.getElementById('firBtn');
  try {
    await firLayer.setVisible(!firLayer.on);
    b.textContent = firLayer.on ? 'FIR境界OFF' : 'FIR境界ON';
  } catch (e) { console.warn('[FIR]', e); b.textContent = 'FIR境界（読込失敗）'; }
};

// ---- 緯度・経度の線 ----
const gridLayer = createGridLayer(viewer);
document.getElementById('gridBtn').onclick = () => {
  const b = document.getElementById('gridBtn');
  gridLayer.setVisible(!gridLayer.on);
  b.textContent = gridLayer.on ? '緯度経度線OFF' : '緯度経度線ON';
  b.classList.toggle('on', gridLayer.on);
};

// ---- 磁気偏差（Variation）の等偏角線 ----
const varLayer = createVarLayer(viewer);
document.getElementById('varBtn').onclick = () => {
  const b = document.getElementById('varBtn');
  varLayer.setVisible(!varLayer.on);
  b.textContent = varLayer.on ? 'Variation OFF' : 'Variation ON';
  b.classList.toggle('on', varLayer.on);
};

// ---- 航法データ（日本国内の航空路・Waypoint・VOR/DME・TACAN） ----
const navLayer = createNavLayer(viewer);
async function setNavVisible(v) {
  const b = document.getElementById('navBtn');
  if (v === navLayer.on) return;
  b.textContent = '✈ 読み込み中…';
  try {
    await navLayer.setVisible(v);
    b.textContent = navLayer.on ? '✈ 航法データ非表示' : '✈ 航法データ表示';
    b.classList.toggle('on', navLayer.on);
    document.getElementById('navLegend').classList.toggle('on', navLayer.on);
    const s = navLayer.stats;
    if (s) b.title = `航空路 ${s.airways}本（${s.segments}区間）・無線施設 ${s.navaid}・義務通報点 ${s.compulsory}・任意通報点 ${s.waypoint}・手順地点 ${s.terminal}・空港 ${s.airport}。記号や航空路をクリックすると詳細`;
  } catch (e) { console.warn('[nav]', e); b.textContent = '✈ 航法データ（読込失敗）'; }
}
document.getElementById('navBtn').onclick = () => setNavVisible(!navLayer.on);
// 経路アドバイスの「経路を作る」BOX から使う
window.awNav = { setVisible: setNavVisible, onPick: fn => navLayer.onPick(fn), get on() { return navLayer.on; } };

// ---- 衛星雲頂3D（ひまわり赤外の雲頂温度 → 雲頂の高さ。アニメ風の雲・エコーの所は積乱雲）。処理は chartsPanel.js ----
{
  const b = document.getElementById('ct3dBtn'), st = document.getElementById('ct3dSt');
  b.onclick = async () => {
    if (!window.awCloudTop3D) { st.textContent = '天気図パネルの準備中です。少し待ってから押してください。'; return; }
    b.disabled = true;
    try {
      const on = await window.awCloudTop3D.set(!window.awCloudTop3D.on);
      b.classList.toggle('on', on); b.textContent = on ? '☁ 衛星雲頂3D 消す' : '☁ 衛星雲頂3D';
      if (!on) st.textContent = '';
    } catch (e) { console.warn('[cloud top 3D]', e); st.textContent = `雲頂3Dを表示できませんでした（${e.message}）`; }
    b.disabled = false;
  };
  window.addEventListener('aw:ct3d', e => { if (window.awCloudTop3D?.on || !e.detail) st.textContent = e.detail || ''; });
  // 「雲の強調」など別の所から消えたときもボタンを合わせる
  window.addEventListener('aw:clouds', () => setTimeout(() => {
    const on = !!window.awCloudTop3D?.on;
    b.classList.toggle('on', on); b.textContent = on ? '☁ 衛星雲頂3D 消す' : '☁ 衛星雲頂3D';
  }, 0));
}

// ---- 空域（AIP ENR：FIR・ACCセクター・管制区・制限区域・訓練空域・ADIZ） ----
const airspace = createAirspaceLayer(viewer);
document.querySelectorAll('#asRow [data-as]').forEach(b => {
  const label = b.textContent;
  b.onclick = async () => {
    b.textContent = '読み込み中…';
    try { b.classList.toggle('on', await airspace.toggle(b.dataset.as)); }
    catch (e) { console.warn('[airspace]', e); alert('空域データを読み込めませんでした: ' + e.message); }
    b.textContent = label;
  };
});
document.getElementById('asBand').onclick = e => {
  airspace.setBand(airspace.band === 'low' ? 'high' : 'low');
  e.target.textContent = airspace.band === 'low' ? 'FL335未満' : 'FL335以上';
};
document.getElementById('asSolid').onclick = async e => {
  const on = !airspace.solid;
  e.target.classList.toggle('on', on);
  const band = document.getElementById('asBand');
  band.disabled = on; band.style.opacity = on ? '0.4' : '';
  band.textContent = on ? '全高度（3D）' : (airspace.band === 'low' ? 'FL335未満' : 'FL335以上');
  if (on) {
    // 実寸では空域の厚み（数km）が見えないので、高度を誇張して斜めから見る
    if ((window.awGetAltScale?.() ?? 1) === 1) await window.awSetExag?.(window.AW_EXAG > 1 ? window.AW_EXAG : 25);
    const c = viewer.camera, ctr = c.pickEllipsoid(new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2));
    if (ctr && c.pitch < Cesium.Math.toRadians(-70)) {
      const range = Math.min(4.5e6, Math.max(6e5, Cesium.Cartesian3.distance(c.positionWC, ctr)));
      c.flyToBoundingSphere(new Cesium.BoundingSphere(ctr, 1), { offset: new Cesium.HeadingPitchRange(c.heading, Cesium.Math.toRadians(-32), range), duration: 1.2 });
    }
  }
  airspace.setSolid(on);
};

// ---- GPV（気象庁GSM・Open-Meteo 経由） ----
const gpvPanel = createGpvPanel(viewer);
document.getElementById('gpvBtn').onclick = () => gpvPanel.setVisible(!gpvPanel.on);
window.addEventListener('aw:gpv', e => {
  const b = document.getElementById('gpvBtn');
  b.textContent = e.detail ? 'GPV非表示' : 'GPV表示';
  b.classList.toggle('on', !!e.detail);
});

// ---- 国際悪天予想図（WAFS SIGWX・NOAA AWC） ----
const sigwxPanel = createSigwxPanel(viewer);
window.awSigwx = sigwxPanel;
document.getElementById('sigwxBtn').onclick = () => sigwxPanel.setVisible(!sigwxPanel.on);
window.addEventListener('aw:sigwx', e => document.getElementById('sigwxBtn').classList.toggle('on', !!e.detail));

// ---- 高層解析の各気圧面オーバーレイ ----
const upperStyle = {
  wet_area:       { color: '#4db6ac', alpha: 0.25 },
  strong_wind:    { color: '#ba68c8', alpha: 0.22 },
  trough:         { color: '#8d6e63' },
  jet_axis:       { color: '#7e57c2' },
  height_contour: { color: '#eceff1' },   // 等高度線＝白の実線
  isotherm:       { color: '#ef5350' },   // 等温線＝赤の破線
};

let levelOn = { 50: false, 100: false, 180: false, 300: false, 340: false, 390: false };
let upperHoverPts = [];                  // ホバー数値表示用の点

function refreshUpper() {
  upperItems.forEach(ent => {
    const fl = ent.__fl;
    // FL340/390（ジェット軸）は300面ボタンに連動させる
    const key = (fl === 340 || fl === 390) ? 300 : fl;
    ent.show = levelOn[key] === true;
  });
}

async function loadUpperLevels() {
  upperHoverPts = [];
  const res = await fetch('./data/upper_levels.geojson');
  const geo = await res.json();

  for (const f of geo.features) {
    const fl = f.properties.fl;
    const alt = AZ(fl * 30.48);
    const type = f.properties.type;
    const st = upperStyle[type] ?? { color: '#ffffff' };

    if (f.geometry.type === 'Polygon') {
      const flat = f.geometry.coordinates[0].flatMap(c => [c[0], c[1]]);
      const ent = viewer.entities.add({
        show: false,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
          height: alt,
          material: Cesium.Color.fromCssColorString(st.color).withAlpha(st.alpha ?? 0.25),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(st.color).withAlpha(0.8),
        },
      });
      ent.__fl = fl;
      upperItems.push(ent);
    }

    if (f.geometry.type === 'LineString') {
      const pos = f.geometry.coordinates.flatMap(c => [c[0], c[1], alt]);
      const isJet = type === 'jet_axis';
      const isSolid = type === 'height_contour';
      const ent = viewer.entities.add({
        show: false,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(pos),
          width: isJet ? 14 : 3,
          material: isJet
            ? new Cesium.PolylineArrowMaterialProperty(
                Cesium.Color.fromCssColorString(st.color).withAlpha(0.9))
            : isSolid
              ? Cesium.Color.fromCssColorString(st.color).withAlpha(0.9)
              : new Cesium.PolylineDashMaterialProperty({
                  color: Cesium.Color.fromCssColorString(st.color) }),
        },
      });
      ent.__fl = fl;
      upperItems.push(ent);

      // ホバー数値用に線上の点を記録（各区間を8分割）
      const hoverText = f.properties.hover ?? f.properties.label;
      const cs = f.geometry.coordinates;
      for (let i = 0; i < cs.length - 1; i++) {
        for (let k = 0; k < 8; k++) {
          const t = k / 8;
          upperHoverPts.push({
            cart: Cesium.Cartesian3.fromDegrees(
              cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t,
              cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t,
              alt),
            text: hoverText,
            fl,
          });
        }
      }
    }

    // ラベル（等高度線・等温線はホバー任せにして浮遊ラベルは付けない）
    if (type !== 'height_contour' && type !== 'isotherm') {
      const c0 = f.geometry.type === 'Polygon'
        ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
      const lbl = viewer.entities.add({
        show: false,
        position: Cesium.Cartesian3.fromDegrees(c0[0], c0[1], alt + AZ(200)),
        label: {
          text: f.properties.label,
          font: 'bold 12px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      lbl.__fl = fl;
      upperItems.push(lbl);
    }
  }
  refreshUpper();
  
}

document.getElementById('chart850Btn').onclick = () => {
  levelOn[50] = !levelOn[50];
  refreshUpper();
  document.getElementById('chart850Btn').textContent =
    levelOn[50] ? '850面 表示中' : '850面';
};

document.getElementById('chart700Btn').onclick = () => {
  levelOn[100] = !levelOn[100];
  refreshUpper();
  document.getElementById('chart700Btn').textContent =
    levelOn[100] ? '700面 表示中' : '700面';
};

document.getElementById('chart500Btn').onclick = () => {
  levelOn[180] = !levelOn[180];
  refreshUpper();
  document.getElementById('chart500Btn').textContent =
    levelOn[180] ? '500面 表示中' : '500面';
};

document.getElementById('chart300Btn').onclick = () => {
  levelOn[300] = !levelOn[300];
  refreshUpper();
  document.getElementById('chart300Btn').textContent =
    levelOn[300] ? '300面 表示中' : '300面';
};



// ---- クリック処理（空港・コメント共通） ----
const infoPanel = document.getElementById('infoPanel');
const commentPanel = document.getElementById('commentPanel');

viewer.selectedEntityChanged.addEventListener((entity) => {
  infoPanel.style.display = 'none';
  commentPanel.style.display = 'none';
  if (!entity || !entity.properties) return;
  if (!entity.properties.kind) { viewer.selectedEntity = undefined; return; }

  const kind = entity.properties.kind?.getValue();

  if (kind === 'airport') {
    const p = entity.properties;
    const risk = p.risk.getValue();
    document.getElementById('apName').textContent = p.name.getValue();
    document.getElementById('apSummary').textContent = p.summary.getValue();
    document.getElementById('apMetar').textContent = p.metar.getValue();
    document.getElementById('apTaf').textContent = p.taf.getValue();
    const badge = document.getElementById('apRisk');
    badge.textContent = riskLabel[risk];
    badge.className = `risk-badge risk-${risk}`;
    infoPanel.style.display = 'block';
  }

  if (kind === 'comment') {
    const p = entity.properties;
    document.getElementById('cTitle').textContent = '！ ' + p.title.getValue();
    document.getElementById('cWhy').textContent = p.why.getValue();
    document.getElementById('cBasis').textContent = p.basis.getValue();
    commentPanel.style.display = 'block';
  }
});

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.onclick = () => { viewer.selectedEntity = undefined; };
});

// ---- 初期カメラ：日本全体を真上から ----
const JAPAN_RECT = Cesium.Rectangle.fromDegrees(123, 24, 149, 46);
viewer.camera.setView({ destination: JAPAN_RECT });

// 事例（7/6 関西→新千歳）は「事例表示」ボタンで読み込む。初期画面はリアルタイム表示のみ
if (CASE_MODE) {
  loadFlightRoute();
  loadAirports();
  loadWeather();
  loadUpperAir();
  loadComments();
  loadFlRings();
  loadUpperLevels();
}

// ---- Step 6: カメラプリセット ----
  // [経度, 緯度, 高度m, 傾きdeg]
const camPresets = {
  all:  { lon: 139.219, lat: 26.905, height: 870492,  heading: 0, pitch: -40 },
  dep:  { lon: 135.383, lat: 31.923, height: 227579,  heading: 0, pitch: -35 },
  turb: { lon: 137.382, lat: 30.734, height: 530463,  heading: 0, pitch: -40 },
  arr:  { lon: 141.749, lat: 39.073, height: 230089,  heading: 0, pitch: -35 },
  sat:  { lon: 138.842, lat: 37.661, height: 2824129, heading: 0, pitch: -88 },
  hero: { lon: 137.433, lat: 27.953, height: 523982,  heading: 0, pitch: -30.2 },
};

// 視点は高度25倍のときに合わせて決めたもの。倍率が違うときは、見ている地点（画面の中心の地面）を変えずに、
// 高く・遠くから見るように直す（100倍では約3倍の高さ）
// 「高度強調」の視点：誇張した経路全体が入るように、経路の点から距離を決めて南から斜めに見る
function flyHero() {
  if (ALT_SCALE === 25 || !routePts.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(routePts.map(p => p.cart));
  viewer.camera.flyToBoundingSphere(sphere, { offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-28), sphere.radius * 2.3), duration: 2.5 });
  return true;
}
function presetView(p) {
  if (ALT_SCALE === 1 || ALT_SCALE === 25 || p.pitch <= -80) return p;
  const k = (ALT_SCALE / 25) ** 0.8, t = Math.tan(Math.abs(p.pitch) * Math.PI / 180);
  const targetLat = p.lat + p.height / t / 111000;            // 南から北を見ている（heading 0）
  const h = p.height * k;
  return { ...p, height: h, lat: targetLat - h / t / 111000 };
}
// ---- 向きのボタン：今見ている所（画面の中心の地面）を中心に、真上・東西南北・南東斜めから見る ----
//   距離は今の距離をおおむね保つ。横から見るときは、誇張した高さ（最大で約1,000km）が入るよう少し見下ろす
{
  const VIEWS = { top: [0, -90], n: [180, -12], e: [270, -12], w: [90, -12], s: [0, -12], se: [315, -35] };
  document.querySelectorAll('#camButtons button[data-view]').forEach(btn => btn.onclick = () => {
    const [h, p] = VIEWS[btn.dataset.view];
    const cv = viewer.canvas, cam = viewer.camera;
    let target = cam.pickEllipsoid(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2));
    if (!target) target = Cesium.Cartesian3.fromDegrees(137, 36);            // 地球の外を見ているときは日本の中心
    const c = Cesium.Cartographic.fromCartesian(target);
    const center = Cesium.Cartesian3.fromDegrees(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude),
      p > -80 && ALT_SCALE > 1 ? 300000 : 0);                                 // 横から見るときは、立体の真ん中あたりを見る
    const dist = Cesium.Cartesian3.distance(cam.positionWC, target);
    const range = Math.min(9e6, Math.max(p > -80 ? 1.5e6 : 4e5, dist));
    cam.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(h), Cesium.Math.toRadians(p), range), duration: 1.5 });
  });
}
document.querySelectorAll('#camButtons button[data-cam]').forEach(btn => {
  btn.onclick = () => {
    // リアルタイム表示中の「全体」は日本全体を真上から
    if (btn.dataset.cam === 'all' && !CASE_MODE) { viewer.camera.flyTo({ destination: JAPAN_RECT, duration: 2.0 }); return; }
    if (btn.dataset.cam === 'hero' && flyHero()) return;
    const p = presetView(camPresets[btn.dataset.cam]);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      orientation: {
        heading: Cesium.Math.toRadians(p.heading ?? 0),
        pitch: Cesium.Math.toRadians(p.pitch),
      },
      duration: 2.5,
    });
  };
});

// ---- ひまわり衛星画像オーバーレイ（雲頂強調） ----
let himawariLayer = null;

async function loadHimawari() {
  // 1. 利用可能な時刻一覧を取得し、最新時刻を使う
  const res = await fetch(
    'https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json'
  );
  const times = await res.json();
  const latest = times[times.length - 1];  // 配列の最後が最新

  // 2. タイルレイヤとして地球に貼る（SND/ETC = 雲頂強調画像）。雲のない黒い所は透明にして、地形が見えるようにする
  const provider = new CloudOnlyImageryProvider({
    url: `https://www.jma.go.jp/bosai/himawari/data/satimg/${latest.basetime}/fd/${latest.validtime}/SND/ETC/{z}/{x}/{y}.jpg`,
    maximumLevel: 5,            // 全球（fd）は z5 まで。z6 を読むと 404 で穴が開く
    credit: new Cesium.Credit('雲画像：気象庁'),
    cloud: CLOUD_ONLY.snd,
  });

  himawariLayer = viewer.imageryLayers.addImageryProvider(provider);
  himawariLayer.alpha = 0.9;   // 透明度（0〜1）。雲以外は透明なので濃いめでよい
}

// ON/OFF切替
document.getElementById('himawariBtn').onclick = async () => {
  if (himawariLayer) {
    himawariLayer.show = !himawariLayer.show;
  } else {
    await loadHimawari();
  }
};
// ---- ひまわり雲頂強調画像の立体表示（レリーフ方式） ----
function tile2lon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

let satPrimitive = null;

async function loadHimawari3D() {
  const Z = 5, XS = [27, 28, 29], YS = [11, 12, 13], SIZE = 256;

  // --- 9枚のタイルを1枚のキャンバスに合成 ---
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * XS.length;
  canvas.height = SIZE * YS.length;
  const ctx = canvas.getContext('2d');

  await Promise.all(XS.flatMap((x, i) =>
    YS.map((y, j) => new Promise((ok, ng) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, i * SIZE, j * SIZE); ok(); };
      img.onerror = ng;
      img.src = `./data/himawari/${Z}_${x}_${y}.jpg`;
    }))
  ));

  const pix = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  // --- 格子メッシュを作る（明るさ→高さ） ---
  const GRID = 180;            // 格子の細かさ（一辺の分割数）
  const BASE_H = 2000;         // 雲底の目安高度[m]
  const TOP_H = 16000;         // 最も白い雲の雲頂高度[m]
  const THRESHOLD = 110;       // この明るさ以下は「雲なし」とみなす

  const nx = GRID + 1, ny = GRID + 1;

  // --- 1. まず高さだけを配列に計算 ---
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = i / GRID, v = j / GRID;
      const px = Math.min(canvas.width - 1, Math.round(u * canvas.width));
      const py = Math.min(canvas.height - 1, Math.round(v * canvas.height));
      const k = (py * canvas.width + px) * 4;
      const bright = (pix[k] + pix[k + 1] + pix[k + 2]) / 3;
      const t = Math.max(0, (bright - THRESHOLD) / (255 - THRESHOLD));
      heights[j * nx + i] = BASE_H + t * (TOP_H - BASE_H);
    }
  }

  // --- 2. 平滑化（近傍3x3の平均を数回かける） ---
  const SMOOTH_PASSES = 2;   // 丸みの強さ（回数を増やすほどなだらか）
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const src = heights.slice();
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            sum += src[(j + dj) * nx + (i + di)];
          }
        }
        heights[j * nx + i] = sum / 9;
      }
    }
  }

  // --- 3. 頂点座標に変換 ---
  const positions = new Float64Array(nx * ny * 3);
  const sts = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = i / GRID, v = j / GRID;
      const lon = tile2lon(XS[0] + u * XS.length, Z);
      const lat = tile2lat(YS[0] + v * YS.length, Z);
      const c = Cesium.Cartesian3.fromDegrees(lon, lat, AZ(heights[j * nx + i]));
      const idx = j * nx + i;
      positions[idx * 3] = c.x;
      positions[idx * 3 + 1] = c.y;
      positions[idx * 3 + 2] = c.z;
      sts[idx * 2] = u;
      sts[idx * 2 + 1] = 1.0 - v;
    }
  }

  // 三角形のインデックス
  const indices = new Uint32Array(GRID * GRID * 6);
  let p = 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * nx + i, b = a + 1, c2 = a + nx, d = c2 + 1;
      indices[p++] = a; indices[p++] = c2; indices[p++] = b;
      indices[p++] = b; indices[p++] = c2; indices[p++] = d;
    }
  }

  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: sts,
      }),
    },
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
  });

  // 暗い部分を透明にするマテリアル（雲だけが残る）
  const material = new Cesium.Material({
    fabric: {
      uniforms: { image: canvas.toDataURL('image/png') },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec4 c = texture(image, materialInput.st);
          float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          m.diffuse = c.rgb;
          m.emission = c.rgb * 0.35;
          m.alpha = smoothstep(0.40, 0.60, lum) * 0.95;
          return m;
        }`,
    },
  });

  satPrimitive = viewer.scene.primitives.add(new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({
      material,
      flat: true,
      translucent: true,
    }),
    asynchronous: false,
  }));
}

// 表示切替ボタン（前回と同じ）
document.getElementById('sat3dBtn').onclick = () => {
  if (satPrimitive) {
    satPrimitive.show = !satPrimitive.show;
  } else {
    loadHimawari3D();
  }
};
// ---- 飛行経路の垂直断面図 ----
const EXAG = 25;  // ★高度の誇張倍率（10倍）。見づらければ 15〜25 に

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * d) / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) *
    Math.sin(((lon2 - lon1) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inPoly(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function drawProfile() {
  const [flight, clouds, turb, jet] = await Promise.all([
    fetch('./data/flight_route.json').then(r => r.json()),
    fetch('./data/clouds.geojson').then(r => r.json()),
    fetch('./data/turbulence.json').then(r => r.json()),
    fetch('./data/jetstream.geojson').then(r => r.json()),
  ]);

  // --- 経路を約10km間隔でサンプリング ---
  const R = flight.route, samples = [];
  let cum = 0;
  for (let i = 0; i < R.length - 1; i++) {
    const a = R[i], b = R[i + 1];
    const seg = distKm(a.lat, a.lon, b.lat, b.lon);
    const n = Math.max(1, Math.round(seg / 10));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      samples.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        alt: a.alt_m + (b.alt_m - a.alt_m) * t,
        d: cum + seg * t,
      });
    }
    cum += seg;
  }
  const last = R[R.length - 1];
  samples.push({ lat: last.lat, lon: last.lon, alt: last.alt_m, d: cum });

  // --- キャンバス設定（横スケール×EXAG＝縦スケール） ---
  const W = 940, padL = 52, padR = 16, padT = 14, padB = 26;
  const hs = (W - padL - padR) / cum;          // px / km（水平）
  const vs = (hs * EXAG) / 1000;               // px / m（垂直）
  const MAXALT = 14000;
  const H = padT + padB + MAXALT * vs;

  const cv = document.getElementById('profileCanvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const X = d => padL + d * hs;
  const Y = a => H - padB - a * vs;

  ctx.clearRect(0, 0, W, H);

  // --- FLグリッド線 ---
  ctx.font = '10px sans-serif';
  for (const fl of [50, 100, 180, 300, 340, 390]) {
    const alt = fl * 30.48;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(padL, Y(alt)); ctx.lineTo(W - padR, Y(alt)); ctx.stroke();
    ctx.fillStyle = '#9fb3c8';
    ctx.fillText('FL' + String(fl).padStart(3, '0'), 8, Y(alt) + 3);
  }

  // --- 雲域（経路がポリゴン内を通る区間に、雲底〜雲頂の帯） ---
  for (const f of clouds.features) {
    const ring = f.geometry.coordinates[0];
    const base = f.properties.base_m, top = f.properties.top_m;
    ctx.fillStyle = 'rgba(176,196,222,0.45)';
    let s0 = null;
    for (let i = 0; i <= samples.length; i++) {
      const inside = i < samples.length && inPoly(samples[i].lon, samples[i].lat, ring);
      if (inside && s0 === null) s0 = samples[i].d;
      if (!inside && s0 !== null) {
        const s1 = samples[i - 1].d;
        ctx.fillRect(X(s0), Y(top), X(s1) - X(s0), Y(base) - Y(top));
        s0 = null;
      }
    }
  }

  // --- 乱気流域（中心距離が半径内の区間に、高度帯の帯） ---
  for (const a of turb.areas) {
    const rKm = Math.min(a.radius_x_m, a.radius_y_m) / 1000;
    ctx.fillStyle = 'rgba(255,167,38,0.5)';
    let s0 = null;
    for (let i = 0; i <= samples.length; i++) {
      const hit = i < samples.length &&
        distKm(samples[i].lat, samples[i].lon, a.lat, a.lon) < rKm;
      if (hit && s0 === null) s0 = samples[i].d;
      if (!hit && s0 !== null) {
        const s1 = samples[i - 1].d;
        ctx.fillRect(X(s0), Y(a.alt_top_m), X(s1) - X(s0), Y(a.alt_bottom_m) - Y(a.alt_top_m));
        s0 = null;
      }
    }
  }

  // --- ジェット気流（軸から60km以内を横切る区間） ---
  for (const f of jet.features) {
    const alt = f.properties.alt_m;
    const pts = [];
    const cs = f.geometry.coordinates;
    for (let i = 0; i < cs.length - 1; i++) {
      for (let t = 0; t < 1; t += 0.1) {
        pts.push([cs[i][0] + (cs[i + 1][0] - cs[i][0]) * t,
                  cs[i][1] + (cs[i + 1][1] - cs[i][1]) * t]);
      }
    }
    ctx.fillStyle = 'rgba(149,117,205,0.55)';
    let s0 = null;
    for (let i = 0; i <= samples.length; i++) {
      const hit = i < samples.length &&
        pts.some(p => distKm(samples[i].lat, samples[i].lon, p[1], p[0]) < 60);
      if (hit && s0 === null) s0 = samples[i].d;
      if (!hit && s0 !== null) {
        const s1 = samples[i - 1].d;
        ctx.fillRect(X(s0), Y(alt + 600), X(s1) - X(s0), Y(alt - 600) - Y(alt + 600));
        s0 = null;
      }
    }
  }

  // --- 地面と飛行経路 ---
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(W - padR, Y(0)); ctx.stroke();

  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  samples.forEach((s, i) => i ? ctx.lineTo(X(s.d), Y(s.alt)) : ctx.moveTo(X(s.d), Y(s.alt)));
  ctx.stroke();
  ctx.lineWidth = 1;

  // --- 空港ラベル ---
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
  ctx.fillText('RJBB', padL - 14, Y(0) + 14);
  ctx.fillText('RJCC', W - padR - 30, Y(0) + 14);

  document.getElementById('profileCap').textContent =
    `RJBB → RJCC 垂直断面（総距離 約${Math.round(cum)}km／高度${EXAG}倍誇張）　` +
    `青帯:雲域　橙帯:乱気流　紫帯:ジェット気流`;
}

document.getElementById('profileBtn').onclick = () => {
  const p = document.getElementById('profilePanel');
  if (p.style.display === 'block') { p.style.display = 'none'; }
  else { p.style.display = 'block'; drawProfile(); }
};
// ---- 高度誇張の切替 ----
async function reloadAll() {
  fbjpItems = [];
  flRingItems = [];
  upperItems = [];
  
  viewer.entities.removeAll();
  viewer.dataSources.removeAll();
  if (satPrimitive) { viewer.scene.primitives.remove(satPrimitive); satPrimitive = null; }
  if (!CASE_MODE) { clearSurfaces(); return; }

  await Promise.all([
    loadFlightRoute(),
    loadAirports(),
    loadWeather(),
    loadUpperAir(),
    loadComments(),
  ]);
  loadFlRings();
  loadUpperLevels();
  buildSurfaces();
}


// 高度ボタン（実寸／×25／×50／×75／×100）の表示を今の倍率に合わせる
function syncExagButtons() {
  document.querySelectorAll('#exagGroup button[data-exag]').forEach(b =>
    b.classList.toggle('on', +b.dataset.exag === ALT_SCALE));
}
// 高度の倍率を切り替える（1 = 実寸、25/50/75/100 = 誇張）。経路アドバイスや事例表示からも呼ばれる
async function setExag(scale) {
  if (scale > 1) { ALT_EXAG = scale; window.AW_EXAG = scale; }   // 選んだ倍率を覚えておく
  if (scale === ALT_SCALE) { syncExagButtons(); return; }
  ALT_SCALE = scale;
  syncExagButtons();
  window.dispatchEvent(new Event('aw:altscale'));   // 雲頂3D などが高さを合わせ直す
  advisorReady.then(a => a?.setAltScale(ALT_SCALE));

  // ひまわりレリーフが表示中だったら、作り直すために一旦破棄
  const satWasOn = satPrimitive && satPrimitive.show !== false;
  if (satPrimitive) {
    viewer.scene.primitives.remove(satPrimitive);
    satPrimitive = null;
  }

  await reloadAll();

  // 表示中だった場合は新しい倍率で再生成
  if (satWasOn) await loadHimawari3D();

}
// 高度ボタンを作る：［実寸］［×25］［×50］［×75］［×100］。押した倍率にする（面の作り直しは reloadAll の中で行う）
{
  const g = document.getElementById('exagGroup');
  for (const s of [1, ...EXAG_CHOICES]) {
    const b = Object.assign(document.createElement('button'), {
      textContent: s === 1 ? '実寸' : `×${s}`,
      title: s === 1 ? '高度を実寸（1倍）で表示' : `高度を${s}倍に強調して表示`,
    });
    b.dataset.exag = s;
    b.onclick = () => setExag(s);
    g.appendChild(b);
  }
  syncExagButtons();
}
window.awSetExag = setExag;
window.awGetAltScale = () => ALT_SCALE;   // 経路アドバイス（advisor.js）から高度を誇張するため
// 標高2,000m以上の山を、高度の倍率に合わせて立体表示（誇張表示のときだけ）
const mountains = createMountains3D(viewer, { getScale: () => ALT_SCALE });
// 「山を強調」ボタン（右下）：高い山を高度の倍率で立体表示する／しない
//   実寸（1倍）のときに押したら、山の強調を ON にして、最後に選んだ倍率（初期値25倍）にする（実寸では山を持ち上げないため）
{
  const b = document.getElementById('mountainBtn');
  const label = () => {
    const on = mountains.enabled && ALT_SCALE > 1;
    b.textContent = mountains.loading ? '⛰ 山を読み込み中…' : mountains.error ? '⛰ 山を表示できません' : on ? '⛰ 山の強調ON' : '⛰ 山を強調';
    b.title = mountains.error || '標高2,000m以上の山を、高度の倍率に合わせて立体表示';
    b.classList.toggle('on', on);
  };
  b.onclick = async () => {
    if (ALT_SCALE === 1) { await mountains.setEnabled(true); await setExag(ALT_EXAG); }
    else await mountains.setEnabled(!mountains.enabled);
    label();
  };
  window.addEventListener('aw:altscale', () => setTimeout(label, 0));
  window.addEventListener('aw:mountains', label);
  label();
}
// 右下の「天気図」ボタン：右の天気図一覧の図をクリックしたのと同じ（地図に表示＋自動解析）。もう一度押すと消す
{
  const SHORT = { sfc: '地上', sfc24: '地上24h', aupq78: 'AUPQ78', aupq35: 'AUPQ35', aupa25: 'AUPA25', aupa20: 'AUPA20',
    fxfe502: 'FXFE502', fxfe5782: 'FXFE5782', fxjp854: 'FXJP854', fupa252: 'FUPA252', fupa302: 'FUPA302', fupa502: 'FUPA502',
    axjp: 'AXJP', fxjp: 'FXJP', typhoon: '台風', fbjp: 'FBJP', vis: '可視', ir: '赤外', radar: 'レーダー', radarIntl: '海外レーダー' };
  const box = document.getElementById('chartBtns');
  // レーダー・海外レーダーは「地図に重ねる」で出し入れする（2つを同時に表示できる。2026-10-18）
  const OVL = new Set(['radar', 'radarIntl']);
  const sync = () => box.querySelectorAll('[data-chart]').forEach(b => b.classList.toggle('on', window.awCharts?.selected === b.dataset.chart || (OVL.has(b.dataset.chart) && !!window.awCharts?.overlayOn?.(b.dataset.chart))));
  const build = () => {
    if (!window.awCharts || box.dataset.built) return;
    box.dataset.built = '1';
    box.innerHTML = window.awCharts.list.map(c => `<button data-chart="${c.id}" title="${c.title}">${SHORT[c.id] || c.id}</button>`).join('');
    box.querySelectorAll('[data-chart]').forEach(b => b.onclick = () => (OVL.has(b.dataset.chart) && window.awCharts.overlay ? window.awCharts.overlay(b.dataset.chart) : window.awCharts.toggle(b.dataset.chart)));
    sync();
  };
  window.addEventListener('aw:charts-ready', build);
  // 右の天気図一覧は、右下のボタン群の上で終わるようにする（ボタン群が隠れないように、高さに合わせて縮める）
  const fit = () => {
    const wx = document.getElementById('awWx'), cam = document.getElementById('camButtons');
    if (wx && cam) wx.style.bottom = Math.max(10, window.innerHeight - cam.getBoundingClientRect().top + 8) + 'px';
  };
  new ResizeObserver(fit).observe(document.getElementById('camButtons'));
  window.addEventListener('resize', fit);
  window.addEventListener('aw:charts-ready', fit);
  window.addEventListener('aw:chartsel', sync);
  build();
}
// ---- カーテン表示切替 ----
document.getElementById('curtainBtn').onclick = () => {
  if (!curtainEntity) return;
  curtainOn = !curtainOn;
  curtainEntity.show = curtainOn;
  document.getElementById('curtainBtn').textContent =
    curtainOn ? 'カーテンOFF' : 'カーテンON';
};
// ---- 予想図（FBJP）レイヤ切替 ----
document.getElementById('fbjpLayerBtn').onclick = () => {
  // リアルタイム表示中は、最新の国内悪天予想図（FBJP）を 3D で表示する（天気図一覧の FBJP「3Dで表示」と同じ。もう一度押すと消す）
  if (!CASE_MODE) {
    const fb = document.querySelector('[data-fb3d]');
    if (!fb) { document.getElementById('fbjpLayerBtn').textContent = '悪天予想図（読み込み中）'; return; }
    fb.click();
    return;
  }
  fbjpOn = !fbjpOn;
  fbjpItems.forEach(item => { item.show = fbjpOn; });
  document.getElementById('fbjpLayerBtn').textContent =
    fbjpOn ? '国内悪天 3D 消す' : '国内悪天 3D';
};

// 右下の「悪天予想図ON/OFF」の表示を、FBJP の 3D 表示の状態に合わせる
document.addEventListener('click', e => {
  if (CASE_MODE || !e.target.closest?.('[data-fb3d], #fbjpLayerBtn')) return;
  setTimeout(() => {
    const on = document.querySelector('[data-fb3d]')?.getAttribute('aria-pressed') === 'true';
    document.getElementById('fbjpLayerBtn').textContent = on ? '国内悪天 3D 消す' : '国内悪天 3D';
  }, 0);
});

// ---- ホバー表示（経路の高度＋高層解析の数値） ----
const altTip = document.getElementById('altTip');
const phaseJp = { departure: '出発', climb: '上昇', cruise: '巡航', descent: '降下', arrival: '到着' };

const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
hoverHandler.setInputAction((movement) => {
  const mouse = movement.endPosition;
  const toWin = Cesium.SceneTransforms.worldToWindowCoordinates
    ? Cesium.SceneTransforms.worldToWindowCoordinates.bind(Cesium.SceneTransforms)
    : Cesium.SceneTransforms.wgs84ToWindowCoordinates.bind(Cesium.SceneTransforms);

  let bestText = null, bestDist = 12;

  for (const p of routePts) {
    const win = toWin(viewer.scene, p.cart);
    if (!win) continue;
    const d = Math.hypot(win.x - mouse.x, win.y - mouse.y);
    if (d < bestDist) {
      bestDist = d;
      const fl = Math.round((p.alt_m * 3.28084) / 100);
      bestText = `FL${String(fl).padStart(3, '0')}（${p.alt_m.toLocaleString()}m）${phaseJp[p.phase] ?? ''}`;
    }
  }

{
    for (const p of upperHoverPts) {
      const key = (p.fl === 340 || p.fl === 390) ? 300 : p.fl;
      if (levelOn[key] !== true) continue;
      const win = toWin(viewer.scene, p.cart);
      if (!win) continue;
      const d = Math.hypot(win.x - mouse.x, win.y - mouse.y);
      if (d < bestDist) { bestDist = d; bestText = p.text; }
    }
  }

  if (bestText) {
    altTip.textContent = bestText;
    altTip.style.left = (mouse.x + 14) + 'px';
    altTip.style.top = (mouse.y + 14) + 'px';
    altTip.style.display = 'block';
  } else {
    altTip.style.display = 'none';
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// ================= 等圧面のうねり曲面（高度/気温/風速・最終版） =================
let surfacePrimitives = [];
let surfaceMode = 'off';
let surfaceHoverPts = [];
let surfaceData = null;

function bilinear(grid, lats, lons, lat, lon) {
  let i = 0, j = 0;
  while (j < lons.length - 2 && lons[j + 1] < lon) j++;
  while (i < lats.length - 2 && lats[i + 1] < lat) i++;
  const tx = (lon - lons[j]) / (lons[j + 1] - lons[j]);
  const ty = (lat - lats[i]) / (lats[i + 1] - lats[i]);
  return grid[i][j] * (1 - tx) * (1 - ty) + grid[i][j + 1] * tx * (1 - ty)
       + grid[i + 1][j] * (1 - tx) * ty + grid[i + 1][j + 1] * tx * ty;
}

// 値→色（モード別カラースケール）
function surfaceColor(mode, v, vmin, vmax) {
  
  const u = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
  const lerp = (a, b, k) => a.map((x, i) => Math.round(x + (b[i] - x) * k));

  if (mode === 'temp') {
    // 紫→青→緑→黄→赤（レインボー）
    const stops = [
      [120, 60, 180], [40, 90, 235], [60, 190, 120], [235, 210, 60], [230, 60, 50]
    ];
    const seg = Math.min(3, Math.floor(u * 4));
    return lerp(stops[seg], stops[seg + 1], u * 4 - seg);
  }

  if (mode === 'wind') {
    // ほぼ無色→緑→黄→赤→紫（強風だけ浮かぶ）
    const stops = [
      [235, 235, 235], [110, 200, 110], [235, 210, 60], [230, 70, 50], [150, 40, 180]
    ];
    const seg = Math.min(3, Math.floor(u * 4));
    return lerp(stops[seg], stops[seg + 1], u * 4 - seg);
  }

  // 高度：青→白→赤
  if (u < 0.5) { const k = u / 0.5; return lerp([33, 150, 243], [255, 255, 255], k); }
  return lerp([255, 255, 255], [239, 83, 80], (u - 0.5) / 0.5);
}

function clearSurfaces() {
  surfacePrimitives.forEach(pr => viewer.scene.primitives.remove(pr));
  surfacePrimitives = [];
  surfaceHoverPts = [];
}

let buildSeq = 0;   // ←関数の直前に追加（let surfaceData = null; の下の行でOK）

async function buildSurfaces() {
  const my = ++buildSeq;          // この呼び出しの番号
  clearSurfaces();
  if (surfaceMode === 'off' || !CASE_MODE) return;

  if (!surfaceData) {
    const res = await fetch('./data/upper_surfaces.json');
    surfaceData = await res.json();
  }
  if (my !== buildSeq) return;    // ★自分より新しい呼び出しが始まっていたら、何も作らず終了
  const data = surfaceData;
  const scale = ALT_SCALE;
  
  const WAVE_EXAG = scale === 1 ? 40 : 1000;
  const N = 48, TEX = 128;
  console.log(`buildSurfaces: mode=${surfaceMode} scale=${scale} exag=${WAVE_EXAG}`);

  const lonMin = data.lons[0], lonMax = data.lons[data.lons.length - 1];
  const latMin = data.lats[0], latMax = data.lats[data.lats.length - 1];

  for (const lv of data.levels) {
    if (levelOn[lv.fl] !== true) continue;
    const flAlt = lv.fl * 30.48;
    // 各緯度行の平均（＝南北の傾き成分）を先に計算
    const rowMean = lv.grid.map(row => row.reduce((s, v) => s + v, 0) / row.length);
    const meanAt = lat => bilinear(rowMean.map(m => [m, m]), data.lats, [0, 1], lat, 0.5);
    const SLOPE_EXAG = scale === 1 ? 15 : 150;    // 傾きは控えめに
    const WAVE_EXAG2 = scale === 1 ? 60 : 4000;   // 波（偏差）を大きく強調
    const cGrid = surfaceMode === 'temp' ? lv.temp
                : surfaceMode === 'wind' ? lv.wind
                : lv.grid;
    const flat = cGrid.flat();
    const vmin = Math.min(...flat), vmax = Math.max(...flat);

    const cv = document.createElement('canvas');
    cv.width = TEX; cv.height = TEX;
    const ctx = cv.getContext('2d');
    const im = ctx.createImageData(TEX, TEX);
    for (let py = 0; py < TEX; py++) {
      for (let px = 0; px < TEX; px++) {
        const lon = lonMin + (lonMax - lonMin) * px / (TEX - 1);
        const lat = latMin + (latMax - latMin) * (py / (TEX - 1));
        const v = bilinear(cGrid, data.lats, data.lons, lat, lon);
        const [r, g, b] = surfaceColor(surfaceMode, v, vmin, vmax);
        const k = (py * TEX + px) * 4;
        im.data[k] = r; im.data[k + 1] = g; im.data[k + 2] = b;
        const u01 = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
        im.data[k + 3] = surfaceMode === 'wind'
          ? Math.round(40 + u01 * 200)
          : 185;
      }
    }
    ctx.putImageData(im, 0, 0);

    const nx = N + 1, ny = N + 1;
    const positions = new Float64Array(nx * ny * 3);
    const sts = new Float32Array(nx * ny * 2);
    for (let jj = 0; jj < ny; jj++) {
      for (let ii = 0; ii < nx; ii++) {
        const lon = lonMin + (lonMax - lonMin) * ii / N;
        const lat = latMin + (latMax - latMin) * jj / N;
        const h = bilinear(lv.grid, data.lats, data.lons, lat, lon);
        const m = meanAt(lat);
        const alt = flAlt * scale + (m - lv.ref) * SLOPE_EXAG + (h - m) * WAVE_EXAG2;
        const c = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
        const idx = jj * nx + ii;
        positions[idx * 3] = c.x;
        positions[idx * 3 + 1] = c.y;
        positions[idx * 3 + 2] = c.z;
        sts[idx * 2] = ii / N;
        sts[idx * 2 + 1] = jj / N;
      }
    }

    const indices = new Uint32Array(N * N * 6);
    let p = 0;
    for (let jj = 0; jj < N; jj++) {
      for (let ii = 0; ii < N; ii++) {
        const a = jj * nx + ii, b = a + 1, c2 = a + nx, d = c2 + 1;
        indices[p++] = a; indices[p++] = c2; indices[p++] = b;
        indices[p++] = b; indices[p++] = c2; indices[p++] = d;
      }
    }

    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3, values: positions }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2, values: sts }),
      },
      indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
    });

    const prim = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: new Cesium.MaterialAppearance({
        material: new Cesium.Material({
          fabric: { type: 'Image', uniforms: { image: cv.toDataURL('image/png') } } }),
        flat: true, translucent: true,
      }),
      asynchronous: false,
    }));
    surfacePrimitives.push(prim);

    for (let i = 0; i < data.lats.length; i++) {
      for (let j = 0; j < data.lons.length; j++) {
        const h = lv.grid[i][j];
        surfaceHoverPts.push({
          cart: Cesium.Cartesian3.fromDegrees(data.lons[j], data.lats[i],
            flAlt * scale + (h - lv.ref) * WAVE_EXAG),
          text: `${lv.level}：高度 ${h.toLocaleString()}m／気温 ${lv.temp[i][j]}℃／風速 ${lv.wind[i][j]}kt`,
        });
      }
    }
  }
}

function setSurfaceMode(mode) {
  surfaceMode = (surfaceMode === mode) ? 'off' : mode;
  buildSurfaces();
const b1 = document.getElementById('surfHeightBtn');
  if (b1) b1.textContent = surfaceMode === 'height' ? '面:高度 表示中' : '面:高度';
  const b2 = document.getElementById('surfTempBtn');
  if (b2) b2.textContent = surfaceMode === 'temp' ? '面:気温 表示中' : '面:気温';
  const b3 = document.getElementById('surfWindBtn');
  if (b3) b3.textContent = surfaceMode === 'wind' ? '面:風速 表示中' : '面:風速';
}
const _sh = document.getElementById('surfHeightBtn');
if (_sh) _sh.onclick = () => setSurfaceMode('height');
const _st = document.getElementById('surfTempBtn');
if (_st) _st.onclick = () => setSurfaceMode('temp');
const _sw = document.getElementById('surfWindBtn');
if (_sw) _sw.onclick = () => setSurfaceMode('wind');

// 面ボタンの後で作り直す（自己完結のフック）。高度ボタンは reloadAll の中で作り直すので不要
['chart850Btn','chart700Btn','chart500Btn','chart300Btn'].forEach(id => {
  const el = document.getElementById(id);
  const orig = el.onclick;
  el.onclick = async (e) => { await orig?.(e); buildSurfaces(); };
});
// ================= うねり曲面ここまで =================








// ================= 事例表示の切り替え（初期画面はリアルタイム） =================
// 事例専用のボタンは、事例表示中だけ使えるようにする
const CASE_ONLY = ['[data-cam="dep"]', '[data-cam="turb"]', '[data-cam="arr"]', '[data-cam="hero"]',
  '#sat3dBtn', '#chart850Btn', '#chart700Btn', '#chart500Btn', '#chart300Btn', '#profileBtn', '#curtainBtn', '#flRingBtn'];
function applyCaseUi() {
  CASE_ONLY.forEach(sel => document.querySelectorAll(sel).forEach(b => {
    b.disabled = !CASE_MODE; b.style.opacity = CASE_MODE ? '' : '0.35';
    b.title = CASE_MODE ? '' : '事例表示中に使えます';
  }));
  const lg = document.getElementById('legend');
  if (lg) lg.style.display = CASE_MODE ? '' : 'none';
  const sub = document.querySelector('#titleBar .sub');
  if (sub) sub.textContent = (CASE_MODE ? '事例：2026-07-06 関西→新千歳 ／ ' : 'リアルタイム表示 ／ ') + '教育用プロトタイプ — 実運航の判断には使用できません';
  const cb = document.getElementById('caseBtn');
  if (cb) cb.textContent = CASE_MODE ? '事例を閉じる' : '事例 7/6 KIX→CTS';
  // 事例とリアルタイムで悪天予想図の表示方法が違うので、切り替え時はいったん閉じる
  Object.assign(document.getElementById('fbjpPanel').style, { display: 'none', left: '', top: '', transform: '' });
  document.querySelector('#fbjpPanel .cap').textContent = '国内悪天予想図（FBJP） 出典：気象庁';
  fbjpOn = false;
  document.getElementById('fbjpLayerBtn').textContent = '国内悪天 3D';
}
{
  const row = document.getElementById('profileBtn').parentElement;
  const b = Object.assign(document.createElement('button'), { id: 'caseBtn' });
  // 事例 7/6 KIX→CTS のボタンは画面に出さない（2026-10-13）。処理は残す
  // row.appendChild(b);
  b.onclick = async () => {
    CASE_MODE = !CASE_MODE;
    applyCaseUi();
    // 事例の経路は高度を誇張した立体で見せる（すでに誇張中なら読み直すだけ）
    if (CASE_MODE && ALT_SCALE === 1) await setExag(ALT_EXAG); else await reloadAll();
    if (CASE_MODE) {                       // 「高度強調」の視点（斜め上から）で経路を見せる
      const p = presetView(camPresets.hero);
      if (!flyHero()) viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
        orientation: { heading: Cesium.Math.toRadians(p.heading), pitch: Cesium.Math.toRadians(p.pitch) }, duration: 2.5 });
    }
    if (!CASE_MODE) {
      document.getElementById('profilePanel').style.display = 'none';
      viewer.camera.flyTo({ destination: JAPAN_RECT, duration: 2.0 });
    }
  };
  applyCaseUi();
}
