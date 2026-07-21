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
  tag: (size = 16) =>
    svg(
      `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414` +
        `l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>` +
        `<circle cx="7.5" cy="7.5" r="1.2"/>`,
      size,
    ),
  externalLink: (size = 16) =>
    svg(
      `<path d="M15 3h6v6"/><path d="M10 14 21 3"/>` +
        `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6"/>`,
      size,
    ),
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
  download: (size = 16) =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>` +
        `<path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>`,
      size,
    ),
  upload: (size = 16) =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>` +
        `<path d="M7 8l5-5 5 5"/><path d="M12 3v12"/>`,
      size,
    ),
  chevronDown: (size = 14) => svg(`<path d="m6 9 6 6 6-6"/>`, size),
  copy: (size = 16) =>
    svg(
      `<rect x="9" y="9" width="12" height="12" rx="2"/>` +
        `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
      size,
    ),
  x: (size = 16) => svg(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, size),
  check: (size = 12) => svg(`<path d="M20 6 9 17l-5-5"/>`, size),
  magnet: (size = 16) =>
    svg(
      `<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/>` +
        `<path d="m5 8 4 4"/><path d="m12 15 4 4"/>`,
      size,
    ),
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
