// Lane color themes: the "Soft" palette (Option B in
// docs/color_recommendations.html), tuned for black ink on the main bars.
// The hex values are CVD-validated as a categorical set (all-pairs check;
// red/green sits in the legal band because lane identity is always carried
// by the visible lane label as well). Tints and borders are derived in CSS
// via color-mix from the single strong value.
//
// The red lane is deliberately rosy rather than warm: it has to stay clear of
// the amber warning family (--flag, --notice), which is drawn *on top of* lane
// bars. A warmer red reads as a lane-colored decoration instead of a warning —
// under tritanopia the two became indistinguishable.

export const LANE_COLORS: Record<string, string> = {
  blue: "#6e8adb",
  green: "#6dae84",
  red: "#c95f76",
  orange: "#e0bc63",
  purple: "#9e7bae",
};

export const LANE_COLOR_ORDER = ["blue", "green", "red", "orange", "purple"];

export function laneColorValue(name: string): string {
  return LANE_COLORS[name] ?? LANE_COLORS["blue"]!;
}
