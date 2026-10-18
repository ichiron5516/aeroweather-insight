// 空港パネルの「SID・STAR・APPROACH」タブ
//   一覧から手順を選ぶと地図に描き、パネルに区間表（パスターミネータ・方位・距離・高度/速度制限）を出す。
//   ・同時にいくつでも表示できる（もう一度押すと消える）。空港を切り替えたとき・パネルを閉じたときに消す
//   ・RNAV 手順は AIP のコーディングテーブル（runwayLegs）どおり、従来型（VOR/DME 基準）は文章から拾った概略経路を点線で描く
//   ・APPROACH は空港DBの approaches（AD2.24 の進入方式チャートから抽出）。IAF→IF→FAF→滑走路と、進入復行の待機点（MAHF）を結ぶ概略
//   地図の線は CustomDataSource に入れる（main.js が dataSources.removeAll しても付け直す）
import * as Cesium from 'cesium';
import { loadNavDb } from './dbLoader.js';
import { createAeroNav } from './advisor/aeroNavCore.js';

const NAV_URL = `${(import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/')}data/nav/nav_db.json`;
const PALETTE = ['#ffd54f', '#4fc3f7', '#f48fb1', '#aed581', '#ffab91', '#b39ddb', '#80deea', '#fff59d'];
const TYPE_KEY = { SID: 'sids', STAR: 'stars', APPROACH: 'approaches' };
const PT_JA = { IF: '開始点', TF: '直線', DF: '直行', CF: 'コース', VA: '方位で上昇', CA: 'コースで上昇', VM: '方位（レーダー誘導）',
  FM: '地点からコース', RF: '円弧', VI: '方位で会合', CI: 'コースで会合', HM: '待機', HA: '待機', HF: '待機' };

export const PROC_CSS = `
#awApt .tabs{display:flex;gap:3px;margin:10px 0 6px;border-bottom:1px solid #2c4258}
#awApt .tabs button{background:none;border:1px solid transparent;border-bottom:none;color:#9fb3c8;font:600 12px "Meiryo",sans-serif;padding:5px 10px;cursor:pointer;border-radius:5px 5px 0 0}
#awApt .tabs button.on{background:#1e3a5f;color:#fff;border-color:#2c4258}
#awApt .tabs button .n{font-weight:400;font-size:10.5px;color:#8fd0ff;margin-left:3px}
#awApt .pbar{display:flex;gap:6px;align-items:center;margin:4px 0 6px;font-size:12px}
#awApt .pbar select{background:#0f1b29;color:#fff;border:1px solid #2c4258;border-radius:4px;font:12px "Meiryo",sans-serif;padding:2px 4px}
#awApt .pbar button{background:#0f1b29;color:#cfe3f5;border:1px solid #2c4258;border-radius:4px;font:11.5px "Meiryo",sans-serif;padding:2px 8px;cursor:pointer}
#awApt .plist{max-height:230px;overflow:auto;border:1px solid #2c4258;border-radius:5px;padding:3px}
#awApt .pi{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:4px;cursor:pointer;font-size:12px}
#awApt .pi:hover{background:#1b2d42}
#awApt .pi.on{background:#1e3a5f}
#awApt .pi .sw{width:10px;height:10px;border-radius:2px;border:1px solid #556;flex:none}
#awApt .pi .rw{margin-left:auto;color:#9fb3c8;font-size:10.5px;white-space:nowrap}
#awApt .pi .tg{font-size:10px;border-radius:6px;padding:0 5px;background:#26415c;color:#cfe3f5}
#awApt .pi.tr{padding-left:22px;font-size:11.5px;color:#cfe3f5}
#awApt .pdet{margin-top:8px;font-size:12px}
#awApt .pdet .ds{color:#cfd8dc;font-size:11.5px;background:rgba(0,0,0,.3);padding:5px 7px;border-radius:4px;margin:4px 0}
#awApt .pdet table{border-collapse:collapse;width:100%;font-size:11.5px}
#awApt .pdet th,#awApt .pdet td{border-bottom:1px solid #2c4258;padding:2px 4px;text-align:left;white-space:nowrap}
#awApt .pdet th{color:#8fd0ff;font-weight:600}
#awApt .empty{color:#9fb3c8;font-size:12px;padding:8px 4px;line-height:1.7}`;

const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ftOrFl = (v, ta) => (v >= (ta || 14000) ? `FL${String(Math.round(v / 100)).padStart(3, '0')}` : `${v}`);
function altText(l, ta) {
  const a = l.alt; if (!a) return '';
  if (a.at != null) return `@${ftOrFl(a.at, ta)}`;
  if (a.min != null && a.max != null) return `${ftOrFl(a.min, ta)}〜${ftOrFl(a.max, ta)}`;
  if (a.min != null) return `≥${ftOrFl(a.min, ta)}`;
  if (a.max != null) return `≤${ftOrFl(a.max, ta)}`;
  return a.raw || '';
}
const spdText = l => (!l.speed ? '' : l.speed.max != null ? `≤${l.speed.max}kt` : l.speed.at != null ? `${l.speed.at}kt` : '');
// 手順の runwayLegs のキー（'34R/34L'、'ALL#2' など）と runways から、使える滑走路の一覧
function procRunways(p, airport) {
  const s = new Set(p.runways || []);
  for (const k of Object.keys(p.runwayLegs || {})) k.split('#')[0].split('/').forEach(r => s.add(r));
  const all = s.has('ALL');
  s.delete('ALL');
  return { list: [...s].filter(r => airport.runways.some(x => x.id === r)), all };
}
function legsFor(p, rwy) {
  const L = p.runwayLegs || {}, keys = Object.keys(L);
  const k = (rwy && keys.find(k => k.split('#')[0].split('/').includes(rwy))) || keys.find(k => k.startsWith('ALL')) || keys[0];
  return k ? { key: k, legs: L[k] } : null;
}

export function createProcedureView(viewer, airportDb) {
  const ds = new Cesium.CustomDataSource('aptProcedures');
  viewer.dataSources.add(ds);
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => viewer.dataSources.add(ds), 0); });

  let nav = null, navLoading = null;
  async function getNav() {
    if (nav) return nav;
    navLoading ||= loadNavDb().catch(() => ({ fixes: {}, airways: {} }))
      .then(navDb => (nav = createAeroNav({ airportDb, navDb })));
    return navLoading;
  }

  const S = { a: null, root: null, tab: 'SID', rwy: '', shown: new Map(), detail: null, colorIx: 0 };

  // ---------- 地図に描く ----------
  // 手順を「線のまとまり（paths）」にする。style: solid（コーディングテーブルどおり）／approx（概略）／final（最終進入）／missed（進入復行）
  function pathsOf(item) {
    const { a } = S, p = item.proc, rw = item.rwy;
    const thr = id => { const r = a.runways.find(x => x.id === id); return r?.threshold ? { id: `${a.icao}-${id}-THR`, ...r.threshold, kind: 'runway' } : null; };
    if (item.type === 'SID' || item.type === 'STAR') {
      const pts = item.type === 'SID' ? nav.sidPoints(a.icao, rw, item.sid, item.transition || null) : nav.starPoints(a.icao, rw, p.name);
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        const u = pts[i - 1], v = pts[i];
        out.push({ pts: [u, v], style: u.approx || v.approx || u.kind === 'runway' || v.kind === 'runway' ? 'approx' : 'solid' });
      }
      return { paths: out, fixes: pts.filter(q => q.kind !== 'runway') };
    }
    // APPROACH：IAF ごとの地点列（routes）→ THR、THR（または MAPt）→ MAHF
    const fx = id => { const f = nav.getFix(id, a.arp); return f ? { ...f, id } : null; };
    const role = {};
    for (const [k, ids] of Object.entries(p.fixes || {})) for (const id of ids) (role[id] ||= []).push(k);
    const end = p.runways[0] !== 'ALL' ? thr(rw) : { id: a.icao, ...a.arp, kind: 'runway' };
    const curved = /\(AR\)/.test(p.name);   // RNP AR は円弧（RF）が多く、直線では形が違う
    const out = [], fixes = new Map();
    const faf = p.fixes?.FAF?.[0];
    for (const r of p.routes || []) {
      const pts = r.map(fx).filter(Boolean);
      pts.forEach(q => fixes.set(q.id, q));
      const fi = pts.findIndex(q => q.id === faf);
      const before = fi >= 0 ? pts.slice(0, fi + 1) : pts;
      if (before.length > 1) out.push({ pts: before, style: curved ? 'approx' : 'solid' });
      const fin = (fi >= 0 ? pts.slice(fi) : pts.slice(-1)).concat(end ? [end] : []);
      if (fin.length > 1) out.push({ pts: fin, style: fi >= 0 && !curved && end?.kind === 'runway' && p.runways[0] !== 'ALL' ? 'final' : 'approx' });
    }
    // 進入復行：MAPt（なければ滑走路）から、進入復行の地点を順に MAHF まで
    const ms = (p.missed || []).map(fx).filter(Boolean);
    const mapt = p.fixes?.MAPt?.[0] && fx(p.fixes.MAPt[0]);
    if (ms.length) { ms.forEach(q => fixes.set(q.id, q)); out.push({ pts: [mapt || end, ...ms].filter(Boolean), style: 'missed' }); }
    const list = [...fixes.values()].map(q => ({ ...q, roles: role[q.id] || [] }));
    return { paths: out, fixes: list };
  }
  function draw(item) {
    const { paths, fixes } = pathsOf(item);
    const col = Cesium.Color.fromCssColorString(item.color);
    const ents = [];
    const ta = S.a.transitionAltitudeFt;
    const MAT = {
      solid: { width: 3.5, m: () => col },
      final: { width: 5, m: () => col },
      approx: { width: 2.5, m: () => new Cesium.PolylineDashMaterialProperty({ color: col.withAlpha(0.85), dashLength: 14 }) },
      missed: { width: 2.5, m: () => new Cesium.PolylineDashMaterialProperty({ color: col.withAlpha(0.7), gapColor: Cesium.Color.TRANSPARENT, dashLength: 6 }) },
    };
    for (const pa of paths) {
      const st = MAT[pa.style];
      ents.push(ds.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(pa.pts.flatMap(q => [q.lon, q.lat])),
        width: st.width, clampToGround: true, material: st.m() } }));
    }
    const fafAlt = item.type === 'APPROACH' ? item.proc.fafAltFt : null;
    for (const p of fixes) {
      const cons = [];
      if (p.roles?.length) cons.push(p.roles.join('/'));
      if (p.altFt != null) cons.push(`@${ftOrFl(p.altFt, ta)}`);
      else if (p.altMinFt != null && p.altMaxFt != null) cons.push(`${ftOrFl(p.altMinFt, ta)}〜${ftOrFl(p.altMaxFt, ta)}`);
      else if (p.altMinFt != null) cons.push(`≥${ftOrFl(p.altMinFt, ta)}`);
      else if (p.altMaxFt != null) cons.push(`≤${ftOrFl(p.altMaxFt, ta)}`);
      if (fafAlt && p.roles?.includes('FAF')) cons.push(`${fafAlt}ft`);
      if (p.speedKt) cons.push(`${p.speedKt}kt`);
      ents.push(ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: 7, color: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: cons.length ? `${p.id}\n${cons.join(' ')}` : p.id, font: '600 12px "Meiryo", sans-serif',
          fillColor: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(9, -4), horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6e5) },
      }));
    }
    // 手順名（SID は最後、STAR・APPROACH は最初の地点の近く）
    const tip = item.type === 'SID' ? fixes.at(-1) : fixes[0];
    if (tip) ents.push(ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(tip.lon, tip.lat),
      label: { text: item.label, font: 'bold 12px "Meiryo", sans-serif', fillColor: Cesium.Color.BLACK,
        showBackground: true, backgroundColor: col.withAlpha(0.9), backgroundPadding: new Cesium.Cartesian2(5, 2),
        pixelOffset: new Cesium.Cartesian2(0, 18), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
    return { ents, pts: paths.flatMap(x => x.pts) };
  }
  function clearAll() {
    ds.entities.removeAll();
    S.shown.clear(); S.detail = null; S.colorIx = 0;
  }
  function flyToShown() {
    const all = [...S.shown.values()].flatMap(x => x.pts);
    if (!all.length) return;
    const lons = all.map(p => p.lon), lats = all.map(p => p.lat), pad = 0.15;
    viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(...lons) - pad, Math.min(...lats) - pad,
      Math.max(...lons) + pad, Math.max(...lats) + pad), duration: 1.5 });
  }

  // ---------- パネル ----------
  function listItems() {
    const a = S.a, key = TYPE_KEY[S.tab], list = a[key] || [];
    const ok = p => { const r = procRunways(p, a); return !S.rwy || r.all || r.list.includes(S.rwy); };
    const items = [];
    for (const p of list.filter(ok)) {
      const r = procRunways(p, a);
      const rwy = S.rwy || r.list[0] || a.runways[0]?.id;
      items.push({ id: `${S.tab}|${p.name}|`, type: S.tab, proc: p, sid: p.name, rwy, label: p.name,
        rwText: r.all ? (S.tab === 'APPROACH' ? '周回進入' : '全滑走路') : r.list.join(' '), tr: false });
      if (S.tab === 'SID') for (const t of (a.sidTransitions || []).filter(t => (t.parents || []).includes(p.name))) {
        items.push({ id: `SID|${p.name}|${t.name}`, type: 'SID', proc: p, trProc: t, sid: p.name, transition: t.name, rwy,
          label: `${p.name.replace(/ DEPARTURE$/, '')} / ${t.name}`, short: t.name, tr: true });
      }
    }
    return items;
  }
  function render() {
    const a = S.a, root = S.root; if (!root) return;
    const tab = S.tab;
    if (tab === 'WX') return;
    const items = listItems();
    const rwOpts = ['', ...a.runways.map(r => r.id)].map(r => `<option value="${r}"${r === S.rwy ? ' selected' : ''}>${r ? 'RWY ' + r : '全滑走路'}</option>`).join('');
    let body;
    if (tab === 'APPROACH' && !(a.approaches || []).length) {
      body = `<div class="empty">この空港の進入方式（IAP）は、空港データベースに入っていません。</div>`;
    } else if (!items.length) {
      body = `<div class="empty">${S.rwy ? `RWY ${S.rwy} で使える` : ''}${tab} はありません。</div>`;
    } else {
      body = `<div class="plist">${items.map(it => {
        const on = S.shown.get(it.id);
        const tag = it.type === 'APPROACH' ? it.proc.kind : it.proc.rnav ? 'RNAV' : '従来型';
        return it.tr
          ? `<div class="pi tr${on ? ' on' : ''}" data-id="${esc(it.id)}"><span class="sw" style="background:${on ? on.color : 'transparent'}"></span>└ ${esc(it.short)}</div>`
          : `<div class="pi${on ? ' on' : ''}" data-id="${esc(it.id)}"><span class="sw" style="background:${on ? on.color : 'transparent'}"></span>${esc(it.proc.name)} <span class="tg">${tag}</span><span class="rw">${esc(it.rwText)}</span></div>`;
      }).join('')}</div>`;
    }
    const d = S.detail && S.shown.get(S.detail);
    root.innerHTML = `
      <div class="pbar">滑走路 <select data-rwy>${rwOpts}</select>
        <button data-fly title="表示中の手順が収まるように地図を動かす">地図で見る</button>
        <button data-clear>すべて消す</button>
        <span style="color:#9fb3c8;font-size:11px">${S.shown.size ? `${S.shown.size}件表示中` : '押すと地図に表示'}</span></div>
      ${body}
      <div class="pdet">${d ? detailHtml(d) : ''}</div>`;
    root.querySelector('[data-rwy]').onchange = e => { S.rwy = e.target.value; render(); };
    root.querySelector('[data-clear]').onclick = () => { clearAll(); render(); };
    root.querySelector('[data-fly]').onclick = flyToShown;
    root.querySelectorAll('.pi').forEach(el => el.onclick = () => toggle(items.find(x => x.id === el.dataset.id)));
  }
  function detailHtml(d) {
    const a = S.a, ta = a.transitionAltitudeFt;
    const parts = [[d.proc, d.rwy]];
    if (d.trProc) parts.push([d.trProc, d.rwy]);
    let html = `<b style="color:${d.color}">${esc(d.label)}</b>　<span style="color:#9fb3c8">${d.proc.runways?.[0] === 'ALL' ? '周回進入' : 'RWY ' + esc(d.rwy)}${d.proc.chartPages ? `・AIP ${d.proc.chartPages.join(',')}頁` : ''}</span>`;
    if (d.type === 'APPROACH') {
      const p = d.proc, F = p.fixes || {};
      const row = (k, ja) => F[k]?.length ? `<tr><th>${k}</th><td>${ja}</td><td>${F[k].map(esc).join('・')}${k === 'FAF' && p.fafAltFt ? `（${p.fafAltFt}ft）` : ''}</td></tr>` : '';
      html += `<table style="margin-top:4px">${row('IAF', '初期進入フィックス')}${row('IF', '中間進入フィックス')}${row('FAF', '最終進入フィックス')}${row('MAPt', '進入復行点')}${row('MAHF', '進入復行の待機点')}</table>`;
      if (p.missedApproach) html += `<h3 style="margin:8px 0 2px">進入復行方式</h3><div class="ds">${esc(p.missedApproach)}</div>`;
      html += `<div style="color:#9fb3c8;font-size:11px;margin-top:4px">地図はチャートの主要地点（IAF→IF→FAF→滑走路）を直線で結んだ概略です。太線が最終進入、細かい点線が進入復行。${/\(AR\)/.test(p.name) ? 'RNP AR は円弧の区間が多いため、全体を点線にしています。' : ''}DMEアークや旋回の形は AIP のチャートで確認してください。</div>`;
      if (p.warnings?.length) html += `<div style="color:#ffcc80;font-size:11px;margin-top:2px">${p.warnings.map(esc).join('<br>')}</div>`;
      return html;
    }
    for (const [p, rw] of parts) {
      if (p.description) html += `<div class="ds">${esc(p.description)}</div>`;
      const lg = legsFor(p, rw);
      if (lg) {
        html += `<table><tr><th>#</th><th>区間</th><th>地点</th><th>磁方位</th><th>距離</th><th>高度</th><th>速度</th></tr>${lg.legs.map(l =>
          `<tr><td>${l.seq ?? ''}</td><td title="${esc(PT_JA[l.pt] || '')}">${esc(l.pt || '')}</td><td>${esc(l.fix || '—')}${l.turn ? ` <span style="color:#9fb3c8">(${l.turn === 'L' ? '左旋回' : '右旋回'})</span>` : ''}</td>
           <td>${l.courseMag != null ? String(Math.round(l.courseMag)).padStart(3, '0') + '°' : ''}</td><td>${l.distNM != null ? l.distNM + 'NM' : ''}</td>
           <td>${esc(altText(l, ta))}</td><td>${esc(spdText(l))}</td></tr>`).join('')}</table>`;
      } else if (p.approxRouteFixes?.length) {
        html += `<div style="color:#ffcc80;font-size:11.5px">従来型手順のため、地図は記述から拾った地点を結んだ概略です（点線）：${esc(p.approxRouteFixes.join(' → '))}</div>`;
      }
    }
    return html;
  }
  async function toggle(it) {
    if (!it) return;
    if (S.shown.has(it.id)) {
      S.shown.get(it.id).ents.forEach(e => ds.entities.remove(e));
      S.shown.delete(it.id);
      if (S.detail === it.id) S.detail = [...S.shown.keys()].at(-1) || null;
      return render();
    }
    await getNav();
    const color = PALETTE[S.colorIx++ % PALETTE.length];
    try {
      const { ents, pts } = draw({ ...it, color });
      S.shown.set(it.id, { ...it, color, ents, pts });
      S.detail = it.id;
    } catch (e) { console.warn('[procedures]', e); }
    render();
  }

  return {
    PROC_CSS,
    /** 空港パネルを開いたとき：タブの件数と、手順の表示先（root）を渡す */
    open(airport, root) {
      if (S.a?.icao !== airport.icao) { clearAll(); S.rwy = ''; }
      S.a = airport; S.root = root;
    },
    setTab(t) { S.tab = t; render(); },
    counts(a) { return { SID: (a.sids || []).length, STAR: (a.stars || []).length, APPROACH: (a.approaches || []).length }; },
    close() { clearAll(); S.root = null; },
  };
}
