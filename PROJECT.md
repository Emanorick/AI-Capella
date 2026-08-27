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

### Landing screen: Solo vs. Ensemble
The very first time the app loads (only when a shared backend is configured — otherwise this
step is skipped entirely), it asks: **Solo** or **Ensemble**? Solo is fully local — nothing
about playback is shared with anyone else, for practicing alone without nudging anyone else's
position. Ensemble is the synced-playback experience described below. The choice is
remembered (`localStorage`) so it's only asked once; a "Switch mode" link in the library
sidebar clears it and reloads back to this screen. Either way, the shared song library itself
is always available — Solo only opts out of shared *playback*, not shared *songs*. See §4.7.

### Library / player split
The app opens on a **library view**: a scrollable list of songs (a bundled sample plus
anything imported into the shared library), with drag-and-drop or a file picker to import
more. Picking a song switches to the **player view** — the piano roll, transport controls,
and per-voice mixer for that song. A "← Library" button goes back without losing your place
(each song reloads fresh when reopened) and always **stops playback** first — including, in
Ensemble mode, for every other connected device, not just the one that clicked it — so nobody
gets left with music playing to an empty player view.

### The piano roll
- Canvas-based, not DOM/SVG — this matters at the note counts and frame rates involved (see
  §4.3).
- Horizontal axis = time (in quarter-note beats), vertical axis = pitch (one row per
  semitone). Each note is a rounded colored bar, one lyric syllable drawn beneath it, sized so
  the bar plus its lyric both fit fully inside the note's own row even for tightly-spaced
  chords.
- A fixed **ruler strip** along the top (22px) is the *only* place a click or drag can set
  where playback starts, or define a loop region. Everywhere else, clicking is inert for
  playback — it can only *preview* a note (see below) — so casual scrolling or tapping while
  the piece plays can never accidentally jump the playback position. This was a deliberate
  design correction after early versions let any click seek, which made scrolling/clicking
  during playback unreliable. A plain tap (not a drag) always **snaps to the start of
  whichever measure it landed in** ("grid locking"), rather than an arbitrary fractional beat —
  a slightly-off tap still lands exactly on a measure boundary. Grid-locking only moves the red
  playback-start line; it deliberately does **not** recenter the view — the view only ever
  snaps to follow the playhead once playback actually starts. The sheet music view (below) has
  its own equivalent ruler strip for the same grid-locking gesture.
- **Jump to measure**: seeks straight to any measure number, for scores too long to comfortably
  scroll through by hand — and, unlike a plain ruler tap, **does** recenter the view on the
  target measure once you go there, since the whole point is to jump somewhere off-screen. On
  desktop this is a numeric field plus a **Go** button; on mobile, typing a number is
  cumbersome, so a **+/− stepper** flanks the field instead — a single tap steps one measure
  (and jumps/recenters immediately), while press-and-hold repeats and accelerates over time
  (starting at 400ms between steps, speeding up to 60ms), so reaching a distant measure doesn't
  require dozens of individual taps. Both paths move the actual playback position, synced
  across devices in Ensemble mode — not a separate "just look" browsing mode.
- **Click-to-preview**: clicking a note anywhere in the main area plays that note's pitch
  (through the same synth used for playback, respecting the current transpose) and shows its
  name (e.g. "E3") in a small label above it for about a second, then the label fades. This
  replaced an earlier design that kept a full piano keyboard down the left edge — the keyboard
  was removed entirely in favor of this click-to-identify interaction, which turned out to be
  both simpler and more useful.
- **Barely-visible semitone gridlines** run behind the notes so you can gauge interval
  distance at a glance without them competing visually with the beat/measure gridlines.
- **Vertical scrolling**: if a piece's full pitch range doesn't fit the viewport at a
  comfortable row height, the roll scrolls vertically (mouse wheel / trackpad / touch drag). If
  it *does* fit, rows stretch to fill the available height and no scrolling is needed.
- **Horizontal panning while paused**: you can freely scroll left/right to browse the score
  while paused. The red playhead line always reflects the actual paused/resume position, not
  wherever you've scrolled to — so it can visually move away from its usual spot (even off
  the edge of the screen) while you're just browsing, and snaps back the moment you press
  Play. While actually playing, horizontal panning is locked (the view follows the music) so
  the line and the audio can never visually desync.
- **Ties** (a note sustained across a bar-line, or any tie) are merged into a single note at parse
  time rather than kept as two notes joined by a line — see §4.2 — so a tied note renders as one
  seamless bar and plays back with a single attack, not a retrigger. **Slurs** are drawn as an
  arched curve in the voice's own color.

### Sheet music view
An alternative, toggleable view (the "Sheet Music" / "Piano Roll" button in the transport bar)
for anyone who reads traditional notation more comfortably than a piano roll — each voice gets
its **own five-line staff, stacked vertically** (never overlaid on a shared staff — SATB voices
sharing a pitch would be unreadable that way), in that part's color, on a black background,
with shared barlines connecting every staff into one system. Real key and time signatures are
shown (with accidentals only drawn where they actually differ from the key or an earlier note
in the same measure — not a redundant sharp/flat on every occurrence), ties render as actual
connected noteheads with a tie curve rather than one elongated note, and rests fill in the
silent gaps. It mirrors the piano roll's mute/solo/true-solo (a true-soloed voice hides every
other staff entirely; a regular Solo dims the rest and hides their lyrics), zoom, transpose (a
real, key-signature-aware transposition — not just a note here — see §4.8), and lyrics. It's
mostly a *view*, not an alternate control surface — no loop-drag of its own — but it does have
its own ruler strip for the same grid-lock tap-to-seek gesture the piano roll's ruler has,
since scrolling to a spot in one view and wanting to start playback there shouldn't require
switching back. See §4.8 for the rendering approach and its remaining scope limits (clef
assignment, note-duration shapes, no beaming).

### Playback & transport
- Play/Pause and Stop are available both in the full transport bar and as compact buttons in
  the header, so they stay reachable even with the settings panel collapsed.
- **Stop** returns to the loop region's start (if one is set), or the last point you tapped in
  the ruler, or the very beginning. Pressing Stop again while already sitting at that point
  goes the rest of the way back to beat zero, matching how a physical transport's Stop button
  behaves.
- **Space bar** toggles play/pause globally (ignored while a text input has focus).
- **BPM presets** (50/80/100/120/140): tempo is entirely independent of whatever tempo, if
  any, was encoded in the source file — the file's own tempo markings are never read or used
  for playback speed. Changing BPM while already playing re-schedules from the current
  position at the new speed without a perceptible jump.
- **Metronome**: an optional click on every beat pulse (accented on downbeats), synthesized
  the same way as the notes.
- **Count-in ("Einzählen")**: pressing Play with the metronome on first counts out one full
  measure at the target tempo/time signature (correctly spaced for compound meters like 6/8,
  not just simple ones) before the music actually starts — accented first click, synced across
  every device in Ensemble mode so everyone hears the same count and the music starts for
  everyone at once right after. Only a genuinely **fresh** playback start triggers it — after a
  Stop, at the very start of a piece, or after a grid-lock/measure-jump seek — never a plain
  Pause→Play resume from wherever playback was paused, and never a BPM/transpose change or a
  seek while already playing. This is tracked by a `freshStart` flag (`sync.ts`), separate from
  the count-in fields themselves — see §4.7. A late-joining device (or one whose update simply
  arrives too late) skips the count-in and joins the music already in progress, same as it
  would for a plain synced Play.
- **Loop**: either loop the whole piece, or drag across the ruler to mark a specific region
  and loop just that (useful for hammering a tricky bar repeatedly). The Loop button toggles
  whether hitting the boundary wraps around or just stops there.
- **Transpose** (±7 semitones) and **Zoom** (25%–300%) apply live, including mid-playback.

### Per-voice mixing
Each part (voice) gets a row in the settings panel with a color swatch, its name, and Mute /
Solo buttons:
- **Mute** silences and hides that voice's notes.
- **Solo** (on one or more voices) ducks every non-soloed, non-muted voice to a configurable
  volume (10/25/50/75% presets) rather than fully silencing them — useful for hearing your own
  part clearly while still following the others faintly.
- **Clicking a voice's row itself** (not the M/S buttons) toggles a *true* solo: mutes and
  hides every other voice entirely. Clicking the same voice again restores everyone. This is
  distinct from the Solo button's "duck the rest" behavior — sometimes you want to hear only
  your part with nothing else at all.

### Import & shared library
- Drag-and-drop or file-picker import of `.musicxml`, `.xml`, `.mxl` (MuseScore's
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
- See §4.7 for how the cross-device timing actually works.

---

## 3. Project layout

```
AI-Capella/
├── index.html              # single entry point, mounts #app
├── public/
│   └── evening-rise.musicxml   # bundled sample score
├── src/
│   ├── main.ts              # app shell, event wiring, transport/mix state, render loop
│   ├── musicxml.ts           # MusicXML → Score parser
│   ├── midi.ts                # Standard MIDI file → Score parser
│   ├── score.ts              # the Score data model + small pure helpers
│   ├── pianoRoll.ts           # canvas rendering: the piano roll itself
│   ├── staffView.ts           # canvas rendering: the alternate sheet-music view
│   ├── audioEngine.ts         # Web Audio synthesis + playback scheduling
│   ├── palette.ts             # deterministic per-voice color assignment
│   ├── library.ts             # Firestore-backed shared song storage, PIN verification, .mxl unzip
│   ├── sync.ts                 # multi-device shared playback session: clock calibration + pub/sub
│   ├── firebase.ts            # Firebase app/auth/Firestore initialization, anonymous sign-in
│   ├── firebaseConfig.ts      # Firebase web app config (not secret; see file comment)
│   ├── pinGate.ts             # the full-screen PIN prompt overlay
│   └── style.css              # all styling
├── .github/workflows/deploy.yml   # builds and deploys dist/ to GitHub Pages on every push
├── vite.config.ts             # sets base: '/AI-Capella/' for GitHub Pages' subpath hosting
├── tsconfig.json
└── package.json
```

No test suite, no server code, no bundler plugins beyond stock Vite + TypeScript. The entire
app is a single-page client-side bundle.

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
  bar and play back with a single attack instead of an audible retrigger at the tie point.

`.mxl` files (MuseScore's default export — a zip containing the MusicXML plus a
`META-INF/container.xml` manifest) are unzipped client-side in `library.ts` using `fflate`,
reading the manifest to find the actual score file inside the archive.

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

They coincide, and the red playhead line sits at its usual fixed screen position, whenever the
view hasn't been panned away from the actual position — which is always true during playback
(panning is locked then) and usually true while paused. While paused, though, panning is still
allowed to browse the score, and the playhead line is computed from `playheadBeat`
independently, so it correctly drifts away from (or entirely off) its usual spot rather than
silently relabeling whatever beat the pan happened to land on.

**Self-correcting buffer bounds.** Before blitting, `render()` verifies the content buffer
actually covers the full visible width and forces an immediate rebuild if it doesn't — a
defensive invariant added after an intermittent, never-reliably-reproduced "black unpainted
strip" report, rather than trusting the incremental rebuild-margin heuristic blindly. A
`ResizeObserver` on the canvas (in addition to the `window.resize` listener) catches mobile
viewport size changes — address bar show/hide, dynamic toolbars — that don't fire a `resize`
event but do change the canvas's actual laid-out box.

### 4.4 Audio (`audioEngine.ts`)

No audio files, no MIDI — every note is synthesized live with the Web Audio API:
- Each note is two detuned oscillators (a triangle fundamental plus a quiet sine an octave-ish
  up) through a lowpass filter that sweeps down as the note decays, giving a simple
  plucked-piano-ish timbre, with an attack/decay/release envelope on a per-note gain node.
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
  practice, imperceptible.
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
- **Metronome-active-but-silent reports**: investigated but not conclusively reproduced from
  reading the code alone. A dead, unreachable `resume()` method with the exact shape of that bug
  (sets `playing = true` without rescheduling anything) has been removed, and `setMetronomeEnabled`/
  `scheduleMetronomeInRange` now log via `console.debug` on every call — if this recurs, check
  the browser console for whether the flag/scheduling actually desynced or the call never
  happened at all.

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
  optional `recenterView` flag: a plain ruler tap (piano roll or sheet music) only moves the red
  playback-start line, leaving the view exactly where it was, while Measure-jump-Go passes
  `recenterView: true` so the view actually snaps to the target — the two gestures have
  different intents (mark a start point while still looking at the current spot, vs. actually
  go look at a different part of the piece).
- **Mobile settings-panel collapse is animated, not instant.** `#settings-panel`'s collapsed
  state is a CSS `max-height` transition rather than `display: none`, with the *target* height
  read from the panel's own `scrollHeight` in JS right before toggling (not a guessed fixed
  pixel value, which risks clipping a larger ensemble's wrapped controls on a narrow phone).
  `pianoRoll`/`staffView` are only resized and re-rendered once the transition actually finishes
  (`transitionend`), not mid-animation. A fast vertical swipe (under 300ms, over 40px) anywhere
  on the piano roll canvas toggles the same collapse — reusing the existing pointer-drag
  axis-lock state machine, with a small accepted trade-off: the drag's own live vertical scroll
  has already applied a few pixels of pan by the time the gesture is recognized as a swipe
  rather than a scroll, since axis-locking happens continuously as the gesture is still in
  progress.

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
  refresh.
- The PIN itself is never stored or transmitted in the clear: `verifyPin()` hashes the entered
  PIN with SHA-256 (`crypto.subtle.digest`) client-side and compares it against a `pinHash`
  field on a single `config/access` Firestore document. As documented directly in the code,
  this is a *soft* gate against casual link-sharing, not a real security boundary — Firestore's
  actual access control is "authenticated (even anonymously) clients can read/write," which the
  PIN does nothing to restrict.

### 4.7 Synced multi-device playback (`sync.ts`, `main.ts`)

One Firestore doc, `sessions/live`, holds the entire shared transport state — `songId`, `bpm`,
`transpose`, `metronomeOn`, `loopEnabled`/`loopRegion`, the play/pause origin (`playing`,
`originBeat`, `originServerTimeMs`), `countInBeats`/`countInPulseBeats` (the count-in described
in §2/§4.4), and `freshStart` (whether the *next* Play should count in at all — see below).
Every connected device subscribes to it via `subscribePlaybackState()`.
Mute/solo/true-solo is deliberately *not* in this doc — see "Not synced" below. Only active in
**Ensemble mode** (`syncEnabled()` = `isFirebaseConfigured && sessionMode === 'ensemble'`,
`sessionMode` set from the landing screen/`localStorage`, see §2) — in **Solo mode**,
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
`canvas, score, partColor`, reusing `colorForPartIndex`/the `partColor` callback as-is) owning
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

Clef glyphs are small hand-drawn bezier-curve shapes (a stylized G-clef spiral for treble; two
dots flanking a hook for bass), not a Unicode music-symbol character — this app bundles no music
font, and Unicode clef characters render as missing-glyph boxes on many systems without one.
Recognizable at a glance as "this is treble/bass," not calligraphic. Each note's notehead is
nudged a few pixels right of its exact beat position (`NOTE_X_OFFSET_PX`) so a note starting
exactly on a barline doesn't visually sit on top of the barline itself.

**Key signature** (`fifths`, from MusicXML's `<key><fifths>`, parsed the same
carry-forward-across-measures way as `beats`/`beatType` — see `MeasureInfo.fifths`) and **time
signature** are drawn right after the clef, using a fixed table of verified staff positions for
each possible sharp/flat count per clef. They're pinned to a fixed screen position like the
clef, tracking whichever measure currently governs the left edge of the visible viewport, rather
than being anchored to the beat where a signature change happens — correct for the overwhelming
common case (one key/time signature for the whole piece) and, for a piece with a genuine
mid-piece change, updates as you scroll past the change point; a change occurring *inside* the
visible viewport isn't also marked inline at its own beat position (a known limitation, §6).

**Accidental-awareness**: an accidental is only drawn on a note when its alter actually differs
from what the key signature (or an earlier note of the same letter+octave earlier in the same
measure) already implies — not on every altered note unconditionally, which would clutter a
piece with a real key signature. This bookkeeping deliberately walks every note in a part in
beat order, not just the ones currently on-screen, so scrolling to a mid-measure position can't
skip an earlier same-measure note that already established an accidental (which would show a
wrong accidental, or a missing one, on the first visible note) — only the actual canvas drawing
is skipped for off-screen notes, not the bookkeeping.

**Ties** are rendered as real notation, not one elongated notehead. MusicXML ties are still
merged into a single `NoteEvent` with an extended `durationBeats` at parse time (§4.2, for
piano-roll/audio purposes) — but `StaffView` splits that merged duration back into individually-
notatable segments (`splitIntoNotatedSegments`): forcing a split at every barline crossing (a
note can't cross one in real notation, same as MusicXML itself), and within a barline-clipped
span, greedily picking the *largest* standard duration that fits without exceeding it (not the
*nearest*, which is what the existing `classifyDuration` picks and would overflow past what's
actually left). Each segment gets its own notehead/stem/flags, connected to the next by a
shallow tie curve. This is what fixes a concretely observed bug where a tied note (e.g. the
"Butterfly" arrangement's opening notes) rendered as a single illegibly-long note instead of
readable rhythm.

**Rests** fill in the inferred silent gaps in each part's own note list — notes sharing a
startBeat count as one chord/event, using the latest end-time among them, so a gap is only
reported once everything sounding at that point has actually finished. Each gap is split with
the same `splitIntoNotatedSegments` ties use, so a rest spanning a barline correctly becomes two
(or more) rest glyphs rather than one that visually crosses the barline. Scoped to one
monophonic voice per part — true for typical SATB choir writing, this app's primary use case; a
genuinely multi-voice part (MusicXML `<backup>`/`<forward>` producing overlapping non-chord
content within one part) may infer incorrect/overlapping gaps (§6). Glyphs are hand-drawn, in
the same spirit as the clef/flag shapes: a small rectangle hanging from the 4th line for a whole
rest, the same rectangle sitting on the middle line for a half rest, a bold zigzag for a quarter
rest, and a dot with one/two/three hook curves (reusing the notehead flags' curve shape) for
eighth/16th/32nd rests.

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
  grouping (each unbeamed note gets its own flagged stem), a heuristic (not parsed) clef per
  part, hand-drawn approximate clef/rest glyphs rather than real notation-font glyphs, and
  MIDI-imported songs get a fixed sharps-preferred spelling rather than the file's actual
  intended spelling (which MIDI has no way to encode). Transpose *is* fully modeled (key
  signature and note spelling both shift correctly together, §4.8) — this is no longer a
  limitation as of the second feedback round.
- **Mid-piece key/time signature changes aren't marked inline at their own beat.** The key and
  time signature shown are pinned to a fixed screen position (like the clef) and track whichever
  measure currently governs the left edge of the visible viewport — correct for the very common
  case of one signature for the whole piece, and they do update as you scroll past a genuine
  mid-piece change, but the change itself isn't also flagged inline at the beat where it happens.
- **Rest inference assumes one monophonic voice per part.** True for typical SATB choir writing
  (this app's primary use case), but a part with genuinely overlapping simultaneous voices
  (MusicXML `<backup>`/`<forward>` producing overlapping non-chord content within one part) may
  show incorrect or overlapping rests. See §4.8.
- **Metronome-active-but-silent reports are not conclusively fixed**, only investigated —
  see §4.4's note on what was found (a removed dead-code landmine) and the diagnostics shipped
  alongside it in case it recurs.
