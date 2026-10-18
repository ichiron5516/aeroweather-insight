# ブルネイ（AIP Brunei Darussalam、PDF）→ nav_db・airport_db・airspace_db
#   ENR 4.1（BRU・BR）、ENR 3.1（航空路。マレーシアと重なる路線は dbLoader がつなぐ）、AD 2 WBSB（基本情報のみ。SID・STAR は設定なし＝レーダー誘導）
#   空域：Brunei TMA はマレーシア AIP（ENR 2.1）にも載っているのでそちらを使い、ここでは Brunei CTR を 17NM の円で近似して入れる
import re, json, subprocess, math, sys
sys.path.insert(0, '/home/claude/kr/tools')
from kr_lib import circle, dest
CC = 'BN'; P = '/home/claude/bn/pdf/'
def text(f): return subprocess.run(['pdftotext', '-layout', P + f, '-'], capture_output=True, text=True).stdout
def dms(s):
    m = re.match(r'(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])', s)
    v = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600
    return -v if m.group(4) in 'SW' else v
def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
fixes = {
    'BRU': {'lat': dms('045229N'), 'lon': dms('1145308E'), 'type': 'navaid', 'name': 'BRUNEI', 'navaidType': 'DVOR/DME', 'freq': '112.0MHZ', 'country': CC},
    'BR': {'lat': dms('045357N'), 'lon': dms('1145405E'), 'type': 'navaid', 'name': 'BRUNEI', 'navaidType': 'NDB', 'freq': '318KHZ', 'country': CC},
}
# ---- ENR 3.1：左の列（名前・座標）だけ読む ----
airways, cur, name = {}, None, None
for L in text('ENR-3-.1new.pdf').split('\n'):
    left = L[:32]
    m = re.match(r'^\s+([A-Z]\d{3})\s*$', left)
    if m and not re.search(r'\d{6}N', L): cur = []; airways[m.group(1)] = cur; name = None; continue
    if cur is None: continue
    nm = re.search(r'\(([A-Z]{2,3})\)', left) or re.match(r'^\s+([A-Z]{3,5})\b(?!\s*\d)', left)
    if nm and not re.search(r'\d{6}N', left): name = nm.group(1); continue
    co = re.search(r'(\d{6}N)\s+(\d{7}E)', left)
    if co and name:
        if name not in fixes: fixes[name] = {'lat': round(dms(co.group(1)), 6), 'lon': round(dms(co.group(2)), 6), 'type': 'waypoint', 'country': CC}
        if not cur or cur[-1] != name: cur.append(name)
        name = None
fixes.pop('TMA', None)
# 航空路はマレーシア AIP（ENR 3.x）に同じものが全部載っているのでそちらを使う（ここでは地点だけ）
json.dump({'meta': {'title': 'ブルネイ 航法データ', 'sources': ['AIP Brunei ENR 3.1', 'ENR 4.1'], 'aipEffective': '2026-06-20'}, 'fixes': fixes, 'airways': {}},
          open('/home/claude/bn/out/nav_bn.json', 'w'), ensure_ascii=False)
print('nav', len(fixes))
# ---- WBSB ----
thr = {'03': (dms('045548.29N'), dms('1145511.53E')), '21': (dms('045729.94N'), dms('1145612.62E'))}
def brg(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    y = math.sin(lo2 - lo1) * math.cos(la2); x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360, 2)
rw = []
for a, b, elev in (('03', '21', 6 * 3.28084), ('21', '03', 22 * 3.28084)):
    rw.append({'id': a, 'trueBearing': brg(thr[a], thr[b]), 'lengthM': 3658, 'widthM': 45, 'threshold': {'lat': round(thr[a][0], 6), 'lon': round(thr[a][1], 6)},
               'thresholdElevFt': round(elev, 1), 'declared': {'TORA': 3658, 'TODA': 3993 if a == '03' else 3962, 'ASDA': 3658, 'LDA': 3658},
               'reciprocal': b, 'departureEnd': {'lat': round(thr[b][0], 6), 'lon': round(thr[b][1], 6)}})
appr = [{'name': n, 'type': 'APPROACH', 'kind': k, 'rnav': False, 'runways': [r], 'chartPages': [], 'fixes': {}, 'routes': [], 'missed': [], 'missedApproach': '',
         'warnings': ['図のみ（データ表がないため経路は表示しません）。AIP のチャートを参照']}
        for n, k, r in (('ILS/DME RWY 03', 'ILS', '03'), ('DVOR/DME RWY 03', 'VOR', '03'), ('NDB RWY 03', 'NDB', '03'), ('ILS/DME RWY 21', 'ILS', '21'), ('DVOR/DME RWY 21', 'VOR', '21'))]
ap = {'icao': 'WBSB', 'iata': 'BWN', 'nameJa': 'ブルネイ国際空港', 'nameEn': 'Brunei International', 'nameAip': 'BRUNEI/International', 'city': 'バンダルスリブガワン', 'country': CC,
      'arp': {'lat': round(dms('045639N'), 6), 'lon': round(dms('1145542E'), 6)}, 'elevationFt': 73, 'magVar': 0.4, 'transitionAltitudeFt': 11000, 'aipEffective': '20260616',
      'runways': rw, 'localNavaids': [{'type': 'DVOR/DME', 'id': 'BRU', 'freq': '112.0MHz', 'lat': fixes['BRU']['lat'], 'lon': fixes['BRU']['lon']},
                                       {'type': 'NDB', 'id': 'BR', 'freq': '318kHz', 'lat': fixes['BR']['lat'], 'lon': fixes['BR']['lon']}],
      'sids': [], 'stars': [], 'approaches': appr, 'sidTransitions': [], 'starTransitions': [],
      'notes': ['SID・STAR は設定なし（AD 2.22：レーダー誘導で最終進入へ）']}
json.dump({'meta': {'title': 'ブルネイ 空港データ（WBSB）', 'source': 'AIP Brunei Darussalam AD 2 WBSB', 'country': CC, 'missingFixes': []},
           'index': {'byIata': {'BWN': 'WBSB'}}, 'airports': {'WBSB': ap}, 'waypoints': {}}, open('/home/claude/bn/out/airport_bn.json', 'w'), ensure_ascii=False)
# ---- 空域：Brunei CTR ----
arp = [ap['arp']['lon'], ap['arp']['lat']]
items = [{'id': 'WB-CTR-BRUNEI', 'cat': 'cta', 'layer': 'cta', 'kind': 'ctr', 'country': CC, 'name': 'Brunei 管制圏（CTR）', 'lower': 0, 'upper': 3500,
          'parts': [{'ring': circle(arp, 17), 'lower': 0, 'upper': 3500, 'note': 'ARP 中心 17NM の円で近似（南西側の 20NM 部分は省略）'}],
          'src': 'AIP Brunei ENR 2.1', 'info': {'種別': '管制圏', 'Class': 'C', '注意': '17NM の円で近似'}}]
json.dump({'meta': {'title': 'ブルネイ 空域データ', 'source': 'AIP Brunei ENR 2.1', 'notes': ['Brunei TMA はマレーシア AIP のデータを使う']}, 'items': items},
          open('/home/claude/bn/out/airspace_bn.json', 'w'), ensure_ascii=False)
print('ok')
