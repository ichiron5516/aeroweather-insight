# インド（AIP India eAIP-v2、PDF）→ 航法・空港データ（2026-10-18）
#   出典：https://aim-india.aai.aero/eaip-v2/（AMDT 01/2018。ページの日付は 2017〜2018 年）
#   入力：tools/intl/_downloads/in/ の PDF（アプリの開発用の窓口 /aipdownload で保存したもの）
#     EC-ENR-4.1-en-GB.pdf（無線施設）・EC-ENR-4.4-en-GB.pdf（地点）・EC-ENR-3.1{航空路}-en-GB.pdf（航空路ごとに1つ）
#     EC-AD-2.1{ICAO}-en-GB.pdf（空港ごと。AD 2.1/2.2/2.12/2.13/2.17）
#   出力：public/data/intl/in/nav_db.json・airport_db.json
#   使い方：python in_build.py <PDF のフォルダ> <出力フォルダ>
#   pdftotext -layout の文字の並び（列の位置がそろう）を正規表現で読む
import json, math, os, re, subprocess, sys

SRC, OUT = sys.argv[1], sys.argv[2]
CC = 'IN'
R_NM = 3440.065
def txt(f): return subprocess.run(['pdftotext', '-layout', os.path.join(SRC, f), '-'], capture_output=True, text=True).stdout
def dms(s):
    m = re.match(r'(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])', s)
    v = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600
    return round(-v if m[4] in 'SW' else v, 6)
def nm(a, b):
    r = math.pi / 180; h = math.sin((b['lat'] - a['lat']) * r / 2) ** 2 + math.cos(a['lat'] * r) * math.cos(b['lat'] * r) * math.sin((b['lon'] - a['lon']) * r / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
LAT, LON = r'(\d{6}(?:\.\d+)?[NS])', r'(\d{7}(?:\.\d+)?[EW])'
fixes, report = {}, []
def put(key, f):
    """同じ識別符号で離れた場所の地点（インドには同じ符号の NDB などがある）は「ID~2」のように別に持つ"""
    if key not in fixes: fixes[key] = f; return key
    if nm(fixes[key], f) < 3: return key
    for n in range(2, 9):
        k = f'{key}~{n}'
        if k not in fixes: fixes[k] = {**f, 'ident': key}; return k
        if nm(fixes[k], f) < 3: return k
    return key

# ---------- ENR 4.1 無線施設 ----------
NAVT = re.compile(r'(DVOR/DME|VOR/DME|DVOR|VOR|TACAN|NDB|DME)')
lines = txt('EC-ENR-4.1-en-GB.pdf').splitlines()
navs = 0
for i, l in enumerate(lines):
    m = re.match(r'^\s*(.+?)\s+([A-Z]{1,3})\s+(\d[\d.]*\s*(?:MHZ|KHZ)|\d+[XY])\s+.*?' + LAT, l)
    if not m: continue
    lon = None; cont = ''
    for l2 in lines[i + 1:i + 3]:
        mm = re.search(LON, l2)
        if mm: lon = dms(mm[1]); cont = l2[:max(0, l2.find('(') if '(' in l2[:40] else 30)].strip() if l2[:30].strip() else ''; break
    if lon is None: continue
    # 列の幅で折り返された長い名前（「THIRUVANANTHAP」＋「URAM」）は、空白なしでつなぐ
    first = m[1].strip()
    name = (first + ('' if cont and len(first.split()[-1]) >= 10 and not NAVT.match(cont) else ' ') + cont).strip()
    ty = NAVT.findall(name.replace('VOR/ DME', 'VOR/DME').replace('VOR/ ', 'VOR/'))
    nt = 'VOR/DME' if re.search(r'VOR/\s*DME', name) else (ty[0] if ty else '')
    clean = re.sub(r'\b(DVOR/DME|VOR/\s*DME|VOR/|DVOR|VOR|TACAN|NDB|DME)\b', '', name).strip(' /')
    fq = re.match(r'([\d.]+)\s*(MHZ|KHZ)', m[3])
    put(m[2], {'lat': dms(m[4]), 'lon': lon, 'type': 'navaid', 'name': clean.upper() or m[2], 'navaidType': nt,
               'freq': (f"{float(fq[1]):g}{'kHz' if fq[2] == 'KHZ' else 'MHz'}" if fq else m[3].strip()), 'country': CC})
    navs += 1
report.append(f'ENR 4.1 無線施設 {navs}')

# ---------- ENR 4.4 地点 ----------
pts = 0
for l in txt('EC-ENR-4.4-en-GB.pdf').splitlines():
    m = re.match(r'^\s*([A-Z]{5})\s+' + LAT + r'\s+' + LON, l)
    if m: put(m[1], {'lat': dms(m[2]), 'lon': dms(m[3]), 'type': 'waypoint', 'country': CC}); pts += 1
report.append(f'ENR 4.4 地点 {pts}')

# ---------- ENR 3.1 航空路（1つの PDF に1路線） ----------
airways, warn = {}, []
for f in sorted(os.listdir(SRC)):
    m = re.match(r'EC-ENR-3\.1([A-Z0-9]+)-en-GB\.pdf$', f)
    if not m: continue
    d = m[1]
    seq, cur = [], None
    for l in txt(f).splitlines():
        # 地点の記号：▲ ✦ ◆ ●（義務通報点）、△ ✧ ◇ ○（任意通報点）
        mk = re.match(r'^\s*([▲△✦✧◆◇●○■□])\s*([A-Za-z0-9].*?)?(?:\s{2,}|$)', l)
        if mk and cur and cur['co'] is None:
            # 記号が2つ重ねて描かれている（「✧ MUMBAI VOR」の次の行が「▲ DVOR/DME (BBB)」）：座標が出る前なら同じ地点の続き
            cur['comp'] = cur['comp'] or mk[1] in '▲✦◆●■'
            mk = None
        if mk:
            if cur: seq.append(cur)
            cur = {'name': (mk[2] or '').strip(), 'comp': mk[1] in '▲✦◆●■', 'id': None, 'co': None}
            continue
        if cur is None: continue
        head = l[:45]
        # 記号だけの行の次の行が名前（長い名前は2行に折り返す：「THIRUVANANTHAPURA」「M VOR」）
        if cur['co'] is None and not re.search(LAT, head):
            nm_ = re.split(r'\s{2,}', head.strip())[0] if head.strip() else ''
            if nm_ and not re.search(r'VOR|NDB|DME|TACAN', nm_) or (nm_ and not cur['name']):
                if not cur['name']: cur['name'] = nm_
        if cur['co'] is not None and not re.search(LAT, head): continue      # 座標の後の行（距離・高度・備考）は見ない
        # 無線施設の識別符号：「DVOR/DME (BBB)」のように種類の後の括弧だけ（備考の「…VOR (TVM) R151…」などは使わない）
        mi = re.search(r'(?:VOR|NDB|DME|TACAN)[^()]{0,12}\(([A-Z]{2,3})\)', head) if re.search(r'VOR|NDB|DME|TACAN', cur['name'] + ' ' + head) else None
        if mi and not cur['id']: cur['id'] = mi[1]
        mc = re.search(LAT + r'\s+' + LON, head)
        if mc and not cur['co']: cur['co'] = (dms(mc[1]), dms(mc[2]))
    if cur: seq.append(cur)
    pts_, comp = [], []
    for p in seq:
        if not p['co']: warn.append(f'{d}：{p["name"]} の座標がない'); continue
        ident = p['id'] or (re.match(r'^([A-Z]{5})\b', p['name']) or re.match(r'^([A-Z0-9]{2,5})', p['name']))[1]
        f_ = {'lat': p['co'][0], 'lon': p['co'][1], 'type': 'navaid' if p['id'] else 'waypoint', 'country': CC}
        if p['id']: f_.update({'name': re.sub(r'\s*(VOR|NDB|DVOR|DME|TACAN).*$', '', p['name']).upper()})
        key = put(ident, f_)
        if not pts_ or pts_[-1] != key: pts_.append(key)
        if p['comp']: comp.append(key)
    if len(pts_) < 2: warn.append(f'{d}：地点が {len(pts_)}'); continue
    for k in comp: fixes[k]['reporting'] = 'COMPULSORY'
    seg = [{'nm': round(nm(fixes[a], fixes[b]), 1)} for a, b in zip(pts_, pts_[1:])]
    airways[d] = {'type': 'RNAV' if re.match(r'^U?[LMNPQTYZ]', d) else 'CONVENTIONAL', 'points': pts_, 'segments': seg, 'country': CC}
report.append(f'ENR 3.1 航空路 {len(airways)}')
for d, a in airways.items():
    for i, s in enumerate(a['segments']):
        if s['nm'] > 500: warn.append(f'{d}：{a["points"][i]}–{a["points"][i + 1]} {s["nm"]}NM')

# ---------- AD 2 空港 ----------
airports = {}
for f in sorted(os.listdir(SRC)):
    m = re.match(r'EC-AD-2\.1([A-Z]{4})-en-GB\.pdf$', f)
    if not m: continue
    icao, t = m[1], txt(f)
    sec = {}
    cur = None
    for l in t.splitlines():
        h = re.match(r'^\s*' + icao + r'\s+AD\s*2\.(\d+)\b', l)
        if h: cur = int(h[1]); continue
        if cur is not None: sec.setdefault(cur, []).append(l)
    s1 = '\n'.join(sec.get(1, []))
    nmM = re.search(icao + r'\s+[-–—]+\s+([A-Z][^\n]+)', t)       # 「VAAH - AHMEDABAD / INTL」（ページの頭の「AD 2 VAAH -1」は除く）
    name = re.sub(r'\s{2,}.*$', '', nmM[1]).strip() if nmM else icao
    s2 = '\n'.join(sec.get(2, []))
    a = {'icao': icao, 'iata': '', 'nameEn': name, 'nameAip': name.upper(), 'nameJa': name, 'city': 'インド', 'country': CC, 'aipEffective': '',
         'runways': [], 'localNavaids': [], 'transitionAltitudeFt': None, 'sids': [], 'stars': [], 'sidTransitions': [], 'starTransitions': [], 'approaches': []}
    mc = re.search(LAT + r'\s*,?\s*' + LON, s2)
    if mc and not re.match(r'0+N', mc[1]): a['arp'] = {'lat': dms(mc[1]), 'lon': dms(mc[2])}   # 「000000N 0000000E」（未記入）は使わない
    me = re.search(r'elevation and reference temperature\s+([\d.,]+)\s*(FT|M)', s2, re.I) or re.search(r'Aerodrome elevation.*?([\d.,]+)\s*(FT|M)\b', s2, re.I | re.S)
    if me: v = float(me[1].replace(',', '')); a['elevationFt'] = round(v * 3.28084, 1) if me[2].upper() == 'M' else v
    mv = re.search(r'Magnetic variation.*?([\d.]+)\s*(?:DEG|°)\s*([EW])', s2, re.I | re.S)
    if mv: a['magVar'] = round((-1 if mv[2] == 'W' else 1) * float(mv[1]), 2)
    for l in sec.get(17, []):
        mt = re.search(r'[Tt]ransition altitude.*?(\d[\d,]*)\s*FT', l)
        if mt: a['transitionAltitudeFt'] = int(mt[1].replace(',', ''))
    L12 = sec.get(12, [])
    for i, l in enumerate(L12):
        mr = re.match(r'^\s*(?:RWY\s*)?(\d{2}[LRC]?)\s+([\d.]+)\s*(?:DEG|°)\s+(\d[\d ,]*)\s*[xX×]\s*(\d+)\s*M', l)
        if not mr: continue
        blob = ' '.join(L12[i:i + 4])
        la, lo = re.search(LAT, blob), re.search(LON, blob)
        if not (la and lo): continue
        rid = mr[1]
        if any(r['id'] == rid for r in a['runways']): continue
        a['runways'].append({'id': rid, 'trueBearing': float(mr[2]), 'lengthM': int(re.sub(r'\D', '', mr[3])), 'widthM': int(mr[4]),
                             'threshold': {'lat': dms(la[1]), 'lon': dms(lo[1])}, 'thresholdElevFt': None})
    thr = [float(x) for x in re.findall(r'THR:\s*([\d.]+)\s*FT', '\n'.join(L12))]
    for r, e in zip(a['runways'], thr): r['thresholdElevFt'] = e
    dec = {}
    for l in sec.get(13, []):
        md = re.match(r'^\s*(\d{2}[LRC]?)\s+(\d{3,5})\s+(\d{3,5})\s+(\d{3,5})\s+(\d{3,5})\b', l)
        if md and md[1] not in dec: dec[md[1]] = {'TORA': int(md[2]), 'TODA': int(md[3]), 'ASDA': int(md[4]), 'LDA': int(md[5])}
    for r in a['runways']:
        r['declared'] = dec.get(r['id'], {})
        rec = '%02d' % ((int(r['id'][:2]) + 17) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C'}.get(r['id'][2:], '')
        o = next((x for x in a['runways'] if x['id'] == rec), None)
        if o: r['reciprocal'] = rec; r['departureEnd'] = o['threshold']
    if 'arp' not in a and a['runways']:
        ps = [r['threshold'] for r in a['runways']]; a['arp'] = {'lat': round(sum(p['lat'] for p in ps) / len(ps), 6), 'lon': round(sum(p['lon'] for p in ps) / len(ps), 6)}
    if 'arp' not in a: warn.append(f'{icao}：位置が読めない'); continue
    if not a['runways']: warn.append(f'{icao}：滑走路が読めない')
    airports[icao] = a
report.append(f'AD 2 空港 {len(airports)}')

os.makedirs(OUT, exist_ok=True)
meta = {'title': 'インド 航法データ', 'sources': ['AIP India eAIP-v2 ENR 3.1', 'ENR 4.1', 'ENR 4.4'], 'aipEffective': 'AMDT 01/2018（ページの日付 2017〜2018 年）'}
json.dump({'meta': meta, 'fixes': fixes, 'airways': airways}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
json.dump({'meta': {'title': 'インド 空港データ', 'source': 'AIP India eAIP-v2 AD 2（PDF）。滑走路・位置・標高・磁差のみ（SID・STAR なし）', 'country': CC},
           'airports': airports, 'waypoints': {}, 'index': {'byIata': {}}}, open(os.path.join(OUT, 'airport_db.json'), 'w'), ensure_ascii=False)
print('\n'.join(report)); print('注意', len(warn)); print('\n'.join(warn[:60]))
