// 衛星画像（ひまわり 全球画像）が地図に表示される範囲（2026-10-18）
//   ひまわりは東経 140.7 度の赤道上にいるので、見える範囲はそこを中心とした円になる。
//   静止衛星から見える地球のふちは、衛星の真下から約 81.3 度（地球の中心から見た角度）。画像に写る所までとして 81 度を範囲とする
//   （2026-10-18 に 75 度から広げた。アンカレジ（約 80.2 度）がぎりぎり入る。ふちに近い所は画像が斜めにつぶれる）。
//   およそ 東経 60 度〜西経 138 度、南緯 81 度〜北緯 81 度（赤道付近が一番広く、高緯度ほど東西が狭い）。
//   白丸の空港（METAR・TAF）・山の強調・国際悪天（SIGWX）の 3D は、この範囲で表示する。
export const SAT_LON0 = 140.7;
export const SAT_RADIUS = 81;
const D2R = Math.PI / 180;
/** 衛星の真下からの角度（度） */
export function satAngle(lat, lon) {
  const c = Math.cos(lat * D2R) * Math.cos((lon - SAT_LON0) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}
/** 衛星画像の範囲（円）の中か */
export const inSatDisk = (lat, lon) => satAngle(lat, lon) <= SAT_RADIUS;
/** 範囲を囲む経緯度の四角（東経。180 度を超える所は 360 引くと西経） */
export const SAT_BOX = { w: SAT_LON0 - SAT_RADIUS, e: SAT_LON0 + SAT_RADIUS, s: -SAT_RADIUS, n: SAT_RADIUS };
/** 経度を −180〜180 にそろえる */
export const wrapLon = lon => ((lon + 540) % 360) - 180;
