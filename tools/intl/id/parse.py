import pdfplumber, re, json, sys, math
DESIG = re.compile(r'^[A-Z]{1,2}\d{1,4}[A-Z]?$')
LAT = re.compile(r'^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])$')
LON = re.compile(r'^(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])$')
def dms(m): v = int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600; return -v if m[4] in 'SW' else v
def col1_lines(path):
    out = []
    pdf = pdfplumber.open(path)
    for pn, p in enumerate(pdf.pages):
        ws = p.extract_words(keep_blank_chars=False, x_tolerance=1.5)
        import collections
        tops = collections.defaultdict(list)
        for w in ws:
            if w['text'] in ('1', '2', '3', '4', '5', '6'): tops[round(w['top'])].append(w)
        rows = [v for v in tops.values() if len({w['text'] for w in v}) >= 5 and any(w['text'] == '2' for w in v)]
        tr = [w for w in ws if w['text'] == 'Track']
        if rows:
            row = rows[0]; xb = [w for w in row if w['text'] == '2'][0]['x0'] - 20; ytop = max(w['bottom'] for w in row) + 1
        elif tr:
            xb = min(w['x0'] for w in tr) - 2; ytop = tr[0]['top'] + 45
        else:
            # 見出しがない続きのページ：左端から 70pt を列1とする
            xb = 128; ytop = 60
        foot = [w for w in ws if w['text'] == 'Directorate']
        ybot = min([w['top'] for w in foot] + [p.height - 40]) - 1
        col = [w for w in ws if w['x0'] < xb and ytop < w['top'] < ybot and not re.fullmatch(r'\d{1,3}\.\d', w['text'])]
        col.sort(key=lambda w: (round(w['top']), w['x0']))
        lines = []
        for w in col:
            if lines and abs(lines[-1][0] - w['top']) < 1.2: lines[-1][1].append(w['text'])
            else: lines.append([w['top'], [w['text']]])
        for t, l in lines: out.append((pn + 1, ' '.join(l)))
    return out
def parse(path, rtype):
    L = col1_lines(path)
    routes, fixes, unknown = {}, {}, []
    cur = None; name = []; lat = None; remarks = False
    def add_point(nm, la, lo):
        txt = ' '.join(nm).strip()
        m = re.search(r'\(([A-Z]{1,3})\)', txt)
        pid = m[1] if m else txt
        if not re.fullmatch(r'[A-Z]{2,5}|[A-Z]{1,3}', pid): unknown.append((cur, txt)); pid = re.sub(r'[^A-Z0-9]', '', txt)[:12]
        f = {'lat': round(la, 6), 'lon': round(lo, 6), 'type': 'navaid' if m else 'waypoint', 'country': 'ID'}
        if m:
            f['name'] = txt[:m.start()].replace('VOR/DME', '').replace('VOR', '').replace('NDB', '').replace('DME', '').strip()
            f['navaidType'] = ('VOR/DME' if 'VOR/DME' in txt else 'VOR' if 'VOR' in txt else 'NDB' if 'NDB' in txt else '')
        old = fixes.get(pid)
        if old and (abs(old['lat'] - f['lat']) > 0.02 or abs(old['lon'] - f['lon']) > 0.02): unknown.append(('座標の食い違い', pid, old['lat'], old['lon'], f['lat'], f['lon']))
        fixes.setdefault(pid, f)
        pts = routes[cur]['points']
        if not pts or pts[-1] != pid: pts.append(pid)
    for pn, s in L:
        if s.startswith('Route Remarks') or re.match(r'^(Note|NOTE|Remarks)', s): remarks = True; continue
        if DESIG.match(s):
            if s != cur and s in routes and routes[s].get('closed'):
                # 同じ名前の別の表（区間が分かれている）→ 別の部分として扱う
                cur = s; routes[s]['parts'].append([]); 
            cur = s; remarks = False; name = []; lat = None
            routes.setdefault(s, {'type': rtype, 'points': [], 'page': pn, 'parts': []})
            continue
        if remarks or cur is None: continue
        if re.fullmatch(r'C?O?N?T?|CONT', s): continue
        if re.match(r'^\((RNP|RNAV)', s): continue
        if re.fullmatch(r'(?:[A-Z] ){2,}[A-Z]', s): s = s.replace(' ', '')
        s = re.sub(r'(VOR/DME|VOR|NDB)\s+([A-Z]{2,3})$', r'\1 (\2)', s)
        if re.fullmatch(r'[\d\s.]+[NSEW]', s): s = s.replace(' ', '')
        s = re.sub(r'(VOR/DME|VOR|NDB|DME)\s+([A-Z]{2,3})\)$', r'\1 (\2)', s)
        if re.fullmatch(r'[A-Z]{2,3}\)', s): s = '(' + s
        m = LAT.match(s)
        if m: lat = dms(m); continue
        m = LON.match(s)
        if m and lat is not None:
            add_point(name, lat, dms(m)); name = []; lat = None; continue
        # 緯度経度が1行に並んでいる場合
        m2 = re.match(r'^(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])$', s)
        if m2: add_point(name, dms(LAT.match(m2[1])), dms(LON.match(m2[2]))); name = []; lat = None; continue
        name.append(s)
    return routes, fixes, unknown
if __name__ == '__main__':
    r, f, u = parse(sys.argv[1], sys.argv[2])
    print(len(r), 'routes', len(f), 'fixes'); print('unknown', u[:40])
    for k in list(r)[:8]: print(k, r[k]['points'])
    json.dump({'routes': r, 'fixes': f}, open(sys.argv[3], 'w'))
