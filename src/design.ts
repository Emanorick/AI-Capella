// Which look this device shows. The default is what the whole choir sees; a device can try another
// by opening the app with ?design=papier (or ?logo=2, ?roll=lantern), and keeps it until opened with
// the default again (?design=samt).
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
export const DESIGN: Design = deviceChoice('design', 'ai-capella-design', ['samt', 'papier'] as const, 'samt');
export const PAPER_DESIGN = DESIGN === 'papier';

/** The two drafts of the pen-written title animation (see artwork.ts animatePen). */
export type LogoDraft = '1' | '2';
export const LOGO_DRAFT: LogoDraft = deviceChoice('logo', 'ai-capella-logo', ['1', '2'] as const, '1');

document.documentElement.dataset.design = DESIGN;
