# 空域の補足データ（public/data/intl/<cc>/airspace_extra.json）を作る（2026-10-18）
#   各国の AIP から作った airspace_db.json に無い区分を、公開データで補う。教育用の目安
#   ・FIR：public/data/fir/fir_asia.geojson（VATSpy をまとめ直したもの）から、まだ FIR の無い国に足す。
#     中国は VATSpy の ACC の「FIR」名で、北京・上海・広州などの FIR に分けて作る
#   ・ACC：VATSpy（VATSIM のシミュレーター管制の区分、CC BY-SA 4.0）。実際の ACC の区分と細部が違う。高度の区分は無い
#     日本・韓国・フィリピン・インドネシアは AIP の区分があるので作らない
#   ・米国（アラスカ・ハワイ・グアム）：FAA の公開データ（ADDS「Special_Use_Airspace」「Boundary_Airspace」）から
#     制限（R）・警戒（W）・危険（D）・禁止（P）・MOA・ADIZ・ホノルル管制施設・グアム CERAP・アンカレッジ ARTCC
#   ・ADIZ：米国 3 つ（FAA）、フィリピン（FAA の Boundary_Airspace）、中国の東シナ海 ADIZ（2013-11-23 の中国国防部の公告の 6 点。
#     西側は中国の領海の外側に沿うと書かれているので、沿岸の近似の点で閉じる）
#   使い方：python tools/intl/common/airspace_extra.py <既存の public/data/intl を読む場所> <書き出す public/data>
#   入力：tools/intl/_downloads/vatspy/Boundaries.geojson・VATSpy.dat、tools/intl/_downloads/faa/faa_bnd.json・faa_sua.json
import json, math, os, re, sys, collections, hashlib
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, Point
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
DL = os.path.join(HERE, '..', '_downloads')
SRC_DATA, OUT = sys.argv[1], sys.argv[2]
VAT = 'VATSpy Data Project（VATSIM の管制区分、CC BY-SA 4.0）'
FAA = 'FAA ADDS 公開データ（2026-10）'

def disk(lat, lon):   # 気象衛星の画像の範囲（中心 140.7E・半径 81 度）
    c = math.cos(math.radians(lat)) * math.cos(math.radians(lon - 140.7))
    return math.degrees(math.acos(max(-1, min(1, c)))) <= 81

def cc_of(icao):
    i = icao.upper()
    P = [('ZK', 'KP'), ('ZM', 'MN'), ('Z', 'CN'), ('VC', 'LK'), ('VR', 'MV'), ('VG', 'BD'), ('VN', 'NP'), ('VY', 'MM'), ('VT', 'TH'),
         ('VV', 'VN'), ('VL', 'LA'), ('VD', 'KH'), ('VH', 'HK'), ('VA', 'IN'), ('VE', 'IN'), ('VI', 'IN'), ('VO', 'IN'),
         ('WM', 'MY'), ('WB', 'MY'), ('WS', 'SG'), ('WI', 'ID'), ('WA', 'ID'), ('RP', 'PH'), ('RC', 'TW'), ('RK', 'KR'), ('RJ', 'JP'),
         ('UA', 'KZ'), ('UC', 'KG'), ('UTD', 'TJ'), ('UTA', 'TM'), ('UZ', 'UZ'), ('U', 'RU'), ('OA', 'AF'), ('OP', 'PK'),
         ('PG', 'US'), ('PH', 'US'), ('PA', 'US'), ('K', 'US'), ('AY', 'PG'), ('AG', 'SB'), ('AN', 'NR'), ('NF', 'FJ'), ('NZ', 'NZ'),
         ('NT', 'PF'), ('Y', 'AU')]
    for p, c in P:
        if i.startswith(p): return c
    return None

NAMES = {'KP': '北朝鮮', 'MN': 'モンゴル', 'CN': '中国', 'LK': 'スリランカ', 'MV': 'モルディブ', 'BD': 'バングラデシュ', 'NP': 'ネパール',
         'MM': 'ミャンマー', 'TH': 'タイ', 'VN': 'ベトナム', 'LA': 'ラオス', 'KH': 'カンボジア', 'HK': '香港', 'IN': 'インド', 'MY': 'マレーシア',
         'SG': 'シンガポール', 'ID': 'インドネシア', 'PH': 'フィリピン', 'TW': '台湾', 'KR': '韓国', 'KZ': 'カザフスタン', 'KG': 'キルギス',
         'TJ': 'タジキスタン', 'TM': 'トルクメニスタン', 'UZ': 'ウズベキスタン', 'RU': 'ロシア', 'AF': 'アフガニスタン', 'PK': 'パキスタン',
         'US': 'アメリカ（アラスカ・ハワイ・グアム・太平洋）', 'PG': 'パプアニューギニア', 'SB': 'ソロモン諸島', 'NR': 'ナウル', 'FJ': 'フィジー',
         'NZ': 'ニュージーランド', 'PF': 'フランス領ポリネシア', 'AU': 'オーストラリア'}

items = collections.defaultdict(list)    # cc → [item]
def ring_of(poly):
    return [[round(x, 4), round(y, 4)] for x, y in poly.exterior.coords]
def parts_of(geom, lower=0, upper=None, **kw):
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in polys:
        if p.is_empty or p.area < 1e-4: continue
        d = {'ring': ring_of(p), 'lower': lower, 'upper': upper, **kw}
        if p.interiors: d['hole'] = [[round(x, 4), round(y, 4)] for x, y in max(p.interiors, key=lambda r: Polygon(r).area).coords]
        out.append(d)
    return out

def existing(cc):
    p = os.path.join(SRC_DATA, cc.lower(), 'airspace_db.json')
    return json.load(open(p, encoding='utf-8'))['items'] if os.path.exists(p) else []

# ---------- VATSpy ----------
B = json.load(open(os.path.join(DL, 'vatspy', 'Boundaries.geojson'), encoding='utf-8'))
VN = {}
sec = None
for l in open(os.path.join(DL, 'vatspy', 'VATSpy.dat'), encoding='utf-8', errors='replace'):
    l = l.strip()
    if l.startswith('['): sec = l; continue
    if sec == '[FIRs]' and l and not l.startswith(';'):
        p = l.split('|')
        if len(p) >= 4: VN.setdefault(p[3] or p[0], p[1])
BY = collections.defaultdict(list)
for f in B['features']: BY[f['properties']['id']].append(f)

def vgeom(ids, shift=False):
    gs = []
    for i in ids:
        for f in BY.get(i, []):
            g = f['geometry']
            for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]):
                r = [[x + 360 if (shift and x < 0) else x, y] for x, y in poly[0]]
                if len(r) >= 4: gs.append(Polygon(r).buffer(0))
    u = unary_union([g.buffer(0.02) for g in gs]).buffer(-0.02).simplify(0.01)
    return u

def in_disk(ids):
    pts = []
    for i in ids:
        for f in BY.get(i, []):
            g = f['geometry']
            for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]): pts += poly[0]
    return pts and sum(disk(y, x) for x, y in pts) / len(pts) > 0.3

# ---------- 1. FIR ----------
FIRS = json.load(open(os.path.join(OUT, 'fir', 'fir_asia.geojson'), encoding='utf-8'))
have_fir = collections.defaultdict(set)
for cc in NAMES:
    for o in existing(cc):
        if o.get('layer') == 'fir': have_fir[cc].add(o['id'])
have_fir['JP'].add('RJJJ')
for f in FIRS['features']:
    p = f['properties']
    for icao in (p['icao'] or '').split('/'):
        if not icao: continue
        cc = cc_of(icao)
        if cc in ('JP',) or icao in have_fir[cc] or icao in ('PHZH', 'PGZU'): continue   # ホノルル・グアムは FIR でなく管制施設（ACC の段に入れる）
        g = shape(f['geometry'])
        items[cc].append({'id': p['icao'], 'cat': 'fir', 'layer': 'fir', 'name': f"{p['ja'].split('（')[0]}（{p['en'].title()} {p.get('sfx', 'FIR')}）",
                          'short': f"{p['en']} {p.get('sfx', 'FIR')}", 'lower': 0, 'upper': None, 'parts': parts_of(g),
                          'src': VAT, 'info': {'出典': 'VATSpy の境界（公式の AIP と細部が違う）'}})
        break
# 中国：VATSpy の ACC の名前「Beijing ACC - Beijing FIR - Beijing」から FIR ごとにまとめる
CN_FIR_JA = {'Beijing': ('ZBPE', '北京'), 'Shanghai': ('ZSHA', '上海'), 'Guangzhou': ('ZGZU', '広州'), 'Wuhan': ('ZHWH', '武漢'),
             'Lanzhou': ('ZLHW', '蘭州'), 'Kunming': ('ZPKM', '昆明'), 'Urumqi': ('ZWUQ', 'ウルムチ'), 'Shenyang': ('ZYSH', '瀋陽')}
cn_acc = {}
for i in BY:
    if i.startswith('Z') and len(i) == 4 and cc_of(i) == 'CN' and i not in ('ZJSA',):
        m = re.match(r'(.+?) ACC - (.+?) FIR', VN.get(i, ''))
        if m: cn_acc[i] = (m.group(1), m.group(2))
for fir, (icao, ja) in CN_FIR_JA.items():
    ids = [i for i, (_, f) in cn_acc.items() if f == fir]
    if not ids: continue
    items['CN'].append({'id': icao, 'cat': 'fir', 'layer': 'fir', 'name': f'{ja}FIR（{fir} FIR）', 'short': f'{fir.upper()} FIR',
                        'lower': 0, 'upper': None, 'parts': parts_of(vgeom(ids)), 'src': VAT,
                        'info': {'出典': 'VATSpy の ACC をまとめた区分（公式の AIP と細部が違う）', 'ACC': '・'.join(sorted(cn_acc[i][0] for i in ids))}})

# ---------- 2. ACC ----------
def acc_item(cc, sid, unit, short, geom, extra=None):
    return {'id': f'{cc}-ACC-{sid}', 'cat': 'sector', 'layer': 'sector', 'name': f'{short}（{unit}）', 'short': short, 'unit': unit,
            'lower': 0, 'upper': None, 'parts': parts_of(geom), 'src': VAT,
            'info': {'管轄': unit, '高度': '区分なし（VATSIM の区分には高さの区分が無い）', **(extra or {})}}

def drop_nested(ids):
    """入れ子の区分（例 UNKL-N と UNKL-N1・N2）は細かい方だけ残す"""
    g = {i: vgeom([i]) for i in ids}
    keep = []
    for i in ids:
        others = [g[j] for j in ids if j != i and g[j].area < g[i].area * 0.95 and g[j].intersection(g[i]).area > 0.8 * g[j].area]
        if others and unary_union(others).intersection(g[i]).area > 0.7 * g[i].area: continue
        keep.append(i)
    return keep, g

SKIP_CC = {'JP', 'KR', 'PH', 'ID'}
groups = collections.defaultdict(list)
for i in BY:
    if '-' not in i: continue
    base = i.split('-')[0]
    cc = cc_of(base)
    if cc in SKIP_CC or cc is None or not in_disk([i]): continue
    if cc == 'CN' or cc == 'US' or cc == 'IN': continue   # 中国・インドは ACC 単位、米国は FAA を使う
    groups[base].append(i)
for base, ids in sorted(groups.items()):
    cc = cc_of(base)
    keep, g = drop_nested(sorted(ids))
    for i in keep:
        nm = VN.get(i, i)
        m = re.match(r'(.+? ACC)(?: Sector)? ?(.*?)(?: - .*)?$', nm)
        unit = m.group(1) if m else f'{VN.get(base, base)} ACC'
        if not unit.endswith('ACC'): unit = f'{VN.get(base, base)} ACC'
        short = (m.group(2) if m and m.group(2) else i.split('-')[1]) or i
        if cc == 'TH': unit, short = 'Bangkok ACC', i.split('-')[1]
        if cc == 'VN': unit = 'Ho Chi Minh ACC' if base == 'VVHM' else 'Hanoi ACC'; short = i.split('-')[1]
        if cc == 'MN': unit = 'Ulaanbaatar ACC'; short = i.split('-')[1]
        items[cc].append(acc_item(cc, i, unit, short, g[i], {'VATSpy': i}))
# 中国：ACC 単位
for i, (acc, fir) in sorted(cn_acc.items()):
    if in_disk([i]): items['CN'].append(acc_item('CN', i, f'{acc} ACC', acc, vgeom([i]), {'FIR': f'{fir} FIR'}))
# インド：ACC 単位。デリー ACC は Delhi FIR から他の ACC を除いた残り
IN_ACC = ['VABB', 'VAAH', 'VANP', 'VECC', 'VEBN', 'VEGF', 'VIAR', 'VIJP', 'VILK', 'VIUX', 'VOMM', 'VOBL', 'VOBG', 'VOCI', 'VOHS', 'VOML', 'VOTV']
for i in IN_ACC:
    if i in BY:
        nm = re.sub(r' - .*$', '', VN.get(i, i))
        items['IN'].append(acc_item('IN', i, nm if 'ACC' in nm else nm + ' ACC', re.sub(r' ACC.*$', '', nm), vgeom([i])))
dl = vgeom(['VIDF']).difference(vgeom(['VIAR', 'VIJP', 'VILK', 'VIUX']))
items['IN'].append(acc_item('IN', 'VIDD', 'Delhi ACC', 'Delhi', dl))
# オーストラリア（メルボルン・ブリスベンのセンターの区分）
for i in sorted(BY):
    if i.startswith('Y') and len(i) == 4 and '-' not in i and in_disk([i]):
        nm = VN.get(i, i)
        m = re.match(r'(Melbourne|Brisbane)(?: Radio)? \(([^)]+)\)', nm)
        if not m:
            m2 = re.match(r'(Melbourne|Brisbane)', nm)
            unit, short = (f'{m2.group(1)} Centre' if m2 else 'Australia'), i
        else: unit, short = f'{m.group(1)} Centre', m.group(2)
        items['AU'].append(acc_item('AU', i, unit, short, vgeom([i])))
# ニュージーランド
for i, unit in [('NZAA', 'Auckland Control'), ('NZAR', 'Auckland Control'), ('NZOH', 'Ohakea Control'), ('NZCB', 'Christchurch Control'),
                ('NZCK', 'Christchurch Control'), ('NZCS', 'Christchurch Control'), ('NZCT', 'Christchurch Control'), ('NZZT', 'Auckland Oceanic')]:
    if i in BY:
        nm = VN.get(i, i); m = re.search(r'\(([^)]+)\)', nm)
        items['NZ'].append(acc_item('NZ', i, unit, m.group(1) if m else nm, vgeom([i], True)))

# ---------- 3. 米国（FAA）----------
fb = json.load(open(os.path.join(DL, 'faa', 'faa_bnd.json')))
fs = json.load(open(os.path.join(DL, 'faa', 'faa_sua.json')))
def shift_geom(geo):
    def fx(r): return [[x + 360 if x < 0 else x, y] for x, y in r]
    polys = geo['coordinates'] if geo['type'] == 'MultiPolygon' else [geo['coordinates']]
    return unary_union([Polygon(fx(p[0]), [fx(h) for h in p[1:]]).buffer(0) for p in polys])
def ft(val, uom, code):
    if code == 'UNLTD' or val in (None, '-9998', -9998): return None
    v = float(val)
    if code == 'SFC': return 0
    return int(v * 100) if uom == 'FL' else int(v)
ADIZ_JA = {'ALASKA ADIZ': 'アラスカ ADIZ', 'HAWAII ADIZ OUTER BOUNDARY': 'ハワイ ADIZ（外側）', 'HAWAII ADIZ INNER BOUNDARY': 'ハワイ ADIZ（内側）',
           'GUAM ADIZ OUTER BOUNDARY': 'グアム ADIZ（外側）', 'GUAM ADIZ INNER BOUNDARY': 'グアム ADIZ（内側）', 'PHILIPPINE ADIZ': 'フィリピン ADIZ'}
adiz = collections.defaultdict(list)
for f in fb['features']:
    p = f['properties']; geo = f['geometry']
    if not geo: continue
    g = shift_geom(geo)
    if p['TYPE_CODE'] == 'ADIZ' and p['NAME'] in ADIZ_JA:
        for poly in (g.geoms if isinstance(g, MultiPolygon) else [g]):
            pts = ring_of(poly)[:-1]
            if any(disk(y, x) for x, y in pts):
                adiz[p['NAME']].append({'pts': pts, 'label': ADIZ_JA[p['NAME']], **({'dash': True} if 'INNER' in p['NAME'] else {})})
    elif p['NAME'] in ('GUAM CERAP', 'HONOLULU CONTROL FACILITY') or (p['IDENT'] == 'ZAN' and p['TYPE_CODE'] == 'ARTCC'):
        unit = {'GUAM CERAP': 'Guam CERAP', 'HONOLULU CONTROL FACILITY': 'Honolulu Control Facility'}.get(p['NAME'], 'Anchorage ARTCC')
        short = unit if p['IDENT'] != 'ZAN' else ('Anchorage ARTCC（低高度）' if p['LOCAL_TYPE'] == 'ARTCC_L' else 'Anchorage ARTCC（高高度）')
        lo, up = ft(p['LOWER_VAL'], 'FL' if p['LOWER_CODE'] == 'STD' else 'FT', p['LOWER_CODE']), ft(p['UPPER_VAL'], 'FL' if p['UPPER_CODE'] == 'STD' else 'FT', p['UPPER_CODE'])
        it = {'id': f"US-ACC-{p['IDENT'] or 'GUAM'}-{p['LOCAL_TYPE'] or ''}", 'cat': 'sector', 'layer': 'sector', 'name': f'{short}', 'short': short, 'unit': unit,
              'lower': lo or 0, 'upper': up, 'parts': parts_of(g, lo or 0, up), 'src': FAA + ' Boundary_Airspace', 'info': {'管轄': unit}}
        items['US'].append(it)
for nm, lines in adiz.items():
    cc = 'PH' if nm.startswith('PHILIPPINE') else 'US'
    key = re.sub(r' (OUTER|INNER) BOUNDARY', '', nm)
    o = next((x for x in items[cc] if x.get('layer') == 'adiz' and x['_k'] == key), None)
    if not o:
        o = {'_k': key, 'id': f"{cc}-ADIZ-{key.split()[0]}", 'cat': 'adiz', 'layer': 'adiz', 'name': f"{ADIZ_JA[nm].split('（')[0]}（{key.title()}）",
             'parts': [], 'lines': [], 'src': FAA + ' Boundary_Airspace', 'info': {'種別': '防空識別圏'}}
        items[cc].append(o)
    o['lines'] += lines
KIND = {'R': ('restricted', 'restricted', 'restricted', '制限空域'), 'P': ('restricted', 'restricted', 'prohibited', '禁止空域'),
        'D': ('restricted', 'restricted', 'danger', '危険空域'), 'W': ('military', 'restricted', 'warning', '警戒空域（洋上の軍の訓練・射撃）'),
        'A': ('military', 'restricted', 'warning', '注意空域（Alert Area）'), 'MOA': ('military', 'jsdf', 'moa', '軍の訓練空域（MOA）')}
for f in fs['sua']['features']:
    p = f['properties']
    if p['TYPE_CODE'] not in KIND: continue
    g = shift_geom(f['geometry'])     # アラスカの内陸は衛星の範囲の少し外だが、州ごとまとめて入れる
    cat, layer, kind, ja = KIND[p['TYPE_CODE']]
    lo, up = ft(p['LOWER_VAL'], p['LOWER_UOM'], p['LOWER_CODE']), ft(p['UPPER_VAL'], p['UPPER_UOM'], p['UPPER_CODE'])
    name = re.sub(r'^\((\w+)\)', '', p['NAME']).strip()
    info = {'種別': ja}
    if p['TIMESOFUSE']: info['時間'] = re.sub(r'\s*%\s*', ' ', p['TIMESOFUSE'])[:200]
    if p['CONT_AGENT']: info['管制機関'] = p['CONT_AGENT']
    items['US'].append({'id': f"US-{p['TYPE_CODE']}-{name}".replace(' ', '_'), 'cat': cat, 'layer': layer, 'kind': kind, 'name': f'{name}（{ja.split("（")[0]}）',
                        'lower': lo, 'upper': up, 'parts': parts_of(g, lo, up, **({'agl': True} if p['LOWER_CODE'] == 'AGL' else {})),
                        'src': FAA + ' Special_Use_Airspace', 'info': info})

# ---------- 4. 中国の東シナ海 ADIZ ----------
d = lambda deg, mn: deg + mn / 60
ecs = [[d(121, 47), d(33, 11)], [125.0, d(33, 11)], [d(128, 20), 31.0], [125.0, d(25, 38)], [123.0, d(24, 45)], [d(120, 58), d(26, 44)],
       [121.6, 27.9], [122.3, 29.2], [122.5, 30.4], [122.2, 31.5], [121.9, 32.4]]   # 6 点目から 1 点目までは沿岸の近似
items['CN'].append({'id': 'CN-ADIZ-ECS', 'cat': 'adiz', 'layer': 'adiz', 'name': '中国 東シナ海防空識別区（East China Sea ADIZ）', 'parts': [],
                    'lines': [{'pts': [[round(x, 4), round(y, 4)] for x, y in ecs], 'label': '中国 東シナ海 ADIZ'}],
                    'src': '中華人民共和国国防部 公告（2013-11-23）の 6 点。西側（中国の領海の外側の線）は近似',
                    'info': {'種別': '防空識別圏（中国）', '注意': '西側の境界は沿岸の近似の点。日本・韓国・台湾の ADIZ と重なる'}})

# ---------- 書き出し ----------
idx_path = os.path.join(OUT, 'intl', 'index.json')
idx = json.load(open(idx_path, encoding='utf-8'))
by_code = {c['code']: c for c in idx['countries']}
summary = {}
for cc, lst in sorted(items.items()):
    if not lst: continue
    for o in lst: o.pop('_k', None); o['country'] = cc
    os.makedirs(os.path.join(OUT, 'intl', cc.lower()), exist_ok=True)
    srcs = sorted({o['src'].split('（')[0] for o in lst})
    json.dump({'meta': {'title': f'{NAMES[cc]} 空域の補足データ', 'source': '・'.join(srcs),
                        'notes': ['教育用の目安。公式の AIP と細部が違う', 'ACC は VATSIM の区分で、高度の区分は無い', 'tools/intl/common/airspace_extra.py で作成']},
               'items': lst}, open(os.path.join(OUT, 'intl', cc.lower(), 'airspace_extra.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    c = by_code.get(cc)
    if not c:
        c = {'code': cc, 'name': NAMES[cc], 'note': '空域の補足データだけ（航空路・空港は無い）'}
        idx['countries'].append(c); by_code[cc] = c
    c['airspaceExtra'] = f'{cc.lower()}/airspace_extra.json'
    summary[cc] = dict(collections.Counter(f"{o['layer']}{'/' + o['kind'] if o.get('kind') else ''}" for o in lst))
json.dump(idx, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
for k, v in summary.items(): print(k, v)
