# ENR 5.3 1.1 民間訓練試験空域（Civil Training & Testing Areas）
import re, json
from lib import *

PT = re.compile(r'\((\d+)\)\s*(\d{6}(?:\.\d+)?N\s*/\s*\d{7}(?:\.\d+)?E)')
ARC = re.compile(r'(?:line|lines) connecting (?:the )?point(?:s)? ((?:\(\d+\)[, ]*(?:and |to )?)+?)\s*(?:to|and) (?:point )?\((\d+)\) (?:is|are) (?:the |a )?minor arc (?:with|within) (?:a )?radius of (\d+(?:\.\d+)?)\s*NM (?:from|of) (\d{6}N\s*/?\s*\d{7}E|[A-Za-z\- ]+?(?:VORTAC|VOR/DME|TACAN|VOR|DME|ARP))', re.I)
GROUP = {'HK': '北海道', 'TH': '東北', 'KK': '関東・甲信越', 'CK': '中部・近畿', 'CS': '中国・四国', 'KS': '九州', 'SM': '下地島'}

rows = []
for pn in range(737, 754):
    nmh, arh, alh, fah = hdr(pn, 'Name'), hdr(pn, 'Area'), hdr(pn, 'Altitude'), hdr(pn, 'Facility')
    xa0 = arh['x0'] - 125; xal0 = alh['x0'] - 10; xf0 = fah['x0'] - 35
    for l in lines([w for w in words(pn) if nmh['top'] + 6 < w['top'] < 790]):
        rows.append({'y': (pn, l[0]['top']),
                     'name': ' '.join(w['text'] for w in l if w['x1'] <= xa0 + 3),
                     'c': ' '.join(w['text'] for w in l if xa0 <= w['x0'] < xal0),
                     'a': [w['text'] for w in l if xal0 <= w['x0'] < xf0],
                     'f': ' '.join(w['text'] for w in l if w['x0'] >= xf0)})

polys, cur, grp = [], None, None
for r in rows:
    g = re.search(r'\((HK|TH|KK|CK|CS|KS|SM)\)', r['name'])
    if g:
        grp = g.group(1)
        if cur and cur['grp'] != grp and len(cur['rows']) < 8: cur['grp'] = grp      # 群の名前が最初の区域の途中の行にある
    if re.match(r'^(The airspace bounded|Within|Area enclosed|Area within)', r['c']):
        cur = {'grp': grp, 'txt': [], 'rows': [], 'lab': None, 'f': []}; polys.append(cur)
    if cur is None: continue
    cur['txt'].append(r['c']); cur['rows'].append(r['y']); cur['f'].append(r['f'])
    m = re.search(r'(?:^|\s)(\d{1,2}(?:-\d{1,2}){0,2})$', r['name'].strip())
    if m and not cur['lab']: cur['lab'] = m.group(1)
    cur.setdefault('a', []).extend((r['y'], a) for a in r['a'])

def key(y): return y[0] * 10000 + y[1]
# 高度：区分線の前後。区分線に一番近い多角形に割り当てる
alltok = [(y, a) for p in polys for (y, a) in p.get('a', []) if re.match(r'^(FL\d+|\d{3,6}|SFC|GND|UNL|-{4,})$', a)]
pairs = [(y, alt_ft(alltok[i - 1][1]), alt_ft(alltok[i + 1][1])) for i, (y, a) in enumerate(alltok) if a.startswith('---') and 0 < i < len(alltok) - 1]
cen = [sum(key(y) for y in p['rows']) / len(p['rows']) for p in polys]
got = [[] for _ in polys]
for y, up, lo in pairs:
    k = min(range(len(polys)), key=lambda i: abs(cen[i] - key(y)))
    got[k].append((up, lo))

out = {}
skipped = []
prev = (0, None)
for p, g in zip(polys, got):
    if g: lo = min(x[1] for x in g); up = None if any(x[0] is None for x in g) else max(x[0] for x in g); prev = (lo, up)
    else: lo, up = prev
    txt = ' '.join(p['txt'])
    lab = p['lab'] or '?'
    pts = [(int(n), coords(c)[0]) for n, c in PT.findall(txt)]
    ring = None
    mc = re.search(r'Within (\d+(?:\.\d+)?)\s*NM radius of ([A-Za-z]+) (ARP|VOR/DME|VORTAC|TACAN)(?: \(([A-Z]{3})\))?', txt)
    if len(pts) >= 3:
        arcs = []
        for m in ARC.finditer(txt):
            a_list = [int(x) for x in re.findall(r'\((\d+)\)', m.group(1))]
            ctr = coords(m.group(4))[0] if re.match(r'\d{6}N', m.group(4)) else navaid(m.group(4))
            if not ctr: continue
            seq = a_list + [int(m.group(2))]
            for u, v in zip(seq, seq[1:]): arcs.append((u, v, float(m.group(3)), ctr))
        ring = []
        for i, (n, c) in enumerate(pts):
            ring.append(c); nxt = pts[(i + 1) % len(pts)]
            for u, v, rr, ctr in arcs:
                if {u, v} == {n, nxt[0]}: ring += arc(ctr, c, nxt[1], rr)
        ring = close(ring)
    elif mc:
        ARPS = {'MATSUMOTO': [137 + 55 / 60, 36 + 10 / 60]}
        c = navaid(mc.group(4) or mc.group(2)) if mc.group(3) != 'ARP' else ARPS.get(mc.group(2).upper())
        if c:
            ring = circle(c, float(mc.group(1)), 144)
            hw = re.search(r'in the (west|east) side of (\d{7})E', txt.replace(' ', '')) or re.search(r'in the (west|east) side of (\d{7})E', txt)
            hn = re.search(r'in the (north|south) side of (\d{6})N', txt)
            if hw:
                x = int(hw.group(2)[:3]) + int(hw.group(2)[3:5]) / 60 + int(hw.group(2)[5:]) / 3600
                ring = close([[min(p[0], x), p[1]] if hw.group(1) == 'west' else [max(p[0], x), p[1]] for p in ring])
            elif hn:
                y = int(hn.group(2)[:2]) + int(hn.group(2)[2:4]) / 60 + int(hn.group(2)[4:]) / 3600
                ring = close([[p[0], max(p[1], y)] if hn.group(1) == 'north' else [p[0], min(p[1], y)] for p in ring])
            elif re.search(r'side of a line|coastline', txt):
                p['note'] = '円の一部（境界線の片側）。図は円全体'
    if not ring:
        skipped.append(f"{p['grp']}{lab}: {txt[:70]}"); continue
    freq = re.search(r'(\d{3}\.\d{1,3})MHz', ' '.join(p['f']))
    fac = re.search(r'([A-Z][A-Za-z\- ]+?(?:Control|APP|TCA|Information|Radio|Approach|Tower))', ' '.join(p['f']))
    gid = p['grp'] or 'XX'
    o = out.setdefault(gid, {'id': f'CIVTRN-{gid}', 'cat': 'civil', 'name': f"民間訓練試験空域 {GROUP.get(gid, gid)}（{gid}）", 'parts': [], 'src': 'ENR 5.3 1.1',
                             'info': {'種別': '民間訓練試験空域（ATMセンターへ訓練計画を提出・承認）'}})
    o['parts'].append({'ring': ring, 'lower': lo, 'upper': up, 'label': f'{gid}{lab}',
                       **({'freq': f"{fac.group(1).strip() if fac else ''} {freq.group(1)}MHz".strip()} if freq else {}),
                       **({'note': p.get('note') or '一部の空域を除く'} if ('Excluding' in txt or p.get('note')) else {})})
res = list(out.values())
json.dump(res, open('r53.json', 'w'), ensure_ascii=False)
for o in res: print(o['id'], len(o['parts']), [(x['label'], x['lower'], x['upper']) for x in o['parts']][:8])
print('skipped', len(skipped)); print('\n'.join(skipped[:30]))
