// One inline SVG icon set, replacing the Unicode glyphs (▶ ■ ↻) the controls used before -- those
// render inconsistently across platforms and can even turn into colour emoji on iPhones.
const S = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  play: '<path d="M8.2 5.6v12.8a1 1 0 0 0 1.52.85l10.1-6.4a1 1 0 0 0 0-1.7l-10.1-6.4a1 1 0 0 0-1.52.85z" fill="currentColor"/>',
  pause: '<rect x="6.2" y="5" width="4.2" height="14" rx="1.3" fill="currentColor"/><rect x="13.6" y="5" width="4.2" height="14" rx="1.3" fill="currentColor"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor"/>',
  prev: `<path d="M6.5 6v12" ${S}/><path d="M18 6.9v10.2a.8.8 0 0 1-1.25.66l-7.6-5.1a.8.8 0 0 1 0-1.32l7.6-5.1A.8.8 0 0 1 18 6.9z" fill="currentColor"/>`,
  next: `<path d="M17.5 6v12" ${S}/><path d="M6 6.9v10.2a.8.8 0 0 0 1.25.66l7.6-5.1a.8.8 0 0 0 0-1.32l-7.6-5.1A.8.8 0 0 0 6 6.9z" fill="currentColor"/>`,
  loop: `<g ${S} stroke-width="1.8"><path d="M4.5 12V10a4 4 0 0 1 4-4h11"/><path d="M16.5 3l3 3-3 3"/><path d="M19.5 12v2a4 4 0 0 1-4 4h-11"/><path d="M7.5 21l-3-3 3-3"/></g>`,
  metronome: `<g ${S} stroke-width="1.8"><path d="M9.3 3.5h5.4l3.8 17H5.5z"/><path d="M12 16.5l5.2-8.6"/></g><circle cx="15.3" cy="11" r="1.3" fill="currentColor"/>`,
  back: `<path d="M14.5 5.5L8 12l6.5 6.5" ${S} stroke-width="2"/>`,
  more: '<g fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></g>',
  plus: `<path d="M12 5v14M5 12h14" ${S} stroke-width="2"/>`,
  minus: `<path d="M5 12h14" ${S} stroke-width="2"/>`,
  search: `<g ${S}><circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.6 15.6L20 20"/></g>`,
  mixer: `<g ${S} stroke-width="1.8"><path d="M6 4v16M12 4v16M18 4v16"/></g><g fill="currentColor"><rect x="3.6" y="12.6" width="4.8" height="3.4" rx="1.7"/><rect x="9.6" y="6.6" width="4.8" height="3.4" rx="1.7"/><rect x="15.6" y="14.6" width="4.8" height="3.4" rx="1.7"/></g>`,
  roll: '<g fill="currentColor"><rect x="3" y="5" width="9" height="3.4" rx="1.7"/><rect x="9" y="10.3" width="12" height="3.4" rx="1.7"/><rect x="4.5" y="15.6" width="8" height="3.4" rx="1.7"/></g>',
  sheet: '<g stroke="currentColor" stroke-width="1.2" opacity=".75"><path d="M2.5 6.5h19M2.5 9.5h19M2.5 12.5h19M2.5 15.5h19M2.5 18.5h19"/></g><ellipse cx="13" cy="15.6" rx="2.9" ry="2.2" transform="rotate(-22 13 15.6)" fill="currentColor"/><path d="M15.6 14.6V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  upload: `<g ${S}><path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/></g>`,
  user: `<g ${S} stroke-width="1.8"><circle cx="12" cy="8" r="3.7"/><path d="M4.8 20c.9-3.7 3.6-5.7 7.2-5.7s6.3 2 7.2 5.7"/></g>`,
  users: `<g ${S} stroke-width="1.8"><circle cx="9" cy="8.5" r="3.3"/><path d="M2.8 19.5c.8-3.3 3.1-5 6.2-5s5.4 1.7 6.2 5"/><circle cx="16.8" cy="7.2" r="2.7"/><path d="M16.3 12.6c2.9 0 4.8 1.6 5.4 4.7"/></g>`,
  chevronRight: `<path d="M9.5 5.5L16 12l-6.5 6.5" ${S} stroke-width="2"/>`,
  fitHeight: `<g ${S} stroke-width="1.8"><path d="M12 3.5v6M9.3 6.2L12 3.5l2.7 2.7M12 20.5v-6M9.3 17.8L12 20.5l2.7-2.7"/><path d="M4.5 12h15"/></g>`,
  chevronLeft: `<path d="M14.5 5.5L8 12l6.5 6.5" ${S} stroke-width="2"/>`,
  camera: `<g ${S} stroke-width="1.8"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.2h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.4"/></g>`,
  image: `<g ${S} stroke-width="1.8"><rect x="3.8" y="4.8" width="16.4" height="14.4" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.6-4.4 3.2 3 3.4-3.6 4 4.3"/></g>`,
  file: `<g ${S} stroke-width="1.8"><path d="M7 3.8h6.5L18 8.3v10.4a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 18.7V5.3A1.5 1.5 0 0 1 7 3.8z"/><path d="M13.3 4v4.5H18M8.5 13h7M8.5 16.2h5"/></g>`,
  chevronUp: `<path d="M5.5 15L12 8.5 18.5 15" ${S} stroke-width="2"/>`,
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" ${S} stroke-width="2"/>`,
  trash: `<g ${S} stroke-width="1.8"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/></g>`,
  pencil: `<g ${S} stroke-width="1.8"><path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5z"/><path d="M13.8 7.2l3 3"/></g>`,
  fork: `<g ${S} stroke-width="1.8"><path d="M8.5 3v7.5a3.5 3.5 0 0 0 7 0V3"/><path d="M12 14v7"/></g>`,
  crown: `<g ${S} stroke-width="1.8"><path d="M4 18h16M5 18l-1.5-10 5 4L12 5l3.5 7 5-4L19 18"/></g>`,
  quarter: '<ellipse cx="9.6" cy="17" rx="3.9" ry="2.9" transform="rotate(-22 9.6 17)" fill="currentColor"/><path d="M13.2 15.6V3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  zoomIn: `<g ${S} stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.6 15.6L20 20M8.3 10.8h5M10.8 8.3v5"/></g>`,
  zoomOut: `<g ${S} stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.6 15.6L20 20M8.3 10.8h5"/></g>`,
  save: `<g ${S} stroke-width="1.8"><path d="M5 4.5h11l3.5 3.5v11a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 6 4.5z"/><path d="M8 4.5v4.5h7V4.5M8 20v-5.5h8V20"/></g>`,
  flag: `<g ${S} stroke-width="1.8"><path d="M6 20.5V4.5M6 5h11l-2.5 4 2.5 4H6"/></g>`,
  swap: `<g ${S} stroke-width="1.8"><path d="M4.5 8.5h14M15 5l3.5 3.5L15 12M19.5 15.5h-14M9 12l-3.5 3.5L9 19"/></g>`,
  globe: `<g ${S} stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/></g>`,
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = 'ic'): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}
