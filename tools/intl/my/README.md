# マレーシア（AIP Malaysia eAIP）→ 航法・空港・空域データ
出典：https://aip.caam.gov.my/aip/eAIP/2026-10-29-AIRAC/html/index-en-MS.html（2026-10-29 AIRAC）。空港は WMKK

- `my_nav.py` → `nav_db.json`：ENR 4.1・4.4、ENR 3.1・3.2・3.3（タイ用 th_nav.py と同じ形の表）
- `my_airspace.py` → `airspace_db.json`：ENR 2.1 の TMA（KL TMA 1〜7、Butterworth、Kuantan、Kota Bharu、Kota Kinabalu、Brunei など）、ENR 5.1（P/R/D）
- `ocr_all.sh`：手順の PDF は文字が化けている（フォントの対応表がない）ため、300dpi で画像化して OCR
- `my_airport.py` → `airport_db.json`：AD 2 の基本情報 ＋ OCR した TABULAR DESCRIPTION から SID・STAR。進入は表の OCR が崩れるため、地点一覧の役割（IF・FAF・MAPT）と表に出てくる地点の順から組み立てた

## 近似・注意
- 「TMA boundaries」「FIR BDRY」に沿う区間は直線で近似。Johor Bahru・Kuching・Sibu TMA など一部は図形を読めず未収録
- OCR の読み違いがありうる。座標が見つからない地点（KK25 など）はその区間を飛ばした
- RNP Z (AR) は経路なし（図のみ）

## 空港について
- 空港データ（airport_db.json）は不要との指示で空にした（2026-10-12）。作成用の my_airport.py は残しているので、必要になれば作り直せる
