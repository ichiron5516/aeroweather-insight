import re, math, json
from asp_lines import lines21
COORD = re.compile(r'(\d{4,6}(?:\.\d+)?)([NS])\s*,?\s*(\d{5,7}(?:\.\d+)?)([EW])')
def cval(d, h, deg_digits):
    d = d.split('.')[0] if '.' in d and len(d.split('.')[0]) in (4, 6, 5, 7) else d
    deg = int(d[:deg_digits]); mm = int(d[deg_digits:deg_digits + 2]); ss = float(d[deg_digits + 2:] or 0)
    v = deg + mm / 60 + ss / 3600
    return -v if h in 'SW' else v
def coord(m): return (cval(m[1], m[2], 2), cval(m[3], m[4], 3))
def nm(a, b):
    r = math.pi / 180; p1, p2 = a[0] * r, b[0] * r; dl = (b[1] - a[1]) * r
    return 2 * 3440.065 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))
def brg(c, p): return math.atan2((p[1] - c[1]) * math.cos(c[0] * math.pi / 180), p[0] - c[0])   # 北から時計回り
def onc(c, r, a): return (c[0] + r / 60 * math.cos(a), c[1] + r / 60 * math.sin(a) / math.cos(c[0] * math.pi / 180))
def arc(c, r, p0, p1, cw):
    a0 = brg(c, p0) if p0 else 0; a1 = brg(c, p1) if p1 else a0 + 2 * math.pi * (1 if cw else -1)
    if cw:
        while a1 <= a0: a1 += 2 * math.pi
    else:
        while a1 >= a0: a1 -= 2 * math.pi
    n = max(4, int(abs(a1 - a0) / (math.pi / 36)))
    return [onc(c, r, a0 + (a1 - a0) * k / n) for k in range(n + 1)]
LIMIT = re.compile(r'^(FL ?\d+|UNL|SFC|GND|GND/Water|[\d ]+ft)', re.I)
def parse(navfix):
    L = lines21('enr21.pdf')
    blocks, cur, state = [], None, 'name'
    pending_names = []
    for pn, s in L:
        if s.startswith('Airspace Classification'):
            if cur: cur['cls'] = s.split(':', 1)[1].strip() if ':' in s else ''; blocks.append(cur)
            cur = None; state = 'name'; pending_names = []; continue
        if cur and cur.get('cls') is None and state == 'limits':
            if LIMIT.match(s): cur['limits'].append(s); continue
        if state == 'name':
            if COORD.search(s) or re.match(r'^(The area|A circle|thence|then|follow|circle|[a-z])', s):
                cur = {'names': pending_names[:], 'text': s, 'limits': [], 'cls': None, 'page': pn}; state = 'path'; continue
            if LIMIT.match(s) and pending_names:   # 範囲の記述がない（図のみ）
                cur = {'names': pending_names[:], 'text': '', 'limits': [s], 'cls': None, 'page': pn}; state = 'limits'; continue
            pending_names.append(s); continue
        if state == 'path':
            if LIMIT.match(s) and not COORD.search(s): cur['limits'].append(s); state = 'limits'; continue
            cur['text'] += ' ' + s
    out = []
    for b in blocks:
        nl = [n for n in b['names'] if not n.endswith(':') and 'WITHIN' not in n and not n.startswith('(')]
        raw = ' '.join(b['names'])
        name = re.sub(r'\s+', ' ', ' '.join(nl[-2:]) if nl else raw).strip(' /')
        code = (re.findall(r'\(([A-Z]{2,5})\)', raw) or [None])[-1]
        t = b['text'].replace('“', '"').replace('”', '"').replace('‘', '"').replace('’', '"')
        # 経路を順に読む
        pts, notes = [], []
        toks = []
        for m in re.finditer(r'radius\s*(?:of\s*)?(\d+)\s*NM|(\d+)\s*NM\s*radius|cent(?:er|r)ed\s*(?:at|on|of)?\s*(?:"([A-Z]{2,3})"|(WABB ARP|ARP))?|\bfrom\b|anticlockwise|clockwise|' + COORD.pattern, t):
            toks.append(m)
        rad = None; center = None; cw = True; want_center = False; arcmode = False
        for m in toks:
            g = m.group(0)
            if m.group(1) or m.group(2): rad = float(m.group(1) or m.group(2)); arcmode = True; continue
            if g.startswith('cent') or g == 'from':
                arcmode = True
                if m.group(3):
                    f = navfix.get(m.group(3)); center = (f['lat'], f['lon']) if f else None
                    if not f: notes.append(f'中心 {m.group(3)} が不明')
                elif m.group(4):
                    # ARP の座標は ENR 2.1 にないので、空港の VOR/DME で代用（Jayapura→JPA、Biak WABB→BIK）
                    sub = 'BIK' if 'WABB' in m.group(4) else 'JPA' if 'JAYAPURA' in raw else None
                    f = navfix.get(sub) if sub else None
                    center = (f['lat'], f['lon']) if f else None
                    notes.append(f'中心の ARP を {sub} VOR/DME で代用' if f else '中心が ARP（座標なし）')
                else: want_center = True
                continue
            if g == 'anticlockwise': cw = False; continue
            if g == 'clockwise': cw = True; continue
            c = coord(COORD.match(g) if COORD.match(g) else m)
            if want_center: center = c; want_center = False; continue
            if arcmode and rad and center:
                pts += arc(center, rad, pts[-1] if pts else None, c, cw)[1:] if pts else [c]
                arcmode = False; rad = None; center = None; cw = True; continue
            pts.append(c)
        if arcmode and rad and center:   # 最後が円弧（始点に戻る）または円だけ
            pts += arc(center, rad, pts[-1] if pts else None, pts[0] if pts else None, cw)[1:] if pts else arc(center, rad, None, None, True)
        lim = []
        for s in b['limits'][:2]:
            s0 = s.split('/')[0].strip()
            if re.match(r'FL ?\d+', s0): lim.append(int(re.findall(r'\d+', s0)[0]) * 100)
            elif s0.upper().startswith('UNL'): lim.append(66000)
            elif re.match(r'(SFC|GND)', s0, re.I): lim.append(0)
            else: lim.append(int(re.sub(r'\D', '', s0) or 0))
        out.append({'name': name, 'names': b['names'], 'code': code, 'raw': raw, 'pts': pts, 'upper': lim[0] if lim else None, 'lower': lim[1] if len(lim) > 1 else None,
                    'cls': b['cls'], 'limitsText': b['limits'][:2], 'notes': notes, 'page': b['page'], 'text': t})
    return out
if __name__ == '__main__':
    nav = json.load(open('p31.json'))['fixes'] | json.load(open('p32.json'))['fixes']
    for a in parse(nav):
        print(a['page'], a['name'], a['code'], len(a['pts']), a['upper'], a['lower'], a['cls'], a['notes'])

VOC = set(json.load(open('vocab.json'))) if __import__('os').path.exists('vocab.json') else set()
def fixname(s):
    t = s.split()
    out = []
    i = 0
    while i < len(t):
        done = False
        for k in (3, 2):
            if i + k <= len(t):
                j = ''.join(t[i:i + k])
                if j in VOC and not all(x in VOC and len(x) > 3 for x in t[i:i + k]):
                    out.append(j); i += k; done = True; break
        if not done: out.append(t[i]); i += 1
    return ' '.join(out)
def clean_name(names):
    keep = [n for n in names if not re.search(r'WITHIN|INFORM|FLIGHT|^A, B|:$|DELEGATED|PROVISION|^\(|AREAs|^TERMINAL CONTROL$|^SECTORS|^[A-G] ?:|^UPPER CONTROL AREAS', fixname(n))]
    keep = [fixname(re.sub(r'\s+', ' ', n)).strip(' /') for n in keep]
    keep = [re.sub(r'\bTERMINAL CONTROL\s+', '', k) for k in keep]
    if not keep: return None
    first = keep[0]
    if len(keep) > 1 and not keep[1].startswith('UPPER'): first += ' ' + keep[1]
    first = re.sub(r'\bU ?T ?A\b', 'UTA', first)
    return first.replace('UTA/', 'UTA').replace(' UTA /', ' UTA').strip()
