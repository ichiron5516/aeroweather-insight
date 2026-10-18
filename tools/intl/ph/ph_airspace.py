# フィリピン ENR 2.1（PDF）→ airspace_db 形式：TMA・ACC セクター
#   PDF の左の列（名前・範囲・高さ）だけを取り出して読む。FIR は既存の FIR 表示を使う
import re, sys, json, subprocess, collections
sys.path.insert(0, '/home/claude/kr/tools')
from kr_geom import ring_of
CC = 'PH'
t = subprocess.run(['pdftotext', '-layout', '/home/claude/ph/pdf/ENR2.1.pdf', '-'], capture_output=True, text=True).stdout
col = []
for L in t.split('\n'):
    m = re.match(r'^(\s{25,45})(\S.*?)(?:\s{3,}|$)', L)
    if m: col.append(m.group(2).strip())
HEAD = re.compile(r'^([A-Z][A-Z/ ()\-]+?(?:TERMINAL CONTROL(?: AREA)?(?: \(TMA\))?|SECTOR|CONTROL AREA|CONTROL ZONE(?: \(CTR\))?|FIR))$')
blocks, cur = [], None
for s in col:
    if HEAD.match(s) and not re.search(r'\d', s):
        cur = {'name': s, 'body': []}; blocks.append(cur); continue
    if cur is None: continue
    if s in ('AREA (TMA)', '(TMA)', 'AREA') and not cur['body']: cur['name'] += ' ' + s; continue
    cur['body'].append(s)
ALT = r'(UNL|SFC|GND(?:/MSL)?|FL\s*\d{2,3}|[\d,]+\s*FT(?:\s*AGL)?)'
def ft(s):
    s = s.strip()
    if s.startswith('UNL'): return None
    if s.startswith(('SFC', 'GND')): return 0
    m = re.match(r'FL\s*(\d+)', s)
    if m: return int(m.group(1)) * 100
    return int(re.sub(r'\D', '', s))
def norm(g):
    g = g.replace('centered', 'centred')
    # 「along an arc 50 NM radius centred on X (…) counterclockwise」→「counterclockwise arc 50 NM centred on X」
    return re.sub(r'(?:thence\s+)?along an arc\s+([\d.]+\s*NM)\s+radius\s+centred\s+on\s+(\d{6}(?:\.\d+)?N\s*\d{7}(?:\.\d+)?E)(?:\s*\([^)]*\))?\s*(counter\s*clockwise|clockwise)',
                  lambda m: f' {m.group(3)} arc {m.group(1)} centred on {m.group(2)} ', g)
items, skipped = [], []
for b in blocks:
    body = b['body']
    vi = next((k for k, s in enumerate(body) if re.fullmatch(ALT, s)), None)
    if vi is None or vi + 1 >= len(body): skipped.append(b['name']); continue
    geo = ' '.join(body[:vi]); up, lo = ft(body[vi]), ft(body[vi + 1]) if re.fullmatch(ALT, body[vi + 1]) else 0
    cls = next((re.search(r'Class o[fr] Airspace:\s*(\S+)', s).group(1) for s in body if re.search(r'Class o[fr] Airspace', s)), None)
    name = re.sub(r'\s+', ' ', b['name']).strip()
    if 'FIR' in name or 'OCEANIC' in name: continue
    ring, note = ring_of(norm(geo))
    if not ring or len(ring) < 4: skipped.append(name); continue
    if 'SECTOR' in name:
        short = name.replace(' SECTOR', '').title()
        items.append({'id': 'RPHI-' + re.sub(r'[^A-Z]', '', name), 'cat': 'sector', 'layer': 'sector', 'country': CC, 'name': f'Manila ACC {short} セクター', 'short': f'MNL {short.upper()}',
                      'lower': lo, 'upper': up, 'parts': [{'ring': ring, 'lower': lo, 'upper': up}], 'src': 'AIP Philippines ENR 2.1',
                      'info': {'ACC': 'Manila ACC', **({'Class': cls} if cls else {})}})
    else:
        place = name.split(' TERMINAL')[0].split(' SUB-TERMINAL')[0].title()
        sub = 'SUB' in name
        items.append({'id': 'RP-TMA-' + re.sub(r'[^A-Z]', '', place.upper()) + ('-SUB' if sub else ''), 'cat': 'cta', 'layer': 'cta', 'kind': 'tma', 'country': CC,
                      'name': f'{place} {"Sub-TMA" if sub else "TMA"}', 'lower': lo, 'upper': up, 'parts': [{'ring': ring, 'lower': lo, 'upper': up}],
                      'src': 'AIP Philippines ENR 2.1', 'info': {'種別': 'ターミナル管制区（TMA）', **({'Class': cls} if cls else {})}})
json.dump({'meta': {'title': 'フィリピン 空域データ', 'source': 'AIP Philippines ENR 2.1（AIRAC AMDT 005/26）', 'notes': ['FIR は既存の FIR 表示を使う', 'ENR 5.1（P/R/D）はまだ受け取っていないため未収録']},
           'items': items}, open('/home/claude/ph/out/airspace_ph.json', 'w'), ensure_ascii=False)
print(collections.Counter((o['layer'], o.get('kind')) for o in items))
print([(o['id'], o['lower'], o['upper'], len(o['parts'][0]['ring'])) for o in items])
print('skipped', skipped)
