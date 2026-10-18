// NOAA Aviation Weather Center（METAR・TAF・SIGMET）の取得
//   aviationweather.gov はブラウザから直接読めない（CORS）ため、中継を通す。
//   1) 開発時（npm run dev）: vite.config.js の proxy（/awc → aviationweather.gov/api/data）
//   2) 公開サイト: .env.local などで VITE_WX_PROXY に中継のURLを設定（例: Cloudflare Workers、tools/wx-proxy-worker.js）
//   3) どちらもなければ直接アクセスを試す
const DIRECT = 'https://aviationweather.gov/api/data';

function bases() {
  const env = import.meta.env || {};
  const out = [];
  if (env.DEV) out.push(`${String(env.BASE_URL || '/').replace(/\/$/, '')}/awc`);
  if (env.VITE_WX_PROXY) out.push(String(env.VITE_WX_PROXY).replace(/\/$/, ''));
  out.push(DIRECT);
  return out;
}

/** path 例: 'metar?ids=RJBB&format=raw&hours=6' */
export async function awcFetch(path, as = 'text') {
  let last;
  for (const b of bases()) {
    try {
      const r = await fetch(`${b}/${path}`, { cache: 'no-store' });
      if (!r.ok && r.status !== 204) throw new Error(`${r.status}`);
      return as === 'json' ? (r.status === 204 ? [] : r.json()) : (await r.text()).trim();
    } catch (e) { last = e; }
  }
  throw new Error(`NOAA AWC に接続できません（${last?.message || 'CORS'}）`);
}
