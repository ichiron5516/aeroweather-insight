// 海外のレーダーエコー（東アジア・東南アジア・西太平洋）
//   西太平洋（2026-10-17 追加）：グアム（PGUA・アンダーセン空軍基地の米国 NEXRAD）とクェゼリン（KWAJ・マーシャル諸島）。台風の監視用
//   各国の気象機関のレーダー画像はブラウザから直接読めない（CORS で拒否される）ため、
//   各国の公式レーダーを合成して配っている RainViewer（https://www.rainviewer.com/api.html）のタイルを使う。
//   ・無料版の条件（2026年1月以降）：ズーム7まで・配色は Universal Blue のみ・1IPあたり毎分100回まで・個人／教育目的
//   ・過去2時間を10分ごとに公開（それより古いコマは公開一覧から消え、URL も作れない）。ここでは20分ごとを使う
//     6時間分を動かすため、アプリを開いている間に見た時刻（URL）を端末に記録しておき、まだ画像が取れるものは再生に加える
//     （アプリを開いた直後は2時間分。開いたままにしておくと、最大6時間分までだんだん長くなる）
//   ・雨域の動き（移動の向き・速さ、発達・衰弱、近づく空港）を、国内のレーダーと同じ方法で解析して地図に矢印で出す
//   ・Universal Blue の色を反射強度（dBZ）に戻し、Marshall-Palmer の式（Z=200R^1.6）で降水強度（mm/h）にして、
//     気象庁と同じ配色に塗り直す。日本のレーダー（気象庁）と同じ色で見比べられる
import * as Cesium from 'cesium';
import { coarsen, analyzeCells, lon2px, lat2px, dirName } from './radarMotionCore.js';

const API = 'https://api.rainviewer.com/public/weather-maps.json';
export const INTL_STEP_MIN = 20;
export const INTL_HOURS = 6;
/** 地図に重ねる範囲（インド東部〜日本・グアム・クェゼリン、インドネシア北部〜沿海州） */
export const INTL_RECT = { w: 88, e: 171, s: -12, n: 55 };
const BOX = { w: 95, e: 171, s: -11, n: 45 };       // 一覧の図の範囲（ジャワ・バリ、グアム・クェゼリンまで）
const COVER = 'https://tilecache.rainviewer.com/v2/coverage/0/256/{z}/{x}/{y}/0/0_0.png';   // RainViewer のレーダー範囲（範囲外が黒）
const BASE = 'https://cyberjapandata.gsi.go.jp/xyz/english/{z}/{x}/{y}.png';   // 一覧の図の背景（国土地理院・英語表記の地図）

/** 海外の主な空港と、各国の公式レーダーのページ */
export const INTL_SITES = [
  // 韓国
  { c: '韓国', icao: 'RKSI', iata: 'ICN', name: '仁川', lat: 37.46, lon: 126.44, agency: '韓国気象庁', url: 'https://www.weather.go.kr/njpn/image/radar-images.do' },
  { c: '韓国', icao: 'RKSS', iata: 'GMP', name: 'ソウル（金浦）', lat: 37.56, lon: 126.79, agency: '韓国気象庁', url: 'https://www.weather.go.kr/njpn/image/radar-images.do', minor: true },
  { c: '韓国', icao: 'RKPK', iata: 'PUS', name: '釜山（金海）', lat: 35.18, lon: 128.94, agency: '韓国気象庁', url: 'https://www.weather.go.kr/njpn/image/radar-images.do', minor: true },
  { c: '韓国', icao: 'RKPC', iata: 'CJU', name: '済州', lat: 33.51, lon: 126.49, agency: '韓国気象庁', url: 'https://www.weather.go.kr/njpn/image/radar-images.do', minor: true },
  // 中国
  { c: '中国', icao: 'ZBAA', iata: 'PEK', name: '北京首都', lat: 40.08, lon: 116.58, agency: '中国気象局', url: 'https://www.nmc.cn/publish/radar/chinaall.html' },
  { c: '中国', icao: 'ZYTL', iata: 'DLC', name: '大連', lat: 38.97, lon: 121.54, agency: '中国気象局', url: 'https://www.nmc.cn/publish/radar/chinaall.html', minor: true },
  { c: '中国', icao: 'ZSQD', iata: 'TAO', name: '青島', lat: 36.36, lon: 120.09, agency: '中国気象局', url: 'https://www.nmc.cn/publish/radar/chinaall.html', minor: true },
  { c: '中国', icao: 'ZSPD', iata: 'PVG', name: '上海浦東', lat: 31.14, lon: 121.81, agency: '中国気象局', url: 'https://www.nmc.cn/publish/radar/shang-hai.htm' },
  { c: '中国', icao: 'ZGGG', iata: 'CAN', name: '広州', lat: 23.39, lon: 113.30, agency: '中国気象局', url: 'https://www.nmc.cn/publish/radar/chinaall.html', minor: true },
  // 香港・台湾
  { c: '香港', icao: 'VHHH', iata: 'HKG', name: '香港', lat: 22.31, lon: 113.91, agency: '香港天文台', url: 'https://www.hko.gov.hk/en/wxinfo/radars/radar.htm' },
  { c: '台湾', icao: 'RCTP', iata: 'TPE', name: '台北桃園', lat: 25.08, lon: 121.23, agency: '台湾 中央気象署', url: 'https://qpeplus.cwa.gov.tw/pub/?lang=en' },
  { c: '台湾', icao: 'RCKH', iata: 'KHH', name: '高雄', lat: 22.58, lon: 120.35, agency: '台湾 中央気象署', url: 'https://qpeplus.cwa.gov.tw/pub/?lang=en', minor: true },
  // 東南アジア
  { c: 'フィリピン', icao: 'RPLL', iata: 'MNL', name: 'マニラ', lat: 14.51, lon: 121.02, agency: 'フィリピン気象庁（PAGASA）', url: 'https://www.pagasa.dost.gov.ph/' },
  { c: 'フィリピン', icao: 'RPVM', iata: 'CEB', name: 'セブ', lat: 10.31, lon: 123.98, agency: 'フィリピン気象庁（PAGASA）', url: 'https://www.pagasa.dost.gov.ph/', minor: true },
  { c: 'ベトナム', icao: 'VVNB', iata: 'HAN', name: 'ハノイ', lat: 21.22, lon: 105.81, agency: 'ベトナム国立水文気象予報センター', url: 'https://nchmf.gov.vn/' },
  { c: 'ベトナム', icao: 'VVTS', iata: 'SGN', name: 'ホーチミン', lat: 10.82, lon: 106.65, agency: 'ベトナム国立水文気象予報センター', url: 'https://nchmf.gov.vn/' },
  { c: 'タイ', icao: 'VTBS', iata: 'BKK', name: 'バンコク', lat: 13.69, lon: 100.75, agency: 'タイ気象局', url: 'https://weather.tmd.go.th/THA_Z.php' },
  { c: 'マレーシア', icao: 'WMKK', iata: 'KUL', name: 'クアラルンプール', lat: 2.75, lon: 101.71, agency: 'マレーシア気象局', url: 'https://www.met.gov.my/' },
  { c: 'マレーシア', icao: 'WBKK', iata: 'BKI', name: 'コタキナバル', lat: 5.94, lon: 116.05, agency: 'マレーシア気象局', url: 'https://www.met.gov.my/', minor: true },
  { c: 'シンガポール', icao: 'WSSS', iata: 'SIN', name: 'シンガポール', lat: 1.36, lon: 103.99, agency: 'シンガポール気象局', url: 'https://www.weather.gov.sg/weather-rain-area-240km' },
  { c: 'インドネシア', icao: 'WIII', iata: 'CGK', name: 'ジャカルタ', lat: -6.13, lon: 106.66, agency: 'インドネシア気象気候地球物理庁（BMKG）', url: 'https://radar.bmkg.go.id/' },
  { c: 'インドネシア', icao: 'WADD', iata: 'DPS', name: 'バリ（デンパサール）', lat: -8.75, lon: 115.17, agency: 'インドネシア気象気候地球物理庁（BMKG）', url: 'https://radar.bmkg.go.id/', minor: true },
  // 西太平洋（台風の監視用）
  { c: 'グアム・北マリアナ', icao: 'PGUM', iata: 'GUM', name: 'グアム', lat: 13.48, lon: 144.80, agency: '米国気象局 グアム予報所（レーダー PGUA）', url: 'https://www.weather.gov/gum/' },
  { c: 'グアム・北マリアナ', icao: 'PGSN', iata: 'SPN', name: 'サイパン', lat: 15.12, lon: 145.73, agency: '米国気象局 グアム予報所（レーダー PGUA）', url: 'https://www.weather.gov/gum/', minor: true },
  { c: 'マーシャル諸島', icao: 'PKWA', iata: 'KWA', name: 'クェゼリン', lat: 8.72, lon: 167.73, agency: 'レーガン試験場 気象局（レーダー KWAJ）', url: 'https://www.rainviewer.com/radars/marshall-islands.html' },
];

// ---------- 色 → dBZ → mm/h ----------
// RainViewer Universal Blue（雨）の配色。dBZ −10〜65（65 以上は白）
const UB = '63615914 66635a19 69665c1e 6c685d24 6f6b5f29 726e612e 75706234 78736439 7c75653e 7f786744 827b6949 857d6a4e 88806c54 8b826d59 8e856f5e 92887164 9e93756e aa9e7978 b6a97e82 c2b4828c cec08796 d2c48ba0 d6c88faa dacc93b4 ded097be 88ddeeff 6cd1ebff 51c5e8ff 36bae5ff 1baee2ff 00a3e0ff 009ad5ff 0091caff 0088bfff 007fb4ff 0077aaff 0070a3ff 00699cff 006295ff 005b8eff 005588ff 005180ff 004e78ff 004a70ff 004768ff ffee00ff ffe000ff ffd200ff ffc500ff ffb700ff ffaa00ff ff9f00ff ff9500ff ff8b00ff ff8100ff ff4400ff f23600ff e62800ff d91b00ff cd0d00ff c10000ff a80000ff 8f0000ff 760000ff 5d0000ff ffaaffff ff9fffff ff95ffff ff8bffff ff81ffff ff77ffff ff6cffff ff62ffff ff58ffff ff4effff ffffffff'
  .split(' ').map((h, k) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), k - 10]);
const memo = new Map();
/** タイルの色から dBZ を読む（なめらか表示で混ざった色は、いちばん近い色にする） */
function dbzOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let v = memo.get(key);
  if (v === undefined) {
    let best = 1e9;
    for (const [R, G, B, d] of UB) { const e = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2; if (e < best) { best = e; v = d; } }
    if (memo.size > 50000) memo.clear();
    memo.set(key, v);
  }
  return v;
}
/** dBZ → 降水強度（mm/h）。Marshall-Palmer：Z = 200 R^1.6 */
export const mmOf = dbz => (10 ** (dbz / 10) / 200) ** (1 / 1.6);
// 気象庁の降水強度の配色（mm/h の下限 → 色）
const RAIN = [[80, [180, 0, 104]], [50, [255, 40, 0]], [30, [255, 153, 0]], [20, [250, 245, 0]], [10, [0, 65, 255]], [5, [33, 140, 255]], [1, [160, 210, 255]], [0.4, [242, 242, 255]]];
const rainColor = mm => (RAIN.find(([v]) => mm >= v) || [0, null])[1];

/** タイル画像を「mm/h の配列」と「気象庁の配色に塗り直した canvas」にする */
function decode(img, { flip = false } = {}) {
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // Cesium はタイルを上下反転済みの ImageBitmap で渡してくるので、反転を戻してから描く（cloudOnly.js と同じ）
  if (flip) { ctx.translate(0, h); ctx.scale(1, -1); }
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const d = ctx.getImageData(0, 0, w, h), p = d.data, mm = new Float32Array(w * h);
  for (let i = 0, k = 0; i < p.length; i += 4, k++) {
    const a = p[i + 3];
    if (a < 90) { p[i + 3] = 0; continue; }              // 弱いエコー（半透明）と縁は消す
    const v = mmOf(dbzOf(p[i], p[i + 1], p[i + 2])), c = rainColor(v);
    if (!c) { p[i + 3] = 0; continue; }                  // 0.4mm/h 未満は表示しない（気象庁と同じ）
    mm[k] = v; p[i] = c[0]; p[i + 1] = c[1]; p[i + 2] = c[2]; p[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return { cv, mm, w, h };
}

/** 地図に重ねるタイルの読み込み口（気象庁の配色に塗り直す） */
export class IntlRadarImageryProvider extends Cesium.UrlTemplateImageryProvider {
  constructor({ url, maximumLevel = 6 }) {
    const R = INTL_RECT;
    super({ url, maximumLevel, minimumLevel: 0, hasAlphaChannel: true, rectangle: Cesium.Rectangle.fromDegrees(R.w, R.s, R.e, R.n),
      credit: new Cesium.Credit('海外レーダー：RainViewer（各国気象機関）') });
  }
  requestImage(x, y, level, request) {
    const p = super.requestImage(x, y, level, request);
    if (!p) return p;                                     // 混雑時は Cesium があとで取り直す
    return Promise.resolve(p).then(img => decode(img, { flip: typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap }).cv);
  }
}

// ---------- 時刻 ----------
const stamp = sec => new Date(sec * 1000).toISOString().replace(/\D/g, '').slice(0, 14);   // YYYYMMDDhhmmss（UTC）
let host = 'https://tilecache.rainviewer.com';
const LOG_KEY = 'aw:rainviewerLog';
const readLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } };
const writeLog = L => { try { localStorage.setItem(LOG_KEY, JSON.stringify(L)); } catch { /* 保存できなくても続ける */ } };
let probed = null;                                       // 古いコマの画像がまだ取れるか（1回だけ確かめる）
/** 過去6時間（取れる分だけ）・20分ごと（古い順、最新を必ず含む） */
export async function intlFrames() {
  const r = await fetch(API, { cache: 'no-store' });
  if (!r.ok) throw new Error(`RainViewer ${r.status}`);
  const j = await r.json();
  host = j.host || host;
  const past = (j.radar?.past || []).slice().sort((a, b) => a.time - b.time);
  if (!past.length) throw new Error('RainViewer に観測時刻がありません');
  const last = past.at(-1).time, first = past[0].time;
  // 見た時刻を記録（6時間より古いものは捨てる）
  const log = new Map(readLog().filter(f => last - f.time <= INTL_HOURS * 3600).map(f => [f.time, f.path]));
  for (const f of past) log.set(f.time, f.path);
  let all = [...log].map(([time, path]) => ({ time, path })).sort((a, b) => a.time - b.time);
  const older = all.filter(f => f.time < first);
  if (older.length) {
    if (probed === null) {
      try { const t = await fetch(`${host}${older[0].path}/256/2/3/1/2/1_0.png`); probed = t.ok; } catch { probed = false; }
    }
    if (!probed) all = all.filter(f => f.time >= first);   // 古い URL はもう使えない
  }
  writeLog(all);
  return all.filter(f => Math.round((last - f.time) / 60) % INTL_STEP_MIN === 0)
    .map(f => ({ time: stamp(f.time), tiles: `${host}${f.path}/256/{z}/{x}/{y}/2/1_0.png` }));   // 配色2（Universal Blue）・なめらか・雪の色分けなし
}

// ---------- 一覧の図 ----------
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z * 256;
const x2lon = (x, z) => x / (2 ** z * 256) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (2 ** z * 256); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const loadRaw = src => new Promise((ok, ng) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ng(new Error('画像を取得できません')); im.src = src; });
// RainViewer は 1IP あたり毎分100回まで。一覧の図・解析の読み込みは毎分約60回に抑える（残りは地図のタイル用）
const bucket = { n: 30, t: Date.now() }, waiters = [];
function take() {
  const now = Date.now(); bucket.n = Math.min(30, bucket.n + (now - bucket.t) / 1000); bucket.t = now;
  while (waiters.length && bucket.n >= 1) { bucket.n--; waiters.shift()(); }
  if (waiters.length) setTimeout(take, 1000);
}
const slot = () => new Promise(ok => { waiters.push(ok); take(); });
const memoImg = new Map();
const loadImg = src => {
  if (!src.includes('rainviewer.com')) return loadRaw(src);
  if (memoImg.has(src)) return memoImg.get(src);
  const p = slot().then(() => loadRaw(src));
  memoImg.set(src, p); p.catch(() => memoImg.delete(src));
  if (memoImg.size > 400) memoImg.delete(memoImg.keys().next().value);
  return p;
};
const baseCache = new Map();
async function baseMap(z, X0, Y0, W, H) {
  const key = `${z}`;
  if (baseCache.has(key)) return baseCache.get(key);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1b2633'; ctx.fillRect(0, 0, W, H);
  const jobs = [];
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor((X0 + W) / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor((Y0 + H) / 256); ty++)
    jobs.push(loadImg(BASE.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then(im => ctx.drawImage(im, tx * 256 - X0, ty * 256 - Y0)).catch(() => null));
  await Promise.all(jobs);
  ctx.fillStyle = 'rgba(11,20,30,.72)'; ctx.fillRect(0, 0, W, H);   // 地図は暗く沈めて、エコーを目立たせる
  baseCache.set(key, cv);
  return cv;
}
const coverCache = new Map();
async function coverMap(z, X0, Y0, W, H) {
  if (coverCache.has(z)) return coverCache.get(z);
  const m = document.createElement('canvas'); m.width = W; m.height = H;
  const mc = m.getContext('2d'), jobs = [];
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor((X0 + W) / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor((Y0 + H) / 256); ty++)
    jobs.push(loadImg(COVER.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then(im => mc.drawImage(im, tx * 256 - X0, ty * 256 - Y0)).catch(() => null));
  await Promise.all(jobs);
  // 範囲外（黒）の所だけに斜線を残す
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.strokeStyle = 'rgba(160,175,190,.35)'; c.lineWidth = 1;
  for (let k = -H; k < W; k += 6) { c.beginPath(); c.moveTo(k, H); c.lineTo(k + H, 0); c.stroke(); }
  c.globalCompositeOperation = 'destination-in'; c.drawImage(m, 0, 0);
  coverCache.set(z, cv);
  return cv;
}
/** 空港の位置がレーダーの範囲内か（RainViewer の範囲図で確かめる） */
async function covered(s) {
  const z = 6, x = lon2x(s.lon, z), y = lat2y(s.lat, z), tx = Math.floor(x / 256), ty = Math.floor(y / 256);
  try {
    const im = await loadImg(COVER.replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    return g.getImageData(Math.floor(x) - tx * 256, Math.floor(y) - ty * 256, 1, 1).data[3] === 0;   // 透明＝範囲内
  } catch { return null; }                              // 分からないときは解析は続ける
}
/** 一覧・拡大表示用の図（東アジア〜東南アジア）。z=3 で一覧、z=4 で拡大表示 */
export async function composeIntl(tmpl, z = 3) {
  const X0 = Math.round(lon2x(BOX.w, z)), X1 = Math.round(lon2x(BOX.e, z)), Y0 = Math.round(lat2y(BOX.n, z)), Y1 = Math.round(lat2y(BOX.s, z));
  const W = X1 - X0, H = Y1 - Y0;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(await baseMap(z, X0, Y0, W, H), 0, 0);
  const jobs = [];
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor(X1 / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor(Y1 / 256); ty++)
    jobs.push(loadImg(tmpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then(im => ctx.drawImage(decode(im).cv, tx * 256 - X0, ty * 256 - Y0)).catch(() => null));
  await Promise.all(jobs);
  ctx.drawImage(await coverMap(z, X0, Y0, W, H), 0, 0);   // レーダーの範囲外を斜線で示す（「雨なし」と「データなし」を区別）
  ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
  for (let lo = 100; lo <= 170; lo += 10) { const x = lon2x(lo, z) - X0; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let la = 0; la <= 40; la += 10) { const y = lat2y(la, z) - Y0; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.font = `600 ${z >= 4 ? 12 : 10}px Meiryo, sans-serif`;
  for (const a of INTL_SITES) {
    const x = lon2x(a.lon, z) - X0, y = lat2y(a.lat, z) - Y0;
    ctx.fillStyle = '#4fc3f7'; ctx.beginPath(); ctx.arc(x, y, z >= 4 ? 3 : 2.5, 0, 7); ctx.fill();
    if (a.minor && z < 4) continue;                       // 一覧の小さな図では主な空港だけ名前を出す
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(a.iata, x + 4, y + 4);
    ctx.fillStyle = '#fff'; ctx.fillText(a.iata, x + 4, y + 4);
  }
  return cv;
}

// ---------- 自動解析：各空港の周り 100km ----------
const R_KM = 100, Z_AN = 6;
const toRad = d => d * Math.PI / 180;
function distBrg(la1, lo1, la2, lo2) {
  const p1 = toRad(la1), p2 = toRad(la2), dl = toRad(lo2 - lo1);
  const km = 6371 * 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
  const brg = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  return { km, brg };
}
const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
async function aroundSite(tmpl, s) {
  const dLa = R_KM / 111, dLo = R_KM / (111 * Math.cos(toRad(s.lat)));
  const X0 = lon2x(s.lon - dLo, Z_AN), X1 = lon2x(s.lon + dLo, Z_AN), Y0 = lat2y(s.lat + dLa, Z_AN), Y1 = lat2y(s.lat - dLa, Z_AN);
  let mx = 0, at = null, n = 0, n20 = 0, ok = 0;
  const jobs = [];
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor(X1 / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor(Y1 / 256); ty++) {
    jobs.push(loadImg(tmpl.replace('{z}', Z_AN).replace('{x}', tx).replace('{y}', ty)).then(im => {
      ok++;
      const { mm, w } = decode(im);
      for (let k = 0; k < mm.length; k++) {
        if (!mm[k]) continue;
        const px = tx * 256 + (k % w) + 0.5, py = ty * 256 + Math.floor(k / w) + 0.5;
        const la = y2lat(py, Z_AN), lo = x2lon(px, Z_AN), { km } = distBrg(s.lat, s.lon, la, lo);
        if (km > R_KM) continue;
        n++; if (mm[k] >= 20) n20++;
        if (mm[k] > mx) { mx = mm[k]; at = [la, lo]; }
      }
    }).catch(() => null));
  }
  await Promise.all(jobs);
  return { s, ok, mx, at, n, n20, cov: await covered(s) };
}
const mmText = v => (v >= 80 ? '80mm/h以上' : v >= 50 ? '50〜80mm/h' : v >= 30 ? '30〜50mm/h' : v >= 20 ? '20〜30mm/h' : v >= 10 ? '10〜20mm/h' : v >= 5 ? '5〜10mm/h' : v >= 1 ? '1〜5mm/h' : '1mm/h未満');
/** 海外の主な空港の周り 100km（約55NM）のエコーを文章にする */
export async function intlText(tmpl, timeLabel = '') {
  const res = await Promise.all(INTL_SITES.map(s => aroundSite(tmpl, s)));
  const lines = [`（${timeLabel ? timeLabel + ' の' : ''}RainViewer のエコーから、各空港の半径100km＝約55NM 以内を自動解析。強さは反射強度から換算した目安）`];
  let country = '';
  for (const r of res) {
    if (r.s.c !== country) { country = r.s.c; lines.push(`<span style="color:#8fd0ff">■ ${country}</span>`); }
    const head = `<b>${r.s.name}（${r.s.icao}）</b>：`;
    if (!r.ok) { lines.push(head + 'タイルを取得できませんでした。'); continue; }
    if (r.cov === false && !r.n) { lines.push(head + `<span style="color:#9fb3c8">レーダーの範囲外（データなし）。${r.s.agency}の公式情報を確認する。</span>`); continue; }
    if (!r.n || r.mx < 1) { lines.push(head + (r.n ? '弱い雨のエコーのみ。' : '降水エコーなし。')); continue; }
    const { km, brg } = distBrg(r.s.lat, r.s.lon, ...r.at);
    const where = km < 10 ? '空港付近' : `空港の${DIR8[Math.round(brg / 45) % 8]}約${Math.round(km / 1.852 / 5) * 5}NM`;
    const warn = r.mx >= 20 ? `。<span style="color:#ffb347">20mm/h以上の強いエコーあり（積乱雲の可能性）</span>` : '';
    lines.push(`${head}最も強いエコーは ${mmText(r.mx)}（${where}）${warn}。`);
  }
  lines.push('<span style="color:#9fb3c8">各国のレーダーの範囲外（海上の遠方など）はエコーが映らない。データの遅れや欠けもあるため、運航判断には各国の公式情報を確認する。</span>');
  return lines;
}

// ---------- 雨域の動き（国内のレーダーと同じ解析：radarMotionCore.js） ----------
//   最新・約30分前・約60分前の図（ズーム4・約9km/画素）を比べ、雨域ごとの移動と発達を求める。
//   日本付近（気象庁のレーダーの範囲）は国内の解析に任せ、ここでは除く
const MZ = 4, MBOX = { w: 95, e: 171, s: -11, n: 45 }, JMA_BOX = { w: 122.5, e: 147, s: 23.5, n: 46 };
const tsDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
async function rasterIntl(tmpl) {
  const tx0 = Math.floor(lon2px(MBOX.w, MZ) / 256), tx1 = Math.floor(lon2px(MBOX.e, MZ) / 256);
  const ty0 = Math.floor(lat2px(MBOX.n, MZ) / 256), ty1 = Math.floor(lat2px(MBOX.s, MZ) / 256);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256, rain = new Float32Array(W * H);
  let ok = 0;
  const jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
    jobs.push(loadImg(tmpl.replace('{z}', MZ).replace('{x}', x).replace('{y}', y)).then(im => {
      const { mm, w } = decode(im); ok++;
      for (let k = 0; k < mm.length; k++) if (mm[k]) rain[((y - ty0) * 256 + Math.floor(k / w)) * W + (x - tx0) * 256 + (k % w)] = mm[k];
    }).catch(() => null));
  }
  await Promise.all(jobs);
  if (!ok) throw new Error('海外レーダーの画像を取得できません');
  // 気象庁のレーダーの範囲は除く
  const X0 = tx0 * 256, Y0 = ty0 * 256;
  const jx0 = Math.round(lon2px(JMA_BOX.w, MZ)) - X0, jx1 = Math.round(lon2px(JMA_BOX.e, MZ)) - X0;
  const jy0 = Math.round(lat2px(JMA_BOX.n, MZ)) - Y0, jy1 = Math.round(lat2px(JMA_BOX.s, MZ)) - Y0;
  for (let y = Math.max(0, jy0); y < Math.min(H, jy1); y++) rain.fill(0, y * W + Math.max(0, jx0), y * W + Math.min(W, jx1));
  return { W, H, rain, z: MZ, x0: X0, y0: Y0 };
}
// 場所の名前（主な都市・空港と海域）
const PLACES = [...INTL_SITES.map(s => [s.name.replace(/（.*?）/, ''), s.lat, s.lon]),
  ['海南島', 19.2, 109.7], ['ルソン島北部', 17.5, 121.2], ['ミンダナオ島', 7.5, 125.0], ['ボルネオ島北部', 4.5, 115.5], ['ボルネオ島西部', 1.0, 110.5],
  ['スマトラ島北部', 3.5, 98.5], ['スマトラ島南部', -3.0, 104.0], ['ラオス', 18.0, 103.0], ['カンボジア', 12.5, 104.9], ['ミャンマー南部', 16.8, 96.2],
  ['武漢', 30.6, 114.3], ['重慶', 29.6, 106.5], ['昆明', 25.0, 102.7], ['厦門', 24.5, 118.1], ['平壌', 39.0, 125.8]];
const km = (a, b, c, d) => { const R = Math.PI / 180, x = (d - b) * R * Math.cos((a + c) / 2 * R), y = (c - a) * R; return 6371 * Math.hypot(x, y); };
export function intlPlaceName(lat, lon) {
  let best = null;
  for (const [n, la, lo] of PLACES) { const d = km(la, lo, lat, lon); if (!best || d < best.d) best = { n, d, la, lo }; }
  if (best.d < 100) return `${best.n}付近`;
  if (best.d < 400) {
    const brg = (Math.atan2((lon - best.lo) * Math.cos(best.la * Math.PI / 180), lat - best.la) * 180 / Math.PI + 360) % 360;
    return `${best.n}の${DIR8[Math.round(brg / 45) % 8]}約${Math.round(best.d / 50) * 50}km`;
  }
  if (lon >= 105 && lon < 120 && lat >= 3 && lat < 22) return '南シナ海';
  if (lon >= 119 && lon < 123 && lat >= 6 && lat < 12) return 'スールー海';
  if (lon >= 150 && lat < 25) return 'ミクロネシア付近の海上';
  if (lon >= 138 && lat < 25) return 'マリアナ諸島付近の海上';
  if (lon >= 125 && lat < 25) return 'フィリピンの東の海上';
  if (lat < 3 && lon >= 105 && lon < 120) return 'ジャワ海・カリマタ海峡付近';
  if (lon < 100 && lat < 15) return 'アンダマン海';
  if (lat >= 23 && lon < 123) return '中国大陸';
  return '海上';
}
const SITES_A = INTL_SITES.map(s => ({ iata: s.iata, icao: s.icao, nameJa: s.name, lat: s.lat, lon: s.lon }));
/**
 * 海外レーダーの雨域の動き
 * @param frames intlFrames() の結果（古い順）
 */
export async function analyzeIntlMotion(frames) {
  const latest = frames.at(-1), t0 = tsDate(latest.time);
  const pick = min => frames.reduce((a, f) => (Math.abs((t0 - tsDate(f.time)) / 60000 - min) < Math.abs((t0 - tsDate(a.time)) / 60000 - min) ? f : a));
  const use = [latest, pick(30), pick(60)].filter((f, i, arr) => arr.indexOf(f) === i);
  const rs = await Promise.all(use.map(f => rasterIntl(f.tiles)));
  const fr = use.map((f, i) => ({ time: tsDate(f.time), c: coarsen(rs[i], 1) }));
  const cells = fr.length > 1 ? analyzeCells(fr, SITES_A, { maxKmh: 120, cellOpts: { thr: 3, minCells: 10, maxCount: 8 } }) : [];
  const circ = '①②③④⑤⑥⑦⑧';
  const mm = v => (v >= 50 ? '50mm/h以上' : v >= 30 ? '30mm/h以上' : v >= 20 ? '20mm/h以上' : v >= 10 ? '10mm/h程度' : v >= 5 ? '5mm/h程度' : '弱い雨');
  const lines = !cells.length ? ['海外（日本付近を除く）に、動きを追えるまとまった降水エコーはない。'] : cells.map((c, i) => {
    const area = c.areaKm2 >= 10000 ? `約${Math.round(c.areaKm2 / 10000)}万km²` : `約${Math.round(c.areaKm2 / 100) * 100}km²`;
    let s = `${circ[i]} ${intlPlaceName(c.lat, c.lon)}の雨域（${area}、${c.max >= 5 ? '最大' + mm(c.max) : '弱い雨のみ'}）：`;
    const m = c.motion;
    if (!m) s += '動きを推定できませんでした。';
    else if (m.speed < 8) s += 'ほぼ停滞。';
    else s += `${dirName(m.dir)}へ時速約${Math.round(m.speed / 5) * 5}km（${Math.round(m.speed / 1.852)}kt）で移動。` + (m.conf === 'low' ? '（形の変化が大きく、動きの推定は不確か）' : '');
    s += c.trend === 'grow' ? '1時間前より発達（強まり・広がり）。' : c.trend === 'decay' ? '1時間前より衰弱傾向。' : '';
    if (c.max >= 20) s += '<span style="color:#ffb347">積乱雲の可能性</span>。';
    if (m && m.speed >= 8) s += `このまま進むと1時間後は${intlPlaceName(c.at1.lat, c.at1.lon)}。`;
    if (c.apts?.length) s += c.apts.map(p => p.now ? `${p.a.iata} ${p.a.nameJa}は現在雨域内` : p.h === 0 ? `${p.a.iata} ${p.a.nameJa}は雨域の縁にかかっている`
      : `${p.a.iata} ${p.a.nameJa}に約${p.h < 1 ? Math.round(p.h * 60) + '分' : p.h.toFixed(1).replace('.0', '') + '時間'}後に接近`).join('、') + '。';
    return s;
  });
  return { time: t0, cells, lines, lags: fr.slice(1).map(f => Math.round((t0 - f.time) / 60000)) };
}
/** 一覧の図の下に出す短い文 */
export const intlMotionShort = res => !res.cells.length ? '海外エコーの動き：まとまった雨域なし'
  : '海外エコーの動き：' + res.cells.slice(0, 3).map((c, k) => `${'①②③'[k]}${intlPlaceName(c.lat, c.lon).replace(/の.*$|付近$/, '')} ${!c.motion ? '不明' : c.motion.speed < 8 ? '停滞' : `${dirName(c.motion.dir)}へ${Math.round(c.motion.speed / 5) * 5}km/h`}`).join('・') + '（詳しくは図をクリック）';

// 地図の矢印（矢印の先＝このまま進んだときの2時間後の位置。橙＝発達中）
let mds = null, mshown = false;
export function drawIntlMotion(viewer, res) {
  if (!mds) {
    mds = new Cesium.CustomDataSource('intlRadarMotion');
    viewer.dataSources.dataSourceRemoved.addEventListener((_, d) => { if (d === mds && mshown) setTimeout(() => viewer.dataSources.add(mds), 0); });
  }
  mshown = true;
  if (!viewer.dataSources.contains(mds)) viewer.dataSources.add(mds);
  mds.entities.removeAll();
  if (!res) return;
  const CIRC = '①②③④⑤⑥⑦⑧';
  res.cells.forEach((c, i) => {
    const m = c.motion;
    const lbl = `${CIRC[i]} ${!m ? '' : m.speed < 8 ? '停滞' : `${dirName(m.dir)} ${Math.round(m.speed / 5) * 5}km/h`}${c.trend === 'grow' ? '・発達' : c.trend === 'decay' ? '・衰弱' : ''}`;
    if (m && m.speed >= 8) mds.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([c.lon, c.lat, c.at2.lon, c.at2.lat]), width: 16, clampToGround: true,
      material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.fromCssColorString(c.trend === 'grow' ? '#ff7043' : '#ffee58').withAlpha(0.95)) } });
    mds.entities.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat), label: {
      text: lbl.trim(), font: '600 13px "Meiryo", sans-serif', fillColor: Cesium.Color.WHITE, showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('rgba(20,30,45,0.85)'), pixelOffset: new Cesium.Cartesian2(0, 20),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  });
}
export function clearIntlMotion(viewer) { mshown = false; if (mds) { mds.entities.removeAll(); if (viewer.dataSources.contains(mds)) viewer.dataSources.remove(mds, false); } }

/** 「見方・見どころ」 */
export const INTL_GUIDE = {
  what: [
    '東アジア〜東南アジア・西太平洋の各国の気象レーダーを合成した降水エコー。RainViewer が各国の公開データをまとめたものを使っている。',
    '西太平洋はグアム（PGUA）とクェゼリン（KWAJ・マーシャル諸島）のレーダー（それぞれ半径約250km）。その間の海上（ミクロネシア・小笠原の南など）はレーダーがないので、台風の雲は衛星画像で見る。',
    '色は日本のレーダー（気象庁）と同じ配色に塗り直してある。青は弱い雨、黄（20mm/h以上）〜赤（50mm/h以上）は積乱雲の可能性が高い。',
    '強さは反射強度（dBZ）から Marshall-Palmer の式で換算した目安。各国の雨量計で補正した値ではない。',
    '斜線の所は RainViewer にレーダーのデータがない範囲（雨がないのではなく、分からない）。インドネシアはスマトラ北部・バタム付近など、近くの国のレーダーが届く所しか映らない。',
    '過去6時間を20分ごとに再生できる（配信元は過去2時間分しか公開していないため、アプリを開いた直後は2時間分。開いている間に見た時刻を端末に記録して、最大6時間分まで延ばす）。日本付近は気象庁のレーダーの方が細かいので、両方重ねると気象庁が上に表示される。',
    '雨域の動き（向き・速さ、発達・衰弱、近づく空港）は、最新と約30分前・60分前の図を比べて自動解析し、地図に矢印で出す（矢印の先は、このまま進んだときの2時間後の位置。橙は発達中）。日本付近は国内のレーダーの解析を使う。',
    '各国の公式レーダー：' + [...new Map(INTL_SITES.map(s => [s.agency, s])).values()].map(s => `<a href="${s.url}" target="_blank" rel="noopener" style="color:#8fd0ff">${s.c}（${s.agency}）</a>`).join('、'),
  ],
  air: [
    '国際線の出発・到着空港の周りに強いエコーがあれば、遅延・ホールディング・代替空港への影響を考える。',
    '東南アジアは午後〜夜に積乱雲が急に発達しやすい。南シナ海・スールー海の雨域は、ベトナム・フィリピン・マレーシアのレーダーの端にかかることが多い。再生と動きの矢印で、発達・移動の様子を確かめる。',
    '台湾〜沖縄・東シナ海は日本と海外のレーダーの境目。両方重ねて、つながった雨域かを確かめる。',
    '台風：グアム・クェゼリンのレーダーで、近くを通る台風の目・壁雲・らせん状の降雨帯が見える。「衛星・レーダーを重ねる」で衛星の雲と一緒に見ると、レーダーの外の雲の広がりも分かる。',
  ],
};
