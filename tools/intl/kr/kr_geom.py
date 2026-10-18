# 区域の境界の文章（座標・円・円弧・境界線沿い）を多角形にする
import re, sys
sys.path.insert(0, '/home/claude/kr/tools')
from kr_lib import *
CO_S = r'\d{4}(?:\d{2}(?:\.\d+)?)?\s*[NS]\s*/?\s*\d{5}(?:\d{2}(?:\.\d+)?)?\s*[EW]'
# 北方限界線（NLL）・軍事境界線（MDL）の概略（西→東）。AIP の「along the Northern Limit Line and Military Demarcation Line」に使う
NLL = [[124.0, 38.0], [124.85, 38.0], [125.1, 37.83], [125.4, 37.7], [125.7, 37.68], [126.1, 37.75], [126.3, 37.78], [126.6, 37.8],
       [126.68, 37.95], [126.95, 38.12], [127.1, 38.28], [127.4, 38.33], [127.66, 38.33], [128.0, 38.31], [128.3, 38.55], [128.367, 38.633]]
GIMPO = [126.797500, 37.556944]
def along(line, a, b):
    """折れ線 line 上で a に一番近い点から b に一番近い点まで"""
    ia = min(range(len(line)), key=lambda i: dist(line[i], a)); ib = min(range(len(line)), key=lambda i: dist(line[i], b))
    seg = line[ia:ib + 1] if ia <= ib else line[ib:ia + 1][::-1]
    return seg[1:-1]
def radius_nm(s):
    m = re.search(r'([\d.]+)\s*NM', s)
    if m: return float(m.group(1))
    m = re.search(r'([\d.]+)\s*km', s, re.I)
    if m: return float(m.group(1)) / 1.852
    m = re.search(r'([\d.]+)\s*M\b', s)
    return float(m.group(1)) / 1852 if m else None
TOK = re.compile(r'(?P<circle>(?:a\s+)?circle[^;]*?(?:radius|diameter|NM)[^;]*?(?:centered|centred|centres|centre|center|radius on|NM on)\s*(?:on|at)?\s*(?:the\s*)?(?:point\s*)?(?:[A-Za-z /\-]*\(\s*(?:channel[^,]*,\s*)?)?(?P<cc>' + CO_S + r'))'
                 r'|(?P<circle2>(?P<rad2>[\d.]+\s*NM)\s*radius\s*(?:centered|centred)\s*(?:on|at)\s*(?P<cc2>' + CO_S + r'))'
                 r'|(?P<arc>(?P<dir>counter[- ]?clockwise|anti[- ]?clockwise|clockwise)[^-]*?(?P<arad>[\d.]+\s*(?:NM|KM|M)\b)[^-]*?(?:centered|centred|centre|from|radius\s+of)\s*(?:on|at)?\s*(?:[A-Z]{3,4}\s+[A-Z/]+\s*\(\s*)?(?P<ac>' + CO_S + r'|ARP|[A-Z]{3}))'
                 r'|(?P<gimpo>50\s*NM\s*Arc\s*South\s*of\s*Gimpo)'
                 r'|(?P<nll>along\s+the\s+Northern\s+Limit\s+Line)'
                 r'|(?P<pt>' + CO_S + r')'
                 r'|(?P<end>to the beginning|To the beginning)', re.I)
def ring_of(text, arp=None):
    """戻り値：(ring, note)。円は円、それ以外は点を順に結ぶ"""
    t = text.replace('\xa0', ' ')
    t = t.replace('cent red', 'centred')
    t = re.sub(r'(\d{2})(\d{2})\.(\d+)\s*([NS])\s*(\d{3})(\d{2})\.(\d+)\s*([EW])', lambda m: f"{m[1]}{m[2]}{float('0.'+m[3])*60:05.2f}{m[4]} {m[5]}{m[6]}{float('0.'+m[7])*60:05.2f}{m[8]}", t)   # 度分（小数）→ 度分秒
    pts, pend, note = [], None, []
    for m in TOK.finditer(t):
        if m.group('circle') or m.group('circle2'):
            c = coords(m.group('cc') or m.group('cc2'))[0]
            s = m.group(0); r = radius_nm(s) if m.group('circle') else float(m.group('rad2').split()[0].replace('NM', ''))
            if 'diameter' in s.lower(): r = r / 2
            if not pts and r: return circle(c, r), ''
            continue
        if m.group('arc'):
            ac = m.group('ac'); c = arp if ac.upper() == 'ARP' else coords(ac)[0] if coords(ac) else None
            pend = ('arc', c, radius_nm(m.group('arad')), not m.group('dir').lower().replace(' ', '').startswith(('counter', 'anti'))); continue
        if m.group('gimpo'): pend = ('arc', GIMPO, 50.0, None); continue
        if m.group('nll'): pend = ('nll',); continue
        if m.group('end'): break
        p = coords(m.group('pt'))[0]
        if pend and pts:
            if pend[0] == 'arc' and pend[1]: pts += arc(pend[1], pts[-1], p, pend[2], cw=pend[3])
            elif pend[0] == 'nll': pts += along(NLL, pts[-1], p); note.append('北方限界線・軍事境界線に沿う区間は概略')
        pend = None
        if not pts or pts[-1] != p: pts.append(p)
    if len(pts) >= 3: return close(pts), '・'.join(dict.fromkeys(note))
    return None, ''
ALT = r'(?:FL\s*\d{2,3}|UNL|GND|SFC|MSL|\d[\d ]*\s*(?:ft|FT)?\s*(?:AMSL|AGL|MSL)?)'
def vlim(s):
    """'FL 185 / 1 000 ft AGL' → (lower, upper, agl)"""
    s = s.replace('\xa0', ' ')
    m = re.search(r'(' + ALT + r')\s*/\s*(' + ALT + r')', s)
    if not m: 
        m2 = re.search(r'(SFC|GND)\s*-\s*(' + ALT + r')', s)
        if not m2: return None
        up, lo = m2.group(2), m2.group(1)
    else: up, lo = m.group(1), m.group(2)
    u, l = alt_ft(re.sub(r'(AMSL|AGL|MSL)', '', up)), alt_ft(re.sub(r'(AMSL|AGL|MSL)', '', lo))
    if u == 'BAD' or l == 'BAD': return None
    return l, u, ('AGL' in lo.upper()) or ('AGL' in up.upper())
