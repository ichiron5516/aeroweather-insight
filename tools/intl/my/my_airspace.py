# マレーシア ENR 2.1（TMA・ターミナル空域）・5.1（P/R/D）→ airspace_db 形式
#   「thence TMA boundaries」「along the FIR BDRY」などの区間は直線で近似。FIR は既存の FIR 表示を使う
import re, sys, json, collections
sys.path.insert(0, '/home/claude/my/tools')
from my_common import *
from kr_geom import ring_of, vlim
CC = 'MY'
NAV = json.load(open('/home/claude/my/out/nav_my.json'))['fixes']
items, skipped = [], []
ALT = r'(?:UNL|GND|SFC|MSL|FL\s*\d{2,3}|[\d ]*\d\s*FT(?:\s*(?:ALT|AMSL|AGL))?)'
def ft(s):
    s = s.strip()
    if s.startswith('UNL'): return None
    if re.match(r'GND|SFC|MSL', s): return 0
    m = re.match(r'FL\s*(\d+)', s)
    if m: return int(m.group(1)) * 100
    return int(re.sub(r'\D', '', s.split('FT')[0]))
def vl(s):
    m = re.search(r'(' + ALT + r')\s*(?:-|/|to)\s*(' + ALT + r')', s)
    if not m: return None
    a, b = ft(m.group(1)), ft(m.group(2))
    agl = 'AGL' in m.group(0)
    if a is None or (b is not None and a > b): return (b or 0, a, agl)
    return (a, b, agl)
def norm(g):
    g = g.replace('centered', 'centred').replace('arcof', 'arc of')
    # 「an arc of 30NM radius centred on VKL DVOR/DME ( 024328N 1014417E ) clockwise」→ kr_geom の形
    g = re.sub(r'(?:along\s+)?(?:the\s+|an\s+)?arc of (?:a circle\s+)?(?:of\s+)?([\d.]+)\s*NM(?:\s+radius)?\s+(?:centred|from)\s+(?:on\s+|of\s+)?[A-Z]{2,3}\s*(?:DVOR/DME|VOR/DME|DVOR)?\s*\(\s*(\d{6}N\s*\d{7}E)\s*\)\s*(anti[- ]?clockwise|counter[- ]?clockwise|clockwise)',
               lambda m: f' {m.group(3)} arc {m.group(1)} NM centred on {m.group(2)} ', g)
    return g
def add(id_, name, layer, kind, cat, ring, v, src, info):
    if not ring or len(ring) < 4: skipped.append(id_); return
    lo, up, agl = v if v else (0, None, False)
    if any(o['id'] == id_ for o in items): return
    items.append({'id': id_, 'cat': cat, 'layer': layer, 'kind': kind, 'country': CC, 'name': name, 'lower': lo, 'upper': up,
                  'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'agl': True} if agl else {}), 'note': '境界線・FIR 境界沿いの区間は直線で近似'}],
                  'src': f'AIP Malaysia {src}', 'info': {**info, **({} if v else {'高度': '記載なし'})}})
# ---- ENR 2.1 ----
HEAD = re.compile(r'^((?:KL TMA \d)|[A-Z][A-Za-z ]+?(?:TERMINAL AREA|TERMINAL CONTROL AREA|TMA))\s+(.*)$', re.I)
for r in soup('ENR-2.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if not c: continue
    m = HEAD.match(c[0])
    if not m or 'AMPA' in c[0]: continue
    name, body = m.group(1).strip(), m.group(2)
    geo = re.split(r'Class of airspace|Vertical', body)[0]
    ring, note = ring_of(norm(geo))
    v = vl(body.split('Class of airspace')[-1]) if 'Class of airspace' in body else vl(' '.join(c[1:2]) + ' ' + body[-120:])
    place = re.sub(r'\s*(TERMINAL CONTROL AREA|TERMINAL AREA|TMA)$', '', name, flags=re.I).title()
    add('WM-TMA-' + re.sub(r'[^A-Z0-9]', '', name.upper()), f'{place} TMA' if not name.startswith('KL TMA') else name, 'cta', 'tma', 'cta', ring, v, 'ENR 2.1',
        {'種別': 'ターミナル管制区（TMA）', **({'Class': re.search(r'Class of airspace:?\s*([A-G])', body).group(1)} if re.search(r'Class of airspace:?\s*([A-G])', body) else {})})
# ---- ENR 5.1 ----
for r in soup('ENR-5.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2: continue
    m = re.match(r'^(W[MB]([PRD])\d+[A-Z]?)\s*-?\s*(.*)$', c[0])
    if not m: continue
    ident, k, rest = m.groups()
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}[k]
    nm = re.match(r'^([A-Z][A-Z \-]+?)(?=\s+(?:Area|A circle|Within|An area|\d))', rest)
    geo = norm(rest)
    cm = re.search(r'([\d.]+)\s*(KM|NM)\s*radius\s*(?:of|centred on|centered on|centred at)\s*(\d{6}(?:\.\d+)?N\s*\d{7}(?:\.\d+)?E)', rest) or \
         re.search(r'within\s*([\d.]+)\s*(KM|NM)\s*(?:radius\s*)?(?:centred|centered|of)\s*(?:on|at)?\s*(\d{6}(?:\.\d+)?N\s*\d{7}(?:\.\d+)?E)', rest, re.I)
    if cm and not re.search(r'\d{6}N\s*\d{7}E.*?\d{6}N\s*\d{7}E.*?\d{6}N', rest):
        rr = float(cm.group(1)) / (1.852 if cm.group(2) == 'KM' else 1)
        ring = circle(coords(cm.group(3))[0], rr)
    else: ring, _ = ring_of(geo)
    add(ident, f'{ident} {nm.group(1).title() if nm else ""}'.strip(), 'restricted', kind, 'restricted', ring, vl(c[1].replace('ALT', '')), 'ENR 5.1',
        {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind], '内容': ' '.join(c[2:])[:160]})
json.dump({'meta': {'title': 'マレーシア 空域データ', 'source': 'AIP Malaysia（eAIP 2026-10-29 AIRAC）ENR 2.1 / 5.1', 'notes': ['FIR は既存の FIR 表示を使う', '境界線沿いの区間は直線で近似']}, 'items': items},
          open('/home/claude/my/out/airspace_my.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print([(o['id'], o['lower'], o['upper'], len(o['parts'][0]['ring'])) for o in items if o['layer'] == 'cta'])
print('no vlim', [o['id'] for o in items if '高度' in o['info']][:30])
print('skipped', skipped)
