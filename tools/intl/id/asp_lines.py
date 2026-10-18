import pdfplumber, collections, re
def lines21(path):
    pdf = pdfplumber.open(path); out = []
    for pn, p in enumerate(pdf.pages):
        ws = p.extract_words(x_tolerance=1.5)
        tops = collections.defaultdict(list)
        for w in ws:
            if w['text'] in list('12345'): tops[round(w['top'])].append(w)
        r = [v for v in tops.values() if len({w['text'] for w in v}) >= 4 and any(w['text'] == '2' for w in v)]
        if not r: continue
        xb = [w for w in r[0] if w['text'] == '2'][0]['x0'] - 28; ytop = max(w['bottom'] for w in r[0]) + 1
        foot = [w for w in ws if w['text'] == 'Directorate']; ybot = min([w['top'] for w in foot] + [p.height - 40]) - 1
        col = sorted([w for w in ws if w['x0'] < xb and ytop < w['top'] < ybot], key=lambda w: (round(w['top']), w['x0']))
        L = []
        for w in col:
            if L and abs(L[-1][0] - w['top']) < 1.5: L[-1][1].append(w['text'])
            else: L.append([w['top'], [w['text']]])
        out += [(pn + 1, ' '.join(t)) for _, t in L]
    return out
if __name__ == '__main__':
    for x in lines21('enr21.pdf'): print(x)
