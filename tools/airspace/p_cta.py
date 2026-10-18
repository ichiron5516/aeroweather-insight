# ENR 2.1 2. 航空交通管制区（Control Area）：A 半径20NM（700ft AGL 以上）、B 半径40NM（1000ft）、C 区域（2000ft）
import re, json
from lib import *

# 英語（右半分）の列だけを行ごとにつなぐ
def eng(pn):
    W = words(pn); mid = pdf().pages[pn - 1].width / 2 - 22
    return [' '.join(w['text'] for w in l) for l in lines([w for w in W if w['x0'] >= mid])]
arp = {}
for pn in (152, 153):
    for line in eng(pn):
        m = re.match(r'^(.+?)\s+(\d{4}N\d{5}E)(?:\s*\(([A-Za-z ]+?)\s*ARP\))?$', line)
        if not m: continue
        nm = m.group(1).strip()
        if m.group(3): nm = 'Fukuoka' if 'FUKUOKA' in m.group(3) else 'Fukuoka NATA'
        if nm in ('Airport/Aerodrome', 'ARP'): continue
        c = CO4.match(m.group(2)).groups()
        arp.setdefault(nm, [int(c[2]) + int(c[3]) / 60, int(c[0]) + int(c[1]) / 60])
# 福岡は「(FUKUOKA ARP)」の行に名前がない（標点 A：3335N13027E）
arp.setdefault('Fukuoka', [130 + 27 / 60, 33 + 35 / 60]); arp.pop('Fukuoka NATA', None)
print('ARP', len(arp), list(arp)[:5], list(arp)[-5:])
E154 = ' '.join(eng(154))
bm = re.search(r'124E\)\.\s*(Sapporo.*?)\s+airport/', E154)
bnames = [x.strip() for x in re.split(r',\s*|\s+and\s+', re.sub(r'\(FUKUOKA ARP\)', '', bm.group(1))) if x.strip()] if bm else []
print('B', len(bnames), bnames)
out = []
def key(n):
    n = n.replace('centrair', '').replace('INTL', '').strip().lower()
    for k in arp:
        if k.replace('INTL', '').strip().lower() == n or k.lower().startswith(n): return k
    return None
for k, c in arp.items():
    if k == 'Fukuoka NATA': continue
    out.append({'id': f'CTA-A-{k}', 'cat': 'cta', 'name': f'管制区 {k}（半径20NM・700ft AGL以上）', 'lower': 700, 'upper': None, 'agl': True,
                'parts': [{'ring': circle(c, 20), 'lower': 700, 'upper': None}], 'src': 'ENR 2.1 2.A', 'info': {'区分': 'A：標点から半径20NM、地表から700ft以上'}})
miss = []
for n in bnames:
    k = key(n)
    if not k: miss.append(n); continue
    out.append({'id': f'CTA-B-{k}', 'cat': 'cta', 'name': f'管制区 {k}（半径40NM・1000ft AGL以上）', 'lower': 1000, 'upper': None, 'agl': True,
                'parts': [{'ring': circle(arp[k], 40), 'lower': 1000, 'upper': None}], 'src': 'ENR 2.1 2.B', 'info': {'区分': 'B：標点から半径40NM、地表から1000ft以上'}})
print('B missing', miss)
# ---- C：英語の「Area within a line connecting …」の点列 ----
flat = E154
cm = re.search(r'Area within a line connecting (.*?)in consecutive order', flat)
eng = cm.group(1) if cm else ''
print('C text', eng[:200])
# 日本語と英語が交互に混ざるので、英語の地点だけ（名前(座標) または 座標）を順に拾う
seq = re.findall(r'(\d{4}N\d{5}E)', eng)
pts = []
for s in seq:
    c = CO4.match(s).groups(); p = [int(c[2]) + int(c[3]) / 60, int(c[0]) + int(c[1]) / 60]
    if not pts or pts[-1] != p: pts.append(p)
print('C points', len(pts))
out.append({'id': 'CTA-C', 'cat': 'cta', 'name': '管制区 C（2000ft AGL以上）', 'lower': 2000, 'upper': None, 'agl': True,
            'parts': [{'ring': close(pts + [[145 + 50 / 60, 43 + 20 / 60]]), 'lower': 2000, 'upper': None}], 'src': 'ENR 2.1 2.C',
            'info': {'区分': 'C：北海道〜先島諸島を囲む区域、地表から2000ft以上（A・B を除く）'}})
ijt = navaid('IJT')
if ijt: out.append({'id': 'CTA-C2', 'cat': 'cta', 'name': '管制区 硫黄島（半径55NM・2000ft AGL以上）', 'lower': 2000, 'upper': None, 'agl': True,
                    'parts': [{'ring': circle(ijt, 55), 'lower': 2000, 'upper': None}], 'src': 'ENR 2.1 2.C', 'info': {'区分': 'C：硫黄島TACAN から半径55NM'}})
json.dump(out, open('cta.json', 'w'), ensure_ascii=False)
print(len(out))
