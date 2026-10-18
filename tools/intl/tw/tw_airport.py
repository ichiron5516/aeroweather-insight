# 台湾 AD2（RCTP・RCKH）：HTML から空港・滑走路・無線施設、PDF の「Aeronautical Data of …」（地点一覧とコーディング表）から RNAV の SID・STAR・RNP 進入
import re, sys, json, glob, subprocess, os
sys.path.insert(0, '/home/claude/tw/tools')
from tw_common import *
import kr_lib
PT = re.compile(r'\b([A-Z][A-Z0-9]{1,4})\s+(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])')
def ft(s): m = re.search(r'([\d,]+)\s*FT', s); return int(m.group(1).replace(',', '')) if m else None
def tables(s):
    for t in s.find_all('table'):
        if t.find('table'): continue
        yield [[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in t.find_all('tr')]
def airport(icao, iata, ja, en, city):
    s = soup(next(k for k in kr_lib.H if icao in k))
    a = {'icao': icao, 'iata': iata, 'nameJa': ja, 'nameEn': en, 'nameAip': en.upper(), 'city': city, 'country': 'TW', 'aipEffective': '20261029',
         'runways': [], 'localNavaids': [], 'transitionAltitudeFt': 11000}
    dec = {}
    for rows in tables(s):
        flat = ' '.join(' '.join(r) for r in rows)
        for r in rows:
            if len(r) >= 3 and 'ARP coordinates' in r[1]:
                c = coords(r[2])[0]; a['arp'] = {'lat': c[1], 'lon': c[0]}
            if len(r) >= 3 and 'Elevation/Reference' in r[1]: a['elevationFt'] = ft(r[2])
            if len(r) >= 3 and 'Geoid undulation' in r[1]: a['geoidUndulationFt'] = ft(r[2])
            if len(r) >= 3 and 'MAG VAR' in r[1]:
                m = re.search(r'([\d.]+)°\s*([WE])', r[2]); a['magVar'] = (-1 if m.group(2) == 'W' else 1) * float(m.group(1))
            if len(r) >= 3 and 'Transition altitude' in r[1] and ft(r[2]): a['transitionAltitudeFt'] = ft(r[2])
        if 'TRUE BRG' in flat:
            for r in rows:
                if len(r) >= 6 and re.match(r'^\d{2}[LRC]?$', r[0]):
                    cs = coords(r[4]); dim = re.match(r'(\d+)\s*x\s*(\d+)', r[2]); te = re.search(r'THR:\s*(\d+)\s*FT', r[5])
                    a['runways'].append({'id': r[0], 'trueBearing': float(r[1]), 'lengthM': int(dim.group(1)), 'widthM': int(dim.group(2)),
                                         'threshold': {'lat': cs[0][1], 'lon': cs[0][0]}, 'departureEnd': {'lat': cs[1][1], 'lon': cs[1][0]},
                                         'thresholdElevFt': float(te.group(1)) if te else None, 'strength': r[3][:40]})
        if 'TORA' in flat and 'INTERSECTION' not in flat:
            for r in rows:
                if len(r) >= 5 and re.match(r'^\d{2}[LRC]?$', r[0]) and r[1].isdigit():
                    dec[r[0]] = dict(zip(['TORA', 'TODA', 'ASDA', 'LDA'], [int(x) if x.isdigit() else None for x in r[1:5]]))
        if 'Type of aid' in flat:
            for r in rows:
                if len(r) >= 5 and re.match(r'^[A-Z]{2,4}$', r[1]) and coords(r[4]):
                    c = coords(r[4])[0]; ty = re.match(r'(VOR/DME|VORTAC|DME|LOC|NDB|TACAN|VOR)', r[0])
                    if r[1] not in [n['id'] for n in a['localNavaids']]:
                        a['localNavaids'].append({'type': ty.group(1) if ty else r[0][:10], 'id': r[1], 'freq': re.sub(r'\s', '', r[2]).replace('MHZ', 'MHz').replace('KHZ', 'kHz'), 'lat': c[1], 'lon': c[0]})
    # AD 2.22 の表（「BAKER 1A」と滑走路）から、データ表に滑走路が書かれていない手順の滑走路を引く
    a['_procRwy'] = {}
    for rows in tables(s):
        rw = None
        for r in rows:
            for x in r:
                if re.match(r'^\d{2}[LRC]?(/\d{2}[LRC]?)*$', x): rw = x.split('/')
            for x in r:
                for nm in re.findall(r'\b([A-Z]{3,5} \d[A-Z])\b', x):
                    if rw: a['_procRwy'].setdefault(nm, set()).update(rw)
    for r in a['runways']:
        r['declared'] = dec.get(r['id'], {})
        rec = '%02d' % ((int(r['id'][:2]) + 17) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C', '': ''}[r['id'][2:]]
        if any(x['id'] == rec for x in a['runways']): r['reciprocal'] = rec
    return a

def alt_of(tok):
    m = re.match(r'^([+\-@]?)(FL\d{3}|\d{3,5})$', tok)
    if not m: return None
    v = int(m.group(2)[2:]) * 100 if m.group(2).startswith('FL') else int(m.group(2))
    sg = m.group(1)
    return {'raw': tok, **({'min': v} if sg == '+' else {'max': v} if sg == '-' else {'min': v, 'max': v})}
LEG = re.compile(r'^\s*(\d{2})\s+([A-Z]{2}(?:/[A-Z]{2})?)\s+(\S+)\s+(Y|-)\s+(.*)$')
def data_pdf(path):
    """戻り値：procs（名前→{rwys, legs}）, waypoints（id→(lat,lon)）, roles（id→[役割]）"""
    t = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
    wps, roles, procs, cur = {}, {}, {}, None
    for L in t.split('\n'):
        for m in PT.finditer(L):
            c = coords(m.group(2) + ' ' + m.group(3))[0]; wps[m.group(1)] = (c[1], c[0])
            rest = L[m.end():m.end() + 40]
            for r in re.findall(r'\b(IAF|IF|FAF|MAPt|MAHF)\b', rest): roles.setdefault(m.group(1), []).append(r)
        h = re.match(r'^\s*((?:[A-Z]+\s){1,4}?(?:ONE|TWO|THREE|FOUR|FIVE)\s+[A-Z]+\s+(?:RNAV\s+)?(?:DEPARTURE|ARRIVAL))\s*(?:\(RWY\s*([0-9LRC/ ,]+)\))?\s*$', L)
        if h:
            cur = re.sub(r'\s+', ' ', h.group(1)).strip()
            if cur in procs and procs[cur]['legs']: cur = cur + ' '            # 地点一覧の見出しと区別（2回目＝コーディング表）
            procs.setdefault(cur.strip(), {'rwys': [x.strip() for x in re.split(r'[/,]', h.group(2) or '') if x.strip()], 'legs': []}); cur = cur.strip(); continue
        h2 = re.match(r'^\s*(?:RC[A-Z]{2}\s+)?(RNP\s+(?:[A-Z]\s+)?RWY\s*\d{2}[LRC]?)\s*$', L)
        if h2: cur = h2.group(1); procs.setdefault(cur, {'rwys': [re.search(r'RWY\s*(\S+)', cur).group(1)], 'legs': []}); continue
        m = LEG.match(L)
        if m and cur:
            leg = {'seq': int(m.group(1)), 'pt': m.group(2).split('/')[-1], 'fix': m.group(3)}
            if m.group(4) == 'Y': leg['flyover'] = True
            rest = m.group(5)
            cm = re.search(r'(\d{3})\s*\((\d{3}\.\d)\)', rest)
            if cm: leg['courseMag'] = float(cm.group(1)); leg['courseTrue'] = float(cm.group(2)); rest = rest.replace(cm.group(0), ' ')
            toks = [x for x in re.split(r'\s{2,}|\s(?=[+\-@]?\d)', rest.strip()) if x]
            nums = [x for x in toks if re.match(r'^[+\-@]?(FL\d{3}|\d{3,5})$', x.replace(' ', ''))]
            if nums:
                a = alt_of(nums[0].replace(' ', ''))
                if a and (a.get('min', 0) >= 400 or a.get('max', 0) >= 400): leg['alt'] = a
                if len(nums) > 1 and re.match(r'^[+\-@]\d{3}$', nums[1]):
                    sp = nums[1]; leg['speed'] = {'raw': sp, **({'max': int(sp[1:])} if sp[0] in '-@' else {'min': int(sp[1:])})}
            ns = re.search(r'(RNAV\s*1|RNP\s*APCH|RNP\s*1|RNAV\s*5)', rest)
            if ns: leg['navSpec'] = ns.group(1).replace(' ', '')
            if leg['fix'] in ('-', '---'): leg['fix'] = None
            procs[cur]['legs'].append(leg)
    return procs, wps, roles

AP, WP = {}, {}
for icao, iata, ja, en, city in [('RCTP', 'TPE', '台湾桃園国際空港', 'Taiwan Taoyuan International', '台湾 桃園市'), ('RCKH', 'KHH', '高雄国際空港', 'Kaohsiung International', '台湾 高雄市')]:
    a = airport(icao, iata, ja, en, city)
    a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
    rwset = [r['id'] for r in a['runways']]
    for f in sorted(glob.glob(f'/home/claude/tw/pdf/{icao}/*Aeronautical Data*.pdf')):
        procs, wps, roles = data_pdf(f)
        pg = int(os.path.basename(f).split('-')[0])
        for k, (la, lo) in wps.items(): WP.setdefault(k, {'lat': la, 'lon': lo, 'type': 'waypoint', 'src': [f'{icao} {os.path.basename(f)}'], 'country': 'TW'})
        for name, p in procs.items():
            legs = [l for l in p['legs'] if l['fix']] if not name.startswith('RNP') else p['legs']
            rws = [r for r in sum((([x] if re.match(r'^\d{2}[LRC]?$', x) else [x[:2] + y for y in 'LR'] if x[2:] in ('L/R', 'LR') else []) for x in p['rwys']), []) if r in rwset]
            if not rws:
                W = {'ONE': '1', 'TWO': '2', 'THREE': '3', 'FOUR': '4', 'FIVE': '5'}
                mm = re.match(r'([A-Z]+) (ONE|TWO|THREE|FOUR|FIVE) ([A-Z])', name)
                NAV = {v.get('name'): k for k, v in json.load(open('/home/claude/tw/out/nav_tw.json'))['fixes'].items() if v.get('type') == 'navaid'}
                if mm:
                    for base in (mm.group(1), NAV.get(mm.group(1), '')):
                        rws = rws or sorted(r for r in a['_procRwy'].get(f'{base} {W[mm.group(2)]}{mm.group(3)}', []) if r in rwset)
            rws = rws or ['ALL']
            if name.startswith('RNP'):
                fx = [l['fix'] for l in legs if l['fix']]
                rl = {}
                for f_, rr in roles.items():
                    for r in rr: rl.setdefault(r, []).append(f_)
                isMap = lambda l_: bool(l_['fix']) and (l_['fix'].startswith('RW') or l_['fix'] in rl.get('MAPt', []))
                starts = [l['fix'] for l in legs if l['seq'] == 1 and l['fix']]
                if len(starts) > 1:                       # T 字型：IAF が複数（どれも 01）→ 共通部分
                    common = []
                    last1 = max(i for i, l in enumerate(legs) if l['seq'] == 1)
                    for l in legs[last1 + 1:]:
                        if not l['fix'] or isMap(l): break
                        common.append(l['fix'])
                    routes = [[s] + common for s in starts]
                else:
                    i0 = next((i for i, l in enumerate(legs) if l['fix'] in rl.get('IAF', [])), 0)
                    r = []
                    for l in legs[i0:]:
                        if not l['fix'] or isMap(l): break
                        r.append(l['fix'])
                    routes = [list(dict.fromkeys(r))]
                mi = next((i for i, l in enumerate(legs) if l['fix'] and (l['fix'].startswith('RW') or l['fix'] in rl.get('MAPt', []))), None)
                missed = [l['fix'] for l in legs[mi + 1:] if l['fix']] if mi is not None else []
                missed = [x for x in dict.fromkeys(missed + rl.get('MAHF', [])) if not x.startswith('RW')]
                a['approaches'].append({'name': name, 'type': 'APPROACH', 'kind': 'RNP', 'rnav': True, 'runways': rws, 'chartPages': [pg],
                                        'fixes': {k: v for k, v in rl.items() if k in ('IAF', 'IF', 'FAF', 'MAPt', 'MAHF')}, 'routes': routes, 'missed': missed,
                                        'runwayLegs': {'/'.join(rws): legs}, 'missedApproach': '', 'warnings': []})
            else:
                kind = 'SID' if 'DEPARTURE' in name else 'STAR'
                lst = a['sids'] if kind == 'SID' else a['stars']
                o = next((x for x in lst if x['name'] == name), None)
                if not o: o = {'name': name, 'type': kind, 'rnav': True, 'chartPages': [pg], 'runwayLegs': {}, 'runways': []}; lst.append(o)
                o['runwayLegs']['/'.join(rws)] = [{**l, 'seq': i + 1} for i, l in enumerate(legs)]
                o['runways'] = list(dict.fromkeys(o['runways'] + rws))
    # 従来型（VOR/NDB 基準）の SID・STAR、ILS/LOC/NDB 進入は図だけ（名前と滑走路のみ）
    for f in sorted(glob.glob(f'/home/claude/tw/pdf/{icao}/*.pdf')):
        b = os.path.basename(f)[4:-4]
        m = re.match(r'(ILS|LOC|NDB|VOR)\s*RWY\s*(\d{2}[LRC]?)(-CAT2)?$', b)
        if m and not m.group(3):
            a['approaches'].append({'name': f'{m.group(1)} RWY{m.group(2)}', 'type': 'APPROACH', 'kind': m.group(1), 'rnav': False, 'runways': [m.group(2)],
                                    'chartPages': [], 'fixes': {}, 'routes': [], 'missed': [], 'missedApproach': '',
                                    'warnings': ['図のみ（データ表がないため経路は表示しません）。AIP のチャートを参照']})
    a['approaches'].sort(key=lambda p: (p['runways'][0], p['kind']))
    a.pop('_procRwy', None)
    AP[icao] = a
    print(icao, a.get('arp'), [r['id'] for r in a['runways']], [n['id'] for n in a['localNavaids']], 'SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']))
json.dump({'meta': {'title': '台湾 空港データ（RCTP・RCKH）', 'source': 'AIP Taiwan AD2（eAIP AIRAC AMDT 05-26, 2026-10-29）', 'country': 'TW'},
           'index': {'byIata': {a['iata']: k for k, a in AP.items()}}, 'airports': AP, 'waypoints': WP}, open('/home/claude/tw/out/airport_tw.json', 'w'), ensure_ascii=False)
print('waypoints', len(WP))
for ic, a in AP.items():
    for p in a['sids'] + a['stars']: print(ic, p['type'], p['name'], list(p['runwayLegs']), [(l['pt'], l['fix'], (l.get('alt') or {}).get('raw')) for l in list(p['runwayLegs'].values())[0]])
    for p in a['approaches']: print(ic, p['name'], p['runways'], p['fixes'], p['routes'], p['missed'])
