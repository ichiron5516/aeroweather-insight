# ベトナム ENR 2.1（FIR・TMA・APP 空域）・5.1（P/R/D）→ airspace_db 形式
#   高さはメートル表記（"8000 M"）が多いのでフィートに直す。ACC セクターは地点名でつなぐ記述のため省略
import re, sys, json, collections
sys.path.insert(0, '/home/claude/vn/tools')
from vn_common import *
from kr_geom import ring_of
CC = 'VN'
NAV = json.load(open('/home/claude/vn/out/nav_vn.json'))['fixes']
items, skipped = [], []
M2FT = 3.28084

def one(s):
    s = s.strip()
    if re.match(r'^(UNL|Unspecified|To be specified)', s, re.I): return None, False
    if re.match(r'^(GND|SFC)', s, re.I): return 0, False
    m = re.match(r'^FL\s*(\d+)', s)
    if m: return int(m.group(1)) * 100, False
    m = re.match(r'^([\d ]+)\s*M\b(\s*AGL)?', s)
    if m: return round(int(m.group(1).replace(' ', '')) * M2FT / 100) * 100, bool(m.group(2))
    m = re.match(r'^([\d ]+)\s*FT\b(\s*AGL)?', s)
    if m: return int(m.group(1).replace(' ', '')), bool(m.group(2))
    return 'x', False
TOK = r'(?:UNL|Unspecified|To be specified|GND|SFC|FL\s*\d+|[\d ]*\d\s*M(?:\s*AGL)?|[\d ]*\d\s*FT(?:\s*AGL)?)'
def vl(s):
    """'8000 M 500 M AGL'（上限 下限）や 'From 750 M up to FL 155' を (下限, 上限, AGL) に"""
    m = re.search(r'From\s+(' + TOK + r')(?:\s*\([^)]*\))?\s*,?\s*(?:up\s+)?to\s+(' + TOK + ')', s, re.I)
    if m: lo, up = m.group(1), m.group(2)
    else:
        s = s.lstrip(' :')
        m = re.match(r'\s*(' + TOK + r')(?:\s*\([^)]*\))?\s+(' + TOK + ')', s, re.I)
        if not m: return None
        up, lo = m.group(1), m.group(2)
    u, _ = one(up); l, agl = one(lo)
    if u == 'x' or l == 'x': return None
    return l, u, agl

def add(id_, name, layer, kind, cat, ring, v, src, info, note=''):
    if not ring: skipped.append(id_); return
    lo, up, agl = v if v else (0, None, False)
    items.append({'id': id_, 'cat': cat, 'layer': layer, **({'kind': kind} if kind else {}), 'country': CC, 'name': name, 'lower': lo, 'upper': up,
                  'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'agl': True} if agl else {}), **({'note': note} if note else {})}],
                  'src': f'AIP Viet Nam {src}', 'info': {**info, **({} if v else {'高度': '記載なし／NOTAM'})}})

def pts_of(t):
    return [[lo, la] for lo, la in coords(t)]

# ---- ENR 2.1 ----
rows = [[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in soup('ENR-2.1').find_all('tr')]
rows = [r for r in rows if r]
# FIR は既存の FIR 表示（fir_asia.geojson）を使うので収録しない（AIP の記述は国境沿いが「along the border」で座標がない）
# TMA・APP 空域（円で定義されたもの）
def circ_item(id_, name, centre, km, v, info):
    add(id_, name, 'cta', 'tma', 'cta', circle(centre, km / 1.852), v, 'ENR 2.1', info)
for r in rows:
    t = r[0]
    m = re.search(r'circle with (?:radius (?:of )?)?(\d+)\s*KM(?: radius)?.*?centred (?:on|at)\s+(?:DVOR/DME\s+)?([A-Z]{3})\b', t)
    if not m or not re.search(r'Vertical limit', t): continue
    ident = m.group(2); c = NAV.get(ident)
    if not c: continue
    key = {'NOB': ('VV-TMA-NOIBAI', 'Noi Bai TMA'), 'TSH': ('VV-TMA-TANSONNHAT', 'Tan Son Nhat TMA'), 'DAN': ('VV-TMA-DANANG', 'Da Nang APP 空域')}.get(ident)
    if not key or any(o['id'] == key[0] for o in items): continue
    v = vl(t.split('Vertical limit')[1])
    cls = re.search(r'Class of airspace:\s*([A-G])', t)
    circ_item(key[0], key[1], [c['lon'], c['lat']], int(m.group(1)), v, {'種別': 'ターミナル管制区（TMA）・進入管制区', **({'Class': cls.group(1)} if cls else {})})
# カムラン APP（13点の多角形）
for r in rows:
    if 'point 1 to point 13' in r[0]:
        p = pts_of(r[0].split('- LAVUT')[0])
        v = vl(r[0].split('Vertical')[1]) if 'Vertical' in r[0] else None
        add('VV-TMA-CAMRANH', 'Cam Ranh APP 空域', 'cta', 'tma', 'cta', close(p), v, 'ENR 2.1', {'種別': '進入管制区'})

# ---- ENR 5.1 ----
for r in soup('ENR-5.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2: continue
    m = re.match(r'^(VV([PRD])\d+[A-Z]?)\s+(.*)$', c[0])
    if not m: continue
    ident, k, rest = m.groups()
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}[k]
    nm = re.match(r'^([A-Z][A-Z ]+?)(?=\s+(?:A circle|\d{6}|Eastern|Northern))', rest)
    geo = rest[nm.end():] if nm else rest
    cm = re.search(r'circle,\s*([\d.]+)\s*KM radius,\s*centred at\s*(\d{6}N\s*\d{7}E)', geo)
    if cm: ring = circle(coords(cm.group(2))[0], float(cm.group(1)) / 1.852)
    else:
        p = pts_of(geo); ring = close(p) if len(p) >= 3 else None
    add(ident, f'{ident} {nm.group(1).title() if nm else ""}'.strip(), 'restricted', kind, 'restricted', ring, vl(c[1]), 'ENR 5.1',
        {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind], '内容': (c[2] if len(c) > 2 else '')[:160]})
json.dump({'meta': {'title': 'ベトナム 空域データ', 'source': 'AIP Viet Nam（eAIP 2026-10-29 AIRAC）ENR 2.1 / 5.1',
                    'notes': ['ACC セクターは地点名でつなぐ記述のため未収録', 'FIR は既存の FIR 表示を使う', '高さのメートル表記はフィートに換算']}, 'items': items},
          open('/home/claude/vn/out/airspace_vn.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print([(o['id'], o['lower'], o['upper'], len(o['parts'][0]['ring'])) for o in items if o['layer'] in ('cta', 'fir')])
print('no vlim', [o['id'] for o in items if '高度' in o['info']])
print('skipped', skipped)
