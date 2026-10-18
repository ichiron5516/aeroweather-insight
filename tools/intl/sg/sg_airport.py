# シンガポール WSSS：AD2 HTML の基本情報 ＋ SID・STAR・RNP 進入の PDF（文字のある表「Tabular Descriptions」）
import re, sys, json, glob, os, subprocess
sys.path.insert(0, '/home/claude/sg/tools'); sys.path.insert(0, '/home/claude/kr/tools')
import sg_common
from ad_generic import airport
a = airport('AD-2-WSSS', 'WSSS', 'SIN', 'シンガポール・チャンギ国際空港', 'Singapore Changi International', 'シンガポール', 'SG', '20260903')
NAV = json.load(open('/home/claude/sg/out/nav_sg.json'))['fixes']
rwset = [r['id'] for r in a['runways']]
ROW = re.compile(r'^\s*([A-Z]{2})\s+([A-Z0-9]{2,5})\s+(Y|N|-)\s+(.*)$')
def alt(s):
    m = re.findall(r'(A(\d{3})|FL(\d{3}))([+-]?)', s)
    if not m: return None
    out = {'raw': ' '.join(x[0] + x[3] for x in m)}
    for full, a_, fl, sg in m:
        v = int(a_) * 100 if a_ else int(fl) * 100
        if sg == '+': out['min'] = v
        elif sg == '-': out['max'] = v
        else: out['min'] = out['max'] = v
    return out
def legs_from(lines):
    legs = []
    for L in lines:
        m = ROW.match(L)
        if not m or m.group(1) not in ('IF', 'TF', 'CF', 'DF', 'VA', 'VI', 'CA', 'FA', 'RF', 'HM', 'HF', 'HA', 'VM', 'FM'): continue
        rest = m.group(4)
        leg = {'seq': len(legs) + 1, 'pt': m.group(1), 'fix': m.group(2)}
        if m.group(3) == 'Y': leg['flyover'] = True
        cm = re.search(r'(\d{3})\s*\((\d{3}\.\d)\)', rest)
        if cm: leg['courseMag'] = float(cm.group(1)); leg['courseTrue'] = float(cm.group(2))
        al = alt(rest)
        if al: leg['alt'] = al
        sp = re.search(r'K(\d{3})([+-]?)|\s(\d{3})\s{3,}', rest)
        if sp and sp.group(1): leg['speed'] = {'raw': sp.group(0).strip(), **({'min': int(sp.group(1))} if sp.group(2) == '+' else {'max': int(sp.group(1))})}
        legs.append(leg)
    return legs
a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
for f in sorted(glob.glob('/home/claude/sg/pdf/*.pdf')):
    t = subprocess.run(['pdftotext', '-layout', f, '-'], capture_output=True, text=True).stdout
    lines = t.split('\n')
    base = os.path.basename(f)
    if '-SID-' in base or '-STAR-' in base:
        h = next((re.search(r'([A-Z]{3,5} \d[A-Z]) \((SID|STAR)\).*?RWY\s*([0-9LRC/ ]+?)\s*-', L) for L in lines if re.search(r'\((SID|STAR)\).*RWY', L)), None)
        if not h: continue
        name, kind = h.group(1), h.group(2)
        rws = [r for r in re.findall(r'\d{2}[LRC]', h.group(3)) if r in rwset] or ['ALL']
        legs = legs_from(lines)
        if not legs: continue
        lst = a['sids'] if kind == 'SID' else a['stars']
        lst.append({'name': name, 'type': kind, 'rnav': True, 'chartPages': [], 'runwayLegs': {'/'.join(rws): legs}, 'runways': rws})
    elif '-IAC-' in base:
        title = next((re.sub(r'\s+', ' ', L).strip() for L in lines[:12] if re.search(r'(ILS|RNP|VOR|DVOR)', L)), '')
        blocks, cur = [], None
        for L in lines:
            m = re.search(r'(RNP[- ]APCH|RNP)\s+RWY\s*(\d{2}[LRC])\s*[–-]\s*Approach from\s+([A-Z0-9]{3,5})', L)
            if m: cur = {'rw': m.group(2), 'from': m.group(3), 'lines': []}; blocks.append(cur); continue
            if cur: cur['lines'].append(L)
        if blocks:
            rw = blocks[0]['rw']; routes, missed, roles = [], [], {'IAF': [], 'IF': [], 'FAF': [], 'MAPt': [], 'MAHF': []}
            for b in blocks:
                lg = legs_from(b['lines']); fx = [l['fix'] for l in lg]
                mi = next((i for i, x in enumerate(fx) if x.startswith('RW')), len(fx))
                routes.append(fx[:mi]); ms = fx[mi + 1:]
                if ms and not missed: missed = ms
                roles['IAF'].append(fx[0])
                if mi < len(fx): roles['MAPt'] = [fx[mi]]
                if mi > 1: roles['FAF'] = [fx[mi - 1]]
            if missed: roles['MAHF'] = [missed[-1]]
            a['approaches'].append({'name': f'RNP RWY{rw}', 'type': 'APPROACH', 'kind': 'RNP', 'rnav': True, 'runways': [rw], 'chartPages': [],
                                    'fixes': {k: list(dict.fromkeys(v)) for k, v in roles.items() if v}, 'routes': routes, 'missed': missed, 'missedApproach': '', 'warnings': []})
        else:
            m = re.search(r'RWY\s*(\d{2}[LRC])\s*-\s*([A-Z]{3})\s*(ILS/DME|DVOR/DME)', json.load(open('/home/claude/sg/titles.json')).get(base, ''))
            if m:
                fx = re.findall(r'\((IAF|IF|FAF|MAPT)\)\s*\n?\s*([A-Z]{5})', t)
                a['approaches'].append({'name': f'{"ILS" if "ILS" in m.group(3) else "VOR"} RWY{m.group(1)}', 'type': 'APPROACH', 'kind': 'ILS' if 'ILS' in m.group(3) else 'VOR', 'rnav': False,
                                        'runways': [m.group(1)], 'chartPages': [], 'fixes': {}, 'routes': [], 'missed': [], 'missedApproach': '',
                                        'warnings': ['図のみ（データ表がないため経路は表示しません）。AIP のチャートを参照']})
a['approaches'].sort(key=lambda p: (p['runways'][0], p['kind']))
WP = {}
_C = re.compile(r'^\s+([A-Z]{5})(?:\s*\([A-Z/]+\))?\s+(\d{2})° (\d{2})’ (\d{2})” ([NS])\s+(\d{3})° (\d{2})’ (\d{2})” ([EW])', re.M)
for _f in sorted(glob.glob('/home/claude/sg/pdf/*IAC*.pdf')):
    _t = subprocess.run(['pdftotext', '-layout', _f, '-'], capture_output=True, text=True).stdout
    for m in _C.finditer(_t):
        g = m.groups(); la = (int(g[1]) + int(g[2]) / 60 + int(g[3]) / 3600) * (-1 if g[4] == 'S' else 1); lo = (int(g[5]) + int(g[6]) / 60 + int(g[7]) / 3600) * (-1 if g[8] == 'W' else 1)
        if g[0] not in NAV: WP.setdefault(g[0], {'lat': round(la, 6), 'lon': round(lo, 6), 'type': 'waypoint', 'src': ['WSSS IAC'], 'country': 'SG'})
used = {l['fix'] for p in a['sids'] + a['stars'] for L in p['runwayLegs'].values() for l in L} | {x for p in a['approaches'] for r in p['routes'] for x in r} | {x for p in a['approaches'] for x in p['missed']}
miss = sorted(x for x in used if x not in NAV and x not in WP and not x.startswith('RW'))
json.dump({'meta': {'title': 'シンガポール 空港データ（WSSS）', 'source': 'AIP Singapore AD2（eAIP 2026-09-03）', 'country': 'SG', 'missingFixes': miss},
           'index': {'byIata': {'SIN': 'WSSS'}}, 'airports': {'WSSS': a}, 'waypoints': WP}, open('/home/claude/sg/out/airport_sg.json', 'w'), ensure_ascii=False)
print('rwy', [(r['id'], r.get('reciprocal')) for r in a['runways']], 'SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']), 'missing', miss)
for p in a['sids'][:3] + a['stars'][:3]: print(p['type'], p['name'], list(p['runwayLegs']), [(l['pt'], l['fix'], (l.get('alt') or {}).get('raw'), (l.get('speed') or {}).get('raw')) for l in list(p['runwayLegs'].values())[0]])
for p in a['approaches']: print(p['name'], p['fixes'], p['routes'], p['missed'])
