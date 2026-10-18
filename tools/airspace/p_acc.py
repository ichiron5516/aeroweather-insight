# ENR 2.1：福岡FIR と ACC セクター
import re, json
from lib import *

out = []
# ---- FIR（ENR 2.1-2：DDMM 形式）----
txt = ' '.join(w['text'] for w in words(130) if w['x0'] < 330)
pts = [[int(m[2]) + int(m[3]) / 60, int(m[0]) + int(m[1]) / 60] for m in CO4.findall(txt)]
out.append({'id': 'RJJJ', 'cat': 'fir', 'name': '福岡FIR（Fukuoka FIR）', 'lower': 0, 'upper': None,
            'parts': [{'ring': close(pts), 'lower': 0, 'upper': None}], 'src': 'ENR 2.1-2',
            'info': {'Class': 'A, B, C, D, E, G', 'ACC': '東京・福岡・神戸'}})

# ---- ACC セクター（ENR 2.1-3〜20）----
UNIT = {'Tokyo': '東京ACC', 'Fukuoka': '福岡ACC', 'Kobe': '神戸ACC'}
recs = []        # (sector, unit, [lines of col1], [col2 words], [col4 words])
for pn in range(131, 149):
    u = hdr(pn, 'Unit'); x2 = u['x0'] - 18 if u else 260
    cs = hdr(pn, 'Call'); fq = hdr(pn, 'Frequency/Purpose')
    xf0 = (fq['x0'] - 25) if fq else x2 + 120
    xr = hdr(pn, 'Remarks'); xf1 = xr['x0'] - 10 if xr else 560
    for l in lines([w for w in words(pn) if w['top'] > 115 and w['top'] < 790]):
        c1 = [w for w in l if w['x1'] < x2 + 8]
        c2 = [w for w in l if x2 + 8 <= w['x0'] < xf0 - 40]
        c4 = [w for w in l if xf0 <= w['x0'] < xf1]
        t1 = ' '.join(w['text'] for w in c1)
        m = re.match(r'^([TFNA]\d\d)$', t1)
        if m and c1[0]['x0'] < x2 - 120:
            recs.append({'id': m.group(1), 'l': [], 'u': [], 'f': []}); continue
        if not recs: continue
        if t1: recs[-1]['l'].append(t1)
        recs[-1]['u'] += [w['text'] for w in c2]
        recs[-1]['f'] += [w['text'] for w in c4]

def parse_parts(sid, L):
    """'1) …' ごとの座標と高度"""
    parts, cur = [], None
    for t in L:
        m = re.match(r'^(\d)\)\s*(.*)', t)
        if m or cur is None:
            cur = {'txt': [], 'notes': []}; parts.append(cur)
            if m: t = m.group(2)
        if re.search(r'\d{6}N', t): cur['txt'].append(t)
        else: cur['notes'].append(t)
    res = []
    for p in parts:
        raw = ' '.join(p['txt'])
        # 座標と印（*1, *2）
        pts = []
        for m in re.finditer(r'(\d{6}N\d{7}E)\s*(\*\d)?', raw.replace(' ', '')):
            c = coords(m.group(1))[0]; pts.append((c, m.group(2)))
        note = ' '.join(p['notes'])
        # *1-*2: 50NM radius of HWE → *1 から *2 の円弧
        ring = []
        am = re.search(r'\*1\s*-\s*\*2\s*:\s*(\d+)\s*NM radius of ([A-Z]{3})', note)
        for i, (c, mk) in enumerate(pts):
            ring.append(c)
            if am and mk == '*1':
                j = next((k for k, (_, m2) in enumerate(pts) if m2 == '*2'), None)
                ctr = navaid(am.group(2))
                if j is not None and ctr and abs(j - i) == 1:
                    ring += arc(ctr, c, pts[j][0], float(am.group(1)))
            if am and mk == '*2' and i + 1 < len(pts) and pts[i + 1][1] == '*1':
                ctr = navaid(am.group(2))
                if ctr: ring += arc(ctr, c, pts[i + 1][0], float(am.group(1)))
        lo, up = 0, None
        b = re.search(r'Below FL\s?(\d{3})', note); a = re.search(r'above FL\s?(\d{3})', note)
        if b: up = int(b.group(1)) * 100
        if a: lo = int(a.group(1)) * 100
        if len(ring) >= 3: res.append({'ring': close(ring), 'lower': lo, 'upper': up})
        else: print('  !', sid, 'part with', len(ring), 'points', raw[:60])
    return res

for r in recs:
    unit = next((UNIT[w] for w in r['u'] if w in UNIT), None)
    if r['id'].startswith('A'): unit = '福岡ACC（洋上）'
    fr = [w for w in r['f'] if re.match(r'^\d{3}\.\d+MHz\*?$', w)]
    hf = [w for w in r['f'] if re.match(r'^\d{4,5}KHz$', w)]
    parts = parse_parts(r['id'], r['l'])
    if not parts: print('!! no parts', r['id']); continue
    out.append({'id': r['id'], 'cat': 'sector', 'name': f"{r['id']} セクター", 'unit': unit,
                'lower': min(p['lower'] for p in parts), 'upper': None if any(p['upper'] is None for p in parts) else max(p['upper'] for p in parts),
                'parts': parts, 'src': 'ENR 2.1',
                'info': {'管轄': unit, '周波数': ' / '.join(x.rstrip('*') for x in fr[:2]) or 'HF（東京ラジオ、CWP/NP 系）'}})

json.dump(out, open('acc.json', 'w'), ensure_ascii=False)
print(len(out), [ (o['id'], len(o['parts']), o['info'].get('周波数')) for o in out])
