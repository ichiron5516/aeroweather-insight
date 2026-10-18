import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// eAIP を URL から読むための中継（開発時だけ。2026-10-18）：/aeroweather-insight/aipfetch?url=https://…
//   各国の eAIP のサイトはブラウザから直接読めない（CORS）ため、Vite の中で読んで返す。
//   読めるのは http(s) の外のサイトだけ（手元のパソコン・社内のアドレスは読まない）
function aipFetchProxy() {
  const PRIVATE = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;
  return {
    name: 'aip-fetch-proxy',
    configureServer(server) {
      server.middlewares.use('/aeroweather-insight/aipfetch', async (req, res) => {
        let target;
        try { target = new URL(new URL(req.url, 'http://x').searchParams.get('url') || ''); } catch { res.statusCode = 400; return res.end('bad url'); }
        if (!/^https?:$/.test(target.protocol) || PRIVATE.test(target.hostname)) { res.statusCode = 403; return res.end('not allowed'); }
        try {
          const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 AeroWeatherInsight/1.0 (educational prototype)' } });
          res.statusCode = r.status;
          res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) { res.statusCode = 502; res.end(String(e.message || e)); }
      });
    },
  };
}

// AIP の取り込みの手伝い（開発時だけ。2026-10-18）
//   GET  /aeroweather-insight/aipdownload?url=…&dir=in … eAIP の PDF などを tools/intl/_downloads/{dir}/ に保存する（Python で解析するため）
//   POST /aeroweather-insight/aipinstall              … AIP 取り込みパネルで読んだ国のデータを public/data/intl/{国}/ に書き、index.json に載せる
//                                                      （ブラウザの中だけでなく、アプリに組み込む）
function aipDevTools() {
  const PRIVATE = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;
  const root = process.cwd();
  return {
    name: 'aip-dev-tools',
    async configureServer(server) {
      const fs = await import('node:fs/promises'), path = await import('node:path');
      server.middlewares.use('/aeroweather-insight/aipdownload', async (req, res) => {
        try {
          const q = new URL(req.url, 'http://x').searchParams, target = new URL(q.get('url') || '');
          const dir = (q.get('dir') || 'misc').replace(/[^a-z0-9_-]/gi, '');
          if (!/^https?:$/.test(target.protocol) || PRIVATE.test(target.hostname)) { res.statusCode = 403; return res.end('not allowed'); }
          const name = decodeURIComponent(target.pathname.split('/').pop() || 'index.html').replace(/[^\w.\-]/g, '_');
          const out = path.join(root, 'tools', 'intl', '_downloads', dir);
          await fs.mkdir(out, { recursive: true });
          const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 AeroWeatherInsight/1.0 (educational prototype)' } });
          if (!r.ok) { res.statusCode = r.status; return res.end(`HTTP ${r.status}`); }
          const buf = Buffer.from(await r.arrayBuffer());
          await fs.writeFile(path.join(out, name), buf);
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, name, bytes: buf.length }));
        } catch (e) { res.statusCode = 500; res.end(String(e.message || e)); }
      });
      // GET /aeroweather-insight/aipbundle?dir=in&match=正規表現 … 保存した PDF を1つの tar にまとめる（tools/intl/_downloads/{dir}_bundle.tar）
      server.middlewares.use('/aeroweather-insight/aipbundle', async (req, res) => {
        try {
          const q = new URL(req.url, 'http://x').searchParams, dir = (q.get('dir') || 'misc').replace(/[^a-z0-9_-]/gi, '');
          const re = new RegExp(q.get('match') || '.'), base = path.join(root, 'tools', 'intl', '_downloads');
          const names = (await fs.readdir(path.join(base, dir))).filter(n => re.test(n)).sort();
          const parts = [];
          for (const n of names) {
            const data = await fs.readFile(path.join(base, dir, n)), h = Buffer.alloc(512);
            h.write(n.slice(0, 99), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
            h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
            h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
            let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
            parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
          }
          parts.push(Buffer.alloc(1024));
          const out = path.join(base, `${dir}_bundle.tar`);
          await fs.writeFile(out, Buffer.concat(parts));
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, files: names.length, path: out }));
        } catch (e) { res.statusCode = 500; res.end(String(e.message || e)); }
      });
      server.middlewares.use('/aeroweather-insight/aipinstall', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        try {
          const chunks = []; for await (const c of req) chunks.push(c);
          const p = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (!/^[A-Z]{2}$/.test(p.code || '')) { res.statusCode = 400; return res.end('bad code'); }
          const cc = p.code.toLowerCase(), dir = path.join(root, 'public', 'data', 'intl', cc);
          await fs.mkdir(dir, { recursive: true });
          const entry = { code: p.code, name: p.name || p.code, ...(p.fir ? { fir: p.fir } : {}), aip: p.aip || '' };
          for (const [k, f] of [['nav', 'nav_db.json'], ['airports', 'airport_db.json'], ['airspace', 'airspace_db.json']]) {
            if (!p[k]) continue;
            await fs.writeFile(path.join(dir, f), JSON.stringify(p[k]));
            entry[k] = `${cc}/${f}`;
          }
          const idxFile = path.join(root, 'public', 'data', 'intl', 'index.json');
          const idx = JSON.parse(await fs.readFile(idxFile, 'utf-8'));
          const i = idx.countries.findIndex(c => c.code === p.code);
          if (i >= 0) idx.countries[i] = { ...idx.countries[i], ...entry }; else idx.countries.push(entry);
          await fs.writeFile(idxFile, JSON.stringify(idx, null, 2) + '\n');
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, entry }));
        } catch (e) { res.statusCode = 500; res.end(String(e.message || e)); }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    cesium({
      cesiumBaseUrl: 'cesium/',
    }),
    aipFetchProxy(),
    aipDevTools(),
  ],
  base: '/aeroweather-insight/',
  // 開発時（npm run dev）だけ、NOAA Aviation Weather Center（METAR/TAF/SIGMET）を中継する
  //   ブラウザから aviationweather.gov を直接読めない（CORS）ため
  server: {
    proxy: {
      // 京都大学 生存圏研究所（RISH）の気象庁 GPV アーカイブ（GSM の GRIB2）。src/gpvSource/rishGsm.js が使う（2026-10-18）
      '/aeroweather-insight/rish': {
        target: 'http://database.rish.kyoto-u.ac.jp',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/aeroweather-insight\/rish/, '/arch/jmadata/data/gpv/original'),
        headers: { 'User-Agent': 'AeroWeatherInsight/1.0 (educational prototype)' },
      },
      // 国際悪天予想図（WAFS SIGWX の GeoJSON）
      '/aeroweather-insight/awcsig': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/aeroweather-insight\/awcsig/, '/data/products/autosigwx'),
        headers: { 'User-Agent': 'AeroWeatherInsight/1.0 (educational prototype)' },
      },
      '/aeroweather-insight/awc': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/aeroweather-insight\/awc/, '/api/data'),
        headers: { 'User-Agent': 'AeroWeatherInsight/1.0 (educational prototype)' },
      },
    },
  },
});
