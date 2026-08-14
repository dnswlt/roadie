// Lane color themes: one strong value per lane, from which CSS derives every
// tint, border and hover shade via color-mix.
//
// The set is muted and mid-toned — soft rather than primary, all at roughly one
// weight so no lane shouts over the others. A cornflower blue, a pistachio
// green, a warm flamingo, a soft banana yellow, a light amethyst, and a birch
// greige. Keep the red off --today, the one thing it sits near.
//
// Every lane clears 7.0 against --ink: bar titles are read as dark ink on these
// fills all day. Retune by lifting OKLCH lightness alone — hue and chroma held —
// to the least that clears it, which is why five sit within 0.02 L of each other.
//
// The gray earns its slot by *not* being a hue — it reads as unassigned or
// supporting work — and is warm rather than neutral, because a true gray fights
// this set. Its weak spot is derived, not direct: .child-bar mixes it to a pale
// neutral sitting nearer --border than any other lane's tint.
//
// These are sRGB. Never re-derive one by sampling pixels off the screen: macOS
// screenshots and Digital Colour Meter report Display P3 coordinates, so a
// reading pasted back in as sRGB comes out desaturated. That is not
// hypothetical — an earlier set was exactly the P3 rendering of this one, which
// is why the whole palette looked slightly washed out.
//
// Color is a signal here, not the lane's identity — the visible lane label
// always names the lane. So these are picked to look right and to separate
// comfortably at a glance, NOT to guarantee every pair survives every
// color-vision deficiency: blue/purple are knowingly the closest pair. Judge a
// new hex on how it looks and on what it has to sit next to, not against a
// distance threshold.
//
// The thing to watch is coexistence with --flag, drawn *on top of* these. It
// is a bright amber fill plus a white ring (see styles.css), and the ring is
// what lets it survive a lane of any hue — so a new lane does not have to dodge
// amber. What would break it is a near-white lane, leaving the ring nothing to
// separate against. These sit at oklab L 0.70..0.81: the ring has 2.6:1 against
// them, and 1.8:1 against orange, the closest case.
//
// The map keys are persisted on lanes — "red" is a stored value, not a
// description of the hex. Retheme by changing the hex, never the key.

export const LANE_COLORS: Record<string, string> = {
  blue: "#779df5",
  green: "#85ad59",
  red: "#dc897f",
  orange: "#e7ba51",
  purple: "#bc90c9",
  gray: "#aa9d90",
};

export const LANE_COLOR_ORDER = ["blue", "green", "red", "orange", "purple", "gray"];

export function laneColorValue(name: string): string {
  return LANE_COLORS[name] ?? LANE_COLORS["blue"]!;
}
