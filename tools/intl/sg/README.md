# シンガポール（AIP Singapore eAIP）→ 航法・空港・空域データ

出典：https://aim-sg.caas.gov.sg/aim-content/uploads/aip/08-OCT-2026/AIP/2026-09-03-000000/html/index-en-GB.html（2026-09-03）

## 入力
- `SG_html.json`：ENR 2.x/3.x/4.x/5.x と AD 2 WSSS の HTML
- `titles.json`・`pdf/*.pdf`：WSSS の SID・STAR・IAC の PDF（95 枚、文字のある PDF なので pdftotext で読む）

## スクリプト（韓国用の kr_lib.py・kr_geom.py・ad_generic.py を共通で使う）
- `sg_common.py`：シンガポールの HTML を読み込む
- `sg_nav.py` → `nav_db.json`：ENR 4.1・4.4（ターミナルの地点を含む）、ENR 3.x（航空路）
- `sg_airspace.py` → `airspace_db.json`：Singapore FIR、Singapore/Johor 空域、Tanjungpinang TMA/CTR、ENR 5.1（P/R/D）
- `sg_airport.py` → `airport_db.json`：AD 2 の基本情報（ad_generic.py）＋「Tabular Description」から SID 63・STAR 19・RNP 進入。進入図にしかない地点（IGODO など）は IAC の座標表から

## 近似・注意
- ILS・VOR 進入は図だけでコーディング表がないため、名前のみ収録（経路は表示しない）
- 「BTN LAT/LONG」で書かれた空域は四角形、円2つで書かれた空域はその外形で近似。WSR6 は未収録
