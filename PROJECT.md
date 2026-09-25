# AI-Capella

A browser-based rehearsal tool for a cappella / choir groups. You import a MusicXML score,
and it turns into an interactive, scrolling "piano roll" you can play back, mute/solo
individual voices, transpose, loop, and slow down or speed up — all running client-side, with
a small shared song library so everyone in the group sees the same scores on any device.

This document explains the idea behind the project, what it does, and how the codebase is put
together, for anyone (human or AI) picking it up later.

---

## 1. The idea

Choir and a cappella rehearsal has a recurring, annoying problem: singers need to hear their
own part in context, at a tempo they can control, without a piano player or a pre-recorded
track that's locked to one fixed speed and one fixed set of voices. Existing tools are either
full notation software (heavyweight, not built for "just play my part back to me") or crude
MIDI players (no per-voice mixing, no visual reference for where you are in the piece).

AI-Capella is a much narrower, much more focused answer to that problem:

- Take a MusicXML file (the de-facto standard export format from Finale, Sibelius, MuseScore,
  and most notation/OMR software).
- Render it as a horizontally-scrolling piano roll — pitch on the vertical axis, time on the
  horizontal axis, one colored bar per note, lyrics under each note.
- Synthesize the audio directly in the browser (no audio files to record or host) so every
  voice can be independently muted, soloed, transposed, or slowed down on the fly.
- Make it trivial to share: a small shared library (backed by Firebase) means one person
  imports a score once and the whole group can open it from their own phone or laptop, with a
  soft PIN gate to keep the link from being casually shared outside the group.

There's no server-side rendering, no account system beyond anonymous auth, and no audio
files anywhere — the "recording" is just a MusicXML file, synthesized live every time it plays.

---

## 2. What it does (feature tour)

### Title screen: Solo vs. Ensemble
Every time the app starts (when a shared backend is configured — otherwise this step is skipped),
it opens on the title screen: the app's name over the moving voice ribbons (see Design below),
and after a moment the two buttons fade in, **Practise alone** (Solo) and **Rehearse together**
(Ensemble), with the last-used one outlined. Solo is fully local — nothing about playback is shared with anyone else. Ensemble is
the synced-playback experience described below. The last choice is remembered (`localStorage`) and
marked; the **Solo | Ensemble** switch in the repertoire header (or the mode badge in the player)
changes it after a confirmation, reloading straight into the new mode (a one-shot
`sessionStorage` flag skips the title screen for that one reload). Either way, the
shared song library itself is always available — Solo only opts out of shared *playback*, not
shared *songs*. See §4.7. The storage key is versioned (`ai-capella-mode-v2`) so it can be bumped
again if every device should see the choice once more.

### Repertoire / player split
The app opens on the **repertoire**: every song as a card with a **cover drawn from its own voice
lines** (each voice's pitch contour, sampled and smoothed, in the voice colours — `artwork.ts`
`coverDataFromScore`/`drawCover`; same piece, same picture on every device), its voice count,
bar count and key (named from the key signature, major unless the file's `<mode>` says minor; no
key is named for MIDI imports). Cards are parsed lazily one at a time so a large library doesn't
freeze the page. A search field appears once there are more than eight songs; files can be
dropped anywhere on the page or picked with **Add arrangement**; each library song's **⋯** menu
offers Rename and Delete. While the shared library loads, skeleton cards show; if it can't be
reached, a banner says so with a Retry button instead of silently showing only the sample. On
phones the grid becomes a list with small covers. Picking a song switches to the **player**; the
back button always **stops playback** first — including, in Ensemble mode, for every other
connected device — so nobody is left with music playing to an empty player.

### The piano roll
- Canvas-based, not DOM/SVG — this matters at the note counts and frame rates involved (see
  §4.3).
- Horizontal axis = time (in quarter-note beats), vertical axis = pitch (one row per
  semitone). Each note is a rounded colored bar, one lyric syllable drawn beneath it, sized so
  the bar plus its lyric both fit fully inside the note's own row even for tightly-spaced
  chords.
- **Follows the music** on phones and in the sing-along view (`setAutoFit`): the rows zoom to the
  pitch range sung by the visible voices around the playhead (plus two beats ahead), never fewer
  than 11 rows or taller than 56 px, and glide (420 ms) to a new range only when the music leaves
  the current one or it has become much wider than needed. The content buffer is repainted once at
  the new row height and scaled during the glide, so a zoom change doesn't cost a repaint per
  frame. Scrolling by hand takes over until the next Play.
- A fixed **ruler strip** along the top (28px) is the *only* place in the score a click or drag
  can set where playback starts, or define a loop region (the whole-piece strip below the score
  is the other). Everywhere else, clicking is inert for
  playback — it can only *preview* a note (see below) — so casual scrolling or tapping while
  the piece plays can never accidentally jump the playback position. A plain tap (not a drag)
  always **snaps to the start of whichever bar it landed in** ("grid locking"). Grid-locking only
  moves the playback-start mark; it deliberately does **not** recenter the view. The ruler also
  shows section letters as boxed rehearsal marks and the loop region with its two handles.
- **Going to a bar**: previous/next bar buttons (tap for one bar, press-and-hold to repeat and
  accelerate, 400ms → 60ms between steps), ←/→ on the keyboard, the **Go to bar** field (click the
  position readout on a laptop, or in the Tempo & key sheet on a phone), section letters, and a
  click on the whole-piece strip. All of these move the actual playback position (synced in
  Ensemble mode) and recenter the view on it.
- **Click-to-preview**: clicking a note anywhere in the main area plays that note's pitch
  (through the same synth used for playback, respecting the current transpose) and shows its
  name (e.g. "E3") in a small label above it for about a second. A small piano keyboard (white
  keys, shorter black keys, C labels) is drawn once just before the piece's first beat — part of
  the scrolling content, not a persistent sidebar — and clicking a key plays its pitch. See §4.3.
- **Notes** are rounded pills in the voice colour, with the lyric syllable printed *inside* the
  pill when it fits (like note blocks in vocal-synth editors) and in a small lane under it when
  the note is too short; a syllable in that lane is skipped if another voice already printed one
  at the same spot, so unison voices don't print over each other. Notes under the playhead light
  up with a soft glow, and everything already played is shaded back slightly.
- **Rows are shaded like piano keys** (black-key rows slightly darker, a hairline under every C)
  so intervals and octaves read at a glance without a persistent keyboard.
- **Vertical scrolling**: if a piece's full pitch range doesn't fit the viewport at a
  comfortable row height, the roll scrolls vertically (mouse wheel / trackpad / touch drag). If
  it *does* fit, rows stretch to fill the available height and no scrolling is needed.
- **Horizontal panning while paused**: you can freely scroll left/right to browse the score
  while paused. The playhead line always reflects the actual paused/resume position, not
  wherever you've scrolled to — so it can visually move away from its usual spot (even off
  the edge of the screen) while you're just browsing, and snaps back the moment you press
  Play. While actually playing, horizontal panning is locked (the view follows the music) so
  the line and the audio can never visually desync.
- **Ties** (a note sustained across a bar-line, or any tie) are merged into a single note at parse
  time rather than kept as two notes joined by a line — see §4.2 — so a tied note renders as one
  seamless bar and plays back with a single attack, not a retrigger. **Slurs** are drawn in the
  title screen's ribbon style: a glowing thread in a light tint of the voice's colour, from inside
  the tail of each slurred note into the head of the next, with a small dot where it lands on each
  note (on top of the notes, lyrics above it — back-to-back notes leave no room for a bow between them).

### Sheet music view
An alternative view (the **Piano roll | Sheet music** switch in the player's top bar) for anyone
who reads traditional notation more comfortably — each voice gets its **own five-line staff,
stacked vertically** (never overlaid; the staves grow to fill the view's height, up to 1.4× on
phones and 1.3× on laptops, and spread out — the time axis grows only by the square root, so a
phone still shows a few beats), with barlines joining the staves into one system and a
classical thin+thick double bar at the end. All musical symbols — clefs (including the tenor's
treble clef with a small 8), noteheads, flags, accidentals, rests and augmentation dots — are
real engraving glyphs from the bundled **Bravura** SMuFL font, positioned with the font's own
anchor metrics (stem attachment points, flag origins), not hand-drawn shapes. Staff lines are a
neutral paper tone; notes, stems and flags carry the voice colour; lyrics sit at one fixed height
under each staff. A **pinned left margin** holds each voice's name, clef and key signature, and
the music scrolls under it (fading out at its edge), so clefs stay in view and lyrics never
collide with them. Muted voices leave the stack entirely instead of leaving a gap; ducked voices
dim. Real key signatures are shown, with accidentals only where they differ from the key or an
earlier note in the same bar; the time signature is deliberately not shown. Ties connect the
*original* tie-note boundaries from the file (§4.8), and rests fill silent gaps. Notes under the
playhead glow, as in the piano roll. It mirrors the piano roll's mute/solo/only-this-voice, zoom
and transpose (key-signature-aware, §4.8), and has its own ruler for grid-lock tap-to-seek.
**Not offered for MIDI-imported songs** (no real notated spelling to show, §4.8).

### Playback & transport
On a laptop, one transport bar runs along the bottom: the position readout (click it to go to a
bar), previous bar / Stop / Play / next bar, Loop and Metronome toggles, and steppers for tempo
(♩ = 100; click the value for presets and a custom field) and key (e.g. "G · +2"). On a phone
the same controls become a **dock** within thumb reach — Stop, previous bar, Play, next bar,
Loop — with an **info row** above it (bar, tempo, key, metronome) that opens the **Tempo & key**
sheet: tempo stepper and presets, custom tempo, key stepper with the transposed key's name,
metronome switch, section letters, and Go to bar. The screen is kept awake while music plays
(Screen Wake Lock), so a phone on the music stand doesn't lock mid-song. Every duplicated control
shares one delegated `[data-action]` handler in `main.ts`, so the laptop bar, the dock, sheets
and popovers can't drift apart.
- **Stop** returns to the loop region's start (if one is set), or the last point you tapped in
  the ruler, or the very beginning. Pressing Stop again while already sitting at that point
  goes the rest of the way back to beat zero.
- **Keyboard**: Space plays/pauses, ←/→ step a bar, L toggles loop, M toggles the metronome
  (all ignored while typing in a field or while a dialog is open).
- **Tempo**: presets (50/80/100/120/140), − / + in steps of 5, or any custom value (20–300).
  Opening a song never carries over the previous song's tempo: it starts at the song's saved
  default, else the first tempo written in the file (MusicXML `<sound tempo>` or a metronome mark,
  MIDI set-tempo; `Score.tempo`), else 100. Changing it while playing reschedules
  from the current position without a perceptible jump.
- **Metronome**: an optional click on every beat pulse (accented on downbeats), synthesized
  the same way as the notes.
- **Count-in ("Einzählen")**: pressing Play with the metronome on first counts out one full
  measure at the target tempo/time signature (correctly spaced for compound meters like 6/8)
  before the music starts — synced across every device in Ensemble mode. Only a genuinely
  **fresh** playback start triggers it (after a Stop, at the start of a piece, or after a
  seek) — never a plain Pause→Play resume, and never a tempo/key change or a seek while already
  playing. Tracked by a `freshStart` flag (`sync.ts`), see §4.7. A late-joining device skips the
  count-in and joins the music already in progress.
- **Starting tones ("Anfangstöne")**: a toggle next to the metronome (in the Tempo & key sheet on
  a phone), off by default and synced like the metronome. When on, every Play (a resume too)
  first sings the starting note of each voice that sings in the bar playback starts in — the note
  sounding at the start position, else its next note within that bar; voices entering later are
  left out — one after another in the score's voice order, top to bottom. Each is a synthesized
  "du" (`playDuNote` in `audioEngine.ts`: a sawtooth source through "u" vowel formants, F2 gliding
  down at the onset for the "d"), one beat apart at the current tempo; then all of them together
  as the chord (two beats), half a beat's breath, the count-in if the metronome is on, then the
  music. Synced in Ensemble via `PlaybackState.startTones` (explicitly `[]` on every other play
  publish — merge-write rule). A late joiner skips them.
- **Loop**: either loop the whole piece, or mark a region — drag across the score's ruler, or
  (with a mouse) across the whole-piece strip — and loop just that. The Loop toggle decides
  whether hitting the boundary wraps around or stops there.
- **Whole-piece strip**: below the score, every voice drawn as a thin line across the entire
  piece, the loop band, the played part shaded, the playhead, and section letters (laptop).
  Click to jump to that bar; drag with a mouse to mark a loop; on touch, drag to scrub through
  the piece (committed on release). Rendered once per size/mix change and only blitted per frame
  (`overview.ts`).
- **Transpose** (±7 semitones) and **Zoom** (25%–300%; − / + at the score's corner on a laptop,
  pinch on touch, ctrl/pinch-wheel on a trackpad) apply live, including mid-playback.

### Per-voice mixing
On a laptop the **voices sidebar** lists every voice with a light that glows while that voice is
singing at the playhead, and Mute / Solo buttons; on a phone the voices are **chips** above the
score, with a mixer button that opens the same rows in a sheet.
- **Mute** silences and hides that voice's notes.
- **Solo** (on one or more voices) ducks every non-soloed, non-muted voice to the "Others while
  soloing" level (a slider, 0–75%) rather than silencing them.
- **Clicking or tapping a voice's name** (sidebar name or phone chip) toggles *only this voice*:
  mutes and hides every other voice entirely; again restores everyone. **Reset** clears the mix.

### Voice menu: clef and removing voices
Each voice's ⋯ button (sidebar on a laptop, mixer sheet on a phone; library songs only) opens a
menu with Rename, the **clef** (treble, tenor = treble with a small 8, bass — MusicXML songs only,
since only they have a sheet-music view) and **Remove voice**. Both are stored beside the score,
never in it, like voice renames: `clefOverrides` (dot-path per voice) and `removedParts` (a list of
part ids) on the song's Firestore document, applied in `applyVoiceSetup()` when the song loads.
Removing asks for confirmation (it affects everyone) and can be undone from the player's ⋯ menu
(**Restore removed voices**); the last voice can't be removed. Other devices pick up clef and
voice changes as soon as their playback is paused.

### Editable song and voice names
Rename a song from its ⋯ menu in the repertoire, from the player's ⋯ menu, or by double-clicking
its title in the player; rename a voice by double-clicking its name in the sidebar, or with the
pencil in the phone's mixer sheet. Both open a small dialog; the new name applies immediately
and is written straight to Firestore (rolled back, with a message, if that write fails). Only
available for actual shared-library songs, not the bundled sample. The player always shows the
library title, not the title embedded in the file. A voice rename doesn't touch the stored
MusicXML/score data — it's a side-channel override (`partNameOverrides`, keyed by part id)
applied when a song loads. See §4.6 for the Firestore-side details, including a bug the design
deliberately avoids (a naive nested-object write would wipe every other voice's saved rename).

### Section markers and saved song defaults
Section letters (A, B, C, …) show as boxed rehearsal marks — in the score's ruler, on the
whole-piece strip (laptop) and in the phone's Tempo & key sheet — and jump straight to their
section. They come from the MusicXML file's own `<rehearsal>` marks (`Score.rehearsalMarks`,
§4.2) when it has any; otherwise the laptop-only flag button at the end of the whole-piece strip
marks the playhead position as the next letter. Hand-added letters are bookmarks: they're saved to
the song right away (`saveSongSections`, only `savedConfig.sections`), and after every change the
letters follow their order in the piece again (A, B, C — no gap or double after removing one).
**Removing**: right-click a letter on the whole-piece strip (laptop) or hold it in the phone's
Tempo & key sheet → jump there / remove this section / remove all; the player ⋯ menu also has
**Remove all sections** (with a confirmation). Letters printed in the file itself can't be removed.
**Save tempo, key and sections as default** (player ⋯ menu, laptop only, library songs only) still
snapshots transpose and tempo together with the letters (`saveSongConfig`). A file with its own
rehearsal marks never offers hand-added ones.

### Import & shared library
- Drop files anywhere on the repertoire page, or use **Add arrangement**, to import `.musicxml`, `.xml`, `.mxl` (MuseScore's
  zip-compressed export format — unzipped client-side via `fflate`), or a standard MIDI file
  (`.mid`/`.midi`, format 0/1/2 — parsed entirely client-side, no conversion service; see §4.2).
- Imported scores are gzip-compressed and written to a shared Firestore collection, so
  everyone using the app (any device, any browser) sees the same library in real time via a
  live `onSnapshot` subscription — no manual refresh, no per-device storage.
- A soft **PIN gate** blocks the library behind a single shared PIN, checked against a SHA-256
  hash stored in Firestore (never the plaintext). This is explicitly *not* real access
  control — Firestore's actual security boundary is "any anonymously authenticated client can
  read/write," which the PIN doesn't change. It exists purely to keep a shared link from being
  casually forwarded outside the group; see the code comment in `pinGate.ts` for the exact
  reasoning and its limits.
- Song titles and voice names come from a library anyone with the PIN can write to, so they are
  always rendered as text (DOM `textContent`), never parsed as HTML — the old library list used
  `innerHTML` with raw titles, which let a crafted title run script on every choir member's
  device.
- Deleting a song asks for confirmation first (the app's own dialog, naming the song) — the one
  destructive, unrecoverable action in the whole library (it removes the song for every device,
  not just the one that clicked it), unlike the trust model everywhere else in this app (renames,
  playback state) of applying shared-state changes immediately with no confirmation step.

### Scan sheet music (PDF / photos)
- When the scan service is configured (`VITE_OMR_URL` at build time, from the GitHub variable
  `OMR_URL`), **Add arrangement** opens a small menu: import a file, or **Scan sheet music**.
  Without it, the button imports files directly as before.
- The scan sheet (`scan.ts`) takes one PDF (≤ 30 MB, ≤ 40 pages) or up to 40 photos — taken with
  the camera on a phone, or chosen from the device — shown as numbered thumbnails that can be
  reordered and removed. Photos are scaled to ≤ 3000 px (EXIF orientation applied) and sent as JPEG.
- The service (`omr-service/`, a Node server in a Docker container — on the choir's own server
  via Docker Compose with Caddy for HTTPS, or on Google Cloud Run; its README covers both) runs **Audiveris** over all pages as one book, then asks **GPT** (OpenAI
  Responses API, model configurable) about every page: the page image next to what Audiveris read
  from it, in a compact JSON notation (per measure and part: voice, staff, chord, pitch as "F#4",
  duration as a quarter-note fraction, tie, lyric syllable). GPT answers with the complete
  corrected note list of each measure it would change (structured output with a strict JSON
  schema), plus voice names and the title. A correction is only written back when every voice
  still fills its bar (the time signature, or what the original measure had for pickups);
  otherwise Audiveris' reading stays and the report lists the suggestion as not applied.
- Progress (upload → reading → checking page n of N → done) shows in the sheet and, once it's
  closed, as a chip next to Add arrangement. The job id is kept per device, so a reload picks the
  scan back up. The result shows a per-page report (corrections, confidence, remarks), an editable
  title, **Add to repertoire** (imported like a MusicXML file) and **Download MusicXML**.
- Requests carry the device's Firebase ID token (checked by the service with firebase-admin);
  a job is only visible to the device that started it. The older `functions/` spike (Claude
  vision only, one page) is superseded by this and isn't used by the app.

### Synced multi-device playback
- Every connected device is a full remote control for one shared playback session: hitting
  Play/Pause/Stop, changing BPM, transpose, or the metronome, seeking via the ruler, marking a
  loop region, or picking a different song on *any* device applies to *every* connected device —
  including starting audio at (as close as technically possible to) the same real-world instant,
  not just the same logical position. Tempo is a synced field like everything else: any device
  can change it, but the value is always identical everywhere.
- Mute/solo/true-solo is the one deliberate exception: each device chooses which voices *it*
  hears independently of every other device, so e.g. a soprano can isolate their own part while
  everyone else in the room still hears the full mix. Not synced, personal per-device viewing
  preference too: zoom level, vertical scroll position, and the solo-ducking volume level.
- **Leading mode**: in Ensemble, the mode badge in the player opens a menu with **Lead the
  rehearsal**. The leading device's id is stored in the shared session (`leaderId`); every other
  device then follows — its shared transport controls (play, stop, jumps, tempo, key, loop,
  metronome, starting tones, song choice) are shown dimmed and answer with a short explanation
  instead of acting (one guard in `pushState`/`publishPlayingAt`), while mute, solo and zoom stay
  personal. The leader can hand the lead back; anyone else can **take over** after a
  confirmation (in case the leader's phone died). Leaving Ensemble as the leader releases it.
  Client-side enforcement, consistent with the app's soft trust model.
- **Sing-along view**: while someone else leads, a following device switches to a view with only
  the music and the voices (`#app.sing-along`): no transport, whole-piece strip or info row; the
  badge shows "Led · Bar 12". On a phone the voices become a dock at the bottom — **tap** switches a
  voice on/off (the last one heard stays on), **hold** opens the voices sheet — and the piano roll
  follows the music (below). The badge menu offers **Full view** (remembered per device,
  `ai-capella-full-view`) and back. Development builds expose `window.__aiCapellaDev.setLeader(id)`
  so tests can show the view without writing to the shared session.
- See §4.7 for how the cross-device timing actually works.

### Offline
The app works without a connection once it has been opened online on that device:
- `public/sw.js` (service worker, production builds only) keeps the app itself — page, scripts,
  styles, the Latin font subsets, the music font, icons and the sample song. Page loads are
  network-first with the stored copy as fallback; build files are served from storage first (their
  names change with every build) and older builds' files are pruned.
- Firestore's persistent local cache (IndexedDB, `firebase.ts`) keeps every song that has been
  listed, including its score, so the repertoire and every song open and play offline. The
  repertoire shows "Offline: showing the songs saved on this device" in that case. Changes made
  offline (renames etc.) are sent when the connection returns. Ensemble mode needs a connection.

### Design ("Dusk", with Samt & Glas)
The visual system, from the September 2026 redesign, extended by the "Samt & Glas" materials
layer (strength between "subtle" and "balanced" of its design draft):
- **Three materials.** *Velvet* is the ground (the title screen keeps its plain ground with only
  the voice ribbons moving): a slow wave backdrop in close ink shades with a
  faint voice-coloured rim on each crest (`backdrop.ts`: half resolution, 30 fps, still in a
  background tab and with reduced motion, still on phones and slowed on laptops while music
  plays) plus a fine pile texture; the score's stage and the repertoire cards are velvet too.
  *Glass* is everything that floats: real frosted blur where something sharp passes behind (the
  repertoire header over scrolling cards, the title screen's buttons, menus, sheets, dialogs);
  the player's permanent panels are tinted glass without blur, because blur there is recomputed
  every frame while the score plays (measured: 30 instead of 60 fps on a laptop) and only the soft
  waves are behind them. *Light* is only for the voices: gel notes (`theme.ts gelPill`), a glow
  in the voice colour on sounding notes, a warm beam for the playhead, the pearl play button,
  and a soft glow on switches that are on. Repertoire cards tilt toward a mouse with a spot of
  light following it. With reduced transparency everything glass becomes solid.
- **Only the voices have colour.** Chrome is ink (`#0D0C16` → `#302C44`) and paper (`#EFE7DA`);
  voice colours come from an eight-step warm-to-cool spectrum (`palette.ts`), spread across the
  whole spectrum for however many voices a song has, so the highest voice is always warmest and
  the lowest always coolest, and neighbouring voices never share a hue. Canvas code reads the
  same tokens from `theme.ts` that CSS reads from `style.css`.
- **Type**: Bodoni Moda (titles, wordmark; upright only — no italics anywhere), Atkinson Hyperlegible Next (everything read while
  singing, designed for legibility at a distance), Atkinson Hyperlegible Mono (bar, tempo and
  key readouts, so digits don't jump). All bundled via `@fontsource-variable/*` rather than
  loaded from Google (no visitor data to a third party — German courts have fined sites for
  remotely loaded Google Fonts — and works on weak Wi-Fi). Canvas text waits for them
  (`canvasFontsReady`) so cached lyric bitmaps never bake in a fallback font.
- **Music font**: Bravura (Steinberg, SIL OFL 1.1; licence in `src/assets/fonts`), subset with
  `pyftsubset` to the ~30 glyphs the sheet view uses (8 KB).
- **Icons**: one inline SVG set (`icons.ts`) instead of Unicode glyphs, which rendered
  inconsistently and could turn into emoji on iPhones.
- **Motion**: the title screen's voice ribbons (`artwork.ts drawRibbons`, ~30 fps, paused when
  the tab is hidden), sheet/popover/dialog transitions; everything is still for devices that ask
  for reduced motion.
- **Language**: German and English (`i18n.ts`), following the device language, switchable from
  the ⋯ menus. German key names use German spelling (B-Dur, H-Dur, fis-Moll).
- **App identity**: the mark (four voice lines that part and meet), favicon, home-screen icons and
  a web-app manifest, so "Add to Home Screen" opens AI-Capella full-screen.
- **Overlays** (`ui.ts`): menus (bottom sheets on phones), popovers, bottom sheets, confirm and
  rename dialogs, and toasts — one open at a time, Escape/outside-click to close, focus returned.

---

## 3. Project layout

```
AI-Capella/
├── index.html              # single entry point, mounts #app
├── public/
│   ├── evening-rise.musicxml   # bundled sample score
│   ├── favicon.svg, icon-*.png, apple-touch-icon.png   # app icons
│   └── manifest.webmanifest    # "Add to Home Screen" metadata
├── src/
│   ├── main.ts              # app shell, event wiring, transport/mix state, render loop
│   ├── musicxml.ts           # MusicXML → Score parser
│   ├── midi.ts                # Standard MIDI file → Score parser
│   ├── score.ts              # the Score data model + small pure helpers
│   ├── pianoRoll.ts           # canvas rendering: the piano roll itself
│   ├── staffView.ts           # canvas rendering: the alternate sheet-music view
│   ├── audioEngine.ts         # Web Audio synthesis + playback scheduling
│   ├── palette.ts             # voice colour spectrum, spread by voice count
│   ├── theme.ts               # design tokens for canvas drawing, font-readiness helper
│   ├── artwork.ts             # voice ribbons, app mark, per-song covers
│   ├── overview.ts            # whole-piece strip below the score
│   ├── ui.ts                  # menus, popovers, sheets, dialogs, toasts
│   ├── icons.ts               # inline SVG icon set
│   ├── i18n.ts                # German/English strings, key names
│   ├── assets/fonts/          # Bravura subset + its OFL licence
│   ├── library.ts             # Firestore-backed shared song storage, PIN verification, .mxl unzip
│   ├── sync.ts                 # multi-device shared playback session: clock calibration + pub/sub
│   ├── firebase.ts            # Firebase app/auth/Firestore initialization, anonymous sign-in
│   ├── firebaseConfig.ts      # Firebase web app config (not secret; see file comment)
│   ├── pinGate.ts             # the PIN screen
│   ├── scan.ts                # "Scan sheet music" sheet: pages, upload, progress, result
│   ├── backdrop.ts            # the velvet wave backdrop behind the whole app
│   └── style.css              # all styling
├── omr-service/            # scan service (Docker: own server or Cloud Run): Audiveris + GPT check
├── .github/workflows/deploy.yml   # builds and deploys dist/ to GitHub Pages on every push
├── vite.config.ts             # sets base: '/AI-Capella/' for GitHub Pages' subpath hosting
├── tsconfig.json
└── package.json
```

No bundler plugins beyond stock Vite + TypeScript. The app itself is a single-page client-side
bundle; the only server code is the optional scan service in `omr-service/` (with its own tests:
`cd omr-service && npm test`).

---

## 4. How it works, in more depth

### 4.1 Data model (`score.ts`)

Everything downstream — rendering, playback, hit-testing — works off one flat, immutable-ish
`Score`:

```ts
interface Score {
  title: string;
  parts: PartInfo[];           // one per voice (id + display name)
  notes: NoteEvent[];           // flat list across all parts, sorted by startBeat
  measures: MeasureInfo[];      // for the ruler's measure numbers / time signature
  slurs: SlurArc[];
  totalBeats: number;             // ties aren't a separate field -- see below, they're merged into notes
}
```

Time is always expressed in **quarter-note beats** from the start of the piece — never
seconds, never MusicXML's raw `<duration>` divisions. Seconds only enter the picture inside
`AudioEngine`, where a beat position is converted to a Web Audio `AudioContext.currentTime`
offset using the current BPM. This is what makes changing BPM live trivial: nothing about the
score model or the rendering math depends on tempo at all.

### 4.2 Parsing (`musicxml.ts`, `midi.ts`, `library.ts`)

`parseMusicXML` walks a `score-partwise` MusicXML document part-by-part, measure-by-measure,
tracking a `cursor` (in beats) that advances with each `<note>` and rewinds/advances on
`<backup>`/`<forward>` (used for chords and cross-voice layering within a measure). It
handles:
- Multiple parts, multi-note chords (`<chord/>`), rests.
- Mid-piece `<divisions>` and `<time>` (time signature) changes.
- **Slurs** (`<notations><slur>`), tracked per-voice with an open/close map keyed by the
  slur's `number` attribute.
- **Ties**, checked against *both* `<tie>` (the sound-level element) and
  `<notations><tied>` (the notation-level element) — real-world files, especially
  OMR/scan-derived ones, sometimes only emit one or the other. A note can't itself cross a
  measure boundary in the MusicXML format, so a note held across one (or tied for any other
  reason) is necessarily written as multiple `<note>` elements — but musically it's one
  continuous note, so the parser *merges* a tied sequence into a single `NoteEvent` (extending
  its `durationBeats` through each tied segment, chains included) rather than keeping them
  separate and bridging the gap visually. This is what makes a tied note render as one seamless
  bar and play back with a single attack instead of an audible retrigger at the tie point. The
  original tie-note boundaries aren't thrown away in the process, though: each individual tied
  `<note>`'s own duration is also appended to the merged `NoteEvent.tieSegments` array (computed
  the same self-correcting way `durationBeats` itself already was, so the segments always sum
  exactly to it) — the sheet-music view uses this to notate the *actual* tie the source file
  specified, rather than re-deriving a plausible-looking split mathematically. See §4.8.

`.mxl` files (MuseScore's default export — a zip containing the MusicXML plus a
`META-INF/container.xml` manifest) are unzipped client-side in `library.ts` using `fflate`,
reading the manifest to find the actual score file inside the archive.

**A `<note>`/`<rest>` missing `<duration>` no longer silently becomes zero-length.** The spec
requires `<duration>` on every note/rest, but not every real-world file is spec-perfect —
hand-edited files and this app's own OMR vision-transcription spike alike can emit a `<type>`
(the notated appearance: "quarter", "eighth", ...) without a computed `<duration>`, especially
for a rest with nothing musically "there" to double-check a length against. Left unhandled, that
note/rest's `durationBeats` came out `0` and the parser's `cursor` never advanced past it. Fixed
with a fallback to `<type>` (+ a dot) when `<duration>` is missing or zero, using the same
beats-per-type units `staffView.ts`'s `DURATION_TABLE` already does (a quarter note is 1 beat,
independent of `<divisions>`). A whole-measure rest (`<rest measure="yes"/>`) gets a further
fallback on top of that — spec-legal without either `<duration>` or `<type>`, since its length is
implied entirely by the measure's own time signature — filling to the end of the measure.

**A `<grace/>` note is explicitly excluded from that same `<type>` fallback, and never advances
`cursor` at all.** A grace note is spec-defined to carry no `<duration>` — it's deliberately
"outside" normal measured time (an ornamental note played quickly around the note it decorates),
not a file that merely forgot to include one, so it must never be treated the same as an
actually-missing duration. Confirmed concretely from a submitted score excerpt ("Jagdlied"): a
grace note leads into a triplet run. Before this exclusion, a grace note picked up a real, nonzero
duration from its own `<type>` via the fallback above, and that got added to `cursor` — silently
displacing every later note in the part by that amount, compounding with every further grace note
in the piece (matching a reported bug: voices drifting out of alignment with each other from a
certain point onward). A grace note is still added as a real (if very short,
`GRACE_NOTE_DURATION_BEATS`) audible/visible `NoteEvent`, ending exactly at the position the next
real note starts — just never allowed to move `cursor` itself.

**A measure's real length is however far its own content actually reaches, not always the
time-signature-implied length (`beats * 4/beatType`).** Those only coincide for an ordinarily-
complete measure; a **pickup/anacrusis measure** is genuinely shorter, and is a normal, common
case, not an error — concretely, "Nachtigall" (a reported bug) opens with a single eighth-note
upbeat in a 3/8 piece, well short of a full 3/8 measure. The parser used to always advance
`measureStartBeat` by the full time-signature length regardless, which for a pickup measure
silently padded in an extra gap of silence before measure 2 and shifted every subsequent
measure/note in the piece later than the source actually notates — worse the more measures away
from the pickup, which is why it showed up most obviously as a *different* voice's first real
note (e.g. a Tenor/Bass part resting through the pickup and the next couple of measures) landing
at the wrong beat entirely, not just "one beat off." Fixed by tracking the furthest `cursor`
actually reaches while walking a measure's content (across every backup/forward-interleaved
voice) and using that as the measure's real length, falling back to the time-signature length
only when a measure has no content at all to measure against. Relies on the source file being
internally consistent about where a pickup measure's shorter boundary falls across every part —
true of any properly engraved score (parts sharing a measure numbering only makes musical sense
if all of them agree on where each measure starts and ends), but this is why the *measures* list
itself is still only ever built from the first part processed (`measuresBuilt`): every other
part's per-note beat math uses this same actual-content-length logic independently, and should
agree with the first part's boundaries rather than needing to re-derive/share them.

**`<clef>` (sign/line/clef-octave-change) is now read from `<attributes>` and stored on
`PartInfo.clef`**, rather than every part's staff-view clef being purely a heuristic guess from
its average pitch. Most concretely, this fixes the real-engraving choir "tenor clef" convention —
a treble (G) clef with a small 8 printed below it (MusicXML `clef-octave-change: -1`, "sounds an
octave lower than written") — which previously either got guessed as a plain bass or treble clef
by average pitch, or (even when the heuristic happened to guess "treble" correctly) was
positioned on the staff at its literal sounding octave, landing on many ledger lines below the
staff instead of where a real tenor clef actually places it. See §4.8 for how `staffView.ts`
resolves and applies this (`resolveClef`, `octaveShift`) — the `<pitch>` data itself (and
therefore MIDI/playback) is unaffected either way, since clef only ever changes where a note is
*positioned* on the page, never what pitch it actually is.

**`<direction><direction-type><rehearsal>` marks are parsed into `Score.rehearsalMarks`**
(label + beat position), the same way `<clef>` and everything else structural is: only from the
first part processed (`measuresBuilt` again — a rehearsal mark is a piece-level concept, and real
scores conventionally print one only once, usually on the top staff), recorded at whatever `cursor`
position the `<direction>` element appears at in the file. See §2's "Section markers" for how
`main.ts` uses this (and what happens when a file has none).

**MIDI import** (`midi.ts`) is a from-scratch standard MIDI file (SMF) reader — no external
library — supporting format 0, 1, and 2 files, running status, and both text/lyric meta-event
conventions. It parses directly into the same `Score` model, notably *without* going through
MusicXML at all: a MIDI note is already a plain numeric pitch (0–127, and note 60 = C4 in both
MIDI's own numbering and this app's `midi` field), so there's no step/alter "spelling" to
reconstruct the way a MusicXML writer would need. Each MIDI track becomes a voice/part (named
from its Sequence/Track Name meta event, or "Track N"; a track using more than one channel is
split further, one part per channel); Lyric (and Text) meta events are attached to whichever
note-on comes next in that track, matching the common karaoke-MIDI convention; Time Signature
meta events drive the same measure-boundary construction MusicXML import does. A MIDI file's own
tempo (Set Tempo meta events) is read only far enough to be skipped — like MusicXML, tempo
always comes from the app's own BPM control, never the source file. Because the resulting
`Score` has no natural MusicXML-equivalent text form worth manufacturing, MIDI imports are
stored in the shared library as a JSON-serialized `Score` rather than XML text — see
`StoredSong.format` in `library.ts`, which every load path branches on.

### 4.3 Rendering (`pianoRoll.ts`)

This is the most performance-sensitive part of the app — it has to redraw smoothly during
playback, every animation frame, on everything from a phone to a 4K desktop monitor. The
design went through several rounds of performance/sharpness fixes; the current approach:

**Pre-rendered scrolling buffers, blitted per frame.** Gridlines, note bars, lyrics, and slurs
don't change relative to each other during playback — only the horizontal scroll offset does. So instead of re-issuing hundreds of fill/stroke/text calls every frame, they're
rasterized *once* into a wide offscreen canvas (`contentBuffer`, spanning several
viewport-widths of beats) whenever something structural actually changes (mute/solo,
transpose, zoom, resize, or the playhead nearing the buffer's edge). Every frame then does a
single cheap `drawImage` blit of just the visible slice. The ruler's measure-number labels get
the same treatment in a matching `rulerBuffer`, rather than being `fillText`'d fresh every
frame.

**Pixel-snapped blitting.** Even a nominally 1:1-scale `drawImage` blurs slightly if its
destination lands on a fractional device pixel — which, mid-playback, it does essentially
every frame, since the scroll offset follows continuous audio time rather than discrete pixel
steps. `snapToDevicePx()` rounds every blit's destination (content buffer, ruler buffer,
playhead line, note-preview label) to the nearest whole device pixel before drawing, which
keeps text and note bars crisp instead of subtly resampling every frame. Canvas image
smoothing is also explicitly disabled as a second line of defense.

**Lyric text is cached as bitmaps**, not re-shaped from `fillText` on every buffer rebuild —
each distinct syllable is rasterized once into its own small offscreen canvas and reused.

**`devicePixelRatio` is capped at 2×** (`MAX_DPR`), covering standard Retina displays without
needlessly quadrupling backing-store size on 3× phone screens. A defensive
`MAX_BUFFER_DEVICE_PX` cap (8192px) also bounds the content buffer's absolute width, since some
browser/GPU combinations silently clamp or fail to paint canvases beyond roughly that size —
this only ever engages on unusually wide and/or high-DPI displays.

**View vs. playhead are two separate beat values.** `render(displayBeat, playheadBeat)` takes:
- `displayBeat` — the view's own horizontal reference point (what the content is scrolled to).
- `playheadBeat` — where the piece actually is (or will resume from).

They coincide, and the playhead line sits at its usual fixed screen position, whenever the
view hasn't been panned away from the actual position — which is always true during playback
(panning is locked then) and usually true while paused. While paused, though, panning is still
allowed to browse the score, and the playhead line is computed from `playheadBeat`
independently, so it correctly drifts away from (or entirely off) its usual spot rather than
silently relabeling whatever beat the pan happened to land on.

**The fixed pitch-row range (`minMidi`/`maxMidi`) tracks the current transpose, not just the
untransposed notes.** Notes are drawn at `note.midi + this.transpose`, but this range used to be
computed once at construction from the untransposed pitches alone and never revisited when
transpose changed. Transposing far enough (down, most noticeably — reported as bass notes
becoming permanently invisible and unreachable by scrolling) could put a note's row outside
`[minMidi, maxMidi]` entirely: `rowY()` would place it beyond the content area's bottom/top, and
`maxScrollY()` (itself derived from that same range) couldn't scroll far enough to reach it.
Fixed by recomputing the range from the untransposed extremes (`basePitchMin`/`basePitchMax`)
plus the current transpose every time `setTranspose()` runs, rather than fixing it forever at
construction. Both bounds shift by the same amount, so the range's *size* — and therefore
`contentHeightPx()`/`maxScrollY()` — stays constant across any transpose value; only which
pitches the existing scroll position shows changes, so this needed no `scrollY` adjustment of its
own and doesn't disturb the untransposed case at all.

**Piano-key gutter, reintroduced in a non-persistent form.** An earlier version kept a full
keyboard permanently down the left edge (removed in favor of click-to-preview, see §2); a
simplified version is back — a light/dark band per semitone row (matching real piano key
coloring, not literal interlocking key shapes) drawn once immediately before beat 0, painted
directly into `contentBuffer`/`paintContent` like gridlines or notes rather than as a separate
pinned overlay. Because it lives in the same beat-space-positioned buffer as everything else, it
scrolls out of view naturally once playback moves past the piece's start, with no extra pinning
logic needed, and it redraws for free on every existing buffer-rebuild trigger (zoom, resize,
etc.) without a new one. Its pixel width is converted to an equivalent beat-width at the buffer's
current `pixelsPerBeat` (`KEYBOARD_WIDTH_PX / pixelsPerBeat`), so it renders as a consistent
physical size regardless of zoom level. `hitTestKeyboard()` (used by the same click handler
`hitTestNote()` already wires up, as a fallback when no actual note is hit) maps a click back to
a MIDI pitch the same way `hitTestNote()` does, previewing the tone through the same
`audioEngine.previewNote()` path — just without a note-name label, since a keyboard key isn't a
real `NoteEvent` with its own beat position to anchor one to.

**Self-correcting buffer bounds.** Before blitting, `render()` verifies the content buffer
actually covers the full visible width and forces an immediate rebuild if it doesn't — a
defensive invariant added after an intermittent, never-reliably-reproduced "black unpainted
strip" report, rather than trusting the incremental rebuild-margin heuristic blindly. A
`ResizeObserver` on the canvas (in addition to the `window.resize` listener) catches mobile
viewport size changes — address bar show/hide, dynamic toolbars — that don't fire a `resize`
event but do change the canvas's actual laid-out box.

### 4.4 Audio (`audioEngine.ts`)

Two playback sounds, chosen per device in the player ⋯ menu (`ai-capella-sound`, not synced):
- **Grand piano** (default): recorded samples of the **Salamander Grand Piano V3** (Alexander Holm,
  Yamaha C5, CC BY 3.0 — credited in `public/samples/piano/ATTRIBUTION.txt`), velocity layer 8 of
  16, one note every third semitone from A1 to C7 (22 files, 1.7 MB: leading silence removed,
  shortened to 5–8 s with a fade, mono, 96 kbit/s MP3, named by MIDI number). Each note plays the
  nearest recording re-pitched by at most 1.5 semitones, with a damper at note-off. Loaded once per
  page and shared by every engine; the service worker stores them for offline use. Until they're
  loaded (or if they can't be), the earlier synthesized piano plays — triangle + sines with a
  sweeping lowpass and an attack/decay/release envelope.
- **Voice (oo)**: a sustained sung tone for long notes, where a piano dies away — two slightly
  detuned sawtooth sources through the "u" vowel formants of the starting-tone "du" (darker for low
  voices), vibrato fading in on longer notes.
- **Mix**: voices stand across the stereo field like a choir seen from the front (first voice left,
  last right); a small generated room (convolution with a noise impulse that darkens as it decays,
  1.6 s) on everything but the metronome; bus compressor, then a limiter — measured over a six-voice
  passage, the old synthesized sound peaked at 1.15 (clipping), now every sound stays below 0.95 at
  matched loudness.
- Playback works by **scheduling every note's oscillators up front** at the moment `play()` is
  called, using the Web Audio clock (`AudioContext.currentTime` plus each note's beat offset
  converted via the current BPM) — not by ticking through notes one at a time in JS. This is
  what keeps timing sample-accurate regardless of main-thread jank from rendering.
- Each voice has its own `GainNode`; mute/solo/duck states are just gain-node level changes
  (`setTargetAtTime` for a short, click-free ramp), routed through a shared
  `DynamicsCompressorNode` before the destination — doubled/unison voices (common in choral
  writing) stack gain and can clip without it.
- **`pause()` suspends the `AudioContext` *and* clears every scheduled-but-not-yet-fired
  oscillator.** Suspending alone freezes the clock but doesn't cancel already-scheduled
  `.start()`/`.stop()` calls — they just wait. Since clicking a note to preview its pitch
  (`previewNote()`) unconditionally resumes the context, a paused-but-still-scheduled note
  would fire in a burst the moment you clicked anything, sounding like playback had resumed on
  its own. Clearing the schedule on pause removes that risk entirely; resuming always goes
  through `play()` again, which reschedules everything from the current position anyway.
- Changing BPM, transpose, or the metronome toggle mid-playback all just call `play()` again
  from the current beat — full re-schedule, not an incremental patch — which is simple and, in
  practice, imperceptible. **Exception**: a metronome toggle that arrives while a count-in is
  still sounding does *not* immediately call `play()` — see below.
- `play()` takes an optional `startAtEpochMs`: a wall-clock instant (`Date.now()`-style) to
  begin at, translated into this device's own `AudioContext` clock, instead of the default "as
  soon as possible." This is what §4.7's multi-device sync uses to make every device start at
  the same real moment; if that instant has already passed by the time `play()` runs, playback
  joins already in progress from wherever it would be right now rather than starting late.
- `play()` also takes optional `countInBeats`/`countInPulseBeats`: when set, that many
  metronome-style clicks (first one accented, spaced `countInPulseBeats` quarter-beats apart —
  the pulse spacing, not just the raw beats count, so a 6/8 count-in clicks 6 correctly-spaced
  eighths rather than 6 quarter-beats) are scheduled ending exactly at the music's start
  instant. If there isn't actually room before that instant (a late-joining/late-delivered
  device), the count-in is silently skipped rather than started late — same principle as the
  "join already in progress" behavior above. `isCountingIn()` reports whether one is currently
  playing, so `main.ts` can show a "Count-in…" label instead of the normal position readout.
- **Click/pop fix.** Every scheduled oscillator/gain pair is tracked as a `Voice`
  (`scheduledVoices`), and `clearSchedule()` — called at the top of every `play()`/`pause()`/
  `stop()`, including the re-schedule calls above, which is why this used to click on almost
  any mid-playback control change — fades each voice's gain to (near-)zero
  (`cancelAndHoldAtTime` + a short `linearRampToValueAtTime`) *before* stopping its
  oscillators, instead of calling `.stop()` immediately on whatever the waveform happened to be
  doing. An abrupt stop mid-waveform is a textbook Web Audio discontinuity — audible as a
  click/pop, exactly matching feedback that playback "sometimes clicks or clips... like when
  you plug a cable into a speaker." A second, related bug in the note envelope itself (a
  sustain-hold automation event landing *before* the decay ramp's own end time, which Web Audio
  resolves by holding flat at peak volume and then jumping straight to the sustain level instead
  of actually decaying, for most notes under ~0.4s) is fixed alongside it.
- **Metronome-active-but-silent / can't-toggle bug (found and fixed)**: root cause was
  `setMetronomeEnabled()`'s handling of a toggle that arrives *while a count-in is still
  sounding*. It used to just skip the reschedule outright — deliberately, since a full `play()`
  reschedule right then would cut the still-sounding count-in short and desync it from every
  other synced device — but the flag change was then silently dropped, not deferred. `tick()`'s
  ordinary incremental top-up doesn't pick it up either: its horizon check is keyed on
  `scheduledUpToBeat`, which the count-in's own `play()` call already advanced up to
  `LOOKAHEAD_SEC` (8s) ahead using whatever `metronomeEnabled` was at that moment —
  `scheduleMetronomeInRange`'s range starts from that already-advanced point, so every beat
  marker before it is skipped forever, never revisited. Net effect: toggling the metronome
  during a count-in could produce up to 8 seconds of silence (toggling on) or up to 8 seconds of
  clicks that wouldn't stop (toggling off) once the count-in ended — matching the reported
  "shows on but stays silent, and won't toggle" symptom. **Fix**: a new
  `pendingMetronomeReschedule` flag. A toggle mid-count-in sets it instead of no-op'ing;
  `tick()` checks it first on every call and, the moment `isCountingIn()` goes false, applies
  the deferred toggle via a normal full `play()` reschedule (the same one the non-count-in path
  already did immediately) — without ever touching the count-in's own already-scheduled clicks.
  An ordinary toggle outside a count-in is unaffected, still applied immediately as before.
  Verified with a scripted regression test (mocked Web Audio API, real `AudioEngine` class, a
  manually-advanceable fake clock) covering toggle-off-mid-count-in, toggle-on-mid-count-in, and
  the ordinary non-count-in path; the same test fails against the pre-fix code and passes against
  the fix.

### 4.5 Input handling (`main.ts`)

- All view-affecting input (wheel, drag, resize) goes through `scheduleRender()`, which
  coalesces any number of same-frame requests into a single `requestAnimationFrame` callback —
  wheel/pointermove events fire far faster than the display refreshes, and rendering
  synchronously per event was the original source of scroll stutter.
- Wheel and pointer-drag panning both use **dominant-axis locking**: once a gesture commits to
  being mostly horizontal or mostly vertical (based on accumulated delta since the gesture
  started), only that axis's pan is applied for the rest of the gesture. Real trackpad/touch
  input is rarely perfectly axis-aligned, and applying both deltas on every event let an
  intended vertical scroll bleed a little unwanted horizontal pan into the view (and vice
  versa).
- The canvas's layout rect (`getBoundingClientRect()`) is cached (`updateCanvasRect()`) and
  only re-read on actual resize/view-mode-change events, not on every pointer event or frame —
  reading layout geometry inside a hot per-frame path forces synchronous layout thrashing in
  the browser.
- `setPositionText()` skips the DOM write entirely when the displayed string hasn't changed
  (which is most frames, since the "Measure N · Beat M" text only changes once per beat) —
  another avoided source of unnecessary style/layout invalidation during playback.
- A ruler tap's raw pixel-derived beat is snapped to `measureAtBeat()`'s containing measure's
  `startBeat` before it's used — floor semantics (a tap anywhere in measure 5 snaps to measure
  5's start, not measure 6's), reusing the existing beat→measure lookup rather than adding a new
  one. Deliberately not applied to loop-region dragging: snapping both drag endpoints to their
  own containing measure's start could collapse a short drag entirely inside one measure to a
  zero-length region.
- **`seekToBeat(beat, opts?)`** distinguishes a grid-lock tap from a deliberate jump via an
  optional `recenterView` flag: a plain ruler tap (piano roll or sheet music) only moves the
  playback-start line, leaving the view exactly where it was, while bar jumps (Go to bar, previous/next bar, sections) pass
  `recenterView: true` so the view actually snaps to the target — the two gestures have
  different intents (mark a start point while still looking at the current spot, vs. actually
  go look at a different part of the piece).
- **No collapsible settings panel any more.** The old layout needed a collapse toggle (and a
  vertical-flick gesture on the canvas) because its controls took half a phone screen; the
  redesign's dock and sheets leave the score most of the height, so both were removed — the
  flick also fired by accident when scrolling fast.
- **The Go-to-bar field proactively clamps itself** (on submit, in `gotoBlock()`) rather than relying on the input's
  native `min`/`max` validation — an out-of-range value left for the browser's own validation to
  catch was the likely cause of a reported visual "wobble" on mobile (a native shake animation
  outside this app's control), so the fix is to never let the field hold an out-of-range value
  in the first place.
- **The sheet-music view now supports touch/pointer drag-to-scroll.** `#staff` has always set
  `touch-action: none` (so a touch drag doesn't fight the browser's own native page-scroll
  gesture), but until now nothing filled in the JS side of that — the canvas only had a `wheel`
  handler (mouse/trackpad only) and a plain `click` handler for ruler tap-to-seek, so a phone or
  tablet had no way to scroll the stacked staves at all once they didn't all fit vertically (a
  real, confirmed gap, not a perception issue). A `pointerdown`/`pointermove`/`pointerup` set
  below the ruler strip mirrors the piano roll's axis-locked drag (vertical scroll, horizontal
  pan via the same shared `displayBeat()`/`viewOffsetBeats` mechanism both views already read
  from) — without the piano roll's ruler-drag loop-selection or tap-to-preview, which are
  piano-roll-only features.
- **Two-finger pinch-to-zoom** (`PinchZoomTracker`) is wired into both canvases' existing pointer
  handlers, sharing the same `applyZoom()` the +/− zoom buttons use. It tracks every currently-
  down pointer by id; once exactly two are down, each move reports the ratio of the new
  inter-finger distance to the *previous move's* (not the gesture's starting distance, which
  would make the reported ratio cumulative rather than the per-call multiplicative factor
  `applyZoom()` expects). A second finger landing mid-drag abandons whatever single-pointer
  gesture (pan, scroll, or a piano-roll ruler loop-selection) was already in progress rather than
  letting both run at once — the existing single-pointer drag state is reset the moment a pinch
  starts, and isn't resumed for whichever finger remains once the pinch ends (lifting both and
  re-touching is an accepted, minor UX cost for keeping the two gestures from fighting).
- **Audio scheduling top-up and the loop/end-of-piece boundary check run on their own
  `setInterval`, independent of the visual `requestAnimationFrame` loop.** They used to live
  inside the same rAF-driven `renderLoop` that draws each frame — but most browsers throttle rAF
  to near-zero or stop firing it entirely once the tab/screen is backgrounded, and
  `AudioEngine`'s scheduled-ahead window is bounded (`LOOKAHEAD_SEC`, 8s), so playback (and the
  metronome) would just go silent a few seconds after switching away from the app, and a piece
  that should loop or stop at its end wouldn't do either while backgrounded. `audioTick()`
  (`AUDIO_TICK_INTERVAL_MS`, 200ms) now owns `audioEngine.tick()` and the boundary check;
  `renderLoop` only reads the current beat and draws. `setInterval` is throttled too (to roughly
  once a second in most browsers when hidden) but isn't halted the way rAF often is — comfortably
  within `LOOKAHEAD_REFILL_SEC`'s (3s) margin to keep the schedule topped up. Verified by freezing
  `requestAnimationFrame` entirely and confirming new notes/clicks keep getting scheduled well
  past the initial 8s lookahead regardless (fails against the pre-fix code, where scheduling
  visibly stalls at the very first lookahead window once rAF stops firing).
- **Song/voice renames apply optimistically, with a rollback and a visible error on failure.**
  The inline-edit element's own text was never touched until the Firestore write's `.then()`
  resolved, so every rename visibly flashed back to the *old* value the instant you committed it,
  then (if and only if the write actually succeeded) jumped to the new one a moment later — itself
  enough to read as "unstable," and a failed write (permissions, network) surfaced nowhere but a
  console.warn, i.e. a silent, unexplained revert. Both rename handlers (song title, voice name)
  now update the local text/state immediately and only roll it back — checking the edited
  song/part is still the one on screen, in case the user has since navigated elsewhere — if the
  write actually rejects, surfacing the failure via `setImportStatus` instead of the console.

### 4.6 Shared library & access (`firebase.ts`, `library.ts`, `pinGate.ts`)

- Firebase is initialized only if `firebaseConfig.ts` looks configured (`isFirebaseConfigured`);
  without it the import button is simply disabled and the app still works fully for the
  bundled sample song.
- Every client signs in **anonymously** (`ensureSignedIn()`) before touching Firestore, since
  the security rules require `request.auth != null`. Anonymous auth state is asynchronously
  restored from persisted storage on load, so `ensureSignedIn()` waits for the *first*
  `onAuthStateChanged` callback before deciding whether to call `signInAnonymously()` — calling
  it based on a synchronous `currentUser` read (which reads `null` for a moment even when a
  session is about to be restored) would silently create a brand-new anonymous account on
  every single page load instead of reusing the persisted one.
- Firestore is initialized with `experimentalAutoDetectLongPolling: true`, since its default
  WebChannel streaming transport can stall indefinitely behind some restrictive proxies/VPNs —
  a documented Firebase workaround for that exact symptom.
- Imported scores are **gzip-compressed** (`fflate`) before being written to Firestore, since a
  document is capped at 1 MiB; `MAX_COMPRESSED_XML_BYTES` leaves headroom below that limit and
  produces a clear error (naming the actual compressed size) if a score is still too large
  after compression. Older documents written before compression was added are still read
  correctly via a fallback to a raw `xml` field.
- The song list is a **live subscription** (`onSnapshot`), not a one-time fetch — importing or
  deleting a song from any device updates every other open client immediately, with no manual
  refresh. A collection `onSnapshot` fires (with the full current result set) on *any* change to
  *any* doc in it, so `subscribeToSongs` keeps a **per-song decompression cache** across
  snapshots, keyed by doc id, and only re-gunzips/re-decodes a song via `docChanges()` when that
  specific doc actually changed — reusing every unchanged song's already-decoded `StoredSong` as-
  is. Before this, one voice's rename or one new import re-gunzipped and re-decoded *every* song
  in the library, on *every* connected device, on every single such event — with a roomful of
  devices all doing that main-thread work simultaneously, this was a real, repeatable cause of a
  synced-rehearsal-wide stutter/freeze that got worse the more songs (and the more people editing
  at once) there were — a concrete, confirmed contributor to reported multi-device performance
  problems.
- The PIN itself is never stored or transmitted in the clear: `verifyPin()` hashes the entered
  PIN with SHA-256 (`crypto.subtle.digest`) client-side and compares it against a `pinHash`
  field on a single `config/access` Firestore document. As documented directly in the code,
  this is a *soft* gate against casual link-sharing, not a real security boundary — Firestore's
  actual access control is "authenticated (even anonymously) clients can read/write," which the
  PIN does nothing to restrict.
- **Renaming** (§2) writes through `updateSongMetadata(id, patch)`, an `updateDoc` on the song's
  existing document — the app's first update-in-place write; every other write was previously
  either a brand-new document (`saveImportedSong`) or a full delete. A song title is a plain
  top-level field write, but a voice rename uses a **dot-path field key**
  (`` `partNameOverrides.${partId}` ``) rather than writing `{ partNameOverrides: { [partId]:
  name } }` as a literal nested object — Firestore's `updateDoc` only merges at the top level of
  the fields object it's given, so a plain object value for a field *replaces* whatever was
  already stored there wholesale. With a real multi-part choir score, that would mean renaming a
  second voice silently wiping out every other voice's already-saved rename the next time this
  ran. The dot-path form updates only that one nested key, leaving the rest of the map alone.
  `partNameOverrides` itself is applied client-side, once, right after a song's `xml`/`score`
  blob is parsed and before anything downstream (the parts panel, piano roll, sheet view) reads
  a part's name — the stored source data is never rewritten just to rename a voice.

### 4.7 Synced multi-device playback (`sync.ts`, `main.ts`)

One Firestore doc, `sessions/live`, holds the entire shared transport state — `songId`, `bpm`,
`transpose`, `metronomeOn`, `loopEnabled`/`loopRegion`, the play/pause origin (`playing`,
`originBeat`, `originServerTimeMs`), `countInBeats`/`countInPulseBeats` (the count-in described
in §2/§4.4), and `freshStart` (whether the *next* Play should count in at all — see below).
Every connected device subscribes to it via `subscribePlaybackState()`.
Mute/solo/true-solo is deliberately *not* in this doc — see "Not synced" below. Only active in
**Ensemble mode** (`syncEnabled()` = `isFirebaseConfigured && sessionMode === 'ensemble'`,
`sessionMode` set from the title screen/`localStorage`, see §2) — in **Solo mode**,
`pushState()` applies every change immediately and locally instead, the same fallback path used
when there's no Firebase backend at all, and the calibration/subscription setup in the
bootstrap is skipped entirely. The shared song *library* (a different Firestore collection,
`subscribeToSongs()`) is unconditional on `isFirebaseConfigured` alone, unaffected by this —
Solo mode only opts out of playback sync.

`countInBeats`/`countInPulseBeats` are **required fields, not optional ones**, specifically
because `publishPlaybackState()` is a Firestore *merge* write: a field left out of a patch keeps
its previous value in the shared doc rather than resetting. Every `publishPlayingAt()` call that
starts playback without an intentional count-in (BPM/transpose-while-playing, seek-while-playing)
explicitly zeroes both fields — omitting them would let a stale count-in from an earlier fresh
Play silently reattach itself to an ordinary tempo tweak, turning it into a multi-second
count-in-then-delay. Only `togglePlay()`'s actual Play branch computes a real value, from the
target measure's own time signature. A count-in also needs real *lead time* before the music's
start instant — `computeFutureOriginServerTimeMs()` takes an `extraLeadMs` parameter for
exactly this, since the fixed 750ms sync buffer alone is nowhere near long enough to fit a
multi-second count-in before playback begins.

`freshStart` follows the same required-field, same merge-write-staleness reasoning: it's `true`
after a Stop, a paused seek (a ruler/staff-ruler grid-lock tap or Measure-jump-Go), or a fresh
song selection, and `false` after a plain Pause — every site that publishes `playing: false`
sets it explicitly. `togglePlay()`'s Play branch reads it (alongside `metronomeOn` and a valid
target measure) to decide whether *this* Play actually counts in — a Pause→Play resume from
wherever playback stopped should never re-trigger the count-in, only a genuinely new start
should. Read locally, not round-tripped through a publish/subscribe cycle for the read itself.
One easy-to-miss detail: `currentStateSnapshot()` — the full-state fallback `pushState()` uses
in Solo mode (no Firebase) — must also read the live `freshStart` variable rather than a
hardcoded value, or Solo mode (the app's default, no-backend mode) would silently reset
`freshStart` to `true` on every interaction and the whole feature would do nothing there.

**The hard part: making Play land at the same real instant, not just the same logical beat.**
Broadcasting "play now" doesn't work — Firestore's realtime updates don't arrive at every
device at the same moment (latency varies, worse on the long-polling fallback `firebase.ts`
already falls back to on restrictive networks), so "start as soon as the update arrives" would
make devices start audibly out of sync with each other. Instead, a device that presses Play
broadcasts a **future** instant (`computeFutureOriginServerTimeMs()`, `Date.now() + offset +
750ms`) rather than "now," and every device — including the one that pressed Play — translates
that shared instant into its own `AudioContext` clock and schedules `AudioEngine.play()`'s
`startAtEpochMs` to begin exactly then (see §4.4). The 750ms buffer just needs to comfortably
exceed normal propagation latency without feeling laggy.

**Clock calibration.** Translating a shared server-time instant into "when is that on *my*
clock" requires knowing the offset between this device's `Date.now()` and true server time —
device clocks aren't perfectly synced, and can drift or jump (laptop sleep, mobile tab
suspension). `calibrateClockOffset()` does an NTP-style round-trip measurement: write a
per-*device* Firestore doc (keyed by a `crypto.randomUUID()` persisted in `localStorage` — a
*shared* calibration doc would let two devices' concurrent writes corrupt each other's
round-trip reading) with a `serverTimestamp()`, read it straight back from the server
(`getDocFromServer`, bypassing the local cache, which would just echo the write instantly and
defeat the measurement), and estimate the server clock at the midpoint of the round trip. A
single sample's error is bounded by roughly half its round-trip time, and real network latency is
rarely symmetric, so this repeats the measurement `CALIBRATION_SAMPLES` (5) times and keeps
whichever sample had the lowest round-trip time — the standard NTP-client mitigation, since the
fastest round trip hit the least queuing/congestion in either direction. `startPeriodicCalibration()`
runs this on load, every 5 minutes, and on `visibilitychange`. Every
synced "start playing" write (Play, seek/BPM/transpose while playing) awaits
`ensureCalibrated()` first, which resolves once that first attempt has finished — otherwise the
very first Play right after the app loads could race the initial calibration and broadcast
against the default, unmeasured `offsetMs` of 0. A calibration write that keeps failing (e.g. a
Firestore rule that doesn't cover `sessions/clockPing_*`, see §5) logs a console warning rather
than failing loudly, since it degrades to "offset stays 0" instead of breaking anything outright.

**State ownership.** Every *synced* control in `main.ts` — Play/Pause/Stop, BPM, transpose, seek,
metronome, loop, song selection — calls `pushState()` with a patch and does nothing else
locally; `applyPlaybackState()`, driven only by the `onSnapshot` callback (including the
writer's own near-instant optimistic echo), is the single place that actually mutates local
state and calls into `audioEngine`/`pianoRoll`. This is the same pattern the shared song
library already used for deletion (every device, including the one that clicked delete, only
updates once Firestore reflects it), applied consistently to the whole transport instead of
just one action. A consequence: a late joiner or a reconnect needs no special-case code at
all — the first snapshot after subscribing runs through the exact same function, which
recomputes the live position from a possibly-minutes-old `originServerTimeMs` anchor and joins
already in sync. Mute/solo/true-solo is the one exception: it mutates `partMix` and calls
`audioEngine.setPartMixState()`/`pianoRoll.setPartMix()` directly, never through `pushState()`,
since it's local-only (see "Not synced" below) — nothing to publish or wait on an echo for.

Two write shapes matter for correctness:
- **Timing writes** (anything that starts, stops, or moves playback, or changes BPM/transpose
  while playing) always carry the full `{playing, originBeat, originServerTimeMs, bpm,
  transpose}` group in one call, never split across separate updates. This is the single most
  important correctness rule in the design: Firestore's per-field merge means two devices'
  *partial* concurrent writes could combine a winning `bpm` from one with a losing `originBeat`
  from another into an incoherent state. Sending the whole group atomically means whichever
  write lands last, it lands whole.
- **Simple writes** (loop region, metronome, BPM/transpose while paused) just touch the field(s)
  that changed.
- `applyPlaybackState()` also diffs incoming timing fields against what it last applied and only
  touches `AudioEngine` when they actually changed — an update that only changed the metronome,
  say, must *not* trigger a reschedule, or every remote toggle would audibly retrigger every
  currently-sounding note (`AudioEngine.play()` always clears and re-attacks the full schedule).

**Without Firebase configured**, `pushState()` applies changes immediately and locally instead
of publishing (single-device fallback, matching the app's pre-sync behavior) — a "start
playing" patch has its origin timestamp zeroed in that case, which makes `AudioEngine.play()`
take its normal "as soon as possible" path instead of waiting for a sync instant nothing else
is listening for.

**Not synced**, and deliberately so:
- **Mute/solo/true-solo.** `partMix` lives entirely in local `main.ts` state and is never
  written to `sessions/live` at all — each device picks which voices *it* wants to hear
  independently (e.g. a soprano isolating their own part via true-solo while everyone else still
  hears the full mix), without affecting anyone else's playback. It resets to all-`normal`
  whenever `loadSongLocally()` runs (a fresh song, on this device, gets a fresh mix), driven
  directly by the mute/solo/true-solo click handlers rather than `pushState()`.
- **Loop/end-of-piece wraparound** stays fully local per device (each device is already
  clock-synced to the same anchor, so they cross a boundary within a couple of animation frames
  of each other regardless — good enough for a rehearsal tool without the real complexity of
  anchor-based drift-free loop math).
- **Zoom, scroll position, and solo-ducking volume** remain personal per-device preferences,
  never written to the shared doc at all.

### 4.8 Sheet music view (`staffView.ts`)

A second, independent renderer (`StaffView`, same constructor shape as `PianoRoll` —
`canvas, score, partColor`, reusing the `partColor` callback (`colorForPart`) as-is) owning
its own `<canvas>`, toggled with the piano roll's rather than replacing it. Deliberately *not*
sharing `PianoRoll`'s code: the two are different enough (staff positions vs. piano-key rows,
noteheads/stems vs. proportional bars) that a shared base would mostly be indirection.
Deliberately simpler than `PianoRoll`'s pipeline too — no offscreen content buffer, it redraws
directly every frame — since this view is read-only (no click-to-seek/loop-drag of its own; see
§2) and meant primarily for reading rather than driving playback, where `PianoRoll`'s buffering
exists specifically to keep long continuous-scroll playback sessions smooth.

**Pitch spelling.** `NoteEvent` carries optional `step`/`alter`/`octave` — MusicXML's `<pitch>`
is already parsed in `musicxml.ts` but previously only the derived MIDI number survived; the
original spelling is now threaded through too, so accidentals render correctly (F♯ vs. G♭)
without needing to parse or guess a key signature. MIDI imports have no source spelling to
preserve, so `staffView.ts` falls back to a fixed sharps-preferred chromatic table for those —
noted as a known limitation (§6): MIDI-imported songs' notation isn't always the "correct"
enharmonic spelling, only a reasonable one.

**Layout.** Diatonic staff position is computed from `(step, octave)` via a simple letter-index
formula (`octave*7 + letterIndex`), independent of accidental — the standard trick that makes
adjacent-letter steps exactly half a line-spacing apart regardless of sharps/flats. Ledger lines
are derived from the same position. **Clef per part** is a heuristic, since no clef is parsed
anywhere in this app's pipeline: each part's average MIDI pitch decides treble vs. bass at
construction time. **Note duration shape** (filled vs. hollow notehead, stem, flag count) is
classified from the nearest standard duration to the note's continuous `durationBeats` value
(including dotted variants) — the only duration representation the rest of the app carries, so
this is inherently a best-fit approximation, not a re-derivation of the source file's actual
notated rhythm. Unbeamed: consecutive eighth/16th notes each get their own flagged stem rather
than being grouped under a beam — full beam-grouping (grouping rules, cross-barline handling) is
a materially larger typesetting problem, left as a possible follow-up rather than built
speculatively.

**Each voice gets its own staff, stacked vertically** (top to bottom in score order, like a
choral octavo), never overlaid on a shared staff — a hard requirement, since SATB voices sharing
or nearly sharing a pitch would be unreadable overlaid even in different colors. Barlines are
drawn once per measure, spanning from the top staff to the bottom staff, so the stack reads as
one synchronized system rather than N unrelated staves.

**Clef resolution** (`resolveClef`) prefers the actually-notated MusicXML `<clef>` (§4.2) over the
average-pitch heuristic whenever it's present and one of the two shapes this view can draw (a
plain G or F clef) — the heuristic remains the fallback for MIDI imports and any other clef sign
(a true C-clef, say — rare in choir writing, and this view has no C-clef glyph to draw anyway).
The resolved `octaveShift` (in whole octaves) only ever affects *positioning*: it's folded
straight into the part's `bottomLineIndex` (`CLEF_BOTTOM_LINE[clef] - octaveShift * 7`, 7
diatonic steps per octave) rather than touching a note's own pitch/spelling. Its most common real
value is +1, for the standard choir "tenor clef" convention — a G clef printed with a small 8
below it (MusicXML `clef-octave-change: -1`, "this clef sounds an octave lower than written") —
so a tenor part's notes land on/near the staff the way they're actually engraved, instead of
plotting them at their literal sounding octave against a plain treble clef (which would hang them
on many ledger lines below it).

All notation symbols are glyphs from **Bravura**, the SMuFL reference font (bundled as an 8 KB
subset — see §2 Design). SMuFL fonts are drawn at 4 staff spaces per em with each glyph's origin
at its musical reference point, so `fillText` at a staff position places it exactly: a G clef
on the G line, an F clef on the F line, a notehead on its line/space, rests on the middle line
(the whole rest on the 4th). The tenor's `clef-octave-change -1` uses the `gClef8vb` glyph (the
small 8 underneath). Stems attach at Bravura's own `stemUpSE`/`stemDownNW` anchors (0.168 staff
spaces off the notehead's centre), are 3.5 spaces long (longer for 16ths/32nds), and flags are
the font's flag glyphs placed at the stem end. Accidentals and augmentation dots are font glyphs
too (a dot on a line moves up into the space). Ties are slim filled crescents. Each notehead is
nudged a few pixels right of its exact beat position (`NOTE_X_OFFSET_PX`) so a note starting on a
barline doesn't sit on the barline itself. The final barline is a classical thin+thick double bar.

The **pinned margin** on the left (`drawMargin`) holds each voice's name, clef and key signature;
music scrolls under it and fades out at its edge. Its width is sized for the widest key signature
anywhere in the (transposed) piece, so the playhead doesn't shift sideways past a key change. The
playhead sits a fixed fraction of the remaining width to the right of the margin (a larger
fraction on narrow screens). Muted voices leave the stack (`visibleLayouts()` restacks each frame).

**Key signature** (`fifths`, from MusicXML's `<key><fifths>`, parsed the same
carry-forward-across-measures way as `beats`/`beatType` — see `MeasureInfo.fifths`) is drawn
right after the clef, using a fixed table of verified staff positions for each possible
sharp/flat count per clef. It sits in the pinned margin with the clef, tracking
whichever measure currently governs the left edge of the visible viewport, rather than being
anchored to the beat where a signature change happens — correct for the overwhelming common case
(one key signature for the whole piece) and, for a piece with a genuine mid-piece change, updates
as you scroll past the change point; a change occurring *inside* the visible viewport isn't also
marked inline at its own beat position (a known limitation, §6). The time signature is
deliberately **not** drawn (an earlier version showed it stacked just after the key signature;
removed as unnecessary clutter).

**Lyrics sit at one fixed height per staff** (`LYRIC_BASELINE_OFFSET_PX` below the staff's bottom
line), not following each note's own pitch, so a whole lyric line reads level instead of bouncing
up and down with the melody. Accepted trade-off: an extreme low note (most likely after a large
negative transpose) can sit below this fixed line, putting its lyric above/near its own notehead
instead of under it — inherent to "one fixed height per staff" versus an unbounded ledger-line
range, not fixable by tuning the constant.

**Accidental-awareness**: an accidental is only drawn on a note when its alter actually differs
from what the key signature (or an earlier note of the same letter+octave earlier in the same
measure) already implies — not on every altered note unconditionally, which would clutter a
piece with a real key signature. This bookkeeping needs to see every note from the start of
whichever measure governs the viewport's left edge, not just the ones currently on-screen, so
scrolling to a mid-measure position can't skip an earlier same-measure note that already
established an accidental (which would show a wrong accidental, or a missing one, on the first
visible note). It does **not** need to start that walk from the very first note of the whole
piece, though: the per-measure `accidentalMap` is cleared on every measure change regardless of
what came before, so nothing an earlier measure did can leak into the current one no matter where
the walk starts, as long as it starts at or before a measure boundary. `firstIndexAtOrAfter`
binary-searches the part's (startBeat-sorted) note list for the first note at or after that
measure's start, and the loop `break`s the moment it passes the visible range, rather than
scanning the remaining notes for the rest of the piece too. Before this, the walk ran from note
zero of the entire piece on **every single animation frame** during playback — since this view has
no offscreen-buffer pipeline like `PianoRoll`'s (see above; it redraws directly every frame), that
was real, measurable per-frame cost that scaled with the piece's total note count, not what was
actually visible — a concrete, confirmed contributor to reported playback jank specifically in
this view (a multi-minute arrangement's per-frame cost dropping from "every note in the piece" to
"roughly what's on screen"). The rests loop gets the same treatment (binary-search to the first
gap that could still be visible, `break` once past the visible range) for the same reason.

**Ties** are rendered as real notation, not one elongated notehead. MusicXML ties are still
merged into a single `NoteEvent` with an extended `durationBeats` at parse time (§4.2, for
piano-roll/audio purposes) — but `StaffView` splits that merged duration back into individually-
notatable segments for drawing. It prefers the note's own `tieSegments` (§4.2 — the *original*
tie-note boundaries the source file actually notated) whenever they're present, via
`segmentsFromTieLengths`, a plain cumulative-sum expansion with no barline logic needed (each
original `<note>` element could never cross a measure boundary in MusicXML to begin with, so
these segments are inherently already barline-safe). This is what makes a tied pair that
mathematically sums to one "clean" value (e.g. two tied eighths summing to exactly one quarter)
still render as two connected noteheads with a visible tie, matching the source engraving,
instead of silently collapsing into one undivided notehead. `splitIntoNotatedSegments` — forcing
a split at every barline crossing, and within a barline-clipped span greedily picking the
*largest* standard duration that fits without exceeding it (not the *nearest*, which is what
`classifyDuration` picks and would overflow past what's actually left) — remains the fallback for
MIDI imports (no tie concept in the source) and any non-tied note with an unusually long single
duration. Either way, each resulting segment gets its own notehead/stem/flags, connected to the
next by a shallow tie curve. This machinery is what fixes a concretely observed bug where a tied
note (e.g. the "Butterfly" arrangement's opening notes) rendered as a single illegibly-long note
instead of readable rhythm.

**Rests** fill in the inferred silent gaps in each part's own note list — notes sharing a
startBeat count as one chord/event, using the latest end-time among them, so a gap is only
reported once everything sounding at that point has actually finished. Each gap is split with
the same `splitIntoNotatedSegments` ties use, so a rest spanning a barline correctly becomes two
(or more) rest glyphs rather than one that visually crosses the barline. Scoped to one
monophonic voice per part — true for typical SATB choir writing, this app's primary use case; a
genuinely multi-voice part (MusicXML `<backup>`/`<forward>` producing overlapping non-chord
content within one part) may infer incorrect/overlapping gaps (§6). Rests are Bravura's rest
glyphs, drawn slightly transparent so they don't compete with the notes.

**Transpose is fully modeled here**, not ignored — both the key signature and every note's
spelling shift together when the app's transpose control is used, driven by the same
circle-of-fifths math: `fifthsShift = ((7×semitones) mod 12 + 12) mod 12`, normalized into
roughly −5..+6 (the conventional flat-side tie-break, e.g. +1 semitone lands on Db major's 5
flats rather than C♯ major's 7 sharps). The note-respelling **letter shift is derived from that
same fifths shift**, not independently rounded from the semitone count — a naive independent
rounding can pick the *opposite* enharmonic side from the one the fifths shift already chose for
the key signature (verified concretely at ±6 semitones, the tritone case), which would show a
sharp-heavy key signature next to flat-spelled notes. `TRANSPOSE_TABLE` holds the verified
fifths-shift/letter-shift pair for every semitone count in the app's ±7 range; respelling then
shifts a note's letter by that amount and solves for whichever `alter` hits the exact target
pitch, so the spelling always matches both the transposed key signature and the real sounding
pitch.

**Note duration shape** (filled vs. hollow notehead, stem, flag count) is classified from the
nearest standard duration to a segment's continuous `durationBeats` value (including dotted
variants) — the only duration representation the rest of the app carries below the segment
level, so this is inherently a best-fit approximation for whatever `splitIntoNotatedSegments`
already produced, not a re-derivation of the source file's actual notated rhythm. Unbeamed:
consecutive eighth/16th notes each get their own flagged stem rather than being grouped under a
beam — full beam-grouping (grouping rules, cross-barline handling) is a materially larger
typesetting problem, left as a possible follow-up rather than built speculatively.

---

## 5. Development

```bash
npm install
npm run dev       # Vite dev server with HMR
npm run build     # tsc typecheck + production build to dist/
npm run preview   # serve the production build locally
```

To point the app at your own Firebase project instead of the bundled one, edit
`src/firebaseConfig.ts` with your project's web app config (Project settings → General →
"Your apps" → Web app in the Firebase console), and create:
- A Firestore collection `songs` (populated automatically as scores are imported).
- A single document at `config/access` with a `pinHash` field: the SHA-256 hex digest of
  whatever PIN you want the group to use.
- Firestore Security Rules that require `request.auth != null` for reads/writes to `songs/**`,
  `config/access`, **and `sessions/**`** (the synced-playback session doc `sessions/live` plus
  the per-device clock-calibration docs `sessions/clockPing_*`, see §4.7). A rule scoped to the
  literal path `sessions/live` and not the whole collection will silently break clock
  calibration — `calibrateClockOffset()` swallows the permission-denied error and just leaves
  the offset at its default of 0, which shows up as synced playback starting audibly out of
  sync (by however much this device's own clock differs from the server) rather than as an
  obvious error. Check the browser console for a `[AI-Capella] Clock calibration failed` warning
  if that happens.

### Deployment

`.github/workflows/deploy.yml` builds the project and deploys `dist/` to GitHub Pages on every
push to `claude/amazing-bardeen-c4fcke` (or manually via `workflow_dispatch`). Because GitHub
Pages serves the repo at a subpath (`https://<user>.github.io/AI-Capella/`), `vite.config.ts`
sets `base: '/AI-Capella/'` so every built asset URL accounts for that prefix; local dev is
unaffected. `import.meta.env.BASE_URL` is used (never a bare `/...` path) anywhere the app
needs to reference its own bundled assets, like the sample song's URL, for the same reason.

---

## 6. Known limitations & non-goals

- **Not a notation editor.** Nothing about the score can be edited from within the app — it's
  strictly a playback/rehearsal viewer for an existing MusicXML file.
- **No real access control.** The PIN gate and Firestore's "any anonymous client can
  read/write" rule together mean this is appropriate for a trusted group sharing a link, not
  for anything that needs to keep content genuinely private.
- **Synthesized audio, not recorded/sampled.** The piano-ish timbre is a simple oscillator
  synth, not a sampled instrument — adequate for pitch/rhythm reference, not a substitute for
  a real accompanist.
- **No offline mode.** Firestore's shared library requires a network connection; the bundled
  sample song is the only thing guaranteed to work with Firebase unreachable.
- **One shared Ensemble session, not multiple rooms.** Choosing Ensemble (§2/§4.7) joins the
  single global `sessions/live` doc — every device in Ensemble mode is in the *same* session,
  with no concept of separate rehearsal rooms for different sub-groups. Any device picking a
  song or changing playback state retargets everyone else immediately, with no confirmation
  step. Solo mode is the only per-device opt-out, not a way to join a different, smaller group.
- **No presence UI.** There's no indication of who else is connected or how many devices are in
  the shared session.
- **Small built-in delay on synced timing changes.** Play, seek, and BPM/transpose changes made
  while playing carry a ~750ms buffer before they take effect (longer when a count-in is
  involved — see §4.7), so every device has time to receive and schedule the change before it
  happens. Loop/end-of-piece wraparound is not anchor-corrected across devices — it stays a
  local per-device boundary check, which converges closely in practice (every device is already
  clock-synced to the same anchor) but isn't drift-proof over very long loop-practice sessions.
- **Sheet music view is a simplified, best-effort renderer, not engraving software.** No beam
  grouping (each unbeamed note gets its own flagged stem), a clef heuristic only when the file
  has no recognised `<clef>` (G and F clefs only, no C clefs), and MIDI-imported songs get a fixed sharps-preferred spelling rather than the file's actual
  intended spelling (which MIDI has no way to encode). Transpose *is* fully modeled (key
  signature and note spelling both shift correctly together, §4.8) — this is no longer a
  limitation as of the second feedback round.
- **Mid-piece key signature changes aren't marked inline at their own beat.** The key signature
  shown is pinned to a fixed screen position (like the clef) and tracks whichever measure
  currently governs the left edge of the visible viewport — correct for the very common case of
  one signature for the whole piece, and it does update as you scroll past a genuine mid-piece
  change, but the change itself isn't also flagged inline at the beat where it happens.
- **Rest inference assumes one monophonic voice per part.** True for typical SATB choir writing
  (this app's primary use case), but a part with genuinely overlapping simultaneous voices
  (MusicXML `<backup>`/`<forward>` producing overlapping non-chord content within one part) may
  show incorrect or overlapping rests. See §4.8.
- **A fixed lyric baseline can sit above an extreme low note.** Sheet-view lyrics are drawn at
  one consistent height per staff rather than following each note's own pitch (§4.8) — inherent
  trade-off for an extreme low note (most likely after a large negative transpose): its lyric can
  end up above/near its own notehead rather than under it, since the fixed line has no way to
  account for an unbounded ledger-line range.
- **No sheet-music view for MIDI-imported songs.** The toggle button is hidden entirely for a
  MIDI import, rather than offering a view built on a heuristic chromatic spelling that isn't
  necessarily the file's actual intended notation (§4.8).
