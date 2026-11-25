// A state's glyph beside its word (spec 28.4), drawn as the canvas draws it so the legend and the
// clones agree: colour from the state's class, shape from the state itself; decorative, since
// the word is always there too.

import type { State } from './lod.canvas.ts';

export function StateGlyph({ state, className }: { state: State; className?: string | undefined }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {state === 'normal' && <circle cx="8" cy="8" r="6" fill="currentColor" />}
      {state === 'warning' && <path d="M8 1.5 L14.5 13.5 H1.5 Z" fill="currentColor" />}
      {state === 'failed' && <g><rect x="2" y="2" width="12" height="12" fill="currentColor" /><path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" stroke="var(--surface-raised)" strokeWidth="1.8" /></g>}
      {state === 'unknown' && <g><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><text x="8" y="11.5" fontSize="9" fontWeight="700" textAnchor="middle" fill="currentColor">?</text></g>}
      {state === 'stale' && <g><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 8 V4 M8 8 L11 9" stroke="currentColor" strokeWidth="1.6" /></g>}
    </svg>
  );
}
