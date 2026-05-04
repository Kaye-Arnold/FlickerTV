'use client';

import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyboardShortcut {
  /** Key code (e.g. 'Space', 'ArrowUp', 'KeyM', 'KeyF'). */
  code: string;
  /** If true, the shortcut fires only when no modifier keys are held. */
  noModifiers?: boolean;
  /** If true, the shortcut fires even when an input/textarea is focused. */
  allowInInputs?: boolean;
  /** Handler to call when the shortcut triggers. */
  handler: (event: KeyboardEvent) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useKeyboardShortcuts
 *
 * Attaches keyboard event listeners for a set of shortcuts.
 * Used by the CinemaPlayer to support Space (play/pause),
 * M (mute), F (fullscreen), and arrow key seeking.
 *
 * All listeners are attached to the document and cleaned up on unmount.
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        if (e.code !== shortcut.code) continue;

        // Skip if modifier keys are held (and shortcut requires clean key).
        if (shortcut.noModifiers && (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
          continue;
        }

        // Skip if focused in a text input (unless explicitly allowed).
        if (!shortcut.allowInInputs) {
          const target = e.target as HTMLElement;
          const tagName = target.tagName.toLowerCase();
          if (
            tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            target.isContentEditable
          ) {
            continue;
          }
        }

        e.preventDefault();
        shortcut.handler(e);
        break; // First matching shortcut wins.
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcuts, enabled]);
}