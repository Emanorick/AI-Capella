import type { MeasureInfo, NoteEvent, PartInfo, RehearsalMark, Score, ScoreMark, SlurArc } from './score';

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

interface PartResult {
  bars: BarSurvey[];
  notes: NoteEvent[];
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

/**
 * Walks one part. Without a plan (pass 1) bars follow each other at whatever length the part's own
 * content has, and only the survey is of use. With a plan (pass 2) every bar starts where the
 * plan says, and a voice whose content overruns the bar (an unmarked tuplet, typically) is fitted
 * into it.
 */
function readPart(partEl: Element, partId: string, plan: BarPlan[] | null, survey: BarSurvey[] | null): PartResult {
  const result: PartResult = { bars: [], notes: [], slurs: [], marks: [], rehearsalMarks: [] };
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
          // Only the first (unnumbered, or number="1") <clef> -- a part with more than one staff
          // (piano grand staff, e.g.) can have several, but this app renders one staff per part.
          const clefEl = child.querySelector(':scope > clef:not([number]), :scope > clef[number="1"]');
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

          if (!isRest) {
            const pitchEl = child.querySelector(':scope > pitch');
            if (pitchEl) {
              const step = pitchEl.querySelector('step')?.textContent || 'C';
              const alter = parseFloat(pitchEl.querySelector('alter')?.textContent || '0');
              const octave = parseInt(pitchEl.querySelector('octave')?.textContent || '4', 10);
              const midi = pitchToMidi(step, alter, octave);
              const lyricEl = child.querySelector(':scope > lyric');
              const lyric = lyricEl?.querySelector(':scope > text')?.textContent?.trim();
              const syllabic = lyricEl?.querySelector(':scope > syllabic')?.textContent?.trim();

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
                };
                result.notes.push(noteEvent);
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

  const title =
    doc.querySelector('work > work-title')?.textContent?.trim() ||
    doc.querySelector('movement-title')?.textContent?.trim() ||
    'Untitled';

  const parts: PartInfo[] = Array.from(doc.querySelectorAll('part-list > score-part')).map((el) => ({
    id: el.getAttribute('id') || '',
    name: el.querySelector('part-name')?.textContent?.trim() || el.getAttribute('id') || '',
  }));

  const partEls = Array.from(doc.querySelectorAll('score-partwise > part'));
  const ids = partEls.map((el) => el.getAttribute('id') || '');
  // Pass 1: how long each part's bars are. Pass 2: every part laid on the bars agreed from that.
  const surveys = partEls.map((el, i) => readPart(el, ids[i], null, null).bars);
  const plan = planBars(surveys);
  const results = partEls.map((el, i) => readPart(el, ids[i], plan, surveys[i]));

  const notes = results.flatMap((r) => r.notes).sort((a, b) => a.startBeat - b.startBeat);
  const slurs = results.flatMap((r) => r.slurs);
  const marks = results.flatMap((r) => r.marks).sort((a, b) => a.beat - b.beat);
  results.forEach((r, i) => {
    const partInfo = parts.find((p) => p.id === ids[i]);
    if (partInfo && r.clef) partInfo.clef = r.clef;
  });

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

  return { title, parts, notes, measures, slurs, totalBeats, rehearsalMarks, tempo: readTempo(doc), marks };
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
