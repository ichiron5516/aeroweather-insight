// 保存した評価を表示している間の、画面上部の帯（日付・評価した経路）と、保存した天気図を見る窓
import { utcText, jstText } from './savedBriefings.js';

const CSS = `
#awSavedBanner{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:31;max-width:calc(100vw - 20px);
  background:rgba(13,71,161,.95);color:#fff;font:13px/1.45 "Meiryo",sans-serif;border-radius:8px;padding:6px 12px;border:1px solid #8fd0ff;
  box-shadow:0 6px 20px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#awSavedBanner[hidden]{display:none}
#awSavedBanner .tag{background:#ffd54f;color:#3d2a00;font-weight:700;border-radius:5px;padding:1px 8px;white-space:nowrap}
#awSavedBanner .when{font-weight:700;white-space:nowrap}
#awSavedBanner .rt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
#awSavedBanner button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #8fd0ff;border-radius:5px;padding:3px 9px;cursor:pointer;white-space:nowrap}
#awSavedCharts{position:fixed;inset:5vh 4vw;z-index:40;background:rgba(14,22,34,.98);color:#fff;font:13px/1.5 "Meiryo",sans-serif;border-radius:10px;
  border:1px solid #47617d;box-shadow:0 10px 40px rgba(0,0,0,.7);display:grid;grid-template-columns:260px 1fr;grid-template-rows:auto 1fr;overflow:hidden}
#awSavedCharts[hidden]{display:none}
#awSavedCharts .hd{grid-column:1/3;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #2b3f55}
#awSavedCharts .hd b{margin-right:auto}
#awSavedCharts .hd button,#awSavedCharts .hd a{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 9px;cursor:pointer;text-decoration:none}
#awSavedCharts .ls{overflow:auto;border-right:1px solid #2b3f55;padding:6px}
#awSavedCharts .ls .g{font-size:11px;color:#8fd0ff;margin:8px 4px 2px}
#awSavedCharts .ls button{display:block;width:100%;text-align:left;font:12px "Meiryo",sans-serif;color:#e0e6ec;background:none;border:1px solid transparent;border-radius:5px;padding:4px 6px;cursor:pointer}
#awSavedCharts .ls button[aria-current="true"]{border-color:#8fd0ff;background:rgba(143,208,255,.1)}
#awSavedCharts .ls button.ng{color:#9fb3c8}
#awSavedCharts .vw{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:6px}
#awSavedCharts .vw img{max-width:100%;background:#fff;border-radius:6px;align-self:flex-start}
#awSavedCharts .vw iframe{flex:1;min-height:70vh;border:0;background:#fff;border-radius:6px}
#awSavedCharts .vw .s{color:#9fb3c8;font-size:12px}
@media (max-width:700px){#awSavedCharts{grid-template-columns:1fr;grid-template-rows:auto 160px 1fr}#awSavedCharts .ls{border-right:0;border-bottom:1px solid #2b3f55}}
`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createSavedView({ onExit }) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const ban = document.createElement('div'); ban.id = 'awSavedBanner'; ban.hidden = true;
  ban.innerHTML = `<span class="tag">保存データ</span><span class="when"></span><span class="rt"></span>
    <button data-c title="保存した時の天気図（画像・PDF・衛星・レーダー）">🗺 保存した天気図</button><button data-x title="保存データの表示をやめて、いまの表示に戻る">最新の表示に戻る</button>`;
  const md = document.createElement('div'); md.id = 'awSavedCharts'; md.hidden = true;
  md.innerHTML = `<div class="hd"><b></b><a data-open target="_blank" rel="noopener" hidden>新しいタブで開く</a><button data-close>閉じる</button></div><div class="ls"></div><div class="vw"></div>`;
  document.body.append(ban, md);
  let charts = [], urls = [], rec = null;
  const freeUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };
  const blobUrl = c => {
    if (c._url) return c._url;
    const b = atob(c.b64), a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    c._url = URL.createObjectURL(new Blob([a], { type: c.mime })); urls.push(c._url);
    return c._url;
  };
  function showChart(k) {
    const c = charts[k]; if (!c) return;
    md.querySelectorAll('.ls button').forEach(b => b.setAttribute('aria-current', +b.dataset.k === k));
    const vw = md.querySelector('.vw'), op = md.querySelector('[data-open]');
    op.hidden = true;
    if (c.error) { vw.innerHTML = `<p class="s">この図は保存の時に取り込めませんでした（${esc(c.error)}）。</p>`; return; }
    const head = `<div><b>${esc(c.title)}</b>　<span class="s">${esc(c.time || '')}${c.note ? `・${esc(c.note)}` : ''}</span></div>`;
    if (c.kind === 'image') { const u = blobUrl(c); vw.innerHTML = `${head}<img src="${u}" alt="${esc(c.title)}">`; op.href = u; op.hidden = false; }
    else if (c.kind === 'pdf') { const u = blobUrl(c); vw.innerHTML = `${head}<iframe src="${u}" title="${esc(c.title)}"></iframe>`; op.href = u; op.hidden = false; }
    else if (c.kind === 'json') {
      const tcs = c.json || [];
      vw.innerHTML = `${head}${tcs.length ? `<pre class="s">${esc(JSON.stringify(tcs, null, 1).slice(0, 20000))}</pre>` : '<p class="s">発表中の台風はありませんでした。</p>'}`;
    }
  }
  md.querySelector('[data-close]').onclick = () => { md.hidden = true; };
  md.querySelector('.ls').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) showChart(+b.dataset.k); });
  ban.querySelector('[data-c]').onclick = () => {
    if (!charts.length) return;
    md.querySelector('.hd b').textContent = `保存した天気図　評価 ${jstText(rec.created)}（${utcText(rec.created).slice(11)}）`;
    let grp = null;
    md.querySelector('.ls').innerHTML = charts.map((c, k) => {
      const g = c.grp && c.grp !== grp ? `<div class="g">${esc(c.grp)}</div>` : ''; grp = c.grp || grp;
      return `${g}<button data-k="${k}" class="${c.error ? 'ng' : ''}">${esc(c.title)}${c.error ? '（なし）' : ''}</button>`;
    }).join('');
    md.hidden = false;
    showChart(Math.max(0, charts.findIndex(c => !c.error)));
  };
  ban.querySelector('[data-x]').onclick = () => onExit?.();
  return {
    get on() { return !ban.hidden; },
    /** rec: 一覧の記録、chartsList: 保存した天気図、label: 選んでいる経路の説明 */
    show(r, chartsList, label) {
      rec = r; freeUrls(); charts = chartsList || [];
      ban.querySelector('.when').textContent = `評価 ${jstText(r.created)}（${utcText(r.created).slice(11)}）・出発 ${utcText(r.departure).slice(5)} 想定`;
      this.setRoute(label);
      ban.querySelector('[data-c]').disabled = !charts.some(c => !c.error);
      ban.hidden = false;
    },
    setRoute(label) { ban.querySelector('.rt').textContent = label || ''; ban.querySelector('.rt').title = label || ''; },
    hide() { ban.hidden = true; md.hidden = true; freeUrls(); charts = []; rec = null; },
  };
}
