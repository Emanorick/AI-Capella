// The sheet music as a PDF: the song's own MusicXML, engraved by Verovio (verovio.org, LGPL) as A4
// pages in the key it plays in now, with the voices chosen (all, unless some are left out) under the
// names chosen, and drawn into a vector PDF by jsPDF + svg2pdf.js. Everything here is loaded only
// when a PDF is asked for: the engraver alone is some 7 MB.
//
// Verovio draws the music itself as paths; only text is text: the lyrics and words in Times (set
// here in Liberation Serif, Times' metric twin, embedded so any language's letters come out) and
// the odd music symbol inside text -- the note of a metronome mark -- in a music font (a small
// subset of Bravura, embedded as "LightScore Music Text").

import liberationRegular from './assets/fonts/pdf/LiberationSerif-Regular.ttf?url';
import liberationItalic from './assets/fonts/pdf/LiberationSerif-Italic.ttf?url';
import liberationBold from './assets/fonts/pdf/LiberationSerif-Bold.ttf?url';
import liberationBoldItalic from './assets/fonts/pdf/LiberationSerif-BoldItalic.ttf?url';
import musicText from './assets/fonts/pdf/MusicText.ttf?url';

export interface PdfVoice {
  id: string; // the MusicXML part id
  name: string;
  include: boolean;
  /** The clef chosen for it in the app, when it differs from the file's. */
  clef?: { sign: string; line?: number; octaveChange?: number };
}

export interface PdfRequest {
  xml: string;
  title: string;
  semitones: number; // the transposition playing now
  voices: PdfVoice[];
}

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

/** The MusicXML with only the chosen voices, under their chosen names, and the song's title. */
export function prepareXml(req: PdfRequest): string {
  const doc = new DOMParser().parseFromString(req.xml, 'application/xml');
  const byId = new Map(req.voices.map((v) => [v.id, v]));
  for (const sp of Array.from(doc.querySelectorAll('part-list > score-part'))) {
    const voice = byId.get(sp.getAttribute('id') || '');
    if (voice && !voice.include) {
      sp.remove();
      continue;
    }
    if (!voice) continue;
    let name = sp.querySelector(':scope > part-name');
    if (!name) {
      name = doc.createElement('part-name');
      sp.prepend(name);
    }
    name.textContent = voice.name;
    // The short name on later systems: the same, so a renamed voice isn't shown by its old one there.
    sp.querySelector(':scope > part-abbreviation')?.remove();
    sp.querySelector(':scope > part-name-display')?.remove();
    sp.querySelector(':scope > part-abbreviation-display')?.remove();
  }
  for (const part of Array.from(doc.querySelectorAll('score-partwise > part'))) {
    const voice = byId.get(part.getAttribute('id') || '');
    if (voice && !voice.include) {
      part.remove();
      continue;
    }
    // A clef chosen in the app, throughout the voice.
    if (voice?.clef) {
      for (const clef of Array.from(part.querySelectorAll('attributes > clef'))) {
        const fresh = doc.createElement('clef');
        const number = clef.getAttribute('number');
        if (number) fresh.setAttribute('number', number);
        const sign = doc.createElement('sign');
        sign.textContent = voice.clef.sign;
        fresh.append(sign);
        if (voice.clef.line != null) {
          const line = doc.createElement('line');
          line.textContent = String(voice.clef.line);
          fresh.append(line);
        }
        if (voice.clef.octaveChange) {
          const oc = doc.createElement('clef-octave-change');
          oc.textContent = String(voice.clef.octaveChange);
          fresh.append(oc);
        }
        clef.replaceWith(fresh);
      }
    }
  }
  // The title as the repertoire shows it (it may have been renamed there).
  const root = doc.documentElement;
  let movement = root.querySelector(':scope > movement-title');
  const fileTitle = movement?.textContent?.trim() || root.querySelector(':scope > work > work-title')?.textContent?.trim() || '';
  if (!movement) {
    movement = doc.createElement('movement-title');
    const work = root.querySelector(':scope > work');
    if (work) work.after(movement);
    else root.prepend(movement);
  }
  movement.textContent = req.title;
  root.querySelector(':scope > work > work-title')?.replaceChildren(doc.createTextNode(req.title));
  if (fileTitle && fileTitle !== req.title) {
    for (const words of Array.from(doc.querySelectorAll('credit > credit-words'))) {
      if (words.textContent?.trim() === fileTitle) words.textContent = req.title;
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

// The interval Verovio transposes by: the key the app plays in (see signatures.ts transposeFifths
// -- the same spelling), reached by the interval that moves the key signature that far.
const UP: Record<number, [string, number]> = {
  0: ['P1', 0], 1: ['P5', 7], [-1]: ['P4', 5], 2: ['M2', 2], [-2]: ['m7', 10], 3: ['M6', 9], [-3]: ['m3', 3],
  4: ['M3', 4], [-4]: ['m6', 8], 5: ['M7', 11], [-5]: ['m2', 1], 6: ['A4', 6], [-6]: ['d5', 6],
};
export function transposeInterval(semitones: number): string {
  if (!semitones) return '';
  const r = (((semitones * 7) % 12) + 12) % 12;
  const fifths = r > 6 ? r - 12 : r;
  const octaves = Math.floor((Math.abs(semitones) - 1) / 12);
  const [name] = semitones > 0 ? UP[fifths] : UP[-fifths];
  const quality = name[0];
  const number = Number(name.slice(1)) + 7 * octaves;
  return `${semitones < 0 ? '-' : ''}${quality}${number}`;
}

/**
 * Verovio draws a page as an inner <svg> scaling its tenth-of-a-millimetre units to the page, with
 * no size of its own; svg2pdf doesn't size such a nested svg to its parent. A group doing the same
 * scaling draws the same.
 */
function flattenInnerSvg(root: SVGSVGElement): SVGGElement | null {
  const inner = root.querySelector<SVGSVGElement>(':scope > svg');
  const outerBox = root.viewBox.baseVal;
  const innerBox = inner?.viewBox.baseVal;
  if (!inner || !innerBox?.width || !outerBox?.width) return null;
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', `scale(${outerBox.width / innerBox.width} ${outerBox.height / innerBox.height}) translate(${-innerBox.x} ${-innerBox.y})`);
  for (const attr of Array.from(inner.attributes)) {
    if (!['viewBox', 'class', 'width', 'height', 'x', 'y'].includes(attr.name)) g.setAttribute(attr.name, attr.value);
  }
  g.append(...Array.from(inner.childNodes));
  inner.replaceWith(g);
  return g;
}

/**
 * A bar wider than a line (a dense bar under long lyrics or many directions) runs past the page's
 * right edge in Verovio's layout; the page is then drawn a little smaller, so nothing is cut off.
 */
function fitToWidth(root: SVGSVGElement, drawing: SVGGElement) {
  const width = root.viewBox.baseVal.width;
  const page = root.getBoundingClientRect();
  if (!page.width) return;
  const right = ((drawing.getBoundingClientRect().right - page.left) * width) / page.width;
  const edge = width * 0.985;
  if (!(right > edge)) return;
  drawing.setAttribute('transform', `scale(${edge / right}) ${drawing.getAttribute('transform') ?? ''}`);
}

async function fontBase64(url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Engraves the request and returns the PDF; `progress` hears what's happening. */
export async function makePdf(req: PdfRequest, progress: (step: 'engraver' | 'engraving' | 'pages', page?: number, pages?: number) => void = () => {}): Promise<Blob> {
  progress('engraver');
  const [{ default: createVerovioModule }, { VerovioToolkit }, { jsPDF }] = await Promise.all([
    import('verovio/wasm'),
    import('verovio/esm'),
    import('jspdf'),
  ]);
  await import('svg2pdf.js');
  const toolkit = new VerovioToolkit(await createVerovioModule());

  progress('engraving');
  toolkit.setOptions({
    // A4 in tenths of a millimetre, the music at 42 % of Verovio's full size: a choir score's
    // staves and lyrics at a comfortable reading size.
    pageWidth: 2100,
    pageHeight: 2970,
    scale: 42,
    pageMarginTop: 120,
    pageMarginBottom: 120,
    pageMarginLeft: 120,
    pageMarginRight: 120,
    adjustPageHeight: false,
    breaks: 'auto',
    header: 'auto',
    footer: 'none',
    font: 'Bravura',
    transpose: transposeInterval(req.semitones),
    lyricSize: 4.2,
    svgViewBox: true,
  });
  if (!toolkit.loadData(prepareXml(req))) throw new Error('The engraver could not read this score.');
  const pages = toolkit.getPageCount();

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const fonts: [string, string, string][] = [
    [liberationRegular, 'LiberationSerif', 'normal'],
    [liberationItalic, 'LiberationSerif', 'italic'],
    [liberationBold, 'LiberationSerif', 'bold'],
    [liberationBoldItalic, 'LiberationSerif', 'bolditalic'],
    [musicText, 'LightScoreMusicText', 'normal'],
  ];
  await Promise.all(
    fonts.map(async ([url, family, style]) => {
      const file = `${family}-${style}.ttf`;
      pdf.addFileToVFS(file, await fontBase64(url));
      pdf.addFont(file, family, style);
    }),
  );
  pdf.setProperties({ title: req.title, creator: 'LightScore' });

  // svg2pdf measures text through the page, so each page's drawing is put in for that moment.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:840px;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  try {
    for (let page = 1; page <= pages; page++) {
      progress('pages', page, pages);
      const svgText = toolkit
        .renderToSVG(page)
        .replace(/font-family="Times, serif"/g, 'font-family="LiberationSerif"')
        .replace(/font-family="(Bravura|Leipzig)"/g, 'font-family="LightScoreMusicText"');
      host.innerHTML = svgText;
      const svg = host.querySelector('svg')!;
      const drawing = flattenInnerSvg(svg);
      if (drawing) fitToWidth(svg, drawing);
      if (page > 1) pdf.addPage('a4', 'portrait');
      await pdf.svg(svg, { x: 0, y: 0, width: PAGE_W_MM, height: PAGE_H_MM });
      // Let the page breathe between pages (a long piece is many).
      await new Promise((r) => setTimeout(r, 0));
    }
    // Page numbers, from the second page on, small at the foot.
    pdf.setFont('LiberationSerif', 'normal');
    pdf.setFontSize(9);
    for (let page = 2; page <= pages; page++) {
      pdf.setPage(page);
      pdf.text(String(page), PAGE_W_MM / 2, PAGE_H_MM - 7, { align: 'center' });
    }
  } finally {
    host.remove();
  }
  return pdf.output('blob');
}
