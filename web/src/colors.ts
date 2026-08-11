// Lane color themes: one strong value per lane, from which CSS derives every
// tint, border and hover shade via color-mix.
//
// The set is muted and mid-toned — soft rather than primary, all at roughly one
// weight so no lane shouts over the others, and all light enough to carry dark
// ink (--ink) on the main bars. A cornflower blue, a pistachio green, a warm
// flamingo, a soft banana yellow and a dusty amethyst. Two of those are
// deliberate: the green is a true leaf green rather than the sage it replaced,
// which leaned teal and sat coldly beside the warm reds, and the red is a
// salmon rather than a rosy cherry, which crowded --today.
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
// separate against. These sit at oklab L 0.64..0.81.
//
// The map keys are persisted on lanes — "red" is a stored value, not a
// description of the hex. Retheme by changing the hex, never the key.

export const LANE_COLORS: Record<string, string> = {
  blue: "#668be1",
  green: "#85ad59",
  red: "#d6837a",
  orange: "#e7ba51",
  purple: "#a479b1",
};

export const LANE_COLOR_ORDER = ["blue", "green", "red", "orange", "purple"];

export function laneColorValue(name: string): string {
  return LANE_COLORS[name] ?? LANE_COLORS["blue"]!;
}
