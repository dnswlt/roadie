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

// Below this rendered size a small outlined shape stops reading as a shape and
// becomes a blob, so glyphs built from tiny nodes fill them instead. See
// diagramMerge, the only icon that currently spans both regimes.
const NODE_FILL_PX = 15;

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
  // lock/globe are the private/public pair: a closed padlock and a wire globe.
  // They are always used as a pair so the two states read as one setting.
  lock: (size = 16) =>
    svg(
      `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
      size,
    ),
  globe: (size = 16) =>
    svg(
      `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>` +
        `<path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>`,
      size,
    ),
  house: (size = 16) =>
    svg(
      `<path d="M3 10.182 12 3l9 7.182"/>` +
        `<path d="M5 8.6V21h5v-6h4v6h5V8.6"/>`,
      size,
    ),
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
  chevronLeft: (size = 14) => svg(`<path d="m15 6-6 6 6 6"/>`, size),
  chevronRight: (size = 14) => svg(`<path d="m9 6 6 6-6 6"/>`, size),
  // Paired arrows moving away/together: expand all and collapse all.
  expandAll: (size = 16) =>
    svg(`<path d="m7 9 5-5 5 5"/><path d="m7 15 5 5 5-5"/>`, size),
  collapseAll: (size = 16) =>
    svg(`<path d="m7 4 5 5 5-5"/><path d="m7 20 5-5 5 5"/>`, size),
  copy: (size = 16) =>
    svg(
      `<rect x="9" y="9" width="12" height="12" rx="2"/>` +
        `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
      size,
    ),
  link: (size = 16) =>
    svg(
      `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>` +
        `<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
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
  // Two walls with arrows pushing outward: fit the span to the width.
  zoomFit: (size = 16) =>
    svg(
      `<path d="M4 5v14"/><path d="M20 5v14"/>` +
        `<path d="m10 9-3 3 3 3"/><path d="m14 9 3 3-3 3"/><path d="M7 12h10"/>`,
      size,
    ),
  eye: (size = 16) =>
    svg(
      `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
      size,
    ),
  history: (size = 16) =>
    svg(
      `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
      size,
    ),
  rotateCcw: (size = 16) =>
    svg(`<path d="M3 12a9 9 0 1 0 3-7.7L3 8"/><path d="M3 3v5h5"/>`, size),
  calendar: (size = 16) =>
    svg(
      `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>` +
        `<path d="M8 2v4"/><path d="M16 2v4"/>`,
      size,
    ),
  user: (size = 16) =>
    svg(`<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`, size),
  signOut: (size = 16) =>
    svg(
      `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>` +
        `<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
      size,
    ),
  help: (size = 16) =>
    svg(
      `<circle cx="12" cy="12" r="10"/>` +
        `<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>`,
      size,
    ),
  info: (size = 16) =>
    svg(`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`, size),
  eyeOff: (size = 16) =>
    svg(
      `<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/>` +
        `<path d="M6.61 6.61A13.5 13.5 0 0 0 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/>` +
        `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="m2 2 20 20"/>`,
      size,
    ),
  search: (size = 16) =>
    svg(`<circle cx="11" cy="11" r="7"/><path d="m20 20-4.35-4.35"/>`, size),
  milestone: (size = 16) => svg(`<path d="M12 3 21 12 12 21 3 12z"/>`, size),
  // The dependency glyph: three nodes converging, two on the left feeding one
  // on the right. The fan-*in* direction is deliberate — fanned the other way
  // this is the universal share glyph, a meaning nobody would unlearn.
  // Converging instead reads as a merge, which is what a prerequisite is.
  //
  // One shape, two weights, chosen by size rather than by the caller. Below
  // NODE_FILL_PX a stroked square closes up into a blob, so the nodes are
  // filled — that is the only reason the fill exists, and it costs weight: at
  // button size the same solid mark is visibly heavier than the stroked icons
  // beside it. So from there up the nodes are outlined like every other icon
  // in this set. The geometry never changes, so it stays one mark.
  diagramMerge: (size = 16) => {
    const node = size < NODE_FILL_PX ? ` fill="currentColor" stroke="none"` : "";
    return svg(
      `<rect x="1.5" y="2" width="6.5" height="6.5" rx="1.2"${node}/>` +
        `<rect x="1.5" y="15.5" width="6.5" height="6.5" rx="1.2"${node}/>` +
        `<rect x="16" y="8.75" width="6.5" height="6.5" rx="1.2"${node}/>` +
        `<path d="M8 5.25 16 12"/><path d="M8 18.75 16 12"/>`,
      size,
    );
  },
  // The two faces of the view toggle: offset horizontal bars for the
  // timeline, a nested outline for the WBS.
  ganttChart: (size = 16) =>
    svg(`<path d="M8 6h10"/><path d="M6 12h9"/><path d="M11 18h7"/>`, size),
  listTree: (size = 16) =>
    svg(
      `<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/>` +
        `<path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>`,
      size,
    ),
};
