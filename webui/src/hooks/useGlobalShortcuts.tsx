import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui';

const SEQUENCE_TIMEOUT_MS = 1000;

const NAV_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['g', 'd'], label: 'Go to Dashboard' },
  { keys: ['g', 'j'], label: 'Go to Jobs' },
  { keys: ['g', 'l'], label: 'Go to Library' },
  { keys: ['g', 's'], label: 'Go to Settings' },
  { keys: ['g', 'c'], label: 'Go to AI Montage' },
  { keys: ['?'], label: 'Show this help' },
];

const NAV_ROUTES: Record<string, string> = {
  d: '/dashboard',
  j: '/jobs',
  l: '/library',
  s: '/settings',
  c: '/compilations',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Global keyboard navigation: "g <key>" sequences jump between pages and "?"
 * opens a help overlay. Suppressed while typing, while any modal is open, and
 * on the long-form editor route (the NLE has its own keyboard handler).
 *
 * Returns the help-modal element; render it near the layout root.
 */
export function useGlobalShortcuts(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);
  const gTimer = useRef<number | null>(null);

  useEffect(() => {
    function clearPendingG() {
      if (gTimer.current !== null) {
        window.clearTimeout(gTimer.current);
        gTimer.current = null;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (location.pathname.startsWith('/longform-editor/')) return;
      if (isEditableTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;

      if (event.key === '?') {
        event.preventDefault();
        clearPendingG();
        setHelpOpen(true);
        return;
      }

      if (event.key.toLowerCase() === 'g') {
        clearPendingG();
        gTimer.current = window.setTimeout(() => { gTimer.current = null; }, SEQUENCE_TIMEOUT_MS);
        return;
      }

      if (gTimer.current !== null) {
        const destination = NAV_ROUTES[event.key.toLowerCase()];
        clearPendingG();
        if (destination) {
          event.preventDefault();
          navigate(destination);
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearPendingG();
    };
  }, [location.pathname, navigate]);

  return (
    <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
      <ul className="space-y-2">
        {NAV_SHORTCUTS.map((shortcut) => (
          <li key={shortcut.label} className="flex items-center justify-between gap-3 text-sm text-slate-300">
            <span>{shortcut.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {shortcut.keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-slate-500">
        The long-form editor has its own shortcuts: <kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> <kbd className="kbd">L</kbd> playback,{' '}
        <kbd className="kbd">I</kbd> <kbd className="kbd">O</kbd> in/out points, <kbd className="kbd">Space</kbd> play/pause,{' '}
        arrow keys nudge, <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Z</kbd> undo, <kbd className="kbd">M</kbd> mute.
      </p>
    </Modal>
  );
}
