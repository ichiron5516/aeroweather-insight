// 経路アドバイスの結果を「ブリーフィング」として1つの HTML ファイルに保存する
//   中身：評価の条件・気象データの取得状況・アドバイス文・候補経路の一覧（距離・推奨高度・揺れ評価・要因）・
//         選んだ経路の詳細（全経路の文字列・SID/STAR・地点ごとの高度と通過時刻）・3D 画面・断面図・
//         天気図（国内悪天予想図 FBJP、地上天気図の実況と24時間予想）・経路にかかる悪天予想図の範囲・SIGMET・
//         再利用できるように評価結果のデータ（JSON）
//   画像はファイルの中に埋め込む（取得できない天気図はリンクだけ残す）。iPad の Safari でもそのまま開ける。
import { levelPlanText, hazardText } from './scoring.js';
import { latestWeatherMaps, FBJP_URL } from './wxSources.js';
import { encodeState } from './stateCodec.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const p2 = n => String(n).padStart(2, '0');
const hhmmZ = d => `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z`;
const stamp = d => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z`;
const jst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' JST';
const utc = d => d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const altText = ft => (ft >= 14000 ? `FL${p2(Math.round(ft / 100)).padStart(3, '0')}` : `${(Math.round(ft / 100) * 100).toLocaleString()}ft`);
const LEVEL_JA = { good: '揺れ小', caution: '揺れ注意', avoid: '揺れ大' };

/** 画像の URL → data URL（取得できなければ null） */
async function imageData(url, timeoutMs = 15000) {
  try {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, { mode: 'cors', signal: ac.signal }); clearTimeout(tm);
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => ok(null); fr.readAsDataURL(b); });
  } catch { return null; }
}

/** 3D 画面の画像（次の描画の直後に取る） */
export function capture3D(viewer) {
  return new Promise(ok => {
    let done = false;
    const off = viewer.scene.postRender.addEventListener(() => {
      if (done) return; done = true; off();
      try { ok(viewer.canvas.toDataURL('image/jpeg', 0.85)); } catch { ok(null); }
    });
    viewer.scene.requestRender();
    // 画面が隠れていて描画が止まっているときは、待たずに先へ進む
    setTimeout(() => { if (!done) { done = true; off(); ok(null); } }, 4000);
  });
}

/**
 * ブリーフィングを作って保存する。
 * ctx: { viewer, ranked, sel, wx, dep, arr, depName, arrName, departure, minFL, maxFL, advice, status:{名前:{cls,txt}}, section, nav }
 * onStep: 進み具合の表示
 */
export async function saveBriefing(ctx, onStep = () => {}) {
  const { ranked, sel, wx } = ctx;
  const r = ranked[sel];
  const now = new Date();
  onStep('3D 画面を記録しています…');
  const img3d = await capture3D(ctx.viewer);
  onStep('断面図を記録しています…');
  const head = `${ctx.dep} → ${ctx.arr}　${r.cand.label}　${Math.round(r.distanceNM).toLocaleString()} NM・${levelPlanText(r.best)}`;
  let imgSec = null;
  try { imgSec = await ctx.section.snapshot(r, wx, wx.fc, head); } catch (e) { console.warn('[briefing] section', e); }
  // 天気図：右の「天気図・画像」パネルの一覧すべて（画像・PDF・衛星とレーダーのつなぎ画像・台風）
  onStep('天気図を取り込んでいます…');
  let charts = [];
  if (window.awCharts?.snapshotAll) {
    try { charts = await window.awCharts.snapshotAll(onStep); } catch (e) { console.warn('[briefing] charts', e); }
  }
  if (!charts.some(c => c.b64)) {          // パネルが使えないときは主な3枚だけ
    let maps = {};
    try { maps = await latestWeatherMaps(); } catch { /* なし */ }
    for (const [id, title, src] of [['fbjp', '国内悪天予想図（FBJP）', `${FBJP_URL}?t=${Date.now()}`], ['sfc', '地上天気図（実況）', maps.now], ['sfc24', '地上天気図（24時間予想）', maps.ft24]]) {
      if (!src) continue;
      const d = await imageData(src);
      charts.push(d ? { id, title, grp: '', kind: 'image', mime: d.slice(5, d.indexOf(';')), b64: d.split(',')[1], url: src } : { id, title, error: '取得できません', url: src });
    }
  }
  // 評価結果をアプリでもう一度表示するためのデータ（候補経路・高度プロファイル・気象データ）
  const state = encodeState({ ranked, sel, wx, dep: ctx.dep, arr: ctx.arr, departure: ctx.departure, minFL: ctx.minFL, maxFL: ctx.maxFL, advice: ctx.advice, status: ctx.status });

  onStep('ファイルを作っています…');
  // 選んだ経路の地点ごとの高度・通過時刻（5NM ごとのプロファイルから一番近い点）
  const prof = r.best.prof;
  const near = p => prof.reduce((m, q) => (Math.hypot(q.lat - p.lat, q.lon - p.lon) < Math.hypot(m.lat - p.lat, m.lon - p.lon) ? q : m));
  let cum = 0;
  const wpRows = r.full.points.map((p, i) => {
    if (i) cum += p.legNM || 0;
    const q = near(p);
    const via = p.kind === 'SID' || p.kind === 'SID_TRANSITION' ? 'SID' : p.kind === 'STAR' ? 'STAR' : p.kind === 'runway' ? '滑走路' : p.via || '';
    return `<tr><td>${esc(p.id.replace(/-(DER|THR)$/, ' $1'))}</td><td>${esc(via)}</td><td class="n">${i ? (p.legNM ?? 0).toFixed(0) : ''}</td><td class="n">${cum.toFixed(0)}</td><td class="n">${esc(altText(q.alt))}</td><td class="n">${esc(hhmmZ(q.eto))}</td></tr>`;
  }).join('');
  const routeText = [r.full.dep || ctx.dep, r.full.sid ? `${r.full.sid}${r.full.sidTransition ? ` (${r.full.sidTransition})` : ''}` : null,
    r.cand.route, r.full.star, r.full.arr || ctx.arr].filter(Boolean).join(' ／ ');
  const candRows = ranked.map((x, i) => `<tr${i === sel ? ' class="sel"' : ''}${x.excluded ? ' style="opacity:.6"' : ''}>
    <td>${x.excluded ? '—' : i + 1}</td><td>${esc(x.cand.label)}</td><td class="n">${Math.round(x.distanceNM).toLocaleString()}</td>
    <td>${esc(levelPlanText(x.best))}</td><td class="n">${x.best.minutes}</td><td><span class="b ${x.level}">${LEVEL_JA[x.level]} ${x.best.hazardScore}</span></td>
    <td>${x.excluded ? `対象外: ${esc(x.excluded)}<br>` : ''}${x.best.hazards.slice(0, 3).map(h => esc(hazardText(h))).join('<br>')}</td></tr>`).join('');
  const st = Object.entries(ctx.status || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td class="${v.cls}">${esc(v.txt)}</td></tr>`).join('');
  // 選んだ経路にかかる悪天予想図の範囲・SIGMET
  const bands = [...new Set(prof.flatMap(p => p.fcst || []))].map(b => `<li>${esc(b.label)}</li>`).join('');
  const sigs = (wx.sigmets || []).map(g => `<li><b>${esc(`${g.hazard} ${g.qualifier || ''}`)}</b>（${esc(g.fir)}）<pre>${esc(g.raw || '')}</pre></li>`).join('');
  const img = (src, alt) => (src ? `<img src="${src}" alt="${esc(alt)}">` : `<p class="na">（記録できませんでした）</p>`);
  // 天気図は JSON に1回だけ入れ、ページを開いたときに画像・PDF のボタンにする（同じデータを二重に持たない）
  const chartHtml = charts.map((c, k) => `<figure id="awc-${k}"><figcaption>${esc(c.title)}${c.time ? `<span class="tm">${esc(c.time)}</span>` : ''}</figcaption>${
    c.error ? `<p class="na">取り込めませんでした（${esc(c.error)}）${c.url ? `。<a href="${esc(c.url)}">元のページ</a>` : ''}</p>`
    : c.kind === 'pdf' ? '<p><button data-pdf>PDF を開く</button></p>' : c.kind === 'json' ? `<p class="na">台風 ${(c.json || []).length} 個（データとして保存）</p>` : '<p class="na">画像を読み込み中…</p>'}${c.note ? `<p class="na">${esc(c.note)}</p>` : ''}</figure>`).join('');
  // 評価結果のデータ（あとで読み直したり、比べたりするため）
  const data = {
    format: 'aeroweather-briefing', version: 1, created: now.toISOString(),
    dep: ctx.dep, arr: ctx.arr, departure: ctx.departure.toISOString(), minFL: ctx.minFL, maxFL: ctx.maxFL,
    status: ctx.status, advice: ctx.advice, selected: sel,
    routes: ranked.map(x => ({
      label: x.cand.label, category: x.cand.category, no: x.cand.no ?? null, route: x.cand.route, sid: x.full.sid, star: x.full.star,
      distanceNM: x.distanceNM, extraNM: x.extraNM, fl: x.best.fl, steps: (x.best.steps || []).map(s => ({ from: s.from, to: s.to, near: s.near })),
      minutes: x.best.minutes, hazardScore: x.best.hazardScore, level: x.level, excluded: x.excluded,
      hazards: x.best.hazards.map(h => ({ type: h.type, cls: h.cls, from: h.from, to: h.to, flMin: h.flMin, flMax: h.flMax, minutes: Math.round(h.minutes * 10) / 10, label: h.label })),
      points: x.full.points.map(p => ({ id: p.id, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), kind: p.kind, via: p.via || null })),
    })),
    sigmets: (wx.sigmets || []).map(g => ({ hazard: g.hazard, qualifier: g.qualifier, fir: g.fir, baseFt: g.baseFt, topFt: g.topFt, raw: g.raw })),
    forecastBands: [...new Set(prof.flatMap(p => p.fcst || []))].map(b => ({ src: b.src, kind: b.kind, base: b.base, top: b.top, label: b.label })),
  };
  const title = `経路ブリーフィング ${ctx.dep}→${ctx.arr} ${utc(ctx.departure)}`;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f8fb;--fg:#17212b;--mut:#5b6b7b;--line:#d5dde6;--card:#fff;--acc:#00875a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1720;--fg:#e6edf3;--mut:#9fb3c8;--line:#2b3f55;--card:#16212d;--acc:#00e676}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Hiragino Sans","Meiryo",sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0}h2{font-size:16px;margin:24px 0 8px;border-left:4px solid var(--acc);padding-left:8px}
.meta{color:var(--mut);font-size:12.5px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.sel{background:rgba(0,200,120,.12)}
.b{display:inline-block;border-radius:9px;padding:0 8px;font-size:11.5px;font-weight:600;color:#fff;white-space:nowrap}
.good{background:#2e7d32}.caution{background:#b58900}.avoid{background:#c62828}.ok{color:#2e7d32}.ng{color:#c62828}.wait{color:#b58900}
.advice{white-space:pre-wrap}img{max-width:100%;display:block;border-radius:6px;border:1px solid var(--line);background:#fff}
figure{margin:0 0 16px}figcaption{font-weight:600;margin-bottom:4px}figcaption .tm{font-weight:400;color:var(--mut);margin-left:8px;font-size:12px}button{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
pre{white-space:pre-wrap;font-size:11.5px;margin:2px 0}.na{color:var(--mut)}.rt{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-word}
.note{color:var(--mut);font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta">作成 ${esc(utc(now))}（${esc(jst(now))}）・出発 ${esc(utc(ctx.departure))} 想定・巡航 FL${ctx.minFL}〜FL${ctx.maxFL}・AeroWeather Insight 経路アドバイス</div>
<h2>アドバイス</h2><div class="card advice">${esc(ctx.advice)}</div>
<h2>選んだ経路：${esc(r.cand.label)}</h2>
<div class="card"><p><b>${Math.round(r.distanceNM).toLocaleString()} NM</b>・${esc(levelPlanText(r.best))}・約${r.best.minutes}分・揺れ評価 ${r.best.hazardScore}（${LEVEL_JA[r.level]}）${r.excluded ? `・対象外：${esc(r.excluded)}` : ''}</p>
<p class="rt">${esc(routeText)}</p>
${r.best.hazards.length ? `<p>主な要因：<br>${r.best.hazards.slice(0, 6).map(h => esc(hazardText(h))).join('<br>')}</p>` : '<p>評価した範囲で揺れの要因は見つかりませんでした。</p>'}
<table><thead><tr><th>地点</th><th>航空路・手順</th><th>区間NM</th><th>累計NM</th><th>計画高度</th><th>通過</th></tr></thead><tbody>${wpRows}</tbody></table></div>
<h2>3D 画面と断面図</h2><div class="grid"><figure><figcaption>3D 画面（保存した時点の表示）</figcaption>${img(img3d, '3D 画面')}</figure>
<figure><figcaption>断面図（選んだ経路）</figcaption>${img(imgSec, '断面図')}</figure></div>
<h2>候補経路</h2><div class="card"><table><thead><tr><th>順位</th><th>経路</th><th>距離NM</th><th>推奨高度</th><th>分</th><th>揺れ評価</th><th>要因・条件</th></tr></thead><tbody>${candRows}</tbody></table></div>
<h2>天気図（保存した時点のもの）</h2><div class="grid">${chartHtml || '<p class="na">天気図を取得できませんでした。</p>'}</div>
<h2>選んだ経路にかかる悪天予想図の範囲</h2><div class="card">${bands ? `<ul>${bands}</ul>` : '<p class="na">なし</p>'}</div>
<h2>SIGMET（評価に使ったもの）</h2><div class="card">${sigs ? `<ul>${sigs}</ul>` : '<p class="na">なし</p>'}</div>
<h2>気象データの取得状況</h2><div class="card"><table>${st}</table></div>
<p class="note">教育用の簡易評価です。実運航の判断には使用できません。天気図の出典：気象庁。国際悪天予想図・SIGMET：NOAA Aviation Weather Center。高層風：Open-Meteo（気象庁 MSM/GSM）。</p>
</main><script type="application/json" id="aw-briefing-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script type="application/json" id="aw-briefing-state">${JSON.stringify(state).replace(/</g, '\\u003c')}</script>
<script type="application/json" id="aw-briefing-charts">${JSON.stringify(charts).replace(/</g, '\\u003c')}</script>
<script>(function(){var C=JSON.parse(document.getElementById('aw-briefing-charts').textContent);
function blob(c){var b=atob(c.b64),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return URL.createObjectURL(new Blob([a],{type:c.mime}));}
C.forEach(function(c,k){var f=document.getElementById('awc-'+k);if(!f||!c.b64)return;
if(c.kind==='image'){var p=f.querySelector('p.na');var im=document.createElement('img');im.src='data:'+c.mime+';base64,'+c.b64;im.alt=c.title;if(p)p.replaceWith(im);else f.appendChild(im);}
else if(c.kind==='pdf'){var u=null;f.querySelector('[data-pdf]').onclick=function(){u=u||blob(c);window.open(u,'_blank');};}});})();</script></body></html>`;
  const name = `AeroWeather_${ctx.dep}-${ctx.arr}_${stamp(ctx.departure)}.html`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { name, html, data, sizeKB: Math.round(blob.size / 1024), charts: charts.map(c => ({ title: c.title, embedded: !!c.b64 || c.kind === 'json' })) };
}
