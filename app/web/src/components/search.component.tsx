'use client';

// A search box for filtering a list: a labelled search input with a clear button. Typing is
// passed on after a short pause, so a list is not filtered again on every key.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.component.tsx';
import styles from './search.component.module.css';

export function SearchInput({ label, value, onChange, placeholder, delayMs = 200 }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  delayMs?: number;
}) {
  const [text, setText] = useState(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return undefined;
    const timer = setTimeout(() => onChangeRef.current(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, value, delayMs]);
  return (
    <div className={styles.box}>
      <Icon name="search" size={16} className={styles.icon} />
      <input type="search" aria-label={label} placeholder={placeholder ?? label} value={text} className={styles.input}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter') onChangeRef.current(text);
          if (e.key === 'Escape' && text !== '') {
            e.stopPropagation();
            setText('');
            onChangeRef.current('');
          }
        }} />
    </div>
  );
}
