// AeroWeather 航法コア（依存なし・ブラウザ/Node 共通）
//   createAeroNav({ airportDb, navDb, routeDb, storage }) で各機能を作る。
//   - airportDb: airport_db.json（空港・滑走路・SID/STAR）
//   - navDb:     nav_db.json（地点・無線施設・航空路）
//   - routeDb:   route_db.json（AIC標準経路・悪天回避登録経路）
//   - storage:   自作Routeの保存先（省略時 localStorage。使えなければメモリ）

export function nm(a, b) {
  const R = 3440.065, r = Math.PI / 180;
  const p1 = a.lat * r, p2 = b.lat * r, dl = (b.lon - a.lon) * r;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function defaultStorage() {
  try { const s = globalThis.localStorage; s.setItem('__t', '1'); s.removeItem?.('__t'); return s; } catch { return memoryStorage(); }
}

export function createAeroNav({ airportDb, navDb = { fixes: {}, airways: {} }, routeDb = { routes: [] }, storage = null } = {}) {
  const AP = airportDb, F = navDb.fixes, A = navDb.airways;
  const store = storage || defaultStorage();
  const STORE_KEY = 'aeroweather.customRoutes.v1';
  const IDX = Object.fromEntries(Object.entries(A).map(([d, r]) => [d, new Map(r.points.map((p, i) => [p, i]))]));
  // 海外の同じ名前の航空路・地点は「名前~国コード」で入っている（dbLoader.js）。名前 → 実際のキーの一覧
  const base = k => k.split('~')[0];
  const VAR = {}, FVAR = {};
  for (const k of Object.keys(A)) (VAR[base(k)] ||= []).push(k);
  for (const k of Object.keys(F)) if (k.includes('~')) (FVAR[base(k)] ||= []).push(k);
  const WVAR = {};   // 空港手順の地点で、同じ名前が別の国にあるもの（dbLoader.js が「名前~国コード」で入れる）
  for (const k of Object.keys(AP.waypoints || {})) if (k.includes('~')) (WVAR[base(k)] ||= []).push(k);
  const THROUGH = {};
  for (const [d, r] of Object.entries(A)) for (const p of r.points) { const l = (THROUGH[p] ||= []); if (!l.includes(base(d))) l.push(base(d)); }

  // ================= 空港 =================
  // 空港DBにない空港（METAR・TAF の白丸など）を引く関数。滑走路・SID・STAR のない空港として返す（2026-10-18）
  let airportFallback = null;
  function getAirport(code) {
    if (!code) return null;
    const c = String(code).trim().toUpperCase();
    const icao = AP.airports[c] ? c : AP.index.byIata[c];
    return icao ? AP.airports[icao] : (/^[A-Z]{4}$/.test(c) && airportFallback?.(c)) || null;
  }
  const listAirports = () => Object.values(AP.airports).filter(a => a.arp).map(a => ({ icao: a.icao, iata: a.iata || a.icao, nameJa: a.nameJa || a.nameEn || a.icao, nameEn: a.nameEn, lat: a.arp.lat, lon: a.arp.lon }));
  const procKey = { SID: 'sids', STAR: 'stars', SID_TRANSITION: 'sidTransitions', STAR_TRANSITION: 'starTransitions' };
  const rwyOk = (p, rwy) => !rwy || p.runways.includes(rwy) || p.runways.includes('ALL') ||
    Object.keys(p.runwayLegs || {}).some(k => k.split('#')[0].split('/').includes(rwy));
  function listProcedures(code, type = 'SID', runway = null) {
    const a = getAirport(code);
    return a ? (a[procKey[type]] || []).filter(p => rwyOk(p, runway)) : [];
  }
  function findProc(a, list, name) {
    const p = (a[list] || []).find(x => x.name === name);
    if (!p) throw new Error(`${a.icao}: 手順が見つかりません: ${name}`);
    return p;
  }
  function pickLegs(p, runway) {
    const L = p.runwayLegs || {}, keys = Object.keys(L);
    const k = keys.find(k => k.split('#')[0].split('/').includes(runway)) || keys.find(k => k.startsWith('ALL')) || keys[0];
    return k ? L[k] : null;
  }
  // 手順の地点はまず空港DB、なければ航法DBから
  //   同じ名前の地点が国内外にあるとき（例 NYLON：成田とシンガポール）は、空港に近いほうを使う
  function procFix(id, near = null) {
    const c = [AP.waypoints[id], ...(WVAR[id] || []).map(k => AP.waypoints[k]), F[id], ...(FVAR[id] || []).map(k => F[k])]
      .flat().filter(x => x && x.lat != null);
    if (!c.length) { const f = getFix(id); return f ? { id, lat: f.lat, lon: f.lon, type: f.type } : null; }
    const w = near ? c.reduce((a, b) => (nm(b, near) < nm(a, near) ? b : a)) : c[0];
    return { id, lat: w.lat, lon: w.lon, type: w.type };
  }
  function legToPoint(l, kind, near = null) {
    const f = procFix(l.fix, near);
    if (!f) return null;
    const pt = { ...f, kind, pathTerminator: l.pt };
    if (l.alt) {
      if (l.alt.at != null) pt.altFt = l.alt.at;
      if (l.alt.min != null) pt.altMinFt = l.alt.min;
      if (l.alt.max != null) pt.altMaxFt = l.alt.max;
    }
    if (l.speed) pt.speedKt = l.speed.max ?? l.speed.at ?? l.speed.min;
    return pt;
  }
  const approxPoints = (p, kind, near = null) => (p.approxRouteFixes || []).map(id => procFix(id, near)).filter(Boolean).map(f => ({ ...f, kind, approx: true }));
  function sidPoints(code, runway, sidName, transitionName = null) {
    const a = getAirport(code), rw = a.runways.find(r => r.id === runway), pts = [];
    if (rw?.departureEnd) pts.push({ id: `${a.icao}-${runway}-DER`, ...rw.departureEnd, altFt: a.elevationFt, kind: 'runway' });
    const sid = findProc(a, 'sids', sidName), legs = pickLegs(sid, runway);
    const near = a.arp;
    (legs ? legs.map(l => legToPoint(l, 'SID', near)).filter(Boolean) : approxPoints(sid, 'SID', near)).forEach(q => pts.push(q));
    if (transitionName) {
      const tr = findProc(a, 'sidTransitions', transitionName), tl = pickLegs(tr, runway);
      (tl ? tl.map(l => legToPoint(l, 'SID_TRANSITION', near)).filter(Boolean) : approxPoints(tr, 'SID_TRANSITION', near))
        .forEach(q => { if (pts.at(-1)?.id !== q.id) pts.push(q); });
    }
    return pts;
  }
  function starPoints(code, runway, starName) {
    const a = getAirport(code), star = findProc(a, 'stars', starName), legs = pickLegs(star, runway), pts = [];
    (legs ? legs.map(l => legToPoint(l, 'STAR', a.arp)).filter(Boolean) : approxPoints(star, 'STAR', a.arp))
      .forEach(q => { if (pts.at(-1)?.id !== q.id) pts.push(q); });
    const rw = a.runways.find(r => r.id === runway);
    if (rw?.threshold) pts.push({ id: `${a.icao}-${runway}-THR`, ...rw.threshold, altFt: rw.thresholdElevFt ?? a.elevationFt, kind: 'runway' });
    return pts;
  }

  // ================= 地点・航空路 =================
  function getFix(id, near = null) {
    const m = /^(\d{2})(\d{2})?([NS])(\d{3})(\d{2})?([EW])$/.exec(id);
    if (m) {
      const la = +m[1] + (+m[2] || 0) / 60, lo = +m[4] + (+m[5] || 0) / 60;
      return { id, lat: m[3] === 'S' ? -la : la, lon: m[6] === 'W' ? -lo : lo, type: 'coord' };
    }
    let c = F[id];
    if (FVAR[id]) c = [c, ...FVAR[id].map(k => F[k])].filter(Boolean);
    // 同じ名前の空港手順の地点（海外空港の手順など）も候補にして、近いほうを使う
    const w0 = AP.waypoints[id];
    if (c && w0 && near) c = [...(Array.isArray(c) ? c : [c]), { lat: w0.lat, lon: w0.lon, type: w0.type }];
    if (!c) {
      const w = AP.waypoints[id];
      return w ? { id, lat: w.lat, lon: w.lon, type: w.type } : null;
    }
    if (Array.isArray(c)) c = near ? [...c].sort((x, y) => nm(x, near) - nm(y, near))[0] : c[0];
    return { id, ...c };
  }
  // 航空路の点は、航空路が持っているキー（同じ名前が離れた所にあるときは「名前~国コード」）の地点そのものを使う。
  // 名前だけで探すと、別の国の同じ名前の地点や空港手順の地点（例 SEPIA：沖縄と台北）を拾ってしまう
  const exactFix = id => (F[id] && !Array.isArray(F[id]) ? { id: base(id), ...F[id] } : null);
  const isAirway = t => t.split('/').some(a => VAR[a] || A[a]);
  const airwaysThrough = id => THROUGH[id] || [];
  /** 航空路（同じ名前が複数あるときは via を通るもの） */
  function getAirway(d, via = null) {
    const ks = VAR[base(d)] || (A[d] ? [d] : []);
    const k = (A[d] && d.includes('~') ? d : null) || (via && ks.find(x => IDX[x].has(via))) || ks[0];
    return k ? { designator: base(k), key: k, ...A[k] } : null;
  }
  function airwaySlice(d, from, to) {
    for (const k of VAR[base(d)] || [d]) {
      const ix = IDX[k];
      if (!ix || !ix.has(from) || !ix.has(to)) continue;
      const a = ix.get(from), b = ix.get(to), pts = A[k].points;
      return a <= b ? pts.slice(a, b + 1) : pts.slice(b, a + 1).reverse();
    }
    return null;
  }
  /** 同じ名前の航空路が国ごとに分かれている・途中でつながっている場合に、全体を1つの網として from→to の道筋を探す。
   *  国の AIP が未収録で途切れている区間（端どうしが 150NM 以内）は直行でつなぎ、gaps に記録する */
  function chainPath(keys, from, to) {
    const adj = new Map(), pos = new Map(), ends = [], keyOf = new Map();
    const node = id => { const b = base(id); if (!pos.has(b)) { const f = exactFix(id) || getFix(id) || getFix(b); if (f) { pos.set(b, f); keyOf.set(b, id); } } return b; };
    const link = (a, b, gap = false) => {
      if (!pos.has(a) || !pos.has(b) || a === b) return;
      const w = nm(pos.get(a), pos.get(b));
      (adj.get(a) || adj.set(a, []).get(a)).push({ b, w, gap });
      (adj.get(b) || adj.set(b, []).get(b)).push({ b: a, w, gap });
    };
    for (const k of keys) {
      const ids = A[k].points.map(node);
      for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
      ends.push(ids[0], ids.at(-1));
    }
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (pos.has(a) && pos.has(b) && nm(pos.get(a), pos.get(b)) <= 150 && !(adj.get(a) || []).some(e => e.b === b)) link(a, b, true);
    }
    const s = base(from), t = base(to);
    if (!adj.has(s) || !adj.has(t)) return null;
    const dist = new Map([[s, 0]]), back = new Map(), done = new Set();
    while (true) {
      let u = null, du = Infinity;
      for (const [k, v] of dist) if (!done.has(k) && v < du) { u = k; du = v; }
      if (u == null) return null;
      if (u === t) break;
      done.add(u);
      for (const e of adj.get(u) || []) {
        const nd = du + e.w * (e.gap ? 1.5 : 1);
        if (nd < (dist.get(e.b) ?? Infinity)) { dist.set(e.b, nd); back.set(e.b, { u, gap: e.gap }); }
      }
    }
    const ids = [t], gaps = [];
    for (let v = t; v !== s;) { const { u, gap } = back.get(v); if (gap) gaps.unshift([u, v]); ids.unshift(u); v = u; }
    return { ids, keys: ids.map(b => keyOf.get(b) || b), gaps };
  }
  /** 地点を前方一致で検索（入力補完用） */
  function searchFixes(prefix, limit = 12) {
    const p = String(prefix || '').toUpperCase();
    if (!p) return [];
    const out = [];
    for (const k of Object.keys(F)) if (k.startsWith(p)) { out.push(k); if (out.length >= limit) break; }
    return out;
  }

  // ================= 経路文字列 =================
  function tokenize(str) {
    let s = String(str || '').toUpperCase().replace(/,/g, ' ');
    s = s.replace(/\b([A-Z]{1,2}\d{1,4})([A-Z]{5})\b/g, '$1 $2');
    const t = s.split(/\s+/).map(x => x.replace(/^[()/]+|[()/]+$/g, '')).filter(x => x && x !== 'DCT');
    while (t.length && /^\d+$/.test(t.at(-1))) t.pop();
    return t;
  }
  const classifyTokens = str => tokenize(str).map(t => ({
    text: t, kind: isAirway(t) ? 'airway' : getFix(t) ? 'fix' : getAirport(t) ? 'airport' : 'unknown',
  }));
  function expandRoute(str) {
    const toks = tokenize(str), pts = [], errors = [], warnings = [], segments = [];
    const push = (p, via) => { if (!pts.length || pts.at(-1).id !== p.id) pts.push({ ...p, via }); };
    let prev = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i], alts = t.split('/').flatMap(a => VAR[a] || (A[a] ? [a] : []));
      if (alts.length) {
        const nxt = toks[i + 1];
        if (!prev || !nxt) { warnings.push(`航空路 ${t} の前後に地点がないため除外しました`); continue; }
        const aw = alts.find(a => IDX[a].has(prev.id) && IDX[a].has(nxt));
        let ch = null;
        if (aw) {
          for (const id of airwaySlice(aw, prev.id, nxt).slice(1)) push(exactFix(id) || getFix(id, prev) || { ...getFix(base(id), prev), id: base(id) }, base(aw));
          segments.push({ airway: base(aw), from: prev.id, to: nxt });
        } else if ((ch = chainPath(alts, prev.id, nxt))) {
          // 国ごとに分かれた同じ名前の航空路をつないで通る
          ch.ids.slice(1).forEach((id, k) => push(exactFix(ch.keys[k + 1]) || getFix(id, prev), base(alts[0])));
          for (const [a, b] of ch.gaps) warnings.push(`航空路 ${base(alts[0])} の ${a}–${b} は未収録の区間のため直行で接続しました`);
          segments.push({ airway: base(alts[0]), from: prev.id, to: nxt });
        } else {
          const a = alts.find(x => IDX[x].has(prev.id)) || alts[0];
          if (!IDX[a].has(prev.id)) errors.push(`${prev.id} は ${base(a)} 上にありません`);
          if (!IDX[a].has(nxt)) errors.push(`${nxt} は ${base(a)} 上にありません`);
          const f = getFix(nxt, prev);
          if (f) push(f, `${base(a)}?`);
        }
        prev = pts.at(-1) || prev; i++;
        continue;
      }
      const ap = getAirport(t);
      const f = getFix(t, prev) || (ap ? { id: ap.icao, lat: ap.arp.lat, lon: ap.arp.lon, type: 'airport' } : null);
      if (!f) {
        if (/^[A-Z]{1,3}\d{1,4}[A-Z]?$/.test(t) && !/^[A-Z]{2}\d{3}$/.test(t)) warnings.push(`航空路 ${t} は未収録（洋上経路など）のため直行で接続しました`);
        else errors.push(`地点 ${t} が見つかりません`);
        continue;
      }
      push(f, pts.length ? 'DCT' : null);
      prev = pts.at(-1);
    }
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += nm(pts[i - 1], pts[i]);
    return { points: pts, segments, errors, warnings, distanceNM: Math.round(d * 10) / 10 };
  }

  // ================= SID / STAR 自動選択 =================
  const procFixes = p => {
    const L = Object.values(p.runwayLegs || {}).map(lg => lg.filter(l => l.fix).map(l => l.fix));
    return L.length ? L : (p.approxRouteFixes ? [p.approxRouteFixes] : []);
  };
  function sidCandidates(dep, firstFix, runway = null) {
    const a = getAirport(dep); if (!a || !firstFix) return [];
    const out = [];
    for (const s of a.sids) if (rwyOk(s, runway) && procFixes(s).some(fx => fx.at(-1) === firstFix)) out.push({ sid: s.name, transition: null, runways: s.runways });
    for (const t of a.sidTransitions) {
      if (!procFixes(t).some(fx => fx.at(-1) === firstFix)) continue;
      for (const par of t.parents || []) {
        const s = a.sids.find(x => x.name === par);
        if (s && rwyOk(s, runway)) out.push({ sid: par, transition: t.name, runways: s.runways });
      }
    }
    return out;
  }
  function starCandidates(arr, lastFix, runway = null) {
    const a = getAirport(arr); if (!a || !lastFix) return [];
    return a.stars.filter(s => rwyOk(s, runway) && procFixes(s).some(fx => fx[0] === lastFix)).map(s => ({ star: s.name, runways: s.runways }));
  }
  const firstRwy = (p, a) => (p?.runways || []).find(r => r !== 'ALL' && a.runways.some(x => x.id === r)) || a.runways[0]?.id || null;

  /** 出発空港→SID→経路→STAR→到着空港 の全経路。sid/star 省略時は候補から自動選択 */
  function buildFullRoute({ dep, depRwy = null, sid = null, sidTransition = null, route, arr, arrRwy = null, star = null }) {
    const ex = expandRoute(route);
    const first = ex.points[0]?.id, last = ex.points.at(-1)?.id;
    const notes = [...ex.warnings], errors = [...ex.errors];
    const D = getAirport(dep), R = getAirport(arr);
    let depPts = [], arrPts = [];
    const isAp = c => /^[A-Z]{4}$/.test(c || '');
    if (dep && !D) notes.push(isAp(dep) ? `出発空港 ${dep} は空港DBにないため、経路の始点から表示します` : `国際線の入域（${dep}）の経路の始点から表示します`);
    if (arr && !R) notes.push(isAp(arr) ? `到着空港 ${arr} は空港DBにないため、経路の終点まで表示します` : `国際線の出域（${arr}）の経路の終点まで表示します`);
    if (D) {
      if (!sid) { const c = sidCandidates(D.icao, first, depRwy)[0]; if (c) { sid = c.sid; sidTransition = c.transition; } }
      const sp = sid && D.sids.find(s => s.name === sid);
      depRwy ||= firstRwy(sp, D);
      if (sp) {
        try { depPts = sidPoints(D.icao, depRwy, sid, sidTransition); } catch (e) { errors.push(e.message); }
      } else {
        if (D.station) notes.push(`${D.icao} は SID のデータがない空港のため、${first ? first + ' まで' : '到着空港まで'}直行で接続しました`);
        else if (first) notes.push(`${first} につながるSIDがないため、${D.icao} から直行で接続しました`);
        depPts = [{ id: D.icao, lat: D.arp.lat, lon: D.arp.lon, kind: 'airport' }];
      }
    }
    if (R) {
      if (!star) star = starCandidates(R.icao, last, arrRwy)[0]?.star || null;
      const st = star && R.stars.find(s => s.name === star);
      arrRwy ||= firstRwy(st, R);
      if (st) {
        try { arrPts = starPoints(R.icao, arrRwy, star); } catch (e) { errors.push(e.message); }
      } else {
        if (R.station) { if (last) notes.push(`${R.icao} は STAR のデータがない空港のため、${last} から直行で接続しました`); }
        else if (last) notes.push(`${last} から始まるSTARがないため、${R.icao} まで直行で接続しました`);
        arrPts = [{ id: R.icao, lat: R.arp.lat, lon: R.arp.lon, kind: 'airport' }];
      }
    }
    const points = [];
    for (const p of [...depPts, ...ex.points.map(p => ({ ...p, kind: 'ENROUTE' })), ...arrPts])
      if (!points.length || points.at(-1).id !== p.id) points.push(p);
    let d = 0;
    for (let i = 1; i < points.length; i++) { points[i].legNM = Math.round(nm(points[i - 1], points[i]) * 10) / 10; d += points[i].legNM; }
    return { dep: D?.icao, arr: R?.icao, depRwy, sid, sidTransition, arrRwy, star,
             route: tokenize(route).join(' '), points, distanceNM: Math.round(d), errors, notes };
  }

  // ================= 登録経路・自作経路 =================
  const norm = c => getAirport(c)?.icao || String(c || '').toUpperCase();
  function readStore() { try { return JSON.parse(store.getItem(STORE_KEY) || '[]'); } catch { return []; } }
  function writeStore(list) { try { store.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch { return false; } }
  const listCustomRoutes = () => readStore();
  function findRoutes(dep, dest, { category = null, includeCustom = true } = {}) {
    const d = dep && norm(dep), a = dest && norm(dest);
    return [...routeDb.routes, ...(includeCustom ? readStore() : [])]
      .filter(r => (!d || r.dep === d) && (!a || r.dest === a) && (!category || r.category === category));
  }
  function saveCustomRoute(rec) {
    const ex = expandRoute(rec.route);
    // 地点なし＝空港から空港への直行（出発・到着がどちらも空港のときだけ）
    const direct = !ex.points.length && !ex.errors.length && getAirport(rec.dep) && getAirport(rec.dest);
    if (!ex.points.length && !direct) return { ok: false, errors: ['経路が空です'] };
    if (ex.errors.length) return { ok: false, errors: ex.errors };
    const list = readStore();
    const id = rec.id || `USR-${norm(rec.dep)}-${norm(rec.dest)}-${Date.now().toString(36)}`;
    const item = {
      id, category: 'custom', source: 'user', dep: norm(rec.dep), dest: norm(rec.dest),
      name: rec.name || null, remarks: rec.remarks || null, route: direct ? 'DCT' : tokenize(rec.route).join(' '),
      fixes: ex.points.map(p => p.id), distanceNM: ex.distanceNM,
      depRwy: rec.depRwy || null, sid: rec.sid || null, sidTransition: rec.sidTransition || null,
      arrRwy: rec.arrRwy || null, star: rec.star || null,
      status: 'ok', warnings: ex.warnings, updated: new Date().toISOString(),
    };
    const i = list.findIndex(r => r.id === id);
    if (i >= 0) list[i] = item; else list.push(item);
    return { ok: true, route: item, persisted: writeStore(list) };
  }
  const deleteCustomRoute = id => writeStore(readStore().filter(r => r.id !== id));
  const exportCustomRoutes = () => JSON.stringify({ format: 'aeroweather-custom-routes', version: 1, routes: readStore() }, null, 2);
  function importCustomRoutes(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const incoming = (data.routes || data).filter(r => r && r.route);
    const list = readStore();
    for (const r of incoming) {
      const ex = expandRoute(r.route);
      const item = { ...r, id: r.id || `USR-${Date.now().toString(36)}-${list.length}`, category: 'custom',
                     fixes: ex.points.map(p => p.id), distanceNM: ex.distanceNM, status: ex.errors.length ? 'error' : 'ok' };
      const i = list.findIndex(x => x.id === item.id);
      if (i >= 0) list[i] = item; else list.push(item);
    }
    writeStore(list);
    return incoming.length;
  }

  return {
    nm, getAirport, listAirports, listProcedures, sidPoints, starPoints,
    getFix, isAirway, airwaysThrough, getAirway, airwaySlice, searchFixes,
    tokenize, classifyTokens, expandRoute, sidCandidates, starCandidates, buildFullRoute,
    findRoutes, listCustomRoutes, saveCustomRoute, deleteCustomRoute, exportCustomRoutes, importCustomRoutes,
    /** 空港DBにない空港を引く関数 fn(ICAO) → 空港（滑走路・SID・STAR は空） */
    setAirportFallback(fn) { airportFallback = fn; },
    data: { airportDb, navDb, routeDb },
  };
}
