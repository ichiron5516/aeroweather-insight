# PDF の AIP（pdftotext -layout で文字の位置がそろうもの）から、航空路・地点・無線施設を読む共通処理（2026-10-18）
#   バングラデシュ（ENR 3.1〜3.3・4.1・4.3）とネパール（ENR 3.3）で使う
#   航空路の表は、左の列に「航空路名」「地点名」「無線施設の種類と識別符号（DVOR/DME (DAC)・'KTM' VOR）」「座標」が縦に並ぶ。
#   右の列（磁方位・距離・高度・備考）は読まない（距離は確かめに使う）
import math, re

R_NM = 3440.065
LAT = r'(\d{2})\s?(\d{2})\s?(\d{2}(?:\.\d+)?)\s*([NS])'
LON = r'(\d{3})\s?(\d{2})\s?(\d{2}(?:\.\d+)?)\s*([EW])'
def dms(d, m, s, h):
    v = int(d) + int(m) / 60 + float(s) / 3600
    return round(-v if h in 'SW' else v, 6)
def nm(a, b):
    r = math.pi / 180; h = math.sin((b['lat'] - a['lat']) * r / 2) ** 2 + math.cos(a['lat'] * r) * math.cos(b['lat'] * r) * math.sin((b['lon'] - a['lon']) * r / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
DES = re.compile(r'^\s*(U?[A-Z]{1,2}\s?\d{1,4}[A-Z]?)\s*(\((?:RNP|RNAV)[^)]*\))?\s*$')
NAV = re.compile(r'''(?:(?<![\dA-Z/])(DVOR/DME|VOR/DME|DVOR|VOR|NDB|DME|TACAN)\s*(?:\(\s*([A-Z]{2,3})\s*\)|([A-Z]{2,3})\s*$)|['"“”‘’]\s*([A-Z]{2,3})\s*['"“”‘’]\s*(DVOR/DME|VOR/DME|DVOR|VOR|NDB|DME))''')

class Store:
    """地点の入れ物。同じ名前で離れた地点は「名前~2」で別に持つ"""
    def __init__(self, cc, trust=()): self.fixes, self.cc, self.trust = {}, cc, set(trust)
    def put(self, key, f, route=False):
        f = {**f, 'country': self.cc}
        if key not in self.fixes: self.fixes[key] = f; return key
        # 地点一覧（ENR 4.3 など）で先に入れた地点は、航空路の表の座標の書き誤り（例：08903396E）より優先する
        if route and key in self.trust: return key
        if nm(self.fixes[key], f) < 3:
            for k in ('name', 'navaidType', 'freq'):
                if f.get(k) and not self.fixes[key].get(k): self.fixes[key][k] = f[k]
            if f['type'] == 'navaid': self.fixes[key]['type'] = 'navaid'
            return key
        for n in range(2, 9):
            k = f'{key}~{n}'
            if k not in self.fixes: self.fixes[k] = {**f, 'ident': key}; return k
            if nm(self.fixes[k], f) < 3: return k
        return key

def ok_dms(m):
    return m and int(m[2]) < 60 and float(m[3]) < 60

def chain(pieces):
    """同じ航空路名が表の別々の所に出るとき、端の地点が同じ切れ端どうしをつなぐ。つながらないものは別に返す"""
    ps = [list(p) for p in pieces if len(p) >= 2]
    out = []
    while ps:
        cur = ps.pop(0); grown = True
        while grown:
            grown = False
            for i, p in enumerate(ps):
                for q in (p, p[::-1]):
                    if q[0] == cur[-1]: cur += q[1:]
                    elif q[-1] == cur[0]: cur = q[:-1] + cur
                    else: continue
                    ps.pop(i); grown = True; break
                if grown: break
        out.append(cur)
    return out

def routes_from_layout(text, store, left=27, compulsory_all=False):
    """左の列（left 文字まで）を上から読む。返り値：{航空路名: [地点のキー…]}、[地点の距離（NM、右の列にあるもの）]
    ・航空路名が 2 つ続けて書かれている（「W2」「A462」）ときは、その下の地点の並びを両方の航空路に入れる
    ・同じ航空路名が別の所にまた出たら、切れ端として持ち、最後に端の地点でつなぐ"""
    pieces, cur, pt, stacked = [], None, None, False
    dists = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)\s*NM\b', text)]
    def flush():
        nonlocal pt
        if pt and pt.get('bad'):
            ident = pt.get('id') or (re.match(r'[A-Z][A-Z0-9]{1,4}', pt.get('name') or '') or [None])[0]
            if ident in store.fixes and cur:
                for _, seq in cur:
                    if not seq or seq[-1] != ident: seq.append(ident)
            pt = None; return
        if pt and pt.get('lat') is not None and pt.get('lon') is not None and cur:
            ident = pt.get('id') or (re.match(r'[A-Z][A-Z0-9]{1,4}', pt.get('name') or '') or [None])[0]
            if ident:
                f = {'lat': pt['lat'], 'lon': pt['lon'], 'type': 'navaid' if pt.get('id') else 'waypoint'}
                if pt.get('id'): f.update({'name': (pt.get('name') or '').upper(), 'navaidType': pt.get('nt', '')})
                key = store.put(ident, f, route=True)
                for _, seq in cur:
                    if not seq or seq[-1] != key: seq.append(key)
        pt = None
    for raw in text.splitlines():
        l = raw[:left].rstrip()
        if not l.strip(): continue
        m = DES.match(l)
        if m and not re.search(LAT, l):
            flush(); d = m[1].replace(' ', '')
            if not (stacked and cur): cur = []
            if d not in [x for x, _ in cur]: piece = (d, []); cur.append(piece); pieces.append(piece)
            stacked = True; continue
        if cur is None: continue
        stacked = False
        if re.search(r'^(AIP|ENR\s|\d{1,2}\s+[A-Z]{3}\s+\d{4}|CIVIL AVIATION|Route Designator|\(RNP|Name of|Coordinates|Odd|Significant)', l.strip()): continue
        mn = NAV.search(l)
        ml, mo = re.search(LAT, l), re.search(LON, l)
        if ml and not mo:   # 経度の度の頭の 0 が抜けている（「902446.52E」）
            m2 = re.search(r'(?<![\d.])(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])', l[ml.end():])
            if m2: mo = m2
        bad = (ml and not ok_dms(ml)) or (mo and not ok_dms(mo)) or bool(re.search(r'\d{8,}(?:\.\d+)?[EW]', l))
        if bad:
            if pt is None: pt = {}
            pt['lat'] = pt['lon'] = None; pt['bad'] = True; continue   # 書き誤りの座標：地点一覧の座標を使う
        if mn:
            if pt is None or pt.get('lat') is not None: flush(); pt = {}
            pt['id'] = mn[2] or mn[3] or mn[4]; pt['nt'] = mn[1] or mn[5]
            continue
        if ml or mo:
            if pt is None: pt = {}
            if ml: pt['lat'] = dms(*ml.groups())
            if mo: pt['lon'] = dms(*mo.groups())
            if pt.get('lat') is not None and pt.get('lon') is not None: flush()
            continue
        if re.match(r'^\s*\(', l): continue                     # 「(ABM DAC VOR)」などの補足
        nmm = re.match(r"^\s*([A-Z][A-Z0-9 .'’-]{1,30}?)\s*(?:VOR|NDB|DME)?\s*$", l)
        if nmm and not re.search(r'\d{3}°|FL\s|ft\b|NM\b', l):
            if pt and pt.get('lat') is not None: flush()
            if pt is None or pt.get('name'): flush(); pt = {}
            pt['name'] = nmm[1].strip()
    flush()
    by = {}
    for d, seq in pieces: by.setdefault(d, []).append(seq)
    out = {}
    for d, ps in by.items():
        for i, c in enumerate(chain(ps)): out[d if i == 0 else f'{d}~{i + 1}'] = c
    return out, dists

def finish(store, rts, comp=()):
    airways = {}
    for d, pts in rts.items():
        seg = [{'nm': round(nm(store.fixes[a], store.fixes[b]), 1)} for a, b in zip(pts, pts[1:])]
        airways[d] = {'type': 'RNAV' if re.match(r'^U?[LMNPQTYZ]', d) else 'CONVENTIONAL', 'points': pts, 'segments': seg, 'country': store.cc}
    return airways
