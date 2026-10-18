// 天気図・画像の解説
//   ・見方（固定の解説）… 何が描かれているか、航空で何を見るか
//   ・今の状況（自動解析）… Open-Meteo（気象庁 MSM/GSM）の格子値・レーダー・SIGMET から文章を作る
//   天気図の画像そのものを読み取っているわけではないので、図と見比べながら使う。
import { rainFromRGB } from '../advisor/wxSources.js';
import { awcFetch } from './awc.js';
import { sectionText } from './sectionGuide.js';

// ---------------- 見方（固定） ----------------
export const GUIDES = {
  sfc: {
    what: ['等圧線（4hPaごと、20hPaごとに太線）と高気圧（H・高）・低気圧（L・低）の中心、前線（寒冷・温暖・停滞・閉塞）を描いた図。',
      '等圧線の間隔が狭いところほど風が強い。'],
    air: ['前線の通過時は風向の急変・ウィンドシア・下層の乱気流に注意。', '低気圧の接近で雲底が下がり、視程も悪化しやすい。',
      '冬型（西高東低）では日本海側の雪と、強い北西風による横風・乱気流。', '梅雨前線・秋雨前線の近くでは下層雲・霧・強い雨が続きやすい。'],
  },
  sfc24: {
    what: ['24時間後の気圧配置の予想図。低気圧の進路と発達、前線の動きを見る。'],
    air: ['到着時刻の天気を考えるときは、実況図とこの図を見比べて低気圧・前線が近づくか離れるかを確認する。'],
  },
  aupq78: {
    what: ['上が 700hPa（約3,000m）、下が 850hPa（約1,500m）。実線は等高度線、破線は等温線（3℃ごと）。',
      '点の網掛けは湿数（気温−露点）が3℃未満の湿った領域（湿域）で、雲が出やすい。', '850hPa の等温線を横切って吹く風から、暖気・寒気が流れ込む場所（温度移流）がわかる。'],
    air: ['0〜−20℃の湿った層は着氷に注意（上昇・降下中）。', '850hPa で −6℃以下は雪、−12℃以下は大雪の目安（冬）。',
      '850hPa の強風（40kt以上）は下層の乱気流・ウィンドシアの原因になる。'],
  },
  aupq35: {
    what: ['上が 500hPa（約5,500m）、下が 300hPa（約9,000m）。500hPa は等高度線と等温線で、気圧の谷（トラフ）・尾根（リッジ）を見る。',
      '300hPa は等風速線（20ktごと）で、ジェット気流の位置と強さを見る。'],
    air: ['トラフの前面（東側）では天気が崩れやすい。', '500hPa で −30℃以下（冬は −36℃以下）の寒気は大気が不安定で、積乱雲・雪雲が発達しやすい。',
      'ジェット軸の北側（寒気側）やトラフ付近は晴天乱気流（CAT）が起きやすい。'],
  },
  aupa25: {
    what: ['250hPa（約10,000m・FL340付近）の等高度線と等風速線。ジェット気流の軸と最大風速域を見る。'],
    air: ['巡航高度の追い風・向かい風に直結する。', 'ジェット核の上下や寒気側で風速の鉛直差（シア）が大きいところは CAT に注意。',
      '寒帯前線ジェットと亜熱帯ジェットが近づく・合流する場所は特に揺れやすい。'],
  },
  aupa20: {
    what: ['200hPa（約12,000m・FL390付近）の等高度線と等風速線。夏は亜熱帯ジェット、冬は強いジェットの中心がこの付近にある。'],
    air: ['高い巡航高度を選ぶときの風を確認する。', '圏界面付近ではジェットの上側でもシアが大きく、CAT が起きることがある。'],
  },
  typhoon: {
    what: ['気象庁の台風情報から描いた進路予想図。赤い点が現在の中心、白い実線がこれまでの経路（破線は台風になる前）。',
      '赤の塗り＝暴風域（平均風速 25m/s≒50kt 以上）、黄の塗り＝強風域（15m/s≒30kt 以上）。',
      '白い破線の円＝予報円（その時刻に中心が入る確率が約70%の範囲）。赤い線で囲まれた範囲＝暴風警戒域（予報円の中に中心が来たとき暴風域に入るおそれがある範囲）。'],
    air: ['暴風警戒域にかかる空港は、横風・ウィンドシア・強い雨で欠航やダイバートの可能性が高い。代替空港も同じ範囲に入っていないか確認する。',
      '強風域の中や台風周辺の雨雲（積乱雲）では、上昇・降下中に強い揺れが起きやすい。台風の北東側（進行方向の右側）は特に風が強い。',
      '台風の上空でも、雲頂が高い積乱雲（FL450 以上になることもある）や、台風の外側の吹き出し（上空の強い発散）で揺れることがある。経路は予報円の外側に余裕を取る。',
      '予報円は先の時刻ほど大きくなる（進路の不確かさ）。最新の発表（3時間ごと、接近時は1時間ごと）で更新する。'],
  },
  fbjp: {
    what: ['国内悪天予想図（FBJP）。予想される乱気流（波線）、着氷、積乱雲（CB）の範囲と高度、ジェット気流（最大風速）、圏界面高度、前線・低気圧の予想位置を1枚にまとめた図。'],
    air: ['経路と巡航高度が悪天域にかかるかを確認する。', '発表中の SIGMET と合わせて見る（SIGMET が実際の発表情報）。'],
  },
  axjp: {
    what: ['高層断面図（解析、00UTC・12UTC）。上段は東経140度、下段は東経130度に沿って、地上から 100hPa（約FL530）までの大気を縦に切った図。横軸は緯度（左が北、50°N〜25°N）、縦軸は気圧（左端に標準大気の高さ km・ft）。',
      '太い破線＝等風速線（20ktごと）でジェット気流の位置と高さ、太い実線＝等温位線（5Kごと）、細い実線＝等温線（5℃ごと）。各観測点（ゾンデ）の列に気温と湿数（T−Td）の値と矢羽根の風が記入されている。',
      '記号で圏界面（TROPOPAUSE LEVEL）と最大風速の高さ（MAX WIND LEVEL）が示される。'],
    air: ['等風速線が閉じて込み合う所がジェット気流の中心。その上下（とくに下側の寒気側）で風速の鉛直差が大きく、晴天乱気流（CAT）が起きやすい。',
      '等温位線の間隔が狭い層は安定層（前線面・圏界面付近）。等温位線が上に向かって急に折れ曲がる所は前線帯で、風のシアと乱気流に注意。',
      '圏界面が北で急に低くなる所（圏界面の段差・切れ目）はジェット気流の直下で、揺れやすい。',
      '湿数 3℃以下の層は雲が多い。0〜−20℃の湿った層は着氷に注意。'],
  },
  fxjp: {
    what: ['国内航空路の予想断面図（数値予報から自動作成、3時間ごと）。上段が 6時間後（FXJP106）、下段が 12時間後（FXJP112）。横軸は石垣・那覇・鹿児島・福岡・大阪・東京・仙台・札幌を結ぶ航空路、縦軸は気圧（左に高さ FL）。',
      '太い実線＝相当温位、細い実線＝気温、太い破線＝鉛直ウィンドシア（kt/1000ft）、細い破線＝等風速線、スカラップ（もこもこ）線＝湿数 3℃未満の湿った領域（雲）、☆＝圏界面。矢羽根は各地点・各高度の風。',
      '右上の小さな地図に、断面の線（航空路）と予想時刻の気圧配置が描かれている。'],
    air: ['巡航高度の風（追い風・向かい風）と、ジェット気流の中心の高さを確認する。',
      '太い破線（鉛直シア）の値が大きい層（6kt/1000ft 以上が目安）は晴天乱気流に注意。ジェット軸の下側・圏界面付近で多い。',
      'スカラップ線の中は雲の中。0〜−20℃と重なる高さは着氷に注意（上昇・降下の高度帯）。',
      '相当温位の線が縦に立ち、湿った領域が高くまで伸びる所は対流（積乱雲）が起きやすい。6時間後と12時間後を比べて、悪天域の動きを見る。'],
  },
  fxfe502: {
    what: ['極東域の数値予報図（初期時刻から 12時間後＝左、24時間後＝右）。上段は 500hPa の高度（実線、60mごと）と渦度（破線。正の渦度の所は縦線で網掛け）。',
      '下段は地上気圧（等圧線、4hPaごと）と、その前12時間の降水量（破線、mm）。',
      '渦度は空気の回転の強さ。正（反時計回り）の極大がトラフ（気圧の谷）、渦度 0 の線はジェット気流の軸の目安になる。'],
    air: ['500hPa の正の渦度の極大（トラフ）が近づく所の東側では、低気圧が発達し天気が崩れる。上空の強い風・揺れにも注意。',
      '渦度 0 の線（網掛けの縁）がジェット気流の軸付近。その北側（低気圧性シアー側）で晴天乱気流が起きやすい。',
      '降水域と強い降水の中心から、雲中の着氷・積乱雲（雷雨）が予想される場所と時刻をつかむ。12時間後と24時間後を比べて、低気圧・前線の動きを見る。'],
  },
  fxfe5782: {
    what: ['極東域の数値予報図（12時間後＝左、24時間後＝右）。上段は 500hPa の気温（実線、3℃ごと）と 700hPa の湿数（気温−露点。3℃以下の湿った所を縦線で網掛け）。',
      '下段は 850hPa の気温（実線、3℃ごと）と風（矢羽）、700hPa の鉛直流（上昇流の所を縦線で網掛け、hPa/h）。'],
    air: ['700hPa の湿った所（網掛け）と上昇流が重なる所は、雲が厚く降水がある。0〜−20℃の層では着氷に注意。',
      '850hPa の等温線が込み合う所は前線帯。風向の急変・ウィンドシア・下層の乱気流に注意。',
      '500hPa の寒気（夏 −6℃以下・冬 −30℃以下が目安）が入ると大気が不安定になり、積乱雲が発達しやすい。冬は 850hPa −6℃以下で雪の目安。'],
  },
  fxjp854: {
    what: ['日本域の数値予報図。850hPa（約1,500m）の相当温位（実線、3Kごと。太線は15Kごと）と風（矢羽、kt）の予想。上段左から 12・24時間後、下段左から 36・48時間後。',
      '相当温位は、気温と水蒸気の量を合わせた「空気の暖かさ・湿りけ」の指標。値が高い（夏で 345K 以上が目安）ほど暖かく湿った空気。'],
    air: ['相当温位の線が込み合う所（集中帯）は前線帯。梅雨前線・秋雨前線の位置と、雲・降水の帯の目安になる。',
      '高い相当温位の空気（舌状に北へ伸びる所）が南西風で流れ込む所は、積乱雲が発達し大雨・雷雨になりやすい。その空港の発着時刻と重なるか確認する。',
      '850hPa の強い風（下層ジェット、30〜40kt 以上）は、湿った空気を運ぶとともに、離着陸時の揺れ・ウィンドシアの原因になる。',
      '12〜48時間後の4面を並べて見ると、前線と湿った空気の動きが分かる。'],
  },
  fupa252: {
    what: ['アジア太平洋域の 250hPa（約10,000m・FL340付近）の24時間予想図。実線は等高度線、破線は等風速線（20ktごと）、数字は気温（℃）、矢羽は風。'],
    air: ['巡航高度でのジェット気流の位置と強さの24時間後の予想。追い風・向かい風と、経路の選び方に直結する。',
      '実況の AUPA25 と比べて、ジェット気流とトラフ・リッジの動きを見る。等風速線が込み合う所（特にジェット軸の北側）は晴天乱気流に注意。'],
  },
  fupa302: {
    what: ['アジア太平洋域の 300hPa（約9,000m・FL300付近）の24時間予想図。実線は等高度線、破線は等風速線（20ktごと）、数字は気温（℃）、矢羽は風。'],
    air: ['FL300前後で巡航する便の風と、ジェット気流の予想位置を確認する。',
      '250hPa の予想図と比べ、ジェット気流の中心の高さ（どちらで風が強いか）を見る。風速の差が大きい層は鉛直シアが大きく揺れやすい。'],
  },
  fupa502: {
    what: ['アジア太平洋域の 500hPa（約5,500m）の24時間予想図。実線は等高度線（60mごと）、破線は等風速線（20ktごと）、数字は気温（℃）、矢羽は風。'],
    air: ['トラフ（気圧の谷）とリッジ（尾根）の24時間後の位置。トラフの前面（東側）では天気が崩れ、上昇・降下中の悪天に注意。',
      '寒気（−30℃以下など）の南下は大気を不安定にし、積乱雲や雪雲の発達につながる。台風の動きを予想する目安にもなる（500hPa の流れに乗って動く）。'],
  },
  vis: {
    what: ['可視画像（雲が太陽光を反射する明るさ）。白いほど厚い雲。夜間は暗く使えない。'],
    air: ['積乱雲は白く凹凸のある塊、霧・層雲は滑らかで輪郭のはっきりした灰白色に写る。'],
  },
  ir: {
    what: ['赤外画像（雲頂の温度）。白いほど雲頂が冷たく、背の高い雲。昼夜使える。'],
    air: ['白く小さい雲が急に大きくなるのは発達中の積乱雲。', '霧や下層雲は地面と温度が近く、ほとんど写らない（可視画像やMETARで補う）。'],
  },
  radar: {
    what: ['レーダーで観測した降水の強さ（mm/h）。青は弱い雨、黄（20mm/h以上）〜赤（50mm/h以上）は積乱雲の可能性が高い。'],
    air: ['強いエコーはおおむね 20NM 以上離して迂回する。', '線状に並ぶ強いエコー（スコールライン）は迂回が難しく、空港の運用にも影響する。'],
  },
};

// ---------------- 格子データ ----------------
const OM = 'https://api.open-meteo.com/v1/forecast';
const VARS = ['pressure_msl', 'temperature_850hPa', 'wind_speed_850hPa', 'wind_direction_850hPa', 'temperature_700hPa', 'relative_humidity_700hPa',
  'geopotential_height_500hPa', 'temperature_500hPa', 'wind_speed_300hPa', 'geopotential_height_300hPa',
  'wind_speed_250hPa', 'wind_direction_250hPa', 'geopotential_height_250hPa', 'wind_direction_300hPa', 'wind_speed_200hPa',
  'relative_humidity_850hPa'];   // 相当温位（FXJP854）用。16変数でも Open-Meteo の数え方は同じ（10変数ごとに1回分）
const cache = new Map();

/** 日本付近の格子値。valid（Date）を渡すとその時刻の予想値、省略すると今の値 */
export async function fetchSynoptic(valid = null) {
  const hour = valid ? valid.toISOString().slice(0, 13) + ':00' : 'now';
  const c = cache.get(hour);
  if (c && Date.now() - c.at < 10 * 60e3) return c.data;
  const lats = [], lons = [];
  for (let a = 22; a <= 48; a += 2) lats.push(a);
  for (let o = 118; o <= 152; o += 2) lons.push(o);
  const pts = lats.flatMap((la, i) => lons.map((lo, j) => ({ la, lo, i, j })));
  const out = {}; VARS.forEach(v => { out[v] = lats.map(() => lons.map(() => null)); });
  for (let s = 0; s < pts.length; s += 90) {
    const b = pts.slice(s, s + 90);
    const when = valid ? `start_hour=${hour}&end_hour=${hour}` : 'forecast_hours=1';
    const u = `${OM}?latitude=${b.map(p => p.la).join(',')}&longitude=${b.map(p => p.lo).join(',')}&hourly=${VARS.join(',')}&${when}&models=jma_seamless&wind_speed_unit=kn&timezone=GMT`;
    const r = await fetch(u);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(/Daily/i.test(j.reason || '') ? 'Open-Meteo の1日の利用上限に達しました（明日の朝9時ごろに戻ります）' : 'Open-Meteo ' + r.status);
    }
    const j = await r.json(); const arr = Array.isArray(j) ? j : [j];
    b.forEach((p, n) => VARS.forEach(v => { out[v][p.i][p.j] = arr[n].hourly?.[v]?.[0] ?? null; }));
    out.time = arr[0].hourly?.time?.[0];
  }
  const data = { lats, lons, ...out };
  cache.set(hour, { at: Date.now(), data });
  return data;
}

// ---------------- 場所の言い方 ----------------
const REF = [['札幌', 43.06, 141.35], ['釧路', 42.98, 144.38], ['仙台', 38.27, 140.87], ['新潟', 37.9, 139.02], ['東京', 35.68, 139.77], ['名古屋', 35.18, 136.9],
  ['大阪', 34.69, 135.5], ['広島', 34.39, 132.46], ['福岡', 33.59, 130.4], ['鹿児島', 31.6, 130.56], ['那覇', 26.21, 127.68], ['石垣', 24.34, 124.16],
  ['ソウル', 37.57, 126.98], ['上海', 31.23, 121.47], ['ウラジオストク', 43.12, 131.89], ['サハリン南部', 46.96, 142.73]];
const km = (a, b, c, d) => { const r = Math.PI / 180; return 6371 * Math.acos(Math.min(1, Math.sin(a * r) * Math.sin(c * r) + Math.cos(a * r) * Math.cos(c * r) * Math.cos((d - b) * r))); };
const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export function placeName(lat, lon) {
  let best = null;
  for (const [n, la, lo] of REF) { const d = km(la, lo, lat, lon); if (!best || d < best.d) best = { n, d, la, lo }; }
  if (best.d < 120) return `${best.n}付近`;
  if (best.d < 500) {
    const brg = (Math.atan2((lon - best.lo) * Math.cos(best.la * Math.PI / 180), lat - best.la) * 180 / Math.PI + 360) % 360;
    return `${best.n}の${DIR8[Math.round(brg / 45) % 8]}約${Math.round(best.d / 50) * 50}km`;
  }
  if (lat >= 44 && lon >= 142) return 'オホーツク海';
  if (lon >= 142 && lat < 40) return '日本の東の太平洋';
  if (lat < 30 && lon >= 128) return '日本の南の海上';
  if (lat < 30) return '東シナ海';
  if (lon < 125) return '中国大陸';
  return '日本海';
}
const near = (g, lat0, lat1, lon0, lon1, f) => {
  const out = [];
  g.lats.forEach((la, i) => g.lons.forEach((lo, j) => { if (la >= lat0 && la <= lat1 && lo >= lon0 && lo <= lon1) out.push(f(i, j, la, lo)); }));
  return out.filter(x => x != null);
};
const JP = [26, 46, 124, 148];     // 日本付近の範囲

// ---------------- 図ごとの自動解析 ----------------
function extrema(g, key, kind) {
  const F = g[key], res = [];
  for (let i = 1; i < g.lats.length - 1; i++) for (let j = 1; j < g.lons.length - 1; j++) {
    const v = F[i][j]; if (v == null) continue;
    let ok = true, diff = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const w = F[i + di][j + dj]; if (w == null) { ok = false; continue; }
      if (kind === 'min' ? w <= v : w >= v) ok = false;
      diff = Math.max(diff, Math.abs(w - v));
    }
    if (ok && diff >= 1) res.push({ lat: g.lats[i], lon: g.lons[j], v });
  }
  return res.filter(p => p.lat >= 22 && p.lat <= 50 && p.lon >= 116 && p.lon <= 154)
    .sort((a, b) => km(38, 136, a.lat, a.lon) - km(38, 136, b.lat, b.lon));
}

function surface(g) {
  const s = [];
  const lows = extrema(g, 'pressure_msl', 'min').slice(0, 3), highs = extrema(g, 'pressure_msl', 'max').slice(0, 3);
  if (lows.length) s.push('低気圧：' + lows.map(p => `${placeName(p.lat, p.lon)}（${Math.round(p.v)}hPa）`).join('、') + '。');
  if (highs.length) s.push('高気圧：' + highs.map(p => `${placeName(p.lat, p.lon)}（${Math.round(p.v)}hPa）`).join('、') + '。');
  // 冬型・夏型の目安
  const west = near(g, 30, 46, 116, 126, (i, j) => g.pressure_msl[i][j]), east = near(g, 36, 48, 142, 152, (i, j) => g.pressure_msl[i][j]);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  if (west.length && east.length && avg(west) - avg(east) >= 8) s.push(`大陸側が高く日本の東が低い「西高東低」（気圧差 約${Math.round(avg(west) - avg(east))}hPa）。北西の季節風が強まりやすい。`);
  const south = near(g, 24, 30, 130, 150, (i, j) => g.pressure_msl[i][j]), north = near(g, 40, 48, 124, 146, (i, j) => g.pressure_msl[i][j]);
  if (south.length && north.length && avg(south) - avg(north) >= 6) s.push('南が高く北が低い「南高北低」で、南寄りの風になりやすい。');
  // 気圧傾度
  let mx = 0, at = null;
  g.lats.forEach((la, i) => g.lons.forEach((lo, j) => {
    if (la < JP[0] || la > JP[1] || lo < JP[2] || lo > JP[3] || i === 0 || j === 0 || i === g.lats.length - 1 || j === g.lons.length - 1) return;
    const dx = (g.pressure_msl[i][j + 1] - g.pressure_msl[i][j - 1]) / (2 * 2 * 111 * Math.cos(la * Math.PI / 180));
    const dy = (g.pressure_msl[i + 1][j] - g.pressure_msl[i - 1][j]) / (2 * 2 * 111);
    const gr = Math.hypot(dx, dy) * 100;
    if (gr > mx) { mx = gr; at = [la, lo]; }
  }));
  if (at && mx >= 1.6) s.push(`等圧線が最も混んでいるのは${placeName(...at)}（100kmあたり約${mx.toFixed(1)}hPa）。地上・下層の強風に注意。`);
  return s;
}

// 850hPa の相当温位（K）。気温と湿度から（Bolton の近似）
function thetaE850(t, rh) {
  if (t == null || rh == null) return null;
  const T = t + 273.15, es = 6.112 * Math.exp(17.67 * t / (t + 243.5)), e = es * Math.max(1, rh) / 100;
  const r = 0.622 * e / (850 - e), Td = 243.5 * Math.log(e / 6.112) / (17.67 - Math.log(e / 6.112)) + 273.15;
  const TL = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56;
  return T * (1000 / 850) ** (0.2854 * (1 - 0.28 * r)) * Math.exp((3376 / TL - 2.54) * r * (1 + 0.81 * r));
}
function thetaEText(g) {
  if (!g.relative_humidity_850hPa) return ['850hPa の湿度を取得できなかったため、相当温位は解析できません。'];
  const s = [];
  const te = near(g, ...JP, (i, j, la, lo) => { const v = thetaE850(g.temperature_850hPa[i][j], g.relative_humidity_850hPa[i][j]); return v == null ? null : { v, la, lo, i, j }; });
  if (!te.length) return s;
  const hi = te.reduce((a, b) => (b.v > a.v ? b : a)), lo = te.reduce((a, b) => (b.v < a.v ? b : a));
  s.push(`850hPa の相当温位は日本付近で ${Math.round(lo.v)}K（${placeName(lo.la, lo.lo)}）〜 ${Math.round(hi.v)}K（${placeName(hi.la, hi.lo)}）。`);
  const moist = te.filter(x => x.v >= 345);
  if (moist.length) {
    const c = moist.reduce((a, b) => ({ la: a.la + b.la / moist.length, lo: a.lo + b.lo / moist.length }), { la: 0, lo: 0 });
    s.push(`345K 以上の暖かく湿った空気が ${moist.length} 格子（中心は${placeName(c.la, c.lo)}）。南西風で流れ込む所は積乱雲・大雨・雷雨に注意。`);
  } else s.push('345K 以上の特に暖かく湿った空気は日本付近にない。');
  // 集中帯（前線帯の目安）：南北方向の相当温位の差が大きい所
  let mx = 0, at = null;
  for (const x of te) {
    if (x.i === 0 || x.i === g.lats.length - 1) continue;
    const a = thetaE850(g.temperature_850hPa[x.i - 1][x.j], g.relative_humidity_850hPa[x.i - 1][x.j]), b = thetaE850(g.temperature_850hPa[x.i + 1][x.j], g.relative_humidity_850hPa[x.i + 1][x.j]);
    if (a == null || b == null) continue;
    const gr = Math.abs(a - b) / (Math.abs(g.lats[x.i - 1] - g.lats[x.i + 1]) * 111) * 100;
    if (gr > mx) { mx = gr; at = [x.la, x.lo]; }
  }
  if (at && mx >= 4) s.push(`相当温位の線が込み合う集中帯（前線帯の目安）が${placeName(...at)}にある（100kmあたり約${mx.toFixed(1)}K）。雲と降水の帯、下層のウィンドシアに注意。`);
  return s;
}

function lower(g) {
  const s = [];
  const t850 = near(g, ...JP, (i, j, la, lo) => ({ v: g.temperature_850hPa[i][j], la, lo }));
  const cold = t850.reduce((a, b) => (b.v < a.v ? b : a)), warm = t850.reduce((a, b) => (b.v > a.v ? b : a));
  s.push(`850hPa の気温は日本付近で ${Math.round(cold.v)}℃（${placeName(cold.la, cold.lo)}）〜 ${Math.round(warm.v)}℃（${placeName(warm.la, warm.lo)}）。`);
  if (cold.v <= -12) s.push('−12℃以下の強い寒気があり、日本海側で大雪のおそれ。');
  else if (cold.v <= -6) s.push('−6℃以下の寒気があり、雪の目安を下回る地域がある。');
  // 前線帯の目安（850hPa の温度傾度）
  let mx = 0, at = null;
  g.lats.forEach((la, i) => g.lons.forEach((lo, j) => {
    if (la < JP[0] || la > JP[1] || lo < JP[2] || lo > JP[3] || i === 0 || i === g.lats.length - 1) return;
    const gr = Math.abs(g.temperature_850hPa[i + 1][j] - g.temperature_850hPa[i - 1][j]) / (4 * 111) * 100;
    if (gr > mx) { mx = gr; at = [la, lo]; }
  }));
  if (at && mx >= 1.5) s.push(`850hPa で南北の気温差が大きい帯（前線帯の目安）が${placeName(...at)}にある（100kmあたり約${mx.toFixed(1)}℃）。`);
  const jet = near(g, ...JP, (i, j, la, lo) => ({ v: g.wind_speed_850hPa[i][j], d: g.wind_direction_850hPa[i][j], la, lo })).reduce((a, b) => (b.v > a.v ? b : a));
  if (jet.v >= 40) s.push(`850hPa で ${Math.round(jet.d)}° ${Math.round(jet.v)}kt の強風（${placeName(jet.la, jet.lo)}）。下層の乱気流・ウィンドシアに注意。`);
  const wet = near(g, ...JP, (i, j, la, lo) => (g.relative_humidity_700hPa[i][j] >= 90 ? { la, lo, t: g.temperature_700hPa[i][j] } : null));
  if (wet.length) {
    const c = wet.reduce((a, b) => ({ la: a.la + b.la / wet.length, lo: a.lo + b.lo / wet.length, t: a.t }), { la: 0, lo: 0, t: wet[0].t });
    s.push(`700hPa で湿度90%以上の湿った領域が ${wet.length} 格子（中心は${placeName(c.la, c.lo)}）。厚い雲がある可能性。`);
    const ice = wet.filter(w => w.t <= 0 && w.t >= -20).length;
    if (ice) s.push(`そのうち気温 0〜−20℃ の場所が ${ice} 格子あり、3,000m付近で着氷のおそれ。`);
  } else s.push('700hPa に目立った湿った領域はない。');
  return s;
}

function jetAxis(g, spdKey, minKt) {
  const axis = [];
  g.lons.forEach((lo, j) => {
    if (lo < 124 || lo > 148) return;
    let best = null;
    g.lats.forEach((la, i) => { const v = g[spdKey][i][j]; if (v != null && (!best || v > best.v)) best = { la, lo, v }; });
    if (best && best.v >= minKt) axis.push(best);
  });
  return axis;
}
function middle(g) {
  const s = [];
  // トラフ: 北緯35〜45度の 500hPa 高度が、帯の平均より最も低い経度
  const band = g.lons.filter(lo => lo >= 122 && lo <= 150).map(lo => {
    const j = g.lons.indexOf(lo);
    const v = g.lats.map((la, i) => (la >= 36 && la <= 44 ? g.geopotential_height_500hPa[i][j] : null)).filter(x => x != null);
    return { lo, z: v.reduce((a, b) => a + b, 0) / v.length };
  });
  const mean = band.reduce((a, b) => a + b.z, 0) / band.length;
  // 範囲の端は谷・尾根と判定しない（範囲外にもっと低い・高いところがあるかもしれないため）
  const inner = band.slice(1, -1);
  const tr = inner.reduce((a, b) => (b.z < a.z ? b : a)), rg = inner.reduce((a, b) => (b.z > a.z ? b : a));
  const isMin = band.indexOf(tr) > 0 && tr.z <= band[band.indexOf(tr) - 1].z && tr.z <= band[band.indexOf(tr) + 1].z;
  const isMax = band.indexOf(rg) > 0 && rg.z >= band[band.indexOf(rg) - 1].z && rg.z >= band[band.indexOf(rg) + 1].z;
  if (isMin && mean - tr.z > 30) s.push(`500hPa の気圧の谷（トラフ）は東経${tr.lo}度付近。その東側（前面）で天気が崩れやすい。`);
  if (isMax && rg.z - mean > 30) s.push(`気圧の尾根（リッジ）は東経${rg.lo}度付近。`);
  const t5 = near(g, ...JP, (i, j, la, lo) => ({ v: g.temperature_500hPa[i][j], la, lo })).reduce((a, b) => (b.v < a.v ? b : a));
  s.push(`500hPa の最も低い気温は ${Math.round(t5.v)}℃（${placeName(t5.la, t5.lo)}）。${t5.v <= -36 ? '強い寒気で、積乱雲・雪雲が発達しやすい。' : t5.v <= -30 ? '寒気が入っており、大気がやや不安定。' : ''}`);
  const ax = jetAxis(g, 'wind_speed_300hPa', 70);
  if (ax.length) {
    const mx = ax.reduce((a, b) => (b.v > a.v ? b : a));
    s.push(`300hPa のジェット気流の軸は北緯${Math.min(...ax.map(a => a.la))}〜${Math.max(...ax.map(a => a.la))}度、最大 ${Math.round(mx.v)}kt（${placeName(mx.la, mx.lo)}）。`);
  } else s.push('300hPa に 70kt 以上の強いジェットは日本付近にない。');
  return s;
}

function upper(g, level) {
  const s = [];
  const key = `wind_speed_${level}hPa`;
  const ax = jetAxis(g, key, 80);
  if (ax.length) {
    const mx = ax.reduce((a, b) => (b.v > a.v ? b : a));
    s.push(`${level}hPa のジェット軸は北緯${Math.min(...ax.map(a => a.la))}〜${Math.max(...ax.map(a => a.la))}度、最大 ${Math.round(mx.v)}kt（${placeName(mx.la, mx.lo)}）。`);
    if (mx.v >= 150) s.push('150kt を超える強いジェット。西行きは向かい風が大きく、軸付近は揺れやすい。');
  } else s.push(`${level}hPa に 80kt 以上のジェットは日本付近にない。`);
  // 300→250hPa の鉛直シア（kt/1000ft）。6以上は並の CAT の目安
  const sh = near(g, ...JP, (i, j, la, lo) => {
    const z1 = g.geopotential_height_300hPa[i][j], z2 = g.geopotential_height_250hPa[i][j];
    const v1 = g.wind_speed_300hPa[i][j], d1 = g.wind_direction_300hPa[i][j], v2 = g.wind_speed_250hPa[i][j], d2 = g.wind_direction_250hPa[i][j];
    if ([z1, z2, v1, d1, v2, d2].some(x => x == null)) return null;
    const r = Math.PI / 180, du = v2 * Math.sin(d2 * r) - v1 * Math.sin(d1 * r), dv = v2 * Math.cos(d2 * r) - v1 * Math.cos(d1 * r);
    return { v: Math.hypot(du, dv) / ((z2 - z1) * 3.28084 / 1000), la, lo };
  });
  const strong = sh.filter(x => x.v >= 6);
  if (strong.length) {
    const mx = strong.reduce((a, b) => (b.v > a.v ? b : a));
    s.push(`FL300〜340 の鉛直シアが 6kt/1000ft 以上（並の CAT の目安）の場所が ${strong.length} 格子。最大は${placeName(mx.la, mx.lo)}で ${mx.v.toFixed(1)}kt/1000ft。`);
  } else s.push('FL300〜340 で CAT の目安（6kt/1000ft）を超える鉛直シアは見当たらない。');
  return s;
}

async function radarText(canvasFromTiles) {
  const s = [];
  const cv = await canvasFromTiles();
  const { width: W, height: H } = cv;
  const px = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  // 範囲は北緯23.5〜46度・東経122.5〜147度（一覧の画像と同じ）
  const lon = x => 122.5 + (147 - 122.5) * x / W;
  const lat = y => { const m0 = Math.log(Math.tan(Math.PI / 4 + 46 * Math.PI / 360)), m1 = Math.log(Math.tan(Math.PI / 4 + 23.5 * Math.PI / 360)); const m = m0 + (m1 - m0) * y / H; return (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI; };
  let mx = 0, at = null, n20 = 0;
  const cells = new Map();
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const k = (y * W + x) * 4, v = rainFromRGB(px[k], px[k + 1], px[k + 2], px[k + 3]);
    if (v >= 20) { n20++; const key = `${Math.round(lat(y))},${Math.round(lon(x))}`; cells.set(key, (cells.get(key) || 0) + 1); }
    if (v > mx) { mx = v; at = [lat(y), lon(x)]; }
  }
  if (!at || mx < 1) { s.push('日本付近に降水エコーはほとんどない。'); return s; }
  s.push(`最も強いエコーは ${mx >= 80 ? '80mm/h以上' : mx + 'mm/h程度'}（${placeName(...at)}）。`);
  if (n20) {
    const top = [...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => placeName(...k.split(',').map(Number)));
    s.push(`20mm/h以上の強いエコーが主にあるのは ${[...new Set(top)].join('、')}。積乱雲の可能性があり、経路が近ければ迂回を検討。`);
  } else s.push('20mm/h以上の強いエコーはない（弱い雨のみ）。');
  return s;
}

async function sigmetsJP() {
  const list = await awcFetch('isigmet?format=json', 'json');
  const now = Date.now() / 1000, seen = new Set();
  return (Array.isArray(list) ? list : []).filter(x => /RJJJ/.test(x.firId || '') && (!x.validTimeTo || x.validTimeTo > now)).filter(x => {
    const k = `${x.hazard}|${x.qualifier}|${x.top}|${x.validTimeTo}`; if (seen.has(k)) return false; seen.add(k); return true;
  }).map(x => {
    const c = (x.coords || []).map(p => [+p.lat, +p.lon]).filter(p => isFinite(p[0]));
    const at = c.length ? placeName(c.reduce((a, p) => a + p[0], 0) / c.length, c.reduce((a, p) => a + p[1], 0) / c.length) : '';
    return { ...x, at };
  });
}
const HZ = { TS: '雷雨', TURB: '乱気流', ICE: '着氷', MTW: '山岳波', TC: '台風', VA: '火山灰', CB: '積乱雲' };
async function fbjpText(g) {
  const s = [];
  try {
    const jp = await sigmetsJP();
    if (jp.length) jp.slice(0, 8).forEach(x => s.push(`SIGMET 発表中：${HZ[x.hazard] || x.hazard}（${x.hazard}${x.qualifier ? ' ' + x.qualifier : ''}）${x.at ? '・' + x.at : ''}、${x.base ? 'FL' + Math.round(x.base / 100) : 'SFC'}〜FL${Math.round((x.top || 0) / 100)}（${new Date(x.validTimeTo * 1000).toISOString().slice(11, 16)}Z まで）。`));
    else s.push('福岡FIR（日本）に発表中の SIGMET はない。');
  } catch { s.push('SIGMET を取得できませんでした。'); }
  return s.concat(upper(g, 250).slice(-1));
}

/** id に応じた「今の状況」の文の配列 */
export async function analyze(id, { tilesCanvas, radarCanvas, init } = {}) {
  if (id === 'axjp' || id === 'fxjp') {
    if (!init) return ['図の時刻が分からないため解析できません。'];
    return [`（図と同じ線に沿った気象庁モデルの値から自動解析。${id === 'fxjp' ? '予想時刻' : '解析時刻'}の値）`].concat(await sectionText(id, init));
  }
  if (id === 'vis') {
    const h = new Date().getUTCHours();
    return h >= 10 && h < 21 ? ['現在は日本付近が夜間のため、可視画像はほぼ真っ暗。赤外画像を使う。'] : ['日中のため可視画像が使える。白く凹凸のある雲の塊が積乱雲の目安。'];
  }
  if (id === 'radar') return radarText(tilesCanvas);
  // FXJP854：最初の面（12時間後）の予想値で、相当温位と 850hPa の風を解析する
  if (id === 'fxjp854') {
    if (!init) return ['図の時刻が分からないため解析できません。'];
    const valid = new Date(init.getTime() + 12 * 3600e3);
    const g = await fetchSynoptic(valid);
    const vt = `${String(valid.getUTCDate()).padStart(2, '0')}日${String(valid.getUTCHours()).padStart(2, '0')}UTC`;
    return [`（12時間後＝${vt} の予想値から自動解析。図の左上のパネルと対応）`].concat(thetaEText(g), lower(g).filter(x => x.startsWith('850hPa で ')));
  }
  // 予想図：予想時刻（初期時刻＋24時間）のモデル値で解析する
  if (['fxfe502', 'fxfe5782', 'fupa252', 'fupa302', 'fupa502'].includes(id)) {
    if (!init) return ['図の時刻が分からないため解析できません。'];
    const valid = new Date(init.getTime() + 24 * 3600e3);
    const g = await fetchSynoptic(valid);
    const vt = `${String(valid.getUTCDate()).padStart(2, '0')}日${String(valid.getUTCHours()).padStart(2, '0')}UTC`;
    const head = [`（24時間後＝${vt} の予想値から自動解析。図の右側のパネルと対応）`];
    if (id === 'fxfe502') return head.concat(surface(g), middle(g));
    if (id === 'fxfe5782') return head.concat(lower(g), middle(g));
    if (id === 'fupa252') return head.concat(upper(g, 250));
    if (id === 'fupa302') return head.concat(upper(g, 250).filter(x => !x.startsWith('FL3')).map(x => x.replace('250hPa', '250hPa（300hPa 付近の目安）')));
    return head.concat(middle(g));
  }
  const g = await fetchSynoptic();
  const head = g.time ? [`（${g.time.replace('T', ' ')}Z のモデル値から自動解析）`] : [];
  if (id === 'sfc' || id === 'sfc24') {
    let tc = [];
    try { tc = (await sigmetsJP()).filter(x => x.hazard === 'TC').map(x => `台風（${x.qualifier || '名称不明'}）が${x.at}にあり、SIGMET が発表中。`); } catch { /* 取得できなくても続ける */ }
    return head.concat(tc, surface(g), id === 'sfc24' ? ['※ 24時間予想図の解説ではなく、現在の気圧配置の解析。予想図と見比べて変化を確認する。'] : []);
  }
  if (id === 'aupq78') return head.concat(lower(g));
  if (id === 'aupq35') return head.concat(middle(g));
  if (id === 'aupa25') return head.concat(upper(g, 250));
  if (id === 'aupa20') return head.concat(upper(g, 200).filter(x => !x.startsWith('FL300')));
  if (id === 'fbjp') return head.concat(await fbjpText(g));
  if (id === 'ir') return (radarCanvas ? radarText(radarCanvas) : Promise.resolve(['レーダーを取得できませんでした。'])).then(r => ['（同じ時刻のレーダーから、強い降水域を示す。雲の動きと種類は上の自動解析を参照）'].concat(r));
  return [];
}
