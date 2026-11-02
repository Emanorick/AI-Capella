# Music fonts of the app and the PDF export

The PDF's (`src/exportPdf.ts`) are loaded only when a PDF is made, and embedded in it.

| File | What | From | Licence |
|---|---|---|---|
| `LightScoreEngraving.zip` | The music: notes, clefs, rests, accidentals, dynamics, in Verovio's font format | **Eugene** 1.44 by Mikko Patama ([github.com/mikkopatama/eugenefont](https://github.com/mikkopatama/eugenefont)), the French engraving of around 1900 (the Fromont editions of Debussy); where Eugene has no sign of its own yet, Verovio takes Bravura's | SIL OFL 1.1, `Eugene-OFL.txt` |
| `MusicText.ttf` | "LightScore Music Text": the music signs set inside text (a tempo mark's note, a dynamic) | Eugene, and Bravura (`MusicText-Bravura.ttf`) for the signs Eugene lacks | SIL OFL 1.1, `Eugene-OFL.txt`, `../Bravura-OFL.txt` |
| `../engraving-subset.woff2` | "LightScore Engraving", the app's music font: the sheet view, the signatures in the rulers, the clefs in menus | Eugene, subset to the 73 signs the views draw (those of `../bravura-subset.woff2`, which stands behind it for the few Eugene lacks) | SIL OFL 1.1, `Eugene-OFL.txt` |
| `MusicText-Bravura.ttf` | The earlier Bravura subset: the source of the signs Eugene lacks (not shipped) | Bravura, Steinberg Media Technologies | SIL OFL 1.1, `../Bravura-OFL.txt` |
| `LiberationSerif-*.ttf` | Lyrics and words (Times' metric twin) | Liberation Fonts | SIL OFL 1.1, `LiberationSerif-OFL.txt` |

"Eugene" and "Bravura" are Reserved Font Names, which the OFL keeps from a modified version (a
change of format counts), so the converted fonts carry names of their own. All are made by
`make-engraving-font.py` (needs fontTools) from a checkout of the Eugene repository:

    python3 make-engraving-font.py path/to/eugenefont

It also prints Eugene's engraving defaults (line thicknesses, in staff spaces), which
`exportPdf.ts` passes to Verovio as `MUSIC_LINES`.
