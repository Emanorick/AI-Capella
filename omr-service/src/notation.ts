// The compact notation GPT reads and writes music in: one short string per note, a voice a list of
// them -- about a fifth of the tokens the earlier object-per-note JSON took, which makes reading a
// whole page in one answer practical.
//
//   C5 1            a quarter-note C5 (durations in quarter notes: 1/2 eighth, 3/2 dotted quarter,
//                   1/3 triplet eighth, 4 whole)
//   F#4 1/2         pitches as they sound with the key signature applied (in G major, F#4)
//   r 2             a half rest
//   C5 2~           tied to the next note of the same pitch in this voice
//   +E5 1           sounds together with the previous note (a chord)
//   C5 1 :Eve-|Come words under the note, one per verse, "|" between verses; a trailing "-" means
//                   the word goes on, a trailing "_" ("ah_") that the syllable is held on (a
//                   melisma line); "_" alone holds the previous syllable here; "" none
//   xF5 1/2         a percussion note (clap, drum) printed where F5 would be

export interface Voice {
  v: number; // voice number (MusicXML <voice>)
  staff: number; // 1 unless the part has several staves
  notes: string[];
}

export interface NoteEv {
  chord: boolean;
  rest: boolean;
  unpitched: boolean;
  step: string; // "" for a rest
  alter: number;
  octave: number;
  num: number; // duration in quarter notes: num / den
  den: number;
  tie: boolean; // tied to the next note
  verses: string[]; // per verse ("" none, "_" held, "Eve-" goes on)
}

const TOKEN = /^(\+)?(?:(r)|(x)?([A-G])(#{1,2}|b{1,2})?(-?\d)) +(\d+)(?:\/(\d+))?(~)?(?: +:(.*))?$/;

export class NotationError extends Error {}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** One note string, read. */
export function parseNote(token: string): NoteEv {
  const m = String(token).trim().match(TOKEN);
  if (!m) throw new NotationError(`can't read "${token}"`);
  const [, plus, rest, x, step, acc, octave, num, den, tie, words] = m;
  const n = Number(num);
  const d = den ? Number(den) : 1;
  if (!n || !d) throw new NotationError(`bad duration in "${token}"`);
  const g = gcd(n, d);
  return {
    chord: !!plus,
    rest: !!rest,
    unpitched: !!x,
    step: rest ? '' : step,
    alter: acc ? (acc[0] === '#' ? acc.length : -acc.length) : 0,
    octave: rest ? 0 : Number(octave),
    num: n / g,
    den: d / g,
    tie: !!tie && !rest,
    verses: words !== undefined ? words.split('|').map((s) => s.trim()) : [],
  };
}

export function pitchText(n: Pick<NoteEv, 'step' | 'alter' | 'octave'>): string {
  return `${n.step}${n.alter > 0 ? '#'.repeat(n.alter) : 'b'.repeat(-n.alter)}${n.octave}`;
}

/** A note, written back as its string. */
export function formatNote(n: NoteEv): string {
  const pitch = n.rest ? 'r' : `${n.unpitched ? 'x' : ''}${pitchText(n)}`;
  const dur = n.den === 1 ? String(n.num) : `${n.num}/${n.den}`;
  const verses = [...n.verses];
  while (verses.length && !verses[verses.length - 1]) verses.pop();
  return `${n.chord ? '+' : ''}${pitch} ${dur}${n.tie ? '~' : ''}${verses.length ? ` :${verses.join('|')}` : ''}`;
}

/** How long a voice lasts, in quarters, as a fraction (chord notes don't move time on). */
export function voiceLength(notes: NoteEv[]): { num: number; den: number } {
  let num = 0;
  let den = 1;
  for (const n of notes) {
    if (n.chord) continue;
    const l = lcm(den, n.den);
    num = num * (l / den) + n.num * (l / n.den);
    den = l;
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return { num, den };
}

/** Every voice of a measure, read; throws NotationError naming the first string it can't read. */
export function parseVoices(voices: Voice[]): { v: number; staff: number; notes: NoteEv[] }[] {
  return voices.map((voice) => ({
    v: Math.max(1, Math.round(voice.v) || 1),
    staff: Math.max(1, Math.round(voice.staff) || 1),
    notes: voice.notes.map(parseNote),
  }));
}
