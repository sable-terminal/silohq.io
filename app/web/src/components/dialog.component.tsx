'use client';

// Dialogs on the native <dialog>, shown modal: the page behind is inert, focus stays inside,
// Escape closes, and focus returns to where it was. A dialog doing work (busy) does not close
// until the work ends, so a write is never abandoned half seen. A drawer is the same dialog
// along the right edge, for detail beside a list.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client.api.ts';
import { Button } from './button.component.tsx';
import { IconButton } from './button.component.tsx';
import { ErrorMessage } from './states.component.tsx';
import styles from './dialog.component.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Along the right edge, full height. */
  drawer?: boolean;
  /** Work is under way: Escape and the close button wait. */
  busy?: boolean;
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', drawer = false, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const cancel = (event: Event) => {
      event.preventDefault();
      if (!busyRef.current) onClose();
    };
    // A click on the backdrop (the dialog element itself, outside its box) closes it.
    const click = (event: MouseEvent) => {
      if (event.target !== el || busyRef.current) return;
      const box = el.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) onClose();
    };
    el.addEventListener('cancel', cancel);
    el.addEventListener('click', click);
    return () => {
      el.removeEventListener('cancel', cancel);
      el.removeEventListener('click', click);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={[styles.dialog, drawer ? styles.drawer : styles[size]].join(' ')}
      // Named by its title while it is open; closed, it holds nothing to name.
      aria-labelledby={open ? titleId : undefined}
      aria-describedby={open && description !== undefined ? descriptionId : undefined}
      aria-busy={busy || undefined}
    >
      {open ? (
        <div className={styles.frame}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <h2 id={titleId} className={styles.title}>{title}</h2>
              {description !== undefined ? <p id={descriptionId} className={styles.description}>{description}</p> : null}
            </div>
            <IconButton label="Close" icon="close" onClick={onClose} disabled={busy} tooltip={false} />
          </header>
          {children !== undefined ? <div className={styles.body}>{children}</div> : null}
          {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Asks before something that is hard to undo. For the hardest (a purge, removing a member), the
 * person types a word to confirm. The confirmation's own failure is shown inside, and the
 * dialog stays open so the person can read it.
 */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel, tone = 'primary', typeToConfirm, onConfirm }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** The word to type before confirming. */
  typeToConfirm?: string | undefined;
  /** Resolves ok to close; a failure stays shown. */
  onConfirm: () => Promise<{ ok: boolean; error?: unknown }>;
}) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const inputId = useId();
  useEffect(() => {
    if (!open) {
      setTyped('');
      setError(undefined);
    }
  }, [open]);
  const ready = typeToConfirm === undefined || typed.trim() === typeToConfirm;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(undefined);
    const outcome = await onConfirm();
    setPending(false);
    if (outcome.ok) onClose();
    else setError(outcome.error ?? new Error('it did not go through'));
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm" busy={pending}>
      <form onSubmit={submit} className={styles.confirm}>
        {children}
        {typeToConfirm !== undefined ? (
          <div className={styles.typeField}>
            <label htmlFor={inputId}>Type <strong>{typeToConfirm}</strong> to confirm</label>
            <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
          </div>
        ) : null}
        {error !== undefined ? <ErrorMessage error={error} /> : null}
        <div className={styles.footerInline}>
          <Button onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" variant={tone} pending={pending} disabled={!ready}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export const isRefusal = (error: unknown): error is ApiError => error instanceof ApiError;
