# カンボジア ENR 4.1（無線施設）・4.4（地点）・3.1/3.2（航空路）→ nav_db 形式
import json, re, sys
sys.path.insert(0, '/home/claude/kh/tools')
from kh_common import *
fixes, airways = {}, {}
CC = 'KH'
# ---- ENR 4.1 ----
for r in soup('ENR-4.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 5 or not coords(c[4]) or not re.match(r'^[A-Z]{1,3}$', c[1]): continue
    m = re.match(r'(.+?)\s+(DVOR/DME|DVOR|VORTAC|VOR/DME|VOR|TACAN|DME|NDB)\b', c[0])
    lo, la = coords(c[4])[0]
    fixes[c[1]] = {'lat': la, 'lon': lo, 'type': 'navaid', 'name': (m.group(1) if m else c[0]).upper(), 'navaidType': m.group(2) if m else '',
                   'freq': c[2].split('(')[0].replace(' ', ''), 'country': CC}
# ---- ENR 4.4 ----
for r in soup('ENR-4.4').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2 or not coords(c[1]): continue
    nm = re.match(r'^([A-Z0-9]{2,5})\b', c[0])
    if not nm: continue
    lo, la = coords(c[1])[0]
    fixes.setdefault(nm.group(1), {'lat': la, 'lon': lo, 'type': 'waypoint', 'country': CC})
# ---- ENR 3.1（従来の航空路）・3.2（RNAV 航空路） ----
DES = re.compile(r'^([A-Z]{1,2}\d{1,3}[A-Z]?)\b')
def routes(n, kind):
    cur = None
    for r in soup(n).find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if not c: continue
        m = DES.match(c[0])
        if m and (len(c) <= 4 or not any(c[2:])) and not coords(' '.join(c[:2])):
            cur = {'name': m.group(1), 'type': kind, 'points': [], 'compulsory': []}; airways.setdefault(m.group(1), []).append(cur); continue
        if cur is None or len(c) < 2: continue
        co = coords(c[1])
        if not co: continue
        pm = re.search(r'\(\s*([A-Z]{2,3})\s*\)', c[1])
        nm = pm.group(1) if pm else re.match(r'[A-Z0-9]+', c[1]).group(0)
        if nm not in fixes: fixes[nm] = {'lat': co[0][1], 'lon': co[0][0], 'type': 'waypoint', 'country': CC}
        if not cur['points'] or cur['points'][-1] != nm: cur['points'].append(nm)
        if c[0] == '▲': cur['compulsory'].append(nm)
routes('ENR-3.1', 'CONVENTIONAL'); routes('ENR-3.2', 'RNAV')
for lst in airways.values():
    for x in lst:
        for f in x['compulsory']: fixes[f]['reporting'] = 'COMPULSORY'
out = {}
for k, lst in airways.items():
    lst = [x for x in lst if len(x['points']) >= 2]
    if not lst: continue
    pts = lst[0]['points']
    for x in lst[1:]:
        if x['points'][0] == pts[-1]: pts = pts + x['points'][1:]
        elif x['points'][-1] == pts[0]: pts = x['points'][:-1] + pts
        else: pts = pts + x['points']
    seg = [{'nm': round(dist([fixes[a]['lon'], fixes[a]['lat']], [fixes[b]['lon'], fixes[b]['lat']]), 1)} for a, b in zip(pts, pts[1:])]
    out[k] = {'type': lst[0]['type'], 'points': pts, 'segments': seg, 'country': CC}
json.dump({'meta': {'title': 'カンボジア 航法データ', 'sources': ['AIP Cambodia ENR 3.1', 'ENR 3.2', 'ENR 4.1', 'ENR 4.4'], 'aipEffective': '2026-09-03 AIRAC'},
           'fixes': fixes, 'airways': out}, open('/home/claude/kh/out/nav_kh.json', 'w'), ensure_ascii=False)
print('fixes', len(fixes), 'navaids', sum(v['type'] == 'navaid' for v in fixes.values()), 'airways', len(out))
for k in list(out)[:6]: print(k, out[k]['type'], out[k]['points'])
