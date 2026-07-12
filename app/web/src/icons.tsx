// Component-kind icons as inline SVG. Pure presentation, shared by the palette rail, the inspector and the
// canvas nodes — extracted from app.tsx so those all read one icon set. `I` builds a single-path glyph.

const I = (p: string): JSX.Element => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><path d={p} /></svg>);

const ICONS: Record<string, JSX.Element> = {
  client: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>),
  compute: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><circle cx="7" cy="7.5" r="0.9" /><circle cx="7" cy="16.5" r="0.9" /></svg>),
  db: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>),
  cache: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h5M7 13h8" /></svg>),
  storage: I('M4 7l8-4 8 4v10l-8 4-8-4z'),
  proxy: I('M3 12h4l3-7 4 14 3-7h4'),
  lb: I('M3 12h4l3-7 4 14 3-7h4'),
  apigw: I('M3 12h4l3-7 4 14 3-7h4'),
  gateway: I('M3 12h4l3-7 4 14 3-7h4'),
  cdn: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>),
  queue: I('M4 7h16M4 12h16M4 17h16'),
  stream: I('M4 7h16M4 12h16M4 17h16'),
  search: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>),
  ai: I('M13 2L4 14h7l-1 8 9-12h-7z'),
  security: I('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'),
};

/** The icon for a component kind, with a generic box fallback for an unknown kind. */
export const iconFor = (kind: string): JSX.Element => ICONS[kind] ?? I('M4 5h16v14H4z');
