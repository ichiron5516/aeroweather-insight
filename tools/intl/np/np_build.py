# ネパール（AIP Nepal ENR 3.3 RNAV 航空路、PDF）→ 航法データ（2026-10-18）
#   入力：ユーザーから受け取った ENR 3.3 の PDF（5 ページ、8th EDITION、ページの日付 2022 年 7 月 1 日など）
#   左の列に地点名・「'KTM' VOR」・緯度・経度（緯度と経度は別の行）。地点一覧（ENR 4.4）は無いので、航空路の表の座標を使う
#   出力：nav_db.json（空港は METAR・TAF の白丸のまま）
#   使い方：python np_build.py <ENR 3.3 の PDF> <出力フォルダ>
import json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'common'))
from layout_routes import Store, routes_from_layout, finish

PDF, OUT = sys.argv[1], sys.argv[2]
text = subprocess.run(['pdftotext', '-layout', PDF, '-'], capture_output=True, text=True).stdout
st = Store('NP')
rts, dists = routes_from_layout(text, st, left=22)
airways = finish(st, rts)
match = lambda v: any(abs(x - v) <= max(1.5, 0.03 * v) for x in dists)
tot = sum(len(a['segments']) for a in airways.values())
ok = sum(1 for a in airways.values() for s in a['segments'] if match(s['nm']))
print(f'地点 {len(st.fixes)}・航空路 {len(airways)}・確かめ：区間 {tot} のうち {ok} が PDF の距離と一致')
print('合わない区間', [f"{d} {a['points'][i]}-{a['points'][i + 1]} {s['nm']}" for d, a in airways.items() for i, s in enumerate(a['segments']) if not match(s['nm'])])
for d, a in airways.items(): print(d, ' '.join(a['points']))
os.makedirs(OUT, exist_ok=True)
json.dump({'meta': {'title': 'ネパール 航法データ', 'sources': ['AIP Nepal ENR 3.3 RNAV 航空路'], 'aipEffective': '8th EDITION（ページの日付 2022 年ほか）'},
           'fixes': st.fixes, 'airways': airways}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
