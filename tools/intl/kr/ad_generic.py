# eAIP（IDS 形式）の AD 2 から、空港の基本情報（ARP・標高・磁差・滑走路・公示距離・無線施設）を取り出す（国を問わない版）
import re
from kr_lib import soup, txt, coords
def _sections(s):
    out, cur = {}, None
    for el in s.find_all(['h4', 'h3', 'table']):
        if el.name in ('h3', 'h4'):
            m = re.search(r'AD\s*2\.(\d+)\b', txt(el))
            if m: cur = int(m.group(1))
            continue
        if cur is not None and not el.find('table'):
            out.setdefault(cur, []).extend([[txt(x) for x in r.find_all(['td', 'th'], recursive=False)] for r in el.find_all('tr')])
    return out
def ft_of(s):
    m = re.search(r'([\d.]+)\s*(FT|ft|M\b|m\b)', s)
    if not m: return None
    v = float(m.group(1)); return round(v * 3.28084, 1) if m.group(2).lower() == 'm' else v
def airport(key, icao, iata, ja, en, city, cc, eff):
    s = soup(key); S = _sections(s)
    a = {'icao': icao, 'iata': iata, 'nameJa': ja, 'nameEn': en, 'nameAip': en.upper(), 'city': city, 'country': cc, 'aipEffective': eff,
         'runways': [], 'localNavaids': [], 'transitionAltitudeFt': None}
    for r in S.get(2, []):
        lab, val = (r[1], r[2]) if len(r) >= 3 else (r[0], r[1]) if len(r) == 2 else ('', '')
        if 'ARP' in lab and coords(val): c = coords(val)[0]; a['arp'] = {'lat': c[1], 'lon': c[0]}
        elif 'levation' in lab and 'eoid' not in lab: a['elevationFt'] = ft_of(val)
        elif 'VAR' in lab.upper() and '°' in val:
            m = re.search(r'([\d.]+)\s*°\s*(?:(\d+)\s*\'\s*)?([WE])', val); a['magVar'] = ((-1 if m.group(3) == 'W' else 1) * round(float(m.group(1)) + float(m.group(2) or 0) / 60, 2)) if m else None
    for r in S.get(17, []):
        if len(r) >= 3 and 'ransition' in r[1]:
            v = re.search(r'([\d ,]+)\s*(?:ft|FT)', r[2]); a['transitionAltitudeFt'] = int(re.sub(r'\D', '', v.group(1))) if v else None
    for r in S.get(12, []):
        rid = re.match(r'^(?:RWY\s*)?(\d{2}[LRC]?)\b', r[0]) if r else None
        if len(r) >= 5 and rid and any(coords(x) for x in r):
            r = [rid.group(1)] + r[1:]
            cs = next(coords(x) for x in r if coords(x)); b = re.search(r'(\d{3}(?:\.\d+)?)\s*°?\s*(?:T|GEO|TRUE)?', r[1])
            dim = re.search(r'(\d[\d ]*)\s*m?\s*[xX×]\s*(\d+)', ' '.join(r[1:4]))
            el = next((ft_of(x) for x in r[4:] if re.search(r'(FT|ft|m\b|M\b)', x) and not coords(x) and ft_of(x) is not None), None)
            a['runways'].append({'id': r[0], 'trueBearing': float(b.group(1)) if b else None, 'lengthM': int(dim.group(1).replace(' ', '')) if dim else None,
                                 'widthM': int(dim.group(2)) if dim else None, 'threshold': {'lat': cs[0][1], 'lon': cs[0][0]}, 'thresholdElevFt': el})
    dec = {}
    for r in S.get(13, []):
        rid = re.match(r'^(?:RWY\s*)?(\d{2}[LRC]?)\b', r[0]) if r else None
        if len(r) >= 5 and rid and rid.group(1) not in dec:
            nums = [x.replace(' ', '') for x in r[1:] if re.fullmatch(r'\d[\d ]{2,5}', x)][:4]
            if len(nums) == 4: dec[rid.group(1)] = dict(zip(['TORA', 'TODA', 'ASDA', 'LDA'], map(int, nums)))
    for r in a['runways']:
        r['declared'] = dec.get(r['id'], {})
        rec = '%02d' % ((int(r['id'][:2]) + 17) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C', '': ''}[r['id'][2:]]
        o = next((x for x in a['runways'] if x['id'] == rec), None)
        if o: r['reciprocal'] = rec; r['departureEnd'] = o['threshold']
    for r in S.get(19, []):
        idx = next((i for i, x in enumerate(r[:3]) if re.match(r'^[A-Z]{2,4}$', x)), None)
        cc_ = next((coords(x) for x in r if coords(x)), None)
        if idx is None or not cc_ or r[idx] in [n['id'] for n in a['localNavaids']]: continue
        ty = re.match(r'(DVOR/DME|VOR/DME|VORTAC|LOC|DME|GP|NDB|TACAN|DVOR|VOR)', r[0])
        a['localNavaids'].append({'type': ty.group(1) if ty else 'NAVAID', 'id': r[idx], 'freq': re.sub(r'\s', '', r[idx + 1])[:16] if idx + 1 < len(r) else '', 'lat': cc_[0][1], 'lon': cc_[0][0]})
    return a
