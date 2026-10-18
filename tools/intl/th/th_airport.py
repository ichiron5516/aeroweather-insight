# タイ VTBS：AD2 HTML の基本情報 ＋ SID・STAR・進入（RNP / ILS）の「TABULAR DESCRIPTION」ページを OCR で読む
#   PDF は画像のため、ocr_all.sh で 300dpi 化 → 罫線除去（hk_clean.py）→ tesseract（--psm 6）した ocr/*_c.txt を使う
import re, sys, json, os, glob, math
from collections import Counter, defaultdict
sys.path.insert(0, '/home/claude/th/tools'); sys.path.insert(0, '/home/claude/kr/tools')
import th_common
from ad_generic import airport

ROOT = '/home/claude/th'
DEBUG = '-d' in sys.argv
a = airport('AD-2.VTBS', 'VTBS', 'BKK', 'バンコク・スワンナプーム国際空港', 'Bangkok Suvarnabhumi International', 'バンコク', 'TH', '20261029')
NAV = json.load(open(f'{ROOT}/out/nav_th.json'))['fixes']
TITLES = json.load(open(f'{ROOT}/titles.json'))
rwset = [r['id'] for r in a['runways']]

FIXNAME = {'RNDU': 'RIVDU', 'DEO2L': 'DE02L', 'DEO2R': 'DE02R', 'DEO19': 'DE019', 'DEO01': 'DE001'}
def ocr(pdf):
    out = []
    for f in sorted(glob.glob(f'{ROOT}/ocr/{pdf[:-4]}-*_c.txt'), key=lambda p: int(re.search(r'-(\d+)_c', p).group(1))):
        t = open(f, encoding='utf-8', errors='ignore').read()
        for x, y in FIXNAME.items(): t = re.sub(rf'\b{x}\b', y, t)
        out.append(t)
    return '\n'.join(out)

# ---------- 座標表（WAYPOINT LIST / FIX COORDINATES） ----------
CO = re.compile(r"(?:^|\s)\(?([A-Z0-9]{2,5})\)?\s+(?:[\d.]+D\s+[A-Z]{3,4}\s+)?(\d{2})\s?[°º]\s?(\d{2})\s?['’‘]\s?(\d{2}(?:[.,]\d{1,2})?)\s?[\"”“]?\s?([NS])_?\s+(\d{3})\s?[°º]\s?(\d{2})\s?['’‘]\s?(\d{2}(?:[.,]\d{1,2})?)\s?[\"”“]?\s?([EW])")
votes = defaultdict(Counter)
for pdf in TITLES:
    for m in CO.finditer(ocr(pdf)):
        g = m.groups(); k = g[0]
        if not re.match(r'^[A-Z]', k) or k in ('RWY', 'THR', 'DER', 'GP', 'LOC'): continue
        la = int(g[1]) + int(g[2]) / 60 + float(g[3].replace(',', '.')) / 3600
        lo = int(g[5]) + int(g[6]) / 60 + float(g[7].replace(',', '.')) / 3600
        if g[4] == 'S': la = -la
        if g[8] == 'W': lo = -lo
        if abs(la - 13.69) > 6 or abs(lo - 100.75) > 6: continue   # バンコクから遠すぎる＝誤読
        votes[k][(round(la, 5), round(lo, 5))] += 1
WP = {}
for k, c in votes.items():
    if k in NAV: continue
    (la, lo), n = c.most_common(1)[0]
    WP[k] = {'lat': la, 'lon': lo, 'type': 'waypoint', 'src': ['VTBS chart'], 'country': 'TH'}

def pos(k):
    p = NAV.get(k) or WP.get(k)
    return (p['lat'], p['lon']) if p else None
def dist(p, q):
    la1, lo1, la2, lo2 = map(math.radians, (*p, *q))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))

# ---------- 表の行 ----------
PTS = 'IF TF CF DF VA VI VM CA FA FM RF HM HF HA'.split()
ROW = re.compile(r'^.{0,6}?(?<![\d.])(\d{3})\s+([A-Z]{2})\s+(?:\(([^)]*)\)\s+)?([A-Z0-9]{2,5}|-)\s+(Y|N|-)?\s*(.*)$')
SIGNED = re.compile(r'(?:^|\s)([+\-@=])\s?(FL\s?\d{3}|\d{2,5})(?=;|\s|$)')
def parse_row(L, carry):
    m = ROW.match(L)
    if not m or m.group(2) not in PTS: return None
    seq, pt, role, fix, fo, rest = m.groups()
    leg = {'serial': int(seq), 'pt': pt}
    if fix != '-': leg['fix'] = fix
    if role: leg['role'] = role.strip()
    if fo == 'Y': leg['flyover'] = True
    cm = re.search(r'(\d{3})\s?°\s?\((\d{3})[.,](\d)', rest)
    if cm: leg['courseMag'] = float(cm.group(1)); leg['courseTrue'] = float(f'{cm.group(2)}.{cm.group(3)}')
    rest = re.sub(r'\d{3}\s?°\s?\([^)]*\)', ' ', rest)
    rest = re.sub(r'(?:^|\s)[+-]\s?0[.,]?\d(?=\s)', ' ', rest, count=1)      # 磁気偏差
    rest = re.sub(r'-\d[.,]\d\s?/\s?\d+', ' ', rest)                        # VPA/TCH
    vals = [(s, v.replace(' ', '')) for s, v in SIGNED.findall(rest)]
    alt, spd = [], None
    for s, v in vals:
        n = int(v[2:]) * 100 if v.startswith('FL') else int(v)
        if s in '-=' and 140 <= n <= 350 and not v.startswith('FL') and spd is None and alt is not None: spd = n; continue
        alt.append((s, v, n))
    if carry: alt = carry + alt
    if alt:
        o = {'raw': ' '.join(('-' if s == '=' else s) + v for s, v, n in alt)}
        for s, v, n in alt:
            if s == '+': o['min'] = n
            elif s in '-=': o['max'] = n
            elif s == '@': o['min'] = o['max'] = n
        leg['alt'] = o
    if spd: leg['speed'] = {'raw': f'-{spd}', 'max': spd}
    return leg

def finish(legs, nav):
    out, prev = [], None
    for l in legs:
        l = dict(l); l.pop('serial', None); l.pop('role', None)
        if 'fix' not in l: continue
        p = pos(l['fix'])
        if p and prev: l['distNM'] = round(dist(prev, p), 1)
        prev = p or prev
        l['seq'] = len(out) + 1; l['navSpec'] = nav
        out.append(l)
    return out

def group_text(match):
    """同じ手順群の PDF を titles.json の順につなげる"""
    return [(k, ocr(k)) for k, v in TITLES.items() if match(v)]

def suffix_of(text):
    c = Counter(re.findall(r'\b[A-Z]{2,5}(\d[A-Z])\b', '\n'.join(text.split('\n')[:9])))
    return c.most_common(1)[0][0] if c else None

def rws_of(s):
    return [r for r in re.findall(r'\d{2}[LRC]?', s) if r in rwset]

a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
# ---------- SID ----------
sid_groups = defaultdict(list)
for k, v in TITLES.items():
    m = re.search(r'\(SID\).*?RNAV RWY\s*(\d{2}[LRC]?)\s*(\(PROPELLER\))?', v)
    if m and 'VTBS' in (ocr(k)[:300] + v): sid_groups[(m.group(1), bool(m.group(2)))].append(k)
for (rw, prop), files in sid_groups.items():
    blocks, cur = [], None
    for k in files:
        t = ocr(k)
        if 'TABULAR' not in t: continue
        suf = suffix_of(t); carry = []
        for L in t.split('\n'):
            h = re.match(r'^([A-Z0-9]{3,8})\s*TO\s?[A-Z]', L.strip())
            if h: cur = {'hdr': h.group(1), 'suf': suf, 'legs': []}; blocks.append(cur); carry = []; continue
            cm = re.match(r'^[^A-Z0-9+\-]*([+\-]\s?(?:FL)?\d{3,5});\s*$', L.strip())
            if cm: carry = [(cm.group(1)[0], cm.group(1)[1:].strip(), 0)]; carry = [(s, v, int(v[2:]) * 100 if v.startswith('FL') else int(v)) for s, v, _ in carry]; continue
            if re.match(r'^\W{0,3}010\s+\S?\s*DER\b', L.strip()):
                if cur is None or cur['legs']: cur = {'hdr': '', 'suf': suf, 'legs': []}; blocks.append(cur)
                continue
            lg = parse_row(L, carry)
            if lg and cur is not None: cur['legs'].append(lg); carry = []
    for b in blocks:
        legs = finish(b['legs'], 'RNAV1')
        if not legs: continue
        name = legs[-1]['fix'] + (b['suf'] or b['hdr'][-2:])
        if DEBUG and not b['hdr'].startswith(legs[-1]['fix']): print('MISMATCH', rw, prop, b['hdr'], [l['fix'] for l in legs])
        a['sids'].append({'name': name, 'type': 'SID', 'rnav': True, 'propeller': prop, 'chartPages': [], 'runwayLegs': {rw: legs}, 'runways': [rw]})

# ---------- STAR（移行経路ごとに「名前 (起点)」を別に作る） ----------
star_groups = defaultdict(list)
for k, v in TITLES.items():
    m = re.search(r'\(STAR\).*?RNAV RWY\s*([0-9LRC/]+)', v)
    if m: star_groups[m.group(1)].append(k)
for rwtxt, files in star_groups.items():
    rws = rws_of(rwtxt)
    stars, cur, tr = [], None, None
    for k in files:
        t = ocr(k)
        if 'TABULAR' not in t: continue
        suf = suffix_of(t)
        for L in t.split('\n'):
            s = L.strip()
            h = re.match(r'^([A-Z]{3,5})\s?(\d[A-Z0-9])$', s)
            if h: cur = {'hdr': h.group(1), 'suf': suf, 'trans': [], 'common': []}; stars.append(cur); tr = None; continue
            tm = re.match(r'^TRANSITION\s+([A-Z0-9]{2,5})\b', s)
            if tm and cur: tr = {'from': tm.group(1), 'legs': []}; cur['trans'].append(tr); continue
            lg = parse_row(L, [])
            if not lg or not cur: continue
            if tr is not None and lg['serial'] == 10 and tr['legs']: tr = None   # 共通部分の始まり
            (tr['legs'] if tr is not None else cur['common']).append(lg)
    for st in stars:
        common = finish(st['common'], 'RNAV1')
        if not common: continue
        name = st['hdr'] + st['suf'] if st['hdr'] in (NAV.keys() | WP.keys()) else common[0]['fix'] + st['suf']
        key = '/'.join(rws)
        a['stars'].append({'name': name, 'type': 'STAR', 'rnav': True, 'chartPages': [], 'runwayLegs': {key: common}, 'runways': rws})
        for t in st['trans']:
            full = finish(t['legs'] + st['common'][1:] if t['legs'] and st['common'] and t['legs'][-1].get('fix') == st['common'][0].get('fix') else t['legs'] + st['common'], 'RNAV1')
            a['stars'].append({'name': f'{name} ({t["from"]})', 'type': 'STAR', 'rnav': True, 'chartPages': [], 'runwayLegs': {key: full}, 'runways': rws, 'transitionOf': name})

# ---------- 進入（RNP・ILS の TABULAR DESCRIPTION） ----------
for k, v in TITLES.items():
    if 'Tabular description' not in v or 'Approach Chart' not in v: continue
    m = re.search(r'ICAO - (RNP|ILS or LOC z)\s+RWY\s*(\d{2}[LRC]?)', v)
    if not m: continue
    kind, rw = ('RNP' if m.group(1) == 'RNP' else 'ILS'), m.group(2)
    t = ocr(k)
    segs, legs = [], []
    for L in t.split('\n'):
        if 'WAYPOINT LIST' in L: break
        lg = parse_row(L, [])
        if not lg: continue
        if lg['serial'] == 10 and legs: segs.append(legs); legs = []
        legs.append(lg)
    if legs: segs.append(legs)
    if not segs: continue
    final = segs[-1]
    mi = next((i for i, l in enumerate(final) if (l.get('role') or '').startswith('MAP')), None)
    if mi is None: continue
    core = [l['fix'] for l in final[:mi + 1] if 'fix' in l]
    missed = [l['fix'] for l in final[mi + 1:] if 'fix' in l]
    missed = [x for i, x in enumerate(missed) if i == 0 or missed[i - 1] != x]
    routes = []
    for sgm in segs[:-1]:
        fx = [l['fix'] for l in sgm if 'fix' in l]
        routes.append(fx + [x for x in core if x not in fx])
    if not routes: routes = [core]
    roles = defaultdict(list)
    for sgm in segs:
        for l in sgm:
            for r in re.findall(r'IAF|IF|FAP|FAF|SDF', l.get('role') or ''):
                roles['FAF' if r == 'FAP' else r].append(l['fix'])
    roles['MAPt'] = [final[mi]['fix']]
    if missed: roles['MAHF'] = [missed[-1]]
    if 'IAF' not in roles: roles['IAF'] = [r[0] for r in routes]
    roles.pop('SDF', None)
    a['approaches'].append({'name': f'{"ILS or LOC Z" if kind == "ILS" else "RNP"} RWY {rw}', 'type': 'APPROACH', 'kind': kind, 'rnav': kind == 'RNP',
                            'runways': [rw], 'chartPages': [], 'fixes': {r: list(dict.fromkeys(x)) for r, x in roles.items()},
                            'routes': routes, 'missed': missed, 'missedApproach': '', 'warnings': []})
a['approaches'].sort(key=lambda p: (p['runways'][0], p['kind']))

# 名前の重複は後勝ちにしない（先のものを残す）
for key in ('sids', 'stars'):
    seen, out = set(), []
    for p in a[key]:
        nk = (p['name'], tuple(p['runways']))
        if nk in seen: continue
        seen.add(nk); out.append(p)
    a[key] = out
# SID は同名で滑走路違いがあれば runwayLegs をまとめる
merged = {}
for p in a['sids']:
    if p['name'] in merged:
        q = merged[p['name']]; q['runwayLegs'].update(p['runwayLegs']); q['runways'] += p['runways']
    else: merged[p['name']] = p
a['sids'] = sorted(merged.values(), key=lambda p: p['name'])
a['stars'].sort(key=lambda p: p['name'])

used = {l['fix'] for p in a['sids'] + a['stars'] for L in p['runwayLegs'].values() for l in L} | {x for p in a['approaches'] for r in p['routes'] for x in r} | {x for p in a['approaches'] for x in p['missed']}
miss = sorted(x for x in used if not pos(x))
WP = {k: v for k, v in WP.items() if k in used}
json.dump({'meta': {'title': 'タイ 空港データ（VTBS）', 'source': 'AIP Thailand AD2（eAIP 2026-10-29 AIRAC）。手順表は画像 PDF を OCR', 'country': 'TH', 'missingFixes': miss},
           'index': {'byIata': {'BKK': 'VTBS'}}, 'airports': {'VTBS': a}, 'waypoints': WP}, open(f'{ROOT}/out/airport_th.json', 'w'), ensure_ascii=False)
print('SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']), 'WP', len(WP), 'missing', miss)
