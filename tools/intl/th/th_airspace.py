# タイ ENR 2.1（バンコク TMA・CTR と地方空港の CTR・TMA）・5.1（P/R/D・TRA）→ airspace_db 形式
#   FIR・ACC セクターは「国境・FIR 境界に沿う」記述のため省略（FIR 境界は既存の FIR 表示を使う）
import re, sys, json, collections
sys.path.insert(0, '/home/claude/th/tools')
from th_common import *
from kr_geom import ring_of, vlim
items, skipped = [], []
def add(id_, name, layer, kind, cat, geo, vt, src, info):
    if 'semi-circle' in geo.lower():
        m = re.search(r'([\d.]+)\s*NM radius of\s*(\d{6}N\s*\d{7}E)\s*from\s*(\d+)°\s*to\s*(\d+)°', geo)
        if m:
            c = coords(m.group(2))[0]; r = float(m.group(1)); b1, b2 = float(m.group(3)), float(m.group(4))
            d = (b2 - b1) % 360 or 360; n = int(d / 3)
            ring = close([c] + [dest(c[0], c[1], b1 + d * i / n, r) for i in range(n + 1)]); note = ''
        else: ring, note = None, ''
    else: ring, note = ring_of(geo)
    if not ring: skipped.append(f'{id_}: {geo[:70]}'); return
    v = vlim(vt) if vt else None
    lo, up, agl = v if v else (0, None, False)
    if up is not None and up > 60000: up = None
    if any(o['id'] == id_ for o in items): id_ += f'-{sum(o["id"].startswith(id_) for o in items) + 1}'
    if 'follow the boundary' in geo or 'coastline' in geo: note = (note + '・' if note else '') + '国境・海岸線に沿う区間は直線で近似'
    items.append({'id': id_, 'cat': cat, 'layer': layer, 'kind': kind, 'country': 'TH', 'name': name, 'lower': lo, 'upper': up,
                  'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'agl': True} if agl else {}), **({'note': note} if note else {})}],
                  'src': f'AIP Thailand {src}', 'info': {**info, **({} if v else {'高度': '記載なし／NOTAM'})}})

# ---- ENR 2.1 ----
SEG = re.compile(r'(?:(?<=\s)|^)(?:[A-Ea-e]\.\s+)?([A-Z][A-Za-z\- ]{2,30}?)\s+(CONTROL ZONE|TERMINAL CONTROL AREA|TERMINAL CONTOL AREA)\b')
for r in soup('ENR-2.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if not c: continue
    t = c[0]
    ms = list(SEG.finditer(t))
    for i, m in enumerate(ms):
        body = t[m.end():ms[i + 1].start() if i + 1 < len(ms) else len(t)]
        body = re.split(r'Sectorization|Class of airspace', body)[0] + ' ' + (re.search(r'Class of airspace\s*:?\s*([A-G])', t[m.end():]) or ['', ''])[0]
        place = m.group(1).strip().title().replace('Bangkok', 'Bangkok')
        kind = 'ctr' if 'ZONE' in m.group(2) else 'tma'
        vt = re.search(r'((?:FL\s*\d+|ALT\s*[\d ]+ft|[\d ]+ft(?:\s*AGL)?)\s*/\s*(?:GND|SFC|[\d ]+\s*ft(?:\s*AGL)?))', body)
        vtx = (vt.group(1).replace('ALT', '') if vt else '')
        if not vt:
            m2 = re.search(r'up to but not including\s*([\d ]+\s*ft(?:\s*AGL)?)', body)
            if m2: vtx = m2.group(1) + ' / GND'
        cls = re.search(r'Class of airspace\s*:?\s*([A-G])', body)
        add(f'VT-{"CTR" if kind == "ctr" else "TMA"}-{re.sub(r"[^A-Z]", "", place.upper())}', f'{place} {"管制圏（CTR）" if kind == "ctr" else "TMA"}', 'cta', kind, 'cta',
            body, vtx, 'ENR 2.1', {'種別': '管制圏' if kind == 'ctr' else 'ターミナル管制区（TMA）', **({'Class': cls.group(1)} if cls else {})})
# ---- ENR 5.1 ----
for r in soup('ENR-5.1').find_all('tr'):
    c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 2: continue
    m = re.match(r'^(VT([PRD])\d+[A-Z]?|TRA\s*\S+)\s+(.+?)\s+(?=Area bounded|Circle|A semi-circle|An area|The area|\d{4})', c[0], re.I)
    if not m: continue
    ident = m.group(1).replace(' ', ''); k = m.group(2)
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}.get(k, 'warning')
    add(ident, f'{ident} {m.group(3).title()}', 'restricted', kind, 'restricted', c[0][m.end():], c[1].replace('ALT', ''), 'ENR 5.1',
        {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域', 'warning': '臨時留保空域（TRA）'}[kind], '内容': (c[2] if len(c) > 2 else '')[:160]})
json.dump({'meta': {'title': 'タイ 空域データ', 'source': 'AIP Thailand（eAIP 2026-10-29 AIRAC）ENR 2.1 / 5.1', 'notes': ['FIR・ACC セクターは国境・FIR 境界に沿う記述のため未収録']}, 'items': items},
          open('/home/claude/th/out/airspace_th.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o['kind']) for o in items))
print([(o['id'], o['lower'], o['upper']) for o in items if o['layer'] == 'cta'])
print('skipped', len(skipped)); print('\n'.join(skipped[:30]))
