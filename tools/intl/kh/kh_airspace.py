# カンボジア ENR 2.1（ACC セクター・TMA）・5.1（P/R/D）→ airspace_db 形式。FIR は既存の FIR 表示を使う
import re, sys, json, collections
sys.path.insert(0, '/home/claude/kh/tools')
from kh_common import *
from kr_geom import ring_of
CC = 'KH'
NAV = json.load(open('/home/claude/kh/out/nav_kh.json'))['fixes']
items, skipped = [], []
def ft(s):
    s = s.strip()
    if s.startswith('UNL'): return None
    if re.match(r'GND|SFC', s): return 0
    m = re.match(r'FL\s*(\d+)', s)
    return int(m.group(1)) * 100 if m else int(re.sub(r'\D', '', s))
def norm(g):
    g = re.sub(r'(\d{6}(?:\.\d+)?)\s+([NS])\b', r'\1\2', g)
    g = re.sub(r'(\d{7}(?:\.\d+)?)\s+([EW])\b', r'\1\2', g)
    g = g.replace('centered', 'centred')
    g = re.sub(r'thence\s+([\d.]+)\s*NM radius\s+(?:clockwise\s+)?(?:arc\s+)?centred on\s+([A-Z]{3})\b[^,]*?(clockwise|anti-clockwise|counter-clockwise)?',
               lambda m: f' {m.group(3) or "clockwise"} arc {m.group(1)} NM centred on {(lambda f: f"{abs(int(f["lat"]*3600))//3600:02d}{abs(int(f["lat"]*3600))//60%60:02d}{abs(int(f["lat"]*3600))%60:02d}N {abs(int(f["lon"]*3600))//3600:03d}{abs(int(f["lon"]*3600))//60%60:02d}{abs(int(f["lon"]*3600))%60:02d}E")(NAV[m.group(2)]) if m.group(2) in NAV else m.group(2)} ', g)
    return g
def add(id_, name, layer, kind, ring, lo, up, src, info, short=None):
    if not ring or len(ring) < 4: skipped.append(id_); return
    items.append({'id': id_, 'cat': 'cta' if layer in ('cta', 'sector') else layer, 'layer': layer, **({'kind': kind} if kind else {}), 'country': CC, 'name': name,
                  'lower': lo, 'upper': up, 'parts': [{'ring': ring, 'lower': lo, 'upper': up}], 'src': f'AIP Cambodia {src}', 'info': info, **({'short': short} if short else {})})
for r in soup('ENR-2.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if not c: continue
    t = c[0]
    m = re.match(r'^(SECTOR \d|[A-Z ]+ TMA)\s+(.*)$', t)
    if not m: continue
    name, body = m.group(1), m.group(2)
    up = re.search(r'Upper limit:\s*(UNL|FL\s*\d+|[\d ]+FT)', body); lo = re.search(r'Lower limit:\s*(GND|SFC|FL\s*\d+|[\d ]+FT)', body)
    up, lo = (ft(up.group(1)) if up else None), (ft(lo.group(1)) if lo else 0)
    geo = norm(body.split('Upper limit')[0])
    if name.startswith('SIEM REAP'):
        ring = circle([NAV['REP']['lon'], NAV['REP']['lat']], 30)      # ARP の代わりに REP DVOR/DME を中心に
    elif name.startswith('PHNOM PENH'):
        ring = circle([NAV['TIA']['lon'], NAV['TIA']['lat']], 50)      # Techo の ARP の代わりに TIA DVOR/DME
    elif name.startswith('SIHANOUK'):
        ring = circle(coords('104329.6N 1032526.4E')[0], 50)
    else: ring, _ = ring_of(geo)
    cls = re.search(r'Class:\s*([A-G])', body)
    if name.startswith('SECTOR'):
        add('VDPF-' + name.replace(' ', ''), f'Phnom Penh ACC {name.title()}', 'sector', None, ring, lo, up, 'ENR 2.1', {'ACC': 'Phnom Penh ACC'}, short=f'PNH {name}')
    else:
        add('VD-TMA-' + re.sub(r'[^A-Z]', '', name), name.title().replace('Tma', 'TMA'), 'cta', 'tma', ring, lo, up, 'ENR 2.1',
            {'種別': 'ターミナル管制区（TMA）', **({'Class': cls.group(1)} if cls else {}), **({'注意': '中心から 50NM（Siem Reap は 30NM）の円で近似。Phnom Penh と Sihanouk の境界線・FIR 境界での切り取りは省略'})})
for r in soup('ENR-5.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2: continue
    m = re.match(r'^(VD([PRD])\d+)\s+(.*)$', c[0])
    if not m: continue
    ident, k, rest = m.groups()
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}[k]
    cm = re.search(r'([\d.]+)\s*NM radius,\s*centred at\s*(\d{6}N\s*\d{7}E)', rest)
    ring = circle(coords(cm.group(2))[0], float(cm.group(1))) if cm else ring_of(norm(rest))[0]
    vm = re.match(r'(UNL|FL\s*\d+|[\d ]+FT)\s+(GND|SFC|FL\s*\d+|[\d ]+FT)', c[1])
    nm = re.match(r'^([A-Z][A-Z ]+?)\s+(?:A circle|\d)', rest)
    add(ident, f'{ident} {nm.group(1).title() if nm else ""}'.strip(), 'restricted', kind, ring, ft(vm.group(2)) if vm else 0, ft(vm.group(1)) if vm else None, 'ENR 5.1',
        {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind], '内容': (c[2] if len(c) > 2 else '')[:160]})
json.dump({'meta': {'title': 'カンボジア 空域データ', 'source': 'AIP Cambodia（eAIP 2026-09-03 AIRAC）ENR 2.1 / 5.1', 'notes': ['FIR は既存の FIR 表示を使う']}, 'items': items},
          open('/home/claude/kh/out/airspace_kh.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items), [(o['id'], o['lower'], o['upper'], len(o['parts'][0]['ring'])) for o in items if o['layer'] != 'restricted'])
print('skipped', skipped)
