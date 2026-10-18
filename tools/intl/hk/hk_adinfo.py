# 香港 AD2 HTML の基本情報（韓国用の関数をそのまま使う：同じ eAIP 形式）
import re, sys
sys.path.insert(0, '/home/claude/hk/tools')
from hk_common import *
def airport(icao, iata, nameJa, nameEn, city):
    s = soup(f'AD-2-{icao}')
    sec = {}
    for h in s.find_all('h4'):
        m = re.search(r'AD 2\.(\d+)', txt(h))
        if m: sec[int(m.group(1))] = h.find_next('table')
    kv = {txt(r.find_all('td')[1]): txt(r.find_all('td')[2]) for r in sec[2].find_all('tr') if len(r.find_all('td')) >= 3}
    arp = coords(kv.get('ARP coordinates and site at AD', ''))[0]
    el = re.search(r'([\d.]+)\s*m', kv.get('Elevation/Reference temperature', '')); var = re.search(r'(\d+(?:\.\d+)?)°\s*([WE])', kv.get('Magnetic VAR/Annual change', ''))
    geoid = re.search(r'([\d.]+)\s*m', kv.get('Geoid undulation at AD ELEV PSN', ''))
    rws = []
    for r in sec[12].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if len(c) < 6 or not re.match(r'^\d{2}[LRC]?$', c[0]): continue
        dim = re.match(r'([\d ]+)\s*×\s*(\d+)', c[2]); th = coords(c[4]); te = re.search(r'THR\s*[\d.]+\s*m\s*/\s*([\d.]+)\s*ft', c[5])
        rws.append({'id': c[0], 'trueBearing': float(c[1].replace('°', '')), 'lengthM': int(dim.group(1).replace(' ', '')), 'widthM': int(dim.group(2)),
                    'threshold': {'lat': th[0][1], 'lon': th[0][0]}, 'thresholdElevFt': float(te.group(1)) if te else None, 'strength': c[3][:40]})
    dec = {}
    for r in sec[13].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        if len(c) >= 6 and c[5] == 'NIL' and c[0] not in dec:
            dec[c[0]] = dict(zip(['TORA', 'TODA', 'ASDA', 'LDA'], [int(x.replace(' ', '')) if x.replace(' ', '').isdigit() else None for x in c[1:5]]))
    for r in rws:
        r['declared'] = dec.get(r['id'], {})
        recip = '%02d' % ((int(r['id'][:2]) + 18 - 1) % 36 + 1) + {'L': 'R', 'R': 'L', 'C': 'C', '': ''}[r['id'][2:]]
        o = next((x for x in rws if x['id'] == recip), None)
        if o: r['reciprocal'] = recip; r['departureEnd'] = o['threshold']
    nav = []
    for r in sec[19].find_all('tr'):
        c = [txt(x) for x in r.find_all(['td', 'th'], recursive=False)]
        cc = next((coords(x) for x in c if coords(x)), None)
        if not cc: continue
        idx = 0 if re.match(r'^[A-Z]{2,4}$', c[0]) else 1
        typ = re.match(r'(VOR/DME|VORTAC|TVOR|DME|LOC|GP|NDB|IM|MM|OM)', c[0]) or (nav and re.match(r'(VOR/DME)', nav[-1]['type']))
        ident = c[idx] if re.match(r'^[A-Z]{2,4}$', c[idx]) else None
        if ident: nav.append({'type': typ.group(1) if typ else 'VOR/DME', 'id': ident, 'freq': c[idx + 1].split('(')[0].replace(' ', ''), 'lat': cc[0][1], 'lon': cc[0][0]})
    ta = re.search(r'Transition altitude.*?([\d ]+)\s*ft', ' '.join(txt(r) for r in sec[17].find_all('tr')))
    return {'icao': icao, 'iata': iata, 'nameJa': nameJa, 'nameEn': nameEn, 'nameAip': nameEn.upper(), 'city': city, 'country': 'HK',
            'arp': {'lat': arp[1], 'lon': arp[0]}, 'elevationFt': round(float(el.group(1)) * 3.28084, 1) if el else None,
            'magVar': (-1 if var and var.group(2) == 'W' else 1) * float(var.group(1)) if var else None,
            'geoidUndulationFt': round(float(geoid.group(1)) * 3.28084) if geoid else None,
            'transitionAltitudeFt': int(ta.group(1).replace(' ', '')) if ta else 14000, 'aipEffective': '20261029', 'runways': rws,
            'localNavaids': list({n['id']: n for n in nav}.values())}

