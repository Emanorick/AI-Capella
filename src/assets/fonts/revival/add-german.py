# Adds the German letters the Font Revival faces lack: Ä Ö Ü ä ö ü (the letter with two dots made
# from the font's own period) and ß / ẞ (as "ss" / "SS"); for text faces also „ ‚ and ·. Writes WOFF2.
# Usage (needs fontTools and brotli):  python3 add-german.py Remington1888-Regular.ttf Remington1888.woff2 [long-hyphen]
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.boundsPen import BoundsPen

src, out = sys.argv[1], sys.argv[2]
f = TTFont(src)
gs = f.getGlyphSet()
cmap = f.getBestCmap()
glyf, hmtx = f['glyf'], f['hmtx']
order = list(f.getGlyphOrder())

def bounds(name):
    p = BoundsPen(gs); gs[name].draw(p); return p.bounds

def record(name):
    r = DecomposingRecordingPen(gs); gs[name].draw(r); return r

def add(name, parts, advance, cps):
    pen = TTGlyphPen(None)
    for g, (sx, dx, dy) in parts:
        record(g).replay(TransformPen(pen, (sx, 0, 0, sx, dx, dy)))
    g = pen.glyph()
    glyf.glyphs[name] = g
    if name not in order: order.append(name)
    g.recalcBounds(glyf)
    hmtx.metrics[name] = (advance, getattr(g, 'xMin', 0))
    for t in f['cmap'].tables:
        if t.isUnicode():
            for cp in cps:
                if cp <= 0xFFFF or t.format in (12, 13): t.cmap[cp] = name

period = cmap[ord('.')]
px0, py0, px1, py1 = bounds(period)
dot = max(px1 - px0, py1 - py0)
caps_only = cmap[ord('a')] == cmap[ord('A')]
xh = f['OS/2'].sxHeight or 500
capH = f['OS/2'].sCapHeight or 700

def umlaut(base, name, cps, lower):
    bx0, by0, bx1, by1 = bounds(base)
    adv = hmtx[base][0]
    s = (0.92 if not lower else 1.0) * min(1.0, 130 / dot) if dot > 0 else 1
    d = dot * s
    w = bx1 - bx0
    cx = (bx0 + bx1) / 2
    half = max(d * 0.95, w * (0.2 if not lower else 0.24))
    gap = (0.06 * capH) if not lower else (0.1 * xh)
    y = by1 + gap - py0 * s
    pcx = (px0 + px1) / 2 * s
    parts = [(base, (1, 0, 0)), (period, (s, cx - half - pcx, y)), (period, (s, cx + half - pcx, y))]
    add(name, parts, adv, cps)

for ch, up in (('A', 0xC4), ('O', 0xD6), ('U', 0xDC)):
    umlaut(cmap[ord(ch)], ch + 'dieresis', [up] + ([up + 0x20] if caps_only else []), False)
if not caps_only:
    for ch, lo in (('a', 0xE4), ('o', 0xF6), ('u', 0xFC)):
        umlaut(cmap[ord(ch)], ch + 'dieresis', [lo], True)

def double(g, name, cps):
    adv = hmtx[g][0]
    add(name, [(g, (1, 0, 0)), (g, (1, adv, 0))], 2 * adv, cps)
S = cmap[ord('S')]; s_ = cmap[ord('s')]
double(S, 'S_S', [0x1E9E] + ([0xDF] if caps_only else []))
if not caps_only: double(s_, 's_s', [0xDF])

# Text faces also need the German low quote and the middle dot (as in "6 Stimmen · 8 Takte").
if ord('\u201e') not in cmap and ord('\u201d') in cmap:
    q = cmap[ord('\u201d')]; cy = bounds(cmap[ord(',')])[1]; qy = bounds(q)[1]
    add('quotedblbase', [(q, (1, 0, cy - qy))], hmtx[q][0], [0x201E])
if ord('\u201a') not in cmap and ord('\u2019') in cmap:
    q = cmap[ord('\u2019')]; cy = bounds(cmap[ord(',')])[1]; qy = bounds(q)[1]
    add('quotesinglbase', [(q, (1, 0, cy - qy))], hmtx[q][0], [0x201A])
if ord('\u00b7') not in cmap:
    mid = (xh if not caps_only else capH) * 0.5
    add('periodcentered', [(period, (1, 0, mid - (py0 + py1) / 2))], hmtx[period][0], [0xB7])

# A typewriter's hyphen can be so short it reads as a dot ("G·Dur"): drawn from the en dash instead,
# at about half the cell.
if len(sys.argv) > 3 and sys.argv[3] == 'long-hyphen':
    hy, en = cmap[ord('-')], cmap[ord('\u2013')]
    hx0, hy0, hx1, hy1 = bounds(hy); ex0, ey0, ex1, ey1 = bounds(en)
    adv = hmtx[hy][0]; want = adv * 0.5; sx = want / (ex1 - ex0)
    pen = TTGlyphPen(None)
    record(en).replay(TransformPen(pen, (sx, 0, 0, 1, (adv - want) / 2 - ex0 * sx, (hy0 + hy1) / 2 - (ey0 + ey1) / 2)))
    g = pen.glyph(); glyf.glyphs[hy] = g; g.recalcBounds(glyf); hmtx.metrics[hy] = (adv, g.xMin)

f.setGlyphOrder(order)
glyf.glyphOrder = order
if 'post' in f and f['post'].formatType == 2.0:
    f['post'].extraNames = []; f['post'].mapping = {}
f.flavor = 'woff2'
f.save(out)
print(out, 'caps-only' if caps_only else 'mixed', 'dot', round(dot), 'glyphs', len(order))
