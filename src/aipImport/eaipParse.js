// eAIP（各国の Web 版 AIP。EUROCONTROL の eAIP 形式＝韓国・台湾・タイ・ベトナム・マレーシア・シンガポール・香港など）の HTML から、
// アプリの航法データ（nav_db）と空港データ（airport_db）を作る（2026-10-18）
//   ・ENR 4.1（無線施設）・ENR 4.4（地点）・ENR 3.x（航空路）・AD 2（空港：ARP・標高・磁差・滑走路・公示距離・空港の無線施設）
//   ・国ごとの表の列の並びの違いに強いように、「座標の入ったセル」を手がかりに読む（列の番号を決め打ちしない）
//   ・tools/intl/*/xx_nav.py・kr/ad_generic.py（Python 版）と同じ考え方をブラウザで動くようにしたもの
//   ・SID・STAR・進入方式は、多くの国で図（PDF）にしかないため読まない（空港は滑走路まで。SID・STAR がないので経路とは直行で結ぶ）
//   ・ENR 2.1・5.x（空域）は図形の文章が国ごとに違うため、ここでは読まない
const R_NM = 3440.065;
export const nmBetween = (a, b) => {
  const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(h));
};

// ---------- 文字・座標 ----------
const txt = el => (el?.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
// 例：372748.60N 1262625.40E ／ 372748N1262625E ／ 37°27'48.60"N 126°26'25.40"E ／ 37 27 48.60N 126 26 25.40E
// 経度の E/W の直後は小文字でなければよい（「0940800.00ECentre of …」のように説明が続くことがある）
const CO1 = /(?<!\d)(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?\s*([NS])\s*\/?\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?\s*([EW])(?![a-z])/g;
const CO2 = /(?<![\d.])(\d{1,2})\s*[°\s]\s*(\d{1,2})\s*['′\s]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([NS])[\s,/]*(\d{1,3})\s*[°\s]\s*(\d{1,2})\s*['′\s]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([EW])(?![A-Za-z])/g;
export function coords(t) {
  const s = String(t || '').replace(/ /g, ' '), out = [];
  for (const re of [CO1, CO2]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const la = +m[1] + +m[2] / 60 + +(m[3] || 0) / 3600, lo = +m[5] + +m[6] / 60 + +(m[7] || 0) / 3600;
      if (la > 90 || lo > 180) continue;
      out.push({ at: m.index, lat: +(m[4] === 'S' ? -la : la).toFixed(6), lon: +(m[8] === 'W' ? -lo : lo).toFixed(6) });
    }
    if (out.length) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 改訂で消された記述（取り消し線）や、画面に出ない参照を取り除く */
function clean(doc) {
  doc.querySelectorAll('del, .AmdtDeleted, [class*="AmdtDeleted"], [id$="_Deleted"], .sdParams, script, style').forEach(e => e.remove());
  return doc;
}
const rows = doc => [...doc.querySelectorAll('tr')].map(r => [...r.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(txt));

// ---------- どの章か ----------
/** ファイル名・題名・見出しから章を決める。{ kind:'ENR'|'AD', no:'4.1'|'3.3'|'2', icao? } */
export function detectSection(name, doc) {
  const from = s => {
    const m = /\b(ENR|AD)[\s_-]*([0-9](?:[._][0-9]{1,2})?)(?:[._\s-]+([A-Z]{4}))?/i.exec(s || '');
    if (!m) return null;
    const no = m[2].replace('_', '.'), kind = m[1].toUpperCase();
    if (kind === 'AD' && !/^2(\.|$)/.test(no)) return null;
    return { kind, no: kind === 'AD' ? '2' : no, icao: m[3] && /^[A-Z]{4}$/i.test(m[3]) ? m[3].toUpperCase() : null };
  };
  let s = from(name.replace(/\.(html?|xhtml)$/i, ''));
  const title = txt(doc.querySelector('title'));
  s ||= from(title);
  if (!s) for (const h of doc.querySelectorAll('h1,h2,h3,h4')) { s = from(txt(h)); if (s) break; }
  if (s?.kind === 'AD' && !s.icao) {
    const m = /\b([A-Z]{4})\s+AD\s*2/.exec(title + ' ' + [...doc.querySelectorAll('h1,h2,h3,h4')].slice(0, 6).map(txt).join(' '));
    if (m) s.icao = m[1];
  }
  return s;
}

// ---------- ENR 4.1 無線施設 ----------
const NAVTYPE = /\b(DVOR\/DME|VOR\/DME|DVORTAC|VORTAC|DVOR|VOR|TACAN|NDB\/DME|NDB|DME|LOC|ILS)\b/;
function parseNavaids(doc, cc, fixes, rep) {
  let n = 0;
  for (const c of rows(doc)) {
    if (c.length < 3) continue;
    const ci = c.findIndex(x => coords(x).length); if (ci < 0) continue;
    const id = c.slice(1, ci).find(x => /^[A-Z]{2,4}$/.test(x)) || c.slice(0, ci).find(x => /^[A-Z]{2,4}$/.test(x)); if (!id) continue;
    const head = c[0], ty = NAVTYPE.exec(c.slice(0, ci).join(' '));
    const freq = c.slice(1, ci + 1).map(x => /(\d{2,4}(?:\.\d{1,3})?)\s*(MHZ|KHZ)/i.exec(x)).find(Boolean);
    const { lat, lon } = coords(c[ci])[0];
    // 名前のセルに磁差が一緒に書かれていることがある（「Arvaikheer DME 3°W / 2025」。モンゴル）
    const nm0 = head.replace(/\d+(?:\.\d+)?\s*°\s*[EW](?:\s*\/\s*\d{4})?/g, '');
    fixes[id] = { lat, lon, type: 'navaid', name: nm0.replace(NAVTYPE, '').replace(/\(.*?\)/g, '').replace(/[\/\s]+$/, '').trim().toUpperCase() || id,
      navaidType: ty ? ty[1] : '', freq: freq ? freq[1] + (freq[2].toUpperCase() === 'KHZ' ? 'kHz' : 'MHz') : '', country: cc };
    n++;
  }
  rep.push(`ENR 4.1 無線施設 ${n}`);
}
// ---------- ENR 4.4 地点 ----------
function parsePoints(doc, cc, fixes, rep) {
  let n = 0;
  for (const c of rows(doc)) {
    const ci = c.findIndex(x => coords(x).length); if (ci < 0) continue;
    const nameCell = (ci === 0 ? c[0].slice(0, coords(c[0])[0].at) : c[0]).replace(/[▲△]/g, ' ');
    const m = /^\s*([A-Z][A-Z0-9]{1,4})\b/.exec(nameCell); if (!m) continue;
    const { lat, lon } = coords(c[ci])[0];
    if (!fixes[m[1]]) { fixes[m[1]] = { lat, lon, type: 'waypoint', country: cc }; n++; }
  }
  rep.push(`ENR 4.4 地点 ${n}`);
}
// ---------- ENR 3.x 航空路 ----------
//   航空路名の行（座標のない短い行、または見出し）で「今の航空路」を決め、座標のある行を地点として順に足す。▲は義務通報点
const DES = /^(?:U?[A-Z]{1,2}\d{1,4}[A-Z]?)$/;
const RNAV_LETTER = /^U?[LMNPQTYZ]/;
function parseRoutes(doc, cc, fixes, airways, rep) {
  const found = {};
  let cur = null;
  const start = name => { cur = { name, points: [], compulsory: [] }; (found[name] ||= []).push(cur); };
  // 見出し・表題・行を文書の順にたどる
  const els = [...doc.querySelectorAll('h1,h2,h3,h4,h5,caption,tr')];
  for (const el of els) {
    if (el.tagName !== 'TR') {
      const m = /^(?:ENR\s*3\.\d+\s*)?(U?[A-Z]{1,2}\d{1,4}[A-Z]?)\b/.exec(txt(el));
      if (m && DES.test(m[1]) && !coords(txt(el)).length) start(m[1]);
      continue;
    }
    if (el.closest('tr') !== el) continue;
    const c = [...el.children].filter(x => /^(TD|TH)$/.test(x.tagName)).map(txt);
    if (!c.length) continue;
    const all = c.join(' ');
    const ci = c.findIndex(x => coords(x).length);
    if (ci < 0) {
      const m = /^\s*(U?[A-Z]{1,2}\d{1,4}[A-Z]?)\b/.exec(c[0]);
      // 航空路名の行：名前のほかのセルがほとんど空（備考「For continuation, see …」が1つ付くことがある。モンゴル）
      if (m && DES.test(m[1]) && (c.length <= 4 || c.slice(1).filter(Boolean).length <= 1) && c[0].length < 40) start(m[1]);
      continue;
    }
    if (!cur) continue;
    // 地点名：座標のセルの座標より前の文字、なければ前のセル。「(ABC)」は無線施設の識別符号
    const co = coords(c[ci])[0];
    const before = [c[ci].slice(0, co.at), ...c.slice(0, ci).reverse()].join(' ');
    const pm = /\(\s*([A-Z]{2,3})\s*\)/.exec(before) || /NAV-[A-Z]+-([A-Z]{2,3})\b/.exec(before);
    const nm = pm ? pm[1] : /\b([A-Z][A-Z0-9]{1,4})\b(?![^(]*\))/.exec(before.replace(/[▲△]/g, ' '))?.[1];
    if (!nm) continue;
    if (!fixes[nm]) fixes[nm] = { lat: co.lat, lon: co.lon, type: 'waypoint', country: cc };
    if (cur.points.at(-1) !== nm) cur.points.push(nm);
    if (/▲/.test(c.slice(0, ci + 1).join(' '))) cur.compulsory.push(nm);
  }
  let n = 0;
  for (const [d, lst0] of Object.entries(found)) {
    const lst = lst0.filter(x => x.points.length >= 2); if (!lst.length) continue;
    let pts = lst[0].points;
    for (const x of lst.slice(1)) {                            // 同じ名前が分かれて載っているときは端でつなぐ
      if (x.points[0] === pts.at(-1)) pts = [...pts, ...x.points.slice(1)];
      else if (x.points.at(-1) === pts[0]) pts = [...x.points.slice(0, -1), ...pts];
      else pts = [...pts, ...x.points];
    }
    lst.forEach(x => x.compulsory.forEach(f => { if (fixes[f]) fixes[f].reporting = 'COMPULSORY'; }));
    const seg = pts.slice(1).map((p, i) => ({ nm: +nmBetween(fixes[pts[i]], fixes[p]).toFixed(1) }));
    airways[d] = { type: RNAV_LETTER.test(d) ? 'RNAV' : 'CONVENTIONAL', points: pts, segments: seg, country: cc };
    n++;
  }
  return n;
}

// ---------- AD 2 空港 ----------
const ftOf = s => { const m = /([\d.,]+)\s*(FT|ft|M\b|m\b)/.exec(s || ''); if (!m) return null; const v = +m[1].replace(/,/g, ''); return /m/i.test(m[2]) ? +(v * 3.28084).toFixed(1) : v; };
function adSections(doc) {
  const out = {}; let cur = null;
  for (const el of doc.querySelectorAll('h2,h3,h4,h5,table')) {
    if (el.tagName !== 'TABLE') { const m = /AD\s*2\.(\d+)\b/.exec(txt(el)); if (m) cur = +m[1]; continue; }
    if (cur == null || el.querySelector('table')) continue;
    (out[cur] ||= []).push(...[...el.querySelectorAll('tr')].map(r => [...r.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(txt)));
  }
  return out;
}
function parseAirport(doc, icao, cc, meta) {
  const S = adSections(doc), head = [...doc.querySelectorAll('h1,h2,h3,h4,title')].map(txt).join(' \n ');
  const nameM = new RegExp(`${icao}\\s*[—–-]+\\s*([^\\n]+?)(?:\\s+AD\\s*2|\\s*\\n|$)`).exec(head + ' \n ' + (S[1] || []).flat().join(' \n '));
  const nameEn = (nameM ? nameM[1] : icao).replace(/\s+/g, ' ').trim();
  const a = { icao, iata: '', nameEn, nameAip: nameEn.toUpperCase(), nameJa: meta.kanji?.[icao] || nameEn, city: meta.countryName || '', country: cc,
    aipEffective: meta.eff || '', runways: [], localNavaids: [], transitionAltitudeFt: null, sids: [], stars: [], sidTransitions: [], starTransitions: [], approaches: [],
    source: 'aip-import' };
  for (const r of S[2] || []) {
    const [lab, val] = r.length >= 3 ? [r[1], r.slice(2).join(' ')] : r.length === 2 ? r : ['', ''];
    if (/ARP/.test(lab) && coords(val).length) { const c = coords(val)[0]; a.arp = { lat: c.lat, lon: c.lon }; }
    else if (/levation/i.test(lab) && !/eoid/i.test(lab)) a.elevationFt = ftOf(val);
    else if (/VAR/i.test(lab) && /°/.test(val)) {
      const m = /([\d.]+)\s*°\s*(?:(\d+)\s*['′]\s*)?([WE])/.exec(val);
      if (m) a.magVar = (m[3] === 'W' ? -1 : 1) * +(+m[1] + +(m[2] || 0) / 60).toFixed(2);
    }
  }
  for (const r of S[17] || []) if (r.length >= 3 && /ransition/.test(r[1])) { const v = /([\d ,]+)\s*(?:ft|FT)/.exec(r[2]); if (v) a.transitionAltitudeFt = +v[1].replace(/\D/g, ''); }
  for (const r0 of S[12] || []) {
    const rid = /^(?:RWY\s*)?(\d{2}[LRC]?)\b/.exec(r0[0] || ''); if (!rid || r0.length < 4) continue;
    const cs = r0.map(coords).find(x => x.length); if (!cs) continue;
    if (a.runways.some(x => x.id === rid[1])) continue;
    const b = /(\d{3}(?:\.\d+)?)\s*°?\s*(?:T|GEO|TRUE)?/.exec(r0[1] || ''), dim = /(\d[\d ,]*)\s*m?\s*[x×]\s*(\d+)/i.exec(r0.slice(1, 4).join(' '));
    a.runways.push({ id: rid[1], trueBearing: b ? +b[1] : null, lengthM: dim ? +dim[1].replace(/\D/g, '') : null, widthM: dim ? +dim[2] : null,
      threshold: { lat: cs[0].lat, lon: cs[0].lon }, thresholdElevFt: r0.slice(4).filter(x => !coords(x).length).map(ftOf).find(v => v != null) ?? null });
  }
  const dec = {};
  for (const r of S[13] || []) {
    const rid = /^(?:RWY\s*)?(\d{2}[LRC]?)\b/.exec(r[0] || ''); if (!rid || dec[rid[1]] || r.length < 5) continue;
    const nums = r.slice(1).filter(x => /^\d[\d ,]{2,6}$/.test(x)).slice(0, 4).map(x => +x.replace(/\D/g, ''));
    if (nums.length === 4) dec[rid[1]] = { TORA: nums[0], TODA: nums[1], ASDA: nums[2], LDA: nums[3] };
  }
  for (const r of a.runways) {
    r.declared = dec[r.id] || {};
    const rec = String((+r.id.slice(0, 2) + 17) % 36 + 1).padStart(2, '0') + ({ L: 'R', R: 'L', C: 'C' }[r.id[2]] || '');
    const o = a.runways.find(x => x.id === rec);
    if (o) { r.reciprocal = rec; r.departureEnd = o.threshold; }
    // 表のセルが結合されていて、反対側の滑走路の行に長さ・幅がないとき
    if (o && r.lengthM == null) { r.lengthM = o.lengthM; r.widthM = o.widthM; }
  }
  for (const r of S[19] || []) {
    const idx = r.slice(0, 3).findIndex(x => /^[A-Z]{2,4}$/.test(x)), co = r.map(coords).find(x => x.length);
    if (idx < 0 || !co || a.localNavaids.some(n => n.id === r[idx])) continue;
    const ty = /(DVOR\/DME|VOR\/DME|VORTAC|LOC|DME|GP|NDB|TACAN|DVOR|VOR)/.exec(r[0]);
    a.localNavaids.push({ type: ty ? ty[1] : 'NAVAID', id: r[idx], freq: (r[idx + 1] || '').replace(/\s/g, '').slice(0, 16), lat: co[0].lat, lon: co[0].lon });
  }
  // ARP が読めないときは滑走路の端の真ん中
  if (!a.arp && a.runways.length) {
    const ps = a.runways.map(r => r.threshold);
    a.arp = { lat: +(ps.reduce((s, p) => s + p.lat, 0) / ps.length).toFixed(6), lon: +(ps.reduce((s, p) => s + p.lon, 0) / ps.length).toFixed(6) };
  }
  return a;
}

/** 有効日（AIRAC）を文書から探す */
function effDate(doc) {
  const t = txt(doc.body).slice(0, 4000) + ' ' + txt(doc.querySelector('title'));
  const m = /(?:EFF(?:ECTIVE)?(?:\s+DATE)?|AIRAC)[^0-9]{0,20}(\d{1,2})\s*([A-Z]{3})\s*(\d{2,4})/i.exec(t) || /(20\d{2})-(\d{2})-(\d{2})-AIRAC/.exec(t);
  if (!m) return '';
  if (/^20\d{2}$/.test(m[1])) return `${m[1]}-${m[2]}-${m[3]}`;
  const mon = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }[m[2].toUpperCase()];
  if (!mon) return '';
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return `${y}-${String(mon).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

/**
 * HTML のファイル群を読む
 * @param files [{ name, text }]（eAIP の各ページの HTML）
 * @param opt   { code（国コード2文字）, countryName, kanji（{ICAO: 漢字の名前}） }
 * @returns { nav:{fixes,airways}, airports:{airports,waypoints,index}, report:{ used:[], skipped:[], lines:[], warnings:[], eff } }
 */
export function parseEaip(files, { code, countryName = '', kanji = {} } = {}) {
  const cc = code.toUpperCase(), fixes = {}, airways = {}, airports = {}, lines = [], warnings = [], used = [], skipped = [];
  const docs = [];
  let eff = '';
  for (const f of files) {
    let doc;
    try { doc = clean(new DOMParser().parseFromString(f.text, 'text/html')); } catch { skipped.push(`${f.name}（読めない）`); continue; }
    const s = detectSection(f.name, doc);
    if (!s || !(s.kind === 'AD' || ['4.1', '4.4'].includes(s.no) || /^3\.\d$/.test(s.no))) { skipped.push(f.name); continue; }
    docs.push({ f, doc, s }); eff ||= effDate(doc);
  }
  // 無線施設 → 地点 → 航空路 の順（航空路の地点は、先に読んだ座標を使う）
  const order = d => (d.s.kind === 'ENR' ? { '4.1': 0, '4.4': 1 }[d.s.no] ?? 2 : 3);
  docs.sort((a, b) => order(a) - order(b));
  let nRoutes = 0;
  for (const { f, doc, s } of docs) {
    used.push(`${f.name} → ${s.kind} ${s.no}${s.icao ? ' ' + s.icao : ''}`);
    if (s.kind === 'ENR' && s.no === '4.1') parseNavaids(doc, cc, fixes, lines);
    else if (s.kind === 'ENR' && s.no === '4.4') parsePoints(doc, cc, fixes, lines);
    else if (s.kind === 'ENR') nRoutes += parseRoutes(doc, cc, fixes, airways, lines);
    else if (s.kind === 'AD') {
      if (!s.icao) { warnings.push(`${f.name}：空港の ICAO コードが分かりません`); continue; }
      const a = parseAirport(doc, s.icao, cc, { eff, countryName, kanji });
      if (!a.arp) { warnings.push(`${s.icao}：空港の位置（ARP）が読めませんでした`); continue; }
      if (!a.runways.length) warnings.push(`${s.icao}：滑走路（AD 2.12）が読めませんでした`);
      airports[s.icao] = a;
    }
  }
  if (nRoutes) lines.push(`ENR 3 航空路 ${nRoutes}`);
  if (Object.keys(airports).length) lines.push(`AD 2 空港 ${Object.keys(airports).length}（${Object.values(airports).map(a => `${a.icao} 滑走路${a.runways.length}`).join('・')}）`);
  // 確かめ：航空路の区間が極端に長い（読み違いの疑い）
  for (const [d, a] of Object.entries(airways)) {
    const long = a.segments.findIndex(s => s.nm > 600);
    if (long >= 0) warnings.push(`${d}：${a.points[long]}–${a.points[long + 1]} が ${a.segments[long].nm}NM（読み違いの可能性）`);
  }
  if (!docs.length) warnings.push('ENR 3.x・4.1・4.4、AD 2 のページが見つかりませんでした（ファイル名か見出しに「ENR 4.1」「AD 2」などが必要です）');
  return {
    nav: { meta: { title: `${countryName || cc} 航法データ（AIP 取り込み）`, aipEffective: eff }, fixes, airways },
    airports: { meta: { title: `${countryName || cc} 空港データ（AIP 取り込み）`, country: cc }, airports, waypoints: {}, index: { byIata: {} } },
    report: { used, skipped, lines, warnings, eff },
  };
}
