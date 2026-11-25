// Where a floating element (a tooltip, menu or popover) goes beside the element it belongs to:
// on the side asked for, flipped to the other side when it does not fit, and kept inside the
// viewport. Floating elements live in the browser's top layer (the Popover API), so no
// container's overflow clips them; their place is set through the CSSOM, which the CSP allows,
// never as a style attribute, which it does not.

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

export interface Box { top: number; left: number; width: number; height: number }

const GAP = 6;
const MARGIN = 8;

/** The top-left corner for a floating box of this size, pure so it is tested without a browser. */
export function placement(anchor: Box, floating: { width: number; height: number }, viewport: { width: number; height: number },
  side: Side, align: Align): { top: number; left: number; side: Side } {
  const fits = (s: Side): boolean => {
    switch (s) {
      case 'bottom': return anchor.top + anchor.height + GAP + floating.height <= viewport.height - MARGIN;
      case 'top': return anchor.top - GAP - floating.height >= MARGIN;
      case 'right': return anchor.left + anchor.width + GAP + floating.width <= viewport.width - MARGIN;
      case 'left': return anchor.left - GAP - floating.width >= MARGIN;
    }
  };
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const chosen = fits(side) || !fits(opposite[side]) ? side : opposite[side];
  let top: number;
  let left: number;
  if (chosen === 'top' || chosen === 'bottom') {
    top = chosen === 'bottom' ? anchor.top + anchor.height + GAP : anchor.top - GAP - floating.height;
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.left + anchor.width - floating.width : anchor.left + (anchor.width - floating.width) / 2;
  } else {
    left = chosen === 'right' ? anchor.left + anchor.width + GAP : anchor.left - GAP - floating.width;
    top = align === 'start' ? anchor.top : align === 'end' ? anchor.top + anchor.height - floating.height : anchor.top + (anchor.height - floating.height) / 2;
  }
  const clamp = (value: number, size: number, limit: number) => Math.max(MARGIN, Math.min(value, limit - size - MARGIN));
  return { top: Math.round(clamp(top, floating.height, viewport.height)), left: Math.round(clamp(left, floating.width, viewport.width)), side: chosen };
}

/** Places a floating element beside its anchor now. */
export function place(anchor: Element, floating: HTMLElement, side: Side = 'bottom', align: Align = 'start'): Side {
  const a = anchor.getBoundingClientRect();
  const f = floating.getBoundingClientRect();
  const at = placement({ top: a.top, left: a.left, width: a.width, height: a.height }, { width: f.width, height: f.height },
    { width: window.innerWidth, height: window.innerHeight }, side, align);
  floating.style.setProperty('top', `${at.top}px`);
  floating.style.setProperty('left', `${at.left}px`);
  floating.dataset['side'] = at.side;
  return at.side;
}
