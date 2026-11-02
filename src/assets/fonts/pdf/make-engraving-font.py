#!/usr/bin/env python3
"""
The music of the PDF export in the engraving of Eugene (Mikko Patama, github.com/mikkopatama/eugenefont,
SIL OFL 1.1): its French engraving style of around 1900 for the notes, clefs, rests and dynamics.

Makes, from Eugene.otf, Eugene.json and the glyphs' SMuFL names in its source (Source/Eugene.ufo):
  LightScoreEngraving.zip  the font in Verovio's format (one SVG path per SMuFL glyph and a file of
                           bounding boxes and anchors), loaded by exportPdf.ts with Verovio's
                           fontAddCustom option -- what the engraver draws the music with;
  MusicText.ttf            "LightScore Music Text": the few music signs set inside text (a tempo
                           mark's note, a dynamic) as TrueType for jsPDF, from Eugene, and from the
                           Bravura subset (MusicText-Bravura.ttf) where Eugene has no sign of its own.

Neither is called Eugene: "Eugene" is a Reserved Font Name, which the OFL keeps from any modified
version (a change of format counts). Needs fontTools:  pip install fonttools

  python3 make-engraving-font.py path/to/eugenefont   (a checkout of the repository above)
"""

import io
import json
import sys
import zipfile
import xml.etree.ElementTree as Et
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

NAME = "LightScoreEngraving"
HERE = Path(__file__).resolve().parent


def num(v: float) -> str:
    return str(round(v, 2)).removesuffix(".0")


def smufl_names(ufo: Path) -> dict[int, str]:
    """Each code point's SMuFL name (noteheadBlack), from the source -- the font's own glyphs are uniE0A4."""
    names = {}
    for glif in (ufo / "glyphs").glob("*.glif"):
        root = Et.parse(glif).getroot()
        for u in root.findall("unicode"):
            names[int(u.get("hex"), 16)] = root.get("name")
    return names


def engraving_font(otf: TTFont, metadata: dict, names: dict[int, str]) -> bytes:
    """Verovio's format: NAME.xml (bounding boxes, advances, anchors) and NAME/XXXX.xml per glyph."""
    glyphs = otf.getGlyphSet()
    hmtx = otf["hmtx"]
    upm = otf["head"].unitsPerEm
    anchors = metadata.get("glyphsWithAnchors", {})
    root = Et.Element("bounding-boxes", {"font-family": NAME, "units-per-em": str(upm)})
    files: dict[str, str] = {}
    for code, glyph_name in sorted(otf.getBestCmap().items()):
        if not 0xE000 <= code <= 0xF8FF:
            continue  # SMuFL lives in the private use area
        c = f"{code:04X}"
        smufl = names.get(code, glyph_name)
        svg = SVGPathPen(glyphs, num)
        glyphs[glyph_name].draw(svg)
        bounds = BoundsPen(glyphs)
        glyphs[glyph_name].draw(bounds)
        x0, y0, x1, y1 = bounds.bounds or (0, 0, 0, 0)
        g = Et.SubElement(root, "g", {"c": c, "x": num(x0), "y": num(y0), "w": num(x1 - x0), "h": num(y1 - y0), "h-a-x": str(hmtx[glyph_name][0]), "n": smufl})
        for anchor, (ax, ay) in anchors.get(smufl, {}).items():
            Et.SubElement(g, "a", {"n": anchor, "x": num(ax), "y": num(ay)})
        el = Et.Element("g", {"id": c})
        if svg.getCommands():
            Et.SubElement(el, "path", {"transform": "scale(1,-1)", "d": svg.getCommands()})
        files[f"{NAME}/{c}.xml"] = Et.tostring(el, encoding="unicode")
    tree = Et.ElementTree(root)
    Et.indent(tree)
    out = io.BytesIO()
    tree.write(out, encoding="UTF-8", xml_declaration=True)
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(f"{NAME}.xml", out.getvalue())
        # (Verovio embeds this in an SVG to set music in text; the PDF has its own font for that.)
        z.writestr(f"{NAME}.css", "/* The music font for text is embedded in the PDF itself. */\n")
        for name, xml in files.items():
            z.writestr(name, xml)
    print(f"{NAME}.zip: {len(files)} glyphs, {len(data.getvalue()) // 1024} KB")
    return data.getvalue()


def music_text(otf: TTFont, bravura: TTFont) -> TTFont:
    """The signs of the Bravura subset, drawn from Eugene where it has them, as TrueType."""
    wanted = sorted(bravura.getBestCmap())  # (the space too: Verovio sets one between a note and its dot)
    eugene_map, bravura_map = otf.getBestCmap(), bravura.getBestCmap()
    order, cmap, glyf, metrics = [".notdef"], {}, {}, {}
    pen = TTGlyphPen(None)
    glyf[".notdef"], metrics[".notdef"] = pen.glyph(), (500, 0)
    from_eugene = 0
    for code in wanted:
        name = f"uni{code:04X}"
        source, source_name = (otf, eugene_map[code]) if code in eugene_map else (bravura, bravura_map[code])
        from_eugene += source is otf
        pen = TTGlyphPen(None)
        # Eugene's outlines are cubic (CFF); TrueType's are quadratic.
        source.getGlyphSet()[source_name].draw(Cu2QuPen(pen, max_err=0.5, reverse_direction=True) if source is otf else pen)
        glyph = pen.glyph()
        glyph.recalcBounds(None)
        order.append(name)
        cmap[code] = name
        glyf[name] = glyph
        metrics[name] = (source["hmtx"][source_name][0], getattr(glyph, "xMin", 0))
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    fb.setupHorizontalMetrics(metrics)
    hhea = bravura["hhea"]
    fb.setupHorizontalHeader(ascent=hhea.ascent, descent=hhea.descent)
    fb.setupNameTable(
        {
            "copyright": "Copyright (c) 2026, Mikko Patama, with Reserved Font Name Eugene. Copyright (c) 2026, "
            'Steinberg Media Technologies GmbH (http://www.steinberg.net/), with Reserved Font Name "Bravura".',
            "familyName": "LightScore Music Text",
            "styleName": "Regular",
            "uniqueFontIdentifier": "LightScoreMusicText-from-Eugene-and-Bravura",
            "fullName": "LightScore Music Text",
            "version": f"Version {otf['head'].fontRevision:.3f}",
            "psName": "LightScoreMusicText",
            "licenseDescription": "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
            "licenseInfoURL": "https://openfontlicense.org",
        }
    )
    fb.setupOS2(sTypoAscender=hhea.ascent, sTypoDescender=hhea.descent, usWinAscent=hhea.ascent, usWinDescent=-hhea.descent)
    fb.setupPost()
    print(f"MusicText.ttf: {len(wanted)} signs, {from_eugene} from Eugene, {len(wanted) - from_eugene} from Bravura")
    return fb.font


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    otf = TTFont(source / "Eugene.otf")
    metadata = json.loads((source / "Eugene.json").read_text())
    (HERE / f"{NAME}.zip").write_bytes(engraving_font(otf, metadata, smufl_names(source / "Source" / "Eugene.ufo")))
    music_text(otf, TTFont(HERE / "MusicText-Bravura.ttf")).save(HERE / "MusicText.ttf")
    # For exportPdf.ts (EUGENE_DEFAULTS): line thicknesses and spacings, in staff spaces.
    defaults = {k: v for k, v in metadata["engravingDefaults"].items() if isinstance(v, (int, float))}
    print("engravingDefaults:", json.dumps(defaults))


if __name__ == "__main__":
    main()
