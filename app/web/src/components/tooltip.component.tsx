'use client';

// A short label shown beside a control on hover and keyboard focus, after a moment. Visual only:
// the control carries its own accessible name or description, so the tooltip is hidden from
// assistive technology and never the only place something is said. Rendered in the top layer,
// so a scrolling sidebar or a table cell never clips it.

import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { place, type Align, type Side } from '../utils/position.util.ts';
import styles from './tooltip.component.module.css';

const DELAY_MS = 350;

interface TriggerProps {
  onPointerEnter?: (event: never) => void;
  onPointerLeave?: (event: never) => void;
  onFocus?: (event: never) => void;
  onBlur?: (event: never) => void;
  onKeyDown?: (event: never) => void;
  ref?: unknown;
}

export function Tooltip({ content, side = 'bottom', align = 'center', children }: {
  content: ReactNode;
  side?: Side;
  align?: Align;
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const el = tip.current;
    if (el === null || anchor.current === null) return;
    if (open && content !== undefined && content !== null && content !== '') {
      try {
        el.showPopover();
      } catch {
        // Already shown, or the element left the page.
      }
      place(anchor.current, el, side, align);
    } else if (el.matches(':popover-open')) {
      el.hidePopover();
    }
  }, [open, side, align, content]);

  const props = children.props;
  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchor.current = node;
      // The trigger's own ref, kept.
      const own = props.ref;
      if (typeof own === 'function') own(node);
      else if (own !== null && typeof own === 'object') (own as { current: unknown }).current = node;
    },
    onPointerEnter: (event: never) => {
      props.onPointerEnter?.(event);
      show();
    },
    onPointerLeave: (event: never) => {
      props.onPointerLeave?.(event);
      hide();
    },
    onFocus: (event: never) => {
      props.onFocus?.(event);
      show();
    },
    onBlur: (event: never) => {
      props.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: never) => {
      props.onKeyDown?.(event);
      if ((event as KeyboardEvent).key === 'Escape') hide();
    },
  });

  return (
    <>
      {trigger}
      <div ref={tip} id={id} popover="manual" className={styles.tip} aria-hidden="true">
        {content}
      </div>
    </>
  );
}
