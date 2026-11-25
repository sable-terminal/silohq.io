'use client';

// Form fields: each with a visible label, an optional hint, and its error under it, tied to the
// control (aria-describedby, aria-invalid) so a screen reader hears all three. A field's error
// can come straight from the gateway: the issue it named for that field (body.name).

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { isApiError } from '../api/client.api.ts';
import type { Blocked } from '../data/query.data.ts';
import styles from './field.component.module.css';

/** The gateway's message for one field of a failed write, if it named that field. */
export function fieldError(error: unknown, field: string): string | undefined {
  return isApiError(error) ? error.issueFor(field)?.message : undefined;
}

interface Frame {
  label: ReactNode;
  hint?: ReactNode | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  /** The label is for assistive technology only (a search box with its own placeholder). */
  hideLabel?: boolean | undefined;
  className?: string | undefined;
}

function useFrame(error: string | undefined, hint: ReactNode | undefined) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined ? `${id}-error` : undefined;
  return { id, hintId, errorId, describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined };
}

function Wrap({ id, label, hint, hintId, error, errorId, required, hideLabel, className, children }: Frame & { id: string; hintId: string | undefined; errorId: string | undefined; children: ReactNode }) {
  return (
    <div className={[styles.field, className ?? ''].filter(Boolean).join(' ')}>
      <span className={hideLabel ? 'visually-hidden' : styles.labelRow}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        {required && hideLabel !== true ? <span className={styles.required} aria-hidden="true">*</span> : null}
      </span>
      {children}
      {hint !== undefined ? <span id={hintId} className={styles.hint}>{hint}</span> : null}
      {error !== undefined ? <span id={errorId} className={styles.error}>{error}</span> : null}
    </div>
  );
}

export function TextField({ label, hint, error, required, hideLabel, className, ...input }: Frame & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  const f = useFrame(error, hint);
  return (
    <Wrap id={f.id} label={label} hint={hint} hintId={f.hintId} error={error} errorId={f.errorId} required={required} hideLabel={hideLabel} className={className}>
      <input {...input} id={f.id} required={required} aria-invalid={error !== undefined || undefined} aria-describedby={f.describedBy} className={styles.input} />
    </Wrap>
  );
}

export function TextArea({ label, hint, error, required, hideLabel, className, ...input }: Frame & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  const f = useFrame(error, hint);
  return (
    <Wrap id={f.id} label={label} hint={hint} hintId={f.hintId} error={error} errorId={f.errorId} required={required} hideLabel={hideLabel} className={className}>
      <textarea {...input} id={f.id} required={required} aria-invalid={error !== undefined || undefined} aria-describedby={f.describedBy} className={styles.textarea} />
    </Wrap>
  );
}

export interface Option { value: string; label: string; disabled?: boolean }

export function SelectField({ label, hint, error, required, hideLabel, className, options, placeholder, ...select }: Frame & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  options: readonly Option[];
  placeholder?: string | undefined;
}) {
  const f = useFrame(error, hint);
  return (
    <Wrap id={f.id} label={label} hint={hint} hintId={f.hintId} error={error} errorId={f.errorId} required={required} hideLabel={hideLabel} className={className}>
      <select {...select} id={f.id} required={required} aria-invalid={error !== undefined || undefined} aria-describedby={f.describedBy} className={styles.select}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </Wrap>
  );
}

export function Checkbox({ label, hint, error, className, ...input }: Omit<Frame, 'hideLabel' | 'required'> & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  const f = useFrame(error, hint);
  return (
    <div className={[styles.check, className ?? ''].filter(Boolean).join(' ')}>
      <input {...input} type="checkbox" id={f.id} aria-invalid={error !== undefined || undefined} aria-describedby={f.describedBy} className={styles.checkbox} />
      <div className={styles.checkText}>
        <label htmlFor={f.id}>{label}</label>
        {hint !== undefined ? <span id={f.hintId} className={styles.hint}>{hint}</span> : null}
        {error !== undefined ? <span id={f.errorId} className={styles.error}>{error}</span> : null}
      </div>
    </div>
  );
}

/** An on/off setting that takes effect when changed (a switch), as opposed to a checkbox in a form. */
export function Switch({ label, hint, checked, onChange, disabled, blocked: why }: {
  label: ReactNode;
  hint?: ReactNode | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  blocked?: Blocked | string | undefined;
}) {
  const id = useId();
  const blocked = typeof why === 'string' ? why : why?.message;
  const inert = disabled === true || blocked !== undefined;
  return (
    <div className={styles.switchRow}>
      <div className={styles.checkText}>
        <span id={`${id}-label`} className={styles.label}>{label}</span>
        {hint !== undefined ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
        {blocked !== undefined ? <span id={`${id}-blocked`} className={styles.hint}>{blocked}</span> : null}
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-label`}
        aria-describedby={[hint !== undefined ? `${id}-hint` : '', blocked !== undefined ? `${id}-blocked` : ''].filter(Boolean).join(' ') || undefined}
        aria-disabled={inert || undefined} className={styles.switch} onClick={() => {
          if (!inert) onChange(!checked);
        }}>
        <span className={styles.thumb} />
      </button>
    </div>
  );
}

export function RadioGroup<V extends string>({ label, hint, value, onChange, options, name }: {
  label: ReactNode;
  hint?: ReactNode | undefined;
  value: V;
  onChange: (value: V) => void;
  options: readonly { value: V; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  name: string;
}) {
  const id = useId();
  return (
    <fieldset className={styles.fieldset} aria-describedby={hint !== undefined ? `${id}-hint` : undefined}>
      <legend className={styles.label}>{label}</legend>
      {hint !== undefined ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
      {options.map((o) => (
        <div key={o.value} className={styles.check}>
          <input type="radio" id={`${id}-${o.value}`} name={name} value={o.value} checked={value === o.value} disabled={o.disabled}
            onChange={() => onChange(o.value)} className={styles.checkbox} />
          <div className={styles.checkText}>
            <label htmlFor={`${id}-${o.value}`}>{o.label}</label>
            {o.hint !== undefined ? <span className={styles.hint}>{o.hint}</span> : null}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

/** The row of buttons at the foot of a form. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
