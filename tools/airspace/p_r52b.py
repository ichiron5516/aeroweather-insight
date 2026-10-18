# ENR 5.2：Area S（円）・超音速飛行空域・回廊・防空識別圏
import re, json
from lib import *

def eng(pn):
    W = words(pn); mid = pdf().pages[pn - 1].width / 2 - 22
    return ' '.join(' '.join(w['text'] for w in l) for l in lines([w for w in W if w['x0'] >= mid]))
E = eng(723) + ' ' + eng(724)
out = []
def ftx(s):
    s = s.replace(',', '').replace(' ft', '').strip()
    return alt_ft(s)

# ---- Area S：硫黄島 TACAN から半径200NM（除外区域は省略）----
ijt = navaid('IJT')
if ijt:
    out.append({'id': 'JSDF-H-S', 'cat': 'jsdf', 'kind': 'high', 'name': '高高度訓練／試験空域 Area S', 'src': 'ENR 5.2-18',
                'parts': [{'ring': circle(ijt, 200), 'lower': 0, 'upper': 80000, 'label': 'S-1', 'note': '除外区域（TOMOL・VASKO・OMLET の線の東側など）は省略'},
                          {'ring': circle(ijt, 150), 'lower': 0, 'upper': 20000, 'label': 'S-2'}],
                'info': {'種別': '自衛隊高高度訓練／試験空域', '時間': '2200-1200UTC の間（ATMセンター承認）', '注意': '除外区域を省略した概略（硫黄島TACAN 中心の円）'}})

# ---- 超音速飛行空域 ----
m = re.search(r'Supersonic Flight Area.*?connecting following points\.\s*\(See ENRC 1\)\s*(.*?)B\. Using ALT', E)
pts = [coords(c)[0] for c in re.findall(r'\(\d+\)(\d{6}N\d{7}E)', m.group(1).replace(' ', ''))]
out.append({'id': 'SUPERSONIC', 'cat': 'jsdf', 'kind': 'supersonic', 'name': '超音速飛行空域', 'src': 'ENR 5.2-19',
            'parts': [{'ring': close(pts), 'lower': 42000, 'upper': None}],
            'info': {'種別': '自衛隊機の水平超音速飛行', '高度': 'FL420以上', '時間': '平日 2200-1200UTC の間（ACC 承認）'}})

# ---- 回廊 ----
def strip(c, b, d0, d1, half):
    a0, a1 = dest(c[0], c[1], b, d0), dest(c[0], c[1], b, d1)
    return [dest(a0[0], a0[1], b - 90, half), dest(a1[0], a1[1], b - 90, half), dest(a1[0], a1[1], b + 90, half), dest(a0[0], a0[1], b + 90, half)]
for m in re.finditer(r'\((\d+)\) ([A-Z"\' ]+?CORRIDOR): (.*?)Altitude: (.*?) through (.*?)\.', E):
    no, name, body, a0, a1 = m.groups()
    name = name.replace('"', '').strip()
    idm = re.search(r'\(([A-Z]{3})\)\s*\.?\s*$', body.strip()) or re.findall(r'\(([A-Z]{3})\)', body)
    nid = idm.group(1) if hasattr(idm, 'group') else idm[-1]
    c = navaid(nid)
    lo, up = ftx(a0), ftx(a1)
    parts = []
    if 'fan-shaped' in body or 'arcs of a circle' in body:      # 千歳 A・C 回廊：扇形を台形で近似
        b = float(re.search(r'on (\d{3})°(\d{2})', body).group(1)) + float(re.search(r'on (\d{3})°(\d{2})', body).group(2)) / 60
        r_in = float(re.search(r'circle of (\d+) NM radius', body).group(1)); r_out = float(re.findall(r'circle of (\d+) NM radius', body)[-1])
        ring = [dest(*dest(c[0], c[1], b, r_in), b - 90, 7.5), dest(*dest(c[0], c[1], b, r_out), b - 90, 10),
                dest(*dest(c[0], c[1], b, r_out), b + 90, 10), dest(*dest(c[0], c[1], b, r_in), b + 90, 7.5)]
        parts.append({'ring': close(ring), 'lower': lo, 'upper': up, 'note': '扇形の外周を直線で近似'})
    else:
        half = float(re.search(r'within (\d+) NM on each side', body).group(1))
        for d0, d1, b in re.findall(r'(?:from (\d+) NM to )?(\d+) NM on (\d{3})°T', body):
            parts.append({'ring': close(strip(c, float(b), float(d0 or 0), float(d1), half)), 'lower': lo, 'upper': up})
    out.append({'id': f'CORR-{no}', 'cat': 'jsdf', 'kind': 'corridor', 'name': f'{name}（自衛隊専用回廊）', 'src': 'ENR 5.2-19/20', 'parts': parts,
                'info': {'種別': '自衛隊訓練／試験機の専用回廊（ACC の許可なく通過不可）', '基準': f'{nid} からの方位・距離'}})

# ---- 防空識別圏（外側線は 1〜30、内側線は「.」の点）----
W = words(726)
txt = [(w['top'], w['x0'], w['text']) for w in W]
def dmsW(s):
    m = re.match(r"(\d+)˚(\d+)´(\d+)´´([NE])", s)
    return int(m[1]) + int(m[2]) / 60 + int(m[3]) / 3600 if m else None
outer, inner = {}, []
for l in lines(W):
    toks = [w['text'] for w in l]
    for i in range(len(toks) - 2):
        la, lo2 = dmsW(toks[i + 1]), dmsW(toks[i + 2])
        if la is None or lo2 is None: continue
        if re.match(r'^\d+\.$', toks[i]): outer[int(toks[i][:-1])] = [lo2, la]
        elif re.match(r'^[Ａ-Ｚ]\.$', toks[i]): inner.append((ord(toks[i][0]), 0, [lo2, la]))
ring = [outer[k] for k in sorted(outer)]
inner = [p for _, _, p in sorted(inner)]
out.append({'id': 'ADIZ', 'cat': 'adiz', 'name': '防空識別圏（ADIZ）', 'src': 'ENR 5.2-21/22',
            'lines': [{'pts': ring, 'label': '外側線'}, {'pts': inner, 'label': '内側線', 'dash': True}],
            'parts': [], 'info': {'種別': '防空識別圏（防衛省）', '注意': '外側線と内側線の間が ADIZ。内側線は A〜U の点を結んだ線（北海道沿岸の「海岸線から3NM」の区間は省略）'}})
print('ADIZ outer', len(ring), 'inner', len(inner))
json.dump(out, open('r52b.json', 'w'), ensure_ascii=False)
for o in out: print(o['id'], o['name'], [(len(p['ring']), p['lower'], p['upper']) for p in o['parts']])
