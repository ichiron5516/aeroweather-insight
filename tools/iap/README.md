# 進入方式（IAP）の抽出

AIP Japan AD2 の PDF（`ICAO__YYYYMMDD.pdf`）の進入方式チャート（AD2.24-IAC）から、
空港DB（`public/data/nav/airport_db.json`）の `approaches` を作ります。

```powershell
pip install pdfplumber
python extract_iap.py <AD2のPDFがあるフォルダ> raw      # チャートごとの題名・地点・座標・進入復行の文
python build_iap.py                                   # airport_db.json と nav_db.json を同じフォルダに置いて実行
#   → airport_db.out.json（approaches を追加した空港DB）と iap_report.txt（要確認の一覧）
```

`extract_iap.py` は、題名が文字として取れないページで pdftotext の結果を使います。
スクリプト内の `/home/claude/aip/<ICAO>__*.txt` を手元のパスに合わせてください（`pdftotext -layout` で作成）。

## 収録内容（approaches の1件）

- `name`（例：ILS Z or LOC Z RWY06L (CAT Ⅱ)）、`kind`（ILS・LOC・VOR・RNP・GLS・LDA・TACAN）、`runways`（周回進入は ALL）、`chartPages`
- `fixes`：IAF・IF・FAF・MAPt・MAHF の地点名、`fafAltFt`：FAF の高度（降下角の表から）
- `routes`：IAF ごとの地点列（IAF→IF→FAF→MAPt）。表示側で滑走路 THR につなぐ
- `missed`：進入復行の待機点、`missedApproach`：進入復行方式の文
- `warnings`：座標が分からない地点など

チャートで座標が分かった新しい地点（RNP の MAPt など）は `waypoints` に追加しています。

## 限界

- 地点を直線で結んだ概略です。DMEアーク、RF（円弧）、旋回の形、ステップダウンフィックスは再現していません
- 最低気象条件（DA/MDA）は収録していません
- 進入復行方式の文はチャートから文字を拾ったもので、一部に図中の文字が混ざることがあります
- 訓練・教育用です。実運航には使わないでください
