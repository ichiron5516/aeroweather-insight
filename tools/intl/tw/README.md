# 台湾（AIP Taiwan eAIP）→ 航法・空港・空域データ

出典：https://ais.caa.gov.tw/eaip/AIRAC%20AIP%20AMDT%2005-26_2026_10_29/index.html（AIRAC AMDT 05-26、2026-10-29）

## 入力
- `TW_eAIP_2026-10-29_html.json`：ENR 2.x/3.x/4.x/5.x と AD 2 RCTP・RCKH の HTML
- `TW_eAIP_2026-10-29_pdfs.json`：RCTP・RCKH の SID・STAR・進入チャート PDF（base64）

## スクリプト（韓国用の kr_lib.py・kr_geom.py を共通で使う）
- `tw_common.py`：台湾の HTML を読み込む
- `tw_nav.py` → `nav_db.json`：ENR 4.1・4.4、ENR 3.1/3.2（1ページ1路線、TRANSITION 路線を含む）
- `tw_airspace.py` → `airspace_db.json`：ENR 2.1（FIR・TMA・C/D/E 類空域）、5.1（制限区域）、5.2（軍の演習・訓練空域、ADIZ）、5.3（民間訓練空域）
- `tw_airport.py` → `airport_db.json`：AD 2.2/2.12/2.13/2.17/2.19、「Aeronautical Data of …」PDF（地点一覧＋コーディング表）から RNAV SID・STAR・RNP 進入。STAR の滑走路は AD 2.22 の表から

## 近似・未収録
- ILS・LOC・NDB 進入と、従来型（VOR/NDB 基準）の SID・STAR はチャート図だけでデータ表がないため、名前と滑走路のみ（ILS/LOC/NDB）または未収録（従来型 SID・STAR）
- 5.2.4 無人機訓練区域、5.3.2 その他の危険（点の位置だけ）、5.5 は未収録
- 日本の地点と同じ名前で離れているもの（CANDY・CAROL・ROBIN など）は「名前~TW」で持つ（dbLoader.js）
