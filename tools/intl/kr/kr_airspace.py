# 韓国 ENR 2.1（FIR・TMA・ACCセクター・管制圏）・5.1（P/R/D）・5.2（MOA・ACMI・KADIZ・警戒区域）・5.3（民間訓練 CATA）→ airspace_db 形式
import json, re, sys
sys.path.insert(0, '/home/claude/kr/tools')
from kr_lib import *
from kr_geom import *
items, skipped = [], []

def hull(points):
    pts = sorted(map(tuple, points))
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return close([list(p) for p in lo[:-1] + up[:-1]])

def rows(n, ti=None):
    tabs = soup(n).find_all('table')
    for i, t in enumerate(tabs):
        if ti is not None and i != ti: continue
        for r in t.find_all('tr'):
            c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
            if c and c[0] and not re.match(r'^(\d|Name|Identification|Lateral|Designation)\b', c[0]): yield i, c

def chunks(text):
    """1つのセルに『境界 高度 境界 高度…』と並んでいるものを分ける"""
    out, pos = [], 0
    for m in re.finditer(r'(?:' + ALT + r')\s*/\s*(?:' + ALT + r')|(?:SFC|GND)\s*-\s*' + ALT, text):
        if not coords(text[pos:m.start()]) and 'circle' not in text[pos:m.start()].lower(): continue
        if vlim(m.group(0)) is None: continue
        out.append((text[pos:m.start()], vlim(m.group(0)))); pos = m.end()
    return out

# ---- ENR 2.1 ----
fir_freq = {}
for i, c in rows('ENR-2.1'):
    if i == 0 and c[0].startswith('Incheon FIR'):
        ring, note = ring_of(c[0])
        items.append({'id': 'RKRR', 'cat': 'fir', 'layer': 'fir', 'name': '仁川FIR（Incheon FIR）', 'short': 'INCHEON FIR', 'lower': 0, 'upper': None, 'country': 'KR',
                      'parts': [{'ring': ring, 'lower': 0, 'upper': None}], 'src': 'AIP Korea ENR 2.1',
                      'info': {'Class': 'A, B, C, D, E, G', 'ACC': 'Daegu ACC・Incheon ACC', '注意': note}})
tma, cur = {}, None
for i, c in rows('ENR-2.1', 1):
    t = c[0]
    m = re.match(r'(.+?Terminal Control Area)\s+(.*)', t)
    if m: cur = m.group(1).replace(' Terminal Control Area', ''); t = m.group(2)
    if cur is None: continue
    o = tma.setdefault(cur, {'id': f'RK-TMA-{cur.upper()}', 'cat': 'cta', 'layer': 'cta', 'kind': 'tma', 'country': 'KR', 'name': f'{cur} TMA', 'parts': [],
                             'src': 'AIP Korea ENR 2.1', 'info': {'種別': 'ターミナル管制区（TMA）'}})
    if len(c) >= 4 and 'APP' in c[1]: o['info']['管制'] = c[1]; o['info']['周波数'] = c[3][:120]
    for geo, v in chunks(t):
        lab = re.search(r'\b(T\s*\d{1,2}|S\d)\b(?=\s*(?:\(|\d{4}))', geo)
        ring, note = ring_of(geo)
        if not ring: skipped.append(f'TMA {cur}: {geo[:60]}'); continue
        o['parts'].append({'ring': ring, 'lower': v[0], 'upper': v[1], **({'agl': True} if v[2] else {}), 'label': lab.group(1).replace(' ', '') if lab else '', **({'note': note} if note else {})})
for o in tma.values():
    if o['parts']: o['lower'] = min(p['lower'] for p in o['parts']); o['upper'] = max(p['upper'] or 60000 for p in o['parts']); items.append(o)
unit = None
for i, c in rows('ENR-2.1', 2):
    m = re.match(r'(.+? Sector)\s+(.*)', c[0])
    if not m: continue
    name = m.group(1)
    if len(c) > 1 and 'ACC' in c[1]: unit = c[1]
    parts = []
    for geo, v in chunks(m.group(2)):
        ring, note = ring_of(geo)
        if ring: parts.append({'ring': ring, 'lower': v[0], 'upper': v[1], **({'agl': True} if v[2] else {}), **({'note': note} if note else {})})
    if not parts: skipped.append('sector ' + name); continue
    items.append({'id': 'RK-' + name.replace(' ', ''), 'cat': 'sector', 'layer': 'sector', 'country': 'KR', 'name': f'{name}（{unit}）', 'short': name.replace(' Sector', ''),
                  'unit': unit, 'lower': min(p['lower'] for p in parts), 'upper': max(p['upper'] or 60000 for p in parts), 'parts': parts, 'src': 'AIP Korea ENR 2.1', 'info': {'管轄': unit}})
for i, c in rows('ENR-2.1', 3):
    m = re.match(r'(.+? CONTROL ZONE)\s+(.*)', c[0])
    if not m: continue
    ring, _ = ring_of(m.group(2)); v = vlim(m.group(2))
    if not ring or not v: skipped.append('ctr ' + m.group(1)); continue
    nm = m.group(1).title().replace(' Control Zone', '')
    items.append({'id': 'RK-CTR-' + nm.upper(), 'cat': 'cta', 'layer': 'cta', 'kind': 'ctr', 'country': 'KR', 'name': f'{nm} 管制圏（CTR）', 'lower': v[0], 'upper': v[1],
                  'parts': [{'ring': ring, 'lower': v[0], 'upper': v[1], **({'agl': True} if v[2] else {})}], 'src': 'AIP Korea ENR 2.1',
                  'info': {'種別': '管制圏', '管制': c[1] if len(c) > 1 else '', **({'注意': '重なる管制圏の除外は省略'} if 'xclud' in m.group(2) else {})}})

# ---- ENR 5.1・5.2・5.3 ----
def area(n, c, layer, kind, cat, idp, name, extra=None):
    geo = c[0] + (' ' + c[1] if len(c) > 1 and coords(c[1]) and not vlim(c[1]) else '')
    vtxt = next((x for x in c[1:] if vlim(x)), '') or (c[0] if vlim(c[0]) else '')
    v = vlim(vtxt) if vtxt else None
    note = ''
    if 'outlines of circles' in geo:
        cs = coords(geo); r = 2.0
        ring = hull([p for cc in cs for p in circle(cc, r)]); note = '2つの円を包む形'
    elif 'either side of center line' in geo:
        a, b = coords(geo)[:2]; w = float(re.search(r'([\d.]+)\s*NM', geo).group(1)); br = bearing(a, b)
        ring = close([dest(*a, br - 90, w), dest(*b, br - 90, w), dest(*b, br + 90, w), dest(*a, br + 90, w)])
    elif 'between Demarcation' in geo:
        pts = coords(geo.split('CIVIL CORRIDOR')[0])
        ring = close(pts + along(NLL, pts[-1], pts[0])); note = '軍事境界線との間（概略）'
    else:
        ring, note = ring_of(geo)
    if not ring: skipped.append(f'{n} {name}: {geo[:80]}'); return
    lo, up, agl = v if v else (0, None, False)
    o = {'id': idp, 'cat': cat, 'layer': layer, 'kind': kind, 'country': 'KR', 'name': name, 'lower': lo, 'upper': up,
         'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'agl': True} if agl else {}), **({'note': note} if note else {})}],
         'src': f'AIP Korea {n.replace("-", " ")}', 'info': {**(extra or {})}}
    if not v: o['info']['高度'] = 'NOTAM による'
    if 'xclud' in geo: o['info']['注意'] = '一部の除外区域は省略'
    items.append(o)
KIND = {'P': ('prohibited', '飛行禁止区域'), 'R': ('restricted', '飛行制限区域'), 'D': ('danger', '危険区域'), 'A': ('warning', '警戒区域（Alert）')}
for i, c in rows('ENR-5.1'):
    m = re.match(r'RK\s*([PRD])\s*(\d+[A-Z]?)\s+(?:RK\s*[PRD]\s*\d+[A-Z]?\s+)?([A-Za-z\- ()]+?)\s+(?=A circle|circle|A Semicircle|Area|The area|\d{4})', c[0] + ' ', re.I)
    if not m: skipped.append('5.1 ' + c[0][:50]); continue
    k, l = KIND[m.group(1)]
    area('ENR-5.1', c, 'restricted', k, 'restricted', f'RK{m.group(1)}{m.group(2)}', f'RK {m.group(1)}{m.group(2)} {m.group(3).strip().title()}',
         {'種別': l, '内容': c[2][:160] if len(c) > 2 else ''})
moa_prev = None
for i, c in rows('ENR-5.2'):
    t = c[0]
    if t.startswith('KOREA ADIZ'):
        pts = coords(t)
        items.append({'id': 'KADIZ', 'cat': 'adiz', 'layer': 'adiz', 'country': 'KR', 'name': '韓国 防空識別圏（KADIZ）', 'parts': [], 'lines': [{'pts': pts, 'label': 'KADIZ'}],
                      'src': 'AIP Korea ENR 5.2', 'info': {'種別': '防空識別圏（韓国）'}}); continue
    m = re.match(r'RK\s*A\s*(\d+[A-Z]?)\s+(.+?)\s+(?=A circle|circle|\d{4})', t + ' ')
    if m:
        area('ENR-5.2', c, 'restricted', 'warning', 'military', f'RKA{m.group(1)}', f'RK A{m.group(1)} {m.group(2).title()}', {'種別': '警戒区域（Alert Area）'}); continue
    m = re.match(r'(MOA\s*\d+[A-Z]?|ACMI\s*[A-Z]|DOKDO|JINDO|GANGGU)\b\s*([A-Z\-]+(?:\s[A-Z\-]+)*)?', t)
    if m:
        nm = m.group(1).replace('  ', ' ')
        area('ENR-5.2', c, 'jsdf', 'moa', 'military', 'RK-' + nm.replace(' ', ''), f'{nm}{" " + m.group(2).title() if m.group(2) else ""}（韓国 軍訓練空域）',
             {'種別': '軍の訓練空域（MOA・ACMI 等）'}); moa_prev = nm; continue
    if coords(t) and moa_prev:            # 前の MOA の続き（名前のない行）
        area('ENR-5.2', c, 'jsdf', 'moa', 'military', f'RK-{moa_prev.replace(" ", "")}-2', f'{moa_prev}（続き）（韓国 軍訓練空域）', {'種別': '軍の訓練空域'}); continue
    skipped.append('5.2 ' + t[:60])
for i, c in rows('ENR-5.3', 0):
    m = re.match(r'(CATA\s*\d+[A-Z]?)\s+([A-Z ]+?)\s+(?=\d{4})', c[0])
    if not m: skipped.append('5.3 ' + c[0][:50]); continue
    area('ENR-5.3', c, 'civil', None, 'civil', 'RK-' + m.group(1).replace(' ', ''), f'{m.group(1)} {m.group(2).title()}（民間訓練空域）', {'種別': '民間航空機訓練空域（CATA）', '時間': c[-1][:60]})

# 同じ id が重なったら番号を付ける
seen = {}
for o in items:
    if o['id'] in seen: seen[o['id']] += 1; o['id'] += f'-{seen[o["id"]]}'
    else: seen[o['id']] = 0
json.dump({'meta': {'title': '韓国 空域データ', 'source': 'AIP Korea（eAIP 2026-10-28 AIRAC）ENR 2.1 / 5.1 / 5.2 / 5.3', 'notes': ['北方限界線・軍事境界線に沿う区間は概略の線で代用']},
           'items': items}, open('/home/claude/kr/out/airspace_kr.json', 'w'), ensure_ascii=False)
import collections
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print('skipped', len(skipped)); print('\n'.join(skipped[:40]))
