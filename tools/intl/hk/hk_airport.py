# 香港 VHHH：AD2 HTML の基本情報 ＋ SID・STAR・進入チャート PDF（画像）を OCR した「FMC Database Coding Reference」から手順
import re, sys, json, glob, os
sys.path.insert(0, '/home/claude/hk/tools')
from hk_common import *
def kv_rows(s, n):
    h = next(h for h in s.find_all('h4') if re.search(rf'AD 2\.{n}\b', txt(h)))
    nxt = next((x for x in h.find_all_next('h4') if re.search(rf'AD 2\.{n + 1}\b', txt(x))), None)
    stop = set(id(t) for t in nxt.find_all_next('table')) if nxt else set()
    rows = []
    for t in h.find_all_next('table'):
        if id(t) in stop: break
        rows += [[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in t.find_all('tr')]
    return rows
s = soup('AD-2-VHHH')
kv = {r[1]: r[2] for r in kv_rows(s, 2) if len(r) >= 3}
arp = coords(kv['ARP co-ordinates and site at AD'])[0]
a = {'icao': 'VHHH', 'iata': 'HKG', 'nameJa': '香港国際空港', 'nameEn': 'Hong Kong International', 'nameAip': 'HONG KONG INTL', 'city': '香港', 'country': 'HK',
     'arp': {'lat': arp[1], 'lon': arp[0]}, 'elevationFt': 28, 'magVar': -3.0, 'transitionAltitudeFt': 9000, 'aipEffective': '20261029', 'runways': [], 'localNavaids': []}
for r in kv_rows(s, 12):
    if len(r) >= 6 and re.match(r'^\d{2}[LRC]$', r[0]):
        c = coords(r[4])[0]; dim = re.match(r'(\d+)\s*x\s*(\d+)', r[2]); e = re.match(r'([\d.]+)FT', r[5])
        a['runways'].append({'id': r[0], 'trueBearing': float(r[1].split('°')[0]), 'lengthM': int(dim.group(1)), 'widthM': int(dim.group(2)), 'strength': r[3][:30],
                             'threshold': {'lat': c[1], 'lon': c[0]}, 'thresholdElevFt': float(e.group(1)) if e else None})
dec = {r[0]: dict(zip(['TORA', 'TODA', 'ASDA', 'LDA'], [int(x) for x in r[1:5]])) for r in kv_rows(s, 13) if len(r) >= 5 and re.match(r'^\d{2}[LRC]$', r[0])}
for r in a['runways']:
    rec = '%02d' % ((int(r['id'][:2]) + 17) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C'}[r['id'][2]]
    o = next((x for x in a['runways'] if x['id'] == rec), None)
    if o: r['reciprocal'] = rec; r['departureEnd'] = o['threshold']
    r['declared'] = dec.get(r['id'], {})
for r in kv_rows(s, 19):
    if len(r) >= 5 and re.match(r'^[A-Z]{2,4}$', r[1]) and coords(r[4]) and r[1] not in [n['id'] for n in a['localNavaids']]:
        c = coords(r[4])[0]; ty = re.match(r'(LOC|DME|GP|DVOR|VOR|NDB)', r[0])
        a['localNavaids'].append({'type': ty.group(1) if ty else r[0][:8], 'id': r[1], 'freq': r[2].replace(' ', ''), 'lat': c[1], 'lon': c[0]})

# ---------- OCR 結果 ----------
NAV = json.load(open('/home/claude/hk/out/nav_hk.json'))['fixes']
CO = re.compile(r'(\d{2})\s*[:.]?\s*(\d{2})\s*(\d{2}\.\d+)\s*N\s*(\d{3})\s*(\d{2})\s*(\d{2}\.\d+)\s*E')
def fixname(t):
    t = t.upper().strip('_|.,:; ')
    if re.match(r'^(HH|VH|DH|TH|LH|CH)', t): t = t[:2] + t[2:].replace('O', '0').replace('S', '5').replace('I', '1').replace('L', '1')
    if re.match(r'^RW', t):
        t = 'RW' + t[2:4].replace('O', '0').replace('S', '5') + t[4:].replace('1', 'L').replace('I', 'L')
    return t
PTS = {'IF', 'TF', 'CF', 'DF', 'VA', 'VI', 'CA', 'FA', 'RF', 'HM', 'HF', 'HA', 'VM', 'FM', 'FC', 'CI', 'VD', 'CD'}
WP, roles_all = {}, {}
def parse(text):
    lines = text.split('\n')
    wps, roles = {}, {}
    for L in lines:
        m = CO.search(L)
        if not m: continue
        head = L[:m.start()]
        nm = re.search(r'([A-Z0-9]{3,5})\s*(?:\((IAF|IF|FAF|FAP|MAPt|MAHF|THR|IAF/IF)\))?\s*\|?\s*$', head.upper().replace('MAPT', 'MAPt'))
        if not nm: continue
        f = fixname(nm.group(1))
        la = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600; lo = int(m[4]) + int(m[5]) / 60 + float(m[6]) / 3600
        wps[f] = (round(la, 7), round(lo, 7))
        if nm.group(2):
            for r in nm.group(2).replace('FAP', 'FAF').split('/'): roles.setdefault(r, []).append(f)
    blocks, cur = [], None
    for L in lines:
        h = re.search(r'TABULAR DESCRIPTION:\s*(.+)$', L)
        if h: cur = {'title': h.group(1).strip(' |'), 'legs': []}; blocks.append(cur); continue
        if not cur or 'WAYPOINT LIST' in L: 
            if 'WAYPOINT LIST' in L: cur = None
            continue
        toks = [x for x in re.split(r'[\s|]+', L.strip(' |.;:}')) if x]
        if len(toks) < 3: continue
        if not re.match(r'^([0Oo][\dOoIlts]{1,2}|\d{2})$', toks[0]): continue
        fx = None; pt = None
        for t in toks[1:5]:
            if t.upper() in PTS and not pt: pt = t.upper(); continue
            n = fixname(t)
            if n in wps or n in NAV: fx = n; break
        if not fx: continue
        rest = ' '.join(toks[toks.index(next(t for t in toks if fixname(t) == fx)) + 1:])
        alt = re.search(r'(?<![\d.])([+\-@])\s?(FL\s?\d{3}|\d{1,2}\s?\d{3})(m?)\b', rest)
        leg = {'pt': pt or 'TF', 'fix': fx}
        if alt and not alt.group(3):
            v = alt.group(2).replace(' ', ''); ft = int(v[2:]) * 100 if v.startswith('FL') else int(v)
            if ft >= 500 and (v.startswith('FL') or ft <= 25000): leg['alt'] = {'raw': alt.group(1) + v, **({'min': ft} if alt.group(1) == '+' else {'max': ft} if alt.group(1) == '-' else {'min': ft, 'max': ft})}
        sp = re.findall(r'(?<![\d.])([+\-@])(\d{3})\b(?!\s?\d)', rest)
        sp = [x for x in sp if 140 <= int(x[1]) <= 290 and (not alt or x[0] + x[1] != alt.group(0).replace(' ', ''))]
        if sp: leg['speed'] = {'raw': sp[-1][0] + sp[-1][1], **({'min': int(sp[-1][1])} if sp[-1][0] == '+' else {'max': int(sp[-1][1])})}
        if ' Y ' in f' {rest[:12]} ' : leg['flyover'] = True
        cur['legs'].append(leg)
    return blocks, wps, roles
def rwys_of(title):
    out = re.findall(r'(?:RWY|Runway)\s*(\d{2}[LRC]?)', title)
    if re.search(r'RWY\s*(\d{2})\s*[LRC]?/', title): pass
    return list(dict.fromkeys(out))
rwset = [r['id'] for r in a['runways']]
a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
for f in sorted(glob.glob('/home/claude/hk/ocr/*_c.txt')):
    kind = re.search(r'VHHH-(SID|STAR|IAC)-', f).group(1)
    blocks, wps, roles = parse(open(f).read())
    last = None
    for k, (la, lo) in wps.items(): WP.setdefault(k, {'lat': la, 'lon': lo, 'type': 'waypoint', 'src': ['VHHH ' + os.path.basename(f)[13:].split('_')[0]], 'country': 'HK'})
    for b in blocks:
        if not b['legs']: continue
        title = re.sub(r'(RWY|Runway)\s*[O0](\d)', r'\g<1> 0\2', re.sub(r'\s+', ' ', b['title']))
        rw = [r for r in rwys_of(title) if r in rwset] or (['07L', '07C', '07R'] if re.search(r'RWY\s*07\b', title) else ['25L', '25C', '25R'] if re.search(r'RWY\s*25\b', title) else ['ALL'])
        name = re.split(r'\s+(?:RWY|Runway)', title)[0].strip()
        legs = [{**l, 'seq': i + 1} for i, l in enumerate(b['legs'])]
        if kind in ('SID', 'STAR'):
            lst = a['sids'] if kind == 'SID' else a['stars']
            o = next((x for x in lst if x['name'] == name), None)
            if not o: o = {'name': name, 'type': kind, 'rnav': True, 'chartPages': [], 'runwayLegs': {}, 'runways': []}; lst.append(o)
            key = '/'.join(rw)
            if key in o['runwayLegs']: key += f'#{len(o["runwayLegs"]) + 1}'
            o['runwayLegs'][key] = legs; o['runways'] = list(dict.fromkeys(o['runways'] + rw))
        elif not re.match(r'(ILS|LOC|RNP|RNAV|VOR|NDB|GLS|IGS)\b', title) or title.startswith('RNAV Transition'):
            # 同じチャートの「RNAV Transition from …」「Missed Approach Segment」は直前の進入方式に足す
            if last is None: continue
            fx = [l['fix'] for l in legs]
            if title.startswith('Missed'): last['missed'] = list(dict.fromkeys(last['missed'] + [x for x in fx if not x.startswith('RW')]))
            else:
                faf = (last['fixes'].get('FAF') or [None])[0]
                r = fx[:fx.index(faf) + 1] if faf in fx else fx
                if r not in last['routes']: last['routes'].append(r)
                if fx[0] not in last['fixes'].get('IAF', []): last['fixes'].setdefault('IAF', []).append(fx[0])
            continue
        else:
            fx = [l['fix'] for l in legs]
            mi = next((i for i, x in enumerate(fx) if x.startswith('RW')), None)
            rl = {k: list(dict.fromkeys(v)) for k, v in roles.items()}
            iaf = (rl.get('IAF') or [fx[0]])
            r0 = fx[:mi] if mi is not None else fx
            i0 = next((i for i, x in enumerate(r0) if x in iaf), 0)
            missed = [x for x in (fx[mi + 1:] if mi is not None else []) if not x.startswith('RW')]
            if mi is not None: rl['MAPt'] = rl.get('MAPt') or [fx[mi]]
            faf0 = (rl.get('FAF') or [None])[0]
            if mi is None and faf0 in r0:                  # 最終進入のコーディングがない（ILS/LOC）：FAF までを経路、その後を進入復行
                k = r0.index(faf0); missed = [x for x in r0[k + 1:] if not x.startswith('RW')]; r0 = r0[:k + 1]
            nm = title.replace('APPROACH', '').strip()
            o = next((x for x in a['approaches'] if x['name'] == nm), None)
            route = list(dict.fromkeys(r0[i0:]))
            # IAF ごとの区間が続けて書かれている（T 字型など）：IAF で分け、FAF で終わらない区間には FAF を足す
            segs, cur_ = [], []
            for x in route:
                if x in iaf and cur_: segs.append(cur_); cur_ = []
                cur_.append(x)
            if cur_: segs.append(cur_)
            if len(segs) > 1:
                fa = (rl.get('FAF') or [None])[0]
                segs = [sg if not fa or sg[-1] == fa else sg + [fa] for sg in segs]
                route = segs[0]
                extra = segs[1:]
            else: extra = []
            if o:
                last = o
                for rr in [route] + extra:
                    if rr not in o['routes']: o['routes'].append(rr)
                for k, v in rl.items(): o['fixes'][k] = list(dict.fromkeys(o['fixes'].get(k, []) + v))
                continue
            kd = re.match(r'(ILS|LOC|RNP|RNAV|VOR|NDB|GLS|IGS)', nm)
            last = {'name': nm, 'type': 'APPROACH', 'kind': kd.group(1) if kd else nm.split()[0], 'rnav': bool(kd and kd.group(1) in ('RNP', 'RNAV')),
                                    'runways': rw[:1], 'chartPages': [], 'fixes': {k: v for k, v in rl.items() if k in ('IAF', 'IF', 'FAF', 'MAPt', 'MAHF')},
                                    'routes': [route] + extra, 'missed': list(dict.fromkeys(missed)), 'missedApproach': '', 'warnings': ['OCR（画像の表の読み取り）による。高度・速度は AIP で確認']}
            a['approaches'].append(last)
for p in a['approaches']:
    if p['missed'] and not p['fixes'].get('MAHF'): p['fixes']['MAHF'] = [p['missed'][-1]]
AP = {'VHHH': a}
json.dump({'meta': {'title': '香港 空港データ（VHHH）', 'source': 'AIP Hong Kong AD2（eAIP 2026-10-29）。SID・STAR・進入はチャート PDF（画像）を OCR', 'country': 'HK'},
           'index': {'byIata': {'HKG': 'VHHH'}}, 'airports': AP, 'waypoints': WP}, open('/home/claude/hk/out/airport_hk.json', 'w'), ensure_ascii=False)
print('rwy', [(r['id'], r.get('reciprocal')) for r in a['runways']], 'nav', [n['id'] for n in a['localNavaids']])
print('SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']), 'WP', len(WP))
for p in a['sids'][:6] + a['stars']: print(p['type'], p['name'], list(p['runwayLegs']), [(l['pt'], l['fix'], (l.get('alt') or {}).get('raw'), (l.get('speed') or {}).get('raw')) for l in list(p['runwayLegs'].values())[0]])
for p in a['approaches']: print('APP', p['name'], p['runways'], p['fixes'], p['routes'], p['missed'])
