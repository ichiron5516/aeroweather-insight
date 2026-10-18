# ベトナム（AIP Viet Nam eAIP）→ 航法・空港・空域データ
出典：https://aim.vatm.vn/images/stories/vnaic.vn/SanPhamDichVu/AIPVietNam/AIP/2026-10-29-AIRAC/html/index-en-GB.html（2026-10-29 AIRAC）。空港は VVNB・VVTS

- `vn_common.py`：HTML を読み込む（韓国用 kr_lib.py を共通で使う）
- `vn_nav.py` → `nav_db.json`：ENR 4.1・4.4、ENR 3.1（従来の航空路）・3.2（RNAV）
- `vn_airspace.py` → `airspace_db.json`：Noi Bai・Tan Son Nhat TMA、Da Nang・Cam Ranh APP 空域、ENR 5.1（P/R/D）。高さのメートル表記はフィートに換算
- `vn_airport.py` → `airport_db.json`：AD 2 の基本情報（ad_generic.py）＋ PDF の「Tabular description」「Procedure coding」（文字が読める PDF）から SID・STAR・進入。高さ m→ft、距離 km→NM、速度 km/h→kt。地点の座標は PDF の WAYPOINT LIST と AD 2 HTML の地点表から

## 近似・注意
- ACC セクターは地点名でつなぐ記述のため未収録。FIR は既存の FIR 表示を使う
- 表の高度が上下2段（例 -2150 / +1500）に分かれているものは、間の行の値として読んでいる
- SID の移行経路で同じ名前・違う経路のものは「DOVIN TRANSITION (ANTRI)」のように起点を付けて分けた
- ILS Y・VOR など図だけの進入は名前のみ

## 空港について
- 空港データ（airport_db.json）は不要との指示で空にした（2026-10-12）。作成用の vn_airport.py は残しているので、必要になれば作り直せる
