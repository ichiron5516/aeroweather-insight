// 経路作成 BOX（2026-10-18 から：アプリを開いたときから画面左下に出しておく）
//   ・まず地図の空港（青いピン）をクリックして路線を決める：1回目＝出発空港、2回目＝到着空港
//     白丸（METAR・TAF だけの空港）も選べる。滑走路・SID・STAR のデータがないので、経路の最初・最後の地点と直行で結ぶ
//     地点を1つも選ばずに登録すると、空港から空港への直行経路（DCT）になる
//     （路線が決まると、航法データを表示して「地図から選ぶ」をオンにし、2つの空港が入るように地図を動かす）
//   ・航法データ（航空路・Waypoint・VOR）を地図に出し、地点や航空路をクリックして経路を組み立てる
//     地点をクリック → 地点を追加（前の地点からは直行。航空路を選んだ後なら、その航空路で結ぶ）
//     航空路をクリック → 最後の地点がその航空路上にあれば航空路を追加（次に、その航空路上の地点をクリック）
//   ・入力欄に「KOHWA Y544 DUBKA」のように直接書いてもよい。候補（次に使える航空路・航空路上の地点）も押せる
//   ・SID / STAR を付けた全経路を地図にプレビューし、「経路作成登録」で自作経路として保存 → 評価をやり直して候補に加える
//   保存先は aeroNavCore の自作経路（ブラウザの localStorage）
import * as Cesium from 'cesium';

const CSS = `
#awRB{position:absolute;left:10px;bottom:10px;z-index:23;width:340px;max-width:calc(100vw - 20px);max-height:46vh;overflow:auto;
  background:rgba(20,30,45,.96);color:#fff;font:12.5px/1.5 "Meiryo",sans-serif;border-radius:8px;padding:10px 12px;border-left:4px solid #ff4fd8;display:none}
#awRB h2{font-size:14px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
#awRB h2 .sub{font-size:11px;color:#9fb3c8;font-weight:400}
#awRB .x{margin-left:auto;background:none;border:none;color:#aaa;font-size:16px;cursor:pointer}
#awRB textarea{width:100%;box-sizing:border-box;min-height:44px;resize:vertical;background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:5px;
  font:12.5px ui-monospace,Menlo,monospace;padding:5px 6px;text-transform:uppercase}
#awRB input{background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:5px;font:12px "Meiryo",sans-serif;padding:3px 6px;flex:1;min-width:0}
#awRB .row{display:flex;gap:5px;align-items:center;margin-top:5px;flex-wrap:wrap}
#awRB button{font:12px "Meiryo",sans-serif;color:#fff;background:#0f1c2b;border:1px solid #47617d;border-radius:5px;padding:3px 8px;cursor:pointer}
#awRB button:disabled{opacity:.4;cursor:default}
#awRB button.reg{background:#b0178f;border-color:#ff4fd8;font-weight:600;padding:5px 12px}
#awRB button.pick[aria-pressed="true"]{background:#5a1550;border-color:#ff4fd8}
#awRB .tok{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
#awRB .tok span{font:11.5px ui-monospace,Menlo,monospace;border-radius:4px;padding:0 5px}
#awRB .tok .fix{background:#26415c}#awRB .tok .airway{background:#4a2d5c;color:#e1bee7}
#awRB .tok .airport{background:#1b4d3e}#awRB .tok .unknown{background:#7f1d1d}
#awRB .sug{font-size:11px;color:#9fb3c8;margin-top:4px}
#awRB .sug button{font:11px ui-monospace,Menlo,monospace;padding:0 5px;margin:1px;background:#16293d;border-color:#2c4258}
#awRB .info{font-size:11.5px;color:#cfe3f5;margin-top:4px}
#awRB .err{color:#ff8a80;font-size:11.5px}#awRB .warn{color:#ffcc80;font-size:11.5px}#awRB .ok{color:#69f0ae;font-size:11.5px}
#awRB.min [data-body]{display:none}
#awRB .od{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
#awRB .ap{font:600 12px "Meiryo",sans-serif;border-radius:5px;padding:2px 7px;background:#1b4d3e;border:1px solid #2e7d5b}
#awRB .ap.need{background:#3a2f0b;border:1px dashed #ffd54f;color:#ffe082;font-weight:400}
#awRB .ap.need.now{animation:awRBblink 1.2s ease-in-out infinite}
@keyframes awRBblink{50%{border-color:transparent}}
#awRB .od button{font-size:11px;padding:1px 6px}
#awRB .hint{font-size:11.5px;color:#ffe082;margin:2px 0 4px}
#awRB select{background:#0f1c2b;color:#fff;border:1px solid #47617d;border-radius:5px;font:11.5px "Meiryo",sans-serif;padding:2px 4px;flex:1;min-width:0}
`;
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLOR = Cesium.Color.fromCssColorString('#ff4fd8');

/**
 * @param viewer  Cesium.Viewer
 * @param opts.nav        aeroNavCore（createAeroNav の戻り値）
 * @param opts.onSaved    経路を登録した後に呼ぶ（評価のやり直し）
 * @param opts.onResize   BOX の高さが変わったとき（アドバイスパネルを上に詰めるため）
 * @param opts.onRoute    地図のクリックで路線（出発・到着）が決まったとき onRoute(dep, arr)（アドバイスパネルの出発・到着の欄を合わせる）
 */
export function createRouteBuilder(viewer, { nav, onSaved, onResize, onRoute }) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const box = Object.assign(document.createElement('div'), { id: 'awRB' });
  document.body.appendChild(box);
  const ds = new Cesium.CustomDataSource('routeBuilder');
  viewer.dataSources.add(ds);
  viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === ds) setTimeout(() => { viewer.dataSources.add(ds); preview(); }, 0); });

  // 「地図から選ぶ」は、路線が決まったときにオンにする（評価のときに航法データを勝手に表示しない）
  // armed：「経路を作り始める」を押した後だけ、地図の空港のクリックを出発・到着に使う（2026-10-18。それまでは空港のクリックは METAR・TAF の表示だけ）
  const S = { dep: null, arr: null, picking: false, open: false, min: false, msg: null, lastApt: 0, armed: false };
  box.innerHTML = `
    <h2>経路を作る <span class="sub" data-od></span><button class="x" data-min title="小さくする">－</button></h2>
    <div data-body>
    <div class="od">
      <span>出発</span><span class="ap" data-dep></span><span>→</span><span>到着</span><span class="ap" data-arr></span>
      <button data-redep title="出発空港を地図でクリックし直す">出発を選び直す</button><button data-rearr title="到着空港を地図でクリックし直す">到着を選び直す</button>
    </div>
    <button class="go" data-arm style="margin:4px 0 2px;padding:6px 12px;font-weight:600;background:#00a152;border:1px solid #00e676;color:#fff;border-radius:5px;cursor:pointer">✈ 経路を作り始める</button>
    <div class="hint" data-hint></div>
    <div data-rtbox>
    <textarea data-rt spellcheck="false" placeholder="地図の地点・航空路をクリック、または入力（例：KOHWA Y544 DUBKA）"></textarea>
    <div class="tok" data-tok></div>
    <div class="sug" data-sug></div>
    <div class="info" data-info></div>
    <div class="row">
      <button class="pick" data-pick aria-pressed="false" title="オンの間は、地図の地点・航空路をクリックすると経路に追加">地図から選ぶ</button>
      <button data-undo>1つ戻す</button>
      <button data-clear>クリア</button>
    </div>
    <div class="row">
      <input data-name placeholder="経路の名前（省略可）" maxlength="40">
      <button class="reg" data-reg>経路作成登録</button>
    </div>
    <div class="row" data-savedrow>
      <select data-saved></select><button data-load>読込</button><button data-del>削除</button>
    </div>
    </div>
    <div class="info" data-odmsg></div>
    </div>`;
  const q = s => box.querySelector(s);
  const ta = q('[data-rt]');

  // ---------- 入力の解析 ----------
  const tokens = () => nav.tokenize(ta.value);
  function setTokens(t) { ta.value = t.join(' '); S.msg = null; update(); }
  function lastFix(t = tokens()) {
    for (let i = t.length - 1; i >= 0; i--) if (!nav.isAirway(t[i])) return { id: t[i], i };
    return null;
  }

  function addFix(id) {
    const t = tokens(), last = t.at(-1);
    if (last === id) return;
    if (last && nav.isAirway(last)) {
      const aw = nav.getAirway(last.split('/')[0], lastFix(t.slice(0, -1))?.id);
      if (aw && !aw.points.includes(id)) { S.msg = { cls: 'err', text: `${id} は ${last} 上にありません。${last} 上の地点を選ぶか、「1つ戻す」で航空路を外してください。` }; return update(false); }
    }
    t.push(id); setTokens(t);
  }
  function addAirway(d, from, to) {
    d = d.split('~')[0];                                        // 海外の同じ名前の航空路（Y233~KR など）は名前だけで書く
    const t = tokens(), lf = lastFix(t);
    if (t.length && nav.isAirway(t.at(-1))) t.pop();          // 航空路を選び直した
    if (!lf) {                                                  // 最初の1点がまだ：クリックした区間の始点から
      t.push(from, d); return setTokens(t);
    }
    const aw = nav.getAirway(d, lf.id);
    if (!aw.points.includes(lf.id)) {
      S.msg = { cls: 'err', text: `${lf.id} は ${d} 上にありません。${d} 上の地点（${aw.points.slice(0, 6).join('・')}…）まで直行してから使えます。` };
      return update(false);
    }
    t.push(d); setTokens(t);
  }

  // ---------- 路線（出発・到着）：地図の空港をクリック ----------
  const phase = () => (!S.dep ? 'dep' : !S.arr ? 'arr' : 'route');
  const apName = c => { const a = nav.getAirport(c); return a ? `${a.icao}${a.iata ? ' ' + a.iata : ''} ${String(a.nameJa || '').replace(/（.*?）/g, '')}` : c; };
  function setPicking(v) {
    S.picking = v; q('[data-pick]').setAttribute('aria-pressed', v);
    if (v) window.awNav?.setVisible(true);
  }
  /** 空港がクリックされた（空港ピン・航法データの空港の記号）。路線を決めている間だけ受け取る → true */
  function pickAirport(icao) {
    if (!S.open || S.min || !S.armed || phase() === 'route') return false;
    // 同じクリックが空港ピンと航法データの両方から届くので、続けて届いた分は使わない
    if (Date.now() - S.lastApt < 600) return true;
    S.lastApt = Date.now();
    const a = nav.getAirport(icao);
    if (!a) { S.odMsg = { cls: 'err', text: `${icao} は空港の位置が分からないため、路線には選べません。` }; update(); return true; }
    S.odMsg = a.station ? { cls: 'warn', text: `${a.icao} は SID・STAR のデータがない空港です。経路の最初（最後）の地点と直行で結びます。` } : null;
    if (phase() === 'dep') {
      if (a.icao === S.arr) { S.odMsg = { cls: 'err', text: '到着と同じ空港です。別の空港を選んでください。' }; update(); return true; }
      S.dep = a.icao; ta.value = '';
    } else {
      if (a.icao === S.dep) { S.odMsg = { cls: 'err', text: '出発と同じ空港です。到着空港を選んでください。' }; update(); return true; }
      S.arr = a.icao; ta.value = '';
    }
    if (phase() === 'route') {
      onRoute?.(S.dep, S.arr);
      setPicking(true);
      const D = nav.getAirport(S.dep).arp, A = nav.getAirport(S.arr).arp;
      const pad = Math.max(1, 0.15 * Math.max(Math.abs(D.lat - A.lat), Math.abs(D.lon - A.lon)));
      viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(Math.min(D.lon, A.lon) - pad, Math.min(D.lat, A.lat) - pad, Math.max(D.lon, A.lon) + pad, Math.max(D.lat, A.lat) + pad), duration: 1.5 });
    }
    update();
    return true;
  }
  /** 空港レイヤ（airportsLayer.js）からのクリック。{ kind: 'dbAirport' | 'wxStation', icao } */
  function onAirport(h) {
    if (!S.open || S.min || !S.armed || phase() === 'route') return false;
    return h.kind === 'dbAirport' || h.kind === 'wxStation' ? pickAirport(h.icao) : false;
  }
  /** 空港にマウスを載せたときの札に出す一言（路線を決めている間だけ） */
  const clickHint = () => (S.open && !S.min && S.armed && phase() !== 'route' ? (phase() === 'dep' ? 'クリックで出発空港に' : 'クリックで到着空港に') : null);

  // ---------- 地図でのクリック（航法レイヤから受け取る） ----------
  function onPick(hit) {
    if (hit.awNav === 'fix' && hit.cls === 'airport') {
      if (phase() !== 'route') return pickAirport(hit.id);
      return S.open && !S.min && S.picking;                      // 経路の途中に空港は入れない（情報ポップアップも出さない）
    }
    if (!S.open || S.min || !S.picking || phase() !== 'route') return false;
    if (hit.awNav === 'fix') addFix(hit.id);
    else if (hit.awNav === 'airway') addAirway(hit.d, hit.from, hit.to);
    return true;                                                 // 航法レイヤの情報ポップアップは出さない
  }

  // ---------- 表示更新 ----------
  function update(clearMsg = true) {
    if (clearMsg === true && S.msg?.cls === 'ok') S.msg = null;
    // 路線の表示
    const ph = phase(), apHtml = (c, k) => (c ? esc(apName(c)) : `${k === ph ? '地図の空港をクリック' : '—'}`);
    const dEl = q('[data-dep]'), aEl = q('[data-arr]');
    dEl.innerHTML = apHtml(S.dep, 'dep'); dEl.className = 'ap' + (S.dep ? '' : ' need' + (ph === 'dep' ? ' now' : ''));
    aEl.innerHTML = apHtml(S.arr, 'arr'); aEl.className = 'ap' + (S.arr ? '' : ' need' + (ph === 'arr' ? ' now' : ''));
    q('[data-redep]').style.display = S.dep ? '' : 'none';
    q('[data-rearr]').style.display = S.arr ? '' : 'none';
    const D = nav.getAirport(S.dep), A = nav.getAirport(S.arr);
    q('[data-od]').textContent = ph === 'route' ? `${D ? D.iata || D.icao : S.dep} → ${A ? A.iata || A.icao : S.arr}` : '';
    q('[data-arm]').style.display = S.armed || ph === 'route' ? 'none' : '';
    q('[data-hint]').textContent = !S.armed && ph !== 'route' ? '「経路を作り始める」を押すと、地図の空港をクリックして出発・到着空港を選べます。今は空港をクリックすると METAR・TAF を表示します。'
      : ph === 'dep' ? '① 地図の空港（青いピン・白丸）をクリックして、出発空港を選んでください。'
      : ph === 'arr' ? '② 次に、到着空港をクリックしてください。'
      : S.picking ? '③ 地図の地点（Waypoint・VOR）・航空路をクリックして経路を作ります。地点を選ばずに登録すると、空港間の直行経路になります。' : '';
    q('[data-odmsg]').innerHTML = S.odMsg ? `<div class="${S.odMsg.cls}">${esc(S.odMsg.text)}</div>` : '';
    q('[data-rtbox]').style.display = ph === 'route' ? '' : 'none';
    if (ph !== 'route') { preview(null); onResize?.(box.offsetHeight); return; }
    const t = tokens();
    q('[data-tok]').innerHTML = nav.classifyTokens(ta.value).map(x => `<span class="${x.kind}">${esc(x.text)}</span>`).join('');
    // 候補：最後が航空路ならその航空路上の地点、最後が地点なら通る航空路
    const last = t.at(-1);
    let sug = '';
    if (last && nav.isAirway(last)) {
      const d = last.split('/')[0], lf = lastFix(t), pts = nav.getAirway(d, lf?.id)?.points || [];
      const i = pts.indexOf(lf?.id);
      const ahead = i < 0 ? pts : [...pts.slice(i + 1), ...pts.slice(0, i).reverse()];
      sug = `${esc(d)} 上の地点：` + ahead.slice(0, 24).map(p => `<button data-fx="${esc(p)}">${esc(p)}</button>`).join('');
    } else if (last) {
      const aws = nav.airwaysThrough(last);
      sug = aws.length ? `${esc(last)} を通る航空路：` + aws.map(a => `<button data-aw="${esc(a)}">${esc(a)}</button>`).join('') : `${esc(last)} を通る航空路はありません（次の地点へは直行）`;
    } else sug = '最初の地点（Waypoint・VOR）をクリックしてください。SID の終わりの地点から始めると SID が自動で付きます。';
    q('[data-sug]').innerHTML = sug;
    q('[data-sug]').querySelectorAll('[data-fx]').forEach(b => b.onclick = () => addFix(b.dataset.fx));
    q('[data-sug]').querySelectorAll('[data-aw]').forEach(b => b.onclick = () => { const lf = lastFix(); addAirway(b.dataset.aw, lf?.id, null); });

    const info = q('[data-info]');
    let html = '';
    let ok = false;
    if (t.length) {
      const full = nav.buildFullRoute({ dep: S.dep, arr: S.arr, route: ta.value });
      const pend = nav.isAirway(t.at(-1));
      html += `<div>${full.distanceNM}NM・SID ${esc(full.sid || '—')}・STAR ${esc(full.star || '—')}</div>`;
      if (pend) html += `<div class="warn">航空路 ${esc(t.at(-1))} の出口の地点を選んでください</div>`;
      full.errors.forEach(e => { html += `<div class="err">${esc(e)}</div>`; });
      full.notes.forEach(n => { html += `<div class="warn">${esc(n)}</div>`; });
      ok = !pend && !full.errors.length && t.filter(x => !nav.isAirway(x)).length >= 1;
      preview(full);
    } else {
      // 地点なし：空港から空港への直行
      const full = nav.buildFullRoute({ dep: S.dep, arr: S.arr, route: '' });
      html += `<div>地点なし：${esc(S.dep)} → ${esc(S.arr)} の直行 ${full.distanceNM}NM（このまま登録すると直行経路「DCT」）</div>`;
      ok = full.points.length >= 2;
      preview(full);
    }
    if (S.msg) html += `<div class="${S.msg.cls}">${esc(S.msg.text)}</div>`;
    info.innerHTML = html;
    q('[data-reg]').disabled = !ok;
    q('[data-undo]').disabled = !t.length;
    refreshSaved();
    onResize?.(box.offsetHeight);
  }

  function preview(full) {
    ds.entities.removeAll();
    // 選んだ出発・到着の空港に印
    for (const [c, t, col] of [[S.dep, '出発', '#00e676'], [S.arr, '到着', '#ffd54f']]) {
      const a = nav.getAirport(c); if (!a || !S.open) continue;
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(a.arp.lon, a.arp.lat),
        point: { pixelSize: 18, color: Cesium.Color.TRANSPARENT, outlineColor: Cesium.Color.fromCssColorString(col), outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: t, font: 'bold 12px "Meiryo", sans-serif', fillColor: Cesium.Color.BLACK, showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString(col), pixelOffset: new Cesium.Cartesian2(0, 22),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    if (!full?.points?.length) return;
    const pts = full.points;
    ds.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(pts.flatMap(p => [p.lon, p.lat])), width: 4, clampToGround: true,
      material: new Cesium.PolylineOutlineMaterialProperty({ color: COLOR, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 }) } });
    const user = new Set(tokens());
    for (const p of pts) {
      if (p.kind === 'runway') continue;
      const mine = user.has(p.id);
      ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: mine ? 9 : 5, color: mine ? COLOR : Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: mine ? { text: p.id, font: 'bold 12px "Meiryo", sans-serif', fillColor: COLOR, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } : undefined });
    }
  }

  // ---------- 登録済みの自作経路 ----------
  function savedList() { return nav.listCustomRoutes().filter(r => r.dep === nav.getAirport(S.dep)?.icao || r.dep === S.dep).filter(r => r.dest === (nav.getAirport(S.arr)?.icao || S.arr)); }
  function refreshSaved() {
    const L = savedList();
    q('[data-savedrow]').style.display = L.length ? '' : 'none';
    const sel = q('[data-saved]'), cur = sel.value;
    sel.innerHTML = L.map(r => `<option value="${esc(r.id)}">${esc(r.name || '名前なし')}：${esc(r.route)}</option>`).join('');
    if (L.some(r => r.id === cur)) sel.value = cur;
  }

  // ---------- ボタン ----------
  ta.addEventListener('input', () => { S.msg = null; update(); });
  q('[data-min]').onclick = () => setMin(!S.min);
  q('h2').addEventListener('click', e => { if (S.min && e.target !== q('[data-min]')) setMin(false); });
  q('[data-redep]').onclick = () => { S.dep = null; S.armed = true; S.odMsg = null; ta.value = ''; update(); };
  q('[data-rearr]').onclick = () => { S.arr = null; S.armed = true; S.odMsg = null; ta.value = ''; update(); };
  q('[data-arm]').onclick = () => { S.armed = true; S.odMsg = null; update(); };
  q('[data-pick]').onclick = () => setPicking(!S.picking);
  q('[data-undo]').onclick = () => { const t = tokens(); t.pop(); setTokens(t); };
  q('[data-clear]').onclick = () => setTokens([]);
  q('[data-reg]').onclick = async () => {
    const name = q('[data-name]').value.trim();
    const res = nav.saveCustomRoute({ dep: S.dep, dest: S.arr, route: ta.value, name: name || null });
    if (!res.ok) { S.msg = { cls: 'err', text: '登録できません：' + res.errors.join('・') }; return update(false); }
    S.msg = { cls: 'ok', text: `「${res.route.name || res.route.route}」を登録しました${res.persisted ? '' : '（このブラウザでは保存できないため、再読込で消えます）'}。評価をやり直しています…` };
    q('[data-name]').value = '';
    update(false);
    try { await onSaved?.(res.route); S.msg = { cls: 'ok', text: `登録した経路を候補に加えて評価しました（「自作」）。` }; }
    catch (e) { console.warn('[routeBuilder]', e); }
    update(false);
  };
  q('[data-load]').onclick = () => {
    const r = savedList().find(x => x.id === q('[data-saved]').value);
    if (r) { ta.value = r.route; q('[data-name]').value = r.name || ''; S.msg = null; update(); }
  };
  q('[data-del]').onclick = async () => {
    const r = savedList().find(x => x.id === q('[data-saved]').value);
    if (!r || !confirm(`自作経路「${r.name || r.route}」を削除しますか？`)) return;
    nav.deleteCustomRoute(r.id);
    S.msg = { cls: 'ok', text: '削除しました。評価をやり直しています…' }; update(false);
    try { await onSaved?.(null); } catch (e) { console.warn('[routeBuilder]', e); }
    S.msg = null; update();
  };

  /** 小さくする（見出しだけ）／元に戻す。小さくしている間は地図のクリックを受け取らない */
  function setMin(v) {
    S.min = v; box.classList.toggle('min', v);
    q('[data-min]').textContent = v ? '＋' : '－'; q('[data-min]').title = v ? '開く' : '小さくする';
    update();
  }
  function close() { setMin(true); }

  return {
    onPick,
    onAirport,
    clickHint,
    get open() { return S.open && !S.min; },
    /** アプリを開いたときに呼ぶ：路線が未定なら、地図の空港のクリックを待つ */
    start() { S.open = true; box.style.display = 'block'; update(); },
    /** 評価の後・出発到着の欄を変えたときに呼ぶ。出発・到着が変わったら入力を空にする */
    show(dep, arr) {
      if (S.dep !== dep || S.arr !== arr) { ta.value = ''; S.msg = null; }
      S.dep = dep; S.arr = arr; S.open = true; S.odMsg = null; S.armed = true;
      box.style.display = 'block';
      update();
    },
    close,
  };
}
