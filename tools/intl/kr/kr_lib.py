# 韓国 eAIP（HTML 版）を読むための共通処理
import json, re, warnings, math
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
warnings.filterwarnings('ignore', category=XMLParsedAsHTMLWarning)
H = json.load(open('/home/claude/kr/KR_eAIP_2026-10-28_html.json'))
def soup(n):
    b = BeautifulSoup(H[n], 'lxml')
    # 改訂で削除された部分（取り消し線で表示される古い記述）は除く
    for e in b.find_all(class_=lambda c: c and 'AmdtDeleted' in c): e.decompose()
    for e in b.find_all(id=lambda i: i and i.endswith('_Deleted')): e.decompose()
    for e in b.find_all('del'): e.decompose()
    for e in b.find_all(class_='sdParams'): e.decompose()          # 画面に出ない AIXM の参照（タイ・シンガポール）
    return b
CO = re.compile(r'(?<!\d)(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?\s*([NS])\s*/?\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?\s*([EW])(?![A-Za-z])')
def coords(t):
    out = []
    for m in CO.finditer(t.replace('\xa0', ' ')):
        la = int(m[1]) + int(m[2]) / 60 + float(m[3] or 0) / 3600; lo = int(m[5]) + int(m[6]) / 60 + float(m[7] or 0) / 3600
        out.append([round(lo if m[8] == 'E' else -lo, 6), round(la if m[4] == 'N' else -la, 6)])
    return out
def txt(c): return re.sub(r'\s+', ' ', c.get_text(' ', strip=True).replace('\xa0', ' ')).strip()
R_NM = 3440.065
def dest(lon, lat, brg, nm):
    r = math.pi / 180; d = nm / R_NM; p1 = lat * r; l1 = lon * r; b = brg * r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return [round(l2 / r, 6), round(p2 / r, 6)]
def bearing(a, b):
    r = math.pi / 180; p1, p2, dl = a[1] * r, b[1] * r, (b[0] - a[0]) * r
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360
def dist(a, b):
    r = math.pi / 180; p1, p2, dl = a[1] * r, b[1] * r, (b[0] - a[0]) * r
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
def circle(c, nm, n=72): return [dest(c[0], c[1], 360 * i / n, nm) for i in range(n)] + [dest(c[0], c[1], 0, nm)]
def arc(c, a, b, nm=None, cw=None, step=3):
    nm = nm or (dist(c, a) + dist(c, b)) / 2
    b1, b2 = bearing(c, a), bearing(c, b); d = (b2 - b1 + 540) % 360 - 180
    if cw is True and d < 0: d += 360
    if cw is False and d > 0: d -= 360
    n = max(1, int(abs(d) / step))
    return [dest(c[0], c[1], b1 + d * i / n, nm) for i in range(1, n)]
def close(r): return r + [r[0]] if r and r[0] != r[-1] else r
def alt_ft(s):
    s = s.upper().replace('\xa0', ' ').strip()
    if re.match(r'^(SFC|GND|MSL)', s): return 0
    if 'UNL' in s: return None
    m = re.match(r'FL\s*(\d{2,3})', s)
    if m: return int(m.group(1)) * 100
    m = re.match(r'(\d[\d ]*)\s*(FT|M)?', s)
    if m:
        v = int(m.group(1).replace(' ', ''))
        return round(v * 3.28084) if m.group(2) == 'M' else v
    return 'BAD'
