'use client';

// Copies an id or reference to the clipboard, and says so. Clipboard access can be refused (an
// insecure context, a permission); the button then says it could not.

import { useState } from 'react';
import { IconButton } from './button.component.tsx';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [said, setSaid] = useState<string | undefined>(undefined);
  return (
    <>
      <IconButton
        size="sm"
        icon={said === 'Copied' ? 'check' : 'copy'}
        label={said ?? label}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setSaid('Copied'), () => setSaid('Could not copy'));
          setTimeout(() => setSaid(undefined), 2000);
        }}
      />
      <span className="visually-hidden" role="status">{said ?? ''}</span>
    </>
  );
}
