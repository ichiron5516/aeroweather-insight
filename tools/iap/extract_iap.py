# AIP Japan AD2.24 の進入方式チャート（IAC）から、進入方式の一覧と主要地点（IAF/IF/FAF/MAPt/MAHF）を抜き出す
import pdfplumber, re, glob, json, sys, os
UP = sys.argv[1] if len(sys.argv) > 1 else '/root/.claude/uploads/4f168f85-21a8-5891-8d31-b62d2d77bef3'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/home/claude/iap/raw'
os.makedirs(OUT, exist_ok=True)
ROMAN = {19574: 'Ⅰ', 19575: 'Ⅱ', 19576: 'Ⅲ'}
def dec(s):
    def r(m):
        n = int(m.group(1))
        if n in ROMAN: return ROMAN[n]
        return chr(n + 29) if 3 <= n < 100 else ('°' if n in (219, 221) else '')
    s = re.sub(r'\(cid:(\d+)\)', r, s)
    return s.replace('䱶', 'Ⅰ').replace('䱷', 'Ⅱ').replace('䱸', 'Ⅲ').replace('（', '(').replace('）', ')').replace('＆', '&')
TYPES = {'ILS', 'LOC', 'VOR', 'RNP', 'GLS', 'LDA', 'NDB', 'RNAV', 'TACAN', 'GNSS', 'VOR/DME', 'LOC/DME', 'NDB/DME', 'VORTAC'}
ROLE = r'(IAF/IF|IF/IAF|IAF|IF|FAF|FAP|MAHF|MAPt)'
LAT = re.compile(r'^(\d{6}(?:\.\d+)?)N$'); LON = re.compile(r'^(\d{7}(?:\.\d+)?)E$')
PAIR = re.compile(r'(\d{6}(?:\.\d+)?)N/?(\d{7}(?:\.\d+)?)E')
def dms(s, deg):
    d = int(s[:deg]); m = int(s[deg:deg+2]); sec = float(s[deg+2:])
    return round(d + m / 60 + sec / 3600, 7)
def lines_of(ws, tol=2.5):
    L = []
    for w in sorted(ws, key=lambda w: (w['top'], w['x0'])):
        if L and abs(L[-1][0]['top'] - w['top']) <= tol: L[-1].append(w)
        else: L.append([w])
    return [sorted(l, key=lambda w: w['x0']) for l in L]

ONLY = os.environ.get('ONLY')
for f in sorted(glob.glob(f'{UP}/*__20*.pdf')):
    icao = re.search(r'([A-Z]{4})__\d{8}', f).group(1)
    if ONLY and icao != ONLY: continue
    tpages = open(glob.glob(f'/home/claude/aip/{icao}__*.txt')[0]).read().split('\f')
    charts = []
    with pdfplumber.open(f) as pdf:
        for pi, pg in enumerate(pdf.pages):
            raw = pg.extract_text() or ''
            if 'INSTRUMENT APPROACH CHART' not in dec(raw): continue
            ws = pg.extract_words(extra_attrs=['size'])
            ex = []
            for w in ws:
                t = dec(w['text'])
                parts = t.split()
                if len(parts) <= 1:
                    w['text'] = t.strip(); ex.append(w); continue
                n, x0, wd = len(t), w['x0'], (w['x1'] - w['x0'])
                pos = 0
                for p in parts:
                    i = t.index(p, pos); pos = i + len(p)
                    ex.append({**w, 'text': p, 'x0': x0 + wd * i / n, 'x1': x0 + wd * pos / n})
            ws = [w for w in ex if w['text']]
            Ls = lines_of(ws)
            # ---- 題名 ----
            title = None
            for l in Ls:
                if l[0]['top'] > 170: break
                for k, w in enumerate(l):
                    if w['x0'] > 250 and w['text'] in TYPES:
                        cand = ' '.join(x['text'] for x in l[k:])
                        cand = re.split(r'\s+(RJ[A-Z]{2}|RO[A-Z]{2}) AD|\s+AIP Japan|\s+[A-Z]+ (TOWER|APP|RADAR)\b', cand)[0]
                        if 'RWY' in cand or re.search(r'\b[A-Z]\b', cand): title = cand; break
                if title: break
            if not title:   # 題名が文字として取れないとき：pdftotext の結果から
                m = re.search(r'R[JO][A-Z]{2} / [A-Z ]+?\s{2,}((?:ILS|LOC|VOR|RNP|GLS|LDA|NDB|TACAN)\b.*?)(?:\s{2,}|$)', tpages[pi], re.M)
                if not m: continue
                title = m.group(1)
            title = re.sub(r'\s+', ' ', title).replace('R WY', 'RWY').strip()
            title = re.sub(r'RWY\s*(\d)', r'RWY\1', title)
            # ---- 座標 ----
            coords = {}
            def name_left(w0):
                best = None
                for w in ws:
                    if abs(w['top'] - w0['top']) <= 3 and w['x1'] <= w0['x0'] + 1 and w0['x0'] - w['x1'] < 90:
                        m = re.match(r'^([A-Z]{5}|[A-Z]{3}|[A-Z]\d[A-Z]\d{2}|[A-Z]{2}\d{3})(\(|$)', w['text'])
                        if m and (best is None or w['x1'] > best[1]['x1']): best = (m.group(1), w)
                return best[0] if best else None
            for w in ws:
                m = PAIR.search(w['text'])
                lat = lon = None
                if m: lat, lon = m.group(1), m.group(2)
                elif LAT.match(w['text']):
                    below = [x for x in ws if LON.match(x['text']) and abs(x['x0'] - w['x0']) < 12 and 4 < x['top'] - w['top'] < 16]
                    same = [x for x in ws if LON.match(x['text']) and abs(x['top'] - w['top']) < 3 and 0 <= x['x0'] - w['x1'] < 20]
                    o = (same or below or [None])[0]
                    if o: lat, lon = w['text'][:-1], o['text'][:-1]
                if not lat: continue
                nm = name_left(w)
                if not nm:   # "OGABA(FAF) : 34..." のように ':' を挟む場合
                    for x in ws:
                        if abs(x['top'] - w['top']) <= 3 and x['x1'] <= w['x0'] and w['x0'] - x['x1'] < 30 and x['text'] in (':', '：'):
                            nm = name_left(x)
                if nm: coords[nm] = {'lat': dms(lat, 2), 'lon': dms(lon, 3)}
            # ---- 地点の役割 ----
            roles = []
            for w in ws:
                m = re.match(rf'^([A-Z]{{5}}|[A-Z]{{3}}|[A-Z]\d[A-Z]\d{{2}})\({ROLE}\)', w['text'])
                if m: roles.append((m.group(1), m.group(2))); continue
                m = re.match(rf'^\({ROLE}\)$', w['text'])
                if m:
                    cx = (w['x0'] + w['x1']) / 2
                    cands = [x for x in ws if re.match(r'^[A-Z]{5}$|^[A-Z]{3}$|^[A-Z]\d[A-Z]\d{2}$', x['text'])
                             and ((abs((x['x0'] + x['x1']) / 2 - cx) < 22 and 2 < w['top'] - x['top'] < 15)
                                  or (abs(x['top'] - w['top']) < 3 and 0 <= w['x0'] - x['x1'] < 12))]
                    if cands:
                        c = min(cands, key=lambda x: abs(w['top'] - x['top']))
                        roles.append((c['text'], m.group(1)))
                    elif m.group(1) == 'MAPt': roles.append((None, 'MAPt'))
            # ---- FAF 高度（ALT(… APCH Path) の表で FAF 列の値） ----
            faf_alt = None
            for k, l in enumerate(Ls):
                txt = ' '.join(x['text'] for x in l)
                if 'APCH' in txt and 'ALT' in txt:
                    for hl in Ls[max(0, k - 3):k]:
                        fh = [x for x in hl if x['text'] in ('FAF', 'FAP')]
                        if fh:
                            nums = [x for x in l if re.match(r'^\d{3,5}$', x['text'])]
                            if nums:
                                n = min(nums, key=lambda x: abs((x['x0'] + x['x1']) / 2 - (fh[0]['x0'] + fh[0]['x1']) / 2))
                                if abs((n['x0'] + n['x1']) / 2 - (fh[0]['x0'] + fh[0]['x1']) / 2) < 25: faf_alt = int(n['text'])
                    break
            # ---- 進入復行の方式（MISSED APPROACH の下の文） ----
            missed = None
            for l in Ls:
                for k in range(len(l) - 1):
                    if l[k]['text'] == 'MISSED' and l[k + 1]['text'].startswith('APPROACH'):
                        h = l[k]
                        blk = [x for x in ws if h['top'] + 4 < x['top'] < h['top'] + 80 and h['x0'] - 70 <= x['x0'] <= h['x0'] + 230
                               and x['text'] not in ('IM', 'MM', 'OM', 'VDP', 'MAPt', 'M', 'i', '(FAF)', '(IF)', '(IAF)', '(MAHF)', '(LOC)', 'GP')]
                        txt = ' '.join(' '.join(x['text'] for x in bl) for bl in lines_of(blk))
                        txt = re.sub(r'\b\d{3,4} (?=at )', '', txt)
                        m = re.search(r'\b(Climb|Climbing|Turn|Proceed|Continue|Fly|Track|Straight|Intercept|At or above|At|Direct|Via|Join|Maintain|When|After|Hold)\b', txt)
                        if m:
                            t = txt[m.start():]
                            e = re.search(r'Contact [A-Z ]+?(APP|RADAR|DEPARTURE|TOWER|CONTROL)\b\.?', t)
                            if e: t = t[:e.end()]
                            else:
                                e = re.search(r'Missed APCH|MINIMA|Missed approach', t)
                                if e: t = t[:e.start()]
                            missed = re.sub(r'\s+', ' ', t).strip()
                        break
                if missed: break
            charts.append({'page': pi + 1, 'title': title, 'roles': roles, 'coords': coords, 'fafAltFt': faf_alt, 'missed': missed})
    json.dump(charts, open(f'{OUT}/{icao}.json', 'w'), ensure_ascii=False, indent=1)
    print(icao, len(charts), [c['title'] for c in charts][:50])
