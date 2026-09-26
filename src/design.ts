// Which look this device shows. The default is what the whole choir sees; a device can switch to
// another by opening the app with ?design=samt (or ?logo=1, ?roll=gel), and keeps it until opened
// with the default again (?design=papier).
//
// 'samt': velvet ground with slow waves, glass panels, gel notes ("Samt & Glas").
// 'papier': night paper everywhere, vellum overlays, embossed buttons, the punched roll lit from
//           behind, and the title screen's voice lines written by a pen ("Papier & Feder").

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

export type Design = 'samt' | 'papier';
export const DESIGN: Design = deviceChoice('design', 'ai-capella-design', ['samt', 'papier'] as const, 'papier');
export const PAPER_DESIGN = DESIGN === 'papier';

/** The two drafts of the pen-written title animation (see artwork.ts drawPenRibbons); '2' was chosen. */
export type LogoDraft = '1' | '2';
export const LOGO_DRAFT: LogoDraft = deviceChoice('logo', 'ai-capella-logo', ['1', '2'] as const, '2');

/**
 * Draft of the next title screen (?start=neu): the voice lines as figures of light with a soft glow,
 * giving way to the pointer and drawn toward a click; the name and buttons printed and embossed in
 * the paper.
 */
export const START_DRAFT = PAPER_DESIGN && deviceChoice('start', 'ai-capella-start', ['neu', 'heute'] as const, 'heute') === 'neu';

document.documentElement.dataset.design = DESIGN;
if (START_DRAFT) document.documentElement.dataset.start = 'neu';
