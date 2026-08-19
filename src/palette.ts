// Stable, colorblind-friendlier-ish palette for up to 8 voice parts (S1/S2/A1/A2/T1/T2/B1/B2).
const PALETTE = [
  '#ff6a88', // Soprano 1
  '#ff9f6a', // Soprano 2
  '#ffd166', // Alto 1
  '#a0d468', // Alto 2
  '#4fd6c4', // Tenor 1
  '#4fa8ff', // Tenor 2
  '#9b7bff', // Bass 1
  '#d17bff', // Bass 2
];

export function colorForPartIndex(index: number): string {
  if (index < PALETTE.length) return PALETTE[index];
  const hue = (index * 47) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}
