# シンガポール ENR 2.1（FIR・Singapore/Johor 空域・Tanjungpinang TMA/CTR）・5.1（P/R/D）・5.2（軽飛行機訓練空域）→ airspace_db 形式
import re, sys, json, collections
sys.path.insert(0, '/home/claude/sg/tools')
from sg_common import *
from kr_geom import ring_of
items, skipped = [], []
def alt1(s):
    s = s.upper().replace(',', '')
    if re.match(r'(GND|SFC|WATER|MSL|SEA)', s): return 0
    m = re.match(r'FL\s*(\d{2,3})', s)
    if m: return int(m.group(1)) * 100
    m = re.match(r'(\d[\d ]*)\s*FT', s)
    return int(m.group(1).replace(' ', '')) if m else None
def vl(s):
    toks = re.findall(r'FL\s*\d{2,3}|\d[\d, ]*\s*FT|GND|SFC|WATER|MSL', s.upper())
    if len(toks) < 2: return None
    return alt1(toks[1]), alt1(toks[0])
def btn(t):
    m = re.search(r'BTN LAT\s*(\d{6}[NS])\s*(\d{6}[NS])\s*and LONG\s*(\d{7}[EW])\s*(\d{7}[EW])', t)
    if not m: return None
    a, b = coords(f'{m[1]} {m[3]}')[0], coords(f'{m[2]} {m[4]}')[0]
    return close([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]])
def add(id_, name, layer, kind, cat, geo, vt, src, info):
    ring = btn(geo)
    note = ''
    if not ring:
        g = re.sub(r'\.?(Area bounded by.*)$', '', geo) if geo.count('Area bounded by') > 1 else geo
        ring, note = ring_of(g)
    if not ring: skipped.append(f'{id_}: {geo[:70]}'); return
    v = vl(vt) if vt else None
    lo, up = v if v else (0, None)
    items.append({'id': id_, 'cat': cat, 'layer': layer, 'kind': kind, 'country': 'SG', 'name': name, 'lower': lo, 'upper': up,
                  'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'note': note} if note else {})}], 'src': f'AIP Singapore {src}',
                  'info': {**info, **({} if v else {'高度': '記載の読み取り不可'})}})
rows = [[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in soup('ENR-2.1').find_all('tr')]
for i, c in enumerate(rows):
    t = c[0] if c else ''
    if t == 'SINGAPORE FIR':
        pts = coords(next(r[0] for r in rows[i + 1:i + 4] if r and coords(r[0])))
        items.append({'id': 'WSJC', 'cat': 'fir', 'layer': 'fir', 'name': 'シンガポールFIR（Singapore FIR）', 'short': 'SINGAPORE FIR', 'lower': 0, 'upper': None, 'country': 'SG',
                      'parts': [{'ring': close(pts), 'lower': 0, 'upper': None}], 'src': 'AIP Singapore ENR 2.1', 'info': {'ACC': 'Singapore ACC'}})
    elif t.startswith('All controlled airspace within'):
        add('WS-SJAC', 'Singapore/Johor 空域（管制空域）', 'cta', 'tma', 'cta', t, 'FL250 2000ft', 'ENR 2.1', {'種別': 'Singapore/Johor Airspace Complex', '注意': 'HOSBA 以遠は上限 FL450'})
    elif t.startswith('TANJUNGPINANG TMA'):
        add('WS-TMA-TPG', 'Tanjungpinang TMA', 'cta', 'tma', 'cta', t, re.search(r'(\d[\d ]*ft\s*\d[\d ]*\s*FT)\s*$', t, re.I).group(1) if re.search(r'(\d[\d ]*ft\s*\d[\d ]*\s*FT)\s*$', t, re.I) else '10000ft 3000ft', 'ENR 2.1', {'種別': 'TMA', '注意': '円弧は直線で近似'})
    elif 'CONTROL ZONE (CTR)' in t and i + 1 < len(rows):
        g = rows[i + 1][0]
        add('WS-CTR-' + ('TPGN' if 'NORTH' in t else 'TPGS'), t.title().replace('(Ctr)', '（CTR）'), 'cta', 'ctr', 'cta', g, re.search(r'([\d ]+ft)\s*GND', g).group(1) + ' GND' if re.search(r'([\d ]+ft)\s*GND', g) else '', 'ENR 2.1', {'種別': '管制圏', '注意': '円弧は直線で近似'})
for r in soup('ENR-5.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2: continue
    m = re.match(r'^(W[SM]([PRD])\d+[A-Z]?)\s+(.*)$', c[0])
    if not m: continue
    ident, k, rest = m.groups()
    nm = re.match(r'([A-Z][A-Z \-]+?)\s+(?=A circle|An arc|Area|\d{4}|BTN)', rest + ' ')
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}[k]
    geo = rest
    if 'two circles' in rest:
        cs = coords(rest); geo = f'A circle, 0.2NM radius centred at {rest[rest.find(cs and "(")+1:]}' if False else ''
        from kr_geom import circle as _c
        ring = None
    if 'two circles' in rest or 'Area within 2NM centred' in rest:
        cc = coords(rest); r_ = 150 / 1852 if '150m' in rest else 2.0
        import kr_lib
        pts = [p for c0 in cc for p in kr_lib.circle(c0, r_, 36)]
        # 凸包
        P = sorted(map(tuple, pts)); cr = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        lo_, up_ = [], []
        for p in P:
            while len(lo_) >= 2 and cr(lo_[-2], lo_[-1], p) <= 0: lo_.pop()
            lo_.append(p)
        for p in reversed(P):
            while len(up_) >= 2 and cr(up_[-2], up_[-1], p) <= 0: up_.pop()
            up_.append(p)
        ring = close([list(p) for p in lo_[:-1] + up_[:-1]]); v = vl(c[1]) or (0, None)
        items.append({'id': ident, 'cat': 'restricted', 'layer': 'restricted', 'kind': kind, 'country': 'SG', 'name': f'{ident} {(nm.group(1).title() if nm else "")}'.strip(), 'lower': v[0], 'upper': v[1],
                      'parts': [{'ring': ring, 'lower': v[0], 'upper': v[1], 'note': '円を包む形で近似'}], 'src': 'AIP Singapore ENR 5.1', 'info': {'種別': '飛行禁止区域' if kind == 'prohibited' else '区域', '内容': c[2][:140] if len(c) > 2 else ''}})
        continue
    if 'An arc,' in rest and 'extremity' in rest:      # WSD4：円弧と弦で囲む半円
        cc = coords(rest); rad = float(re.search(r'([\d.]+)NM', rest).group(1))
        import kr_lib
        ring = close([cc[1]] + kr_lib.arc(cc[0], cc[1], cc[2], rad, cw=False) + [cc[2]])
        v = vl(c[1]) or (0, None)
        items.append({'id': ident, 'cat': 'restricted', 'layer': 'restricted', 'kind': kind, 'country': 'SG', 'name': f'{ident} {(nm.group(1).title() if nm else "")}'.strip(), 'lower': v[0], 'upper': v[1],
                      'parts': [{'ring': ring, 'lower': v[0], 'upper': v[1], 'note': '円弧の向きは概略'}], 'src': 'AIP Singapore ENR 5.1', 'info': {'種別': '危険区域', '内容': c[2][:140] if len(c) > 2 else ''}})
        continue
    add(ident, f'{ident} {(nm.group(1).title() if nm else "")}'.strip(), 'restricted', kind, 'restricted', geo, c[1], 'ENR 5.1',
        {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind], '内容': c[2][:140] if len(c) > 2 else ''})
json.dump({'meta': {'title': 'シンガポール 空域データ', 'source': 'AIP Singapore（eAIP 2026-09-03）ENR 2.1 / 5.1'}, 'items': items}, open('/home/claude/sg/out/airspace_sg.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print([(o['id'], o['lower'], o['upper'], len(o['parts'][0]['ring'])) for o in items])
print('skipped', skipped)
