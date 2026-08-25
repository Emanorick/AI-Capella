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

### Library / player split
The app opens on a **library view**: a scrollable list of songs (a bundled sample plus
anything imported into the shared library), with drag-and-drop or a file picker to import
more. Picking a song switches to the **player view** — the piano roll, transport controls,
and per-voice mixer for that song. A "← Library" button goes back without losing your place
(each song reloads fresh when reopened).

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
  during playback unreliable.
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
`transpose`, `metronomeOn`, `loopEnabled`/`loopRegion`, and the play/pause origin (`playing`,
`originBeat`, `originServerTimeMs`). Every connected device subscribes to it via
`subscribePlaybackState()`. Mute/solo/true-solo is deliberately *not* in this doc — see "Not
synced" below.

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
- **One shared session, not multiple rooms.** Synced playback (§4.7) is a single global
  `sessions/live` doc — every connected device is in the same session, with no concept of
  separate rehearsal rooms. Any device picking a song or changing playback state retargets
  everyone else immediately, with no confirmation step.
- **No presence UI.** There's no indication of who else is connected or how many devices are in
  the shared session.
- **Small built-in delay on synced timing changes.** Play, seek, and BPM/transpose changes made
  while playing carry a ~750ms buffer before they take effect, so every device has time to
  receive and schedule the change before it happens. Loop/end-of-piece wraparound is not
  anchor-corrected across devices — it stays a local per-device boundary check, which converges
  closely in practice (every device is already clock-synced to the same anchor) but isn't
  drift-proof over very long loop-practice sessions.
