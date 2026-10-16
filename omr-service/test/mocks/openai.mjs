// Stand-in for the OpenAI Responses API in local tests, for all three GPT steps of a scan:
// - reading a page (omr_page_transcription): Evening Rise, bars 1-4 on page 1, 5-8 on page 2 --
//   with two misreadings: the soprano's first note a D4 instead of E4, and bar 6 of the bass in
//   notes that can't be read;
// - the second run (omr_page_review): puts back whatever differs from the real Evening Rise, also
//   proposes a correction that doesn't fill its bar (it must be refused), asks one question per
//   page and leaves one doubt on page 2;
// - a typed answer (omr_answer): makes the first note a D5, unless the answer says "unklar".
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { compactPage, parseXml } from '../../dist/score.js';

export const calls = [];

const truth = compactPage(parseXml(readFileSync(new URL('../../../public/evening-rise.musicxml', import.meta.url), 'utf8')), [0, 1, 2, 3, 4, 5, 6, 7]).measures;
const PAGES = [[1, 2, 3, 4], [5, 6, 7, 8]];
const PARTS = [
  { id: 'P1', name: 'Sopran', staves: 1, clefs: ['G2'] },
  { id: 'P2', name: 'Melodie', staves: 1, clefs: ['G2'] },
  { id: 'P3', name: 'Alt 1', staves: 1, clefs: ['G2'] },
  { id: 'P4', name: 'Alt 2', staves: 1, clefs: ['G2'] },
  { id: 'P5', name: 'Tenor', staves: 1, clefs: ['G2-8'] },
  { id: 'P6', name: 'Bass', staves: 1, clefs: ['F4'] },
];
// Where the bars stand: as on an A4 page of Evening Rise engraved by Verovio (two systems of four
// bars), page 1 being its first system, page 2 its second -- so a trial with that page as both
// photos shows the right excerpts.
const row = (top, step) => PARTS.map((p, i) => ({ part: p.id, top: top + i * step, bottom: top + (i + 1) * step }));
const SYSTEMS = [{ top: 0.05, bottom: 0.43, parts: [] }, { top: 0.44, bottom: 0.83, parts: [] }];
const BARLINES = [[0.105, 0.383, 0.552, 0.765, 0.942], [0.105, 0.383, 0.605, 0.806, 0.942]];
const firstPitchTo = (voices, pitch) => {
  const out = structuredClone(voices);
  const i = out[0].notes.findIndex((n) => !n.startsWith('r '));
  out[0].notes[i] = out[0].notes[i].replace(/^[A-G](#|b)*\d/, pitch);
  return out;
};

function transcription(context) {
  const page = Number(context.match(/page (\d+) of/)[1]) - 1;
  const ms = PAGES[page] ?? [];
  return {
    parts: page === 0 ? PARTS : [],
    systems: [{ ...SYSTEMS[page], parts: row(page ? 0.442 : 0.054, page ? 0.0616 : 0.0605) }],
    measures: ms.map((m, i) => ({
      number: i === 0 ? String(m) : '',
      system: 1,
      left: BARLINES[page][i],
      right: BARLINES[page][i + 1],
      time: m === 1 ? '4/4' : '',
      keyPrinted: i === 0,
      key: 1,
      barStart: 'none',
      barEnd: m === 8 ? 'final' : 'normal',
      repeatTimes: 0,
      endingNumbers: '',
      endingStart: false,
      endingStop: false,
      marks: m === 1 ? [{ kind: 'rehearsal', text: 'A', part: '', bpm: 0 }, { kind: 'tempo', text: 'Ruhig', part: '', bpm: 72 }] : [],
      parts: Object.entries(truth[m - 1].parts).map(([part, voices]) => ({
        part,
        voices: m === 1 && part === 'P1' ? firstPitchTo(voices, 'D4') : m === 6 && part === 'P6' ? [{ v: 1, staff: 1, notes: ['Q3 4'] }] : voices,
      })),
    })),
    stackedVerses: [],
    doubts: page === 0 ? [{ measure: 2, part: 'P5', note: 'Tenor: Vorzeichen unklar' }] : [],
    title: page === 0 ? 'Evening Rise' : '',
    confidence: 'medium',
  };
}

function review(payload) {
  const { measures } = payload;
  const first = measures[0];
  const corrections = [];
  for (const m of measures) {
    for (const [part, voices] of Object.entries(m.parts)) {
      const right = truth[m.m - 1].parts[part];
      if (JSON.stringify(voices) !== JSON.stringify(right)) corrections.push({ part, m: m.m, reason: 'falsch gelesen', voices: right });
    }
  }
  corrections.push({ part: 'P1', m: first.m + 1, reason: 'kaputt', voices: [{ v: 1, staff: 1, notes: ['C5 1'] }] });
  const asked = measures[2];
  return {
    corrections,
    barlines: [],
    marks: first.m === 5 ? [{ m: 5, kind: 'rehearsal', text: 'B', part: '', bpm: 0 }] : [],
    questions: [
      {
        part: 'P2',
        m: asked.m,
        question: 'Melodie: ist der erste Ton ein H oder ein C?',
        options: [
          { label: 'H, wie gelesen', voices: asked.parts.P2 },
          { label: 'C', voices: firstPitchTo(asked.parts.P2, 'C5') },
        ],
      },
    ],
    doubts: first.m === 5 ? [{ part: 'P3', m: 7, note: 'Alt 1: Rhythmus unsicher' }] : [],
    partNames: [],
    title: first.m === 1 ? 'Evening Rise' : '',
    confidence: 'high',
    remarks: '',
  };
}

function answer(payload) {
  if (/unklar/.test(payload.answer)) return { understood: false, voices: [], note: '' };
  return { understood: true, voices: firstPitchTo(payload.current, 'D5'), note: 'Erster Ton auf D geändert' };
}

export function startFakeOpenAI(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const request = JSON.parse(body);
        const content = request.input[0].content;
        const text = content.find((c) => c.type === 'input_text').text;
        const hasImage = content.some((c) => c.type === 'input_image' && /^data:image\/(jpeg|png);base64,/.test(c.image_url));
        const schema = request.text?.format?.name;
        let out;
        if (schema === 'omr_page_transcription') {
          out = transcription(text);
          calls.push({ schema, model: request.model, hasImage, page: Number(text.match(/page (\d+) of/)[1]) });
        } else if (schema === 'omr_page_review') {
          const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
          out = review(payload);
          calls.push({ schema, model: request.model, hasImage, measures: payload.measures.map((m) => m.m), lookAt: payload.lookAt });
        } else {
          const payload = JSON.parse(text);
          out = answer(payload);
          calls.push({ schema, model: request.model, hasImage, payload });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_test', object: 'response', created_at: 0, status: 'completed', model: request.model,
          output: [{ type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(out), annotations: [] }] }],
        }));
      });
    });
    server.listen(port, () => resolve(server));
  });
}
