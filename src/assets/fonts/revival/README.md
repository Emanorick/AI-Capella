# Font Revival faces (test: `?schrift=test`)

From [Font Revival](https://font-revival.com/) by Harold Lehmann — digital revivals of American
type specimens, MIT license (`LICENSE.txt`). Taken from the `fonts/*.ttf` of
github.com/fontrevival/font-revival at b848391 (2026-10-26).

| File | Face | Used for (only with `?schrift=test`) |
|---|---|---|
| `BaltimoreTitle1832.woff2` | Baltimore Title 1832 | headings, in spaced capitals |
| `ModernAntique1889.woff2` | Modern Antique 1889 | song titles |
| `BaltimoreBold1832.woff2` | Baltimore Bold 1832 | rehearsal letters |
| `Remington1888.woff2` | Remington 1888 | text and controls |
| `Johnson1892.woff2` | Johnson 1892 | the "Score" of LightScore |

**Changed from the originals** (`add-german.py`): none of them has German letters, so Ä Ö Ü ä ö ü
are added, each the letter with two dots drawn from the face's own period; ß and ẞ are set as
"ss" / "SS". Remington also gets „ ‚ and the middle dot ·, and a longer hyphen
(`long-hyphen`) — its own reads as a dot at small sizes ("G·Dur"). Everything else is as published.
