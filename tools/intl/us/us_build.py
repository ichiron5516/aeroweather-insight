# アメリカ（アラスカ・ハワイ・グアム、太平洋の洋上航空路）→ 航法データ（2026-10-18）
#   米国の AIP（https://www.faa.gov/air_traffic/publications/atpubs/aip_html/）の ENR 3 には航空路の一覧が無く、
#   「Part 95」と FAA の NASR（28 日ごとのデータ）を見るように書いてある。そこで NASR の CSV を使う
#     ・AWY_BASE.csv / AWY_SEG_ALT.csv：航空路（V・J・T・Q・アラスカの色付き航空路 A/B/G/R ほか）と地点の並び
#     ・FIX_BASE.csv：地点の座標、NAV_BASE.csv：無線施設の座標・周波数
#     ・ATS.txt：太平洋（PA）・バハマ（BF）などの ATS 航空路（座標つき）。PA だけ使う
#   入手：https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/ の
#     extra/<日付>_AWY_CSV.zip・_FIX_CSV.zip・_NAV_CSV.zip と <日付>/ATS.zip
#   選ぶ航空路：アラスカ（AWY_LOCATION=A）・ハワイ（H）の全部と、太平洋の ATS 航空路（PA）、
#     地点がアラスカ・ハワイ・グアム・北マリアナ（州コード AK・HI・GU・MP）か、
#     アンカレジ・ホノルル・グアム・オークランド洋上の管制区（ZAN・ZHN・ZUA・ZAK）にある航空路
#   ・航空路に切れ目（AWY_SEG_GAP_FLAG=Y）があるときは「名前~2」などで別に持つ（表示は名前）
#   ・国境の点（U.S. CANADIAN BORDER など）は座標が無いので飛ばす
#   出力：nav_db.json（空港は METAR・TAF の白丸のまま）
#   使い方：python us_build.py <CSV と ATS.txt を広げたフォルダ> <出力フォルダ>
import csv, json, math, os, re, sys
from collections import defaultdict

SRC, OUT = sys.argv[1], sys.argv[2]
rd = lambda n: list(csv.DictReader(open(os.path.join(SRC, n), encoding='utf-8', errors='replace')))
R_NM = 3440.065
def nm(a, b):
    r = math.pi / 180; h = math.sin((b['lat'] - a['lat']) * r / 2) ** 2 + math.cos(a['lat'] * r) * math.cos(b['lat'] * r) * math.sin((b['lon'] - a['lon']) * r / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
STATES, ARTCC = {'AK', 'HI', 'GU', 'MP'}, {'ZAN', 'ZHN', 'ZUA', 'ZAK'}

# ---------- 地点・無線施設 ----------
fixes_by = defaultdict(list)
for f in rd('FIX_BASE.csv'):
    fixes_by[f['FIX_ID']].append({'lat': float(f['LAT_DECIMAL']), 'lon': float(f['LONG_DECIMAL']), 'region': f['ICAO_REGION_CODE'], 'state': f['STATE_CODE'], 'cc': f['COUNTRY_CODE']})
navs_by = defaultdict(list)
for n in rd('NAV_BASE.csv'):
    if not n['LAT_DECIMAL']: continue
    fq = n['FREQ'].strip()
    navs_by[n['NAV_ID']].append({'lat': float(n['LAT_DECIMAL']), 'lon': float(n['LONG_DECIMAL']), 'type': n['NAV_TYPE'], 'name': n['NAME'].upper(),
                                'state': n['STATE_CODE'], 'cc': n['COUNTRY_CODE'],
                                'freq': (f"{float(fq):g}{'kHz' if 'NDB' in n['NAV_TYPE'] else 'MHz'}" if re.match(r'^[\d.]+$', fq) else '')})

def pick(cands, row):
    if not cands: return None
    for k, v in (('state', row['STATE_CODE']), ('cc', row['COUNTRY_CODE'])):
        c = [x for x in cands if v and x.get(k) == v]
        if c: cands = c
    if 'region' in cands[0] and row['ICAO_REGION_CODE']:
        c = [x for x in cands if x['region'] == row['ICAO_REGION_CODE']]
        if c: cands = c
    return cands[0]

F = {}
def put(ident, f):
    """同じ名前で離れた地点（米国内で同じ識別符号の NDB と VOR など）は「名前~2」"""
    if ident not in F: F[ident] = f; return ident
    if nm(F[ident], f) < 3:
        if f['type'] == 'navaid' and F[ident]['type'] != 'navaid': F[ident] = {**F[ident], **{k: v for k, v in f.items() if v}}
        return ident
    for i in range(2, 20):
        k = f'{ident}~{i}'
        if k not in F: F[k] = {**f, 'ident': ident}; return k
        if nm(F[k], f) < 3: return k

def point(row):
    p, t = row['FROM_POINT'].strip(), row['FROM_PT_TYPE'].strip()
    if not p or 'BORDER' in p: return None
    if t in ('RP', 'WP', 'CN', ''):
        x = pick(fixes_by.get(p, []), row)
        if x: return put(p, {'lat': round(x['lat'], 6), 'lon': round(x['lon'], 6), 'type': 'waypoint', 'country': 'US'})
    cands = navs_by.get(p, [])
    if t: cands = [c for c in cands if c['type'] == t] or cands
    x = pick(cands, row)
    if x: return put(p, {'lat': round(x['lat'], 6), 'lon': round(x['lon'], 6), 'type': 'navaid', 'name': x['name'], 'navaidType': x['type'], 'freq': x['freq'], 'country': 'US'})
    x = pick(fixes_by.get(p, []), row)
    if x: return put(p, {'lat': round(x['lat'], 6), 'lon': round(x['lon'], 6), 'type': 'waypoint', 'country': 'US'})
    return None

# ---------- NASR の航空路 ----------
segs = defaultdict(list)
for s in rd('AWY_SEG_ALT.csv'): segs[(s['AWY_LOCATION'], s['AWY_ID'])].append(s)
A, missing, src_dist = {}, [], {}
def add(d, pts, typ, dists=None):
    pts = [p for i, p in enumerate(pts) if p and (i == 0 or p != pts[i - 1])]
    if len(pts) < 2: return
    k, n = d, 1
    while k in A: n += 1; k = f'{d}~{n}'
    A[k] = {'type': typ, 'points': pts, 'segments': [{'nm': round(nm(F[a], F[b]), 1)} for a, b in zip(pts, pts[1:])], 'country': 'US'}
    if k != d: A[k]['designator'] = d
    if dists: src_dist[k] = dists

for b in rd('AWY_BASE.csv'):
    rows = sorted(segs.get((b['AWY_LOCATION'], b['AWY_ID']), []), key=lambda r: int(r['POINT_SEQ']))
    if not rows or b['AWY_DESIGNATION'] in ('AT', 'BF', 'PR', 'SP', 'PA'): continue   # PA は ATS.txt から（座標つき）
    if not (b['AWY_LOCATION'] in ('A', 'H') or any(r['STATE_CODE'] in STATES or r['ARTCC'] in ARTCC for r in rows)): continue
    d = b['AWY_ID']
    typ = 'RNAV' if re.match(r'^[QTY]', d) else 'CONVENTIONAL'
    cur, dist = [], []
    for r in rows:
        k = point(r)
        if k is None and 'BORDER' not in r['FROM_POINT'] and r['FROM_POINT'].strip(): missing.append(f"{d} {r['FROM_POINT']} {r['FROM_PT_TYPE']}")
        if k: cur.append(k); dist.append(float(r['MAG_COURSE_DIST']) if r['MAG_COURSE_DIST'] else None)
        if r['AWY_SEG_GAP_FLAG'] == 'Y' or k is None:   # 切れ目・座標の無い点で分ける
            add(d, cur, typ, dist); cur, dist = [], []
    add(d, cur, typ, dist)

# ---------- 太平洋の ATS 航空路（ATS.txt、PA）----------
def dmsx(s):
    m = re.match(r'(\d+)-(\d+)-([\d.]+)([NSEW])', s)
    v = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600
    return round(-v if m[4] in 'SW' else v, 6)
pa = defaultdict(list)
for l in open(os.path.join(SRC, 'ATS.txt'), encoding='latin1'):
    if not l.startswith('ATS2PA'): continue
    m = re.match(r'ATS2PA(\S+)\s+(?:[A-Z]\s+)?(\d+)(\S.*?)\s{2,}(\S+)', l)
    if not m: continue
    d, seq, name, typ = m[1], int(m[2]), m[3].strip(), m[4]
    ll = re.search(r'(\d{2}-\d{2}-[\d.]+[NS])\s+(\d{3}-\d{2}-[\d.]+[EW])', l)
    if not ll or 'BORDER' in name: continue
    pa[d].append((seq, name, typ, dmsx(ll[1]), dmsx(ll[2])))
for d, rows in pa.items():
    pts = []
    for _, name, typ, lat, lon in sorted(rows):
        ident = name.split()[0] if typ in ('WAY-PT', 'REP-PT', 'CN') else None
        if ident is None:   # 無線施設は名前（例 HONOLULU）から NAV_BASE の識別符号を探す
            c = [x for k, v in navs_by.items() for x in [dict(v_, id=k) for v_ in v] if x['name'] == name.upper() and abs(x['lat'] - lat) < 0.05 and abs(x['lon'] - lon) < 0.05]
            ident = c[0]['id'] if c else re.sub(r'[^A-Z]', '', name.upper())[:5]
            f = {'lat': lat, 'lon': lon, 'type': 'navaid', 'name': name.upper(), 'navaidType': c[0]['type'] if c else typ, 'freq': c[0]['freq'] if c else '', 'country': 'US'}
        else:
            f = {'lat': lat, 'lon': lon, 'type': 'waypoint', 'country': 'US'}
        pts.append(put(ident, f))
    add(d, pts, 'CONVENTIONAL')

# ---------- グアム：Andersen の TACAN（FAA AIP AD 2 のページ）。NASR にあればそちら ----------
if 'UAM' not in F: put('UAM', {'lat': 13.591219, 'lon': 144.946578, 'type': 'navaid', 'name': 'ANDERSEN', 'navaidType': 'TACAN', 'freq': '', 'country': 'US'})

# 使う地点だけ残す（UAM は残す）
used = {p for a in A.values() for p in a['points']} | {'UAM'}
F = {k: {kk: vv for kk, vv in v.items() if vv != ''} for k, v in F.items() if k in used}
# 確かめ：NASR の区間距離（MAG_COURSE_DIST）と、座標から出した距離
ok = bad = 0; bads = []
for k, ds in src_dist.items():
    for s, x in zip(A[k]['segments'], ds):
        if x is None: continue
        if abs(s['nm'] - x) <= max(1.5, 0.03 * x): ok += 1
        else: bad += 1; bads.append(f"{k} {s['nm']} vs {x}")
os.makedirs(OUT, exist_ok=True)
eff = rd('FIX_BASE.csv')[0]['EFF_DATE']
json.dump({'meta': {'title': 'アメリカ（アラスカ・ハワイ・グアム・太平洋）航法データ', 'sources': ['FAA NASR 28 Day Subscription（AWY・FIX・NAV の CSV、ATS.txt）', 'FAA AIP ENR 3（航空路は Part 95・NASR を参照）', 'FAA AIP AD 2.0 Guam（UAM TACAN）'],
                    'aipEffective': f'NASR {eff}'}, 'fixes': F, 'airways': A}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
print(f'地点 {len(F)}（無線施設 {sum(1 for f in F.values() if f["type"] == "navaid")}）・航空路 {len(A)}（PA {len(pa)}）')
print(f'確かめ：区間 {ok + bad} のうち {ok} が NASR の距離と一致'); print('合わない', bads[:20]); print('座標が無い点', missing[:20], len(missing))
