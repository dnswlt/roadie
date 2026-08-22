import type { Dependency, DependencyRef } from "./types";

export interface DependencyPoint {
  x: number;
  y: number;
}

const ARROW_APPROACH = 16;
const ARROW_LENGTH = 10;

export interface DependencyPaths {
  body: string;
  arrow: string;
}

// Storage names the prerequisite first (`from`) and the dependent second
// (`to`). The timeline keeps that topological direction, matching the dialog
// and the convention used by Gantt tools.
export function timelineEdgeRefs(
  dependency: Dependency,
): { start: DependencyRef; target: DependencyRef } {
  return { start: dependency.from, target: dependency.to };
}

// dependencyPaths connects two finish points. Its final straight run keeps the
// arrowhead perpendicular to the bar edge; a Bézier tangent alone only becomes
// horizontal at the exact endpoint, so the body of the marker can still look
// skewed on a steep curve. Routing between the dates, rather than around the
// rightmost one, keeps the relation visible beside the edit rail.
export function dependencyPaths(from: DependencyPoint, to: DependencyPoint): DependencyPaths {
  const dx = to.x - from.x;
  const direction = dx < 0 ? -1 : 1;
  const bend = Math.max(32, Math.abs(dx) * 0.42);
  const approachX = to.x - direction * ARROW_APPROACH;
  const arrowBaseX = to.x - direction * ARROW_LENGTH;
  return {
    body: `M ${from.x} ${from.y} C ${from.x + direction * bend} ${from.y}, ${to.x - direction * bend} ${to.y}, ${approachX} ${to.y} L ${arrowBaseX} ${to.y}`,
    arrow: `M ${arrowBaseX} ${to.y} L ${to.x} ${to.y}`,
  };
}
