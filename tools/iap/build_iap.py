# raw/*.json（extract_iap.py の出力）を空港DBの approaches にまとめる
import json, glob, re, math, sys
db = json.load(open('airport_db.json')); nav = json.load(open('nav_db.json'))
OVERRIDE_TITLE = {('RJCC', 99): 'VOR RWY19L'}
def nm(a, b):
    R = 3440.065; r = math.pi / 180
    p1, p2, dl = a['lat'] * r, b['lat'] * r, (b['lon'] - a['lon']) * r
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
def brg(a, b):
    r = math.pi / 180; p1, p2, dl = a['lat'] * r, b['lat'] * r, (b['lon'] - a['lon']) * r
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360
def norm_title(t):
    t = re.sub(r'\s+', ' ', t)
    for a, b in [('LO C', 'LOC'), ('C AT', 'CAT'), ('R W Y', 'RWY'), ('( ', '('), (' )', ')')]: t = t.replace(a, b)
    t = re.sub(r'\s*\(\s*', ' (', t); t = re.sub(r'RWY(\d\d[LRC]?) \(', r'RWY\1 (', t)
    t = re.sub(r'\(\s*CAT\s*', '(CAT ', t); t = re.sub(r'\s*&\s*(CAT\s*)?', ' & ', t)
    t = re.sub(r'(LNAV/VNAV only|LPV only|AR)\)', r'\1)', t)
    return t.strip()
report = []
START = r'(Climb|Climbing|Turn|Proceed|Continue|Fly|Track|Straight|Intercept|At|Contact|Hold|Then|When|After|Maintain|Via|Join|Direct)\b'
OKW = {'to', 'at', 'and', 'hold', 'turn', 'left', 'via', 'on', 'or', 'of', 'the', 'then', 'in', 'for', 'with', 'from', 'not', 'by', 'a', 'an', 'when', 'climb', 'fly', 'join', 'arc', 'dme', 'ft', 'nm', 'kt', 'is', 'be', 'if', 'as', 'into', 'over', 'cross', 'turn', 'than', 'only', 'more', 'less'}
def clean_missed(t, drop=()):
    if not t: return None
    out = []
    for s in re.split(r'(?<=[A-Za-z˚°)])\.(?:\s+|$)', t):
        m = re.search(START, s)
        if not m: continue
        s = s[m.start():]
        s = re.sub(r'\s+(de|i|M|\.)(?=\s)', '', ' ' + s + ' ').strip()
        s = re.sub(r'\s*\(FAF\)\s*', ' ', s)
        s = ' '.join(w for w in s.split() if not (re.fullmatch(r'[a-z]{1,4}', w) and w not in OKW)
                     and not (re.fullmatch(r'[A-Z]\d[A-Z]\d\d|[A-Z]{2}\d{3}', w) and w in drop)
                     and not re.fullmatch(r'[B-Z]|\(MAPt\)', w))
        s = re.sub(r'\bat(\d)', r'at \1', s)
        if len(s) > 6: out.append(s + '.')
        if s.startswith('Contact'): break
    return ' '.join(out) or None
tot = 0
for f in sorted(glob.glob('raw/*.json')):
    icao = f[-9:-5]; a = db['airports'][icao]; WP = db['waypoints']
    raw = json.load(open(f))
    merged = {}
    for c in raw:
        t = norm_title(OVERRIDE_TITLE.get((icao, c['page']), c['title']))
        m = merged.setdefault(t, {'pages': [], 'roles': [], 'coords': {}, 'faf': None, 'missed': None})
        m['pages'].append(c['page']); m['roles'] += c['roles']; m['coords'].update(c['coords'])
        m['faf'] = m['faf'] or c['fafAltFt']; m['missed'] = m['missed'] or c['missed']
    out = []
    rw_by = {r['id']: r for r in a['runways']}
    for t, m in merged.items():
        drop = {fx for fx, r in m['roles'] if r == 'MAPt' and fx}
        m['missed'] = clean_missed(m['missed'], drop)
        rws = re.findall(r'RWY ?(\d\d[LRC]?)', t)
        rws = [r for r in rws if r in rw_by]
        kind = t.split()[0]
        def where(fx):
            if fx in m['coords']: return {**m['coords'][fx], 'src': 'chart'}
            if fx in WP: return {'lat': WP[fx]['lat'], 'lon': WP[fx]['lon'], 'src': 'airportDb'}
            v = nav['fixes'].get(fx)
            if isinstance(v, list): v = min(v, key=lambda x: nm(x, a['arp']))
            return {'lat': v['lat'], 'lon': v['lon'], 'src': 'navDb'} if v else None
        roles = {'IAF': [], 'IF': [], 'FAF': [], 'MAPt': [], 'MAHF': []}
        for fx, r in m['roles']:
            if not fx: continue
            rr = ['IAF', 'IF'] if r in ('IAF/IF', 'IF/IAF') else ['FAF'] if r == 'FAP' else [r]
            for x in rr:
                if fx not in roles[x]: roles[x].append(fx)
        # MAHF が見つからなければ、進入復行の文の「… to XXXXX and hold」から
        if not roles['MAHF'] and m['missed']:
            h = re.findall(r'\b([A-Z]{3}|[A-Z]{5})(?: (?:VOR/DME|VORTAC|VOR|TACAN|NDB))? and hold', m['missed']) \
                or re.findall(r'(?:direct(?: to)?|proceed to|to) ([A-Z]{5}|[A-Z]{3})\b(?! R\d)', m['missed'])
            h = [x for x in h if where(x)]
            if h: roles['MAHF'].append(h[-1])
        # 位置が分からない地点は外し、その旨を記録
        unknown = sorted({fx for v in roles.values() for fx in v if not where(fx)})
        for k in roles: roles[k] = [fx for fx in roles[k] if where(fx)]
        # IF と FAF が同じ地点名で重複していたら FAF を優先
        roles['IF'] = [x for x in roles['IF'] if x not in roles['FAF']]
        roles['IAF'] = [x for x in roles['IAF'] if x not in roles['FAF']]
        thr = rw_by[rws[0]]['threshold'] if len(rws) == 1 and rw_by[rws[0]].get('threshold') else None
        # 経路：IAF → IF → FAF → (MAPt) → THR。IAF ごとに1本
        core = roles['IF'][:1] + roles['FAF'][:1] + [x for x in roles['MAPt'][:1] if x not in roles['FAF']]
        starts = [x for x in roles['IAF'] if x not in core] or [None]
        routes = [[x for x in [s] + core if x] for s in starts]
        routes = [r for r in routes if r]
        missed = roles['MAHF'][:1]
        warn = []
        if thr and roles['FAF']:
            fp = where(roles['FAF'][0]); d = nm(fp, thr)
            if not (2 <= d <= 15): warn.append(f'FAF {roles["FAF"][0]} が THR から {d:.1f}NM')
            if kind in ('ILS', 'GLS', 'LOC') and len(rws) == 1:
                fin = (rw_by[rws[0]]['trueBearing'] + 180) % 360; b = brg(thr, fp)
                if min(abs(b - fin), 360 - abs(b - fin)) > 6: warn.append(f'FAF が最終進入コースから {min(abs(b-fin),360-abs(b-fin)):.0f}° ずれ')
        for s in starts:
            if s and nm(where(s), a['arp']) > 60: warn.append(f'IAF {s} が空港から {nm(where(s), a["arp"]):.0f}NM')
        if not roles['FAF']: warn.append('FAF（名前付き）なし：最終進入は概略')
        for x in unknown: warn.append(f'{x} の座標不明（除外）')
        # チャートで座標が分かった新しい地点は空港DBの地点に加える
        for fx, cp in m['coords'].items():
            if fx not in WP and fx not in nav['fixes']:
                WP[fx] = {'lat': cp['lat'], 'lon': cp['lon'], 'type': 'waypoint', 'src': [f'{icao} IAC p.{m["pages"][0]}']}
        out.append({
            'name': t, 'type': 'APPROACH', 'kind': kind, 'rnav': kind in ('RNP', 'RNAV', 'GLS'),
            'runways': rws or ['ALL'], 'chartPages': m['pages'],
            'fixes': {k: v for k, v in roles.items() if v}, 'fafAltFt': m['faf'],
            'missedApproach': m['missed'], 'routes': routes, 'missed': missed, 'warnings': warn,
        })
        if warn: report.append(f'{icao} {t}: ' + ' / '.join(warn))
    a['approaches'] = out; tot += len(out)
    print(icao, len(out))
db['meta']['notes'] = [n for n in db['meta']['notes'] if not n.startswith('approaches')] + [
    'approaches は AD2.24 の進入方式チャート（IAC）から抽出。routes は IAF→IF→FAF→(MAPt) の地点列（THR へは表示側で接続）、missed は進入復行の待機点（MAHF）。地点間は直線で結ぶ概略（RF・DME アーク等の曲線は再現しない）']
db['meta']['title'] = 'AeroWeather 空港データベース（滑走路・SID・STAR・進入方式）'
json.dump(db, open('airport_db.out.json', 'w'), ensure_ascii=False, separators=(',', ':'))
open('iap_report.txt', 'w').write('\n'.join(report))
print('total', tot, 'warnings', len(report))
