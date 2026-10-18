// zip ファイルの中身を取り出す（eAIP を「まとめてダウンロード」した zip をそのまま読めるように。2026-10-18）
//   ブラウザの DecompressionStream（deflate-raw）で展開する。外部のライブラリは使わない
//   want(name) が true を返すファイルだけ展開する（eAIP の zip には図の PDF が大量に入っていて大きいため）
export async function unzip(buf, want = () => true) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  // 中央ディレクトリの終わり（EOCD）を後ろから探す
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip ファイルとして読めません');
  let n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8'), out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loc = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || !want(name)) continue;
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true), data = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;                                             // それ以外の圧縮方式は読まない
    out.push({ name, bytes });
  }
  return out;
}
