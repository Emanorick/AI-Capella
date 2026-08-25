import type { MeasureInfo, NoteEvent, PartInfo, Score } from './score';

/** Sequential reader over a standard MIDI file's bytes, tracking position for the caller. */
class ByteReader {
  private view: DataView;
  pos = 0;
  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }
  get length() {
    return this.view.byteLength;
  }
  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  /** Variable-length quantity: 7 data bits per byte, high bit means "more bytes follow". */
  vlq(): number {
    let value = 0;
    for (;;) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }
  text(len: number): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len);
    this.pos += len;
    // Meta-event text is spec'd as ASCII, but real-world files vary and choir lyrics are
    // frequently non-ASCII (accents, umlauts); UTF-8 with a lossy fallback covers plain ASCII
    // identically while decoding those correctly too.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  skip(len: number) {
    this.pos += len;
  }
  ascii(len: number): string {
    return this.text(len);
  }
}

interface OpenNote {
  startTick: number;
  lyric?: string;
}

interface PartBuild {
  trackIndex: number;
  channel: number;
  trackName?: string;
  notes: NoteEvent[];
  openNotes: Map<number, OpenNote>; // keyed by pitch
  pendingLyric?: string;
}

interface TimeSigChange {
  beat: number;
  beats: number;
  beatType: number;
}

/**
 * Parses a standard MIDI file (format 0, 1, or 2) into the same Score model MusicXML import
 * produces. MIDI note numbers already match this app's `midi` field 1:1 (note 60 = C4 in both),
 * so unlike a MusicXML round-trip there's no pitch-spelling (step/alter) to reconstruct -- the
 * numbers are used as-is.
 */
export function parseMIDI(buffer: ArrayBuffer): Score {
  const reader = new ByteReader(buffer);

  if (reader.ascii(4) !== 'MThd') throw new Error('Not a standard MIDI file (missing MThd header)');
  const headerLen = reader.u32();
  const headerEnd = reader.pos + headerLen;
  reader.u16(); // format (0/1/2): every track is parsed identically regardless
  const numTracks = reader.u16();
  const division = reader.u16();
  if (division & 0x8000) throw new Error('SMPTE-timecode MIDI files are not supported');
  if (division === 0) throw new Error('Invalid MIDI file: ticks-per-quarter-note (division) is zero');
  const ticksPerQuarter = division;
  reader.pos = headerEnd; // tolerate a header chunk longer than the 6 bytes we read

  let title: string | undefined;
  const timeSigChanges: TimeSigChange[] = [];
  const parts = new Map<string, PartBuild>(); // keyed by "trackIndex:channel"

  for (let trackIndex = 0; trackIndex < numTracks && reader.pos < reader.length; trackIndex++) {
    const chunkId = reader.ascii(4);
    const chunkLen = reader.u32();
    const trackEnd = reader.pos + chunkLen;
    if (chunkId !== 'MTrk') {
      // Unknown/non-standard chunk type -- skip it rather than fail the whole import.
      reader.pos = trackEnd;
      continue;
    }

    let tick = 0;
    let runningStatus: number | null = null;
    let trackName: string | undefined;
    let pendingLyric: string | undefined;

    const partFor = (channel: number): PartBuild => {
      const key = `${trackIndex}:${channel}`;
      let part = parts.get(key);
      if (!part) {
        part = { trackIndex, channel, trackName, notes: [], openNotes: new Map() };
        parts.set(key, part);
      }
      return part;
    };

    while (reader.pos < trackEnd) {
      tick += reader.vlq();
      let status = reader.u8();

      if (status === 0xff) {
        // Meta event: type byte, then a length-prefixed data block.
        const metaType = reader.u8();
        const len = reader.vlq();
        const dataStart = reader.pos;
        if (metaType === 0x03) {
          trackName = reader.text(len);
          if (trackIndex === 0 && !title) title = trackName;
          for (const part of parts.values()) if (part.trackIndex === trackIndex) part.trackName = trackName;
        } else if (metaType === 0x01 || metaType === 0x05) {
          // Text / Lyric: attached to whichever note-on comes next in this track.
          pendingLyric = reader.text(len).trim();
        } else if (metaType === 0x58 && len >= 2) {
          const numerator = reader.u8();
          const denomPow = reader.u8();
          const beats = Math.max(1, numerator);
          const beatType = Math.max(1, Math.min(64, Math.pow(2, Math.min(6, Math.max(0, denomPow)))));
          timeSigChanges.push({ beat: tick / ticksPerQuarter, beats, beatType });
        }
        // Jump to the end of this meta block regardless of how many bytes a handler above
        // actually consumed -- `len` is authoritative, and this also skips any type we don't care
        // about (tempo, end-of-track, etc).
        reader.pos = dataStart + len;
        runningStatus = null;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        // Sysex: length-prefixed, and per spec resets running status.
        const len = reader.vlq();
        reader.skip(len);
        runningStatus = null;
        continue;
      }

      // Channel voice/mode message. A byte below 0x80 here means running status: this byte is
      // actually the first data byte, and the previous status byte carries forward.
      if (status < 0x80) {
        if (runningStatus == null) throw new Error('Malformed MIDI: data byte with no running status');
        reader.pos -= 1;
        status = runningStatus;
      } else {
        runningStatus = status;
      }

      const type = status & 0xf0;
      if (type < 0x80 || type > 0xe0) {
        // System common/realtime bytes (0xF1-0xF6, 0xF8-0xFE) are live-performance-stream-only
        // and essentially never appear in a written SMF file; failing clearly here beats silently
        // misaligning every subsequent event by guessing a data-byte count for an unknown status.
        throw new Error(`Unsupported MIDI status byte 0x${status.toString(16)}`);
      }
      const channel = status & 0x0f;

      if (type === 0x90 || type === 0x80) {
        const pitch = reader.u8();
        const velocity = reader.u8();
        const part = partFor(channel);
        const isNoteOn = type === 0x90 && velocity > 0;
        if (isNoteOn) {
          // A retrigger of an already-open pitch (no note-off in between) closes the old one at
          // the new note's start rather than leaving it dangling.
          const already = part.openNotes.get(pitch);
          if (already) {
            part.notes.push(makeNote(pitch, already, tick, ticksPerQuarter));
          }
          part.openNotes.set(pitch, { startTick: tick, lyric: pendingLyric });
          pendingLyric = undefined;
        } else {
          const open = part.openNotes.get(pitch);
          if (open) {
            part.openNotes.delete(pitch);
            part.notes.push(makeNote(pitch, open, tick, ticksPerQuarter));
          }
        }
      } else if (type === 0xc0 || type === 0xd0) {
        reader.skip(1); // program change / channel pressure: one data byte
      } else {
        reader.skip(2); // polyphonic pressure, control change, pitch bend: two data bytes
      }
    }

    // Any note still open at track end (missing its note-off) is closed here rather than dropped.
    for (const part of parts.values()) {
      if (part.trackIndex !== trackIndex) continue;
      for (const [pitch, open] of part.openNotes) {
        part.notes.push(makeNote(pitch, open, tick, ticksPerQuarter));
      }
      part.openNotes.clear();
    }
    reader.pos = trackEnd;
  }

  const partInfos: PartInfo[] = [];
  const allNotes: NoteEvent[] = [];
  let trackCounter = 0;
  const trackHasMultipleChannels = new Map<number, number>();
  for (const part of parts.values()) {
    if (!part.notes.length) continue;
    trackHasMultipleChannels.set(part.trackIndex, (trackHasMultipleChannels.get(part.trackIndex) ?? 0) + 1);
  }
  for (const part of parts.values()) {
    if (!part.notes.length) continue;
    trackCounter++;
    const base = part.trackName?.trim() || `Track ${part.trackIndex + 1}`;
    const multiChannel = (trackHasMultipleChannels.get(part.trackIndex) ?? 0) > 1;
    const name = multiChannel ? `${base} (ch ${part.channel + 1})` : base;
    const id = `p${trackCounter}`;
    partInfos.push({ id, name });
    for (const note of part.notes) allNotes.push({ ...note, partId: id });
  }
  allNotes.sort((a, b) => a.startBeat - b.startBeat);

  const totalBeats = allNotes.reduce((max, n) => Math.max(max, n.startBeat + n.durationBeats), 0);
  const measures = buildMeasures(timeSigChanges, totalBeats);

  return {
    title: title?.trim() || 'Untitled',
    parts: partInfos,
    notes: allNotes,
    measures,
    slurs: [],
    totalBeats,
  };
}

function makeNote(pitch: number, open: OpenNote, endTick: number, ticksPerQuarter: number): NoteEvent {
  const startBeat = open.startTick / ticksPerQuarter;
  const durationBeats = Math.max(0, (endTick - open.startTick) / ticksPerQuarter);
  return {
    partId: '', // filled in once the part's final id is assigned
    midi: pitch,
    startBeat,
    durationBeats,
    lyric: open.lyric,
    measureNumber: 0, // recomputed below via buildMeasures; not used for MIDI-sourced rendering
  };
}

/** Builds a MeasureInfo list from time-signature changes (defaulting to 4/4 if the file has none). */
function buildMeasures(changes: TimeSigChange[], totalBeats: number): MeasureInfo[] {
  const sorted = [...changes].sort((a, b) => a.beat - b.beat);
  if (!sorted.length || sorted[0].beat > 0) sorted.unshift({ beat: 0, beats: 4, beatType: 4 });

  const measures: MeasureInfo[] = [];
  let cursor = 0;
  let number = 1;
  let changeIdx = 0;
  let current = sorted[0];
  const MAX_MEASURES = 20_000; // defensive cap against a pathological/corrupt file

  while (cursor < totalBeats && measures.length < MAX_MEASURES) {
    while (changeIdx + 1 < sorted.length && sorted[changeIdx + 1].beat <= cursor + 1e-9) {
      changeIdx++;
      current = sorted[changeIdx];
    }
    measures.push({ number, startBeat: cursor, beats: current.beats, beatType: current.beatType });
    cursor += current.beats * (4 / current.beatType);
    number++;
  }
  if (!measures.length) measures.push({ number: 1, startBeat: 0, beats: current.beats, beatType: current.beatType });
  return measures;
}
