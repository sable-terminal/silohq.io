'use client';

// A panel that opens from a button: header panels, menus, pickers. Built on the browser's
// Popover API: the panel sits in the top layer (never clipped), closes on Escape or a click
// outside, one open at a time unless nested; the trigger is its invoker (popovertarget), so
// pressing the trigger again closes it rather than closing and reopening. Focus moves into the
// panel when it opens and back to the trigger when it closes from inside.
//
// Uncontrolled by default; pass open and onOpenChange to open it from elsewhere (a keyboard
// shortcut, a link in another panel).

import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { place, type Align, type Side } from '../utils/position.util.ts';
import styles from './popover.component.module.css';

export interface TriggerProps {
  ref: Ref<HTMLButtonElement>;
  popoverTarget: string;
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-haspopup': 'dialog' | 'menu' | 'listbox';
}

export interface PopoverProps {
  /** The panel's accessible name. */
  label: string;
  renderTrigger: (props: TriggerProps) => ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  side?: Side;
  align?: Align;
  role?: 'dialog' | 'menu' | 'listbox';
  /** Where focus goes on opening: the first control, the panel itself, or nowhere (a hover card). */
  initialFocus?: 'first' | 'panel' | 'none';
  className?: string | undefined;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Popover({ label, renderTrigger, children, open, onOpenChange, side = 'bottom', align = 'start', role = 'dialog', initialFocus = 'first', className }: PopoverProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  const controlled = open !== undefined;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // The browser opened or closed it (the invoker, Escape, a click outside): follow it.
  useEffect(() => {
    const el = panel.current;
    if (el === null) return undefined;
    const toggled = (event: Event) => {
      const now = (event as ToggleEvent).newState === 'open';
      setShown(now);
      onOpenChangeRef.current?.(now);
    };
    el.addEventListener('toggle', toggled);
    return () => el.removeEventListener('toggle', toggled);
  }, []);

  // Asked to open or close from outside.
  useEffect(() => {
    const el = panel.current;
    if (!controlled || el === null) return;
    const isOpen = el.matches(':popover-open');
    try {
      if (open && !isOpen) el.showPopover();
      if (!open && isOpen) el.hidePopover();
    } catch {
      // Not connected yet; the next render tries again.
    }
  }, [open, controlled]);

  // Placed beside the trigger while open, following scrolling and resizing; focus moved in.
  useEffect(() => {
    const el = panel.current;
    if (!shown || el === null || trigger.current === null) return undefined;
    const reposition = () => {
      if (trigger.current !== null) place(trigger.current, el, side, align);
    };
    reposition();
    if (initialFocus === 'first') (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    else if (initialFocus === 'panel') el.focus();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = new ResizeObserver(reposition);
    observer.observe(el);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer.disconnect();
      // Closed while focus was inside: back to the trigger, so the keyboard is not lost.
      if (el.contains(document.activeElement) || document.activeElement === document.body) trigger.current?.focus();
    };
  }, [shown, side, align, initialFocus]);

  const close = useCallback(() => {
    try {
      panel.current?.hidePopover();
    } catch {
      // Already closed.
    }
  }, []);

  return (
    <>
      {renderTrigger({ ref: trigger, popoverTarget: id, 'aria-expanded': shown, 'aria-controls': id, 'aria-haspopup': role })}
      <div
        ref={panel}
        id={id}
        popover="auto"
        role={role}
        aria-label={label}
        tabIndex={-1}
        className={[styles.panel, className ?? ''].filter(Boolean).join(' ')}
      >
        {shown ? (typeof children === 'function' ? children(close) : children) : null}
      </div>
    </>
  );
}
