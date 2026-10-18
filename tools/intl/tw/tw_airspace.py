# 台湾 ENR 2.1（FIR・TMA・D/E 類空域）・5.1（制限区域）・5.2（軍の演習・訓練空域、ADIZ）・5.3（民間訓練空域）→ airspace_db 形式
import re, sys, json, collections
sys.path.insert(0, '/home/claude/tw/tools')
from tw_common import *
from kr_geom import ring_of, vlim
items, skipped = [], []
def eng(name):
    """'臺北 終端管制區域 Taipei TMA' → 'Taipei TMA'、'五空域/Area Five' → 'Area Five'"""
    m = re.search(r'/\s*([A-Za-z].*)$', name)
    if m: return m.group(1).strip()
    m = re.search(r'([A-Za-z][A-Za-z0-9 ()\-\.]*)$', name)
    return m.group(1).strip() if m else name.strip()
def split_geo(t):
    m = re.search(r'(\d{6}(?:\.\d+)?[NS]\s*\d{7}(?:\.\d+)?[EW]|Circle|Clockwise|Counter)', t)
    return (t[:m.start()].strip(), t[m.start():]) if m else (t.strip(), '')
def add(id_, name, layer, cat, kind, geo, vt, src, info, label=None):
    ring, note = ring_of(geo)
    v = vlim(vt) if vt else None
    if not ring: skipped.append(f'{id_}: {geo[:60]}'); return
    lo, up, agl = v if v else (0, None, False)
    o = next((x for x in items if x['id'] == id_), None)
    part = {'ring': ring, 'lower': lo, 'upper': up, **({'agl': True} if agl else {}), **({'label': label} if label else {}), **({'note': note} if note else {})}
    if o:
        same = next((p for p in o['parts'] if p['ring'] == ring), None)
        if same is not None:
            if same.get('_nov') and v: same.update(part); same.pop('_nov', None); o['info'].pop('高度', None); o['lower'], o['upper'] = lo, up
            return
        if v: o['parts'].append(part); o['lower'] = min(o['lower'], lo)
        return
    if not v: part['_nov'] = True
    items.append({'id': id_, 'cat': cat, 'layer': layer, 'kind': kind, 'country': 'TW', 'name': name, 'lower': lo, 'upper': up, 'parts': [part], 'src': f'AIP Taiwan {src}',
                  'info': {**info, **({} if v else {'高度': 'NOTAM による'})}})

# ---- ENR 2.1：入れ子の表（1区域1表） ----
for t in soup('ENR 2.1').find_all('table'):
    if t.find('table'): continue
    rows = [[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in t.find_all('tr')]
    rows = [r for r in rows if r and r[0]]
    if len(rows) < 3 or not (coords(rows[1][0]) or 'Circle' in rows[1][0]): continue
    nm, geo, vt = rows[0][0], rows[1][0], rows[2][0]
    en = eng(nm)
    if 'FIR' in nm:
        r, _ = ring_of(geo)
        items.append({'id': 'RCAA', 'cat': 'fir', 'layer': 'fir', 'name': '台北FIR（Taipei FIR）', 'short': 'TAIPEI FIR', 'lower': 0, 'upper': None, 'country': 'TW',
                      'parts': [{'ring': r, 'lower': 0, 'upper': None}], 'src': 'AIP Taiwan ENR 2.1', 'info': {'Class': 'A（FL600超）, E', 'ACC': 'Taipei ACC'}}); continue
    kind = 'tma' if 'TMA' in nm else 'ctr'
    cls = re.search(r'Class of airspace:\s*([A-G])', ' '.join(' '.join(r) for r in rows))
    add('RC-' + re.sub(r'\W+', '', en.upper())[:20], en + ('' if kind == 'tma' else '（管制空域）'), 'cta', 'cta', kind, geo, vt, 'ENR 2.1',
        {'種別': 'ターミナル管制区（TMA）' if kind == 'tma' else '空港周辺の管制空域（D／E類）', **({'Class': cls.group(1)} if cls else {})})

# ---- ENR 5.1・5.2・5.3 ----
def section(r):
    h = r.find_previous(['h2', 'h3', 'h4', 'h5'])
    return txt(h) if h else ''
for n in ['ENR 5.1', 'ENR 5.2', 'ENR 5.3']:
    s = soup(n)
    prev = None
    for r in s.find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if not c or not c[0]: continue
        sec = section(r)
        head, geo = split_geo(c[0])
        vt = c[1] if len(c) > 1 else ''
        if not geo:                     # 名前だけの行（次の行が形）
            if re.match(r'^(RC[RDP]\d+|[A-Z]{1,3}\d*)', head) and len(head) < 40: prev = head
            continue
        name = head or prev
        if not name: continue
        if head: prev = head
        src = n
        if n == 'ENR 5.1':
            m = re.match(r'(RC([RDP])\d+[A-Z]?)', name)
            k = {'R': 'restricted', 'D': 'danger', 'P': 'prohibited'}[m.group(2)] if m else 'restricted'
            add(m.group(1) if m else 'RC-' + re.sub(r'\W+', '', eng(name).upper())[:16], f"{m.group(1) if m else ''} {eng(name[len(m.group(1)):] if m else name)}".strip(), 'restricted', 'restricted', k, geo, vt, src,
                {'種別': {'restricted': '飛行制限区域', 'danger': '危険区域', 'prohibited': '飛行禁止区域'}[k], '内容': (c[2] if len(c) > 2 else '')[:160]})
        elif n == 'ENR 5.2':
            if 'ADIZ' in name or 'ADIZ' in geo[:40]:
                if any(o['id'] == 'TWADIZ' for o in items) or not re.match(r'^\s*210000N 1173000E', geo): continue
                items.append({'id': 'TWADIZ', 'cat': 'adiz', 'layer': 'adiz', 'country': 'TW', 'name': '台湾 防空識別圏（Taiwan ADIZ）', 'parts': [], 'lines': [{'pts': coords(re.split(r'\.\s|\.$', geo)[0]), 'label': 'Taiwan ADIZ'}],
                              'src': 'AIP Taiwan ENR 5.2', 'info': {'種別': '防空識別圏（台湾）'}}); continue
            if '5.2.4' in sec or 'UAS' in sec or re.match(r'^(ARMY\d|N[A-E]-[A-D])', eng(name)): continue          # 無人機の訓練区域は省略
            en = eng(name)
            add('RC-MIL-' + re.sub(r'\W+', '', en.upper())[:16], f'{en}（台湾 軍訓練空域）', 'jsdf', 'military', 'moa', geo, vt, src, {'種別': '軍の演習・訓練空域', '節': sec[:40]})
        else:
            if 'CIVIL TRAINING' not in sec.upper(): continue
            en = eng(name)
            add('RC-CIV-' + re.sub(r'\W+', '', en.upper())[:16], f'{en}（民間訓練空域）', 'civil', 'civil', None, geo, vt, src, {'種別': '民間訓練空域'})
for o in items:
    for p in o['parts']: p.pop('_nov', None)
json.dump({'meta': {'title': '台湾 空域データ', 'source': 'AIP Taiwan（eAIP AIRAC AMDT 05-26, 2026-10-29）ENR 2.1 / 5.1 / 5.2 / 5.3'}, 'items': items},
          open('/home/claude/tw/out/airspace_tw.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print('skipped', len(skipped), skipped[:20])
print([(o['id'], o['name'], o.get('lower'), o.get('upper')) for o in items if o['layer'] in ('jsdf','civil')])
