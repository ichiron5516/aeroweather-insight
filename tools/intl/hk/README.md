# 香港（AIP Hong Kong eAIP）→ 航法・空港・空域データ

出典：https://www.ais.gov.hk/eaip_20261001/2026-10-29-000000/html/index-en-US.html（2026-10-29）

## 入力
- `HK_eAIP_2026-10-29_html.json`：ENR 2.x/3.x/4.x/5.x と AD 2 VHHH の HTML
- `HK_eAIP_2026-10-29_pdfs.json`：VHHH の SID・STAR・IAC の PDF（base64）。表は画像のため OCR で読む

## スクリプト（韓国用の kr_lib.py・kr_geom.py を共通で使う）
- `hk_common.py`：香港の HTML を読み込む
- `hk_nav.py` → `nav_db.json`：ENR 4.1・4.4、3.1（ATS 路線・V 路線）・3.3（RNAV 路線）
- `hk_airspace.py` → `airspace_db.json`：ENR 2.1（FIR・TMA・CTR）、5.1（P/R/D）
- `hk_clean.py`：PDF を 300dpi で画像にし、表の罫線を消す（OCR の精度を上げる）→ tesseract --psm 6
- `hk_airport.py` → `airport_db.json`：AD 2.2/2.12/2.13/2.19 と、OCR した「FMC Database Coding Reference」（コーディング表・地点一覧）から SID・STAR・進入方式

## 近似・注意
- SID・STAR・進入方式は OCR で読んだもの。地点の並びと座標は地点一覧で確かめているが、高度・速度は読み違いがありうる（AIP で確認）
- ILS/LOC は最終進入のコーディングがないため、FAF までを経路、その後を進入復行とした
- FIR の中国領海沿いの境界は直線、TMA は「BIGEX から 50NM 以内（2000ft 以上）」と「それ以外（8000ft 以上）」の2つで近似。UCARA は未収録
- ENR 5.5（パラグライダー等）は未収録
