# 香港 ENR 4.1（無線施設）・4.4（地点）・3.1/3.3（航空路）→ nav_db 形式
import json, re, sys
sys.path.insert(0, '/home/claude/hk/tools')
from hk_common import *
fixes, airways = {}, {}
# ---- ENR 4.1 ----
for r in soup('ENR-4.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 5 or not coords(c[4]): continue
    m = re.match(r'(.+?)\s+(DVOR/DME|VORTAC|VOR/DME|VOR|TACAN|DME|NDB)\b', c[0])
    lo, la = coords(c[4])[0]
    fixes[c[1]] = {'lat': la, 'lon': lo, 'type': 'navaid', 'name': (m.group(1) if m else c[0]).upper(), 'navaidType': m.group(2) if m else '',
                   'freq': c[2].split('(')[0].replace(' ', ''), 'country': 'HK'}
# ---- ENR 4.4 ----
for r in soup('ENR-4.4').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2 or not coords(c[1]): continue
    nm = re.match(r'([A-Z0-9]{2,5})', c[0])
    if not nm: continue
    lo, la = coords(c[1])[0]
    fixes.setdefault(nm.group(1), {'lat': la, 'lon': lo, 'type': 'waypoint', 'country': 'HK', **({'note': 'FIR境界'} if 'FIR' in c[0] else {})})
# ---- ENR 3.x 航空路 ----
DES = re.compile(r'^([A-Z]{1,2}\d{1,3}[A-Z]?)\b')
def routes(n, kind):
    cur = None
    for r in soup(n).find_all('tr'):
        cells = r.find_all(['td', 'th'], recursive=False)
        c = [txt(x) for x in cells]
        if not c: continue
        m = DES.match(c[0])
        if m and len(c) <= 3 and not coords(' '.join(c)):
            cur = {'name': m.group(1), 'type': kind, 'points': [], 'seg': []}; airways.setdefault(m.group(1), []).append(cur); continue
        if cur is None or len(c) < 3: continue
        co = coords(c[2])
        if co and c[1]:
            pm = re.search(r'\(([A-Z]{2,3})\)', c[1]); nm = pm.group(1) if pm else re.match(r'[A-Z0-9]+', c[1]).group(0)
            if nm not in fixes: fixes[nm] = {'lat': co[0][1], 'lon': co[0][0], 'type': 'waypoint', 'country': 'HK'}
            if not cur['points'] or cur['points'][-1] != nm: cur['points'].append(nm)
            cur['compulsory'] = cur.get('compulsory', []) + ([nm] if c[0] == '▲' else [])
routes('ENR-3.1', 'CONVENTIONAL'); routes('ENR-3.3', 'RNAV')
for lst in airways.values():
    for x in lst:
        for f in x.get('compulsory', []): fixes[f]['reporting'] = 'COMPULSORY'
out = {}
for k, lst in airways.items():
    lst = [x for x in lst if len(x['points']) >= 2]
    if not lst: continue
    # 同じ名前が分かれて載っている場合はつなげる（端が同じなら）
    pts = lst[0]['points']
    for x in lst[1:]:
        if x['points'][0] == pts[-1]: pts = pts + x['points'][1:]
        elif x['points'][-1] == pts[0]: pts = x['points'][:-1] + pts
        else: pts = pts + x['points']
    seg = [{'nm': round(dist([fixes[a]['lon'], fixes[a]['lat']], [fixes[b]['lon'], fixes[b]['lat']]), 1)} for a, b in zip(pts, pts[1:])]
    out[k] = {'type': lst[0]['type'], 'points': pts, 'segments': seg, 'country': 'HK'}
json.dump({'meta': {'title': '香港 航法データ', 'sources': ['AIP Hong Kong ENR 3.1', 'ENR 3.3', 'ENR 4.1', 'ENR 4.4'], 'aipEffective': '2026-10-29 AIRAC'},
           'fixes': fixes, 'airways': out}, open('/home/claude/hk/out/nav_hk.json', 'w'), ensure_ascii=False)
print('fixes', len(fixes), 'navaids', sum(v['type'] == 'navaid' for v in fixes.values()), 'airways', len(out))
for k in list(out)[:8]: print(k, out[k]['type'], out[k]['points'])
