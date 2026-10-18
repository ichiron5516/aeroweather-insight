# 韓国 AD2（RKSI・RKSS）：HTML から空港・滑走路・無線施設、PDF のコーディングテーブル／データ表から SID・STAR・進入方式
import json, re, sys, subprocess
sys.path.insert(0, '/home/claude/kr/tools')
from kr_lib import *
DMS = re.compile(r"(\d{2})°(\d{2})'(\d{2}(?:\.\d+)?)(?:''|\")\s*([NS])\s+(\d{3})°(\d{2})'(\d{2}(?:\.\d+)?)(?:''|\")\s*([EW])")
def dms(m):
    la = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600; lo = int(m[5]) + int(m[6]) / 60 + float(m[7]) / 3600
    return round(-la if m[4] == 'S' else la, 7), round(-lo if m[8] == 'W' else lo, 7)
def pages(pdf):
    n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout).group(1))
    return [subprocess.run(['pdftotext', '-layout', '-f', str(p), '-l', str(p), pdf, '-'], capture_output=True, text=True).stdout for p in range(1, n + 1)]
def alt_of(s):
    s = s.replace('\xa0', ' ')
    out = {}
    toks = re.findall(r'([+\-@]?)\s?(FL\s?\d{2,3}|\d{1,2}\s\d{3}|\d{3,5})', s)
    if not toks: return None
    raw = ' '.join((a + b).replace(' ', '') for a, b in toks)
    for sign, v in toks:
        ft = int(v.replace('FL', '').replace(' ', '')) * (100 if v.startswith('FL') else 1)
        if sign == '+': out['min'] = ft
        elif sign == '-': out['max'] = ft
        else: out['min'] = out['max'] = ft
    return {'raw': raw, **out}
def rwys(text):
    """'RWY 15L/R, 16L/R' → ['15L','15R','16L','16R']"""
    out = []
    for m in re.finditer(r'RWY\s*(\d{2})([LRC](?:\s*/\s*[LRC])*)?', text):
        if m.group(2): out += [m.group(1) + x.strip() for x in m.group(2).split('/')]
        else: out.append(m.group(1))
    return list(dict.fromkeys(out))

PNAME = re.compile(r'^\s*((?:RNAV\s+)?[A-Z]{5}\s+\d[A-Z])\s*$')
def coding(lines, start):
    """start 行（Serial の見出し）から下のコーディング表を読む。戻り値：legs, 次の行番号, 地点座標
    pdftotext は複数行のセルを上下に振り分けるので、番号のない行は近いほうの行（同じ距離なら値の欠けている行）に足す"""
    h = lines[start]
    col = {k: h.find(k) for k in ['Serial', 'Path', 'Waypoint', 'Fly', 'Course', 'Distance', 'Turn', 'Altitude', 'Speed', 'Coordinates']}
    rows, extra, pts, i = [], [], {}, start + 1
    while i < len(lines):
        L = lines[i]
        if rows and (PNAME.match(L) or ('Serial' in L and 'Path' in L) or re.match(r'^\s*(RNP|RNAV|ILS|LOC|VOR)\b.*RWY', L)): break
        m = re.match(r'^\s*(\d{3})\s+(?:([A-Z]{2})\s+)?([A-Z][A-Z0-9]{1,4}|RW\d{2}[LRC]?)\s+(Y|-)\s', L)
        if m: rows.append((i, m, L))
        elif L.strip(): extra.append((i, L))
        i += 1
    seg = lambda L, a, b: L[max(0, col[a] - 3):(col[b] - 2 if b else None)] if col[a] >= 0 else ''
    legs = []
    for i0, m, L in rows:
        leg = {'seq': int(m.group(1)), 'pt': m.group(2) or '', 'fix': m.group(3), '_alt': seg(L, 'Altitude', 'Speed'), '_crs': L[:col['Turn']] if col['Turn'] > 0 else L, '_i': i0}
        if m.group(4) == 'Y': leg['flyover'] = True
        dm = re.search(r'(\d+\.\d)', seg(L, 'Distance', 'Turn'))
        if dm: leg['distNM'] = float(dm.group(1))
        sp = re.search(r'([@\-+]?)(\d{3})\b', seg(L, 'Speed', 'Coordinates'))
        if sp: leg['speed'] = {'raw': sp.group(0), **({'max': int(sp.group(2))} if sp.group(1) in ('-', '@') else {'min': int(sp.group(2))})}
        c = DMS.search(L)
        if c: pts[leg['fix']] = dms(c)
        ns = re.search(r'(RNAV\s*1|RNP\s*APCH|RNP\s*1|RNAV\s*5)', L)
        if ns: leg['navSpec'] = ns.group(1).replace(' ', '')
        legs.append(leg)
    for j, L in extra:
        if not legs or j > legs[-1]['_i'] + 3: continue
        prev = max((l for l in legs if l['_i'] < j), key=lambda l: l['_i'], default=None)
        nxt = min((l for l in legs if l['_i'] > j), key=lambda l: l['_i'], default=None)
        def pick(field):
            if prev and nxt:
                dp, dn = j - prev['_i'], nxt['_i'] - j
                if dp != dn: return prev if dp < dn else nxt
                return nxt if not nxt[field].strip(' -') else prev
            return prev or nxt
        for field, a, b in (('_alt', 'Altitude', 'Speed'), ('_crs', 'Fly', 'Turn')):
            t = seg(L, a, b)
            if t.strip(' -') and not re.search(r'[A-Za-z]{4}', t): pick(field)[field] += ' ' + t
        pm = re.match(r'^\s*([A-Z]{2})\s*$', seg(L, 'Path', 'Waypoint'))
        if pm:
            tgt = nxt if nxt and not nxt['pt'] and (prev is None or prev['pt'] or nxt['_i'] - j <= j - prev['_i']) else prev
            if tgt is not None and not tgt['pt']: tgt['pt'] = pm.group(1)
    for l in legs:
        a = alt_of(l.pop('_alt'))
        if a: l['alt'] = a
        cm = re.search(r'(\d{3})\s*\((\d{3}\.\d)\)', l.pop('_crs'))
        if cm: l['courseMag'] = float(cm.group(1)); l['courseTrue'] = float(cm.group(2))
        l.pop('_i'); l['pt'] = l['pt'] or 'TF'
    return legs, i, pts

def procs(pdf, kind):
    """SID・STAR の PDF → 手順のリスト"""
    out, wps = {}, {}
    for pg, t in enumerate(pages(pdf), 1):
        if 'Coding Tables' not in t: continue
        lines = t.split('\n')
        rw = rwys(' '.join(lines[:12])) or ['ALL']
        name = None
        i = 0
        while i < len(lines):
            m = PNAME.match(lines[i])
            if m: name = re.sub(r'\s+', ' ', m.group(1)); i += 1; continue
            if 'Serial' in lines[i] and 'Path' in lines[i] and name:
                legs, i, pts = coding(lines, i)
                wps.update(pts)
                p = out.setdefault(name, {'name': name, 'type': kind, 'rnav': name.startswith('RNAV'), 'chartPages': [], 'runwayLegs': {}, 'runways': []})
                key = '/'.join(rw)
                if key in p['runwayLegs']: key += f'#{len(p["runwayLegs"]) + 1}'
                p['runwayLegs'][key] = legs
                p['runways'] = list(dict.fromkeys(p['runways'] + rw)); p['chartPages'].append(pg)
                continue
            i += 1
    return list(out.values()), wps

ROLE = r'(IAF|IF|FAF|FAP|SDF|MAPt|MAHF)'
def approaches(pdf, known):
    groups, cur = [], None
    for pg, t in enumerate(pages(pdf), 1):
        head = '\n'.join(t.split('\n')[:14])
        m = re.search(r'((?:ILS|LOC|RNP|VOR|GLS|RNAV|GNSS)[A-Za-z0-9 ()/]*?\s?RWY\s?\d{2}[LRC]?)\s*$', head, re.M)
        nm = re.sub(r'\s+', ' ', m.group(1)).strip() if m else None
        if nm and (cur is None or nm != cur['name']): cur = {'name': nm, 'pages': [], 'text': []}; groups.append(cur)
        if cur: cur['pages'].append(pg); cur['text'].append(t)
    res, wps = [], {}
    for g in groups:
        T = '\n'.join(g['text']); nm = g['name']
        kind = 'ILS' if nm.startswith('ILS') else nm.split()[0]
        role = {}
        def addrole(r, f):
            for x in r.split('/'): role.setdefault('FAF' if x == 'FAP' else x, []).append(f)
        # ---- データ表（Fix / Point と座標）：まとまり（from … to …）ごとの地点列 ----
        blocks = []
        for blk in re.split(r'\n(?=\s*[A-Z/ ]*Approach to RWY)', T):
            if 'Fix / Point' not in blk: continue
            seq, L = [], blk.split('\n')
            for k, line in enumerate(L):
                c = DMS.search(line)
                if not c: continue
                left = line[:c.start()]
                fm = re.match(r'^\s*(?:(D\d+(?:\.\d+)?)\s+([A-Z]{3,4})|([A-Z][A-Z0-9]{2,4}))\s*(?:\(' + ROLE + r'(?:/' + ROLE + r')?\))?\s*(?:BRG|R\s?\d|HDG|$|\s)', left)
                if not fm or re.match(r'^\s*(THR|[A-Z]{3,4}\s+(VOR|DME|NDB|LOC|VORTAC|TACAN))', left): continue
                fid = f'{fm.group(1)}{fm.group(2)}' if fm.group(1) else fm.group(3)
                wps[fid] = dms(c)
                rl = [x for x in (fm.group(4), fm.group(5)) if x]
                nx = L[k + 1] if k + 1 < len(L) else ''
                rm = re.match(r'^\s*\(' + ROLE + r'\b', nx)
                if rm: rl.append(rm.group(1))
                for r in rl: addrole(r, fid)
                seq.append(fid)
            if seq: blocks.append(seq)
        # ---- コーディング表（RNP） ----
        lines, cod = T.split('\n'), []
        for i, line in enumerate(lines):
            if 'Serial' in line and 'Path' in line:
                legs, _, pts = coding(lines, i); wps.update(pts)
                if legs: cod.append(legs)
        for a, b in re.findall(r'via ([A-Z0-9]{3,5})\(IAF\) to ([A-Z0-9]{3,5})\(MAHF\)', T): addrole('IAF', a); addrole('MAHF', b)
        ok = lambda f: f in wps or f in known
        role = {k: list(dict.fromkeys(x for x in v if ok(x))) for k, v in role.items()}
        routes, missed = [], []
        if cod:
            for legs in cod:
                fx = [l['fix'] for l in legs]
                mi = next((k for k, l in enumerate(legs) if l['fix'].startswith('RW')), None)
                if mi is None: mi = next((k for k, l in enumerate(legs) if l.get('flyover') and k > 1), len(legs))
                routes.append([f for f in fx[:mi] if ok(f)])
                ms = [f for f in fx[mi + 1:] if ok(f)]
                if ms and not missed: missed = list(dict.fromkeys(ms))
                if mi < len(fx) and fx[mi].startswith('RW') is False: role.setdefault('MAPt', [fx[mi]])
        else:
            iaf = role.get('IAF', []); faf = (role.get('FAF') or [None])[0]
            fin = next((b for b in blocks if faf and faf in b), None)
            for b in blocks:
                if b[0] in iaf or (not iaf and b is blocks[0]):
                    r = list(b)
                    if fin and fin is not b: r += [x for x in fin[:fin.index(faf) + 1] if x not in r]
                    elif faf in r: r = r[:r.index(faf) + 1]
                    routes.append(r)
            if fin:
                after = fin[fin.index(faf) + 1:]
                mp = role.get('MAPt', [None])[0]
                after = after[after.index(mp) + 1:] if mp in after else [x for x in after if x not in role.get('SDF', [])]
                missed = list(dict.fromkeys(after))
        if missed and 'MAHF' not in role: role['MAHF'] = [missed[-1]]
        mh = role.get('MAHF', [None])[0]
        if mh and mh not in missed: missed.append(mh)
        if missed and mh and missed[-1] != mh and mh in missed: missed = missed[:missed.index(mh) + 1]
        ma = re.search(r'MISSED APPROACH\s*\n((?:.*\n){1,4})', T)
        mtxt = ' '.join(re.split(r'\s{4,}', l.strip())[0] for l in ma.group(1).split('\n') if l.strip()) if ma else ''
        sents = re.findall(r'((?:Fly|Climb|After|Track|Turn|At|Continue)[^.]*?\.)', mtxt)
        mtxt = ' '.join(x for x in sents if not re.search(r'TRANSITION|NOTE|Gradient', x))
        rw = re.search(r'RWY\s?(\d{2}[LRC]?)', nm).group(1)
        routes = [list(dict.fromkeys(r)) for r in routes if r]
        # 区間ごとに分かれた表をつなぐ（前の表の終点＝次の表の始点）
        for _ in range(3):
            for r in routes:
                nxt = next((q for q in routes if q is not r and q[0] == r[-1] and q[0] not in role.get('IAF', [])), None)
                if nxt: r += nxt[1:]
        starts = set(role.get('IAF', []))
        if starts: routes = [r for r in routes if r[0] in starts] or routes
        res.append({'name': nm, 'type': 'APPROACH', 'kind': kind, 'rnav': kind in ('RNP', 'RNAV', 'GNSS'), 'runways': [rw], 'chartPages': g['pages'],
                    'fixes': {k: v for k, v in role.items() if k in ('IAF', 'IF', 'FAF', 'MAPt', 'MAHF') and v},
                    'routes': list(map(list, dict.fromkeys(map(tuple, routes)))), 'missed': missed, 'missedApproach': mtxt,
                    'warnings': [] if routes else ['チャートのデータ表・コーディング表がなく、経路を読み取れませんでした（図のみ）']})
    return res, wps

def airport(icao, iata, nameJa, nameEn, city):
    s = soup(f'AD-2.{icao}')
    sec = {}
    for h in s.find_all('h4'):
        m = re.search(r'AD 2\.(\d+)', txt(h))
        if m: sec[int(m.group(1))] = h.find_next('table')
    kv = {txt(r.find_all('td')[1]): txt(r.find_all('td')[2]) for r in sec[2].find_all('tr') if len(r.find_all('td')) >= 3}
    arp = coords(kv.get('ARP coordinates and site at AD', ''))[0]
    el = re.search(r'([\d.]+)\s*m', kv.get('Elevation/Reference temperature', '')); var = re.search(r'(\d+(?:\.\d+)?)°\s*([WE])', kv.get('Magnetic VAR/Annual change', ''))
    geoid = re.search(r'([\d.]+)\s*m', kv.get('Geoid undulation at AD ELEV PSN', ''))
    rws = []
    for r in sec[12].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if len(c) < 6 or not re.match(r'^\d{2}[LRC]?$', c[0]): continue
        dim = re.match(r'([\d ]+)\s*×\s*(\d+)', c[2]); th = coords(c[4]); te = re.search(r'THR\s*[\d.]+\s*m\s*/\s*([\d.]+)\s*ft', c[5])
        rws.append({'id': c[0], 'trueBearing': float(c[1].replace('°', '')), 'lengthM': int(dim.group(1).replace(' ', '')), 'widthM': int(dim.group(2)),
                    'threshold': {'lat': th[0][1], 'lon': th[0][0]}, 'thresholdElevFt': float(te.group(1)) if te else None, 'strength': c[3][:40]})
    dec = {}
    for r in sec[13].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if len(c) >= 6 and c[5] == 'NIL' and c[0] not in dec:
            dec[c[0]] = dict(zip(['TORA', 'TODA', 'ASDA', 'LDA'], [int(x.replace(' ', '')) if x.replace(' ', '').isdigit() else None for x in c[1:5]]))
    for r in rws:
        r['declared'] = dec.get(r['id'], {})
        recip = '%02d' % ((int(r['id'][:2]) + 18 - 1) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C', '': ''}[r['id'][2:]]
        o = next((x for x in rws if x['id'] == recip), None)
        if o: r['reciprocal'] = recip; r['departureEnd'] = o['threshold']
    nav = []
    for r in sec[19].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        cc = next((coords(x) for x in c if coords(x)), None)
        if not cc: continue
        idx = 0 if re.match(r'^[A-Z]{2,4}$', c[0]) else 1
        typ = re.match(r'(VOR/DME|VORTAC|TVOR|DME|LOC|GP|NDB|IM|MM|OM)', c[0]) or (nav and re.match(r'(VOR/DME)', nav[-1]['type']))
        ident = c[idx] if re.match(r'^[A-Z]{2,4}$', c[idx]) else None
        if ident: nav.append({'type': typ.group(1) if typ else 'VOR/DME', 'id': ident, 'freq': c[idx + 1].split('(')[0].replace(' ', ''), 'lat': cc[0][1], 'lon': cc[0][0]})
    ta = re.search(r'Transition altitude.*?([\d ]+)\s*ft', ' '.join(txt(r) for r in sec[17].find_all('tr')))
    return {'icao': icao, 'iata': iata, 'nameJa': nameJa, 'nameEn': nameEn, 'nameAip': nameEn.upper(), 'city': city, 'country': 'KR',
            'arp': {'lat': arp[1], 'lon': arp[0]}, 'elevationFt': round(float(el.group(1)) * 3.28084, 1) if el else None,
            'magVar': (-1 if var and var.group(2) == 'W' else 1) * float(var.group(1)) if var else None,
            'geoidUndulationFt': round(float(geoid.group(1)) * 3.28084) if geoid else None,
            'transitionAltitudeFt': int(ta.group(1).replace(' ', '')) if ta else 14000, 'aipEffective': '20261028', 'runways': rws,
            'localNavaids': list({n['id']: n for n in nav}.values())}

AP = {}
WP = {}
KNOWN = set(json.load(open('/home/claude/kr/out/nav_kr.json'))['fixes'])
for icao, iata, ja, en, city in [('RKSI', 'ICN', '仁川国際空港', 'Incheon International', '韓国 仁川広域市'), ('RKSS', 'GMP', '金浦国際空港', 'Gimpo International', '韓国 ソウル特別市')]:
    a = airport(icao, iata, ja, en, city)
    a['sids'], w1 = procs(f'/home/claude/kr/KR_{icao}_SID.pdf', 'SID')
    a['stars'], w2 = procs(f'/home/claude/kr/KR_{icao}_STAR.pdf', 'STAR')
    a['approaches'], w3 = approaches(f'/home/claude/kr/KR_{icao}_IAC.pdf', KNOWN | {n['id'] for n in a['localNavaids']})
    a['sidTransitions'], a['starTransitions'] = [], []
    for w in (w1, w2, w3):
        for k, (la, lo) in w.items(): WP.setdefault(k, {'lat': la, 'lon': lo, 'type': 'waypoint', 'src': [f'{icao} chart'], 'country': 'KR'})
    AP[icao] = a
    print(icao, 'rwy', [r['id'] for r in a['runways']], 'nav', [n['id'] for n in a['localNavaids']], 'SID', len(a['sids']), 'STAR', len(a['stars']), 'APP', len(a['approaches']))
json.dump({'meta': {'title': '韓国 空港データ（RKSI・RKSS）', 'source': 'AIP Korea AD2（eAIP 2026-10-28 AIRAC、SID/STAR/IAC の PDF）', 'country': 'KR'},
           'index': {'byIata': {a['iata']: k for k, a in AP.items()}}, 'airports': AP, 'waypoints': WP}, open('/home/claude/kr/out/airport_kr.json', 'w'), ensure_ascii=False)
print('waypoints', len(WP))
