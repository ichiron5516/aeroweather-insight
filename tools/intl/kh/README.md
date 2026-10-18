# カンボジア（AIP Cambodia eAIP）→ 航法・空域データ
出典：https://aim.cats.com.kh/eaip/2026-09-03-AIRAC/html/index-en-GB.html（ログインが必要）。空港は不要との指示で収録なし

- `kh_nav.py`（ベトナム用 vn_nav.py と同じ形）→ `nav_db.json`：ENR 4.1・4.4・3.1・3.2
- `kh_airspace.py` → `airspace_db.json`：Phnom Penh ACC セクター 1・2、Phnom Penh・Siem Reap・Sihanouk TMA、ENR 5.1（P/R）

## 近似・注意
- TMA は中心から 50NM（Siem Reap は 30NM）の円で近似（Phnom Penh と Sihanouk の境界線、FIR 境界での切り取りは省略）
