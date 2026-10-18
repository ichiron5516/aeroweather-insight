// 経路の断面図（経路アドバイスで選んだ経路）
//   横軸＝出発からの距離（NM）、縦軸＝高度（ft / FL）。画面の下の中央に出す。
//   描くもの：
//     ・計画の高度（上昇・巡航・降下。区間ごとに揺れの強さで色分け）、TOC・TOD・途中の高度変更
//     ・晴天乱気流（Ellrod 指数。飛行時刻の予報で、高度 1,000ft ごと）
//     ・対流雲（レーダーエコー、経路の左右10NM。推定雲頂まで）、発達した積乱雲
//     ・SIGMET（範囲・時刻・高度が重なる所）
//     ・悪天予想図：国内（FBJP）の CAT 域・積乱雲・雲中の揺れ・雲域、国際（SIGWX）の積乱雲・乱気流・着氷・ジェット気流・圏界面
//     ・地形
//   操作：ホイール（またはピンチ）で拡大・縮小、ドラッグで移動、ダブルクリックで全体。Shift＋ホイールで縦方向。
//         「大きく」でパネルを広げる。マウスを載せた所の内容を札で出す。
//   高度の変更（「✏ FL変更」を押した状態）：
//         ・巡航中の所をクリック（タップ）→ そこから、クリックした高さに近い FL（東行き奇数・西行き偶数）へ上昇・降下
//         ・上昇の途中（TOC より前）をクリック → 最初の巡航高度を変える
//         ・高度変更の印（▲▼）をドラッグ → 変更を始める場所を動かす。印をクリック → その変更を取り消す
//         ・「元に戻す」で1つ前へ、「推奨に戻す」で自動の推奨計画へ。変えるたびに揺れ評価を計算し直す
import { tiAt, tiClass } from './turbulence.js';
import { pointInPoly } from './wxSources.js';
import { jetsNear, tropAt } from './fcstCharts.js';
import { normalizeSteps, planProfile } from './scoring.js';

const CSS = `
#awSec{position:absolute;left:50%;transform:translateX(-50%);bottom:40px;z-index:26;width:min(960px,calc(100vw - 740px));min-width:min(560px,calc(100vw - 20px));
  height:300px;background:rgba(14,22,34,.96);color:#fff;font:12px/1.4 "Meiryo",sans-serif;border-radius:8px;border-top:3px solid #00e676;
  box-shadow:0 6px 24px rgba(0,0,0,.55);display:flex;flex-direction:column;padding:6px 8px 6px}
#awSec[hidden]{display:none}
#awSec.big{width:calc(100vw - 20px);height:min(62vh,640px);min-width:0}
#awSec .hd{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#awSec .hd b{font-size:13px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
#awSec .hd button{font:11.5px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:2px 8px;cursor:pointer;min-width:30px}
#awSec .hd button:hover{border-color:#8fd0ff}
#awSec .cv{position:relative;flex:1;min-height:0;margin-top:4px;touch-action:none;cursor:grab}
#awSec .cv.drag{cursor:grabbing}
#awSec canvas{position:absolute;inset:0;width:100%;height:100%}
#awSec .tip{position:absolute;pointer-events:none;background:rgba(20,30,45,.95);border:1px solid #8fd0ff;border-radius:5px;padding:4px 7px;
  font-size:11.5px;white-space:pre;display:none;z-index:2;max-width:420px}
#awSec .hd button.ed[aria-pressed="true"]{background:#1e3a5f;border-color:#40c4ff;color:#b3e5fc}
#awSec .hd .edc{display:none;gap:6px}
#awSec.editing .hd .edc{display:flex}
#awSec.editing{border-top-color:#40c4ff}
#awSec.editing .cv{cursor:crosshair}
#awSec .hd .man{display:none;font-size:11px;color:#40c4ff;font-weight:600}
#awSec.manual .hd .man{display:inline}
#awSec .lg{display:flex;flex-wrap:wrap;gap:1px 10px;font-size:10.5px;color:#cfe3f5;margin-top:3px}
#awSec .lg i{display:inline-block;width:14px;height:9px;margin-right:3px;vertical-align:-1px;border:1px solid rgba(255,255,255,.35)}
`;

// 色
const C = {
  bg: '#0e1622', grid: 'rgba(143,208,255,.13)', axis: '#9fb3c8',
  CAT: { LGT: 'rgba(255,238,88,.22)', MOD: 'rgba(255,167,38,.42)', SEV: 'rgba(239,83,80,.6)' },
  // レーダーエコーは青系（晴天乱気流の黄〜赤と区別する）。10〜20・20〜50・50mm/h 以上
  CONV: mm => (mm >= 50 ? 'rgba(48,79,254,.62)' : mm >= 20 ? 'rgba(30,136,229,.46)' : 'rgba(100,181,246,.3)'),
  CB: '#ff1744', SIGMET: '#e040fb', terrain: '#5d4037', terrainEdge: '#a1887f',
  F: { CAT: '#c2185b', CB: '#ff5252', TURB: '#ff9100', CLOUD: '#b0bec5', ICING: '#4fc3f7' },
  jet: '#ce93d8', trop: '#fff59d', plan: '#ffffff', risk: { LGT: '#ffee58', MOD: '#ffa726', SEV: '#ef5350' },
};
const FT_MAX = 47000;
const flText = ft => (ft >= 14000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${(Math.round(ft / 100) * 100).toLocaleString()}ft`);
const fl3 = ft => 'FL' + String(Math.round(ft / 100)).padStart(3, '0');
const hhmm = d => `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/** 断面図に描く中身を、経路上の点ごとに作る */
function buildData(r, wx, fc) {
  const prof = r.best.prof, N = prof.length;
  const D = prof.at(-1).d;
  // 各点の区間の幅（隣との中点まで）
  const x0 = prof.map((p, i) => (i ? (prof[i - 1].d + p.d) / 2 : 0));
  const x1 = prof.map((p, i) => (i < N - 1 ? (p.d + prof[i + 1].d) / 2 : D));
  // 晴天乱気流：飛行時刻の予報で、1,000ft ごと（8,000ft 以上）
  const cat = [];
  if (wx.grid && wx.tiField) {
    const T = wx.grid.times.map(t => new Date(t).getTime());
    const tIdx = eto => { let k = 0; for (let i = 1; i < T.length; i++) if (Math.abs(T[i] - eto) < Math.abs(T[k] - eto)) k = i; return k; };
    const stride = Math.max(1, Math.round(N / 400));                       // 長い経路は間引く
    for (let i = 0; i < N; i += stride) {
      const p = prof[i], t = tIdx(p.eto.getTime());
      const xa = x0[i], xb = x1[Math.min(N - 1, i + stride - 1)];
      for (let a = 8000; a <= 45000; a += 1000) {
        const v = tiAt(wx.grid, wx.tiField, t, p.lat, p.lon, a + 500), c = v && tiClass(v.ti);
        if (c) cat.push({ xa, xb, z0: a, z1: a + 1000, cls: c.cls, ti: v.ti, layer: v.layer });
      }
    }
  }
  // 対流雲・積乱雲・SIGMET・悪天予想図：同じものが続く区間をまとめる（枠と名前を付けるため）
  const open = new Map(), runs = [];       // key → 続いている区間
  const runAdd = (key, i, o) => {
    const r0 = open.get(key);
    if (r0 && r0.last === i - 1) { r0.xb = x1[i]; r0.last = i; r0.z0 = Math.min(r0.z0, o.z0); r0.z1 = Math.max(r0.z1, o.z1); return; }
    const n = { ...o, xa: x0[i], xb: x1[i], last: i };
    open.set(key, n); runs.push(n);
  };
  const conv = [], jets = [], trop = [], terrain = [];
  prof.forEach((p, i) => {
    if (p.radarMax >= 10) conv.push({ xa: x0[i], xb: x1[i], z1: p.convTop ?? 30000, unknownTop: p.convTop == null, mm: p.radarMax });
    if (p.cbNear) { const b = p.cbNear.b; runAdd(`CB|${b.lat},${b.lon}`, i, { kind: 'CB', z0: 0, z1: (b.top?.fl ?? 450) * 100, label: `積乱雲 雲頂${b.top ? fl3(b.top.fl * 100) : '不明'}`, b }); }
    for (const g of wx.sigmets || []) {
      if (g.from && p.eto < g.from || g.to && p.eto > g.to) continue;
      if (!pointInPoly(p.lat, p.lon, g.coords)) continue;
      runAdd(`SIG|${g.raw || g.hazard + g.fir}`, i, { kind: 'SIGMET', z0: Math.max(0, g.baseFt), z1: Math.min(g.topFt, FT_MAX), label: `SIGMET ${g.hazard}${g.qualifier ? ' ' + g.qualifier : ''}`, g });
    }
    for (const b of p.fcst || []) runAdd(`F|${b.label}|${b.ring.length}|${b.ring[0].lat}`, i, { kind: 'FCST', fk: b.kind, src: b.src, z0: b.base, z1: Math.min(b.top, FT_MAX), label: b.label, cls: b.cls });
    if (fc && i % 6 === 0) {
      for (const j of jetsNear(fc, p.lat, p.lon)) jets.push({ x: p.d, z: j.fl * 100, kt: j.kt, src: j.src });
      const tr = tropAt(fc, p.lat, p.lon); if (tr) trop.push({ x: p.d, z: tr * 100 });
    }
    terrain.push({ x: p.d, z: p.elevFt ?? (wx.elevAt ? wx.elevAt(p.lat, p.lon) : 0) });   // 保存したデータは各点の標高を使う
  });
  // ジェット気流の札は 150NM ごとに1つ
  const jetMarks = []; let lastJ = -1e9;
  for (const j of jets.sort((a, b) => a.x - b.x)) if (j.x - lastJ > 150) { jetMarks.push(j); lastJ = j.x; }
  // 地点（全経路の点の距離）
  const wpts = []; let d = 0;
  r.full.points.forEach((p, i) => { if (i) d += p.legNM || 0; if (p.kind !== 'runway') wpts.push({ id: p.id, x: d, kind: p.kind }); });
  const scale = D / (d || D);                                              // densify との差をそろえる
  wpts.forEach(w => { w.x *= scale; });
  // 航空路（SID・STAR・直行を含む）：同じ名前が続く区間
  const legs = []; d = 0;
  const pts = r.full.points;
  const nameOf = p => {
    if (p.kind === 'SID' || p.kind === 'SID_TRANSITION') return { name: shortProc(r.full.sid) || 'SID', type: 'SID' };
    if (p.kind === 'STAR') return { name: shortProc(r.full.star) || 'STAR', type: 'STAR' };
    if (p.kind === 'ENROUTE') return p.via && p.via !== 'DCT' ? { name: p.via.replace(/\?$/, ''), type: 'AWY' } : { name: 'DCT', type: 'DCT' };
    return null;
  };
  for (let i = 1; i < pts.length; i++) {
    const a = d; d += pts[i].legNM || 0;
    const n = (pts[i].kind === 'runway' || pts[i].kind === 'airport') ? nameOf(pts[i - 1]) : nameOf(pts[i]);
    if (!n) continue;
    const last = legs.at(-1);
    if (last && last.name === n.name && Math.abs(last.x1 - a * scale) < 1e-6) last.x1 = d * scale;
    else legs.push({ ...n, x0: a * scale, x1: d * scale });
  }
  // TOC・TOD・高度変更
  const firstLv = r.best.fl * 100, lastLv = r.best.steps?.length ? r.best.steps.at(-1).to * 100 : firstLv;
  const toc = prof.findIndex(q => q.alt >= firstLv - 50), tod = prof.findLastIndex(q => q.alt >= lastLv - 50);
  return { prof, D, cat, conv, runs, jetMarks, trop, terrain, wpts, toc, tod, segs: r.best.segs, legs, steps: r.best.steps || [] };
}

export function createRouteSection({ onClose, onEdit, onReset } = {}) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const el = document.createElement('div'); el.id = 'awSec'; el.hidden = true;
  el.innerHTML = `
    <div class="hd"><b id="awSecT">断面図</b><span class="man">手動の高度</span>
      <button data-z="edit" class="ed" aria-pressed="false" title="断面図をクリックして、途中で高度（FL）を変える">✏ FL変更</button>
      <span class="edc"><button data-z="undo" title="1つ前の高度計画に戻す">元に戻す</button><button data-z="reset" title="自動で選んだ推奨の高度計画に戻す">推奨に戻す</button></span>
      <button data-z="in" title="横に拡大">＋</button><button data-z="out" title="横に縮小">－</button>
      <button data-z="vin" title="縦に拡大">縦＋</button><button data-z="vout" title="縦に縮小">縦－</button>
      <button data-z="fit" title="経路全体を表示">全体</button>
      <button data-z="big" title="断面図を大きく表示" aria-pressed="false">大きく</button>
      <button data-z="x" title="閉じる">✕</button></div>
    <div class="cv"><canvas></canvas><div class="tip"></div></div>
    <div class="lg">
      <span><i style="background:${C.CAT.MOD}"></i>晴天乱気流（弱・並・強）</span>
      <span><i style="background:${C.CONV(20)}"></i>レーダーエコー（推定雲頂まで）</span>
      <span><i style="border-color:${C.CB};background:rgba(255,23,68,.18)"></i>発達した積乱雲</span>
      <span><i style="border-color:${C.SIGMET};background:rgba(224,64,251,.15)"></i>SIGMET</span>
      <span><i style="border:1px dashed ${C.F.CAT};background:rgba(194,24,91,.2)"></i>悪天予想図 CAT</span>
      <span><i style="border:1px dashed ${C.F.CB};background:rgba(255,82,82,.16)"></i>予想 積乱雲</span>
      <span><i style="border:1px dashed ${C.F.TURB};background:rgba(255,145,0,.16)"></i>予想 乱気流・雲中の揺れ</span>
      <span><i style="border:1px dashed ${C.F.ICING};background:rgba(79,195,247,.14)"></i>予想 着氷</span>
      <span><i style="background:${C.jet}"></i>ジェット気流</span>
      <span><i style="background:${C.trop}"></i>圏界面</span>
      <span><i style="background:${C.terrain}"></i>地形</span>
    </div>`;
  document.body.append(el);
  const box = el.querySelector('.cv'), cv = el.querySelector('canvas'), tip = el.querySelector('.tip');
  const ctx = cv.getContext('2d');
  const M = { l: 52, r: 12, t: 46, b: 22 };              // 余白（左＝高度目盛、上＝地点名と航空路、下＝距離目盛）
  let data = null, title = '', V = { x0: 0, x1: 1, z0: 0, z1: FT_MAX }, hover = null;
  const show = { wpt: true, awy: true };                  // 地点名・航空路名を出すか
  const setTop = () => { M.t = 14 + (show.wpt ? 16 : 0) + (show.awy ? 16 : 0); };
  let hiddenProfile = null;
  // 高度の変更：ctx = { samples, depEl, arrEl, levels }、plan = { fl, steps:[{to,d0}] }
  let ed = { on: false, ctx: null, plan: null, hist: [], ghost: null, dragStep: -1, down: null, msg: '' };

  // ---------- 座標 ----------
  const W = () => box.clientWidth, H = () => box.clientHeight;
  const X = x => M.l + (x - V.x0) / (V.x1 - V.x0) * (W() - M.l - M.r);
  const Z = z => H() - M.b - (z - V.z0) / (V.z1 - V.z0) * (H() - M.t - M.b);
  const invX = px => V.x0 + (px - M.l) / (W() - M.l - M.r) * (V.x1 - V.x0);
  const invZ = py => V.z0 + (H() - M.b - py) / (H() - M.t - M.b) * (V.z1 - V.z0);
  const clampV = () => {
    const D = data?.D || 1, span = Math.min(D, Math.max(20, V.x1 - V.x0));
    V.x0 = Math.max(0, Math.min(D - span, V.x0)); V.x1 = V.x0 + span;
    const zs = Math.min(FT_MAX, Math.max(4000, V.z1 - V.z0));
    V.z0 = Math.max(0, Math.min(FT_MAX - zs, V.z0)); V.z1 = V.z0 + zs;
  };
  const zoomX = (f, at = (V.x0 + V.x1) / 2) => { V.x0 = at - (at - V.x0) * f; V.x1 = at + (V.x1 - at) * f; clampV(); draw(); };
  const zoomZ = (f, at = (V.z0 + V.z1) / 2) => { V.z0 = at - (at - V.z0) * f; V.z1 = at + (V.z1 - at) * f; clampV(); draw(); };
  const fit = () => { V = { x0: 0, x1: data?.D || 1, z0: 0, z1: FT_MAX }; draw(); };

  // ---------- 描画 ----------
  function draw() {
    const dpr = window.devicePixelRatio || 1, w = W(), h = H();
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    if (!data) return;
    const pw = w - M.l - M.r, ph = h - M.t - M.b;
    ctx.save(); ctx.beginPath(); ctx.rect(M.l, M.t, pw, ph); ctx.clip();
    const rect = (xa, xb, z0, z1) => [X(xa), Z(z1), Math.max(1, X(xb) - X(xa)), Z(z0) - Z(z1)];
    // 目盛の線（高度 5,000ft ごと、距離）
    const zStep = V.z1 - V.z0 > 25000 ? 5000 : V.z1 - V.z0 > 10000 ? 2000 : 1000;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let z = Math.ceil(V.z0 / zStep) * zStep; z <= V.z1; z += zStep) { ctx.beginPath(); ctx.moveTo(M.l, Z(z) + .5); ctx.lineTo(M.l + pw, Z(z) + .5); ctx.stroke(); }
    const xStep = niceStep((V.x1 - V.x0) / 8);
    for (let x = Math.ceil(V.x0 / xStep) * xStep; x <= V.x1; x += xStep) { ctx.beginPath(); ctx.moveTo(X(x) + .5, M.t); ctx.lineTo(X(x) + .5, M.t + ph); ctx.stroke(); }
    // 地点の縦線
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    if (show.wpt) for (const p of data.wpts) if (p.x >= V.x0 && p.x <= V.x1) { ctx.beginPath(); ctx.moveTo(X(p.x) + .5, M.t); ctx.lineTo(X(p.x) + .5, M.t + ph); ctx.stroke(); }
    // 晴天乱気流
    for (const c of data.cat) { if (c.xb < V.x0 || c.xa > V.x1) continue; ctx.fillStyle = C.CAT[c.cls]; ctx.fillRect(...rect(c.xa, c.xb, c.z0, c.z1)); }
    // 対流雲（レーダー）
    for (const c of data.conv) { if (c.xb < V.x0 || c.xa > V.x1) continue; ctx.fillStyle = C.CONV(c.mm); ctx.fillRect(...rect(c.xa, c.xb, 0, c.z1)); }
    // 悪天予想図（破線の枠＋薄い塗り＋斜線）・SIGMET・積乱雲
    for (const r of data.runs) {
      if (r.xb < V.x0 || r.xa > V.x1) continue;
      const [x, y, rw, rh] = rect(r.xa, r.xb, r.z0, r.z1);
      if (r.kind === 'FCST') {
        const col = C.F[r.fk] || '#fff';
        ctx.fillStyle = hexA(col, r.fk === 'CLOUD' ? 0.1 : 0.16); ctx.fillRect(x, y, rw, rh);
        if (r.fk === 'CAT' || r.fk === 'TURB') hatch(x, y, rw, rh, hexA(col, 0.45));
        ctx.setLineDash([5, 3]); ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.strokeRect(x + .5, y + .5, rw - 1, rh - 1); ctx.setLineDash([]);
        tag(r.label.replace(/^(国内|国際)悪天予想図 /, r.src === 'FBJP' ? '国内予想 ' : '国際予想 '), x + 3, y + 12, col, rw);
      } else if (r.kind === 'SIGMET') {
        ctx.fillStyle = 'rgba(224,64,251,.15)'; ctx.fillRect(x, y, rw, rh);
        ctx.strokeStyle = C.SIGMET; ctx.lineWidth = 1.6; ctx.strokeRect(x + .5, y + .5, rw - 1, rh - 1);
        tag(r.label, x + 3, y + 12, C.SIGMET, rw);
      } else if (r.kind === 'CB') {
        ctx.fillStyle = 'rgba(255,23,68,.18)'; ctx.fillRect(x, y, rw, rh);
        ctx.strokeStyle = C.CB; ctx.lineWidth = 1.6; ctx.strokeRect(x + .5, y + .5, rw - 1, rh - 1);
        tag(r.label, x + 3, y + 12, '#ff8a80', rw);
      }
    }
    // 圏界面
    if (data.trop.length > 1) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = C.trop; ctx.lineWidth = 1.3; ctx.beginPath();
      data.trop.forEach((t, i) => (i ? ctx.lineTo(X(t.x), Z(t.z)) : ctx.moveTo(X(t.x), Z(t.z)))); ctx.stroke(); ctx.setLineDash([]);
    }
    // 地形
    ctx.fillStyle = C.terrain; ctx.strokeStyle = C.terrainEdge; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(0), Z(0));
    for (const t of data.terrain) ctx.lineTo(X(t.x), Z(t.z));
    ctx.lineTo(X(data.D), Z(0)); ctx.closePath(); ctx.fill();
    // 計画の高度（区間の揺れの強さで色分け。黒い縁取り）
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 5.5; ctx.beginPath();
    data.prof.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Z(p.alt)) : ctx.moveTo(X(p.d), Z(p.alt)))); ctx.stroke();
    for (const s of data.segs) {
      ctx.strokeStyle = s.cls ? C.risk[s.cls] : '#00e676'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(X(s.a.d), Z(s.a.alt)); ctx.lineTo(X(s.b.d), Z(s.b.alt)); ctx.stroke();
    }
    // ジェット気流（中心の高さ）
    for (const j of data.jetMarks) {
      if (j.x < V.x0 || j.x > V.x1) continue;
      const x = X(j.x), y = Z(j.z);
      ctx.fillStyle = C.jet; ctx.beginPath(); ctx.ellipse(x, y, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      tag(`J ${fl3(j.z)}${j.kt ? ' ' + j.kt + 'kt' : ''}`, x + 11, y + 4, C.jet, 200);
    }
    // TOC・TOD・高度変更
    const mark = (p, txt, col) => {
      if (!p || p.d < V.x0 || p.d > V.x1) return;
      ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X(p.d), Z(p.alt), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      tag(txt, X(p.d) + 6, Z(p.alt) - 7, col, 200);
    };
    mark(data.prof[data.toc], `TOC ${flText(data.prof[data.toc]?.alt || 0)}`, '#b388ff');
    mark(data.prof[data.tod], `TOD ${flText(data.prof[data.tod]?.alt || 0)}`, '#b388ff');
    // 途中の高度変更（▲上昇・▼降下）。高度を変える状態では、つかめる印を大きく
    (data.steps || []).forEach(st => {
      if (st.d0 < V.x0 - 50 || st.d0 > V.x1 + 50) return;
      const up = st.to > st.from, x = X(st.d0), y = Z(st.from * 100), col = up ? '#40c4ff' : '#ffab40';
      ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2;
      const r = ed.on ? 7 : 5;
      ctx.beginPath();
      if (up) { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * .8); ctx.lineTo(x - r, y + r * .8); }
      else { ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r * .8); ctx.lineTo(x - r, y - r * .8); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      tag(`${up ? '▲' : '▼'} FL${st.to}`, x + 8, up ? y - 6 : y + 16, col, 200);
    });
    // クリックしたときの計画（破線）
    if (ed.on && ed.ghost) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#40c4ff'; ctx.lineWidth = 2.2; ctx.beginPath();
      ed.ghost.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Z(p.alt)) : ctx.moveTo(X(p.d), Z(p.alt)))); ctx.stroke(); ctx.setLineDash([]);
    }
    // カーソル
    if (hover) {
      ctx.strokeStyle = 'rgba(143,208,255,.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(hover.x) + .5, M.t); ctx.lineTo(X(hover.x) + .5, M.t + ph); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(M.l, Z(hover.z) + .5); ctx.lineTo(M.l + pw, Z(hover.z) + .5); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
    // 目盛の文字
    ctx.fillStyle = C.axis; ctx.font = '10.5px Meiryo, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let z = Math.ceil(V.z0 / zStep) * zStep; z <= V.z1; z += zStep) ctx.fillText(z >= 14000 ? fl3(z) : `${z.toLocaleString()}ft`, M.l - 4, Z(z));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = Math.ceil(V.x0 / xStep) * xStep; x <= V.x1; x += xStep) ctx.fillText(`${Math.round(x)}NM`, X(x), h - M.b + 4);
    // 地点名（重ならないように間引く。拡大すると全部出る）
    const yW = M.t - 4 - (show.awy ? 16 : 0);
    if (show.wpt) {
      ctx.textBaseline = 'bottom'; ctx.font = '10.5px Meiryo, sans-serif';
      let lastR = -1e9;
      for (const p of data.wpts) {
        if (p.x < V.x0 || p.x > V.x1) continue;
        const x = X(p.x), tw = ctx.measureText(p.id).width;
        if (x - tw / 2 < lastR + 4) continue;
        ctx.fillStyle = p.kind === 'SID' || p.kind === 'STAR' || p.kind === 'SID_TRANSITION' ? '#80deea' : '#e0e6ec';
        ctx.fillText(p.id, x, yW); lastR = x + tw / 2;
        ctx.fillRect(x - .5, yW + 1, 1, 3);
      }
    }
    // 航空路名（区間の上に、区間の長さの線と名前）
    if (show.awy) {
      const y = M.t - 9;
      ctx.font = '700 10px Meiryo, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      for (const g of data.legs) {
        if (g.x1 < V.x0 || g.x0 > V.x1) continue;
        const xa = Math.max(M.l, X(g.x0)) + 1.5, xb = Math.min(W() - M.r, X(g.x1)) - 1.5;
        if (xb - xa < 2) continue;
        const st = LEG[g.type];
        ctx.strokeStyle = st.bg; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        ctx.fillStyle = st.bg; ctx.fillRect(xa - .5, y - 3, 1.5, 6); ctx.fillRect(xb - 1, y - 3, 1.5, 6);
        const tw = ctx.measureText(g.name).width;
        if (tw + 8 > xb - xa) continue;                      // 区間が短いときは名前を省く（拡大すると出る）
        const cx = (xa + xb) / 2;
        ctx.fillStyle = st.bg; ctx.fillRect(cx - tw / 2 - 4, y - 6.5, tw + 8, 13);
        ctx.fillStyle = st.fg; ctx.fillText(g.name, cx, y + .5);
      }
    }
  }
  function tag(text, x, y, col, maxW) {
    ctx.font = '600 10.5px Meiryo, sans-serif';
    const tw = ctx.measureText(text).width;
    if (tw + 6 > maxW && maxW < 60) return;                   // 狭すぎる所には書かない
    ctx.fillStyle = 'rgba(14,22,34,.78)'; ctx.fillRect(x - 2, y - 10, tw + 4, 13);
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(text, x, y);
  }
  function hatch(x, y, w, h, col) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    for (let k = -h; k < w; k += 7) { ctx.beginPath(); ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + h, y); ctx.stroke(); }
    ctx.restore();
  }

  // ---------- マウスを載せた所の内容 ----------
  function describe(x, z) {
    const p = data.prof.reduce((a, b) => (Math.abs(b.d - x) < Math.abs(a.d - x) ? b : a));
    const lines = [`${Math.round(p.d)}NM（${p.near}付近）  高度 ${flText(z)}`, `計画 ${flText(p.alt)}・通過 ${hhmm(p.eto)}`];
    const c = data.cat.find(c => x >= c.xa && x <= c.xb && z >= c.z0 && z < c.z1);
    if (c) lines.push(`晴天乱気流 ${{ LGT: '弱', MOD: '並', SEV: '強' }[c.cls]}（TI ${c.ti.toFixed(1)}）`);
    const cv0 = data.conv.find(c => x >= c.xa && x <= c.xb && z <= c.z1);
    if (cv0) lines.push(`レーダーエコー ${cv0.mm >= 80 ? '80以上' : cv0.mm}mm/h・雲頂${cv0.unknownTop ? '不明（30,000ft で表示）' : flText(cv0.z1)}`);
    for (const r of data.runs) if (x >= r.xa && x <= r.xb && z >= r.z0 && z <= r.z1) lines.push(r.label);
    const tr = data.trop.reduce((a, b) => (!a || Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a), null);
    if (tr && Math.abs(tr.x - x) < 60) lines.push(`圏界面 ${fl3(tr.z)}（国際悪天予想図）`);
    const t = data.terrain.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    if (t.z > 300) lines.push(`地形 ${Math.round(t.z).toLocaleString()}ft`);
    return lines.join('\n');
  }

  // ---------- 高度の変更 ----------
  const planOf = b => ({ fl: b.fl, steps: (b.steps || []).map(x => ({ to: x.to, d0: x.d0 })) });
  const tocD = () => data.prof[data.toc]?.d ?? 0;
  const todD = () => data.prof[data.tod]?.d ?? data.D;
  const nearName = x => data.prof.reduce((a, b) => (Math.abs(b.d - x) < Math.abs(a.d - x) ? b : a)).near;
  const snapFL = z => ed.ctx.levels.reduce((a, b) => (Math.abs(b * 100 - z) < Math.abs(a * 100 - z) ? b : a));
  const norm = pl => normalizeSteps(pl.fl, pl.steps, data.D);
  const ghostOf = pl => planProfile(ed.ctx.samples, pl.fl, norm(pl), ed.ctx.depEl, ed.ctx.arrEl).map(q => ({ d: q.d, alt: q.alt }));
  /** 距離 x・高さ z をクリックしたときの新しい計画（変わらなければ plan なし）と説明 */
  function clicked(x, z) {
    const p = ed.plan, fl = snapFL(z), steps = norm(p);
    if (x <= tocD() + 1) return fl === p.fl ? { msg: `最初の巡航高度 FL${p.fl}` } : { plan: { fl, steps: p.steps }, msg: `クリック：最初の巡航高度を FL${fl} に変える` };
    if (x >= todD() - 3) return { msg: '降下を始めた後（TOD より後）は変えられません' };
    let k = -1; steps.forEach((st, i) => { if (st.d0 <= x) k = i; });
    if (k >= 0 && x < steps[k].d1) {                          // 上昇・降下の途中 → その変更の行き先を変える
      if (fl === steps[k].to) return { msg: `${Math.round(steps[k].d0)}NM から FL${fl} へ変更中` };
      return { plan: { fl: p.fl, steps: steps.map((st, i) => ({ to: i === k ? fl : st.to, d0: st.d0 })) },
        msg: `クリック：${Math.round(steps[k].d0)}NM からの変更先を FL${fl} にする` };
    }
    const cur = k < 0 ? p.fl : steps[k].to;
    if (fl === cur) return { msg: `この区間は FL${cur}（上下にずらした所をクリックすると高度を変えます）` };
    return { plan: { fl: p.fl, steps: [...steps.map(st => ({ to: st.to, d0: st.d0 })), { to: fl, d0: x }] },
      msg: `クリック：${Math.round(x)}NM（${nearName(x)}付近）から FL${fl} へ${fl > cur ? '上昇' : '降下'}` };
  }
  /** 高度変更の印に当たっているか（番号、なければ -1） */
  function hitStep(px, py) {
    let best = -1, bd = 13;
    (data?.steps || []).forEach((st, i) => { const d = Math.hypot(X(st.d0) - px, Z(st.from * 100) - py); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function commit(pl) {
    ed.hist.push(ed.plan); ed.plan = pl; ed.ghost = null;
    onEdit?.({ fl: pl.fl, steps: norm(pl).map(x => ({ to: x.to, d0: x.d0 })) });
  }
  function setEdit(on) {
    ed.on = on; el.classList.toggle('editing', on);
    el.querySelector('[data-z="edit"]').setAttribute('aria-pressed', on);
    ed.ghost = null; ed.down = null; draw();
  }

  // ---------- 操作（マウス・タッチ） ----------
  const ptrs = new Map(); let drag = null, pinch = null;
  box.addEventListener('wheel', e => {
    if (!data) return; e.preventDefault();
    const rc = box.getBoundingClientRect(), f = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    if (e.shiftKey || e.altKey) zoomZ(f, invZ(e.clientY - rc.top)); else zoomX(f, invX(e.clientX - rc.left));
  }, { passive: false });
  box.addEventListener('pointerdown', e => {
    box.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { drag = { x: e.clientX, y: e.clientY, V: { ...V } }; box.classList.add('drag'); }
    if (ed.on && data && ptrs.size === 1) {
      const rc = box.getBoundingClientRect(), hit = hitStep(e.clientX - rc.left, e.clientY - rc.top);
      ed.down = { x: e.clientX, y: e.clientY, hit, moved: false };
      if (hit >= 0) { drag = null; box.classList.remove('drag'); }        // 印をつかんだときは図を動かさない
    }
    if (ptrs.size === 2) {
      ed.down = null; ed.ghost = null;
      const [a, b] = [...ptrs.values()]; drag = null;
      pinch = { dx: Math.abs(a.x - b.x) || 1, dy: Math.abs(a.y - b.y) || 1, V: { ...V }, cx: invX((a.x + b.x) / 2 - box.getBoundingClientRect().left), cz: invZ((a.y + b.y) / 2 - box.getBoundingClientRect().top) };
    }
  });
  box.addEventListener('pointermove', e => {
    const rc = box.getBoundingClientRect();
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const fx = pinch.dx / Math.max(1, Math.abs(a.x - b.x)), fz = pinch.dy / Math.max(1, Math.abs(a.y - b.y));
      V = { ...pinch.V };
      if (pinch.dx > 40) { V.x0 = pinch.cx - (pinch.cx - V.x0) * fx; V.x1 = pinch.cx + (V.x1 - pinch.cx) * fx; }
      if (pinch.dy > 40) { V.z0 = pinch.cz - (pinch.cz - V.z0) * fz; V.z1 = pinch.cz + (V.z1 - pinch.cz) * fz; }
      clampV(); draw(); return;
    }
    if (drag) {
      const kx = (V.x1 - V.x0) / (W() - M.l - M.r), kz = (V.z1 - V.z0) / (H() - M.t - M.b);
      V.x0 = drag.V.x0 - (e.clientX - drag.x) * kx; V.x1 = drag.V.x1 - (e.clientX - drag.x) * kx;
      V.z0 = drag.V.z0 + (e.clientY - drag.y) * kz; V.z1 = drag.V.z1 + (e.clientY - drag.y) * kz;
      clampV();
    }
    if (!data) return;
    const px = e.clientX - rc.left, py = e.clientY - rc.top;
    if (ed.down && Math.hypot(e.clientX - ed.down.x, e.clientY - ed.down.y) > 5) ed.down.moved = true;
    if (px < M.l || py < M.t || px > W() - M.r || py > H() - M.b) { hover = null; ed.ghost = null; tip.style.display = 'none'; draw(); return; }
    hover = { x: invX(px), z: invZ(py) };
    // 高度を変える状態：印のドラッグ中は場所を動かした計画、それ以外はクリックしたときの計画を破線で見せる
    ed.msg = '';
    if (ed.on && ed.ctx) {
      if (ed.down?.hit >= 0) {
        if (ed.down.moved) {
          const steps = norm(ed.plan).map(x => ({ to: x.to, d0: x.d0 })), x = Math.max(tocD() + 1, Math.min(todD() - 10, hover.x));
          steps[ed.down.hit].d0 = x; ed.down.plan = { fl: ed.plan.fl, steps };
          ed.ghost = ghostOf(ed.down.plan); ed.msg = `${Math.round(x)}NM（${nearName(x)}付近）から変更を始める`;
        }
      } else if (drag && ed.down?.moved) { ed.ghost = null; }
      else if (hitStep(px, py) >= 0) { ed.ghost = null; ed.msg = 'ドラッグ：変更を始める場所を動かす／クリック：この変更を取り消す'; }
      else { const c = clicked(hover.x, hover.z); ed.ghost = c.plan ? ghostOf(c.plan) : null; ed.msg = c.msg; }
    }
    tip.textContent = (ed.msg ? ed.msg + '\n' : '') + describe(hover.x, hover.z); tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${px + 14 + tw > W() ? px - tw - 14 : px + 14}px`; tip.style.top = `${Math.max(0, Math.min(H() - th, py - th - 8))}px`;
    draw();
  });
  const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) { drag = null; box.classList.remove('drag'); } };
  box.addEventListener('pointerup', e => {
    const d = ed.down; ed.down = null;
    if (ed.on && d && data && ptrs.size === 1 && e.type === 'pointerup') {
      const rc = box.getBoundingClientRect(), px = e.clientX - rc.left, py = e.clientY - rc.top;
      if (d.hit >= 0 && d.moved && d.plan) commit(d.plan);                             // 印を動かした
      else if (d.hit >= 0 && !d.moved) {                                               // 印をクリック → その変更を取り消す
        const steps = norm(ed.plan).map(x => ({ to: x.to, d0: x.d0 })); steps.splice(d.hit, 1);
        commit({ fl: ed.plan.fl, steps });
      } else if (!d.moved && px >= M.l && py >= M.t && px <= W() - M.r && py <= H() - M.b) {
        const c = clicked(invX(px), invZ(py)); if (c.plan) commit(c.plan);
      }
    }
    up(e);
  });
  box.addEventListener('pointercancel', e => { ed.down = null; up(e); });
  box.addEventListener('pointerleave', () => { if (!ptrs.size) { hover = null; ed.ghost = null; tip.style.display = 'none'; draw(); } });
  box.addEventListener('dblclick', () => { if (!ed.on) fit(); });
  el.querySelector('.hd').addEventListener('click', e => {
    const z = e.target.closest('button')?.dataset.z; if (!z) return;
    if (z === 'in') zoomX(1 / 1.5); else if (z === 'out') zoomX(1.5);
    else if (z === 'vin') zoomZ(1 / 1.5); else if (z === 'vout') zoomZ(1.5);
    else if (z === 'fit') fit();
    else if (z === 'big') { const on = el.classList.toggle('big'); e.target.setAttribute('aria-pressed', on); requestAnimationFrame(draw); }
    else if (z === 'edit') setEdit(!ed.on);
    else if (z === 'undo') { if (ed.hist.length) { ed.plan = ed.hist.pop(); onEdit?.({ fl: ed.plan.fl, steps: norm(ed.plan).map(x => ({ to: x.to, d0: x.d0 })) }); } }
    else if (z === 'reset') { ed.hist.push(ed.plan); onReset?.(); }
    else if (z === 'x') { setEdit(false); api.hide(); onClose?.(); }
  });
  new ResizeObserver(() => draw()).observe(box);

  const api = {
    get open() { return !el.hidden; },
    /** r: rankRoutes の結果1件、wx: 気象データ、fc: 悪天予想図、head: 見出し */
    /** 地点名・航空路名の表示（経路アドバイスの「Waypoint」「Airway」ボタン） */
    setLayers({ wpt = show.wpt, awy = show.awy } = {}) { show.wpt = wpt; show.awy = awy; setTop(); draw(); },
    /** ctx：高度を変えるための材料（scoring.js の planContext）。ないときは高度を変えられない */
    show(r, wx, fc, head, ctx = null) {
      data = buildData(r, wx, fc); title = head || '';
      if (ed.r !== r) ed.hist = [];
      Object.assign(ed, { r, ctx, plan: planOf(r.best), ghost: null });
      el.querySelector('[data-z="edit"]').hidden = !ctx; if (!ctx && ed.on) setEdit(false);
      el.classList.toggle('manual', !!r.best.manual);
      el.querySelector('#awSecT').textContent = title;
      // 事例表示の断面図（index.html の #profilePanel）と重なるので、出している間は隠す
      const pp = document.getElementById('profilePanel');
      if (pp && pp.style.display !== 'none' && getComputedStyle(pp).display !== 'none') { hiddenProfile = pp.style.display; pp.style.display = 'none'; }
      el.hidden = false; V = { x0: 0, x1: data.D, z0: 0, z1: FT_MAX }; hover = null; tip.style.display = 'none';
      requestAnimationFrame(draw);
    },
    /** 高度を変えた後の描き直し（拡大・位置はそのまま） */
    refresh(r, wx, fc, head, ctx = ed.ctx) {
      if (el.hidden) return;
      data = buildData(r, wx, fc); title = head || title;
      Object.assign(ed, { r, ctx, plan: planOf(r.best), ghost: null });
      el.querySelector('#awSecT').textContent = title;
      el.classList.toggle('manual', !!r.best.manual);
      clampV(); draw();
    },
    /** 保存用の画像（大きく表示して全体を描き、元に戻す）。閉じていれば一時的に開く */
    async snapshot(r, wx, fc, head) {
      const wasOpen = !el.hidden, wasBig = el.classList.contains('big'), keep = { data, title, V: { ...V }, hover };
      const frame = () => new Promise(ok => { requestAnimationFrame(() => requestAnimationFrame(ok)); setTimeout(ok, 300); });
      if (!wasOpen) api.show(r, wx, fc, head);
      else { data = buildData(r, wx, fc); V = { x0: 0, x1: data.D, z0: 0, z1: FT_MAX }; }
      hover = null; tip.style.display = 'none';
      el.classList.add('big'); await frame(); draw();
      let url = null;
      try { url = cv.toDataURL('image/png'); } catch (e) { console.warn('[section] snapshot', e); }
      if (!wasBig) el.classList.remove('big');
      if (!wasOpen) api.hide();
      else { data = keep.data; title = keep.title; V = keep.V; await frame(); draw(); }
      return url;
    },
    hide() {
      el.hidden = true; data = null;
      const pp = document.getElementById('profilePanel');
      if (pp && hiddenProfile != null) { pp.style.display = hiddenProfile; hiddenProfile = null; }
    },
  };
  return api;
}

const LEG = {
  AWY: { fg: '#1a1300', bg: 'rgba(255,213,79,0.92)' },
  SID: { fg: '#002a33', bg: 'rgba(128,222,234,0.92)' },
  STAR: { fg: '#002a33', bg: 'rgba(128,222,234,0.92)' },
  DCT: { fg: '#e0e6ec', bg: 'rgba(96,112,132,0.9)' },
};
const NUM = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, ZERO: 0 };
const PHON = { ALFA: 'A', ALPHA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F', GOLF: 'G', HOTEL: 'H', INDIA: 'I', JULIETT: 'J', KILO: 'K', LIMA: 'L', MIKE: 'M', NOVEMBER: 'N', OSCAR: 'O', PAPA: 'P', QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S', TANGO: 'T', UNIFORM: 'U', VICTOR: 'V', WHISKEY: 'W', XRAY: 'X', YANKEE: 'Y', ZULU: 'Z' };
/** 手順名を短く（OMGOR ONE DEPARTURE → OMGOR1、DRAKE ONE ALFA RNAV ARRIVAL → DRAKE1A、RNAV GUKDO 2H → GUKDO2H） */
function shortProc(n) {
  if (!n) return null;
  const w = n.replace(/\(.*?\)/g, '').replace(/\b(RNAV|ARRIVAL|DEPARTURE|TRANSITION)\b/g, '').trim().split(/\s+/).filter(Boolean);
  return w.map((x, i) => (i === 0 ? x : NUM[x] ?? PHON[x] ?? x)).join('');
}
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, v))), m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
