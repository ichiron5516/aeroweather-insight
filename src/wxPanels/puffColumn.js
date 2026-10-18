// もくもくした雲の柱（3D の立体）
//   高度を100倍に強調しても自然に見えるように、絵（板）を積むのではなく、
//   円柱の表面に丸いこぶ（雲の房）をたくさん付けた立体を作る。
//     ・こぶの大きさは柱の半径に合わせる（縦に引き伸ばさない）ので、どの倍率でも丸く見える
//     ・上は丸い頭（こぶの集まり）、下は少し丸めた平らな雲底
//     ・陰は南南西の上からの光で3段階（白・空色がかった白・青みの灰色）のアニメ調
import * as Cesium from 'cesium';

const NT = 56;                                     // 周方向の分割数

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/**
 * @param lon,lat 柱の中心
 * @param z0,z1   柱の下端・上端（m、高度倍率を掛けた後の値）
 * @param R       柱の半径（m）
 * @param opt     { seed, anvil: { z, R } }  anvil … 上端の上に横へ広がるかなとこ雲（高さ z まで、半径 R）
 */
export function puffColumn(lon, lat, z0, z1, R, { seed = 1, anvil = null, gray = false } = {}) {
  const rnd = rng(seed);
  const H = Math.max(z1 - z0, R * 0.6);
  // こぶ（雲の房）：柱の表面に、縦横 0.35〜0.6R の丸いこぶを、すき間なく散らす
  const lumps = [];
  const nRow = Math.max(2, Math.round(H / (R * 0.75)));
  for (let k = 0; k < nRow; k++) {
    const per = 5 + Math.floor(rnd() * 3);
    for (let m = 0; m < per; m++) {
      lumps.push({ th: (m + rnd() * 0.7) / per * 2 * Math.PI, z: z0 + (k + 0.3 + rnd() * 0.6) / nRow * H, s: R * (0.55 + 0.3 * rnd()) });
    }
  }
  const bump = (th, z) => {                      // 0〜1（こぶの一番高い所）
    let b = 0;
    for (const l of lumps) {
      let dth = Math.abs(th - l.th); if (dth > Math.PI) dth = 2 * Math.PI - dth;
      const d2 = ((dth * R) ** 2 + (z - l.z) ** 2) / (l.s * l.s);
      if (d2 < 1) { const v = Math.sqrt(1 - d2); if (v > b) b = v; }
    }
    return b;
  };
  // 断面の半径：柱（揺れの高度帯）は同じ太さ、かなとこ雲の所は広げる
  const radAt = z => {
    if (!anvil || z <= z1) return R;
    const f = Math.min(1, (z - z1) / Math.max(1, (anvil.z - z1) * 0.5));
    return R + (anvil.R - R) * f;
  };
  // 縦の行（側面）＋ 上の丸い頭（8段）＋ 下の雲底（3段）
  const zTop = anvil ? anvil.z : z1;
  const rows = [];
  for (let z = z0; z <= zTop + 1; z += Math.max(R * 0.12, (zTop - z0) / 160)) rows.push({ z, shrink: 1, cap: 0 });
  if (rows.at(-1).z < zTop) rows.push({ z: zTop, shrink: 1, cap: 0 });
  const capH = Math.min(radAt(zTop), R * 1.3) * 0.75;
  for (let k = 1; k <= 8; k++) { const ph = k / 8 * Math.PI / 2; rows.push({ z: zTop + capH * Math.sin(ph), shrink: Math.cos(ph), cap: 1, ph }); }
  const bottom = [];
  for (let k = 3; k >= 1; k--) { const ph = k / 3 * Math.PI / 2; bottom.push({ z: z0 - R * 0.12 * Math.sin(ph), shrink: Math.cos(ph) * 0.98 + 0.02, cap: -1 }); }
  const all = [...bottom, ...rows];
  const NR = all.length, NC = NT + 1;
  // 局所座標（東・北・上）での頂点
  const P = new Float64Array(NR * NC * 3);
  for (let j = 0; j < NR; j++) {
    const { z, shrink, cap } = all[j];
    for (let i = 0; i < NC; i++) {
      const th = (i % NT) / NT * 2 * Math.PI;
      const zz = cap > 0 ? zTop : cap < 0 ? z0 : z;
      const b = bump(th, Math.min(zz, z1));
      let r = radAt(zz) * (0.62 + 0.55 * b) * shrink;   // こぶの所は大きくふくらむ
      if (cap > 0) r *= 0.9 + 0.2 * bump(th + 1.3, z1 - (z - zTop));      // 頭もでこぼこに
      const o = (j * NC + i) * 3;
      P[o] = r * Math.cos(th); P[o + 1] = r * Math.sin(th); P[o + 2] = cap > 0 ? zTop + capH * Math.sin(all[j].ph) * (0.85 + 0.3 * b) : z;
    }
  }
  // 陰（法線と、北西の上からの光）→ 3段階の色。テクスチャは 頂点1つ = 1画素
  const cv = document.createElement('canvas'); cv.width = NC; cv.height = NR;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(NC, NR);
  const L = [-0.35, -0.6, 0.72], Ln = Math.hypot(...L);   // 南南西の上からの光（南から見ることが多いので、手前が明るくなる向き）
  const at = (j, i) => { const o = (Math.min(NR - 1, Math.max(0, j)) * NC + ((i + NT) % NT)) * 3; return [P[o], P[o + 1], P[o + 2]]; };
  const tones = gray ? [[214, 216, 222], [184, 188, 198], [150, 156, 170]] : [[255, 255, 255], [226, 236, 250], [182, 200, 230]];
  for (let j = 0; j < NR; j++) for (let i = 0; i < NC; i++) {
    const a = at(j, i + 1), b2 = at(j, i - 1), c = at(j + 1, i), d = at(j - 1, i);
    const u = [a[0] - b2[0], a[1] - b2[1], a[2] - b2[2]], v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const p = at(j, i); if (n[0] * p[0] + n[1] * p[1] < 0 && all[j].cap === 0) n = n.map(x => -x);   // 外向きに
    const nl = Math.hypot(...n) || 1;
    const lit = (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / (nl * Ln);
    const t = lit > 0.42 ? tones[0] : lit > 0.08 ? tones[1] : tones[2];
    const o = (j * NC + i) * 4; img.data[o] = t[0]; img.data[o + 1] = t[1]; img.data[o + 2] = t[2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // 地球の座標へ
  const M = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
  const pos = new Float64Array(NR * NC * 3), st = new Float32Array(NR * NC * 2), q = new Cesium.Cartesian3(), w = new Cesium.Cartesian3();
  for (let k = 0; k < NR * NC; k++) {
    q.x = P[k * 3]; q.y = P[k * 3 + 1]; q.z = P[k * 3 + 2];
    Cesium.Matrix4.multiplyByPoint(M, q, w);
    pos[k * 3] = w.x; pos[k * 3 + 1] = w.y; pos[k * 3 + 2] = w.z;
    const j = Math.floor(k / NC), i = k % NC;
    st[k * 2] = (i + 0.5) / NC; st[k * 2 + 1] = 1 - (j + 0.5) / NR;
  }
  const idx = [];
  for (let j = 0; j < NR - 1; j++) for (let i = 0; i < NC - 1; i++) {
    const a = j * NC + i, b = a + 1, c = a + NC, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    },
    indices: new Uint32Array(idx), primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  const material = new Cesium.Material({ translucent: false, fabric: { uniforms: { image: cv.toDataURL('image/png') },
    source: `czm_material czm_getMaterial(czm_materialInput mi) {
      czm_material m = czm_getDefaultMaterial(mi);
      vec4 c = texture(image, mi.st);
      m.diffuse = c.rgb * 0.15; m.emission = c.rgb * 0.92; m.alpha = 1.0;
      return m; }` } });
  return new Cesium.Primitive({ geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({ material, flat: true, translucent: false, faceForward: true, closed: false }), asynchronous: false });
}
