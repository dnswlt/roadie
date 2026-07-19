// Small inline SVG icon set (stroke-based, lucide-style). Icons inherit
// the surrounding text color via stroke="currentColor".

function svg(inner: string, size = 16): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = inner;
  return el;
}

export const icons = {
  pencil: (size = 16) =>
    svg(
      `<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>`,
      size,
    ),
  trash: (size = 16) =>
    svg(
      `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>` +
        `<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>`,
      size,
    ),
  plus: (size = 16) => svg(`<path d="M12 5v14"/><path d="M5 12h14"/>`, size),
  flag: (size = 16) =>
    svg(`<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>`, size),
  dots: (size = 16) =>
    svg(
      `<circle cx="5" cy="12" r="0.8"/><circle cx="12" cy="12" r="0.8"/><circle cx="19" cy="12" r="0.8"/>`,
      size,
    ),
  grip: (size = 14) =>
    svg(
      `<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>` +
        `<circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>`,
      size,
    ),
  x: (size = 16) => svg(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, size),
  check: (size = 12) => svg(`<path d="M20 6 9 17l-5-5"/>`, size),
  zoomIn: (size = 16) =>
    svg(
      `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/><path d="M11 8v6"/>`,
      size,
    ),
  zoomOut: (size = 16) =>
    svg(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>`, size),
  eye: (size = 16) =>
    svg(
      `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
      size,
    ),
  eyeOff: (size = 16) =>
    svg(
      `<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/>` +
        `<path d="M6.61 6.61A13.5 13.5 0 0 0 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/>` +
        `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="m2 2 20 20"/>`,
      size,
    ),
};
