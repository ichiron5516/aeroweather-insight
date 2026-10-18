# バングラデシュ（AIP Bangladesh、PDF）→ 航法データ（2026-10-18）
#   入力：ユーザーから受け取った ENR 全体の PDF（156 ページ。ページの日付は 2010〜2026 年、AIP AMDT 03/26 まで）
#     ENR 3.1（国際・国内の航空路）・3.2・3.3、ENR 4.1（無線施設）、ENR 4.3（地点。この AIP では 4.3 が地点一覧）
#   出力：nav_db.json（空港は METAR・TAF の白丸のまま。空港データは作らない）
#   使い方：python bd_build.py <ENR の PDF> <出力フォルダ>
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'common'))
from layout_routes import Store, LAT, LON, dms, nm, routes_from_layout, finish

PDF, OUT = sys.argv[1], sys.argv[2]
def pages(a, b): return subprocess.run(['pdftotext', '-layout', '-f', str(a), '-l', str(b), PDF, '-'], capture_output=True, text=True).stdout
def find(label):
    """「ENR 3.1-1」のようなページ番号の書かれたページを探す"""
    n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', PDF], capture_output=True, text=True).stdout)[1])
    return [p for p in range(1, n + 1) if re.search(label, pages(p, p)[:400])]
st = Store('BD')
rep = []

# ---------- ENR 4.1 無線施設（DVOR と DME が別の行。同じ識別符号はまとめて VOR/DME） ----------
p41 = find(r'ENR 4\.1-\d')
lines = pages(min(p41), max(p41)).splitlines()
navs = {}
for i, l in enumerate(lines):
    m = re.search(r'^\s*(.*?)\s*\b([A-Z]{2,3})\s+([\d.]+)\s*(MHz|kHz|MHZ|KHZ)\s+\S+\s+' + LAT + r'\s*' + LON, l)
    if not m: continue
    name = m[1].strip(' ,')
    # 名前が折り返されている（「CHATTOGRAM,」／ID の行／「DVOR」）
    prev, nxt = lines[i - 1].strip() if i else '', lines[i + 1].strip() if i + 1 < len(lines) else ''
    if not name and prev.endswith(','): name = prev.rstrip(',') + ', ' + nxt
    ty = 'NDB' if 'NDB' in name else 'DME' if re.search(r'\bDME\b', name) else 'DVOR' if 'VOR' in name else ''
    nm_ = re.sub(r',?\s*(DVOR|VOR|DME|NDB)\b', '', name).strip(' ,').upper()
    f = navs.setdefault(m[2], {'lat': dms(*m.groups()[4:8]), 'lon': dms(*m.groups()[8:12]), 'type': 'navaid', 'name': nm_, 'types': set(), 'freq': ''})
    f['types'].add(ty)
    fq = float(m[3])
    if m[4].lower() == 'khz' or (108 <= fq <= 118): f['freq'] = f"{fq:g}{'kHz' if m[4].lower() == 'khz' else 'MHz'}"
for k, f in navs.items():
    t = f.pop('types'); f['navaidType'] = 'VOR/DME' if ('DVOR' in t and 'DME' in t) else 'DVOR' if 'DVOR' in t else 'NDB' if 'NDB' in t else 'DME'
    st.put(k, f)
rep.append(f'ENR 4.1 無線施設 {len(navs)}')

# ---------- ENR 4.3 地点 ----------
p43 = find(r'ENR 4\.3-\d')
n43 = 0
for l in pages(min(p43), max(p43)).splitlines():
    m = re.match(r'^\s*([A-Z]{5})\s+' + LAT + r'\s*' + LON, l)
    if m: st.put(m[1], {'lat': dms(*m.groups()[1:5]), 'lon': dms(*m.groups()[5:9]), 'type': 'waypoint'}); n43 += 1
st.trust = set(st.fixes)
rep.append(f'ENR 4.3 地点 {n43}')

# ---------- ENR 3.1〜3.3 航空路 ----------
p3 = find(r'ENR 3\.[123]-\d')
text = pages(min(p3), max(p3))
rts, dists = routes_from_layout(text, st, left=27)
airways = finish(st, rts)
rep.append(f'ENR 3 航空路 {len(airways)}')
ok = sum(1 for a in airways.values() for s in a['segments'] if any(abs(x - s['nm']) <= max(1.5, 0.03 * s['nm']) for x in dists))
tot = sum(len(a['segments']) for a in airways.values())
rep.append(f'確かめ：区間 {tot} のうち {ok} が PDF の距離と一致')
bad = [f"{d} {a['points'][i]}-{a['points'][i + 1]} {s['nm']}" for d, a in airways.items() for i, s in enumerate(a['segments']) if not any(abs(x - s['nm']) <= max(1.5, 0.03 * s['nm']) for x in dists)]

os.makedirs(OUT, exist_ok=True)
json.dump({'meta': {'title': 'バングラデシュ 航法データ', 'sources': ['AIP Bangladesh ENR 3.1〜3.3', 'ENR 4.1', 'ENR 4.3'], 'aipEffective': 'AIP AMDT 03/26（ページの日付 2010〜2026 年）'},
           'fixes': st.fixes, 'airways': airways}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
print('\n'.join(rep)); print('合わない区間', bad[:30])
for d, a in list(airways.items()): print(d, ' '.join(a['points']))
