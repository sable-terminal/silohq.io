'use client';

// A field for a JSON object a person types: sample records for a connection's write and stream
// tests, where no engine can invent values a source will accept. It says, as they type, whether
// what they wrote is an object, and the parsed object is what the form sends.

import { useState } from 'react';
import { TextArea } from './field.component.tsx';

export type JsonObject = Record<string, unknown>;

/** The object in the text, or why it is not one. Empty text is no object, and no error. */
export function parseObject(text: string): { value: JsonObject | undefined; error: string | undefined } {
  if (text.trim() === '') return { value: undefined, error: undefined };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: undefined, error: 'Write an object: { "field": value }' };
    return { value: parsed as JsonObject, error: undefined };
  } catch (e) {
    return { value: undefined, error: `Not JSON yet: ${(e as Error).message.replace(/^JSON\.parse: /, '')}` };
  }
}

export function useJsonObject(initial = ''): { text: string; setText: (text: string) => void; value: JsonObject | undefined; error: string | undefined } {
  const [text, setText] = useState(initial);
  const { value, error } = parseObject(text);
  return { text, setText, value, error };
}

export function JsonObjectField({ label, hint, required, state, serverError, rows = 5 }: {
  label: string;
  hint?: string | undefined;
  required?: boolean | undefined;
  state: ReturnType<typeof useJsonObject>;
  /** The gateway's message for this field, if a write named it. */
  serverError?: string | undefined;
  rows?: number;
}) {
  return (
    <TextArea label={label} hint={hint} required={required} rows={rows} spellCheck={false} autoComplete="off" value={state.text}
      placeholder={'{ "name": "Silo test record" }'} onChange={(e) => state.setText(e.target.value)} error={state.error ?? serverError} />
  );
}
