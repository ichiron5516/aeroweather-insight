# フィリピン ENR 4.1（無線施設）・3.1/3.2（航空路、PDF）→ nav_db 形式
#   航空路の表は「緯度の行 → 名前の行（C=義務通報点 / R=任意通報点）→ 経度の行」の順に並ぶ。無線施設は名前が上、識別符号が下の「(ZAM)」
import re, sys, json, subprocess, math
CC = 'PH'
def text(f): return subprocess.run(['pdftotext', '-layout', f'/home/claude/ph/pdf/{f}', '-'], capture_output=True, text=True).stdout
def dms(s):
    m = re.match(r'(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])', s)
    v = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600
    return -v if m.group(4) in 'SW' else v
def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    return 3440.065 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
fixes, airways = {}, {}
LAT = re.compile(r'(?<!\d)(\d{6}(?:\.\d+)?[NS])(?!\w)')
LON = re.compile(r'(?<!\d)(\d{7}(?:\.\d+)?[EW])(?!\w)')
# ---- ENR 4.1 ----
L41 = text('ENR4.1.pdf').split('\n')
for i, L in enumerate(L41):
    m = re.match(r'^(\S.*?)\s{2,}([A-Z]{1,3})\s{2,}([\d.]+\s*(?:KHZ|MHZ)).*?(\d{6}(?:\.\d+)?N)', L)
    if not m: continue
    lon = next((LON.search(x).group(1) for x in L41[i + 1:i + 3] if LON.search(x)), None)
    if not lon: continue
    typ = re.match(r'^\s*(DVOR/DME|VOR/DME|DVOR|VOR|NDB|DME|TACAN|VORTAC)', L41[i + 1])
    fixes[m.group(2)] = {'lat': round(dms(m.group(4)), 6), 'lon': round(dms(lon), 6), 'type': 'navaid', 'name': m.group(1).strip().upper(),
                         'navaidType': typ.group(1) if typ else '', 'freq': m.group(3).replace(' ', ''), 'country': CC}
# ---- ENR 3.1 / 3.2 ----
DES = re.compile(r'^\s{0,8}([A-Z]{1,2}\d{1,3}[A-Z]?)(?=\s{2,}|$)')
NAME = re.compile(r'^\s*(?:(?:[DAFT]|ONLY)\s+)?(?:([CR])\s+)?([A-Z]{2,5})\s*$')
def routes(f, kind):
    lines = text(f).split('\n')
    cur = None
    i = 0
    while i < len(lines):
        L = lines[i]
        m = DES.match(L)
        if m and not LAT.search(L):
            cur = {'type': kind, 'points': [], 'compulsory': []}; airways.setdefault(m.group(1), []).append(cur); i += 1; continue
        la = LAT.search(L)
        if la and not LON.search(L) and cur is not None:
            j = next((k for k in range(i + 1, min(i + 4, len(lines))) if LON.search(lines[k])), None)
            if j is None: i += 1; continue
            lon = LON.search(lines[j]).group(1)
            between = [x[:24] for x in lines[i + 1:j]] + [re.sub(LON, '', lines[j])[:24]]
            nm, comp = None, False
            if any(re.search(r'DVOR|VOR|NDB|DME|TACAN', x) for x in between + [L]):
                for x in lines[j + 1:j + 3] + lines[i - 2:i]:
                    pm = re.search(r'\(([A-Z]{2,3})\)', x)
                    if pm: nm = pm.group(1); break
                comp = any(re.match(r'^\s*C\s', x) for x in between)
            if not nm:
                for x in between:
                    mm = NAME.match(x.strip() and x or '')
                    if mm: nm, comp = mm.group(2), mm.group(1) == 'C'; break
            if not nm:
                prev = lines[i - 1][:24] if i else ''
                mm = NAME.match(prev)
                if mm and mm.group(2) not in ('ONLY', 'D', 'R', 'A', 'F', 'T'): nm, comp = mm.group(2), mm.group(1) == 'C'
                else:
                    head = re.sub(LAT, '', L).strip()
                    mm = NAME.match(head) if head else None
                    if mm and mm.group(2) != 'ONLY': nm = mm.group(2)
            if nm:
                if nm not in fixes: fixes[nm] = {'lat': round(dms(la.group(1)), 6), 'lon': round(dms(lon), 6), 'type': 'waypoint', 'country': CC}
                if not cur['points'] or cur['points'][-1] != nm: cur['points'].append(nm)
                if comp: cur['compulsory'].append(nm)
            i = j + 1; continue
        i += 1
routes('ENR3.1.pdf', 'CONVENTIONAL'); routes('ENR3.2.pdf', 'RNAV')
out = {}
for k, lst in airways.items():
    lst = [x for x in lst if len(x['points']) >= 2]
    if not lst: continue
    pts = lst[0]['points']
    for x in lst[1:]:
        if x['points'][0] == pts[-1]: pts = pts + x['points'][1:]
        elif x['points'][-1] == pts[0]: pts = x['points'][:-1] + pts
        else: pts = pts + x['points']
    for x in lst:
        for f in x['compulsory']: fixes[f]['reporting'] = 'COMPULSORY'
    out[k] = {'type': lst[0]['type'], 'points': pts, 'segments': [{'nm': round(dist(fixes[a], fixes[b]), 1)} for a, b in zip(pts, pts[1:])], 'country': CC}
json.dump({'meta': {'title': 'フィリピン 航法データ', 'sources': ['AIP Philippines ENR 3.1', 'ENR 3.2', 'ENR 4.1'], 'aipEffective': 'ENR 3.1 14 MAY 26 / ENR 3.2 10 JUL 25'},
           'fixes': fixes, 'airways': out}, open('/home/claude/ph/out/nav_ph.json', 'w'), ensure_ascii=False)
print('fixes', len(fixes), 'navaids', sum(v['type'] == 'navaid' for v in fixes.values()), 'airways', len(out))
for k in list(out)[:12]: print(k, out[k]['type'], out[k]['points'], [s['nm'] for s in out[k]['segments']])
