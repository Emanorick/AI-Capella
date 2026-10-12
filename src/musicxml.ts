import type { MeasureInfo, NoteEvent, PartInfo, RehearsalMark, Score, ScoreMark, SlurArc } from './score';
import { t } from './i18n';

const STEP_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

function pitchToMidi(step: string, alter: number, octave: number): number {
  return (octave + 1) * 12 + (STEP_SEMITONES[step] ?? 0) + alter;
}

// MusicXML's <type> values, in beats (a quarter note is 1 beat) -- used only as a fallback when
// <duration> is missing/zero (see the 'note' case below), independent of <divisions>.
const TYPE_BEATS: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
};

// A grace note has no real duration of its own (see the 'note' case's isGrace handling) -- this
// is purely a nominal, short audible/visible length for playback and the piano roll/staff view,
// not derived from the source file.
const GRACE_NOTE_DURATION_BEATS = 0.25;

const EPS = 1e-6;

// Printed words that set or bend the tempo (shown with the tempo marks rather than as a voice's
// expression words).
const TEMPO_WORDS =
  /^(a tempo|tempo\b|tempo primo|grave|largo|larghetto|lento|adagio|adagietto|andante|andantino|moderato|allegretto|allegro|vivace|vivo|presto|prestissimo|rit\b|rit\.|ritard|ritenuto|riten|rall|rallentando|accel|accelerando|stringendo|rubato|misterioso|maestoso|con moto|più mosso|meno mosso|piu mosso|langsam|ruhig|lebhaft|schnell|mäßig|gemächlich|bewegt|breit|swing|ballad)/i;

const CHORD_SYMBOL = /^[A-G][#b♯♭s]?(m|mi|mic|min|maj|dim|aug|sus|add|d|\d+|\/[A-G][#b♯♭]?)*$/;

/** What one part's walk through its bars found, before the bars are laid out (pass 1). */
interface BarSurvey {
  number: number;
  beats: number;
  beatType: number;
  fifths: number;
  mode: MeasureInfo['mode'];
  // How far the bar's timed content reaches, in beats from its start -- null when the part has
  // nothing to say about the bar's length (empty, or only a whole-bar rest).
  reach: number | null;
  voiceReach: Map<string, number>;
}

/** Where each bar starts and how long it is, agreed across all parts. */
interface BarPlan {
  start: number;
  length: number;
}

/** A note's words in one verse (a passage printed once and sung twice has two lines of words). */
interface Verse {
  lyric?: string;
  lyricJoin?: boolean;
  lyricExtend?: boolean;
}

interface PartResult {
  bars: BarSurvey[];
  notes: NoteEvent[];
  noteBars: number[]; // the bar (index into the part's bars) each of `notes` starts in
  verses: Map<NoteEvent, Verse[]>; // a note's words per verse, where it has more than one line
  slurs: SlurArc[];
  marks: ScoreMark[];
  rehearsalMarks: RehearsalMark[];
  clef?: PartInfo['clef'];
}

/** A <time>'s numerator, including additive ones like "3+2". */
function readBeats(text: string | null | undefined): number | null {
  if (!text) return null;
  const sum = text.split('+').reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
  return sum > 0 ? sum : null;
}

const STEPS = 'CDEFGAB';

/**
 * Where a percussion note sits, as the step and octave of a treble staff: its <display-step> and
 * <display-octave>. Some exports leave those empty or nonsensical (MuseScore wrote an empty step
 * and octave 1434 for one drum kit -- taken at its word, the note sat miles above the staff); the
 * note's printed height (default-y, tenths below the top line, F5) stands in then, and without
 * that it sits on the middle line, B4.
 */
function unpitchedPlace(unpitched: Element, note: Element): { step: string; octave: number } {
  const step = unpitched.querySelector('display-step')?.textContent?.trim() ?? '';
  const octave = parseInt(unpitched.querySelector('display-octave')?.textContent ?? '', 10);
  if (STEPS.includes(step) && step.length === 1 && octave >= 0 && octave <= 9) return { step, octave };
  const y = parseFloat(note.getAttribute('default-y') ?? '');
  if (Number.isFinite(y) && Math.abs(y) <= 120) {
    const index = 5 * 7 + STEPS.indexOf('F') + Math.round(y / 5); // a step of the staff is 5 tenths
    return { step: STEPS[((index % 7) + 7) % 7], octave: Math.floor(index / 7) };
  }
  return { step: 'B', octave: 4 };
}

/**
 * Walks one part. Without a plan (pass 1) bars follow each other at whatever length the part's own
 * content has, and only the survey is of use. With a plan (pass 2) every bar starts where the
 * plan says, and a voice whose content overruns the bar (an unmarked tuplet, typically) is fitted
 * into it. With `staff`, only that staff's notes, clef and directions are kept (a part printed on
 * several staves is read once per staff; the others' notes still move time along).
 */
function readPart(partEl: Element, partId: string, plan: BarPlan[] | null, survey: BarSurvey[] | null, staff?: number): PartResult {
  const result: PartResult = { bars: [], notes: [], noteBars: [], verses: new Map(), slurs: [], marks: [], rehearsalMarks: [] };
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  let fifths = 0;
  let keyMode: MeasureInfo['mode'];
  let measureStartBeat = 0;
  let cursor = 0;
  let lastNoteStart = 0;
  const openSlurs = new Map<number, { beat: number; midi: number }>();
  // A tie is MusicXML's way of representing one sustained pitch that had to be split into
  // multiple <note> elements because a note can't itself cross a measure boundary in the file
  // format -- musically (and for playback/rendering purposes) it's one continuous note, so tied
  // notes are merged into a single NoteEvent here rather than kept as separate ones bridged by a
  // visual line: this map holds, per currently-open pitch, the actual NoteEvent object already
  // pushed that a subsequent tied note should extend instead of duplicating. A tie chain (a note
  // held across more than one boundary) keeps extending the same object.
  const openTieNotes = new Map<number, NoteEvent>();
  const openWedges = new Map<number, ScoreMark>();

  const measureEls = Array.from(partEl.querySelectorAll(':scope > measure'));
  measureEls.forEach((measureEl, index) => {
    const numAttr = measureEl.getAttribute('number');
    const parsedNumber = numAttr ? parseInt(numAttr, 10) : NaN;
    const measureNumber = Number.isFinite(parsedNumber) ? parsedNumber : index + 1;
    const planned = plan?.[index];
    if (planned) measureStartBeat = planned.start;
    cursor = measureStartBeat;
    // The furthest `cursor` reaches in this bar (across every backup/forward-interleaved voice),
    // and per voice -- see planBars() for how these decide the bar's length.
    let reach: number | null = null;
    const voiceReach = new Map<string, number>();
    const reached = (voice: string | null, end: number) => {
      const offset = end - measureStartBeat;
      reach = Math.max(reach ?? 0, offset);
      if (voice !== null) voiceReach.set(voice, Math.max(voiceReach.get(voice) ?? 0, offset));
    };
    // In pass 2: the factor a voice's positions are squeezed by to fit the bar (1 almost always).
    const fit = new Map<string, number>();
    const barSurvey = survey?.[index];
    if (planned && barSurvey) {
      for (const [voice, r] of barSurvey.voiceReach) if (r > planned.length + EPS) fit.set(voice, planned.length / r);
    }
    const place = (beat: number, voice: string) => measureStartBeat + (beat - measureStartBeat) * (fit.get(voice) ?? 1);

    for (const child of Array.from(measureEl.children)) {
      switch (child.tagName) {
        case 'attributes': {
          const divText = child.querySelector('divisions')?.textContent;
          if (divText) divisions = parseFloat(divText) || 1;
          const fifthsText = child.querySelector('key > fifths')?.textContent;
          if (fifthsText) fifths = parseInt(fifthsText, 10) || 0;
          const modeText = child.querySelector('key > mode')?.textContent?.trim();
          if (modeText === 'major' || modeText === 'minor') keyMode = modeText;
          const timeEl = child.querySelector('time');
          if (timeEl) {
            const b = readBeats(timeEl.querySelector('beats')?.textContent);
            const bt = parseInt(timeEl.querySelector('beat-type')?.textContent ?? '', 10);
            if (b) beats = b;
            if (bt > 0) beatType = bt;
          }
          // The staff's own <clef> (unnumbered, or number="1", for the first) -- a part read whole
          // takes its first staff's.
          const clefEl = child.querySelector(
            staff && staff > 1 ? `:scope > clef[number="${staff}"]` : ':scope > clef:not([number]), :scope > clef[number="1"]',
          );
          const clefSign = clefEl?.querySelector('sign')?.textContent;
          if (clefSign && !result.clef) {
            const lineText = clefEl!.querySelector('line')?.textContent;
            const octaveChangeText = clefEl!.querySelector('clef-octave-change')?.textContent;
            result.clef = {
              sign: clefSign,
              line: lineText ? parseInt(lineText, 10) : undefined,
              octaveChange: octaveChangeText ? parseInt(octaveChangeText, 10) : undefined,
            };
          }
          break;
        }
        case 'note': {
          const isChord = !!child.querySelector(':scope > chord');
          const restEl = child.querySelector(':scope > rest');
          const isRest = !!restEl;
          const voice = child.querySelector(':scope > voice')?.textContent?.trim() || '1';
          // A grace note (<grace/>) is spec-defined to carry no <duration> at all -- it's
          // deliberately "outside" normal measured time (an ornamental note played quickly
          // before/around the note it decorates). Confirmed concretely from a submitted score
          // excerpt ("Jagdlied"): a grace note leads into a triplet run. Must be excluded from the
          // <type> duration fallback just below -- otherwise it gets a real, nonzero duration that
          // is added to `cursor`, silently displacing every later note in the part.
          const isGrace = !!child.querySelector(':scope > grace');
          const durationText = child.querySelector(':scope > duration')?.textContent;
          const durationUnits = durationText ? parseFloat(durationText) : 0;
          let durationBeats = divisions > 0 ? durationUnits / divisions : 0;

          // <duration> is required by the spec, but OMR output and hand-edited files sometimes
          // carry only a <type>; left at 0 the next note would inherit this one's start (the
          // "Nachtigall" rest bug). Fall back to <type> (+ dots) then.
          if (durationBeats <= 0 && !isGrace) {
            const typeText = child.querySelector(':scope > type')?.textContent;
            const typeBeats = typeText ? TYPE_BEATS[typeText] : undefined;
            if (typeBeats != null) {
              const dots = child.querySelectorAll(':scope > dot').length;
              durationBeats = typeBeats * (2 - Math.pow(0.5, dots));
            }
          }
          // A whole-bar rest (<rest measure="yes"/>) lasts the whole bar by definition -- whatever
          // its <duration> says. Exporters regularly write a 4/4 whole rest's length into bars of
          // other metres (Mondlicht's 12/8 bars: 4 beats instead of 6), so it has no say in how
          // long the bar is. Without a stated length it fills the bar as the time signature has it.
          const isBarRest = isRest && restEl?.getAttribute('measure') === 'yes';
          if (isBarRest && durationBeats <= 0) durationBeats = Math.max(0, measureStartBeat + beats * (4 / beatType) - cursor);

          if (isGrace) durationBeats = GRACE_NOTE_DURATION_BEATS;
          // Still audible/visible as a real (very short) note -- just never allowed to touch
          // `cursor`; placed to end exactly where the main note it leads into starts.
          const rawStart = isChord ? lastNoteStart : cursor;
          const startBeat = isGrace ? Math.max(0, place(cursor, voice) - durationBeats) : place(rawStart, voice);
          const endBeat = isGrace ? startBeat + durationBeats : place(rawStart + durationBeats, voice);
          const noteBeats = endBeat - startBeat;

          const onStaff = !staff || (parseInt(child.querySelector(':scope > staff')?.textContent || '1', 10) || 1) === staff;
          if (!isRest && onStaff) {
            const pitchEl = child.querySelector(':scope > pitch');
            // A percussion note: its place on the staff stands in for a pitch.
            const unpitchedEl = pitchEl ? null : child.querySelector(':scope > unpitched');
            if (pitchEl || unpitchedEl) {
              const { step, octave } = pitchEl
                ? { step: pitchEl.querySelector('step')?.textContent?.trim() || 'C', octave: parseInt(pitchEl.querySelector('octave')?.textContent || '4', 10) }
                : unpitchedPlace(unpitchedEl!, child);
              const alter = pitchEl ? parseFloat(pitchEl.querySelector('alter')?.textContent || '0') : 0;
              const notehead = child.querySelector(':scope > notehead')?.textContent?.trim();
              const midi = pitchToMidi(step, alter, octave);
              // The first line of words; every line, by verse number, where there are more.
              const lyricEls = Array.from(child.querySelectorAll(':scope > lyric'));
              const verseOf = (el: Element | undefined): Verse => {
                const text = el?.querySelector(':scope > text')?.textContent?.trim();
                const syl = el?.querySelector(':scope > syllabic')?.textContent?.trim();
                return text
                  ? { lyric: text, lyricJoin: syl === 'begin' || syl === 'middle' ? true : undefined, lyricExtend: el?.querySelector(':scope > extend') ? true : undefined }
                  : {};
              };
              const lyricEl = lyricEls[0];
              const lyric = lyricEl?.querySelector(':scope > text')?.textContent?.trim();
              const syllabic = lyricEl?.querySelector(':scope > syllabic')?.textContent?.trim();
              let verses: Verse[] | undefined;
              if (lyricEls.some((el) => (parseInt(el.getAttribute('number') || '1', 10) || 1) > 1)) {
                verses = [];
                for (const el of lyricEls) {
                  const n = parseInt(el.getAttribute('number') || '1', 10) || 1;
                  if (n >= 1 && n <= 12 && !verses[n - 1]) verses[n - 1] = verseOf(el);
                }
              }

              // Tools vary in which element they emit for a tie: <tie> is the sound-level element,
              // <notations><tied> the notation-level one; OMR files sometimes carry only one.
              const tieTypes = new Set(
                Array.from(child.querySelectorAll(':scope > tie, :scope > notations > tied')).map((el) => el.getAttribute('type')),
              );
              const continuesOpenTie = tieTypes.has('stop') && openTieNotes.has(midi);
              // Its beams, by level (a grace note's own little beams aren't kept).
              let beamMarks: string[] | undefined;
              if (!isGrace) {
                for (const beamEl of Array.from(child.querySelectorAll(':scope > beam'))) {
                  const level = parseInt(beamEl.getAttribute('number') || '1', 10);
                  const mark = beamEl.textContent?.trim();
                  if (!mark || level < 1 || level > 6) continue;
                  (beamMarks ??= [])[level - 1] = mark;
                }
              }

              if (continuesOpenTie) {
                // Extend the already-pushed NoteEvent through this note's end instead of adding a
                // second one. newTotal is recomputed from the tie-start's own startBeat (not a
                // running sum), which self-corrects for any gap/rounding between tied notes; the
                // new tieSegments entry uses the same math so segments always sum to the total.
                const open = openTieNotes.get(midi)!;
                const newTotal = endBeat - open.startBeat;
                if (open.tieSegments) {
                  const priorSum = open.tieSegments.reduce((a, b) => a + b, 0);
                  open.tieSegments.push(newTotal - priorSum);
                }
                open.durationBeats = newTotal;
                if (open.beams || beamMarks) {
                  open.beams ??= (open.tieSegments ?? [0]).slice(0, -1).map(() => undefined);
                  open.beams.push(beamMarks);
                }
                if (!tieTypes.has('start')) openTieNotes.delete(midi);
              } else {
                const noteEvent: NoteEvent = {
                  partId,
                  midi,
                  startBeat,
                  durationBeats: noteBeats,
                  lyric: lyric || undefined,
                  lyricJoin: lyric && (syllabic === 'begin' || syllabic === 'middle') ? true : undefined,
                  lyricExtend: lyric && lyricEl?.querySelector(':scope > extend') ? true : undefined,
                  measureNumber,
                  step,
                  alter,
                  octave,
                  tieSegments: tieTypes.has('start') ? [noteBeats] : undefined,
                  voice,
                  beams: beamMarks ? [beamMarks] : undefined,
                  unpitched: unpitchedEl ? true : undefined,
                  notehead: notehead === 'x' || notehead === 'cross' ? 'x' : undefined,
                };
                result.notes.push(noteEvent);
                result.noteBars.push(index);
                if (verses) result.verses.set(noteEvent, verses);
                if (tieTypes.has('start')) openTieNotes.set(midi, noteEvent);
              }

              for (const slurEl of Array.from(child.querySelectorAll(':scope > notations > slur'))) {
                const num = parseInt(slurEl.getAttribute('number') || '1', 10);
                const type = slurEl.getAttribute('type');
                if (type === 'start') {
                  openSlurs.set(num, { beat: startBeat, midi });
                } else if (type === 'stop') {
                  const open = openSlurs.get(num);
                  if (open) {
                    result.slurs.push({ partId, startBeat: open.beat, startMidi: open.midi, endBeat: startBeat, endMidi: midi });
                    openSlurs.delete(num);
                  }
                }
              }
            }
          }

          if (!isChord && !isGrace) {
            if (!isBarRest) reached(voice, cursor + durationBeats);
            cursor += durationBeats;
            lastNoteStart = rawStart;
          }
          break;
        }
        case 'backup': {
          const durationUnits = parseFloat(child.querySelector('duration')?.textContent ?? '') || 0;
          cursor -= divisions > 0 ? durationUnits / divisions : 0;
          break;
        }
        case 'forward': {
          const durationUnits = parseFloat(child.querySelector('duration')?.textContent ?? '') || 0;
          cursor += divisions > 0 ? durationUnits / divisions : 0;
          reached(null, cursor);
          break;
        }
        case 'direction': {
          if (!plan) break;
          // A direction belongs to its <staff> (the first, without one).
          if (staff && (parseInt(child.querySelector(':scope > staff')?.textContent || '1', 10) || 1) !== staff) break;
          const voice = child.querySelector(':scope > voice')?.textContent?.trim() || '1';
          const offsetUnits = parseFloat(child.querySelector(':scope > offset')?.textContent ?? '') || 0;
          const beat = place(cursor + (divisions > 0 ? offsetUnits / divisions : 0), voice);
          readDirection(child, partId, beat, result, openWedges);
          break;
        }
      }
    }

    result.bars.push({ number: measureNumber, beats, beatType, fifths, mode: keyMode, reach, voiceReach });
    if (!planned) measureStartBeat += reach ?? beats * (4 / beatType);
  });
  return result;
}

/** A <direction>'s rehearsal mark, dynamics, hairpin, tempo or words, into `result`. */
function readDirection(el: Element, partId: string, beat: number, result: PartResult, openWedges: Map<number, ScoreMark>) {
  const types = Array.from(el.querySelectorAll(':scope > direction-type'));
  const below = el.getAttribute('placement') === 'below';
  const words: string[] = [];
  let metronome: ScoreMark['metronome'];
  for (const type of types) {
    const rehearsal = type.querySelector(':scope > rehearsal')?.textContent?.trim();
    if (rehearsal) result.rehearsalMarks.push({ label: rehearsal, beat });
    for (const dyn of Array.from(type.querySelectorAll(':scope > dynamics > *'))) {
      const text = dyn.tagName === 'other-dynamics' ? dyn.textContent?.trim() : dyn.tagName;
      if (text) result.marks.push({ kind: 'dynamic', partId, beat, text });
    }
    const wedge = type.querySelector(':scope > wedge');
    if (wedge) {
      const num = parseInt(wedge.getAttribute('number') || '1', 10);
      const kind = wedge.getAttribute('type');
      if (kind === 'crescendo' || kind === 'diminuendo') {
        const mark: ScoreMark = { kind: 'wedge', partId, beat, text: kind, endBeat: beat };
        openWedges.set(num, mark);
      } else if (kind === 'stop') {
        const open = openWedges.get(num);
        if (open) {
          open.endBeat = Math.max(open.beat, beat);
          if (open.endBeat > open.beat + EPS) result.marks.push(open);
          openWedges.delete(num);
        }
      }
    }
    for (const w of Array.from(type.querySelectorAll(':scope > words'))) {
      const text = w.textContent?.replace(/\s+/g, ' ').trim();
      // Not directions: titles and credits some exporters put in as words (large type, or set high
      // above the staff), sung syllables typed as words down among the lyrics, and chord symbols.
      const y = parseFloat(w.getAttribute('default-y') ?? '0');
      const credit = parseFloat(w.getAttribute('font-size') ?? '0') >= 16 || y >= 60;
      const amongLyrics = !el.getAttribute('placement') && y < -30;
      if (text && !credit && !amongLyrics && !CHORD_SYMBOL.test(text)) words.push(text);
    }
    const m = type.querySelector(':scope > metronome');
    const perMinute = m?.querySelector('per-minute')?.textContent?.trim();
    if (m && perMinute) {
      metronome = { unit: m.querySelector('beat-unit')?.textContent?.trim() || 'quarter', dots: m.querySelectorAll('beat-unit-dot').length, perMinute };
    }
  }
  const text = words.join(' ');
  const isTempo = !!metronome || !!el.querySelector(':scope > sound[tempo]') || TEMPO_WORDS.test(text);
  if (isTempo && (text || metronome)) result.marks.push({ kind: 'tempo', partId, beat, text, metronome });
  else if (text) result.marks.push({ kind: 'words', partId, beat, text, below: below || undefined });
}

/**
 * Lays the bars out once for all parts. A bar is as long as its time signature says, unless the
 * parts agree on something else (a pickup, a bar split around a repeat) -- so one voice whose bar
 * is too long or short (an unmarked triplet, a dropped note, a mis-sized whole-bar rest in a scan)
 * can no longer push that voice, or the bar lines, out of step with the others for the rest of
 * the piece.
 */
function planBars(parts: BarSurvey[][]): BarPlan[] {
  const count = Math.max(0, ...parts.map((p) => p.length));
  const plan: BarPlan[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const lead = parts.find((p) => p[i])?.[i];
    const nominal = lead ? lead.beats * (4 / lead.beatType) : 4;
    const votes = parts.map((p) => p[i]?.reach).filter((v): v is number => v != null && v > EPS);
    let length = nominal;
    if (votes.length && !votes.some((v) => Math.abs(v - nominal) < EPS)) {
      // Nobody fills the time signature: the length most parts agree on (the longer on a tie).
      let best = votes[0];
      let bestCount = 0;
      for (const v of votes) {
        const n = votes.filter((w) => Math.abs(w - v) < EPS).length;
        if (n > bestCount || (n === bestCount && v > best)) {
          best = v;
          bestCount = n;
        }
      }
      length = best;
    }
    plan.push({ start, length });
    start += length;
  }
  return plan;
}

/**
 * Parses a MusicXML partwise document into a flat Score model.
 * Supports the subset produced by typical OMR/engraving tools: multiple parts, chord notes, rests,
 * <backup>/<forward>, tuplets, and changes of divisions, time and key signature along the way.
 */
export function parseMusicXML(xmlText: string): Score {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid MusicXML: ' + parseError.textContent);
  }

  // An accent typed for an apostrophe ("Don´t") is set as one.
  const title = (
    doc.querySelector('work > work-title')?.textContent?.trim() ||
    doc.querySelector('movement-title')?.textContent?.trim() ||
    'Untitled'
  ).replace(/(\p{L})[´`](\p{L})/gu, '$1’$2');

  // Names as printed can run over several lines ("Clara\n(Anja)", "Übe-\nKlavier"): one line here.
  const fileParts: PartInfo[] = Array.from(doc.querySelectorAll('part-list > score-part')).map((el) => ({
    id: el.getAttribute('id') || '',
    name:
      [el.querySelector('part-name'), el.querySelector('part-abbreviation'), el.querySelector('score-instrument > instrument-name')]
        .map((n) => n?.textContent?.replace(/([-/])\s*\n\s*/g, '$1').replace(/\s+/g, ' ').trim())
        .find((n) => n) ||
      el.getAttribute('id') ||
      '',
  }));

  const partEls = Array.from(doc.querySelectorAll('score-partwise > part'));
  const fileIds = partEls.map((el) => el.getAttribute('id') || '');
  // Pass 1: how long each part's bars are. Pass 2: every part laid on the bars agreed from that.
  const surveys = partEls.map((el, i) => readPart(el, fileIds[i], null, null).bars);
  const plan = planBars(surveys);
  // A part printed on several staves (a piano's two hands) is one voice: one player, heard as one.
  // It is read once per staff, each staff's notes, clef and directions marked with it, so the sheet
  // view can draw them on their own staves (and splitStaves can make each a voice of its own).
  const parts: PartInfo[] = [];
  const results: PartResult[] = [];
  partEls.forEach((el, i) => {
    const info: PartInfo = { ...(fileParts.find((p) => p.id === fileIds[i]) ?? { id: fileIds[i], name: fileIds[i] }) };
    const staves = Math.max(1, ...Array.from(el.querySelectorAll(':scope > measure > attributes > staves')).map((s) => parseInt(s.textContent || '1', 10) || 1));
    parts.push(info);
    if (staves === 1) {
      const r = readPart(el, info.id, plan, surveys[i]);
      info.clef = r.clef;
      results.push(r);
      return;
    }
    info.staves = [];
    for (let staff = 1; staff <= staves; staff++) {
      const r = readPart(el, info.id, plan, surveys[i], staff);
      for (const n of r.notes) n.staff = staff;
      for (const sl of r.slurs) sl.staff = staff;
      for (const m of r.marks) m.staff = staff;
      info.staves.push({ clef: r.clef });
      results.push(r);
    }
    info.clef = info.staves[0].clef;
  });

  const notes = results.flatMap((r) => r.notes).sort((a, b) => a.startBeat - b.startBeat);
  const slurs = results.flatMap((r) => r.slurs);
  const marks = results.flatMap((r) => r.marks).sort((a, b) => a.beat - b.beat);
  for (const p of parts) if (!p.clef) delete p.clef;

  // Bar numbers, time and key signatures and rehearsal marks are the piece's, read from the first
  // part (real scores print rehearsal marks once, usually over the top staff).
  const lead = results[0];
  const measures: MeasureInfo[] = (lead?.bars ?? []).map((bar, i) => ({
    number: bar.number,
    startBeat: plan[i].start,
    beats: bar.beats,
    beatType: bar.beatType,
    fifths: bar.fifths,
    mode: bar.mode,
  }));
  const rehearsalMarks = (lead?.rehearsalMarks ?? []).sort((a, b) => a.beat - b.beat);
  const last = plan.at(-1);
  const totalBeats = last ? last.start + last.length : 0;
  const score: Score = { title, parts, notes, measures, slurs, totalBeats, rehearsalMarks, tempo: readTempo(doc), marks };

  // Repeats, endings and jumps: the bars laid out in the order they're played.
  const order = playOrder(mergeRepeats(partEls.map(readRepeats)), plan.length);
  if (order.length === plan.length && order.every((o, k) => o.bar === k)) return score;
  const noteBar = new Map<NoteEvent, number>();
  const verses = new Map<NoteEvent, Verse[]>();
  for (const r of results) {
    r.notes.forEach((n, k) => noteBar.set(n, r.noteBars[k]));
    for (const [n, v] of r.verses) verses.set(n, v);
  }
  return unroll(score, plan, order, noteBar, verses);
}

/** A bar's repeat signs, endings and jumps, as printed (MusicXML <barline> and <sound>). */
interface BarRepeats {
  forward?: boolean; // |: at its start
  backward?: number; // :| at its end: how often the passage is played, all told (2 unless stated)
  ending?: { numbers: number[]; start: boolean; stop: boolean }; // a volta bracket begins / ends here
  segno?: boolean;
  coda?: boolean; // the coda begins here
  dacapo?: boolean; // D.C. at its end
  dalsegno?: boolean; // D.S. at its end
  tocoda?: boolean; // "To Coda" at its end (taken after a D.C. or D.S.)
  fine?: boolean; // "Fine": the end, after a D.C. or D.S.
}

function readRepeats(partEl: Element): BarRepeats[] {
  return Array.from(partEl.querySelectorAll(':scope > measure')).map((measure) => {
    const bar: BarRepeats = {};
    for (const line of Array.from(measure.querySelectorAll(':scope > barline'))) {
      const repeat = line.querySelector(':scope > repeat');
      const direction = repeat?.getAttribute('direction');
      if (direction === 'forward') bar.forward = true;
      if (direction === 'backward') bar.backward = Math.max(1, parseInt(repeat!.getAttribute('times') || '2', 10) || 2);
      const ending = line.querySelector(':scope > ending');
      if (ending) {
        const type = ending.getAttribute('type');
        const numbers = (ending.getAttribute('number') || '').split(/[^0-9]+/).map(Number).filter((n) => n > 0);
        bar.ending = {
          numbers: numbers.length ? numbers : (bar.ending?.numbers ?? []),
          start: !!bar.ending?.start || type === 'start',
          stop: !!bar.ending?.stop || type === 'stop' || type === 'discontinue',
        };
      }
    }
    for (const sound of Array.from(measure.querySelectorAll('sound'))) {
      if (sound.hasAttribute('segno')) bar.segno = true;
      if (sound.hasAttribute('coda')) bar.coda = true;
      if (sound.hasAttribute('dacapo') && sound.getAttribute('dacapo') !== 'no') bar.dacapo = true;
      if (sound.hasAttribute('dalsegno')) bar.dalsegno = true;
      if (sound.hasAttribute('tocoda')) bar.tocoda = true;
      if (sound.hasAttribute('fine')) bar.fine = true;
    }
    return bar;
  });
}

/** Every part's repeats, together: the first part's endings, any part's signs and jumps. */
function mergeRepeats(parts: BarRepeats[][]): BarRepeats[] {
  const count = Math.max(0, ...parts.map((p) => p.length));
  return Array.from({ length: count }, (_, i) => {
    const bars = parts.map((p) => p[i]).filter((b): b is BarRepeats => !!b);
    const backward = Math.max(0, ...bars.map((b) => b.backward ?? 0));
    return {
      forward: bars.some((b) => b.forward) || undefined,
      backward: backward || undefined,
      ending: bars.find((b) => b.ending)?.ending,
      segno: bars.some((b) => b.segno) || undefined,
      coda: bars.some((b) => b.coda) || undefined,
      dacapo: bars.some((b) => b.dacapo) || undefined,
      dalsegno: bars.some((b) => b.dalsegno) || undefined,
      tocoda: bars.some((b) => b.tocoda) || undefined,
      fine: bars.some((b) => b.fine) || undefined,
    };
  });
}

/**
 * The bars in the order they're played, each with its pass through a repeat (1, 2, ...): a
 * passage between |: and :| as often as the repeat says, its volta brackets on their passes, D.C.
 * and D.S. once each -- after which repeats aren't taken again, the last volta is played, "To
 * Coda" jumps to the coda and "Fine" ends -- as an engraved part is read. `count` bars in all.
 */
function playOrder(bars: BarRepeats[], count: number): { bar: number; pass: number }[] {
  // Each bar's volta numbers, and the last bar of its volta.
  const voltaOf: (number[] | null)[] = [];
  const voltaEnd: number[] = [];
  let open: number[] | null = null;
  let openStart = 0;
  for (let i = 0; i < count; i++) {
    const ending = bars[i]?.ending;
    if (ending?.start) {
      open = ending.numbers;
      openStart = i;
    }
    voltaOf[i] = open;
    if (open && (ending?.stop || i === count - 1)) {
      for (let j = openStart; j <= i; j++) voltaEnd[j] = i;
      open = null;
    }
  }
  const lastVolta = (i: number) => !(voltaEnd[i] + 1 < count && voltaOf[voltaEnd[i] + 1]);
  const segno = bars.findIndex((b) => b.segno);
  const coda = bars.findIndex((b) => b.coda);

  const order: { bar: number; pass: number }[] = [];
  const jumpsTaken = new Set<number>();
  let i = 0;
  let pass = 1;
  let from = 0; // where the passage being repeated begins
  let jumped = false; // past a D.C. or D.S.
  let inVolta = false;
  const limit = count * 16 + 64; // a malformed file never plays forever
  while (i < count && order.length < limit) {
    const bar = bars[i] ?? {};
    const volta = voltaOf[i];
    if (!volta && inVolta) {
      // Past the voltas: a new passage.
      pass = 1;
      from = i;
    }
    if (bar.forward && i !== from) {
      from = i;
      pass = 1;
    }
    inVolta = !!volta;
    if (volta && !(jumped ? lastVolta(i) : volta.includes(pass))) {
      i = voltaEnd[i] + 1;
      continue;
    }
    order.push({ bar: i, pass });
    if (jumped && bar.fine) break;
    if (jumped && bar.tocoda && coda > i) {
      i = coda;
      continue;
    }
    if (bar.backward && !jumped) {
      if (pass < bar.backward) {
        pass++;
        i = from;
        inVolta = false;
        continue;
      }
      if (!volta) {
        pass = 1;
        from = i + 1;
      }
    }
    if ((bar.dacapo || (bar.dalsegno && segno >= 0)) && !jumpsTaken.has(i)) {
      jumpsTaken.add(i);
      jumped = true;
      i = bar.dacapo ? 0 : segno;
      pass = 1;
      from = i;
      inVolta = false;
      continue;
    }
    i++;
  }
  return order;
}

/**
 * The score with its bars in playing order: each bar's notes, slurs and marks once per time it's
 * played, under its printed number; on a passage's second pass the second verse's words, where it
 * has them; rehearsal marks at their first pass only. `playOrder` maps the printed layout to it.
 */
function unroll(score: Score, plan: BarPlan[], order: { bar: number; pass: number }[], noteBar: Map<NoteEvent, number>, verses: Map<NoteEvent, Verse[]>): Score {
  const passes: { bar: number; pass: number; start: number }[] = [];
  let at = 0;
  for (const o of order) {
    passes.push({ ...o, start: at });
    at += plan[o.bar].length;
  }
  const playedAt: number[][] = plan.map(() => []); // per printed bar, its passes (indices into passes)
  passes.forEach((p, k) => playedAt[p.bar].push(k));
  // The printed bar a beat falls in.
  const barAt = (beat: number) => {
    let lo = 0;
    let hi = plan.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (plan[mid].start <= beat + EPS) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const notes: NoteEvent[] = [];
  for (const n of score.notes) {
    const bar = noteBar.get(n) ?? barAt(n.startBeat);
    const lines = playedAt[bar].length > 1 ? verses.get(n) : undefined;
    for (const k of playedAt[bar]) {
      const copy: NoteEvent = { ...n, startBeat: n.startBeat - plan[bar].start + passes[k].start };
      if (lines) {
        // This pass's verse; one printed only once is sung every time.
        const verse = lines[passes[k].pass - 1] ?? (passes[k].pass > 1 ? lines[0] : undefined) ?? {};
        copy.lyric = verse.lyric;
        copy.lyricJoin = verse.lyricJoin;
        copy.lyricExtend = verse.lyricExtend;
      }
      notes.push(copy);
    }
  }
  notes.sort((a, b) => a.startBeat - b.startBeat);

  const shifted = <T extends { beat?: number; startBeat?: number }>(items: T[], beatOf: (item: T) => number, move: (item: T, by: number) => T): T[] =>
    items.flatMap((item) => {
      const bar = barAt(beatOf(item));
      return playedAt[bar].map((k) => move(item, passes[k].start - plan[bar].start));
    });
  const slurs = shifted(score.slurs, (sl) => sl.startBeat, (sl, by) => ({ ...sl, startBeat: sl.startBeat + by, endBeat: sl.endBeat + by }));
  const marks = score.marks
    ? shifted(score.marks, (m) => m.beat, (m, by) => ({ ...m, beat: m.beat + by, endBeat: m.endBeat !== undefined ? m.endBeat + by : undefined })).sort((a, b) => a.beat - b.beat)
    : undefined;
  const rehearsalMarks = score.rehearsalMarks.flatMap((r) => {
    const bar = barAt(r.beat);
    const first = playedAt[bar][0];
    return first === undefined ? [] : [{ ...r, beat: r.beat - plan[bar].start + passes[first].start }];
  });
  const measures = passes.flatMap((p) => {
    const m = score.measures[p.bar];
    return m ? [{ ...m, startBeat: p.start }] : [];
  });
  return {
    ...score,
    notes,
    slurs,
    marks,
    rehearsalMarks,
    measures,
    totalBeats: at,
    playOrder: passes.map((p) => ({ start: p.start, writtenStart: plan[p.bar].start, length: plan[p.bar].length })),
  };
}

/**
 * Makes each staff of the given parts a voice of its own (a song whose hands are played by two
 * people): ids "<part>-staff<n>", named "<part> (oben)" / "(unten)" (numbered from three staves on),
 * each with its staff's clef, notes, slurs and marks. Parts on one staff are left as they are.
 */
export function splitStaves(score: Score, partIds: Iterable<string>) {
  const chosen = new Set(partIds);
  const parts: PartInfo[] = [];
  const moved = new Map<string, string[]>(); // part id -> its staves' new ids
  for (const part of score.parts) {
    if (!chosen.has(part.id) || !part.staves || part.staves.length < 2) {
      parts.push(part);
      continue;
    }
    const count = part.staves.length;
    const ids = part.staves.map((staff, i) => {
      const id = `${part.id}-staff${i + 1}`;
      const label = count === 2 ? t(i === 0 ? 'staffUpper' : 'staffLower') : String(i + 1);
      const voice: PartInfo = { id, name: `${part.name} (${label})`, sourceId: part.id, sourceName: part.name };
      if (staff.clef) voice.clef = staff.clef;
      parts.push(voice);
      return id;
    });
    moved.set(part.id, ids);
  }
  if (!moved.size) return;
  const staffId = (partId: string, staff: number | undefined) => {
    const ids = moved.get(partId);
    return ids ? ids[Math.min(ids.length, Math.max(1, staff ?? 1)) - 1] : partId;
  };
  score.parts = parts;
  score.notes = score.notes.map((n) => (moved.has(n.partId) ? { ...n, partId: staffId(n.partId, n.staff) } : n));
  score.slurs = score.slurs.map((sl) => (moved.has(sl.partId) ? { ...sl, partId: staffId(sl.partId, sl.staff) } : sl));
  if (score.marks) score.marks = score.marks.map((m) => (moved.has(m.partId) ? { ...m, partId: staffId(m.partId, m.staff) } : m));
}

/**
 * The file's first stated tempo in quarter notes per minute: a <sound tempo> (always in quarter
 * notes by definition) wins; otherwise a printed metronome mark, converted from its beat unit.
 */
function readTempo(doc: Document): number | undefined {
  const sound = doc.querySelector('sound[tempo]')?.getAttribute('tempo');
  const fromSound = sound ? parseFloat(sound) : NaN;
  if (Number.isFinite(fromSound) && fromSound > 0) return Math.round(fromSound);
  const metronome = doc.querySelector('direction-type > metronome');
  const perMinute = parseFloat(metronome?.querySelector('per-minute')?.textContent ?? '');
  if (!Number.isFinite(perMinute) || perMinute <= 0) return undefined;
  const unit = metronome?.querySelector('beat-unit')?.textContent?.trim() ?? 'quarter';
  const quarters: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };
  let factor = quarters[unit] ?? 1;
  if (metronome?.querySelector('beat-unit-dot')) factor *= 1.5;
  return Math.round(perMinute * factor);
}
