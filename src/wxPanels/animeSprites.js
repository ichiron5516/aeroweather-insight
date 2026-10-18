// アニメ風の雲・雨の絵（キャンバスで手続き的に描く。外部の画像は使わない）
//   雲：もこもこした輪郭（円の重なり）に、影・中間・明るい面・光の縁（桃色）を
//       くっきりした段階（セル画風）で塗り分ける。下は平らで青い影。
//   雨：縦の筋が上から下へ薄くなる幕。色は下で強さごとに付ける（白地の絵に色を掛ける）

const PAL = {
  shadow: '#8db6e6', shadow2: '#b2d2f2', mid: '#dbeeff', light: '#f5faff', white: '#ffffff',
  rim: '#ffd6c8',
};

// 種から決まる乱数（同じ絵を毎回作れるように）
const rng = seed => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/**
 * 雲のかたまり1つ
 * @param kind 'puff'（積雲）・'tower'（縦に伸びた積乱雲）・'layer'（平たい層の雲）
 */
function cloud(kind, seed) {
  const W = 256, H = kind === 'tower' ? 320 : kind === 'layer' ? 128 : 200;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), r = rng(seed * 97 + 13);
  const baseY = H * 0.9;
  // 輪郭＝胴体（だ円）＋上にのる丸いこぶ＋平らな底
  const lobes = [];
  let body;
  if (kind === 'tower') {
    body = { x: W / 2, y: baseY - H * 0.36, rx: W * 0.26, ry: H * 0.36 };
    for (let t = 0; t <= 1.0001; t += 0.125) {               // 下から上へ、だんだん細く
      const cx = W / 2 + (r() - 0.5) * 24, cy = baseY - 30 - t * H * 0.66, rad = (1 - t * 0.45) * 44 + r() * 12;
      lobes.push({ x: cx - rad * 0.55, y: cy, rad: rad * 0.9 }, { x: cx + rad * 0.55, y: cy + 6, rad: rad * 0.85 });
    }
    lobes.push({ x: W / 2 + (r() - 0.5) * 20, y: H * 0.13, rad: 34 + r() * 8 });
  } else {
    const flat = kind === 'layer';
    body = { x: W / 2, y: baseY - (flat ? 26 : 44), rx: W * (flat ? 0.42 : 0.36), ry: flat ? 26 : 44 };
    const n = flat ? 8 : 6;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, hump = Math.sin(Math.PI * u);
      const rad = (flat ? 18 : 26) + r() * (flat ? 10 : 16) + hump * (flat ? 8 : 22);
      lobes.push({ x: W * (0.14 + 0.72 * u) + (r() - 0.5) * 10, y: body.y - body.ry * 0.55 - hump * (flat ? 10 : 40) + (r() - 0.5) * 8, rad });
    }
  }
  const shape = (grow = 0, dx = 0, dy = 0, k = 1) => {
    g.beginPath();
    g.ellipse(body.x + dx, body.y + dy, body.rx * k + grow, body.ry * k + grow, 0, 0, Math.PI * 2);
    for (const l of lobes) { g.moveTo(l.x + dx + l.rad * k + grow, l.y + dy); g.arc(l.x + dx, l.y + dy, l.rad * k + grow, 0, Math.PI * 2); }
  };
  const clipBase = () => { g.beginPath(); g.rect(0, 0, W, baseY); g.clip(); };   // 底を平らに切る
  g.save(); clipBase();
  // 0) ふんわりした縁の光
  // （縁の外側を白で少しにじませ、地図に重ねたときに黒い縁が出ないようにする）
  g.fillStyle = '#ffffff';
  for (const [gw, a] of [[9, 0.12], [6, 0.2], [3, 0.35]]) { g.globalAlpha = a; shape(gw); g.fill(); }
  g.globalAlpha = 1;
  // 1) 影色で全体
  g.fillStyle = PAL.shadow; shape(); g.fill();
  // 2) 中から明るい面を段階的に（左上から光が当たる）
  g.save(); shape(); g.clip();
  const band = (dx, dy, k, col, a = 1) => { g.globalAlpha = a; g.fillStyle = col; shape(0, dx, dy, k); g.fill(); g.globalAlpha = 1; };
  band(-4, -6, 0.96, PAL.shadow2);
  band(-8, -13, 0.88, PAL.mid);
  band(-12, -20, 0.74, PAL.light);
  band(-15, -26, 0.55, PAL.white);
  band(12, -14, 0.45, PAL.rim, 0.28);                     // 右上にうっすら桃色の光
  // 底の青い影
  const grd = g.createLinearGradient(0, baseY - 34, 0, baseY);
  grd.addColorStop(0, 'rgba(106,155,210,0)'); grd.addColorStop(1, 'rgba(90,140,200,0.9)');
  g.fillStyle = grd; g.fillRect(0, baseY - 34, W, 34);
  g.restore();
  g.restore();
  // 3) 小さなちぎれ雲
  g.fillStyle = PAL.light;
  for (let i = 0; i < 2; i++) { const x = W * (0.12 + r() * 0.76), y = H * (0.05 + r() * 0.12); g.globalAlpha = 0.75; g.beginPath(); g.ellipse(x, y, 7 + r() * 6, 3 + r() * 2, 0, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  return cv;
}

/** 雨の幕（白い絵。色は billboard.color で掛ける） */
function rain(seed) {
  const W = 64, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), r = rng(seed * 31 + 7);
  // 全体のうす色
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(255,255,255,0.75)'); bg.addColorStop(0.7, 'rgba(255,255,255,0.45)'); bg.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = bg;
  g.beginPath(); g.moveTo(8, 0); g.lineTo(W - 8, 0); g.lineTo(W - 2, H); g.lineTo(2, H); g.closePath(); g.fill();
  // 斜めの雨筋
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = 6 + r() * (W - 12), y = r() * H * 0.8, len = 20 + r() * 40;
    g.lineWidth = 1 + r() * 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x - len * 0.12, y + len); g.stroke();
  }
  return cv;
}

/**
 * 積乱雲（入道雲）：下はもくもく積み上がった塔、上は横に広がる「かなとこ雲」
 *   縦長の絵（256×400）。高さは表示側で雲底〜雲頂に合わせて伸ばす
 */
function cumulonimbus(seed) {
  const W = 256, H = 400;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), r = rng(seed * 131 + 5);
  const baseY = H * 0.97, lobes = [];
  // 塔：下から上へ、少し細くなりながら積み上がるこぶ
  for (let t = 0; t <= 1.0001; t += 0.09) {
    const cy = baseY - 30 - t * H * 0.7, wdt = 100 - t * 45 + r() * 12;       // 下は太く、上へ細く
    const cx = W / 2 + Math.sin(t * 5 + seed) * 12;
    lobes.push({ x: cx, y: cy, rad: wdt * 0.5 });                                 // 芯
    lobes.push({ x: cx - wdt * 0.62, y: cy + 6 + r() * 10, rad: wdt * (0.3 + r() * 0.14) });   // 左右に張り出すこぶ
    lobes.push({ x: cx + wdt * 0.62, y: cy + r() * 10, rad: wdt * (0.3 + r() * 0.14) });
    if (r() < 0.6) lobes.push({ x: cx + (r() - 0.5) * wdt * 0.8, y: cy - wdt * 0.35, rad: wdt * (0.28 + r() * 0.12) });
  }
  // かなとこ：上で横に広がる平たい雲
  const anvilY = H * 0.12;
  for (let i = 0; i < 9; i++) { const u = i / 8; lobes.push({ x: W * (0.06 + 0.88 * u), y: anvilY + Math.abs(u - 0.5) * 20 + (r() - 0.5) * 6, rad: 16 + r() * 10 + (1 - Math.abs(u - 0.5) * 2) * 14 }); }
  const anvil = { x: W / 2, y: anvilY + 14, rx: W * 0.47, ry: 22 };
  const shape = (grow = 0, dx = 0, dy = 0, k = 1) => {
    g.beginPath();
    g.ellipse(anvil.x + dx, anvil.y + dy, anvil.rx * k + grow, anvil.ry * k + grow, 0, 0, Math.PI * 2);
    for (const l of lobes) { g.moveTo(l.x + dx + l.rad * k + grow, l.y + dy); g.arc(l.x + dx, l.y + dy, l.rad * k + grow, 0, Math.PI * 2); }
  };
  g.save(); g.beginPath(); g.rect(0, 0, W, baseY); g.clip();
  g.fillStyle = '#ffffff';
  for (const [gw, a] of [[9, 0.12], [6, 0.2], [3, 0.35]]) { g.globalAlpha = a; shape(gw); g.fill(); }
  g.globalAlpha = 1;
  g.fillStyle = PAL.shadow; shape(); g.fill();
  g.save(); shape(); g.clip();
  const band = (dx, dy, k, col, a = 1) => { g.globalAlpha = a; g.fillStyle = col; shape(0, dx, dy, k); g.fill(); g.globalAlpha = 1; };
  band(-4, -7, 0.96, PAL.shadow2);
  band(-9, -15, 0.88, PAL.mid);
  band(-13, -23, 0.76, PAL.light);
  band(-16, -30, 0.58, PAL.white);
  band(14, -18, 0.5, PAL.rim, 0.32);
  // 下ほど暗い（雨を降らせる雲の底）
  const grd = g.createLinearGradient(0, H * 0.45, 0, baseY);
  grd.addColorStop(0, 'rgba(90,130,190,0)'); grd.addColorStop(1, 'rgba(70,110,175,0.8)');
  g.fillStyle = grd; g.fillRect(0, H * 0.45, W, baseY - H * 0.45);
  g.restore(); g.restore();
  return cv;
}

/** 薄い層雲：横に長く、うっすら透けて、横向きの筋が入った雲（512×120） */
function stratus(seed) {
  const W = 512, H = 120;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), r = rng(seed * 53 + 3);
  // 横長の雲の帯（だ円をいくつか重ねる）
  for (let i = 0; i < 11; i++) {
    const x = W * (0.1 + 0.8 * i / 10 + (r() - 0.5) * 0.06), y = H * (0.5 + (r() - 0.5) * 0.25), rx = W * (0.14 + r() * 0.1), ry = H * (0.2 + r() * 0.14);
    const grd = g.createRadialGradient(x, y, 0, x, y, rx);
    grd.addColorStop(0, 'rgba(255,255,255,0.75)'); grd.addColorStop(0.6, 'rgba(235,245,255,0.45)'); grd.addColorStop(1, 'rgba(220,235,252,0)');
    g.save(); g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y);
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, rx, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // 横向きの筋（アニメの遠景の雲のような白い線）
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const y = H * (0.25 + r() * 0.5), x0 = W * (0.05 + r() * 0.4), len = W * (0.2 + r() * 0.45);
    g.strokeStyle = `rgba(255,255,255,${0.5 + r() * 0.4})`; g.lineWidth = 1.5 + r() * 2.5;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(Math.min(W - 6, x0 + len), y + (r() - 0.5) * 4); g.stroke();
  }
  // 下側にうっすら青い影
  const sh = g.createLinearGradient(0, H * 0.5, 0, H);
  sh.addColorStop(0, 'rgba(150,185,225,0)'); sh.addColorStop(1, 'rgba(150,185,225,0.25)');
  g.globalCompositeOperation = 'source-atop'; g.fillStyle = sh; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  return cv;
}

// ---------------- 写実的な雲（もくもくした積雲・積乱雲） ----------------
//   たくさんの「光の当たった球」を重ねて描く。大きな球の表面に小さな球、その表面にさらに小さな球
//   （カリフラワーのような凹凸）。光は左上から。下ほど灰色がかり、底は平ら。

/** 光の当たった球1つ（中心が明るく、右下が灰青色、縁はやわらかく消える） */
function ball(g, x, y, r, shade = 0) {
  const k = 1 - shade * 0.25;                               // 下の方ほど少し暗く
  const c = (v, a = 1) => `rgba(${Math.round(v[0] * k)},${Math.round(v[1] * k)},${Math.round(v[2] * k)},${a})`;
  const gr = g.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.05, x, y, r);
  gr.addColorStop(0, c([255, 255, 255]));
  gr.addColorStop(0.5, c([250, 251, 253]));
  gr.addColorStop(0.78, c([228, 233, 241], 0.95));
  gr.addColorStop(0.92, c([212, 220, 232], 0.6));
  gr.addColorStop(1, c([205, 214, 228], 0));
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}

/**
 * 球の集まり（親の上半分の表面に子、子の表面に孫）を作って描く
 * @param seeds [{x, y, r}] いちばん大きな球
 */
function cauliflower(g, seeds, r, baseY, H, { flat = 1, depth = 2 } = {}) {
  const all = [];
  const grow = (b, lvl) => {
    all.push({ ...b, lvl });
    if (lvl >= depth) return;
    const n = lvl === 0 ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (1.05 + 0.9 * (i + r() * 0.8) / n);     // 上半分（左上〜右上）
      const cr = b.r * (lvl === 0 ? 0.45 + r() * 0.12 : 0.45 + r() * 0.15);
      const d = b.r * (0.78 + r() * 0.12);
      grow({ x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d * flat, r: cr }, lvl + 1);
    }
  };
  seeds.forEach(s0 => grow(s0, 0));
  // 奥（下・大きい）から手前（上・小さい）へ
  all.sort((a, b) => a.lvl - b.lvl || b.y - a.y);
  for (const b of all) if (b.y - b.r < baseY) ball(g, b.x, b.y, b.r, Math.max(0, Math.min(1, b.y / H)));
}

function finishCloud(g, W, H, baseY) {
  // 全体の光：左上が明るく、右下へ灰色がかる
  g.globalCompositeOperation = 'source-atop';
  const lt = g.createLinearGradient(W * 0.15, H * 0.1, W * 0.85, H * 0.9);
  lt.addColorStop(0, 'rgba(255,255,255,0.25)'); lt.addColorStop(0.55, 'rgba(255,255,255,0)'); lt.addColorStop(1, 'rgba(120,135,165,0.22)');
  g.fillStyle = lt; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  // 底を平らにし、下ほど灰色がかった影
  g.globalCompositeOperation = 'destination-out';
  const cut = g.createLinearGradient(0, baseY - 6, 0, baseY + 6);
  cut.addColorStop(0, 'rgba(0,0,0,0)'); cut.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = cut; g.fillRect(0, baseY - 6, W, H - baseY + 6);
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, H * 0.35, 0, baseY);
  sh.addColorStop(0, 'rgba(120,135,160,0)'); sh.addColorStop(1, 'rgba(110,125,152,0.3)');
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
}
/** 少しぼかして、球の輪郭を目立たなくする（ふわっとした雲に） */
function soften(cv, px = 2) {
  const o = document.createElement('canvas'); o.width = cv.width; o.height = cv.height;
  const g = o.getContext('2d'); g.filter = `blur(${px}px)`; g.drawImage(cv, 0, 0); g.filter = 'none';
  g.globalAlpha = 0.45; g.drawImage(cv, 0, 0); g.globalAlpha = 1;     // 細部も少し残す
  return o;
}

// --- 密度の場から描く写実的な雲 ---
//   雲の「濃さ」を、丸いかたまり（こぶ）の和＋細かいゆらぎ（フラクタルノイズ）で作り、
//   それを高さとみなして光（左上から）を当てる。くぼみは灰色、盛り上がりは白く光る。
function noise2(seed) {
  const p = new Uint8Array(512), r = rng(seed * 7 + 1);
  const base = Array.from({ length: 256 }, (_, i) => i).sort(() => r() - 0.5);
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const n = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y), A = p[X] + Y, B = p[X + 1] + Y;
    const l1 = grad(p[A], x, y) + u * (grad(p[B], x - 1, y) - grad(p[A], x, y));
    const l2 = grad(p[A + 1], x, y - 1) + u * (grad(p[B + 1], x - 1, y - 1) - grad(p[A + 1], x, y - 1));
    return l1 + v * (l2 - l1);                                   // およそ -1〜1
  };
  return (x, y, oct = 5) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); a *= 0.5; f *= 2.03; } return s; };
}

/**
 * @param lobes [{x, y, rx, ry}] 雲のかたまり（画素）
 */
function densityCloud(W, H, lobes, seed, { baseY = H * 0.9, rough = 0.25, scale = 0.011 } = {}) {
  const fbm = noise2(seed);
  const D = new Float32Array(W * H), Hh = new Float32Array(W * H), Cr = new Float32Array(W * H);
  // 1) 濃さ：かたまりのやわらかい山の和（なめらかにつながる）と最大値。かたまりごとに範囲だけ足す
  const SUM = new Float32Array(W * H), MX = new Float32Array(W * H);
  for (const l of lobes) {
    const ya = Math.max(0, Math.floor(l.y - l.ry)), yb = Math.min(H - 1, Math.ceil(l.y + l.ry));
    const xa = Math.max(0, Math.floor(l.x - l.rx)), xb = Math.min(W - 1, Math.ceil(l.x + l.rx));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry, q = dx * dx + dy * dy;
      if (q < 1) { const f = (1 - q) * (1 - q), k = y * W + x; SUM[k] += f; if (f > MX[k]) MX[k] = f; }
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sum = SUM[y * W + x], mx = MX[y * W + x];
    if (sum <= 0) continue;
    const m = 1 - Math.exp(-1.8 * sum), k = y * W + x;
    const nz = fbm(x * scale, y * scale, 4), nz2 = fbm(x * scale * 2.6 + 37, y * scale * 2.6 + 11, 3);
    D[k] = m + rough * nz * (1 - 0.5 * m);                         // 濃さ（輪郭。縁ほどゆらぐ）
    Hh[k] = 0.6 * Math.sqrt(mx) + 0.4 * m + 0.05 * nz2;             // 高さ（こぶごとの盛り上がり＋細かいもこもこ）
    Cr[k] = Math.max(0, m - mx);                                   // こぶとこぶの間のくぼみ
  }
  for (const F of [D, Hh]) for (let pass = 0; pass < 2; pass++) {   // 細かいざらつきをならす
    const src = F.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const k = y * W + x;
      F[k] = (src[k] * 4 + src[k - 1] + src[k + 1] + src[k - W] + src[k + W]) / 8;
    }
  }
  // 2) 光：濃さを高さとみなした面の向き × 左上からの光
  const L = [-0.55, -0.65, 0.52], ln = Math.hypot(...L); L[0] /= ln; L[1] /= ln; L[2] /= ln;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), img = g.createImageData(W, H), o = img.data;
  const at = (x, y) => Hh[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = D[y * W + x];
    const a = Math.min(1, Math.max(0, (d - 0.08) / 0.22)) * Math.min(1, Math.max(0, (baseY - y) / 10));
    if (a <= 0) continue;
    const gx = (at(x + 3, y) - at(x - 3, y)) * 5, gy = (at(x, y + 3) - at(x, y - 3)) * 5;
    const nl = Math.hypot(gx, gy, 1), nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
    const lam = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const depth = Math.min(1, d);                                 // 中ほど濃く（厚い所は内側が少し暗い）
    const low = Math.max(0, (y - H * 0.35) / (baseY - H * 0.35)); // 下ほど影
    // 明るさ t：日の当たる面は真っ白、くぼみ・下側は青みがかった灰色
    const t = Math.min(1, Math.max(0, 0.42 + 0.7 * lam - 0.22 * low - 0.04 * depth - 0.25 * Cr[y * W + x]));
    const k = (y * W + x) * 4;
    o[k] = 186 + 69 * t; o[k + 1] = 197 + 58 * t; o[k + 2] = 218 + 37 * t;
    o[k + 3] = Math.round(255 * a);
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/** 写実的な積雲（512×384） */
function realPuff(seed) {
  const W = 512, H = 384, r = rng(seed * 211 + 9), baseY = H * 0.88, lobes = [];
  for (let i = 0; i < 6; i++) {
    const u = (i + 0.5) / 6, hump = Math.sin(Math.PI * u), rad = 58 + hump * 44 + r() * 16;
    const x = W * (0.16 + 0.68 * u) + (r() - 0.5) * 20, y = baseY - rad * 0.5 - hump * 60 - r() * 12;
    lobes.push({ x, y, rx: rad, ry: rad * 0.95 });
    for (let k = 0; k < 4; k++) { const a = Math.PI * (1.1 + 0.8 * r()), cr = rad * (0.4 + r() * 0.15); lobes.push({ x: x + Math.cos(a) * rad * 0.75, y: y + Math.sin(a) * rad * 0.75, rx: cr, ry: cr }); }
  }
  lobes.push({ x: W * (0.42 + r() * 0.16), y: baseY - 200 - r() * 20, rx: 64, ry: 60 });
  lobes.push({ x: W / 2, y: baseY - 40, rx: W * 0.42, ry: 60 });                  // 平らな底の胴体
  return densityCloud(W, H, lobes, seed, { baseY });
}

/** 写実的な積乱雲（512×800）：もくもくの塔＋上に広がるかなとこ雲 */
function realCb(seed) {
  const W = 512, H = 800, r = rng(seed * 307 + 21), baseY = H * 0.95, lobes = [];
  for (let n = 0; n < 60; n++) {                                   // 塔（下は太く、上へ細く）：大小のこぶを不規則に
    const t = r(), cy = baseY - 60 - t * H * 0.64, half = 165 - t * 70, cx = W / 2 + Math.sin(t * 4 + seed) * 20;
    const rad = half * (0.3 + r() * 0.45);
    lobes.push({ x: cx + (r() * 2 - 1) * (half - rad * 0.5), y: cy + (r() - 0.5) * 20, rx: rad, ry: rad * (0.85 + r() * 0.2) });
  }
  for (let t = 0; t <= 1.0001; t += 0.1) {                         // 芯（すき間が空かないように）
    const half = 165 - t * 70; lobes.push({ x: W / 2 + Math.sin(t * 4 + seed) * 20, y: baseY - 60 - t * H * 0.64, rx: half * 0.75, ry: half * 0.6 });
  }
  for (let i = 0; i < 12; i++) {                                    // かなとこ雲（横に平たく広がる）
    const u = i / 11, w = 1 - Math.abs(u - 0.5) * 2;
    lobes.push({ x: W * (0.06 + 0.88 * u), y: H * 0.15 + (1 - w) * 26 + (r() - 0.5) * 10, rx: 48 + w * 34, ry: 30 + w * 24 });
  }
  for (let k = 0; k < 3; k++) lobes.push({ x: W / 2 + (k - 1) * 50, y: H * 0.22 + k * 6, rx: 70, ry: 50 });   // 塔とかなとこのつなぎ
  return densityCloud(W, H, lobes, seed, { baseY, rough: 0.28, scale: 0.014 });
}

/**
 * 横に広がった積乱雲（1024×640）：3本の塔（真ん中が一番高い）、広い雲の土台、上に大きく広がるかなとこ雲
 */
function realCbWide(seed) {
  const W = 1024, H = 640, r = rng(seed * 401 + 3), baseY = H * 0.95, lobes = [];
  // 土台：横いっぱいの低い雲
  for (let i = 0; i < 16; i++) { const u = i / 15, rad = 70 + r() * 40; lobes.push({ x: W * (0.06 + 0.88 * u) + (r() - 0.5) * 30, y: baseY - rad * 0.55 - r() * 25, rx: rad * 1.2, ry: rad * 0.8 }); }
  // 塔
  const towers = [[0.28 + r() * 0.06, 0.5 + r() * 0.08, 120], [0.5 + (r() - 0.5) * 0.06, 0.72, 150], [0.73 + r() * 0.06, 0.45 + r() * 0.1, 110]];
  for (const [cx0, hfrac, half0] of towers) {
    for (let n = 0; n < 26; n++) {
      const t = r(), cy = baseY - 70 - t * H * hfrac, half = half0 * (1 - t * 0.45), cx = W * cx0 + Math.sin(t * 4 + seed) * 14;
      const rad = half * (0.3 + r() * 0.45);
      lobes.push({ x: cx + (r() * 2 - 1) * (half - rad * 0.5), y: cy + (r() - 0.5) * 18, rx: rad, ry: rad * (0.85 + r() * 0.2) });
    }
    for (let t = 0; t <= 1.0001; t += 0.12) lobes.push({ x: W * cx0, y: baseY - 70 - t * H * hfrac, rx: half0 * (1 - t * 0.45) * 0.75, ry: half0 * 0.55 });
  }
  // かなとこ：真ん中の塔の頂から左右へ大きく
  const ay = baseY - 70 - H * 0.72 - 10;
  for (let i = 0; i < 18; i++) { const u = i / 17, w = 1 - Math.abs(u - 0.5) * 2; lobes.push({ x: W * (0.04 + 0.92 * u), y: ay + (1 - w) * 30 + (r() - 0.5) * 10, rx: 50 + w * 40, ry: 22 + w * 22 }); }
  return densityCloud(W, H, lobes, seed + 50, { baseY, rough: 0.28, scale: 0.012 });
}

/** 横に広い雲の層（揺れのある中層雲など、1024×300）：平らな底の上に、もこもこが並ぶ */
function realLayer(seed) {
  const W = 1024, H = 300, r = rng(seed * 503 + 7), baseY = H * 0.9, lobes = [];
  for (let i = 0; i < 22; i++) {
    const u = i / 21, rad = 40 + r() * 50 + Math.sin(Math.PI * u) * 30;
    lobes.push({ x: W * (0.04 + 0.92 * u) + (r() - 0.5) * 20, y: baseY - rad * 0.6 - r() * 20, rx: rad * 1.1, ry: rad * 0.9 });
  }
  for (let i = 0; i < 6; i++) lobes.push({ x: W * (0.1 + 0.8 * i / 5), y: baseY - 30, rx: 120, ry: 40 });
  return densityCloud(W, H, lobes, seed + 90, { baseY, rough: 0.3, scale: 0.014 });
}

let cache = null;
export function sprites() {
  if (cache) return cache;
  cache = {
    rain: [11, 12, 13].map(s => ({ id: `awRain${s}`, cv: rain(s) })),
    cb: [21, 22, 23].map(s => ({ id: `awRealCb${s}`, cv: realCb(s) })),          // 写実的な積乱雲（縦長）
    cbWide: [24, 25].map(s => ({ id: `awCbWide${s}`, cv: realCbWide(s) })),        // 横に広がった積乱雲
    layer: [26, 27].map(s => ({ id: `awLayerReal${s}`, cv: realLayer(s) })),       // 横に広い雲の層

    stratus: [31, 32, 33, 34].map(s => ({ id: `awSt${s}`, cv: stratus(s) })),
  };
  return cache;
}

/**
 * Cesium のビルボードは幅・高さを内部で 65,535 までしか持てない（それ以上は切り詰められ、細長くなる）。
 * そこで大きさを scale（倍率）に分けて渡す。
 */
export function bbSize(w, h) {
  const k = Math.max(1, Math.max(w, h) / 60000);
  return { width: w / k, height: h / k, scale: k };
}
