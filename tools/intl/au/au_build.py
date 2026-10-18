# オーストラリア（AIP Australia）→ 航法データ（2026-10-18）
#   AIP Australia の ENR 3（ユーザーから受け取った ENR、26 NOV 2026）には航空路の表が無く、「DAH を見よ」とある。
#   そこで Airservices Australia の DAH（Designated Airspace Handbook、26 NOV 2026 発効）の
#     SECTION 21 NAVIGATION AIDS（無線施設の名前・種類）・SECTION 23 AIR ROUTES（航空路。地点ごとに座標と区間距離）を読む
#   入手：https://www.airservicesaustralia.com/aip/aip.asp?pg=10 →「pending/dah/DAH_26NOV2026.pdf」
#   ・SECTION 23 は 1 ページに 2 列。列の境目は、ページの見出し行「WAYPOINT … WAYPOINT」の 2 つめの位置
#   ・行の形：「2 CIN VOR 173519.6S 1235107.2E 019/023 190.6 2600/2500 H」（報告の区分・地点・座標・磁方位・距離・最低安全高度・図）
#   ・列の頭（見出しの前）の行は、前の列の最後の航空路の続き
#   ・報告の区分 2（すべての航空機が位置通報）の地点は義務通報点（reporting: COMPULSORY）
#   出力：nav_db.json（空港は METAR・TAF の白丸のまま）
#   使い方：python au_build.py <DAH の PDF> <出力フォルダ>
import json, math, os, re, subprocess, sys

PDF, OUT = sys.argv[1], sys.argv[2]
text = subprocess.run(['pdftotext', '-layout', PDF, '-'], capture_output=True, text=True).stdout
R_NM = 3440.065
def nm(a, b):
    r = math.pi / 180; h = math.sin((b['lat'] - a['lat']) * r / 2) ** 2 + math.cos(a['lat'] * r) * math.cos(b['lat'] * r) * math.sin((b['lon'] - a['lon']) * r / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(h))
def lat_(s): v = int(s[0:2]) + int(s[2:4]) / 60 + float(s[4:-1]) / 3600; return round(-v if s[-1] == 'S' else v, 6)
def lon_(s): v = int(s[0:3]) + int(s[3:5]) / 60 + float(s[5:-1]) / 3600; return round(-v if s[-1] == 'W' else v, 6)

i21 = text.index('SECTION 21 – NAVIGATION AIDS\n', text.index('SECTION 23 – AIR ROUTES'))   # 目次の後の本文
i22 = text.index('SECTION 22 – IFR WAYPOINTS\n', i21)
i23 = text.index('SECTION 23 – AIR ROUTES\n', i22)

# ---------- SECTION 21 無線施設（LOC・GP は使わない）----------
NAVS = {}
for m in re.finditer(r'([A-Z][A-Z ()./\'-]*?)\s+(VOR|DME|NDB|TAC)\s+([A-Z]{2,3})\s+(\d{6}\.\d[NS])\s+(\d{7}\.\d[EW])', text[i21:i22]):
    NAVS.setdefault((m[3], m[2]), {'name': re.sub(r'^[NSEW]\s{2,}', '', m[1].strip()), 'lat': lat_(m[4]), 'lon': lon_(m[5])})

# ---------- SECTION 23 航空路 ----------
ROW = re.compile(r'(?<![A-Z0-9])([1-5])\s+([A-Z][A-Z0-9]{1,4})(?:\s+(VOR|NDB|TAC|DME))?\s+(\d{6}(?:\.\d)?[NS])\s+(\d{7}(?:\.\d)?[EW])(?:\s+(\d{3}|---)/(\d{3}|---))?(?:\s+(\d+(?:\.\d)?)(?=\s+\d+/\d+))?')
HDR = re.compile(r'ATS ROUTE ([A-Z]{1,2}\d{1,4}[A-Z]?)\s+(T/W|O/W|LIMITED)')
F, routes, order, cmp_ = {}, {}, [], []
def put(k, f):
    if k in F:
        if nm(F[k], f) < 2: return k
        for i in range(2, 9):
            kk = f'{k}~{i}'
            if kk not in F: F[kk] = {**f, 'ident': k}; return kk
            if nm(F[kk], f) < 2: return kk
    F[k] = f; return k
last = None   # 前の列の最後の航空路
for page in re.split(r'\f', text[i23:]):
    lines = page.splitlines()
    hdr = next((l for l in lines if l.count('WAYPOINT') >= 2), None)
    split = [m.start() for m in re.finditer('WAYPOINT', hdr)][1] - 2 if hdr else 10 ** 6
    cols = [[], []]
    for l in lines:
        for m in list(HDR.finditer(l)) + list(ROW.finditer(l)):
            cols[0 if m.start() < split else 1].append(m)
    for col in cols:
        cur = last
        for m in col:
            if m.re is HDR:
                cur = m[1]
                if cur in routes: routes[cur].append([])            # 同じ名前がもう一度出たら別の切れ端
                else: routes[cur] = [[]]; order.append(cur)
                continue
            if cur is None: continue
            ident, typ = m[2], m[3]
            f = {'lat': lat_(m[4]), 'lon': lon_(m[5]), 'type': 'waypoint', 'country': 'AU'}
            if typ:
                n = NAVS.get((ident, typ)) or NAVS.get((ident, 'DME')) or {}
                f.update({'type': 'navaid', 'navaidType': {'TAC': 'TACAN'}.get(typ, typ), 'name': n.get('name', '')})
                if typ == 'VOR' and (ident, 'DME') in NAVS: f['navaidType'] = 'VOR/DME'
                if typ == 'NDB' and (ident, 'DME') in NAVS: f['navaidType'] = 'NDB/DME'
            if m[1] == '2': f['reporting'] = 'COMPULSORY'   # 区分 2：すべての航空機が位置通報（義務通報点）
            key = put(ident, {k: v for k, v in f.items() if v is not None})
            seq = routes[cur][-1]
            if seq and m[8] and seq[-1] != key: cmp_.append((cur, seq[-1], key, float(m[8])))
            if not seq or seq[-1] != key: seq.append(key)
        last = cur

A = {}
for d in order:
    for i, seq in enumerate(s for s in routes[d] if len(s) >= 2):
        k = d if i == 0 else f'{d}~{i + 1}'
        A[k] = {'type': 'RNAV' if re.match(r'^[LMNPQTYZ]', d) else 'CONVENTIONAL', 'points': seq, 'country': 'AU',
                'segments': [{'nm': round(nm(F[a], F[b]), 1)} for a, b in zip(seq, seq[1:])]}
        if k != d: A[k]['designator'] = d
# 確かめ：行ごとの距離（DIST）と、座標から出した距離
ok = sum(1 for _, a, b, d in cmp_ if abs(nm(F[a], F[b]) - d) <= max(1.5, 0.02 * d))
bad = [f'{r} {a}-{b} {nm(F[a], F[b]):.1f} vs {d}' for r, a, b, d in cmp_ if abs(nm(F[a], F[b]) - d) > max(1.5, 0.02 * d)]
print(f'無線施設（SECTION 21）{len(NAVS)}・航空路 {len(A)}（名前 {len(order)}）・地点 {len(F)}（無線施設 {sum(1 for f in F.values() if f["type"] == "navaid")}）')
print(f'確かめ：区間 {len(cmp_)} のうち {ok} が DAH の距離と一致'); print('合わない', bad[:30])
print('切れ端のある航空路', [k for k in A if '~' in k][:30]); print('同じ名前で離れた地点', [k for k in F if '~' in k])
os.makedirs(OUT, exist_ok=True)
json.dump({'meta': {'title': 'オーストラリア 航法データ', 'sources': ['AIP Australia DAH（Designated Airspace Handbook）26 NOV 2026 SECTION 21・23', 'AIP Australia ENR 3（航空路は DAH を参照）'], 'aipEffective': 'DAH 26 NOV 2026'},
           'fixes': F, 'airways': A}, open(os.path.join(OUT, 'nav_db.json'), 'w'), ensure_ascii=False)
