// 公開サイト（GitHub Pages）用の中継：Cloudflare Workers に貼り付けて使う
//   1. https://dash.cloudflare.com → Workers & Pages → 作成 → 「Hello World」を選び、このコードに置き換えてデプロイ
//   2. 発行された URL（例 https://aw-proxy.xxxx.workers.dev）を .env.local に  VITE_WX_PROXY=https://aw-proxy.xxxx.workers.dev  と書く
//   3. ビルドし直して公開
// 中継するのは aviationweather.gov の METAR・TAF・SIGMET と、国際悪天予想図（WAFS SIGWX の GeoJSON）、
// 京都大学 生存圏研究所の気象庁 GSM（/rish/YYYY/MM/DD/…。2026-10-18 追加。GPV を Open-Meteo の代わりに読むため）、
// それに AIP 取り込みパネルの eAIP（/aip?url=…。2026-10-18 追加。URL に eAIP・AIP を含む http(s) のページ・zip だけ）。
// 呼び出し元は公開サイトとローカル開発に限定する。
const ALLOW_ORIGINS = ['https://ichiron5516.github.io', 'http://localhost:5173'];
const ALLOW_PATHS = /^\/(metar|taf|isigmet|stationinfo)$/;   // stationinfo：白丸の空港の一覧（2026-10-18 追加）
const RISH = /^\/rish\/(\d{4}\/\d\d\/\d\d)\/(Z__C_RJTD_\d{14}_GSM_GPV_Rgl_FD\d{4}_grib2\.bin)?$/;   // /rish/YYYY/MM/DD/[GSM のファイル]（2026-10-18）
const SIGWX = /^\/sigwx\/(\d{8}\/\d{8}_\d{2}_F\d{2}_sigwx_hi_[A-Z]+\.geojson)$/;   // /sigwx/YYYYMMDD/YYYYMMDD_HH_Fhh_sigwx_hi_CB.geojson

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0], 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    const url = new URL(req.url);
    if (url.pathname === '/aip') {                                  // eAIP（AIP 取り込みパネル）
      let t;
      try { t = new URL(url.searchParams.get('url') || ''); } catch { return new Response('bad url', { status: 400, headers: cors }); }
      if (!/^https?:$/.test(t.protocol) || !/aip/i.test(t.href) || !/(\.x?html?|\.zip|\/)$/i.test(t.pathname)) return new Response('not allowed', { status: 403, headers: cors });
      const r = await fetch(t.href, { headers: { 'User-Agent': 'Mozilla/5.0 AeroWeatherInsight/1.0 (educational prototype)' }, cf: { cacheTtl: 3600, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'text/html', 'Cache-Control': 'max-age=3600' } });
    }
    const rish = url.pathname.match(RISH);
    if (rish) {                                                     // 京都大学 RISH の気象庁 GSM（GRIB2）とフォルダの一覧
      const file = !!rish[2];
      const r = await fetch(`http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original/${rish[1]}/${rish[2] || ''}`, {
        headers: { 'User-Agent': 'AeroWeatherInsight/1.0 (educational prototype)' },
        cf: { cacheTtl: file ? 86400 * 2 : 600, cacheEverything: true },
      });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': file ? 'application/octet-stream' : 'text/html', 'Cache-Control': file ? 'max-age=172800' : 'max-age=600' } });
    }
    const sw = url.pathname.match(SIGWX);
    if (!sw && !ALLOW_PATHS.test(url.pathname)) return new Response('not allowed', { status: 404, headers: cors });
    const target = sw ? `https://aviationweather.gov/data/products/autosigwx/${sw[1]}` : `https://aviationweather.gov/api/data${url.pathname}${url.search}`;
    const r = await fetch(target, {
      headers: { 'User-Agent': 'AeroWeatherInsight/1.0 (educational prototype)' },
      cf: { cacheTtl: sw ? 600 : 120, cacheEverything: true },
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': sw ? 'application/json' : (r.headers.get('Content-Type') || 'text/plain'), 'Cache-Control': 'max-age=120' } });
  },
};
