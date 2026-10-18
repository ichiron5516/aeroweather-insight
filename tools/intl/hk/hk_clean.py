# 表の罫線を消してから OCR する（罫線があると表の文字が崩れるため）
import sys, numpy as np
from PIL import Image
def runs_mask(d, minlen):
    out = np.zeros_like(d)
    for y in range(d.shape[0]):
        r = d[y]
        if not r.any(): continue
        dd = np.diff(np.concatenate(([0], r.astype(np.int8), [0])))
        st, en = np.where(dd == 1)[0], np.where(dd == -1)[0]
        for s, e in zip(st, en):
            if e - s > minlen: out[y, s:e] = True
    return out
for f in sys.argv[1:]:
    im = np.array(Image.open(f).convert('L')); d = im < 128
    m = runs_mask(d, 120) | runs_mask(d.T, 60).T
    im[m] = 255
    Image.fromarray(im).save(f.replace('.png', '_c.png'))
