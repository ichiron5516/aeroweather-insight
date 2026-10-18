# タイ（AIP Thailand eAIP）→ 航法・空港・空域データ

出典：https://aip.caat.or.th/2026-10-29-AIRAC/html/index-en-GB.html（2026-10-29 AIRAC）

## 入力
- `TH_html.json`：ENR 2.x/3.x/4.x/5.x と AD 2 VTBS の HTML
- `titles.json`・`pdf/*.pdf`：VTBS の SID・STAR・IAC の PDF（169 枚、画像のため OCR で読む）

## スクリプト（韓国用の kr_lib.py・kr_geom.py・ad_generic.py を共通で使う）
- `th_common.py`：タイの HTML を読み込む（隠れた AIXM 用の文字 `sdParams` は除く）
- `th_nav.py` → `nav_db.json`：ENR 4.1（航法援助施設）・4.4（地点）、ENR 3.x（航空路）
- `th_airspace.py` → `airspace_db.json`：Bangkok TMA/CTR、地方空港の CTR/TMA、ENR 5.1（P/R/D、半円も対応）
- `ocr_all.sh`：PDF を 300dpi で画像化 → 罫線を消す（../hk/hk_clean.py）→ tesseract --psm 6
- `th_airport.py` → `airport_db.json`：AD 2 の基本情報（ad_generic.py）＋ OCR した「TABULAR DESCRIPTION」と「WAYPOINT LIST」から SID・STAR・進入方式（RNP・ILS）

## 近似・注意
- SID・STAR・進入方式は OCR で読んだもの。地点の座標は複数の図の地点一覧で多数決、高度・速度は読み違いがありうる（AIP で確認）
- SID の名前は「最後の地点 ＋ 図の番号と記号（3K など）」で付け直した（見出しの OCR が崩れることがあるため）
- STAR の移行経路（TRANSITION）は「LEBIM2C (GUTSO)」のように別の手順として収録
- FIR 境界と管制セクターは未収録。上限が FL600 を超える空域は上限なしとした。図形を読めなかった空域が 3 つある
