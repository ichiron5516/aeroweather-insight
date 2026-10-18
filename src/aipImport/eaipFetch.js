// eAIP を URL から読む（2026-10-18）
//   eAIP のサイトはブラウザから直接読めない（CORS）ことが多いので、中継を通す：
//     開発時（npm run dev）… vite.config.js の /aipfetch（Vite の中で読む）
//     公開サイト … tools/wx-proxy-worker.js の /aip（Cloudflare Workers。VITE_WX_PROXY）
//   入れる URL は eAIP のどのページでもよい（例 https://aip.caat.or.th/2026-10-29-AIRAC/html/index-en-GB.html、…/eAIP/VT-ENR-4.1-en-GB.html）。
//   目次（eAIP/{国}-menu-{言語}.html）から ENR 3.x・4.1・4.4 と AD 2（空港ごと）のページを探す。zip の URL ならそのまま読む
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
function relays() {
  const env = import.meta.env || {}, out = [];
  if (env.DEV) out.push(u => `${BASE}aipfetch?url=${encodeURIComponent(u)}`);
  if (env.VITE_WX_PROXY) out.push(u => `${String(env.VITE_WX_PROXY).replace(/\/$/, '')}/aip?url=${encodeURIComponent(u)}`);
  out.push(u => u);                                               // 中継がないときは直接（CORS を許しているサイトだけ読める）
  return out;
}
let good = null;
/** URL を読む（中継を順に試す）。as: 'text' | 'buffer' */
export async function fetchVia(url, as = 'text') {
  let last;
  for (const make of good ? [good] : relays()) {
    try {
      const r = await fetch(make(url), { cache: 'no-store' });
      if (r.status === 404) { good = make; throw Object.assign(new Error(`見つかりません（404）：${url}`), { notFound: true }); }
      if (!r.ok) throw new Error(`${r.status}`);
      good = make;
      return as === 'buffer' ? r.arrayBuffer() : r.text();
    } catch (e) { if (e.notFound) throw e; last = e; }
  }
  throw new Error(`読めませんでした（${last?.message || '接続できません'}）。開発時は npm run dev で開いているか、公開サイトでは中継（VITE_WX_PROXY）に /aip があるか確かめてください`);
}

// ファイル名の国の文字（ICAO の地域記号）→ アプリの国コード（ISO）。分からないものはそのまま
const PREFIX_CC = { VT: 'TH', WM: 'MY', WS: 'SG', VH: 'HK', RC: 'TW', RP: 'PH', VD: 'KH', VL: 'LA', WA: 'ID', WI: 'ID', ZM: 'MN', RK: 'KR', VV: 'VN', VY: 'MM', VG: 'BD', VQ: 'BT', VR: 'MV', VC: 'LK', OP: 'PK', NZ: 'NZ', AY: 'PG', NF: 'FJ' };
export const prefixToCode = p => PREFIX_CC[p] || p;

/**
 * URL から eAIP の目次を読み、ENR と空港のページの一覧を返す
 * @returns { prefix, lang, menu, enr:[{ no, url }], airports:[{ icao, name, url }] }
 */
export async function discoverEaip(url) {
  const u = new URL(url.trim());
  let prefix = null, lang = null, eaipDir = null;
  // 国の文字つき（VT-menu-en-GB.html）と、国の文字なし（menu-en-GB.html。ミャンマーなど）の両方
  const fromName = s => {
    const a = /([A-Z]{2})-(?:ENR|AD|GEN|menu|cover)[^/]*?-([a-z]{2}-[A-Z]{2})\.html?/.exec(s);
    if (a) return a;
    const b = /(?:^|[\/"'])(?:menu|ENR-\d|AD-\d|GEN-\d)[^/"']*?-([a-z]{2}-[A-Z]{2})\.html?/.exec(s);
    return b ? [b[0], '', b[1]] : null;
  };
  let m = fromName(u.pathname);
  if (m) {
    [prefix, lang] = [m[1], m[2]];
    eaipDir = /\/eAIP\//i.test(u.pathname) ? u.href.replace(/(\/eAIP\/).*$/i, '$1') : new URL('eAIP/', u).href;
  } else {
    // 入口のページ（index-en-GB.html など）：中の枠（frame）や文字から国の文字と言語を探す
    const t = await fetchVia(u.href);
    m = fromName(t);
    if (!m) {
      const fs = [...t.matchAll(/src="([^"]+\.html?)"/gi)].map(x => new URL(x[1], u).href);
      for (const f of fs) { try { m = fromName(f) || fromName(await fetchVia(f)); } catch { /* 次 */ } if (m) break; }
    }
    if (!m) throw new Error('eAIP の目次が見つかりません（EUROCONTROL 形式の eAIP の URL を入れてください）');
    [prefix, lang] = [m[1], m[2]];
    eaipDir = new URL('eAIP/', u).href;
  }
  const menu = `${eaipDir}${prefix ? prefix + '-' : ''}menu-${lang}.html`;
  let pdfs = 0;
  const enr = [], airports = [];
  try {
    const doc = new DOMParser().parseFromString(await fetchVia(menu), 'text/html');
    doc.querySelectorAll('.sdParams, script, style').forEach(e => e.remove());
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = new URL(a.getAttribute('href').split('#')[0], menu).href;
      if (seen.has(href)) continue;
      if (/\.pdf$/i.test(href)) { pdfs++; continue; }
      const e = /(?:^|[\/-])ENR-([34]\.\d+)-/.exec(href), ad = /(?:^|[\/-])AD-2\.([A-Z]{4})-/.exec(href);
      if (e && (e[1] === '4.1' || e[1] === '4.4' || e[1].startsWith('3.'))) { seen.add(href); enr.push({ no: e[1], url: href }); }
      else if (ad) {
        seen.add(href);
        const name = a.textContent.replace(/\s+/g, ' ').replace(new RegExp(`^\\s*${ad[1]}\\s*[—–-]?\\s*`), '').trim();
        airports.push({ icao: ad[1], name: /^AD 2/.test(name) ? '' : name, url: href });
      }
    }
  } catch (e) { console.warn('[eaip] menu', e); }
  if (!enr.length && !airports.length && pdfs > 20) throw new Error('この eAIP は PDF だけで、HTML の表がありません（アプリの中では読めません）。PDF を解析して DB ファイルにする必要があります');
  if (!enr.length) for (const no of ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '4.1', '4.4']) enr.push({ no, url: `${eaipDir}${prefix ? prefix + "-" : ""}ENR-${no}-${lang}.html`, guess: true });
  return { prefix: prefix || '', lang, menu, enr, airports: airports.sort((a, b) => a.icao.localeCompare(b.icao)) };
}

/** ページをまとめて読む（3つずつ）。onProgress(済, 全部)。読めなかったページは errors に */
export async function fetchPages(urls, onProgress) {
  const out = [], errors = [];
  let done = 0;
  for (let i = 0; i < urls.length; i += 3) {
    await Promise.all(urls.slice(i, i + 3).map(async x => {
      try { out.push({ name: x.url.split('/').pop(), text: await fetchVia(x.url) }); }
      catch (e) { if (!x.guess) errors.push(`${x.url.split('/').pop()}：${e.message}`); }
      onProgress?.(++done, urls.length);
    }));
  }
  return { files: out, errors };
}
