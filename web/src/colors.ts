// Lane color themes. The hex values are CVD-validated as a categorical set
// (all-pairs check; red/green sits in the legal band because lane identity
// is always carried by the visible lane label as well). Tints and borders
// are derived in CSS via color-mix from the single strong value.

export const LANE_COLORS: Record<string, string> = {
  blue: "#2456b8",
  green: "#2e7d54",
  red: "#c93a4e",
  orange: "#b07d10",
  purple: "#8f6fe3",
};

export const LANE_COLOR_ORDER = ["blue", "green", "red", "orange", "purple"];

export function laneColorValue(name: string): string {
  return LANE_COLORS[name] ?? LANE_COLORS["blue"]!;
}
