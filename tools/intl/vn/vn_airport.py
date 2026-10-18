# ベトナム VVNB・VVTS：AD2 HTML の基本情報 ＋ SID・STAR・進入の PDF（文字のある表「Tabular description」「Procedure coding」）
#   高さはメートル（FL 以外）、距離は km、速度は km/h で書かれているので、フィート・NM・kt に直す（raw には元の表記を残す）
#   表の高度・速度は列の位置で見分ける。上下2段に分かれた高度（-2150 / +1500）は、その間の行の値として読む
import re, sys, json, glob, os, subprocess, math
from collections import defaultdict
sys.path.insert(0, '/home/claude/vn/tools'); sys.path.insert(0, '/home/claude/kr/tools')
import vn_common
from ad_generic import airport
ROOT = '/home/claude/vn'
CC = 'VN'
NAV = json.load(open(f'{ROOT}/out/nav_vn.json'))['fixes']
TITLES = json.load(open(f'{ROOT}/titles.json'))
M2FT, KM2NM, KMH2KT = 3.28084, 1 / 1.852, 1 / 1.852
PTS = 'IF TF CF DF CA VA VI VM FA FM RF HM HF HA'.split()
ROW = re.compile(r'^\s*(?:(\d{3})\s+)?(' + '|'.join(PTS) + r')\s+([A-Z][A-Z0-9]{1,4}|–|-)?\s+(Y|N|–|-)\s+(.*)$')
SIG = re.compile(r'(?<![\w.])([+\-@])\s?(FL\s?\d{2,3}|\d{2,5})(?![\w.°/])')
LONE = re.compile(r'^\s*(?:[+\-@]\s?(?:FL\s?\d{2,3}|\d{2,5})\s*)+$')
COORD = re.compile(r"^\s*([A-Z][A-Z0-9]{1,4})\s+(\d{2})°(\d{2})'(\d{2}(?:\.\d+)?)\"([NS])\s+(\d{3})°(\d{2})'(\d{2}(?:\.\d+)?)\"([EW])")

def pdftext(f): return subprocess.run(['pdftotext', '-layout', f, '-'], capture_output=True, text=True).stdout

WP = {}
def collect_wp(t, ap):
    for L in t.split('\n'):
        m = COORD.match(L)
        if not m: continue
        g = m.groups()
        la = (int(g[1]) + int(g[2]) / 60 + float(g[3]) / 3600) * (-1 if g[4] == 'S' else 1)
        lo = (int(g[5]) + int(g[6]) / 60 + float(g[7]) / 3600) * (-1 if g[8] == 'W' else 1)
        if g[0] not in NAV: WP.setdefault(g[0], {'lat': round(la, 6), 'lon': round(lo, 6), 'type': 'waypoint', 'src': [f'{ap} chart'], 'country': CC})

def alt_of(toks):
    if not toks: return None
    o = {'raw': ' '.join(s + v + ('' if v.startswith('FL') else 'm') for s, v in toks)}
    for s, v in toks:
        ft = int(v[2:].strip()) * 100 if v.startswith('FL') else round(int(v) * M2FT / 10) * 10
        if s == '+': o['min'] = ft
        elif s == '-': o['max'] = ft
        else: o['min'] = o['max'] = ft
    return o

def parse_rows(text):
    """表の行を読む。戻り値：[(行番号, leg, 見出し)]"""
    lines = text.split('\n')
    altX = spdX = None
    rows, lone, heads = [], [], []
    head, proc = '', ''
    for i, L in enumerate(lines):
        if re.search(r'Altitude|ALTITUDE', L):
            altX = (L.find('Altitude') if 'Altitude' in L else L.find('ALTITUDE')) + 4
        if re.search(r'\blimit\b|\bLIMIT\b|Speed|SPEED', L) and not re.search(r'Altitude|ALTITUDE', L) or re.search(r'SPEED', L):
            k = max(L.find('limit'), L.find('LIMIT'), L.find('Speed'), L.find('SPEED')); spdX = k + 2 if k >= 0 else spdX
        m = ROW.match(L)
        if m:
            ser, pt, fix, fo, rest = m.groups()
            leg = {'pt': pt}
            if fix and fix not in '–-': leg['fix'] = fix
            if fo == 'Y': leg['flyover'] = True
            cm = re.search(r'(\d{3})\s*\((\d{3}\.\d)\)', rest)
            if cm: leg['courseMag'] = float(cm.group(1)); leg['courseTrue'] = float(cm.group(2))
            toks = [(mm.start() + L.find(rest), mm.group(1), mm.group(2).replace(' ', '')) for mm in SIG.finditer(rest)]
            rows.append({'i': i, 'leg': leg, 'toks': toks, 'altX': altX, 'spdX': spdX, 'head': head, 'line': L})
            continue
        if LONE.match(L):
            lone.append((i, [(mm.start(), mm.group(1), mm.group(2).replace(' ', '')) for mm in SIG.finditer(L)])); continue
        s = L.strip()
        if s and not re.search(r'Serial|number|Descriptor|Identifier|TEMINATOR|TERMINATOR|NAME\)|\(WPT|KM/H|\(km|^Speed|^limit|^SPEED|^LIMIT|TRACK|FIX ID|RCMD|^\(km/h\)|^\(m\)', s) and len(s) < 70 and re.match(r'^[A-Z(]', s):
            if re.match(r'^[A-Z]{2,5}\s+\d[A-Z]\s+(DEPARTURE|ARRIVAL)$|^[A-Z]{2,5}\s+TRANSITION', s): proc, head = s, s
            else: head = f'{proc}|{s}' if proc else s
    # 上下に分かれた高度を、近い行（同じ距離なら高度が空いている行）に付ける
    for li, tk in lone:
        cand = sorted(rows, key=lambda r: abs(r['i'] - li))[:2]
        cand = [r for r in cand if abs(r['i'] - li) <= 2]
        if not cand: continue
        if len(cand) == 2 and abs(cand[0]['i'] - li) == abs(cand[1]['i'] - li):
            near = lambda r: any(abs(x - (r['altX'] or 0)) < abs(x - (r['spdX'] or 999)) for x, _, _ in r['toks'])
            cand.sort(key=lambda r: near(r))
        cand[0]['toks'] += tk
    out = []
    for r in rows:
        alt, spd = [], None
        for x, s, v in sorted(r['toks']):
            if r['altX'] is not None and r['spdX'] is not None and abs(x - r['spdX']) < abs(x - r['altX']) and not v.startswith('FL'):
                spd = (s, v)
            else: alt.append((s, v))
        # 上段（-）を先に
        alt.sort(key=lambda t: {'-': 0, '@': 1, '+': 2}[t[0]])
        leg = r['leg']
        a = alt_of(alt)
        if a: leg['alt'] = a
        if spd and 80 <= int(spd[1]) <= 700:
            kt = round(int(spd[1]) * KMH2KT)
            leg['speed'] = {'raw': f'{spd[0]}{spd[1]}km/h', **({'min': kt} if spd[0] == '+' else {'max': kt})}
        rw = re.search(r'\b(RW\d{2}[LRC]?)\b', r['line'])
        if 'fix' not in leg:
            prev = r['i'] - 1
            pl = text.split('\n')[prev] if prev >= 0 else ''
            m2 = re.search(r'\b(RW\d{2}[LRC]?)\b', pl)
            if m2 and leg['pt'] in ('TF', 'CF'): leg['fix'] = m2.group(1); leg['mapt'] = True
        elif leg['fix'].startswith('RW'): leg['mapt'] = True
        if re.search(r'\(MAPT\)', r['line']): leg['mapt'] = True
        out.append((r['i'], leg, r['head']))
    return out

def pos(k):
    p = NAV.get(k) or WP.get(k)
    return (p['lat'], p['lon']) if p else None
def dist(p, q):
    la1, lo1, la2, lo2 = map(math.radians, (*p, *q))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
def finish(legs, nav='RNAV1'):
    out, prev = [], None
    for l in legs:
        l = dict(l); l.pop('mapt', None)
        if 'fix' not in l: continue
        if out and out[-1]['fix'] == l['fix'] and l['pt'] == 'IF': continue
        p = pos(l['fix'])
        if p and prev: l['distNM'] = round(dist(prev, p), 1)
        prev = p or prev
        l['seq'] = len(out) + 1; l['navSpec'] = nav
        out.append(l)
    return out

AP = {}
INFO = {'VVNB': ('VV-AD-2.VVNB', 'HAN', 'ハノイ・ノイバイ国際空港', 'Ha Noi Noi Bai International', 'ハノイ'),
        'VVTS': ('VV-AD-2.VVTS', 'SGN', 'ホーチミン・タンソンニャット国際空港', 'Ho Chi Minh Tan Son Nhat International', 'ホーチミン')}
for icao, (key, iata, ja, en, city) in INFO.items():
    a = airport(key.replace('VV-', ''), icao, iata, ja, en, city, CC, '20261029')
    seen_rw = set(); a['runways'] = [r for r in a['runways'] if not (r['id'] in seen_rw or seen_rw.add(r['id']))]
    rwset = [r['id'] for r in a['runways']]
    if not a.get('arp'):     # AD 2.2 の ARP を読めなかったときは、滑走路の端の平均で代用
        th = [r['threshold'] for r in a['runways'] if r.get('threshold')]
        a['arp'] = {'lat': round(sum(t['lat'] for t in th) / len(th), 6), 'lon': round(sum(t['lon'] for t in th) / len(th), 6)}
    for r in a['runways']:
        if r.get('threshold'): WP.setdefault(f'RW{r["id"]}', {**r['threshold'], 'type': 'runway', 'src': [f'{icao} AD 2.12'], 'country': CC})
    def rws_of(s):
        out = []
        for m in re.finditer(r'(\d{2})([LRC](?:/[LRC])*)?', s):
            for side in (m.group(2) or '').split('/') or ['']:
                r = m.group(1) + side
                if r in rwset and r not in out: out.append(r)
            if not m.group(2) and m.group(1) in rwset and m.group(1) not in out: out.append(m.group(1))
        return out
    a['sids'], a['stars'], a['approaches'], a['sidTransitions'], a['starTransitions'] = [], [], [], [], []
    files = [f for f in TITLES if f.startswith(icao + '_')]
    texts = {f: pdftext(f'{ROOT}/pdf/{f}') for f in files}
    for f, t in texts.items(): collect_wp(t, icao)
    # AD 2 の HTML にある地点の表（番号・名前・緯度・経度）
    for r in vn_common.soup(key.replace('VV-', '')).find_all('tr'):
        c = [vn_common.txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        for j in range(len(c) - 1):
            if re.match(r'^[A-Z][A-Z0-9]{1,4}$', c[j]) and re.match(r'^\d{6}(\.\d+)?[NS]\s*\d{7}(\.\d+)?[EW]$', c[j + 1]):
                co = vn_common.coords(c[j + 1])
                if co and c[j] not in NAV: WP.setdefault(c[j], {'lat': round(co[0][1], 6), 'lon': round(co[0][0], 6), 'type': 'waypoint', 'src': [f'{icao} AD 2'], 'country': CC})
    # ---- SID・STAR ----
    for kind in ('SID', 'STAR'):
        groups = defaultdict(list)          # 図ごと（タイトルの先頭）に、表のページをつなげる
        for f in files:
            ti = TITLES[f]
            if f'({kind})' not in ti or 'RNAV' not in ti: continue
            if not re.search(r'Tabular|coding', ti): continue
            groups[re.split(r'\s*\((?:Tabular|Procedure coding|APCH)', ti)[0]].append(f)
        for gt, fs in groups.items():
            m = re.search(r'RWY\s*([0-9LRC/ ,]+)', gt)
            grw = rws_of(m.group(1)) if m else []
            procs, trans, cur, part = [], [], None, None
            for f in fs:
                for i, leg, head in parse_rows(texts[f]):
                    if part is None or part['head'] != head:
                        pr, _, sub = head.partition('|')
                        hm = re.match(r'^([A-Z]{2,5})\s+(\d[A-Z])\s+(DEPARTURE|ARRIVAL)$', pr)
                        tm = re.match(r'^([A-Z]{2,5})\s+TRANSITION', pr)
                        im = re.match(r'^INITIAL CLIMB RWY\s*(\d{2}[LRC]?)', sub)
                        if hm and (cur is None or cur['hdr'] != pr): cur = {'name': f'{hm.group(1)} {hm.group(2)}', 'hdr': pr, 'init': {}, 'common': []}; procs.append(cur)
                        if tm:
                            tr = {'name': tm.group(1), 'legs': [], 'after': cur}; trans.append(tr); part = {'head': head, 'to': tr['legs']}
                        elif cur is None: continue
                        elif im: cur['init'][im.group(1)] = []; part = {'head': head, 'to': cur['init'][im.group(1)]}
                        else: part = {'head': head, 'to': cur['common']}
                    part['to'].append(leg)
            lst = a['sids'] if kind == 'SID' else a['stars']
            for p in procs:
                if kind == 'SID' and p['init']:
                    rl = {rw: finish(L + p['common']) for rw, L in p['init'].items()}
                else: rl = {'/'.join(grw) or 'ALL': finish(p['common'])}
                rl = {k: v for k, v in rl.items() if v}
                if not rl: continue
                lst.append({'name': p['name'], 'type': kind, 'rnav': True, 'chartPages': [], 'runwayLegs': rl, 'runways': list(p['init']) if kind == 'SID' and p['init'] else grw})
            for tr in trans:
                legs = finish(tr['legs'])
                if len(legs) < 2: continue
                if kind == 'SID':
                    par = [p['name'] for p in procs if any(L and L[-1]['fix'] == legs[0]['fix'] for L in ({k: finish(v + p['common']) for k, v in p['init'].items()} or {'x': finish(p['common'])}).values())]
                    if not par and tr['after']: par = [tr['after']['name']]
                    a['sidTransitions'].append({'name': f'{tr["name"]} TRANSITION', 'type': 'SID_TRANSITION', 'parents': par, 'runwayLegs': {'ALL': legs}, 'runways': []})
                else:
                    for p in procs:
                        cm = finish(p['common'])
                        if cm and cm[0]['fix'] == legs[-1]['fix']:
                            full = finish(tr['legs'] + p['common'])
                            lst.append({'name': f'{p["name"]} ({tr["name"]})', 'type': 'STAR', 'rnav': True, 'chartPages': [], 'runwayLegs': {'/'.join(grw) or 'ALL': full}, 'runways': grw, 'transitionOf': p['name']})
    # ---- 進入 ----
    for f in files:
        ti = TITLES[f]
        if 'Approach Chart' not in ti or not re.search(r'Tabular|coding', ti): continue
        nm = re.search(r'ICAO:\s*((?:ILS|RNP|VOR|LOC)[^()]*?RWY\s*\d{2}[LRC]?)', ti)
        if not nm: continue
        name = re.sub(r'\s+', ' ', nm.group(1)).strip()
        rw = re.search(r'RWY\s*(\d{2}[LRC]?)', name).group(1)
        kindA = 'ILS' if name.startswith('ILS') else 'RNP' if name.startswith('RNP') else 'VOR'
        rows = parse_rows(texts[f])
        segs, curS, lastHead = [], None, None
        for i, leg, head in rows:
            if leg['pt'] == 'IF' or head != lastHead or curS is None:
                curS = {'head': head, 'legs': []}; segs.append(curS)
            lastHead = head
            curS['legs'].append(leg)
        missed, final, feeders = [], None, []
        for s in segs:
            if re.search(r'MISSED', s['head']) and not re.search(r'AND MISSED|FROM', s['head']): missed += [l['fix'] for l in s['legs'] if 'fix' in l]; continue
            if any(l.get('mapt') for l in s['legs']): final = s
            else: feeders.append(s)
        routes, roles = [], defaultdict(list)
        if final:
            mi = next(k for k, l in enumerate(final['legs']) if l.get('mapt'))
            core = [l['fix'] for l in final['legs'][:mi + 1] if 'fix' in l]
            missed = [l['fix'] for l in final['legs'][mi + 1:] if 'fix' in l] + missed
            for s in feeders:
                fx = [l['fix'] for l in s['legs'] if 'fix' in l]
                routes.append(fx + [x for x in core if x not in fx])
            if not routes: routes = [core]
            roles['MAPt'] = [core[-1]]
            if len(core) >= 2: roles['FAF'] = [core[-2]]
            roles['IF'] = [core[0]]
        else:
            for s in feeders:
                fx = [l['fix'] for l in s['legs'] if 'fix' in l]
                if fx: routes.append(fx)
        roles['IAF'] = list(dict.fromkeys(r[0] for r in routes if r))
        missed = [x for k, x in enumerate(missed) if k == 0 or missed[k - 1] != x]
        if missed: roles['MAHF'] = [missed[-1]]
        a['approaches'].append({'name': name, 'type': 'APPROACH', 'kind': kindA, 'rnav': kindA == 'RNP', 'runways': [rw], 'chartPages': [],
                                'fixes': {k: v for k, v in roles.items() if v}, 'routes': routes, 'missed': missed, 'missedApproach': '',
                                'warnings': [] if final else ['最終進入のコーディングがないため、FAF までを経路として表示']})
    # 図だけの進入（VOR・ILS Y など）は名前だけ
    have = {p['name'] for p in a['approaches']}
    for f in files:
        ti = TITLES[f]
        nm = re.search(r'ICAO:\s*((?:ILS|RNP|VOR|LOC)[^()]*?RWY\s*\d{2}[LRC]?)', ti)
        if 'Approach Chart' in ti and nm and not re.search(r'Tabular|coding', ti):
            name = re.sub(r'\s+', ' ', nm.group(1)).strip()
            if name in have: continue
            have.add(name)
            rw = re.search(r'RWY\s*(\d{2}[LRC]?)', name).group(1)
            a['approaches'].append({'name': name, 'type': 'APPROACH', 'kind': 'ILS' if name.startswith('ILS') else 'RNP' if name.startswith('RNP') else 'VOR',
                                    'rnav': name.startswith('RNP'), 'runways': [rw], 'chartPages': [], 'fixes': {}, 'routes': [], 'missed': [], 'missedApproach': '',
                                    'warnings': ['図のみ（データ表がないため経路は表示しません）。AIP のチャートを参照']})
    for p in a['approaches']:
        p['routes'] = [[x for k, x in enumerate(r) if k == 0 or r[k - 1] != x] for r in p['routes']]
        if not p['routes'] and not p['missed']: p['warnings'] = ['図のみ（データ表がないため経路は表示しません）。AIP のチャートを参照']
    # SID の移行経路：同じ名前で中身が違うものは「（起点）」を付けて分ける。同じ中身は親をまとめる
    merged = {}
    for t in a['sidTransitions']:
        fx = tuple(l['fix'] for l in t['runwayLegs']['ALL'])
        k = (t['name'], fx)
        if k in merged: merged[k]['parents'] = list(dict.fromkeys(merged[k]['parents'] + t['parents']))
        else: merged[k] = t
    cnt = defaultdict(int)
    for (n, fx) in merged: cnt[n] += 1
    for (n, fx), t in merged.items():
        if cnt[n] > 1: t['name'] = f'{n} ({fx[0]})'
    a['sidTransitions'] = list(merged.values())
    a['approaches'].sort(key=lambda p: (p['runways'][0], p['name']))
    for k in ('sids', 'stars'):
        seen, out = set(), []
        for p in a[k]:
            if p['name'] in seen:
                q = next(x for x in out if x['name'] == p['name']); q['runwayLegs'].update(p['runwayLegs']); q['runways'] = list(dict.fromkeys(q['runways'] + p['runways'])); continue
            seen.add(p['name']); out.append(p)
        a[k] = sorted(out, key=lambda p: p['name'])
    AP[icao] = a

used = {l['fix'] for a in AP.values() for p in a['sids'] + a['stars'] + a['sidTransitions'] for L in p['runwayLegs'].values() for l in L} | \
       {x for a in AP.values() for p in a['approaches'] for r in p['routes'] for x in r} | {x for a in AP.values() for p in a['approaches'] for x in p['missed']}
miss = sorted(x for x in used if not pos(x))
WP = {k: v for k, v in WP.items() if k in used}
json.dump({'meta': {'title': 'ベトナム 空港データ（VVNB・VVTS）', 'source': 'AIP Viet Nam AD2（eAIP 2026-10-29 AIRAC）。高さ m→ft、距離 km→NM、速度 km/h→kt に換算', 'country': CC, 'missingFixes': miss},
           'index': {'byIata': {a['iata']: k for k, a in AP.items()}}, 'airports': AP, 'waypoints': WP}, open(f'{ROOT}/out/airport_vn.json', 'w'), ensure_ascii=False)
for k, a in AP.items():
    print(k, 'rwy', [r['id'] for r in a['runways']], 'SID', len(a['sids']), 'SIDTR', len(a['sidTransitions']), 'STAR', len(a['stars']), 'APP', len(a['approaches']))
print('WP', len(WP), 'missing', miss)
