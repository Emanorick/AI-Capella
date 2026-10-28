// Which look this device shows. The default is what the whole choir sees; a device can switch to
// another by opening the app with ?design=samt (or ?logo=1, ?roll=gel), and keeps it until opened
// with the default again (?design=papier).
//
// 'samt': velvet ground with slow waves, glass panels, gel notes ("Samt & Glas").
// 'papier': night paper everywhere, vellum overlays, embossed buttons, the punched roll lit from
//           behind, and the title screen's voice lines written by a pen ("Papier & Feder").
// 'pergament': the same paper design on parchment, a light ground (test: ?design=pergament): text
//           in iron-gall ink, the voices in coloured inks, gold leaf where the night paper has gold;
//           the lamp behind the parchment makes it glow amber at the reading line, and the inks
//           there shine like stained glass ("Pergament & Tinte").

/**
 * A choice from the address (?param=value), remembered on this device; asking for the default
 * forgets it again. Falls back to the default wherever storage is unavailable.
 */
export function deviceChoice<T extends string>(param: string, key: string, values: readonly T[], fallback: T): T {
  const valid = (v: string | null): v is T => v !== null && (values as readonly string[]).includes(v);
  try {
    const asked = new URLSearchParams(location.search).get(param);
    if (asked === fallback) localStorage.removeItem(key);
    else if (valid(asked)) localStorage.setItem(key, asked);
    const stored = localStorage.getItem(key);
    return valid(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export type Design = 'samt' | 'papier' | 'pergament';
export const DESIGN: Design = deviceChoice('design', 'ai-capella-design', ['samt', 'papier', 'pergament'] as const, 'papier');
/** Parchment: the paper design on a light ground (everything of the paper design holds, in light). */
export const PARCHMENT = DESIGN === 'pergament';
export const PAPER_DESIGN = DESIGN === 'papier' || PARCHMENT;

/** The two drafts of the pen-written title animation (see artwork.ts drawPenRibbons); '2' was chosen. */
export type LogoDraft = '1' | '2';
export const LOGO_DRAFT: LogoDraft = deviceChoice('logo', 'ai-capella-logo', ['1', '2'] as const, '2');

/**
 * The title screen of the paper design (default; ?start=heute brings back the earlier one): the
 * voice lines as figures of light drawn toward a click, the name written in ink floating over the
 * paper, the choices embossed paper tabs.
 */
const START_CHOICE = PAPER_DESIGN ? deviceChoice('start', 'ai-capella-start', ['neu', 'heute', 'zeile', 'buehne'] as const, 'neu') : 'heute';
export const START_DRAFT = START_CHOICE !== 'heute';
/**
 * Draft (?start=zeile): "Die erste Zeile" -- instead of the swaying voice lines, a staff ruled across
 * the paper, "Score" set into it, "Light" written across it by the pen of light with the reading
 * line following, the five lines taking on the voices' colours (titleStaff.ts).
 */
export const START_STAFF = START_CHOICE === 'zeile';
/**
 * Draft (?start=buehne): "Die Bühne" -- black paper, "Score" alone in the dark until a spotlight
 * comes on and "Light" lights up in it, dust in the beam, the staff and the voices lit after
 * (titleStage.ts).
 */
export const START_STAGE = START_CHOICE === 'buehne';

/**
 * Test (?schrift=test; ?schrift=heute goes back): the faces from Font Revival (assets/fonts/revival)
 * -- headings in Baltimore Title, song titles in Modern Antique, rehearsal letters in Baltimore
 * Bold, text and controls in Remington, the "Score" of the name in Baltimore Black Slope
 * (typeTest.css). The fonts are only fetched on a device that has it on.
 */
export const TYPE_TEST = deviceChoice('schrift', 'ai-capella-schrift', ['heute', 'test'] as const, 'heute') === 'test';

document.documentElement.dataset.design = PAPER_DESIGN ? 'papier' : DESIGN;
if (PARCHMENT) {
  document.documentElement.dataset.ground = 'pergament';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#E8D9B8');
}
if (TYPE_TEST) document.documentElement.dataset.schrift = 'test';
if (START_DRAFT) document.documentElement.dataset.start = 'neu';
if (START_STAFF) document.documentElement.dataset.title = 'zeile';
if (START_STAGE) document.documentElement.dataset.title = 'buehne';
