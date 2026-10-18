# 中国（eAIP China、AIRAC 2026-10）→ nav_db・airspace_db・airport_db（ZSPD）
#   eAIP の画面が読み込む JSON（GeneralDoc/<jsId>.js）をそのまま使う：ENR 2.1（CTA・APP）、3.2/3.3（航空路）、4.1、4.4、5.1、5.2
#   ZSPD：AD 2 の PDF（基本情報）＋「DATABASE CODING TABLE」「WAYPOINT LIST」の PDF（文字が読める）
#   中国 AIP は高さをメートル（m）で書くので、フィートに直す。滑走路の端の座標は公開されていない（Nil）ため、ARP と AD 2.12 の位置関係から計算した近似
import re, json, math, subprocess, sys, glob, os, collections
sys.path.insert(0, '/home/claude/kr/tools')
from kr_lib import circle, dest, arc
ROOT = '/home/claude/cn'; CC = 'CN'
M2FT = 3.28084
J = json.load(open(f'{ROOT}/CN_js.json'))
def load(k):
    s = J[k]; return json.loads(s[s.index('=') + 1:].strip().rstrip(';'))
def co(s):
    """'N36°00′02″' 'N41°15.7′' 'N452317' 'N321517E1201718' → 度"""
    s = s.strip()
    m = re.match(r'([NSEW])\s*(\d{1,3})°\s*(\d{1,2}(?:\.\d+)?)[′\']\s*(?:(\d{1,2}(?:\.\d+)?)[″"])?', s)
    if m:
        v = int(m.group(2)) + float(m.group(3)) / 60 + (float(m.group(4)) / 3600 if m.group(4) else 0)
        return -v if m.group(1) in 'SW' else v
    m = re.match(r'([NSEW])(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)', s)
    if m:
        v = int(m.group(2)) + int(m.group(3)) / 60 + float(m.group(4)) / 3600
        return -v if m.group(1) in 'SW' else v
    raise ValueError(s)
def pair(s):
    m = re.match(r'\s*(N[\d°′″\'". ]+?)\s*(E[\d°′″\'". ]+)\s*$', s)
    return (round(co(m.group(1)), 6), round(co(m.group(2)), 6)) if m else None
def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))

# ================= 航法データ =================
fixes, airways = {}, {}
for e in load('ENR 4.1 Radio navigation aids — en-route')['list']:
    if not e.get('designator') or not e.get('latitude'): continue
    fixes.setdefault(e['designator'], {'lat': round(co(e['latitude']), 6), 'lon': round(co(e['longitude']), 6), 'type': 'navaid',
                                       'name': (e.get('nameEn') or e.get('pinyin') or '').upper(), 'navaidType': e.get('type') or '',
                                       'freq': (e.get('frequency') or '').replace(' ', ''), 'country': CC})
for e in load('ENR 4.4 Name-code designators for significant points')['list']:
    if e.get('designator') and e.get('latitude'):
        fixes.setdefault(e['designator'], {'lat': round(co(e['latitude']), 6), 'lon': round(co(e['longitude']), 6), 'type': 'waypoint', 'country': CC})
for k in J:
    if not (k.startswith('ENR 3.2.') or k.startswith('ENR 3.3.1')): continue
    kind = 'RNAV' if k.startswith('ENR 3.3') else 'CONVENTIONAL'
    for r in load(k)['list']:
        pts, comp = [], []
        for p in r['routePointSegment']['list']:
            if p.get('type') != '0': continue
            nm = p.get('sigDesignator') or p.get('pointDesignator') or p.get('pointNameEn')
            c = pair(p.get('coordinate') or '')
            if not nm or not c: continue
            nm = nm.strip()
            fixes.setdefault(nm, {'lat': c[0], 'lon': c[1], 'type': 'waypoint', 'country': CC})
            if not pts or pts[-1] != nm: pts.append(nm)
            if p.get('reporting') == 'COMPULSORY': comp.append(nm)
        if len(pts) < 2: continue
        d = r['designator'].strip()
        if d in airways:      # 同じ名前が分かれているときはつなげる
            q = airways[d]['points']
            if q[-1] == pts[0]: q += pts[1:]
            elif pts[-1] == q[0]: airways[d]['points'] = pts[:-1] + q
            else: q += pts
        else: airways[d] = {'type': kind, 'points': pts, 'country': CC}
        for f in comp: fixes[f]['reporting'] = 'COMPULSORY'
for d, a in airways.items():
    a['segments'] = [{'nm': round(dist(fixes[x], fixes[y]), 1)} for x, y in zip(a['points'], a['points'][1:])]
json.dump({'meta': {'title': '中国 航法データ', 'sources': ['AIP China ENR 3.2', 'ENR 3.3', 'ENR 4.1', 'ENR 4.4'], 'aipEffective': 'AIRAC 2026-10（EFF 2026-09-30）'},
           'fixes': fixes, 'airways': airways}, open(f'{ROOT}/out/nav_cn.json', 'w'), ensure_ascii=False)
print('nav', len(fixes), 'navaids', sum(v['type'] == 'navaid' for v in fixes.values()), 'airways', len(airways))

# ================= 空域 =================
def ring_of_list(L):
    pts, pend = [], None
    for p in L:
        v = (p.get('value') or '').strip()
        c = pair(v.replace(' ', ' ')) or (lambda m: (round(co(m.group(1)), 6), round(co(m.group(2)), 6)) if m else None)(re.match(r'(N\d{6}(?:\.\d+)?)\s*(E\d{7}(?:\.\d+)?)', v))
        am = re.search(r'(counter|anti)?\s*-?clockwised?\s+arc with radius of\s*([\d.]+)\s*(km|NM)\s*centered at\s*(N\d{6}\s*E\d{7})?', v, re.I)
        if am:
            cc = re.match(r'(N\d{6})\s*(E\d{7})', am.group(4) or '')
            if cc: pend = ([co(cc.group(2)), co(cc.group(1))], float(am.group(2)) / (1.852 if am.group(3).lower() == 'km' else 1), not am.group(1))
            continue
        if not c: continue                     # 「National Boundaries」などは直線で近似
        q = [c[1], c[0]]
        if pend and pts:
            pts += arc(pend[0], pts[-1], q, pend[1], cw=pend[2])
            pend = None
        pts.append(q)
    if pts and pts[0] != pts[-1]: pts.append(pts[0])
    return pts if len(pts) >= 4 else None
def vlim(note):
    if not note: return None
    s = note.replace('\r', '')
    nums = []
    for m in re.finditer(r'(FL\s*\d{2,3})|([\d ]*\d)\s*(m|M|ft|FT)?\b(?!\s*(?:km|NM))|(GND|SFC|UNL)', s):
        if m.group(1): nums.append(int(re.sub(r'\D', '', m.group(1))) * 100)
        elif m.group(4): nums.append(0 if m.group(4) != 'UNL' else None)
        elif m.group(2):
            v = int(m.group(2).replace(' ', ''))
            if v < 30: continue
            nums.append(round(v * (1 if (m.group(3) or '').lower() == 'ft' else M2FT) / 100) * 100)
    nums = [n for n in nums if n is not None] + ([None] if 'UNL' in s else [])
    vals = [n for n in nums if n is not None]
    if not vals: return None
    return (min(vals), None if 'UNL' in s else max(vals))
items = []
def add(id_, name, layer, kind, ring, v, src, info):
    if not ring: return
    lo, up = v if v else (0, None)
    if lo == up: lo = 0
    items.append({'id': id_, 'cat': 'cta' if layer in ('cta', 'sector') else layer, 'layer': layer, **({'kind': kind} if kind else {}), 'country': CC, 'name': name,
                  'lower': lo, 'upper': up, 'parts': [{'ring': ring, 'lower': lo, 'upper': up}], 'src': f'AIP China {src}', 'info': {**info, **({} if v else {'高度': '記載なし'})},
                  **({'short': name.replace(' Control Area', '').upper()} if layer == 'sector' else {})})
for f in load('ENR 2.1.3 CTA')['list']:
    for e in (f.get('airspace') or {}).get('list', []):
        add('CN-CTA-' + (e.get('locationIndicator') or e['nameEn']), e['nameEn'], 'sector', None, ring_of_list(e['lateralLimit']['list']), vlim(e.get('noteVerticalLimit')),
            'ENR 2.1.3', {'FIR': f['nameEn']})
for f in load('ENR 2.1.5 Terminal control area and approach control areas')['list']:
    for e in (f.get('airspace') or {}).get('list', []):
        add('CN-APP-' + (e.get('locationIndicator') or e['nameEn']), e['nameEn'].replace(' Approach Control Area', ' 進入管制区'), 'cta', 'tma',
            ring_of_list(e['lateralLimit']['list']), vlim(e.get('noteVerticalLimit')), 'ENR 2.1.5', {'種別': '進入管制区（APP）', 'FIR': f['nameEn']})
for k, kind in (('ENR 5.1.2 Prohibited areas', 'prohibited'), ('ENR 5.1.3 Restricted areas', 'restricted'), ('ENR 5.1.4 Danger areas', 'danger')):
    for e in load(k)['list']:
        nm = (e.get('nameCn') or e.get('nameEn') or '').strip()
        add(nm, nm + (f' {e["nameEn"]}' if e.get('nameEn') and e['nameEn'] != nm else ''), 'restricted', kind, ring_of_list((e.get('lateralLimit') or {}).get('list', [])),
            vlim(e.get('noteVerticalLimit')), k.split(' ')[1] and 'ENR ' + k.split(' ')[1], {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind],
                                                                                         '内容': re.sub(r'\s+', ' ', e.get('note') or e.get('restrictiveClass') or '')[:160]})
json.dump({'meta': {'title': '中国 空域データ', 'source': 'AIP China（AIRAC 2026-10）ENR 2.1.3 / 2.1.5 / 5.1', 'notes': ['FIR は既存の FIR 表示を使う', '国境沿いの区間は直線で近似', '高さのメートル表記はフィートに換算']},
           'items': items}, open(f'{ROOT}/out/airspace_cn.json', 'w'), ensure_ascii=False)
print('airspace', collections.Counter((o['layer'], o.get('kind')) for o in items))

# ================= ZSPD =================
ad = subprocess.run(['pdftotext', '-layout', f'{ROOT}/pdf/AD2_ZSPD.pdf', '-'], capture_output=True, text=True).stdout
arp_la, arp_lo = co('N31°08.7′'), co('E121°47.6′')
m = re.search(r"N31°08\.7′\s*E121°47\.6′", ad); assert m
GEO = 162.0
def mv(p, brg, m_): lo, la = dest(p[0], p[1], brg, m_ / 1852); return [lo, la]
arp = [arp_lo, arp_la]
thr17L = mv(arp, GEO + 180, 2000); thr35R = mv(arp, GEO, 2000)
side = lambda p, m_: mv(p, GEO - 90, m_)          # 東（滑走路の左＝進行方向 162° の左）
thr17R = mv(mv(thr17L, GEO + 90, 460), GEO, 600); thr35L = mv(thr17R, GEO, 3400)
thr16R = mv(side(thr17L, 2260), GEO, 1000); thr34L = mv(thr16R, GEO, 3800)
thr16L = mv(side(thr17L, 2700), GEO, 1000); thr34R = mv(thr16L, GEO, 3800)
RW = {'16L': (thr16L, thr34R, '34R', 3800, 3.5), '34R': (thr34R, thr16L, '16L', 3800, 3.3), '16R': (thr16R, thr34L, '34L', 3800, 3.1), '34L': (thr34L, thr16R, '16R', 3800, 3.2),
      '17L': (thr17L, thr35R, '35R', 4000, 2.8), '35R': (thr35R, thr17L, '17L', 4000, 2.8), '17R': (thr17R, thr35L, '35L', 3400, 3.4), '35L': (thr35L, thr17R, '17R', 3400, 3.4)}
runways = [{'id': k, 'trueBearing': GEO if k[:2] in ('16', '17') else GEO + 180, 'lengthM': L, 'widthM': 60, 'threshold': {'lat': round(t[1], 6), 'lon': round(t[0], 6)},
            'thresholdElevFt': round(el * M2FT, 1), 'reciprocal': rc, 'departureEnd': {'lat': round(e[1], 6), 'lon': round(e[0], 6)}, 'thresholdApprox': True}
           for k, (t, e, rc, L, el) in RW.items()]
WP = {}
for f in sorted(glob.glob(f'{ROOT}/pdf/ZSPD-0W-*.pdf')):
    t = subprocess.run(['pdftotext', '-layout', f, '-'], capture_output=True, text=True).stdout
    for m in re.finditer(r'\b([A-Z][A-Z0-9]{1,4})\s+N(\d{2})\D{1,4}(\d{2})\'(\d{2}(?:\.\d+)?)"E(\d{3})\D{1,4}(\d{2})\'(\d{2}(?:\.\d+)?)"', t):
        g = m.groups()
        WP[g[0]] = {'lat': round(int(g[1]) + int(g[2]) / 60 + float(g[3]) / 3600, 6), 'lon': round(int(g[4]) + int(g[5]) / 60 + float(g[6]) / 3600, 6),
                    'type': 'waypoint', 'src': ['ZSPD WAYPOINT LIST'], 'country': CC}
for k, (t, e, rc, L, el) in RW.items(): WP[f'RW{k}'] = {'lat': round(t[1], 6), 'lon': round(t[0], 6), 'type': 'runway', 'src': ['ZSPD AD 2.12（近似）'], 'country': CC}
def pos(k):
    p = fixes.get(k) or WP.get(k)
    return p
# ---- コーディング表 ----
PTS = 'IF TF CF DF VA VI VM CA FA FM RF HM HF HA'.split()
ROW = re.compile(r'^\s*(' + '|'.join(PTS) + r')\s+(?:([A-Z][A-Z0-9]{1,4})\s+)?(.*)$')
def parse(text):
    rows, lone, out = [], [], []
    lines = text.split('\n')
    for i, L in enumerate(lines):
        h = re.match(r'^\s*(RWY[\dLR/]+)\s+(SID|STAR)\s+([A-Z]+\d[A-Z]?)(\s*\(by ATC\))?\s*$', L) or \
            re.match(r'^\s*(RWY\d{2}[LR]?)\s+(Approach Transition|Missed Approach(?! Holding))\s*(.*?)\s*$', L) or \
            re.match(r'^\s*(RWY\d{2}[LR]?)\s+(Runway Transition)\s*$', L) or re.match(r'^\s*(Common)\s*$', L) or \
            re.match(r'^\s*(RWY[\dLR/]+)\s+(STAR Holding|Missed Approach Holding).*$', L)
        if h: out.append(('H', h.groups(), i)); continue
        m = ROW.match(L)
        if m:
            pt, fix, rest = m.groups()
            if fix in ('RNAV', 'RNP'): fix = None
            out.append(('R', {'pt': pt, **({'fix': fix} if fix else {}), 'rest': rest, 'i': i}, i)); continue
        mm = re.match(r'^\s{40,}(\d{3,5})\s*$', L)
        if mm: lone.append((i, int(mm.group(1))))
    rws = [x for x in out if x[0] == 'R']
    for i, v in lone:                          # 上下2段の高度（上＝上限、下＝下限）
        r = min(rws, key=lambda x: abs(x[2] - i), default=None)
        if r and abs(r[2] - i) <= 1: r[1].setdefault('stack', []).append((i < r[2], v))
    for kind, x, i in out:
        if kind != 'R': continue
        rest = x.pop('rest'); stack = x.pop('stack', []); x.pop('i')
        if re.match(r'^\s*Y\b', rest): x['flyover'] = True
        cm = re.search(r'(?<!\d)(\d{3})(?!\d)', rest)
        sp = re.search(r'\b(MAX|AT|MIN)(\d{3})\b', rest)
        al = re.search(r'(?<!\d)(\d{3,5})(?:\s*or\s*(\d{3,5}))?(?=\s+(?:MAX|AT|MIN|RNAV|RNP|-))', rest)
        nums = [int(n) for n in re.findall(r'(?<![\d.])(\d{3,5})(?![\d.])', rest)]
        if x['pt'] in ('VA', 'CA', 'CF', 'HM') and nums: x['courseMag'] = float(nums[0])
        a = None
        if stack:
            up = [v for above, v in stack if above]; lo = [v for above, v in stack if not above]
            a = {'raw': '/'.join(f'{v}m' for v in up + lo)}
            if up: a['max'] = round(up[0] * M2FT / 10) * 10
            if lo: a['min'] = round(lo[0] * M2FT / 10) * 10
        elif al and not (x['pt'] in ('VA', 'CA') and al.group(1) == str(nums[0]) and len(nums) == 1):
            v = int(al.group(1)); a = {'raw': f'{al.group(0)}m'.replace(' or ', 'm or ')}
            if x['pt'] in ('VA', 'CA'): a['min'] = round(v * M2FT / 10) * 10
        elif x['pt'] in ('VA', 'CA') and len(nums) >= 2:
            a = {'raw': f'{nums[1]}m', 'min': round(nums[1] * M2FT / 10) * 10}
        if a: x['alt'] = a
        if sp: x['speed'] = {'raw': sp.group(0), **({'max': int(sp.group(2))} if sp.group(1) != 'MIN' else {'min': int(sp.group(2))}), **({'min': int(sp.group(2))} if sp.group(1) == 'AT' else {})}
    return out
def finish(legs):
    o, prev = [], None
    for l in legs:
        if 'fix' not in l: continue
        if o and o[-1]['fix'] == l['fix'] and l['pt'] == 'IF': continue
        l = dict(l); p = pos(l['fix'])
        if p and prev: l['distNM'] = round(dist(prev, p), 1)
        prev = p or prev; l['seq'] = len(o) + 1; l['navSpec'] = 'RNAV1'; o.append(l)
    return o
def rws_of(s):
    out = []
    for m in re.finditer(r'(\d{2}[LR]?)', s.replace('RWY', '')):
        if m.group(1) in RW: out.append(m.group(1))
    return out
text = '\n'.join(subprocess.run(['pdftotext', '-layout', f, '-'], capture_output=True, text=True).stdout
                 for f in sorted(glob.glob(f'{ROOT}/pdf/ZSPD-0C-*.pdf'), key=lambda p: int(re.search(r'0C-(\d+)', p).group(1))))
sids, stars, appT, missed = [], [], collections.defaultdict(list), {}
cur = part = None
for kind, x, i in parse(text):
    if kind == 'H':
        g = x
        if len(g) >= 3 and g[1] in ('SID', 'STAR'):
            cur = {'name': g[2] + (' (by ATC)' if g[3] else ''), 'type': g[1], 'rws': rws_of(g[0]), 'rt': {}, 'common': []}
            (sids if g[1] == 'SID' else stars).append(cur); part = cur['common']
        elif g[1:2] == ('Runway Transition',) and cur: part = cur['rt'].setdefault(g[0][3:], [])
        elif g[0] == 'Common' and cur: part = cur['common']
        elif len(g) >= 2 and g[1] == 'Approach Transition': cur = None; part = appT[g[0][3:]].__class__(); appT[g[0][3:]].append((g[2], part))
        elif len(g) >= 2 and g[1] == 'Missed Approach': cur = None; part = missed.setdefault(g[0][3:], {'name': g[2], 'legs': []})['legs']
        else: cur = None; part = None
        continue
    if part is not None: part.append(x)
AP = {'icao': 'ZSPD', 'iata': 'PVG', 'nameJa': '上海浦東国際空港', 'nameEn': 'Shanghai Pudong International', 'nameAip': 'SHANGHAI/Pudong', 'city': '上海', 'country': CC,
      'arp': {'lat': round(arp_la, 6), 'lon': round(arp_lo, 6)}, 'elevationFt': round(3.5 * M2FT, 1), 'magVar': -5.8, 'transitionAltitudeFt': 9800, 'aipEffective': '20260930',
      'runways': runways, 'localNavaids': [], 'sids': [], 'stars': [], 'approaches': [], 'sidTransitions': [], 'starTransitions': [],
      'notes': ['滑走路の端の座標は AIP で公開されていないため、ARP（17L/35R の中心）と AD 2.12 の位置関係から計算した近似', 'コーディング表の高度は m 表記。上下2段は上限・下限として読み、1つだけの値は区別（以上・以下）が図にしかないため数値の範囲は付けていない']}
for p in sids:
    rl = {rw: finish(L + p['common']) for rw, L in p['rt'].items()} if p['rt'] else {'/'.join(p['rws']) or 'ALL': finish(p['common'])}
    rl = {k: v for k, v in rl.items() if len(v) >= 2}
    if rl: AP['sids'].append({'name': p['name'], 'type': 'SID', 'rnav': True, 'chartPages': [], 'runwayLegs': rl, 'runways': list(p['rt']) or p['rws']})
for p in stars:
    L = finish(p['common'])
    if len(L) >= 2: AP['stars'].append({'name': p['name'], 'type': 'STAR', 'rnav': True, 'chartPages': [], 'runwayLegs': {'/'.join(p['rws']): L}, 'runways': p['rws']})
for rw in RW:
    if rw not in appT and rw not in missed: continue
    routes = [[l['fix'] for l in legs if 'fix' in l] + [f'RW{rw}'] for nm, legs in appT.get(rw, [])]
    ms = [l['fix'] for l in missed.get(rw, {}).get('legs', []) if 'fix' in l]
    ms = [x for k, x in enumerate(ms) if (k == 0 or ms[k - 1] != x) and pos(x)]
    nm = (missed.get(rw, {}).get('name') or 'RNAV ILS/DME z').split(' x')[0].strip()
    AP['approaches'].append({'name': f'{nm} RWY{rw}', 'type': 'APPROACH', 'kind': 'ILS', 'rnav': True, 'runways': [rw], 'chartPages': [],
                             'fixes': {'IAF': list(dict.fromkeys(r[0] for r in routes)), 'FAF': list(dict.fromkeys(r[-2] for r in routes if len(r) >= 2)), 'MAPt': [f'RW{rw}'], **({'MAHF': [ms[-1]]} if ms else {})},
                             'routes': routes, 'missed': ms, 'missedApproach': '', 'warnings': ['最終進入（FAF から先）は ILS のためコーディングなし。FAF から滑走路へ直線で表示']})
used = {l['fix'] for p in AP['sids'] + AP['stars'] for L in p['runwayLegs'].values() for l in L} | {x for p in AP['approaches'] for r in p['routes'] for x in r} | {x for p in AP['approaches'] for x in p['missed']}
miss = sorted(x for x in used if not pos(x))
WP = {k: v for k, v in WP.items() if k in used and k not in fixes}
json.dump({'meta': {'title': '中国 空港データ（ZSPD）', 'source': 'AIP China AD 2 ZSPD（AIRAC 2026-10）', 'country': CC, 'missingFixes': miss},
           'index': {'byIata': {'PVG': 'ZSPD'}}, 'airports': {'ZSPD': AP}, 'waypoints': WP}, open(f'{ROOT}/out/airport_cn.json', 'w'), ensure_ascii=False)
print('ZSPD SID', len(AP['sids']), 'STAR', len(AP['stars']), 'APP', len(AP['approaches']), 'WP', len(WP), 'missing', miss)
