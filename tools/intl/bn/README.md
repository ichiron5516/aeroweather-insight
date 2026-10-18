# ブルネイ（AIP Brunei Darussalam、PDF）→ 航法・空港・空域データ
出典：https://www.dca.gov.bn/eaip/（AIP AMDT 01/2026、2026-06-20）

- `bn_all.py`：ENR 4.1（BRU DVOR/DME・BR NDB）と ENR 3.1 の地点、AD 2 WBSB の基本情報（滑走路 03/21）、Brunei CTR（17NM の円で近似）
- 航空路はマレーシア AIP に同じものが載っているのでそちらを使う。Brunei TMA もマレーシアのデータを使う
- WBSB は SID・STAR の設定がない（レーダー誘導）。進入（ILS・DVOR/DME・NDB）は図のみで名前だけ収録

## 空港について
- 空港データ（airport_db.json）は不要との指示で空にした（2026-10-12）。作成用の bn_all.py（空港部分） は残しているので、必要になれば作り直せる
