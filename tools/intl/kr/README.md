# 韓国（AIP Korea eAIP）→ 航法・空港・空域データ

出典：https://aim.koca.go.kr/eaipPub/Package/2026-10-28-AIRAC/html/index-en-GB.html（2026-10-28 AIRAC）

## 入力
- `KR_eAIP_2026-10-28_html.json`：eAIP の HTML（ENR 2.1/2.2/3.x/4.1/4.4/5.x、AD 2 RKSI・RKSS）をまとめたもの
- `KR_RKSI_SID.pdf` などの AD2 チャート PDF（SID・STAR・INSTR APCH CHART）

## スクリプト
- `kr_lib.py`：HTML の読み込み（改訂で削除された記述＝AmdtDeleted は除く）、座標、測地計算
- `kr_geom.py`：区域の境界の文章（座標・円・円弧・北方限界線沿い・金浦50NM円弧）→ 多角形、高度の上下限
- `kr_nav.py` → `nav_db.json`：ENR 4.1 無線施設、4.4 地点、3.1/3.3 航空路（▲は義務通報点）
- `kr_airspace.py` → `airspace_db.json`：ENR 2.1 FIR・TMA・ACC セクター・管制圏、5.1 P/R/D、5.2 MOA・ACMI・KADIZ・警戒区域、5.3 CATA
- `kr_airport.py` → `airport_db.json`：AD 2.2/2.12/2.13/2.17/2.19、SID・STAR のコーディングテーブル、進入方式のデータ表・コーディングテーブル

## 近似・未収録
- 北方限界線・軍事境界線に沿う境界は概略の折れ線（FIR、West-sea / East-sea セクター、P518）
- P73 は2つの円を包む形、管制圏の「重なる部分を除く」は省略
- ENR 5.5（超軽量機）・2.2（ATZ ほか）は未収録
- RKSS の RNP・VOR 進入はチャート PDF にデータ表がないため経路なし（名前と滑走路のみ）
- STAR の一部は PDF の見出しに滑走路がなく「全滑走路」として収録
- 同じ名前の航空路が日本側とつながらないときは「名前~KR」で別に持つ（dbLoader.js）
