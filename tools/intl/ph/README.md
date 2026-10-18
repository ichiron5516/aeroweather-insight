# フィリピン（AIP Philippines、PDF）→ 航法・空域データ
入力：ユーザーから受け取った ENR 2.1・3.1・3.2・4.1 の PDF（pdftotext -layout で読む）

- `ph_nav.py` → `nav_db.json`：ENR 4.1（無線施設）、ENR 3.1・3.2（航空路。緯度→名前（C/R）→経度の並び、無線施設は「(ZAM)」）
- `ph_airspace.py` → `airspace_db.json`：ENR 2.1 の TMA と Manila ACC のセクター（左の列だけ取り出し、円弧は kr_geom の形に直して読む）
- 空港データ：AD 2 を受け取っていないため空（airport_db.json は空港なし）

## 近似・注意
- ENR 4.4（地点一覧）・5.1（P/R/D）は未受領のため未収録。地点は航空路の表に載っている座標を使う
- 図の「DRAFT」の透かし文字が行頭に混ざるため、名前の前の1文字は読み飛ばしている
