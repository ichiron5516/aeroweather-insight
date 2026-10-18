# 台湾 ENR 4.1（無線施設）・4.4（地点）・3.1/3.2（航空路。1ページ1路線）→ nav_db 形式
import re, sys, json
sys.path.insert(0, '/home/claude/tw/tools')
from tw_common import *
fixes, airways = {}, {}
for r in soup('ENR 4.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 5 or not coords(c[4]) or not re.match(r'^[A-Z]{1,3}$', c[1]): continue
    m = re.match(r'(.+?)\s+(VORTAC|VOR/DME|VOR|TACAN|DME|NDB)\b', c[0])
    lo, la = coords(c[4])[0]
    fixes[c[1]] = {'lat': la, 'lon': lo, 'type': 'navaid', 'name': (m.group(1) if m else c[0]).upper(), 'navaidType': m.group(2) if m else '',
                   'freq': re.sub(r'\s|\(.*', '', c[2]).replace('KHZ', 'kHz').replace('MHZ', 'MHz'), 'country': 'TW'}
for r in soup('ENR 4.4').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2 or not coords(c[1]): continue
    nm = re.match(r'([A-Z0-9]{2,5})\b', c[0])
    if not nm: continue
    lo, la = coords(c[1])[0]
    fixes.setdefault(nm.group(1), {'lat': la, 'lon': lo, 'type': 'waypoint', 'country': 'TW', **({'note': 'FIR境界'} if 'FIR' in c[0] else {})})
for page in [k for k in kr_lib.H if re.match(r'ENR 3\.[12] \S', k)]:
    d = page.split()[2]
    kind = 'RNAV' if page.startswith('ENR 3.2') or 'RNAV' in page else 'CONVENTIONAL'
    pts, comp = [], []
    for r in soup(page).find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if not c: continue
        m = re.match(r"^([▲△])\s*([A-Z][A-Z0-9 /]*?)(?:\s*\(([^)]*)\)|\s*'([A-Z]{2,3})')?\s+(\d{6}(?:\.\d+)?[NS]\s*\d{7}(?:\.\d+)?[EW])", c[0])
        if not m: continue
        co = coords(m.group(5))[0]
        name = m.group(2).strip()
        fid = m.group(4) or name.split()[0]
        if fid not in fixes: fixes[fid] = {'lat': co[1], 'lon': co[0], 'type': 'waypoint', 'country': 'TW'}
        if not pts or pts[-1] != fid: pts.append(fid)
        if m.group(1) == '▲': comp.append(fid)
    if len(pts) < 2: print('!! no points', page); continue
    for f in comp: fixes[f]['reporting'] = 'COMPULSORY'
    seg = [{'nm': round(dist([fixes[a]['lon'], fixes[a]['lat']], [fixes[b]['lon'], fixes[b]['lat']]), 1)} for a, b in zip(pts, pts[1:])]
    airways[d] = {'type': kind, 'points': pts, 'segments': seg, 'country': 'TW', **({'note': page.split(' ', 2)[2]} if 'TRANSITION' in page else {})}
json.dump({'meta': {'title': '台湾 航法データ', 'sources': ['AIP Taiwan ENR 3.1', 'ENR 3.2', 'ENR 4.1', 'ENR 4.4'], 'aipEffective': '2026-10-29 AIRAC'},
           'fixes': fixes, 'airways': airways}, open('/home/claude/tw/out/nav_tw.json', 'w'), ensure_ascii=False)
print('fixes', len(fixes), 'navaids', sum(v['type'] == 'navaid' for v in fixes.values()), 'airways', len(airways))
for k in list(airways)[:6] + ['M750', 'V12']: print(k, airways.get(k, {}).get('points'))
