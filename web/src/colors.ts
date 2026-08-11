// Lane color themes, taken from Google Calendar's palette — Kobalt, Salbei,
// Kirschblüte, Banane, Amethyst — and tuned for black ink on the main bars.
// Tints and borders are derived in CSS via color-mix from this single strong
// value.
//
// These are the values Google *declares*, in sRGB. Never re-derive them by
// sampling pixels off the screen: macOS screenshots and Digital Colour Meter
// report Display P3 coordinates, so a reading pasted back in as sRGB comes out
// desaturated. That is not hypothetical — the previous set was exactly the P3
// rendering of these five (blue, green and orange matched to the integer),
// which is why the whole palette looked slightly washed out.
//
// Color is a signal here, not the lane's identity — the visible lane label
// always names the lane. So these are picked to look right and to separate
// comfortably at a glance, NOT to guarantee every pair survives every
// color-vision deficiency: red and green are knowingly close. Judge a new hex
// on how it looks and on what it has to sit next to, not against a distance
// threshold.
//
// The one hard constraint is coexistence: stay clear of the amber warning
// family (--flag, --notice), which is drawn *on top of* lane bars. A warm red
// made the flag read as lane-colored decoration rather than a warning, which
// is why red is rosy.

export const LANE_COLORS: Record<string, string> = {
  blue: "#668be1",
  green: "#55b080",
  red: "#d85675",
  orange: "#e7ba51",
  purple: "#a479b1",
};

export const LANE_COLOR_ORDER = ["blue", "green", "red", "orange", "purple"];

export function laneColorValue(name: string): string {
  return LANE_COLORS[name] ?? LANE_COLORS["blue"]!;
}
