# 空域データベースの作り方（AIP Japan ENR）

`airspace_db.json`（public/data/airspace/）は AIP Japan の ENR PDF から作っています。

| スクリプト | 内容 | AIP |
|---|---|---|
| p_acc.py | 福岡FIR・ACCセクター（T/F/N/A） | ENR 2.1 |
| p_cta.py | 航空交通管制区（A：半径20NM・B：40NM・C：2000ft 以上の区域） | ENR 2.1 2. |
| p_r51.py | 飛行制限区域 RJR1〜3、空域制限（R- / W- / 演習場） | ENR 5.1 |
| p_r52.py | 自衛隊 低高度・高高度訓練／試験空域 | ENR 5.2 1.・2. |
| p_r52b.py | Area S、超音速飛行空域、専用回廊、防空識別圏 | ENR 5.2 2.〜5. |
| p_r53.py | 民間訓練試験空域 | ENR 5.3 1.1 |
| build_db.py | まとめて airspace_db.json を作り、範囲・高度を検査 | |

```powershell
pip install pdfplumber
# lib.py の PDF のパス、航法DB（nav_db.json・airport_db.json）のパスを手元に合わせる
python p_acc.py; python p_cta.py; python p_r51.py; python p_r52.py; python p_r52b.py; python p_r53.py; python build_db.py
```

p_cta.py は `pdftotext -layout` で作った `enr.txt` も使います。

## 近似・省略している所
- 円弧は3度ごとの点で近似。中心の施設が航法DBにないもの（石見 VOR/DME・松島 TACAN）は空港の標点で代用
- 道路・鉄道・河川で区切られた民間訓練空域（関東 KK4-2〜4-8）は省略。片側の円（境界が海岸線など）は円全体
- Area S（硫黄島）は除外区域を省いた円。千歳 A・C 回廊は扇形を台形で近似
- 管制区の下限は地表からの高さ（AGL）
- 高高度訓練空域の H／S など、同じ形で高度帯が違う小区域は、高度の上下をまとめて1つの区域にしている場合がある
- 訓練・教育用の可視化データです。実運航には使わないでください
