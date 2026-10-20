// Body percussion and drums in MIDI files: clapping, stamping, snapping, drums. MIDI keeps them on
// channel 10, where a key is an instrument, not a pitch (General MIDI: 36 bass drum -- what a stamp
// is usually written as --, 39 hand clap, 42 hi-hat ...); some files put them on a track of their
// own named after them instead. Such notes become percussion notes (NoteEvent.unpitched), as a
// MusicXML <unpitched> note is: placed where percussion notation prints the instrument on a treble
// staff (the bass drum / a stamp low, a clap high, with a cross for claps and cymbals), never
// transposed, and played as a tap (audioEngine playTap) -- low places as a thump, high ones as a clap.

import type { NoteEvent, Score } from './score';

type Place = { midi: number; x?: boolean };

const F4: Place = { midi: 65 }; // bottom space: bass drum, stamping
const A4: Place = { midi: 69 }; // a pat on the thighs, a low tom
const C5: Place = { midi: 72 }; // snare
const D5: Place = { midi: 74 }; // toms
const E5x: Place = { midi: 76, x: true }; // hand clap
const F5x: Place = { midi: 77, x: true }; // ride
const G5x: Place = { midi: 79, x: true }; // hi-hat, a snap
const A5x: Place = { midi: 81, x: true }; // crash

/** General MIDI's percussion keys (channel 10), placed as drum notation prints them. */
function gmPlace(key: number): Place {
  if (key === 35 || key === 36) return F4;
  if (key === 39) return E5x;
  if (key === 37 || key === 38 || key === 40) return C5;
  if (key === 41 || key === 43) return A4;
  if (key === 45 || key === 47 || key === 48 || key === 50) return D5;
  if (key === 42 || key === 44 || key === 46) return G5x;
  if (key === 49 || key === 52 || key === 55 || key === 57) return A5x;
  if (key === 51 || key === 53 || key === 59) return F5x;
  if (key >= 54) return G5x; // tambourine, cowbell, claves, woodblocks, shakers: small and high
  return C5;
}

// What a part's name says it is: one instrument (all its notes go to its place) or a kit (keys
// placed as General MIDI's). German and English, as choir arrangements name them.
const ONE_INSTRUMENT: [RegExp, Place][] = [
  [/klatsch|clap/i, E5x],
  [/stampf|stomp|stamp/i, F4],
  [/schnips|snap/i, G5x],
  [/patsch|oberschenkel|thigh|\bpat\b|slap|brust|chest/i, A4],
];
const KIT = /percussion|perkussion|\bperc\b|schlagwerk|schlagzeug|drum|beat ?box|\bkit\b/i;

/** How a part's name says to place its notes: one instrument's place, General MIDI's, or not percussion. */
export function percussionByName(name: string): Place | 'gm' | null {
  for (const [re, place] of ONE_INSTRUMENT) if (re.test(name)) return place;
  return KIT.test(name) ? 'gm' : null;
}

// The keys body percussion and drum grooves use most (bass drum, sticks, snare, clap, hi-hats, toms).
const DRUM_KEYS = new Set([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 54, 56, 57, 59]);

/**
 * Whether a part's notes look like a drum track whose channel wasn't kept (MIDI files imported
 * before channel 10 was read): only short hits, on a few of the usual drum keys.
 */
export function looksLikeDrums(notes: NoteEvent[]): boolean {
  if (notes.length < 4) return false;
  const keys = new Set(notes.map((n) => n.midi));
  if (keys.size > 8 || ![...keys].every((k) => DRUM_KEYS.has(k))) return false;
  const durations = notes.map((n) => n.durationBeats).sort((a, b) => a - b);
  return durations[durations.length >> 1] <= 0.26;
}

/**
 * Makes notes percussion notes, placed by `how`: one instrument's place, General MIDI's keys, or
 * (a MusicXML part written on a normal staff) where they are printed already.
 */
export function asPercussion(notes: NoteEvent[], how: Place | 'gm' | 'keep' | 'low-high', cross = false): NoteEvent[] {
  const lowHigh = how === 'low-high' ? lowToHigh(notes) : null;
  return notes.map((n) => {
    if (how === 'keep') return { ...n, unpitched: true, notehead: cross ? 'x' : n.notehead };
    const place = how === 'gm' ? gmPlace(n.midi) : lowHigh ? lowHigh.get(n.midi)! : (how as Place);
    return { ...n, midi: place.midi, unpitched: true, notehead: place.x ? 'x' : undefined, step: undefined, alter: undefined, octave: undefined };
  });
}

// Body percussion written on ordinary pitches: the lowest is the feet, the highest the hands, what
// lies between pats and snares.
const LOW_TO_HIGH: Place[] = [F4, A4, C5, D5];

function lowToHigh(notes: NoteEvent[]): Map<number, Place> {
  const keys = [...new Set(notes.map((n) => n.midi))].sort((a, b) => a - b);
  const map = new Map<number, Place>();
  if (keys.length === 1) map.set(keys[0], C5);
  else keys.forEach((k, i) => map.set(k, i === keys.length - 1 ? E5x : LOW_TO_HIGH[Math.min(i, LOW_TO_HIGH.length - 1)]));
  return map;
}

/**
 * A score's parts that are percussion -- by their name, or (a MIDI import stored before channel
 * 10 was read) by how their notes look -- made percussion; `choice` (the song's own setting per
 * part, main.ts) overrides that either way. `midi`: the notes' numbers are MIDI keys (else they are
 * printed pitches, MusicXML, and keep their places).
 */
export function applyPercussion(score: Score, choice: Record<string, boolean> = {}, midi = true): Set<string> {
  const made = new Set<string>();
  const byPart = new Map<string, NoteEvent[]>();
  for (const n of score.notes) {
    const list = byPart.get(n.partId);
    if (list) list.push(n);
    else byPart.set(n.partId, [n]);
  }
  let changed = false;
  for (const part of score.parts) {
    const notes = byPart.get(part.id) ?? [];
    if (!notes.length || notes.every((n) => n.unpitched)) continue;
    const named = percussionByName(part.name);
    const wanted = choice[part.id] ?? (named !== null || part.midiChannel === 10 || (midi && looksLikeDrums(notes)));
    if (!wanted) continue;
    // A kit (by its name, channel 10, or chosen by hand): its keys as General MIDI's when they are
    // drum keys, else written on ordinary pitches -- low ones the feet, high ones the hands.
    const kit = named === null || named === 'gm';
    const how = !midi ? 'keep' : !kit ? named : notes.every((n) => DRUM_KEYS.has(n.midi)) ? 'gm' : 'low-high';
    const cross = named !== null && named !== 'gm' && !!named.x;
    byPart.set(part.id, asPercussion(notes, how, cross));
    part.clef = { sign: 'percussion', line: 2 };
    made.add(part.id);
    changed = true;
  }
  if (changed) score.notes = [...byPart.values()].flat().sort((a, b) => a.startBeat - b.startBeat);
  return made;
}
