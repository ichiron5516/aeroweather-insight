# AIP ENR PDF の表を列ごとに読むための共通処理
import pdfplumber, re, math, json, functools

PDF = '/root/.claude/uploads/4f168f85-21a8-5891-8d31-b62d2d77bef3/584400a4-ENR_20261001.pdf'
NAV = json.load(open('/home/claude/iap/nav_db.json'))
APT = json.load(open('/home/claude/iap/airport_db.out.json'))

_pdf = None
def pdf():
    global _pdf
    if _pdf is None: _pdf = pdfplumber.open(PDF)
    return _pdf

@functools.lru_cache(maxsize=None)
def words(pn):
    return pdf().pages[pn - 1].extract_words(keep_blank_chars=False)

def lines(ws, tol=2.5):
    L = []
    for w in sorted(ws, key=lambda w: (round(w['top']), w['x0'])):
        if L and abs(L[-1][0]['top'] - w['top']) <= tol: L[-1].append(w)
        else: L.append([w])
    return [sorted(l, key=lambda w: w['x0']) for l in L]

def hdr(pn, name, nth=0):
    hs = [w for w in words(pn) if w['text'] == name]
    return hs[nth] if len(hs) > nth else None

# ---------- 座標 ----------
CO = re.compile(r'(\d{2})(\d{2})(\d{2}(?:\.\d+)?)N\s*/?\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)E')
CO4 = re.compile(r'(\d{2})(\d{2})N(\d{3})(\d{2})E')
def dms(m):
    return [round(int(m[3]) + int(m[4]) / 60 + float(m[5]) / 3600, 6), round(int(m[0]) + int(m[1]) / 60 + float(m[2]) / 3600, 6)]
def coords(text):
    """[lon, lat] のリスト（DDMMSSN/DDDMMSSE）"""
    return [dms(m.groups()) for m in CO.finditer(text.replace(' /', '/').replace('/ ', '/'))]

# ---------- 測地計算 ----------
R_NM = 3440.065
def dest(lon, lat, brg, nm):
    r = math.pi / 180; d = nm / R_NM; p1 = lat * r; l1 = lon * r; b = brg * r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return [round(l2 / r, 6), round(p2 / r, 6)]
def bearing(a, b):
    r = math.pi / 180
    p1, p2, dl = a[1] * r, b[1] * r, (b[0] - a[0]) * r
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360
def dist(a, b):
    r = math.pi / 180
    p1, p2, dl = a[1] * r, b[1] * r, (b[0] - a[0]) * r
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
def circle(c, nm, n=72):
    return [dest(c[0], c[1], 360 * i / n, nm) for i in range(n)] + [dest(c[0], c[1], 0, nm)]
def arc(c, a, b, nm=None, cw=None, step=3):
    """中心 c、点 a から b への円弧（a, b を含まない中間点）。cw=None なら短い方"""
    nm = nm or (dist(c, a) + dist(c, b)) / 2
    b1, b2 = bearing(c, a), bearing(c, b)
    d = (b2 - b1 + 540) % 360 - 180            # -180..180（正＝時計回り）
    if cw is True and d < 0: d += 360
    if cw is False and d > 0: d -= 360
    n = max(1, int(abs(d) / step))
    return [dest(c[0], c[1], b1 + d * i / n, nm) for i in range(1, n)]
def sector(c, nm_out, b1, b2, nm_in=0):
    """扇形（真方位 b1→b2 時計回り）"""
    d = (b2 - b1) % 360
    n = max(2, int(d / 3))
    out = [dest(c[0], c[1], b1 + d * i / n, nm_out) for i in range(n + 1)]
    inn = [dest(c[0], c[1], b2 - d * i / n, nm_in) for i in range(n + 1)] if nm_in else [list(c)]
    return out + inn + [out[0]]

# ---------- 無線施設 ----------
NAMEMAP = {}
for k, v in NAV['fixes'].items():
    if v.get('type') == 'navaid':
        NAMEMAP.setdefault(k, v)
        if v.get('name'): NAMEMAP.setdefault(v['name'].upper(), v)
# 航法DBにない施設：空港の標点で代用（石見 VOR/DME は石見空港内）
FALLBACK = {'IWAMI': [131 + 47 / 60, 34 + 41 / 60], 'MXT': [141 + 13 / 60, 38 + 24 / 60]}   # 松島 TACAN は松島飛行場の標点
def navaid(s):
    """'Nagoya VORTAC' / 'KCC' / 'CHITOSE VOR/DME' → [lon, lat]"""
    s = s.upper().strip()
    m = re.search(r'\(([A-Z]{3})\)', s)
    if m and m.group(1) in NAV['fixes']: v = NAV['fixes'][m.group(1)]; return [v['lon'], v['lat']]
    if s in NAV['fixes']: v = NAV['fixes'][s]; return [v['lon'], v['lat']]
    nm = re.sub(r'\s*(VORTAC|VOR/DME|VOR|TACAN|DME|NDB)\b.*', '', s).strip()
    nm = re.sub(r'^[A-Z]\s+', '', nm)                 # 行頭に紛れた一文字（H・S の区分記号）
    if nm in FALLBACK: return FALLBACK[nm]
    v = NAMEMAP.get(nm)
    return [v['lon'], v['lat']] if v else None

def alt_ft(s):
    """'FL335' → 33500、'5000' → 5000、SFC/GND → 0、UNL → None"""
    s = s.strip().upper().replace(',', '')
    if s in ('SFC', 'GND', 'MSL'): return 0
    if s in ('UNL', 'UNLTD'): return None
    m = re.match(r'FL\s?(\d{2,3})$', s)
    if m: return int(m.group(1)) * 100
    m = re.match(r'(\d{3,6})(FT)?$', s)
    return int(m.group(1)) if m else 'BAD'

def close(ring):
    if ring and ring[0] != ring[-1]: ring = ring + [ring[0]]
    return ring
