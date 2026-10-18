// 機種ごとの飛行時間・燃料・CO2 の目安（2026-10-18。今は Airbus A321XLR のみ）
//   評価した経路の高度の計画（scoring.js の prof：5NM ごとの点の距離 d・高度 alt）に沿って、上昇・巡航・降下ごとに
//   真対気速度（TAS）と燃料流量を当てはめて足し合わせる。上層風の影響は考えない（対地速度＝真対気速度）
//   ・重量・気温（ISA 標準大気とする）・進入方式・待機・代替空港・予備燃料は考えない。教育用の目安
//   ・燃料は「トリップ燃料（離陸〜着陸）」と、地上走行（出発 12 分・到着 6 分）を分けて出す
//   ・ドラム缶：200L 缶。ジェット燃料（Jet A-1）の密度 0.80kg/L として 1 本 160kg
//   ・CO2：燃料 1kg あたり 3.16kg（ICAO の換算係数）
//   ・燃料代（2026-10-18 追加）：ジェット燃料は灯油とほぼ同じ値段として、灯油の店頭価格の全国平均
//     （資源エネルギー庁の石油製品価格調査。2026-09-28 時点 18L 2,538円 → 1L 約141円）で計算する。値段が変わったら FUEL_YEN_PER_L を直す
const FT = 0.3048;
/** 高度（ft）での音速（kt）。ISA。11,000m（36,089ft）より上は一定 */
const soundKt = altFt => {
  const h = Math.min(altFt * FT, 11000), T = 288.15 - 0.0065 * h;
  return 661.47 * Math.sqrt(T / 288.15);
};
/** 高度（ft）での密度比 σ（ISA） */
const sigma = altFt => {
  const h = altFt * FT;
  if (h <= 11000) return (1 - 2.25577e-5 * h) ** 4.25588;
  return 0.29707 * Math.exp(-(h - 11000) / 6341.6);
};
/** 指示対気速度（kt）→ 真対気速度（kt）。高度の低い所の近似（圧縮性は無視） */
const iasToTas = (ias, altFt) => ias / Math.sqrt(sigma(altFt));

export const AIRCRAFT = {
  A321XLR: {
    name: 'Airbus A321XLR',
    engines: 'CFM LEAP-1A ／ PW1100G（2基）',
    // 速さ：上昇・降下は 10,000ft 未満 250kt（IAS）、それより上は 290kt（IAS）、M0.78 を超えない。巡航は M0.78
    climbIas: 290, descentIas: 290, lowIas: 250, mach: 0.78,
    climbFtPerNm: 250, descentFtPerNm: 320,
    // 燃料流量（2基の合計、kg/時）：標準的な重量の目安
    //   上昇：低い所 3,900 → 高い所ほど少なく（FL350 付近で約 3,000）
    //   巡航：FL350 で 2,450。それより低いと 1,000ft ごとに +1.1%、高いと −0.6%
    //   降下：900（ほぼアイドル）
    climbFF: altFt => 3900 - 25 * (altFt / 1000),
    cruiseFF: altFt => 2450 * (altFt < 35000 ? 1 + 0.011 * (35000 - altFt) / 1000 : 1 - 0.006 * (altFt - 35000) / 1000),
    descentFF: () => 900,
    taxiKgPerMin: 11, taxiOutMin: 12, taxiInMin: 6,
  },
};
export const DEFAULT_AIRCRAFT = 'A321XLR';
const KG_LB = 2.20462, DENSITY = 0.80, DRUM_KG = 200 * DENSITY, CO2_PER_KG = 3.16;
export const FUEL_YEN_PER_L = 141;          // 円／L（灯油の店頭価格の全国平均、2026-09-28）

/** 速さ（kt、TAS）：段階と高度から */
function tasOf(ac, phase, altFt) {
  const machTas = ac.mach * soundKt(altFt);
  if (phase === 'cruise') return altFt < 25000 ? Math.min(iasToTas(ac.climbIas, altFt), machTas) : machTas;
  const ias = altFt < 10000 ? ac.lowIas : phase === 'climb' ? ac.climbIas : ac.descentIas;
  return Math.min(iasToTas(ias, altFt), machTas);
}

/**
 * 高度の計画 prof（[{ d(NM), alt(ft) }…]）から、飛行時間・燃料・CO2 を出す
 * @returns { minutes, tripKg, taxiKg, blockKg, tripLb, blockLb, drums, co2Kg, phases:{ climb, cruise, descent: { minutes, kg } } }
 */
export function flightPerf(prof, acKey = DEFAULT_AIRCRAFT) {
  const ac = AIRCRAFT[acKey];
  if (!ac || !prof?.length) return null;
  const ph = { climb: { minutes: 0, kg: 0 }, cruise: { minutes: 0, kg: 0 }, descent: { minutes: 0, kg: 0 } };
  // 揺れの評価の高度計画は、上昇・降下をゆるく見ている（上昇 130ft/NM・降下 200ft/NM）。
  // 燃料の計算では、計画の巡航高度・途中の高度変更（tg）はそのままに、出発後の上昇と最後の降下だけを
  // この機種らしい傾き（上昇 250ft/NM、降下 3°＝320ft/NM）で引き直す
  const D = prof.at(-1).d, z0 = prof[0].alt || 0, z1 = prof.at(-1).alt || 0;
  prof = prof.map(p => ({ d: p.d, alt: Math.max(0, Math.min(p.tg ?? p.alt, z0 + ac.climbFtPerNm * p.d, z1 + ac.descentFtPerNm * (D - p.d))) }));
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1], b = prof[i], dd = b.d - a.d;
    if (!(dd > 0)) continue;
    const alt = (a.alt + b.alt) / 2, dz = b.alt - a.alt;
    const phase = dz > 50 ? 'climb' : dz < -50 ? 'descent' : 'cruise';
    const min = dd / tasOf(ac, phase, alt) * 60;
    const ff = phase === 'climb' ? ac.climbFF(alt) : phase === 'descent' ? ac.descentFF(alt) : ac.cruiseFF(alt);
    ph[phase].minutes += min; ph[phase].kg += ff * min / 60;
  }
  const minutes = ph.climb.minutes + ph.cruise.minutes + ph.descent.minutes;
  const tripKg = ph.climb.kg + ph.cruise.kg + ph.descent.kg;
  const taxiKg = ac.taxiKgPerMin * (ac.taxiOutMin + ac.taxiInMin), blockKg = tripKg + taxiKg;
  return {
    aircraft: ac.name, minutes, tripKg, taxiKg, blockKg, tripLb: tripKg * KG_LB, blockLb: blockKg * KG_LB,
    drums: blockKg / DRUM_KG, co2Kg: blockKg * CO2_PER_KG, phases: ph,
    liters: blockKg / DENSITY, yen: blockKg / DENSITY * FUEL_YEN_PER_L,
  };
}

const n0 = v => Math.round(v).toLocaleString('en-US');
/** 円を「約12.3万円」「約1,234円」のように */
export const yenText = y => (y >= 1e4 ? `約${(y / 1e4).toFixed(y >= 1e6 ? 0 : 1)}万円` : `約${n0(Math.round(y / 10) * 10)}円`);
export const hm = min => { const m = Math.round(min); return `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分`; };
/** 一覧などに出す短い文 */
export const perfShort = p => (p ? `A321XLR ${hm(p.minutes)}・燃料 ${n0(Math.round(p.blockKg / 10) * 10)}kg（${n0(Math.round(p.blockLb / 10) * 10)}lbs）・ドラム缶 約${Math.round(p.drums)}本・燃料代 ${yenText(p.yen)}・CO2 ${(p.co2Kg / 1000).toFixed(1)}t` : '');
/** アドバイス文などに出す詳しい文 */
export function perfText(p) {
  if (!p) return '';
  return `【${p.aircraft} で運航した場合の目安（上層風は考えない）】飛行時間 ${hm(p.minutes)}` +
    `（上昇 ${Math.round(p.phases.climb.minutes)}分・巡航 ${Math.round(p.phases.cruise.minutes)}分・降下 ${Math.round(p.phases.descent.minutes)}分）。` +
    `消費燃料 ${n0(p.blockKg)}kg（${n0(p.blockLb)}lbs）＝ 飛行中 ${n0(p.tripKg)}kg ＋ 地上走行 ${n0(p.taxiKg)}kg、` +
    `ドラム缶（200L）約${Math.round(p.drums)}本分。燃料代 ${yenText(p.yen)}（約${n0(Math.round(p.liters / 10) * 10)}L × ${FUEL_YEN_PER_L}円/L。ジェット燃料は灯油と同じくらいの値段として、灯油の店頭価格の全国平均で計算）。` +
    `CO2 排出 約${(p.co2Kg / 1000).toFixed(1)}t（${n0(p.co2Kg)}kg）。`;
}
