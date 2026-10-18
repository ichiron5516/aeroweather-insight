# パプアニューギニア（AIP Papua New Guinea、PDF「PNG AIP_01 OCT 2026」）→ 航法データ（2026-10-18）
#   PDF は Google ドライブの共有（ダウンロード不可）。ドライブの表示画面が読み込む各ページの文字と位置（viewer/presspage）を
#   ブラウザで集め、文字の x 位置で桁をそろえたテキスト（1 桁＝4pt）にしてから読む。ページ 300〜353（PDF の 301〜354 ページ）
#     ENR 3.1〜3.3 航空路（H・B・A・G・R 路線）、ENR 4.1 無線施設、ENR 4.3.1 地点一覧（5 文字の地点と通る航空路）
#   ・航空路の表の座標は「S09 27.2 E147 12.9」（度・分）。ENR 4.3.1 の座標（度・分・秒）があればそちらを使う
#   ・無線施設は「PORT MORESBY VOR (PY)」「VANIMO NDB (VNO)」、空港は「MISIMA ARP (AYMS)」
#   出力：nav_db.json（空港は METAR・TAF の白丸のまま）
#   使い方：python pg_build.py <集めたテキスト> <出力フォルダ>
import json, math, os, re, sys

SRC, OUT = sys.argv[1], sys.argv[2]
text = open(SRC, encoding='utf-8').read()
pages = {int(m[1]): m[2] for m in re.finditer(r'=====PAGE (\d+)\n(.*?)(?======PAGE|\Z)', text, re.S)}
R_NM = 3440.065
def nm(a, b):
    r = math.pi / 180; h = math.sin((b['lat'] - a['lat']) * r / 2) ** 2 + math.cos(a['lat'] * r) * math.cos(b['lat'] * r) * math.sin((b['lon'] - a['lon']) * r / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
def val(h, d, m, s=None):
    v = int(d) + float(m) / 60 + (float(s) / 3600 if s else 0)
    return round(-v if h in 'SW' else v, 6)
# S09 27.2 E147 12.9（度・分）／ S09 14 33.60 E146 58 44.99（度・分・秒）／「E151 0114.16」「E147 44' 26.63」「50.15E149」も読む
PART = r"(\d{%d})\s*(?:(\d{2}\.\d+)(?!\d)|(\d{2})'?\s*(\d{2}(?:\.\d+)?)?)"
CO = re.compile(r'([NS])\s?' + PART % 2 + r'\s*([EW])\s?' + PART % 3)
def coord(s):
    m = CO.search(s)
    if not m: return None
    lat = val(m[1], m[2], m[3] or m[4], None if m[3] else m[5])
    lon = val(m[6], m[7], m[8] or m[9], None if m[8] else m[10])
    return {'lat': lat, 'lon': lon}

F, trust, conflict = {}, set(), {}
def put(k, f):
    if k in F:
        if F[k].get('name') and f.get('name') and len(f['name']) > len(F[k]['name']) and f['name'].startswith(F[k]['name']): F[k]['name'] = f['name']
        if k in trust and nm(F[k], f) >= 3: conflict[k] = {'lat': f['lat'], 'lon': f['lon']}   # 地点一覧と航空路の表で座標が違う
        if k in trust or nm(F[k], f) < 3:
            for x in ('name', 'navaidType', 'freq'):
                if f.get(x) and not F[k].get(x): F[k][x] = f[x]
            if f['type'] == 'navaid': F[k]['type'] = 'navaid'
            return k
        for i in range(2, 9):
            kk = f'{k}~{i}'
            if kk not in F: F[kk] = {**f, 'ident': k, 'country': 'PG'}; return kk
            if nm(F[kk], f) < 3: return kk
    F[k] = {**f, 'country': 'PG'}
    return k

# ---------- ENR 4.3.1 地点（5 文字、度・分・秒）----------
n43 = 0
for p in range(340, 344):
    for l in pages.get(p, '').splitlines():
        m = re.match(r'^\s+([A-Z]{5})\s+(.*)', l)
        if not m: continue
        c = coord(m[2])
        if c: put(m[1], {**c, 'type': 'waypoint'}); trust.add(m[1]); n43 += 1

# ---------- ENR 4.1 無線施設 ----------
nav41 = 0
for p in (336, 337):
    L = pages.get(p, '').splitlines()
    for i, l in enumerate(L):
        m = re.search(r'(VOR/DME|NDB/DME|VOR|NDB|DME)\s+[‘\']?([A-Z]{2,3})[’\']?\s+([\d.]+)\s*(MHz|kHz|M)', l)
        if not m or m[1] == 'LOC': continue
        a = re.search(r'(\d{2})\s(\d{2}(?:\.\d+)?)(?:\s(\d{2}(?:\.\d+)?))?([NS])', l)
        b = None
        for j in range(i, min(i + 4, len(L))):
            b = re.search(r'(\d{3})\s(\d{2}(?:\.\d+)?)(?:\s(\d{2}(?:\.\d+)?))?([EW])', L[j][60:]) if j > i or True else None
            if b: break
        if not a or not b: continue
        name = re.sub(r'\s+', ' ', l[:m.start()].strip())
        if not name:
            for j in range(i - 3, i + 4):
                t = L[j][:40].strip() if 0 <= j < len(L) else ''
                if re.fullmatch(r'[A-Z][A-Z ]+', t): name = (name + ' ' + t).strip()
        fq = f"{float(m[3]):g}{'kHz' if m[4] == 'kHz' else 'MHz'}"
        put(m[2], {'lat': val(a[4], a[1], a[2], a[3]), 'lon': val(b[4], b[1], b[2], b[3]), 'type': 'navaid', 'name': name.upper(), 'navaidType': m[1], 'freq': fq})
        nav41 += 1

# ---------- ENR 3.1〜3.3 航空路 ----------
LEFT = 46
DES = re.compile(r'^\s*([ABGHLMNPQRTUVWYZ]\d{2,4}[A-Z]?)(?:\s*\(continued\))?(?:\s+([A-Z]{5}))?\s*$')
NAVID = re.compile(r'(.*?)\s*(?:(VOR/DME|NDB/DME|VOR|NDB|DME|ARP)\s*)?\(\s*([A-Z]{2,4})\s*\)\s*$')
routes, order, dists = {}, [], []
for p in range(300, 336):
    pg = pages.get(p, '')
    dists += [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)\s*NM\b', pg)]
    cur, pt = None, None
    def flush():
        global pt
        if pt and cur and pt.get('c'):
            k = pt.get('id') or (pt.get('name') if re.fullmatch(r'[A-Z]{5}', pt.get('name') or '') else None)
            if k:
                f = {**pt['c'], 'type': 'navaid' if pt.get('nt') and pt['nt'] != 'ARP' else 'waypoint'}
                if pt.get('id'): f.update({'name': (pt.get('name') or '').upper(), 'navaidType': pt.get('nt') or ''})
                key = put(k, f)
                seq = routes[cur][-1]
                if not seq or seq[-1] != key: seq.append(key)
        pt = None
    for raw in pg.splitlines():
        l = raw[:LEFT].replace('▲', ' ').rstrip()
        if not l.strip(): continue
        if re.search(r'Route Designator|Name\s+of|Coordinates\.|significant|points,|ENR\s+3\.|AIP|Papua|Civil Aviation|Edition|^\s*\d{1,2}\s+[A-Z]{3}\s+\d{4}|utilized|LEVEL|All the way|^\s*\d\s*$', l): continue
        m = DES.match(l)
        if m:
            flush()
            cur = m[1]
            if cur not in routes: routes[cur] = []; order.append(cur)
            if 'continued' not in raw or not routes[cur]: routes[cur].append([])
            if m[2]: pt = {'name': m[2]}
            continue
        if cur is None: continue
        c = coord(l)
        if c:
            if pt is None: pt = {}
            pt['c'] = c; flush(); continue
        t = re.sub(r'\s+', ' ', l.strip())
        t = re.split(r'\s(?:\.\.|\d)', t)[0].strip()          # 右の列の磁方位が入り込んだとき
        mi = NAVID.match(t)
        if mi:
            if pt is None or pt.get('id'): flush(); pt = {}
            nmx = mi[1].strip()
            if nmx: pt['name'] = (pt.get('name', '') + ' ' + nmx).strip() if pt.get('name') and not pt.get('nt') else nmx
            pt['id'] = mi[3]; pt['nt'] = mi[2] or pt.get('nt') or ('VOR' if re.search(r'\bVOR\b', t) else '')
            continue
        mv = re.fullmatch(r"([A-Z][A-Z .'-]*?)\s*(VOR/DME|NDB/DME|VOR|NDB|ARP)?", t)
        if mv and len(t) <= 30:
            if pt and pt.get('c'): flush()
            if pt is None or (pt.get('name') and (pt.get('id') or mv[1].strip() == pt['name'])): flush(); pt = {}
            if pt.get('name') and not pt.get('id') and not re.fullmatch(r'[A-Z]{5}', pt['name']):
                pt['name'] += ' ' + mv[1].strip()                     # 「PORT」「MORESBY」が 2 行のとき
            elif not pt.get('name'): pt['name'] = mv[1].strip()
            else: flush(); pt = {'name': mv[1].strip()}
            if mv[2]: pt['nt'] = mv[2]
    flush()

A = {}
for d in order:
    for i, seq in enumerate(x for x in routes[d] if len(x) >= 2):
        k = d if i == 0 or d not in A else f'{d}~{i + 1}'
        if k in A:
            a = A[k]['points']
            if a[-1] == seq[0]: A[k]['points'] = a + seq[1:]; continue
            k = f'{d}~{i + 1}'
        A[k] = {'type': 'RNAV' if re.match(r'^[LMNPQTYZ]', d) else 'CONVENTIONAL', 'points': seq, 'country': 'PG'}
        if k != d: A[k]['designator'] = d
# 地点一覧（ENR 4.3）と航空路の表（ENR 3）で座標が違う地点は、PDF の区間距離に合う方を使う
fixed = []
for k, alt in conflict.items():
    def score(pos):
        G = {**F, k: {**F[k], **pos}}
        return sum(1 for a in A.values() for x, y in zip(a['points'], a['points'][1:]) if k in (x, y) and any(abs(d - nm(G[x], G[y])) <= max(2, 0.03 * d) for d in dists))
    if score(alt) > score(F[k]): fixed.append(f"{k}：ENR 4.3 {F[k]['lat']:.4f},{F[k]['lon']:.4f} → ENR 3 {alt['lat']:.4f},{alt['lon']:.4f}"); F[k].update(alt)
for a in A.values(): a['segments'] = [{'nm': round(nm(F[x], F[y]), 1)} for x, y in zip(a['points'], a['points'][1:])]
match = lambda v: any(abs(x - v) <= max(2, 0.03 * v) for x in dists)
tot = sum(len(a['segments']) for a in A.values()); ok = sum(1 for a in A.values() for s in a['segments'] if match(s['nm']))
used = {p for a in A.values() for p in a['points']}
F = {k: v for k, v in F.items() if k in used or v['type'] == 'navaid'}
print(f'ENR 4.3.1 地点 {n43}・ENR 4.1 無線施設 {nav41}・航空路 {len(A)}・地点 {len(F)}')
print('座標を直した地点', fixed)
print(f'確かめ：区間 {tot} のうち {ok} が PDF の距離と一致')
print('合わない', [f"{d} {a['points'][i]}-{a['points'][i + 1]} {s['nm']}" for d, a in A.items() for i, s in enumerate(a['segments']) if not match(s['nm'])][:40])
os.makedirs(OUT, exist_ok=True)
json.dump({'meta': {'title': 'パプアニューギニア 航法データ', 'sources': ['AIP Papua New Guinea ENR 3.1〜3.3・4.1・4.3（PNG AIP_01 OCT 2026、ページの日付 2014〜2025 年）'], 'aipEffective': 'PNG AIP 01 OCT 2026'},
           'fixes': F, 'airways': A}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
for d, a in A.items(): print(d, ' '.join(a['points']))
