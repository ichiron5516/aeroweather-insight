// METAR / TAF のデコードと、空港ごとの「今後の気象解説」（ルールベース）

const WX = {
  TS: '雷電', SH: 'しゅう雨性の', FZ: '着氷性の', BL: '高い地ふぶき', DR: '低い地ふぶき', MI: '浅い', BC: '散在する', PR: '部分的な', VC: '周辺の',
  RA: '雨', SN: '雪', DZ: '霧雨', GR: 'ひょう', GS: '雪あられ', PL: '凍雨', SG: '霧雪', IC: '細氷', UP: '不明の降水',
  FG: '霧', BR: 'もや', HZ: '煙霧', FU: '煙', SA: '砂', DU: 'ちり', VA: '火山灰', SQ: 'スコール', FC: 'たつまき', PO: '塵旋風', DS: '砂じんあらし', SS: '砂あらし',
};

export function decodeWx(code) {
  const m = /^([+-]|VC)?([A-Z]{2,})$/.exec(code);
  if (!m) return code;
  let s = m[2], out = '';
  const parts = [];
  while (s.length) { parts.push(s.slice(0, 2)); s = s.slice(2); }
  for (const p of parts) out += WX[p] || p;
  const inten = m[1] === '+' ? '強い' : m[1] === '-' ? '弱い' : m[1] === 'VC' ? '周辺の' : '';
  return inten + out;
}

/** 天気・雲・視程などの要素（METAR本文とTAFの各グループ共通） */
function parseElements(tokens) {
  const e = { wx: [], clouds: [] };
  for (const t of tokens) {
    let m;
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(t))) {
      const k = m[4] === 'MPS' ? 1.944 : 1;
      e.wind = { dir: m[1] === 'VRB' ? null : +m[1], spd: Math.round(+m[2] * k), gust: m[3] ? Math.round(+m[3] * k) : null };
    } else if (t === 'CAVOK') { e.vis = 10000; e.cavok = true; }
    else if (/^\d{4}$/.test(t) && e.vis == null) e.vis = +t;
    else if ((m = /^(\d+)SM$/.exec(t))) e.vis = Math.round(+m[1] * 1609);
    else if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(t))) e.clouds.push({ cov: m[1], ft: +m[2] * 100, type: m[3] || null });
    else if (t === 'NSC' || t === 'SKC' || t === 'CLR' || t === 'NCD') e.noCloud = true;
    else if (t === 'NSW') e.nsw = true;
    else if (/^([+-]|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+$/.test(t) || /^([+-]|VC)?TS$/.test(t)) e.wx.push(t);
    else if ((m = /^(M?\d{2})\/(M?\d{2})$/.exec(t))) { e.temp = +m[1].replace('M', '-'); e.dew = +m[2].replace('M', '-'); }
    else if ((m = /^Q(\d{4})$/.exec(t))) e.qnh = +m[1];
    else if ((m = /^A(\d{4})$/.exec(t))) e.qnh = Math.round(+m[1] / 100 * 33.8639);
  }
  const ceil = e.clouds.filter(c => ['BKN', 'OVC', 'VV'].includes(c.cov)).map(c => c.ft);
  e.ceiling = ceil.length ? Math.min(...ceil) : (e.cavok || e.noCloud ? null : undefined);
  return e;
}

/** フライトカテゴリ（視程とシーリング） */
export function category(e) {
  const v = e.vis ?? 10000, c = e.ceiling ?? 99999;
  if (v < 1600 || c < 500) return 'LIFR';
  if (v < 4800 || c < 1000) return 'IFR';
  if (v <= 8000 || c <= 3000) return 'MVFR';
  return 'VFR';
}
export const CAT_JA = { VFR: '有視界(VFR)', MVFR: 'やや悪い(MVFR)', IFR: '計器気象(IFR)', LIFR: '悪い(LIFR)' };
const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

export function parseMetar(raw) {
  const tk = raw.replace(/=$/, '').trim().split(/\s+/);
  let i = 0;
  if (/^(METAR|SPECI)$/.test(tk[0])) i++;
  const icao = tk[i++];
  const tm = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tk[i] || '');
  if (tm) i++;
  const body = [];
  for (; i < tk.length; i++) { if (/^(RMK|NOSIG|BECMG|TEMPO)$/.test(tk[i])) break; body.push(tk[i]); }
  const e = parseElements(body);
  return { raw, icao, day: tm ? +tm[1] : null, hhmm: tm ? tm[2] + tm[3] : null, ...e, cat: category(e), speci: /^SPECI/.test(raw) };
}

/** TAF を基本予報と変化グループに分解 */
export function parseTaf(raw) {
  const s = raw.replace(/\s+/g, ' ').replace(/=$/, '').trim();
  const tk = s.split(' ');
  let i = 0;
  while (/^(TAF|AMD|COR)$/.test(tk[i])) i++;
  const icao = tk[i++];
  if (/^\d{6}Z$/.test(tk[i])) i++;
  const vp = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tk[i] || '');
  if (vp) i++;
  const groups = [];
  let cur = { type: 'BASE', from: vp ? [+vp[1], +vp[2]] : null, to: vp ? [+vp[3], +vp[4]] : null, tokens: [] };
  for (; i < tk.length; i++) {
    const t = tk[i];
    let m;
    if (/^(BECMG|TEMPO)$/.test(t) || /^PROB\d{2}$/.test(t) || /^FM\d{6}$/.test(t)) {
      groups.push(cur);
      if ((m = /^FM(\d{2})(\d{2})(\d{2})$/.exec(t))) { cur = { type: 'FM', from: [+m[1], +m[2]], to: null, tokens: [] }; continue; }
      let type = t;
      if (/^PROB/.test(t) && tk[i + 1] === 'TEMPO') { type = t + ' TEMPO'; i++; }
      cur = { type, from: null, to: null, tokens: [] };
      const p = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tk[i + 1] || '');
      if (p) { cur.from = [+p[1], +p[2]]; cur.to = [+p[3], +p[4]]; i++; }
      continue;
    }
    if (/^(RMK|TX|TN)/.test(t)) continue;
    cur.tokens.push(t);
  }
  groups.push(cur);
  // FM は次のグループの開始まで
  groups.forEach((g, k) => { if (g.type === 'FM' && !g.to) g.to = groups.slice(k + 1).find(x => x.type === 'FM' || x.type === 'BASE')?.from || (vp ? [+vp[3], +vp[4]] : null); });
  return { raw, icao, groups: groups.map(g => { const e = parseElements(g.tokens); return { ...g, ...e, cat: category(e) }; }) };
}

// ---------------- 文章化 ----------------
const fmtDH = d => (d ? `${String(d[0]).padStart(2, '0')}日${String(d[1]).padStart(2, '0')}Z` : '');
const jst = d => (d ? `${String((d[1] + 9) % 24).padStart(2, '0')}時JST` : '');
export function windText(w) {
  if (!w) return '';
  if (w.spd === 0) return '静穏';
  return `${w.dir == null ? '風向不定' : String(w.dir).padStart(3, '0') + '°'} ${w.spd}kt${w.gust ? `（最大瞬間 ${w.gust}kt）` : ''}`;
}
const visText = v => (v == null ? '' : v >= 9999 ? '10km以上' : v >= 5000 ? `${(v / 1000).toFixed(0)}km` : `${v}m`);
const cloudText = e => (e.cavok ? 'CAVOK' : e.clouds.length ? e.clouds.map(c => `${c.cov} ${c.ft}ft${c.type ? '(' + c.type + ')' : ''}`).join('・') : e.noCloud ? '雲なし' : '');
export function elementsText(e) {
  return [windText(e.wind), e.vis != null ? '視程' + visText(e.vis) : '', e.wx.map(decodeWx).join('・'), cloudText(e),
    e.ceiling ? `シーリング${e.ceiling}ft` : ''].filter(Boolean).join('、');
}

/** 滑走路ごとの向かい風・横風（風向は真方位、滑走路も真方位） */
export function runwayWinds(runways, wind) {
  if (!wind || wind.dir == null) return [];
  const spd = Math.max(wind.spd, wind.gust || 0);
  return runways.map(r => {
    const a = (wind.dir - r.trueBearing) * Math.PI / 180;
    return { id: r.id, head: Math.round(spd * Math.cos(a)), cross: Math.round(Math.abs(spd * Math.sin(a))) };
  });
}

/**
 * 今後の気象解説を作る。
 * airport: 空港DBの1件、metars: 新しい順の METAR 文字列配列、taf: TAF 文字列
 * 返り値: { now:[], trend:[], forecast:[], cautions:[] }（それぞれ文の配列）
 */
export function briefing(airport, metars, taf) {
  const out = { now: [], trend: [], forecast: [], cautions: [] };
  const M = metars.map(parseMetar).filter(m => m.icao);
  const latest = M[0];
  if (latest) {
    out.now.push(`${latest.hhmm ? latest.hhmm.slice(0, 2) + ':' + latest.hhmm.slice(2) + 'Z' : ''}の実況は ${elementsText(latest) || '要素なし'}。`);
    const extra = [latest.temp != null ? `気温${latest.temp}℃・露点${latest.dew}℃` : '', latest.qnh ? `QNH ${latest.qnh}hPa` : ''].filter(Boolean).join('、');
    out.now.push(`${CAT_JA[latest.cat]}。${extra}${extra ? '。' : ''}`);
    if (latest.temp != null && latest.dew != null && latest.temp - latest.dew <= 2 && !latest.wx.some(w => /FG|BR/.test(w)))
      out.now.push('気温と露点の差が2℃以内で、霧・低い雲が出やすい状態です。');
  } else out.now.push('METAR を取得できませんでした。');

  if (M.length >= 2) {
    const old = M[M.length - 1];
    if (latest.qnh && old.qnh) {
      const d = latest.qnh - old.qnh;
      const mins = x => (x.day || 0) * 1440 + +x.hhmm.slice(0, 2) * 60 + +x.hhmm.slice(2);
      let hrs = latest.hhmm && old.hhmm ? (mins(latest) - mins(old)) / 60 : 6;
      if (hrs < 0) hrs += 24 * 30;   // 月をまたいだ場合
      out.trend.push(`気圧（QNH）は約${Math.round(hrs)}時間で ${d > 0 ? '+' : ''}${d}hPa${Math.abs(d) >= 3 ? '（変化が大きく、低気圧・前線の接近や通過が考えられます）' : ''}。`);
    }
    const worst = M.reduce((a, b) => (CAT_RANK[b.cat] > CAT_RANK[a.cat] ? b : a));
    if (worst.cat !== 'VFR') out.trend.push(`この6時間で最も悪かったのは ${worst.hhmm}Z の ${CAT_JA[worst.cat]}（${elementsText(worst)}）。`);
    else out.trend.push('この6時間はおおむね良好（VFR）でした。');
    const gusts = M.filter(m => m.wind?.gust);
    if (gusts.length) out.trend.push(`ガストを ${gusts.length} 回観測（最大 ${Math.max(...gusts.map(m => m.wind.gust))}kt）。`);
    const specis = M.filter(m => m.speci).length;
    if (specis) out.trend.push(`SPECI（特別観測）が ${specis} 回出ており、天気が急変しています。`);
  }

  if (taf) {
    const T = parseTaf(taf);
    const base = T.groups[0];
    out.forecast.push(`TAF（${fmtDH(base.from)}〜${fmtDH(base.to)}）の基本予報は ${elementsText(base)}、${CAT_JA[base.cat]}。`);
    for (const g of T.groups.slice(1)) {
      const when = `${fmtDH(g.from)}${g.to ? '〜' + fmtDH(g.to) : ''}（${jst(g.from)}〜）`;
      const kind = g.type === 'BECMG' ? 'しだいに' : g.type === 'TEMPO' ? '一時' : /PROB/.test(g.type) ? `${g.type.slice(4, 6)}%の確率で${/TEMPO/.test(g.type) ? '一時' : ''}` : g.type === 'FM' ? '以降' : '';
      const txt = elementsText(g) || (g.nsw ? '顕著な天気なし' : '');
      out.forecast.push(`${when} ${kind} ${txt}${g.vis != null || g.clouds.length ? `（${CAT_JA[g.cat]}）` : ''}。`);
      if (CAT_RANK[g.cat] >= 2 && (g.vis != null || g.clouds.length)) out.cautions.push(`${when} ${kind}${CAT_JA[g.cat]}の予想。進入方式の最低気象条件と代替空港を確認。`);
      if (g.wx.some(w => /TS/.test(w)) || g.clouds.some(c => c.type === 'CB')) out.cautions.push(`${when} 雷雨（CB）の予想。離着陸の遅延・待機や、空域の迂回に注意。`);
      if (g.wx.some(w => /SN|FZ|PL/.test(w))) out.cautions.push(`${when} 雪・着氷性の降水の予想。滑走路状態（ブレーキングアクション）と防除氷に注意。`);
    }
    // 予報期間の最大の風で横風を見る
    const winds = T.groups.map(g => g.wind).filter(Boolean);
    const maxW = winds.reduce((a, b) => (Math.max(b.spd, b.gust || 0) > Math.max(a?.spd || 0, a?.gust || 0) ? b : a), null);
    if (maxW && maxW.dir != null) {
      const rw = runwayWinds(airport.runways || [], maxW).sort((a, b) => b.head - a.head);
      const best = rw[0];
      // 滑走路のデータがない空港（METAR・TAF だけの空港）は風だけを書く
      out.forecast.push(best ? `予報期間で最も強い風は ${windText(maxW)}。この風では RWY${best.id} が向かい風 ${best.head}kt・横風 ${best.cross}kt です。` : `予報期間で最も強い風は ${windText(maxW)}。`);
      if (best && best.cross >= 20) out.cautions.push(`横風 ${best.cross}kt の予想（RWY${best.id}）。機種の横風制限を確認。`);
      if (Math.max(maxW.spd, maxW.gust || 0) >= 30) out.cautions.push(`強風（${windText(maxW)}）の予想。ウィンドシア・乱気流に注意。`);
    }
  } else out.forecast.push('TAF を取得できませんでした（TAF が発表されていない空港の可能性があります）。');

  if (latest?.wind?.dir != null) {
    const rw = runwayWinds(airport.runways || [], latest.wind).sort((a, b) => b.head - a.head)[0];
    if (rw) out.now.push(`現在の風では RWY${rw.id} が向かい風 ${rw.head}kt・横風 ${rw.cross}kt。`);
  }
  if (!out.cautions.length) out.cautions.push('TAF の範囲では、大きな注意事項は見当たりません。');
  return out;
}
