import { PARCHMENT } from './design';

// "Dusk" voice spectrum, warm to cool: high voices get the warm end, low voices the cool end, so a
// singer can find their part by colour temperature. Order matches S1/S2/A1/A2/T1/T2/B1/B2.
const DUSK = ['#F4879B', '#F6A77A', '#EDC96B', '#A9D38A', '#6FD3BE', '#72B7F2', '#9A9CF5', '#C891EE'];
// On parchment the same spectrum as inks: carmine, vermilion, ochre, sap green, viridian, cobalt,
// indigo, violet -- dark enough to read on the light ground, the order and temperatures kept.
const INKS = ['#B8384F', '#BF5A26', '#9C7414', '#5A8A2A', '#1E7F70', '#2D69AE', '#4E4EB4', '#8445A6'];
export const VOICE_SPECTRUM = PARCHMENT ? INKS : DUSK;

/**
 * Colour for voice `index` of `count` voices. Colours are spread across the whole spectrum rather
 * than handed out in list order, so a four-voice SATB song gets rose/honey/sky/orchid (maximally
 * distinct neighbours, bass always the coolest) instead of the first four warm-ish entries.
 */
export function colorForPart(index: number, count: number): string {
  const n = Math.max(1, count);
  if (n <= VOICE_SPECTRUM.length) {
    const slot = n === 1 ? 0 : Math.round((index * (VOICE_SPECTRUM.length - 1)) / (n - 1));
    return VOICE_SPECTRUM[slot];
  }
  const hue = (index * 47) % 360;
  return PARCHMENT ? `hsl(${hue}, 60%, 38%)` : `hsl(${hue}, 70%, 72%)`;
}
