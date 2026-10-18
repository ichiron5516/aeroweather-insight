# マレーシア WMKK：AD2 HTML の基本情報 ＋ SID・STAR・進入の「TABULAR DESCRIPTION」を OCR で読む
#   PDF は文字が化けている（フォントの対応表がない）ため、全ページを 300dpi で画像化して OCR（ocr_all.sh）
import re, sys, json, glob, math
from collections import Counter, defaultdict
sys.path.insert(0, '/home/claude/my/tools'); sys.path.insert(0, '/home/claude/kr/tools')
import my_common
from ad_generic import airport
ROOT = '/home/claude/my'
CC = 'MY'
a = airport('AD-2.WMKK', 'WMKK', 'KUL', 'クアラルンプール国際空港', 'Kuala Lumpur International', 'クアラルンプール', CC, '20261029')
seen_rw = set(); a['runways'] = [r for r in a['runways'] if not (r['id'] in seen_rw or seen_rw.add(r['id']))]
rwset = [r['id'] for r in a['runways']]
NAV = json.load(open(f'{ROOT}/out/nav_my.json'))['fixes']
TITLES = json.load(open(f'{ROOT}/titles.json'))

ALIAS = {'KKBIG': 'KK815'}
def fixname(s):
    s = s.upper()
    if s in ALIAS: return ALIAS[s]
    m = re.match(r'^KK([0-9OBIlSZ]{3})$', s)       # KK8OB → KK808 など（数字の読み違い）
    if m: s = 'KK' + m.group(1).translate(str.maketrans('OBISZ', '08152'))
    return s
def ocr(pdf):
    out = []
    for f in sorted(glob.glob(f'{ROOT}/ocr/{pdf[:-4]}-*_c.txt'), key=lambda p: int(re.search(r'-(\d+)_c', p).group(1))):
        out.append(open(f, encoding='utf-8', errors='ignore').read())
    return '\n'.join(out)
TEXT = {f: ocr(f) for f in TITLES if 'TAXI' not in TITLES[f]}

# ---- 座標（WAYPOINT LIST・FIX COORDINATES）を多数決で ----
CO = re.compile(r"([A-Z][A-Z0-9]{1,4})\b[^\n]*?(\d{2})\s?°\s?(\d{2})\D{0,2}?(\d{2}[.,]\d{1,2})\D{0,3}([NS])\s*\|?\s*(\d{3})\s?°\s?(\d{2})\D{0,2}?(\d{2}[.,]\d{1,2})\D{0,3}([EW])")
votes = defaultdict(Counter)
for t in TEXT.values():
    for L in t.split('\n'):
        L2 = re.sub(r'^[\s|\[;:,.]+', '', L)
        L2 = re.sub(r"°(\d{2})1(\d{2}[.,]\d{2})", r"°\1'\2", L2)
        L2 = re.sub(r'^RWY\s?(\d{2}[LRC]?)', r'RW\1', L2)
        m = CO.search(L2)
        if not m or m.start() > 3: continue
        g = m.groups(); k = fixname(g[0])
        if k in ('AMDT', 'AIP', 'DME', 'RDL', 'FAP', 'FAF'): continue
        la = int(g[1]) + int(g[2]) / 60 + float(g[3].replace(',', '.')) / 3600
        lo = int(g[5]) + int(g[6]) / 60 + float(g[7].replace(',', '.')) / 3600
        if g[4] == 'S': la = -la
        if g[8] == 'W': lo = -lo
        if abs(la - 2.75) > 4 or abs(lo - 101.7) > 4 or int(g[2]) > 59 or int(g[6]) > 59: continue
        votes[k][(round(la, 4), round(lo, 4))] += 1
WP = {}
for k, c in votes.items():
    if k in NAV: continue
    (la, lo), n = c.most_common(1)[0]
    WP[k] = {'lat': la, 'lon': lo, 'type': 'waypoint', 'src': ['WMKK chart'], 'country': CC}
for r in a['runways']:
    if r.get('threshold'): WP.setdefault(f'RW{r["id"]}', {**r['threshold'], 'type': 'runway', 'src': ['WMKK AD 2.12'], 'country': CC})
def pos(k):
    p = NAV.get(k) or WP.get(k)
    return (p['lat'], p['lon']) if p else None
def dist(p, q):
    la1, lo1, la2, lo2 = map(math.radians, (*p, *q))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))

# ---- 表の行 ----
PTS = 'IF TF CF DF VA VI VM CA FA FM RF HM HF HA'.split()
ROW = re.compile(r'^[\W_LI]{0,4}?(' + '|'.join(PTS) + r')\s*[|]?\s*(?:\(([A-Z/ ]+)\)\s*)?([A-Z][A-Z0-9]{1,4})\b(.*)$')
SIG = re.compile(r'(?<![\w.])([+\-@])\s?(FL\s?\d{2,3}|\d{3,5})(?![\w.])')
def parse_row(L):
    m = ROW.match(L.strip())
    if not m: return None
    pt, role, fix, rest = m.groups()
    fix = fixname(fix)
    if fix in ('RNP', 'RNAV'): return None
    leg = {'pt': pt, 'fix': fix}
    if role: leg['role'] = role
    if re.match(r'^\s*[|]?\s*Y\b', rest): leg['flyover'] = True
    cm = re.search(r'\b(\d{3})(?:\s*\((\d{3}(?:\.\d)?)\))?', rest)
    if cm: leg['courseMag'] = float(cm.group(1))
    vals = SIG.findall(rest)
    alt, spd = [], None
    for s, v in vals:
        v = v.replace(' ', '')
        n = int(v[2:]) * 100 if v.startswith('FL') else int(v)
        if s == '-' and 140 <= n <= 350 and not v.startswith('FL') and alt and spd is None: spd = n; continue
        if n < 500 and not v.startswith('FL'): continue
        alt.append((s, v, n))
    if alt:
        o = {'raw': ' '.join(s + v for s, v, n in alt)}
        for s, v, n in alt:
            if s == '+': o['min'] = n
            elif s == '-': o['max'] = n
            else: o['min'] = o['max'] = n
        leg['alt'] = o
    if spd: leg['speed'] = {'raw': f'-{spd}', 'max': spd}
    return leg
DROPPED = set()
def finish(legs, nav='RNP1'):
    out, prev = [], None
    for l in legs:
        l = dict(l); l.pop('role', None)
        if out and out[-1]['fix'] == l['fix']: continue
        p = pos(l['fix'])
        if not p: DROPPED.add(l['fix']); continue
        if p and prev: l['distNM'] = round(dist(prev, p), 1)
        prev = p or prev
        l['seq'] = len(out) + 1; l['navSpec'] = nav
        out.append(l)
    return out
def rws_of(s):
    out = []
    for r in re.findall(r'\b(\d{2}[LRC]?)\b', s.replace('RWY', ' ')):
        if r in rwset and r not in out: out.append(r)
    return out

a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
HDR = re.compile(r'\(([A-Z]{2,5})\s?(\d[A-Z])\)\s*$')
for f, t in TEXT.items():
    ti = TITLES[f]
    kind = 'SID' if '(SID)' in ti else 'STAR' if 'ARRIVAL' in ti or '(STAR)' in ti else None
    if not kind: continue
    rws = rws_of(ti.split(' AD 2-')[0])
    cur = None
    for L in t.split('\n'):
        h = HDR.search(L.strip())
        if h and re.search(r'DEPARTURE|ARRIVAL|TRANSITION', L):
            cur = {'name': f'{h.group(1)} {h.group(2)}', 'legs': []}
            lst = a['sids'] if kind == 'SID' else a['stars']
            lst.append(cur); continue
        if cur is None: continue
        lg = parse_row(L)
        if lg: cur['legs'].append(lg)
    for lst in (a['sids'], a['stars']):
        for p in lst:
            if 'legs' in p and 'runwayLegs' not in p:
                p['runwayLegs'] = {'/'.join(rws) or 'ALL': finish(p.pop('legs'))}
                p.update({'type': kind if lst is (a['sids'] if kind == 'SID' else a['stars']) else p.get('type'), 'rnav': True, 'chartPages': [], 'runways': rws})
# 同名をまとめる（滑走路違い）・空のものを除く
for key, kind in (('sids', 'SID'), ('stars', 'STAR')):
    merged = {}
    for p in a[key]:
        p['type'] = kind
        legs = {k: v for k, v in p['runwayLegs'].items() if len(v) >= 2}
        if not legs: continue
        if p['name'] in merged:
            q = merged[p['name']]
            for k, v in legs.items():
                if k not in q['runwayLegs'] or len(v) > len(q['runwayLegs'][k]): q['runwayLegs'][k] = v
            q['runways'] = list(dict.fromkeys(q['runways'] + p['runways']))
        else: p['runwayLegs'] = legs; merged[p['name']] = p
    a[key] = sorted(merged.values(), key=lambda p: p['name'])

# ---- 進入 ----
for f, t in TEXT.items():
    ti = TITLES[f]
    if 'INSTRUMENT APPROACH CHART' not in ti or 'TABULAR' not in ti: continue
    m = re.search(r'RWY\s*(\d{2}[LRC]?)\s+(ILS OR LOC|RNP [XYZ](?: \(AR\))?|VOR/DME)', ti)
    if not m: continue
    rw, typ = m.group(1), m.group(2)
    name = f'{typ} RWY {rw}'
    kindA = 'ILS' if typ.startswith('ILS') else 'RNP' if typ.startswith('RNP') else 'VOR'
    legs = [lg for lg in (parse_row(L) for L in t.split('\n')) if lg]
    segs, cur = [], None
    for lg in legs:
        if lg['pt'] == 'IF' or cur is None: cur = []; segs.append(cur)
        cur.append(lg)
    final = next((s for s in segs if any(l['fix'].startswith('RW') or 'MAP' in (l.get('role') or '') for l in s)), None)
    routes, missed, roles = [], [], defaultdict(list)
    if final:
        mi = next(k for k, l in enumerate(final) if l['fix'].startswith('RW') or 'MAP' in (l.get('role') or ''))
        core = [l['fix'] for l in final[:mi + 1]]
        missed = [l['fix'] for l in final[mi + 1:]]
        for s in segs:
            if s is final: continue
            fx = [l['fix'] for l in s]
            routes.append(fx + [x for x in core if x not in fx])
        if not routes: routes = [core]
        roles['MAPt'] = [core[-1]]
        if len(core) >= 2: roles['FAF'] = [core[-2]]
        roles['IF'] = [core[0]]
    roles['IAF'] = list(dict.fromkeys(r[0] for r in routes if r))
    missed = [x for k, x in enumerate(missed) if k == 0 or missed[k - 1] != x]
    if missed: roles['MAHF'] = [missed[-1]]
    if not routes:
        # 表の OCR が崩れているときは、地点一覧の役割（IF・FAF・MAPT）と、表の中に出てくる地点の順で組み立てる
        tab = t.split('WAYPOINT LIST')[0].split('TABULAR DESCRIPTION')[-1]
        wl = t.split('WAYPOINT LIST')[-1]
        known, rl = [], {}
        for L in wl.split('\n'):
            mm = re.match(r'^[\s|]*(RWY\s?\d{2}[LRC]?|[A-Z][A-Z0-9]{1,4})\s*(?:\((IF|FAF|FAP|MAPT|IAF|MAHF)\))?', L)
            if mm and re.search(r'\d{2}\s?°', L):
                k = fixname(mm.group(1).replace('RWY', 'RW').replace(' ', ''))
                known.append(k)
                if mm.group(2): rl[mm.group(2)] = k
        seq = []
        for tok in re.findall(r'(RWY\s?\d{2}[LRC]?|\b[A-Z][A-Z0-9]{4}\b)', tab):
            k = fixname(tok.replace('RWY', 'RW').replace(' ', ''))
            if k in known and (not seq or seq[-1] != k): seq.append(k)
        if rl.get('IF') and (not seq or seq[0] != rl['IF']): seq.insert(0, rl['IF'])
        mapt = rl.get('MAPT') or next((k for k in seq if k.startswith('RW')), None)
        if mapt and mapt in seq:
            mi = seq.index(mapt)
            routes = [seq[:mi + 1]]; missed = [x for x in seq[mi + 1:] if x not in seq[:mi + 1]]
            roles = defaultdict(list, {'IAF': [seq[0]], 'IF': [rl.get('IF', seq[0])], 'MAPt': [mapt], **({'FAF': [rl.get('FAF') or rl.get('FAP')]} if (rl.get('FAF') or rl.get('FAP')) else {})})
            if missed: roles['MAHF'] = [missed[-1]]
        faf = rl.get('FAF') or rl.get('FAP')
        if routes and faf and faf not in routes[0] and len(routes[0]) >= 2: routes[0].insert(len(routes[0]) - 1, faf)
        if routes and len(routes[0]) < 2: routes, missed, roles = [], [], defaultdict(list)
        if not routes and rl.get('IF'):
            routes = [[rl['IF']] + ([faf] if faf else []) + [f'RW{rw}']]
            missed = [rl['MAHF']] if rl.get('MAHF') else []
            roles = defaultdict(list, {'IAF': [rl['IF']], 'IF': [rl['IF']], 'MAPt': [f'RW{rw}'], **({'FAF': [faf]} if faf else {}), **({'MAHF': missed} if missed else {})})
    if name in {p['name'] for p in a['approaches']}:
        q = next(p for p in a['approaches'] if p['name'] == name)
        q['routes'] += [r for r in routes if r not in q['routes']]; q['missed'] = q['missed'] or missed
        continue
    a['approaches'].append({'name': name, 'type': 'APPROACH', 'kind': kindA, 'rnav': kindA == 'RNP', 'runways': [rw], 'chartPages': [],
                            'fixes': {k: v for k, v in roles.items() if v}, 'routes': routes, 'missed': missed, 'missedApproach': '',
                            'warnings': [] if routes else ['図のみ（コーディング表を読めなかったため経路は表示しません）。AIP のチャートを参照']})
a['approaches'].sort(key=lambda p: (p['runways'][0], p['name']))
used = {l['fix'] for p in a['sids'] + a['stars'] for L in p['runwayLegs'].values() for l in L} | {x for p in a['approaches'] for r in p['routes'] for x in r} | {x for p in a['approaches'] for x in p['missed']}
miss = sorted(x for x in used if not pos(x))
WP = {k: v for k, v in WP.items() if k in used}
json.dump({'meta': {'title': 'マレーシア 空港データ（WMKK）', 'source': 'AIP Malaysia AD2（eAIP 2026-10-29 AIRAC）。手順表は PDF を OCR', 'country': CC, 'missingFixes': miss},
           'index': {'byIata': {'KUL': 'WMKK'}}, 'airports': {'WMKK': a}, 'waypoints': WP}, open(f'{ROOT}/out/airport_my.json', 'w'), ensure_ascii=False)
for p in a['approaches']:
    p['routes'] = [[x for x in r if pos(x)] for r in p['routes']]; p['missed'] = [x for x in p['missed'] if pos(x)]
    if p['routes']: p['warnings'] = ['表の OCR が一部崩れているため、地点一覧と表の地点の順から組み立てた経路']
print('dropped', sorted(DROPPED))
print('rwy', rwset, 'SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']), 'WP', len(WP), 'missing', miss)
