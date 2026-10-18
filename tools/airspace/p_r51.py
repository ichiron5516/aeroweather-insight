# ENR 5.1：制限空域（RJR1〜3）と 4. 空域制限（R- / W- / 演習場）
import re, json, sys
from lib import *

out = []
# ---- RJR1〜3（円の一部）----
c1 = coords('405806N1401930E')[0]; ring = [p for p in circle(c1, 3.25, 144) if p[0] <= c1[0]]
out.append({'id': 'RJR1', 'cat': 'restricted', 'name': 'RJR1 車力', 'parts': [{'ring': close(ring), 'lower': 0, 'upper': 19000}],
            'info': {'種別': '飛行制限区域（航空法80条）', '時間': 'H24', '連絡先': '車力通信所（在日米軍）'}, 'src': 'ENR 5.1-1'})
c2 = coords('372518N1410156E')[0]
out.append({'id': 'RJR2', 'cat': 'restricted', 'name': 'RJR2 福島第一原子力発電所', 'parts': [{'ring': circle(c2, 3 / 1.852), 'lower': 0, 'upper': 5000}],
            'info': {'種別': '飛行制限区域（航空法80条）', '時間': 'H24'}, 'src': 'ENR 5.1-2'})
c3 = coords('354553N1351145E')[0]; ring = [p for p in circle(c3, 3.25, 144) if p[1] >= c3[1]]
out.append({'id': 'RJR3', 'cat': 'restricted', 'name': 'RJR3 経ヶ岬', 'parts': [{'ring': close(ring), 'lower': 0, 'upper': 19000}],
            'info': {'種別': '飛行制限区域（航空法80条）', '時間': 'H24', '連絡先': '経ヶ岬通信所（在日米軍）'}, 'src': 'ENR 5.1-3'})

# ---- 4. 空域制限（ENR 5.1-4〜12）----
blocks = []
NAME = re.compile(r'^(?:([RW]-\d+[A-Z]?)\s+)?([A-Z][A-Z0-9\-\'/ ]{2,}|Area [A-Za-z]+)$')
for pn in range(696, 705):
    up = hdr(pn, 'Upper'); ty = hdr(pn, 'Type'); ho = hdr(pn, 'Hours'); rm = hdr(pn, 'Remarks')
    if not up: continue
    xa0, xa1, xt1, xh1 = up['x0'] - 18, ty['x0'] - 5, ho['x0'] - 8, rm['x0'] - 10
    for l in lines([w for w in words(pn) if up['top'] + 25 < w['top'] < 790]):
        c1 = [w for w in l if w['x1'] <= xa0 + 3]
        ca = [w for w in l if xa0 <= w['x0'] < xa1]
        ct = [w for w in l if xa1 <= w['x0'] < xt1]
        ch = [w for w in l if xt1 <= w['x0'] < xh1]
        t1 = ' '.join(w['text'] for w in c1)
        m = NAME.match(t1) if c1 and c1[0]['x0'] < xa0 - 150 else None
        if m and not re.search(r'\d{6}N|Beginning|Area within|Fan|circle|Target|Island|then|radius|on |to ', t1) and (m.group(1) or t1.isupper()):
            blocks.append({'id': m.group(1) or m.group(2).title(), 'name': m.group(2), 'lat': [], 'alt': [], 'type': [], 'hrs': [], 'pg': pn})
            ct = ct; ch = ch
            blocks[-1]['type'] += [w['text'] for w in ct]; blocks[-1]['hrs'] += [w['text'] for w in ch]
            continue
        if not blocks: continue
        b = blocks[-1]
        if t1: b['lat'].append((t1, c1[0]['x0']))
        b['alt'] += [w['text'] for w in ca]
        b['type'] += [w['text'] for w in ct]; b['hrs'] += [w['text'] for w in ch]

def altpairs(A):
    """['36000', '----', 'GND'] → [(上限, 下限), …]（区分線の前後）"""
    toks = [a for a in A if re.match(r'^(FL\d+|\d{3,6}|SFC|GND|UNL|-{4,})$', a)]
    res = []
    for i, a in enumerate(toks):
        if a.startswith('---') and 0 < i < len(toks) - 1: res.append((alt_ft(toks[i - 1]), alt_ft(toks[i + 1])))
    return res

def nmval(v, u):
    v = float(v); u = u.lower()
    return v if u == 'nm' else v * 0.869 if u in ('sm', 'mile') else v / 1852 if u == 'm' else v / 1.852
def walk(txt):
    """'Beginning at A to B then clockwise along the arc of a circle radius Rnm centered on C to D to E …' を点列に"""
    toks = re.findall(r'(clockwise|counter-clockwise)|radius (\d+(?:\.\d+)?)\s*(nm|sm)|centered\s+(?:on|at)\s+(\d{6}(?:\.\d+)?N/\s*\d{7}(?:\.\d+)?E)|(\d{6}(?:\.\d+)?N/\s*\d{7}(?:\.\d+)?E)', txt)
    ring, mode = [], None
    for cw, r, u, ctr, p in toks:
        if cw: mode = {'cw': cw == 'clockwise'}; continue
        if r: mode['r'] = nmval(r, u); continue
        if ctr: mode['c'] = coords(ctr)[0]; continue
        q = coords(p)[0]
        if mode and 'c' in mode and ring:
            ring += arc(mode['c'], ring[-1], q, mode['r'], cw=mode['cw']); mode = None
        ring.append(q)
    if mode and 'c' in mode and ring:      # 最後の弧で始点に戻る
        ring += arc(mode['c'], ring[-1], ring[0], mode['r'], cw=mode['cw'])
    return close(ring)
def semicircle_r130(txt):
    f = coords(txt)[0]; r1 = 0.869; r5 = 5 * 0.869
    ntip, stip = dest(f[0], f[1], 0, r1), dest(f[0], f[1], 180, r1)
    def hit(p, brg):                      # 点 p から方位 brg の線が半径 r5 の円と交わる所
        lo, hi = 0.0, 20.0
        for _ in range(60):
            m = (lo + hi) / 2
            if dist(f, dest(p[0], p[1], brg, m)) < r5: lo = m
            else: hi = m
        return dest(p[0], p[1], brg, lo)
    a, b = hit(stip, 108), hit(ntip, 58)
    west = [dest(f[0], f[1], 360 - 180 * i / 24, r1) for i in range(25)]     # 北端→西→南端
    return close(west + [a] + arc(f, a, b, r5, cw=False) + [b])

TYPE_JA = {'Restricted': '制限区域', 'Warning': '警戒区域'}
for b in blocks:
    txt = ' '.join(t for t, _ in b['lat'])
    alts = altpairs(b['alt'])
    up, lo = (alts[0] if alts else (None, 0))
    parts = []
    tid = b['id']
    txt = re.sub(r'\s*Target will be.*?\d{6}N/\s*\d{7}E\.?', ' ', txt)        # 標的の位置は区域の点ではない
    if tid == 'R-130':
        parts.append({'ring': semicircle_r130(txt), 'lower': lo, 'upper': up})
    elif tid == 'R-116':
        P = {k: coords(v) for k, v in {
            1: '343512N/1401648E 341823N/1403306E 340818N/1404651E 340159N/1405701E 335707N/1410514E 333429N/1402547E 343112N/1400748E',
            2: '341823N/1403306E 340818N/1404651E 334706N/1402150E 341121N/1401409E',
            3: '343512N/1401648E 341823N/1403306E 341121N/1401409E 343112N/1400748E'}.items()}
        for k, (u2, l2) in zip((1, 2, 3), [(None, 0), (15000, 0), (12000, 0)]):
            parts.append({'ring': close(P[k]), 'lower': l2, 'upper': u2, 'label': f'({k})'})
    elif 'along the arc' in txt:                    # W-179・W-178A：円弧でつながる区域
        parts.append({'ring': walk(txt), 'lower': lo, 'upper': up})
    elif re.search(r'A circle (?:with a )?radius of', txt):   # 中心から半径 N（nm / m）
        m = re.search(r'radius of (\d+(?:\.\d+)?)\s*(nm|m)\b', txt); ctr = coords(txt)[0]
        parts.append({'ring': circle(ctr, nmval(m.group(1), m.group(2)) + (0.3 if m.group(2) == 'm' else 0)), 'lower': lo, 'upper': up})
    elif 'Fan-shaped' in txt:                       # R-521：扇形
        ctr = coords(txt)[0]
        for k, (km, b1, b2) in enumerate(re.findall(r'within (\d+)km radius of \S+ between (\d+)°True and (\d+)°True', txt)):
            a2 = alts[k] if k < len(alts) else (up, lo)
            parts.append({'ring': sector(ctr, float(km) / 1.852, float(b1), float(b2)), 'lower': a2[1], 'upper': a2[0]})
    elif 'beyond 3nm to 5nm' in txt:               # W-183A：半径3〜5NM の輪
        ctr = coords(txt)[0]
        o = circle(ctr, 5); i = circle(ctr, 3)[::-1]
        parts.append({'ring': o, 'hole': i, 'lower': lo, 'upper': up})
    elif re.search(r'circular area', txt, re.I):   # 島を中心に半径 N NM（島の大きさは無視）
        ctr = coords(txt)[0]; r = float(re.search(r'extending (\d+)nm', txt).group(1)) + 0.5
        parts.append({'ring': circle(ctr, r), 'lower': lo, 'upper': up})
    else:
        # (1)(2)(3) の小区域（R-116 など）：座標が別の列にもある。左の列の座標は区域(1)、右の列は高度ごとの区域
        segs = re.split(r'\(\d\)', txt)
        if len(segs) > 2:
            # 左の列（x が小さい）が (1)、右の列は (1) の続き＋(2)(3)…。高度の区切りで分ける
            left = [t for t, x in b['lat'] if x < 60]; right = [t for t, x in b['lat'] if x >= 60]
            print('  multi', tid, len(alts), '|', ' '.join(left)[:80], '|', ' '.join(right)[:200])
            groups = [coords(' '.join(left))]
            for t, x in b['lat']:
                pass
            b['multi'] = True
        pts = coords(txt)
        if len(pts) >= 3: parts.append({'ring': close(pts), 'lower': lo, 'upper': up})
    note = re.search(r'Target will be[^.]*\.', txt)
    typ = ' '.join(b['type'])
    kind = 'warning' if tid.startswith('W') or 'Warning' in typ else 'restricted'
    m = re.search(r'\((?:USN|USAF|JSDF-[AGM]|USMC|US Army)[^)]*\)', typ)
    H = ' '.join(b['hrs'])
    hrs = ' '.join(re.findall(r'by NOTAM|by AIP SUP|[Cc]ontinuous|DLY|MON-FRI|MON-SAT|SAT|SUN|HOL|\d{4}-\d{4}|&|VMC-IMC|VMC', H))
    if not parts: print('!! no geometry', tid, txt[:120]); continue
    out.append({'id': tid, 'cat': 'military', 'kind': kind, 'name': f"{tid} {b['name'].title() if not tid.startswith(('R-', 'W-')) else b['name']}".strip() if tid != b['name'].title() else b['name'].title(),
                'parts': parts, 'src': f"ENR 5.1-{b['pg'] - 692}",
                'info': {'種別': ('警戒区域（Warning Area）' if kind == 'warning' else '制限区域（Restricted Area）') + (' ' + m.group(0) if m else ''),
                         '時間': hrs or '—', **({'備考': note.group(0)} if note else {})}})
json.dump(out, open('r51.json', 'w'), ensure_ascii=False)
for o in out: print(o['id'], '|', o['name'], '|', [(len(p['ring']), p['lower'], p['upper']) for p in o['parts']], '|', o['info'].get('時間'))
