// レーダーエコー（気象庁 高解像度降水ナウキャスト）と衛星画像（ひまわり）の6時間分アニメーション
//   ・レーダー：時刻の一覧（targetTimes_N1.json）は過去3時間だけだが、それより前の画像も残っているので、
//     最新から10分ごとに6時間前まで時刻を作って使う（37コマ）
//   ・衛星：一覧に1日以上あるので、過去6時間を20分ごと（19コマ）に間引いて使う
//   ・一覧の小さな図と、地図に重ねたレーダーの両方を同じ再生バーで動かす
//   ・地図ではコマごとに画像レイヤを作り、表示中のコマ以外は透明にしておく（切り替えが一瞬で済む）
import * as Cesium from 'cesium';

const NOWC = 'https://www.jma.go.jp/bosai/jmatile/data/nowc';
export const RADAR_STEP_MIN = 10;
export const ANIM_HOURS = 6;        // アニメーションにする時間（過去何時間分）
export const SAT_STEP_MIN = 20;
const toMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
const toJma = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12) + '00';

/** ひまわりの過去6時間（20分ごと、古い順）。band は 'B13/TBB'（赤外）や 'B03/ALBD'（可視） */
export async function satFrames(band) {
  const SAT = 'https://www.jma.go.jp/bosai/himawari/data/satimg';
  const r = await fetch(`${SAT}/targetTimes_fd.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  const L = (await r.json()).sort((a, b) => (a.validtime < b.validtime ? -1 : 1));
  const lastMs = toMs(L.at(-1).validtime);
  return L.filter(x => { const m = Math.round((lastMs - toMs(x.validtime)) / 60000); return m <= ANIM_HOURS * 60 && m % SAT_STEP_MIN === 0; })
    .map(x => ({ time: x.validtime, tiles: `${SAT}/${x.basetime}/fd/${x.validtime}/${band}/{z}/{x}/{y}.jpg` }));
}

/** 過去6時間の観測時刻（10分ごと、古い順、最新を必ず含む） */
export async function radarFrames() {
  const r = await fetch(`${NOWC}/targetTimes_N1.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  const L = (await r.json()).filter(x => x.basetime === x.validtime && (x.elements || ['hrpns']).includes('hrpns'))
    .sort((a, b) => (a.validtime < b.validtime ? -1 : 1));
  const lastMs = toMs(L.at(-1).validtime), out = [];
  // 一覧にない3時間より前も、実況の画像は同じ形の URL で残っている（基準時刻＝対象時刻）
  for (let m = ANIM_HOURS * 60; m >= 0; m -= RADAR_STEP_MIN) {
    const t = toJma(lastMs - m * 60000);
    out.push({ time: t, tiles: `${NOWC}/${t}/none/${t}/surf/hrpns/{z}/{x}/{y}.png` });
  }
  return out;
}

const CSS = `
#awWx .rp{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#cfe3f5}
#awWx .rp button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:1px 8px;cursor:pointer;min-width:34px}
#awWx .rp input[type=range]{flex:1;min-width:60px}
#awWx .rp .tl{white-space:nowrap;font-variant-numeric:tabular-nums}
#awWx .rp .ld{color:#9fb3c8;font-size:10.5px}`;

/**
 * @param viewer Cesium の viewer
 * @param opts.rect 重ねる範囲 / opts.compose(tiles) → 一覧用の canvas / opts.thumbEl 一覧の図の入れ物 / opts.barEl 再生バーの入れ物
 */
//  opts.lazy … 地図のレイヤを全コマ一度に作らず、表示するコマだけ作る（回数制限のある配信元向け）。opts.onLayerAdded … レイヤを作ったときに呼ぶ
export function createRadarAnim(viewer, { rect, compose, thumbEl, barEl, onTime, makeProvider = null, stepMs = [450, 1500], lazy = false, onLayerAdded = null }) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const A = { frames: [], thumbs: [], idx: 0, playing: false, timer: null, layers: null, alpha: 0.8, gen: 0, hidden: false };
  const fmt = s => `${s.slice(8, 10)}:${s.slice(10, 12)}Z`;
  const ago = s => {
    const last = A.frames.at(-1)?.time; if (!last || s === last) return '最新';
    const m = (Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8), +last.slice(8, 10), +last.slice(10, 12)) -
      Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))) / 60000;
    return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}前` : `${m}分前`;
  };

  barEl.innerHTML = `<button data-p aria-label="再生">▶</button><input type="range" min="0" max="0" value="0" data-s aria-label="時刻"><span class="tl" data-t>—</span>`;
  const bP = barEl.querySelector('[data-p]'), bS = barEl.querySelector('[data-s]'), bT = barEl.querySelector('[data-t]');
  const loadNote = Object.assign(document.createElement('span'), { className: 'ld' });
  barEl.appendChild(loadNote);

  const vis = () => (A.hidden === true ? 0 : A.hidden === false ? 1 : A.hidden);   // 地図の画像の濃さの倍率
  function setFrame(i) {
    if (!A.frames.length) return;
    A.idx = Math.max(0, Math.min(A.frames.length - 1, i));
    const f = A.frames[A.idx];
    bS.value = A.idx;
    bT.textContent = `${fmt(f.time)}（${ago(f.time)}）`;
    if (A.thumbs[A.idx]) thumbEl.replaceChildren(A.thumbs[A.idx]);
    if (A.layers && lazy && !A.layers[A.idx]) A.layers[A.idx] = makeLayer(A.frames[A.idx], A.alpha);
    if (A.layers) A.layers.forEach((l, k) => { if (l) l.alpha = k === A.idx ? A.alpha * vis() : 0; });
    onTime?.(f.time, A.idx === A.frames.length - 1);
  }
  function step() {
    const atEnd = A.idx >= A.frames.length - 1;
    setFrame(atEnd ? 0 : A.idx + 1);
    A.timer = setTimeout(step, A.idx === A.frames.length - 1 ? stepMs[1] : stepMs[0]);   // 最新のコマで少し止める
  }
  function play() { if (A.playing || A.frames.length < 2) return; A.playing = true; bP.textContent = '❚❚'; bP.setAttribute('aria-label', '一時停止'); step(); }
  function pause() { A.playing = false; clearTimeout(A.timer); bP.textContent = '▶'; bP.setAttribute('aria-label', '再生'); }
  bP.onclick = () => (A.playing ? pause() : play());
  bS.oninput = () => { pause(); setFrame(+bS.value); };

  /** 新しい時刻の一覧を受け取る（10分ごとの更新時にも呼ぶ） */
  async function setFrames(frames, latestThumb) {
    const gen = ++A.gen;
    const wasPlaying = A.playing; pause();
    A.frames = frames; A.thumbs = new Array(frames.length);
    if (latestThumb) A.thumbs[frames.length - 1] = latestThumb;
    bS.max = Math.max(0, frames.length - 1);
    setFrame(frames.length - 1);
    if (A.layers) { hideFromMap(); showOnMap(); }
    // 一覧用の図を古い順に用意（数枚ずつ並行）
    let done = latestThumb ? 1 : 0;
    loadNote.textContent = `読込 ${done}/${frames.length}`;
    const order = frames.map((_, k) => k).filter(k => !A.thumbs[k]).reverse();
    const worker = async () => {
      while (order.length) {
        const k = order.shift();
        try { const cv = await compose(frames[k].tiles); if (gen !== A.gen) return; A.thumbs[k] = cv; } catch { /* 取得できないコマは飛ばす */ }
        done++; if (gen === A.gen) loadNote.textContent = done < frames.length ? `読込 ${done}/${frames.length}` : '';
        if (k === A.idx && A.thumbs[k]) thumbEl.replaceChildren(A.thumbs[k]);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (gen === A.gen && wasPlaying) play();
  }

  // ---- 地図に重ねる ----
  function showOnMap(alpha) {
    if (alpha != null) A.alpha = alpha;
    if (A.layers || !A.frames.length) { setFrame(A.idx); return; }
    if (lazy) { A.layers = new Array(A.frames.length); A.layers[A.idx] = makeLayer(A.frames[A.idx], A.alpha); return; }
    A.layers = A.frames.map((f, k) => makeLayer(f, k === A.idx ? A.alpha : 0));   // 透明でもタイルは読み込まれるので、再生がなめらか
  }
  function makeLayer(f, alpha) {
    const l = viewer.imageryLayers.addImageryProvider(makeProvider ? makeProvider(f) : new Cesium.UrlTemplateImageryProvider({
      url: f.tiles, maximumLevel: 10, minimumLevel: 0, rectangle: rect, credit: new Cesium.Credit('気象庁') }));
    l.alpha = alpha;
    onLayerAdded?.();
    return l;
  }
  function hideFromMap() {
    if (!A.layers) return;
    A.layers.forEach(l => l && viewer.imageryLayers.remove(l, true));
    A.layers = null;
  }
  return {
    setFrames, showOnMap, hideFromMap, play, pause, setFrame,
    get onMap() { return !!A.layers; },
    setAlpha(a) { A.alpha = a; if (A.layers?.[A.idx]) A.layers[A.idx].alpha = a * vis(); },
    /** 地図に貼った画像を一時的に見えなくする・薄くする（true＝見えない、false＝通常、0〜1＝濃さの倍率）。
     *  3D で雲頂の高さに持ち上げた画像を出すとき、地表の画像は「本当の位置」を示す影として薄く残す */
    //   同じ値なら何もしない（setFrame → onTime → 雲頂の高さの表示（syncLift）→ setHidden … と呼び合って止まらなくなるのを防ぐ）
    setHidden(v) { const nv = typeof v === 'number' ? v : !!v; if (nv === A.hidden) return; A.hidden = nv; if (A.layers) setFrame(A.idx); },
    raise() { A.layers?.forEach(l => l && viewer.imageryLayers.raiseToTop(l)); },
    get current() { return A.frames[A.idx]; },
    get frames() { return A.frames; },
  };
}
