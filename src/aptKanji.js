// 空港の漢字名（中国・韓国・北朝鮮・台湾・香港・マカオ・日本の「METAR・TAF の白丸」の空港）
//   白丸の空港名は NOAA AWC の地点一覧（英語）しかないため、Wikidata（ICAO コード＝P239）の日本語の名前を引く。
//   日本語の名前に漢字がなければ中国語（繁体字→簡体字）の名前を使う。漢字の名前がない空港は英語のまま。
//   ブラウザから Wikidata の検索窓口（query.wikidata.org、CORS 可）に問い合わせ、結果はブラウザに30日間とっておく。
//   取得できないとき（通信できない・混雑）は英語の名前のまま表示し、次に開いたときにもう一度問い合わせる。
const EP = 'https://query.wikidata.org/sparql';
const KEY = 'aw.aptKanji.v1', DAYS = 30, BATCH = 120;
/** 漢字の名前を探す空港（ICAO の頭の文字）。モンゴル（ZM）はキリル文字なので除く */
export const KANJI_RE = /^(RJ|RO|RK|ZK|RC|VH|VM|Z(?!M))/;
const HAN = /[㐀-鿿]/;
const hasHan = s => HAN.test(s || '');
// 繁体字を先に使う所（台湾・香港・マカオ・韓国・北朝鮮）
const TRAD = /^(RC|VH|VM|RK|ZK)/;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (c && Date.now() - c.t < DAYS * 864e5 && c.names) return c;
  } catch { /* なし */ }
  return { t: Date.now(), names: {} };
}
function writeCache(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* 保存できなくても表示はする */ } }

/** 名前を短く整える（「国際空港」はそのまま。括弧の補足は外す） */
const tidy = s => s.replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim();

async function query(icaos) {
  const q = `SELECT ?icao ?ja ?zht ?zh ?zhs WHERE {
    VALUES ?icao { ${icaos.map(i => `"${i}"`).join(' ')} }
    ?a wdt:P239 ?icao .
    OPTIONAL { ?a rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
    OPTIONAL { ?a rdfs:label ?zht FILTER(LANG(?zht) = "zh-hant") }
    OPTIONAL { ?a rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
    OPTIONAL { ?a rdfs:label ?zhs FILTER(LANG(?zhs) = "zh-hans") }
  }`;
  const res = await fetch(`${EP}?format=json&query=${encodeURIComponent(q)}`, { headers: { Accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  const j = await res.json();
  const out = {};
  for (const b of j.results?.bindings || []) {
    const icao = b.icao.value, v = k => b[k]?.value || '';
    const order = TRAD.test(icao) ? ['ja', 'zht', 'zh', 'zhs'] : ['ja', 'zh', 'zhs', 'zht'];
    const name = order.map(v).find(hasHan);
    if (name && !hasHan(out[icao])) out[icao] = tidy(name);
  }
  return out;
}

/**
 * ICAO コードの一覧 → { ICAO: 漢字の名前 }（見つからない空港は含めない）
 *   問い合わせの済んだ空港は、見つからなかったものも覚えておき、30日間は問い合わせない
 */
export async function kanjiNames(icaos) {
  const c = readCache();
  const need = [...new Set(icaos.filter(i => KANJI_RE.test(i) && !(i in c.names)))];
  for (let k = 0; k < need.length; k += BATCH) {
    const part = need.slice(k, k + BATCH);
    try {
      const got = await query(part);
      for (const i of part) c.names[i] = got[i] || '';
      writeCache(c);
    } catch (e) { console.warn('[apt kanji]', e.message); break; }   // 取れなかった分は次の機会に
  }
  return Object.fromEntries(Object.entries(c.names).filter(([, v]) => v));
}
