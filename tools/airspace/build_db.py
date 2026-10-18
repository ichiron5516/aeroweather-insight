import json, math
from lib import dist
parts = {}
for f in ['acc', 'cta', 'r51', 'r52', 'r52b', 'r53']:
    for o in json.load(open(f + '.json')): parts[o['id']] = o
items = list(parts.values())
# 区分（ボタンに対応）
for o in items:
    c = o['cat']
    o['layer'] = {'fir': 'fir', 'sector': 'sector', 'cta': 'cta', 'restricted': 'restricted', 'military': 'restricted',
                  'jsdf': 'jsdf', 'civil': 'civil', 'adiz': 'adiz'}[c]
    if o.get('kind') == 'corridor': o['layer'] = 'jsdf'
# 検査：座標の範囲・点の数・高度
bad = []
for o in items:
    for p in o['parts']:
        r = p['ring']
        lons = [q[0] for q in r]; lats = [q[1] for q in r]
        if not (115 < min(lons) and max(lons) < 170 and 15 < min(lats) and max(lats) < 52): bad.append((o['id'], 'range'))
        if len(r) < 4: bad.append((o['id'], 'pts'))
        if p['lower'] is not None and p['upper'] is not None and p['lower'] >= p['upper']: bad.append((o['id'], p.get('label'), 'alt', p['lower'], p['upper']))
        # 区域の大きさ（対角 NM）
        diag = dist([min(lons), min(lats)], [max(lons), max(lats)])
        if o['layer'] in ('restricted', 'civil') and diag > 400: bad.append((o['id'], p.get('label'), 'huge', round(diag)))
        for k in range(len(r) - 1):
            if dist(r[k], r[k + 1]) > 600 and o['layer'] not in ('fir', 'sector', 'cta'): bad.append((o['id'], p.get('label'), 'longedge', round(dist(r[k], r[k + 1]))))
for b in bad: print('CHECK', b)
db = {'meta': {'title': 'AeroWeather 空域データベース（AIP Japan ENR）', 'source': 'AIP Japan ENR（2026-10-01 版）ENR 2.1 / 5.1 / 5.2 / 5.3',
               'units': {'altitude': 'ft（FL は ×100ft）。lower/upper が null は UNL', 'coords': '[経度, 緯度]'},
               'notes': ['教育用の可視化データ。実運航には使わないこと', '円弧は3度ごとの点で近似。道路・河川・海岸線で区切られた区域は省略または概略']},
      'items': items}
json.dump(db, open('airspace_db.json', 'w'), ensure_ascii=False, separators=(',', ':'))
import collections
print(collections.Counter(o['layer'] for o in items), sum(len(o['parts']) for o in items), 'parts')
import os; print(os.path.getsize('airspace_db.json') // 1024, 'KB')
