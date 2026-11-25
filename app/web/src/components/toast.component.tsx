'use client';

// Short notes about what just happened ("Connection renamed"), in a live region so they are
// read out without moving focus. They leave on their own after a while, but not while the
// pointer or focus is on them; a failure stays until dismissed.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './button.component.tsx';
import { Icon } from './icon.component.tsx';
import styles from './toast.component.module.css';

interface Toast {
  id: number;
  tone: 'ok' | 'info' | 'danger';
  message: string;
  action?: { label: string; onSelect: () => void } | undefined;
}

type Say = (message: string, options?: { tone?: Toast['tone']; action?: Toast['action'] }) => void;

const ToastContext = createContext<Say>(() => undefined);
export const useToast = (): Say => useContext(ToastContext);

const STAY_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const say = useCallback<Say>((message, options = {}) => {
    const toast: Toast = { id: next.current++, tone: options.tone ?? 'ok', message, action: options.action };
    setToasts((all) => [...all.slice(-3), toast]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  return (
    <ToastContext.Provider value={say}>
      {children}
      <div className={styles.region} aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || toast.tone === 'danger') return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), STAY_MS);
    return () => clearTimeout(timer);
  }, [held, toast, onDismiss]);
  return (
    <div className={`${styles.toast} ${styles[toast.tone]}`} role={toast.tone === 'danger' ? 'alert' : 'status'}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <Icon name={toast.tone === 'danger' ? 'error' : toast.tone === 'ok' ? 'success' : 'info'} size={16} className={styles.icon} />
      <span className={styles.message}>{toast.message}</span>
      {toast.action !== undefined ? (
        <button type="button" className={styles.action} onClick={() => {
          toast.action!.onSelect();
          onDismiss(toast.id);
        }}>{toast.action.label}</button>
      ) : null}
      <IconButton size="sm" label="Dismiss" icon="close" onClick={() => onDismiss(toast.id)} tooltip={false} />
    </div>
  );
}
