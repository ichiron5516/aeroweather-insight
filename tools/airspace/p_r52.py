# ENR 5.2：自衛隊 低高度訓練／試験空域（Area 1〜）・高高度訓練／試験空域（Area A〜U）
import re, json
from lib import *

PT = re.compile(r'\((\d+)\)\s*(\d{6}(?:\.\d+)?N\s*/\s*\d{7}(?:\.\d+)?E)')
ARC = re.compile(r'(?:line|lines) connecting (?:the )?point(?:s)? ((?:\(\d+\)[, ]*(?:and |to )?)+?)\s*(?:to|and) point \((\d+)\) (?:is|are) (?:the |a )?minor arc (?:with|within) (?:a )?radius of (\d+(?:\.\d+)?)\s*NM (?:from|of) ([A-Za-z\- ]+?(?:VORTAC|VOR/DME|TACAN|VOR|DME))', re.I)

def page_items(pn):
    co = hdr(pn, 'Coordinates'); oc = hdr(pn, 'Occupied'); al = hdr(pn, 'Altitude')
    ctrl = [w for w in words(pn) if w['text'] == 'Controlling' and w['top'] < 120]
    if not (co and oc and al): return None
    xc0, xc1 = co['x0'] - 80, oc['x0'] - 6
    xa0, xa1 = al['x0'] - 12, (min(w['x0'] for w in ctrl) - 4) if ctrl else al['x0'] + 45
    top = max(co['top'], al['top']) + 8
    res = []
    for l in lines([w for w in words(pn) if top < w['top'] < 790]):
        nm = [w for w in l if w['x1'] <= xc0 + 2]
        cc = [w for w in l if xc0 <= w['x0'] < xc1]
        aa = [w for w in l if xa0 <= w['x0'] < xa1]
        res.append({'y': (pn, l[0]['top']), 'name': ' '.join(w['text'] for w in nm), 'c': ' '.join(w['text'] for w in cc),
                    'a': [w['text'] for w in aa]})
    return res

def build(pages, kind):
    blocks = []
    for pn in pages:
        it = page_items(pn)
        if it is None: continue
        for r in it:
            m = re.match(r'^Area\s+(\w+)', r['name'])
            if m:
                same = [x for x in blocks if x['id'] == m.group(1)]
                if same and same[-1] is blocks[-1]: continue          # 続きのページで同じ Area 名が繰り返される
                blocks.append({'id': m.group(1), 'rows': [], 'pg': pn})
            if blocks: blocks[-1]['rows'].append(r)
    out = []
    for b in blocks:
        polys, cur = [], None
        apairs = []                                   # (y, 上限, 下限)
        flat_alt = []
        for r in b['rows']:
            for a in r['a']: flat_alt.append((r['y'], a))
            if re.search(r'^(The airspace bounded|Within|The airspace within|Airspace bounded)', r['c']) or (cur is None and PT.search(r['c'])):
                cur = {'txt': [], 'rows': [], 'sub': None}; polys.append(cur)
            if cur is None: continue
            cur['txt'].append(r['c']); cur['rows'].append(r['y'])
            s2 = re.search(r'\b([A-Z]-\d{1,2}|\d{1,2}-\d)\b', r['name'])
            if s2 and not cur['sub']: cur['sub'] = s2.group(1)
        toks = [(y, a) for y, a in flat_alt if re.match(r'^(FL\d+|\d{3,6}|SFC|GND|UNL|-{4,})$', a)]
        for i, (y, a) in enumerate(toks):
            if a.startswith('---') and 0 < i < len(toks) - 1: apairs.append((y, alt_ft(toks[i - 1][1]), alt_ft(toks[i + 1][1])))
        # 高度は、区分線の位置に一番近い多角形（行の中央）に割り当てる。割り当てがない多角形は直前の多角形と同じ
        def key(y): return y[0] * 10000 + y[1]
        cen = [sum(key(y) for y in p['rows']) / len(p['rows']) for p in polys]
        got = [[] for _ in polys]
        for y, up, lo in apairs:
            if polys: got[min(range(len(polys)), key=lambda k: abs(cen[k] - key(y)))].append((up, lo))
        res, prev, lab = [], (0, None), None
        for p, g in zip(polys, got):
            if g: lo = min(x[1] for x in g); up = None if any(x[0] is None for x in g) else max(x[0] for x in g); prev = (lo, up)
            else: lo, up = prev
            lab = p['sub'] or lab
            txt = ' '.join(p['txt'])
            pts = [(int(n), coords(c)[0]) for n, c in PT.findall(txt)]
            if len(pts) < 3: continue
            arcs = []
            for m in ARC.finditer(txt):
                a_list = [int(x) for x in re.findall(r'\((\d+)\)', m.group(1))]
                ctr = navaid(m.group(4))
                if not ctr: print('   ? navaid', m.group(4)); continue
                seq = a_list + [int(m.group(2))]
                for u, v in zip(seq, seq[1:]): arcs.append((u, v, float(m.group(3)), ctr))
            ring = []
            for i, (n, c) in enumerate(pts):
                ring.append(c)
                nxt = pts[(i + 1) % len(pts)]
                for u, v, rr, ctr in arcs:
                    if {u, v} == {n, nxt[0]}: ring += arc(ctr, c, nxt[1], rr)
            res.append({'ring': close(ring), 'lower': lo, 'upper': up, **({'label': lab} if lab else {}),
                        **({'note': '一部の空域を除く'} if 'Excluding' in txt else {})})
        if not res: print('!! no polygons', b['id']); continue
        nm = f"{'低高度' if kind == 'low' else '高高度'}訓練／試験空域 Area {b['id']}"
        out.append({'id': f"JSDF-{'L' if kind == 'low' else 'H'}-{b['id']}", 'cat': 'jsdf', 'kind': kind, 'name': nm, 'parts': res,
                    'src': f"ENR 5.2-{b['pg'] - 704}",
                    'info': {'種別': '自衛隊' + ('低高度' if kind == 'low' else '高高度') + '訓練／試験空域', '時間': '2200-1200UTC の間（使用統制機関と調整・NOTAM）'}})
        print(out[-1]['id'], [(len(x['ring']), x['lower'], x['upper'], x.get('label')) for x in res])
    return out

out = build(range(706, 709), 'low') + build(range(709, 723), 'high')
json.dump(out, open('r52.json', 'w'), ensure_ascii=False)
print(len(out))
