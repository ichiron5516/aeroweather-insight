# インドネシア（AIP Indonesia ENR 3.1・3.2・2.1 の PDF）→ nav_db.json・airspace_db.json・airport_db.json
import json, math, re
from parse import parse as parse_routes
import asp
r31, f31, u31 = parse_routes('enr31.pdf', 'CONVENTIONAL')
r32, f32, u32 = parse_routes('enr32.pdf', 'RNAV')
def nm(a, b):
    r = math.pi / 180; p1, p2 = a['lat'] * r, b['lat'] * r; dl = (b['lon'] - a['lon']) * r
    return 2 * 3440.065 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))
F = dict(f31); notes = []
ren32 = {}
for k, v in f32.items():
    if k in F and nm(F[k], v) > 2:
        ren32[k] = f'{k}~R'; F[ren32[k]] = {**v, 'ident': k}
        notes.append(f'{k}：ENR 3.1 と ENR 3.2 で座標が違う（{nm(F[k], v):.0f}NM）。ENR 3.2 の方を「{k}~R」で持つ')
    else: F.setdefault(k, v)
A = {}
def add(routes, rtype, ren={}):
    for d, r in routes.items():
        pts = [ren.get(p, p) for p in r['points']]
        # 航空路の表がページで切れて、名前のない続きが別の区間を始めている所（距離が 1,000NM を超える跳び）で分ける
        parts, cur = [], [pts[0]] if pts else []
        for p in pts[1:]:
            if nm(F[cur[-1]], F[p]) > 1000: parts.append(cur); cur = [p]; notes.append(f'{d}：{cur and p} の前で表が途切れている（名前のない続き）ため、その後は航空路に含めない')
            else: cur.append(p)
        parts.append(cur)
        main = parts[0]
        if len(main) < 2: continue
        key = d if d not in A else f'{d}~R'
        A[key] = {'type': rtype, 'points': main, 'segments': [{'nm': round(nm(F[main[i - 1]], F[main[i]]), 1)} for i in range(1, len(main))], 'country': 'ID'}
        if key != d: A[key]['designator'] = d
add(r31, 'CONVENTIONAL'); add(r32, 'RNAV', ren32)
used = {p for a in A.values() for p in a['points']} | set(F)
nav = {'meta': {'title': 'インドネシア 航法データ', 'sources': ['AIP Indonesia ENR 3.1 Conventional Navigation Routes（AIRAC AIP AMDT 180, 01 OCT 26）',
        'ENR 3.2 Area Navigation Routes（AIRAC AIP AMDT 178, 06 AUG 26）'], 'aipEffective': '2026-10-01', 'notes': notes}, 'fixes': F, 'airways': A}
json.dump(nav, open('out/nav_db.json', 'w'), ensure_ascii=False)
# 空域
items = []
KIND = lambda n: 'uta' if ' UTA' in n else 'tma' if ' TMA' in n else 'sector' if 'SECTOR' in n else 'cta'
for a in asp.parse(F):
    name = asp.clean_name(a['names'])
    if not name or 'FIR' in name or len(a['pts']) < 3: continue
    ring = [[round(lo, 6), round(la, 6)] for la, lo in a['pts']]
    if ring[0] != ring[-1]: ring.append(ring[0])
    k = KIND(name)
    info = {'種別': {'uta': '高高度管制区（UTA）', 'tma': 'ターミナル管制区（TMA）', 'sector': 'FIR 内のセクター（下層）', 'cta': '管制区（CTA）'}[k],
            'Class': a['cls'], '上限/下限（AIP の表記）': ' / '.join(a['limitsText'])}
    if a['notes']: info['注意'] = '、'.join(a['notes'])
    items.append({'id': 'ID-' + k.upper() + '-' + re.sub(r'[^A-Z0-9]', '', name), 'cat': 'cta', 'layer': 'cta', 'kind': 'tma' if k in ('tma', 'cta') else k,
                  'country': 'ID', 'name': name.title().replace('Tma', 'TMA').replace('Uta', 'UTA'), 'lower': a['lower'], 'upper': a['upper'],
                  'parts': [{'ring': ring, 'lower': a['lower'], 'upper': a['upper']}], 'src': 'AIP Indonesia ENR 2.1', 'info': info})
json.dump({'meta': {'title': 'インドネシア 空域データ', 'source': 'AIP Indonesia ENR 2.1（AIRAC AIP AMDT 180, 01 OCT 26）',
           'notes': ['FIR は既存の FIR 表示を使う', '国境・海岸線に沿う区間は直線で近似', '円弧は中心・半径から 5 度ごとの点で近似。中心が ARP の所は空港の VOR/DME で代用（Jayapura・Biak）']},
           'items': items}, open('out/airspace_db.json', 'w'), ensure_ascii=False)
json.dump({'meta': {'title': 'インドネシア 空港データ', 'source': '空港は不要との指示のため収録なし', 'country': 'ID', 'missingFixes': []},
           'index': {'byIata': {}}, 'airports': {}, 'waypoints': {}}, open('out/airport_db.json', 'w'), ensure_ascii=False)
print(len(F), 'fixes', len(A), 'airways', len(items), 'airspaces'); print('\n'.join(notes))
