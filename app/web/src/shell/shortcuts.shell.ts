// The workspace's keyboard shortcuts: one list, read by the handler and shown in the help centre.
// None fires while the person is typing in a field, except those with a modifier.

export interface Shortcut {
  /** As shown: "/", "Ctrl K". */
  keys: string;
  /** As aria-keyshortcuts writes it. */
  aria: string;
  does: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: '/', aria: '/', does: 'Search objects, pages, settings and commands' },
  { keys: 'Ctrl K or ⌘K', aria: 'Control+K Meta+K', does: 'Search, from anywhere, even while typing' },
  { keys: 'N', aria: 'N', does: 'Open the + menu to make something new' },
  { keys: 'Ctrl B or ⌘B', aria: 'Control+B Meta+B', does: 'Collapse or expand the sidebar' },
  { keys: 'Ctrl J or ⌘J', aria: 'Control+J Meta+J', does: 'Open or close the Ask panel' },
  { keys: '?', aria: 'Shift+?', does: 'Show these shortcuts' },
  { keys: 'Esc', aria: 'Escape', does: 'Close the open panel, menu or dialog' },
];

/** Whether a key press happened while the person was typing. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="textbox"]') !== null;
}
