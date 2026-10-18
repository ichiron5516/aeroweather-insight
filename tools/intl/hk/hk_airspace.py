# 香港 ENR 2.1（FIR・TMA・CTR）・5.1（P/R/D）→ airspace_db 形式
import re, sys, json, collections
sys.path.insert(0, '/home/claude/hk/tools')
from hk_common import *
from kr_geom import ring_of, vlim
SP = re.compile(r'(\d{2}) (\d{2}) (\d{2}(?:\.\d+)?)([NS]) (\d{3}) (\d{2}) (\d{2}(?:\.\d+)?)([EW])')
def unspace(t): return SP.sub(lambda m: f'{m[1]}{m[2]}{m[3]}{m[4]} {m[5]}{m[6]}{m[7]}{m[8]}', t)
items = []
BIGEX = None
nav = json.load(open('/home/claude/hk/out/nav_hk.json'))['fixes']
BIGEX = [nav['BIGEX']['lon'], nav['BIGEX']['lat']]
tabs = soup('ENR-2.1').find_all('table')
def col0(t): return [unspace(txt(r.find_all(['td', 'th'], recursive=False)[0])) for r in t.find_all('tr') if r.find_all(['td', 'th'], recursive=False)]
for t in tabs:
    L = col0(t); txt_all = ' \n'.join(L)
    pts = coords(txt_all)
    if '1. HONG KONG FIR' in txt_all:
        items.append({'id': 'VHHK', 'cat': 'fir', 'layer': 'fir', 'name': '香港FIR（Hong Kong FIR）', 'short': 'HONG KONG FIR', 'lower': 0, 'upper': None, 'country': 'HK',
                      'parts': [{'ring': close(pts[:-1] if pts[0] == pts[-1] else pts), 'lower': 0, 'upper': None, 'note': '中国の領海沿いの境界は直線で近似'}],
                      'src': 'AIP Hong Kong ENR 2.1', 'info': {'Class': 'A, C, G', 'ACC': 'Hong Kong ACC'}})
    elif '2. HONG KONG TMA' in txt_all:
        ring = close(pts[:-1] if pts[0] == pts[-1] else pts)
        items.append({'id': 'VH-TMA', 'cat': 'cta', 'layer': 'cta', 'kind': 'tma', 'country': 'HK', 'name': 'Hong Kong TMA', 'lower': 2000, 'upper': None,
                      'parts': [{'ring': ring, 'lower': 8000, 'upper': None, 'label': 'BIGEX 50NM 外'},
                                {'ring': circle(BIGEX, 50, 96), 'lower': 2000, 'upper': None, 'label': 'BIGEX 50NM 以内', 'note': 'CTR・UCARA の上は 9000ft から（省略）'}],
                      'src': 'AIP Hong Kong ENR 2.1', 'info': {'種別': 'ターミナル管制区（TMA）', 'Class': 'A（8000ft 以上）・C', '管制': 'Hong Kong ACC/APP'}})
    elif '3. HONG KONG CONTROL ZONE' in txt_all:
        items.append({'id': 'VH-CTR', 'cat': 'cta', 'layer': 'cta', 'kind': 'ctr', 'country': 'HK', 'name': 'Hong Kong 管制圏（CTR）', 'lower': 0, 'upper': 9000,
                      'parts': [{'ring': close(pts), 'lower': 0, 'upper': 9000}], 'src': 'AIP Hong Kong ENR 2.1', 'info': {'種別': '管制圏', 'Class': 'C', '管制': 'Hong Kong TWR/ZNC/APP'}})
# ---- ENR 5.1 ----
for r in soup('ENR-5.1').find_all('tr'):
    c = [unspace(txt(x)) for x in r.find_all(['td', 'th'], recursive=False)]
    if len(c) < 3 or not re.match(r'^(VH[PRD]\d+|ZJ)', c[0]): continue
    ident = c[0].replace(' ', '')
    geo = c[1].replace(',', ' -')
    if 'Sectors' in geo:
        cc = coords(geo)[0]; ring = circle(cc, 3000 / 6076.1); note = '扇形2つ（090°–120°・230°–270°）を円で近似'
    else:
        ring, note = ring_of(geo if 'ircle' in geo else ' - '.join(re.findall(r'\d{6}(?:\.\d+)?N \d{7}(?:\.\d+)?E', geo)))
    vt = c[2].replace('ALT', '').strip()
    m = re.match(r'([\d ]+)\s*(ft|m)\s+(SFC|GND|[\d ]+\s*(?:ft|m))', vt)
    if m:
        k = 3.28084 if m.group(2) == 'm' else 1
        up = round(int(m.group(1).replace(' ', '')) * k); lo = 0 if m.group(3) in ('SFC', 'GND') else round(int(re.sub(r'\D', '', m.group(3))) * (3.28084 if m.group(3).endswith('m') else 1))
    else: lo, up = 0, None
    kind = {'P': 'prohibited', 'R': 'restricted', 'D': 'danger'}[ident[2]] if ident.startswith('VH') else 'danger'
    name = re.sub(r'\s*(Sectors|Circle|\d{6}).*', '', c[1]).title() or '（中国 広東省沖）'
    items.append({'id': ident, 'cat': 'restricted', 'layer': 'restricted', 'kind': kind, 'country': 'HK', 'name': f'{ident} {name}', 'lower': lo, 'upper': up,
                  'parts': [{'ring': ring, 'lower': lo, 'upper': up, **({'note': note} if note else {})}], 'src': 'AIP Hong Kong ENR 5.1',
                  'info': {'種別': {'prohibited': '飛行禁止区域', 'restricted': '飛行制限区域', 'danger': '危険区域'}[kind], '内容': c[3][:120] if len(c) > 3 else ''}})
json.dump({'meta': {'title': '香港 空域データ', 'source': 'AIP Hong Kong（eAIP 2026-10-29）ENR 2.1 / 5.1'}, 'items': items}, open('/home/claude/hk/out/airspace_hk.json', 'w'), ensure_ascii=False)
for o in items: print(o['id'], o['name'], [(len(p['ring']), p['lower'], p['upper']) for p in o['parts']])
