# 中国（AIP China eAIP）→ 航法・空港・空域データ
出典：https://www.eaipchina.cn/e-AIP（AIRAC 2026-10、EFF 2026-09-30。ログインが必要）。空港は ZSPD のみ

- 入力：eAIP の画面が読み込む JSON（GeneralDoc/<jsId>.js）＝ ENR 2.1.3（CTA）・2.1.5（APP）・3.2・3.3・4.1・4.4・5.1・5.2、ZSPD の AD 2 PDF、WAYPOINT LIST・DATABASE CODING TABLE の PDF
- `cn_all.py` → `nav_db.json`・`airspace_db.json`・`airport_db.json`

## 近似・注意
- 高さはメートル表記なのでフィートに換算。空域の「National Boundaries」区間は直線で近似。FIR は既存の FIR 表示を使う
- ZSPD の滑走路の端の座標は AIP で公開されていない（Nil）ため、ARP（17L/35R の中心）と AD 2.12 の位置関係（滑走路間隔・ずれ）から計算した近似。進入の FAF→滑走路の向きは 162°/342° で一致することを確認
- コーディング表の高度：上下2段は上限・下限として読む。1つだけの値は「以上・以下」の区別が図の線にしかないため、数値の範囲は付けず表記だけ残した
- ILS 進入は FAF までの移行経路と進入復行のみコーディングあり（最終進入は直線で表示）
