# ラオス（AIP Lao PDR）ENR 3.2・ENR 2.1 の紙面（写真）から読み取った値で、航法データと空域データを作る
import json, math
def dms(s):
    # "15 25 00N" / "16 33 43.7N" / "104 46 00.0E"
    p = s.split(); h = p[-1][-1]; p[-1] = p[-1][:-1]
    v = float(p[0]) + float(p[1]) / 60 + float(p[2]) / 3600
    return round(-v if h in 'SW' else v, 6)
F = {}
def fx(id, lat, lon, typ='waypoint', comp=True, **kw):
    F[id] = {'lat': dms(lat), 'lon': dms(lon), 'type': typ, 'country': 'LA', **({'reporting': 'COMPULSORY'} if comp else {}), **kw}
fx('BUTRA', '15 25 00N', '105 36 00E'); fx('PAPRA', '15 46 00N', '107 11 00E')
fx('SAV', '16 33 43.7N', '104 46 00.0E', 'navaid', name='SAVANNAKHET', navaidType='DVOR/DME')
fx('VILAO', '17 22 00N', '106 05 00E')
fx('LPB', '19 54 39.5N', '102 10 18.9E', 'navaid', name='LUANG PRABANG', navaidType='DVOR/DME')
fx('NOHET', '19 25 36N', '103 36 41E'); fx('NALAO', '19 19 46N', '103 54 18E')
fx('PONUK', '20 18 54N', '100 23 18E'); fx('SAGAG', '21 11 30N', '101 37 24E')
fx('UBL', '15 14 43N', '104 51 57E', 'navaid', name='UBON', navaidType='DVOR/DME')
fx('PAK', '15 11 48.3N', '105 44 17.0E', 'navaid', name='PAKSE', navaidType='DVOR/DME')
fx('BOMPA', '14 20 00N', '107 24 00E')
fx('AKSAG', '20 49 00N', '100 28 00E'); fx('LADON', '21 06 13N', '102 58 01E')
fx('VTN', '18 00 37.3N', '102 32 25.7E', 'navaid', name='VIENTIANE', navaidType='DVOR/DME')
fx('LEKOB', '14 07 48N', '105 31 12E'); fx('YAKUA', '17 44 15N', '101 30 52E')
fx('LAPON', '20 45 00N', '104 28 30E'); fx('NOBOK', '20 37 20N', '102 38 26E')
fx('ANBOK', '18 37 00N', '101 13 00E'); fx('TOMIP', '19 11 00N', '101 16 00E')
fx('ISGAK', '16 31 45N', '105 26 15E'); fx('LEBAL', '16 30 11N', '105 56 42E'); fx('TORED', '16 27 49N', '106 40 32E')
fx('ALPHA', '18 32 36N', '103 19 42E'); fx('IDOTA', '18 41 36N', '105 08 22E'); fx('LAVOS', '20 26 29N', '104 23 37E')
fx('LAVAN', '14 05 49N', '105 41 36E'); fx('SEKON', '14 52 04N', '106 22 34E', comp=False)
fx('KADIN', '18 27 00N', '104 00 00E'); fx('TANGO', '17 25 30N', '104 54 18E')
fx('ABMSAV', '16 51 21N', '105 14 38E', name='ABM/SAV (Abeam SAV)'); fx('DELTA', '16 00 00N', '105 45 00E')
F['NOHET'].pop('reporting')   # A206 では任意通報点（△）、R474 では義務（▲）→ 任意として持つ
# 航空路：地点の並びと AIP の距離（NM）、上限/下限、管制周波数
R = {
 'A1':   (['BUTRA', 'PAPRA'], [94], 'FL460', 'FL200', '128.30'),
 'A202': (['SAV', 'VILAO'], [90], 'FL460', 'FL260', '128.30'),
 'A206': (['LPB', 'NOHET', 'NALAO'], [87, 17], 'FL460', 'FL260', '124.10'),
 'A581': (['PONUK', 'SAGAG'], [87], 'FL460', 'FL200', '124.10'),
 'B202': (['UBL', 'PAK', 'BOMPA'], [50, 110], 'FL460', 'FL200', '128.30'),
 'B214': (['AKSAG', 'LADON'], [141], 'FL460', 'FL200', '128.30'),
 'B218': (['SAGAG', 'LPB', 'VTN'], [83, 115], 'FL460', 'FL200', '124.10'),
 'B329': (['LEKOB', 'PAK', 'VILAO'], [65, 131], 'FL460', 'FL200', '128.30'),
 'B346': (['YAKUA', 'LPB'], [135], 'FL460', 'FL200', '124.10'),
 'B465': (['AKSAG', 'LPB', 'LAPON'], [110, 140], 'FL460', 'FL200', '124.10'),
 'B468': (['LPB', 'NOBOK', 'LADON'], [51, 34], 'FL460', 'FL200', '124.10'),
 'R207': (['ANBOK', 'VTN'], [84], 'FL460', 'FL200', '124.10'),
 'R215': (['TOMIP', 'LPB'], [66], 'FL460', 'FL200', '124.10'),
 'R328': (['SAV', 'ISGAK', 'LEBAL', 'TORED'], [39, 30, 42], 'FL460', 'FL200', '128.30'),
 'R335': (['VTN', 'ALPHA', 'IDOTA'], [55, 104], 'FL460', 'FL200', '128.30'),
 'R474': (['VTN', 'NOHET', 'LAVOS'], [105, 75], 'FL460', 'FL200', '124.10'),
 'R575': (['LAVAN', 'SEKON', 'PAPRA'], [61, 71], 'FL460', 'FL200', '128.30'),
 'W76':  (['VTN', 'ALPHA', 'KADIN', 'TANGO', 'ABMSAV', 'DELTA', 'PAK'], [55, 39, 80, 39, 59, 48], 'FL460', 'FL200', '128.30'),
}
def nm(a, b):
    r = math.pi / 180; p1, p2 = a['lat'] * r, b['lat'] * r; dl = (b['lon'] - a['lon']) * r
    return 2 * 3440.065 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))
A, bad = {}, []
for d, (pts, dist, up, lo, fq) in R.items():
    segs = []
    for i in range(1, len(pts)):
        c = nm(F[pts[i - 1]], F[pts[i]]); segs.append({'nm': round(c, 1), 'aipNm': dist[i - 1], 'upper': up, 'lower': lo})
        if abs(c - dist[i - 1]) > 3: bad.append(f'{d} {pts[i-1]}-{pts[i]} 座標 {c:.1f}NM / AIP {dist[i-1]}NM')
    A[d] = {'type': 'CONVENTIONAL', 'points': pts, 'segments': segs, 'country': 'LA', 'atc': f'Vientiane ACC {fq} MHz'}
print('距離の照合:', '全区間 3NM 以内' if not bad else bad)
nav = {'meta': {'title': 'ラオス 航法データ', 'sources': ['AIP Lao PDR ENR 3.2（AIRAC AIP AMDT 12/15・13/15、ENR 3.2-5/7 は 31 MAR 2016）'],
        'note': 'ユーザーから受け取った紙面の写真から読み取り。UBL は Bangkok FIR の地点（B202 の起点）', 'aipEffective': '2016-03-31'},
       'fixes': F, 'airways': A}
json.dump(nav, open('nav_db.json', 'w'), ensure_ascii=False, indent=1)
# Vientiane TMA：VTN を中心に半径 50NM の円（FIR 境界での切り取り・B218/W76 沿いの回廊は省略）
c = F['VTN']; ring = []
for k in range(73):
    t = 2 * math.pi * k / 72; dlat = 50 / 60 * math.cos(t); dlon = 50 / 60 * math.sin(t) / math.cos(c['lat'] * math.pi / 180)
    ring.append([round(c['lon'] + dlon, 6), round(c['lat'] + dlat, 6)])
asp = {'meta': {'title': 'ラオス 空域データ', 'source': 'AIP Lao PDR ENR 2.1（23 AUG 2012）', 'notes': ['FIR（Vientiane FIR）は既存の FIR 表示を使う']},
       'items': [{'id': 'VL-TMA-VIENTIANE', 'cat': 'cta', 'layer': 'cta', 'kind': 'tma', 'country': 'LA', 'name': 'Vientiane TMA',
                  'lower': 4000, 'upper': 19500, 'parts': [{'ring': ring, 'lower': 4000, 'upper': 19500}], 'src': 'AIP Lao PDR ENR 2.1',
                  'info': {'種別': 'ターミナル管制区（TMA）', '管制': 'Vientiane Approach 119.70 MHz', '上限/下限': 'FL195 / 4,000ft AMSL',
                           '注意': 'VTN VOR 中心 50NM の円で近似。FIR 境界での切り取り、B218 沿い（KAASI まで幅 20NM）・W76 沿い（LPHA まで幅 10NM）の回廊は省略'}}]}
json.dump(asp, open('airspace_db.json', 'w'), ensure_ascii=False)
json.dump({'meta': {'title': 'ラオス 空港データ', 'source': '空港の資料（AD 2）は未受領のため収録なし', 'country': 'LA', 'missingFixes': []},
           'index': {'byIata': {}}, 'airports': {}, 'waypoints': {}}, open('airport_db.json', 'w'), ensure_ascii=False)
