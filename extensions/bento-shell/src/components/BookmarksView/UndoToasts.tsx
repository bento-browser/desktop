// The "deleted" toasts with their Undo. A small Bento composite on Mux parts rather than Mux's
// Toast: the Mux ToastProvider pulls React Aria's toast machinery into the vendor chunk every shell
// document loads (about 7 KB gzipped on each of the 14 documents' cold starts), for a toast only this
// view shows. A toast enters on the reveal role and leaves on the dismiss role (BookmarksView.css),
// stays while the pointer or the keyboard is on it (each tracked on its own, dismissTimer.ts), and
// goes by itself after a few seconds.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Text } from '@muxui/react';
import X from 'lucide-react/dist/esm/icons/x';

import { afterMotion } from '../../motion/afterMotion';
import { BentoIcon } from '../primitives';
import { createDismissTimer, type DismissTimer } from './dismissTimer';

export interface UndoToast {
  id: number;
  title: string;
  /** What was deleted: the row's text. */
  label: string;
  /** `viaKeyboard` is true when the Undo button was activated from the keyboard. */
  onUndo: (viaKeyboard: boolean) => void;
}

/** How long a toast stays when nothing is on it. */
export const UNDO_TOAST_MS = 6000;

function UndoToastItem({ toast, onRemove }: { toast: UndoToast; onRemove: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<DismissTimer | null>(null);

  useEffect(() => {
    const countdown = createDismissTimer(UNDO_TOAST_MS, () => setExiting(true));
    timer.current = countdown;
    return () => {
      countdown.cancel();
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    if (exiting) timer.current?.cancel();
  }, [exiting]);

  useLayoutEffect(() => {
    if (!exiting) return;
    const element = ref.current;
    if (!element) {
      onRemove(toast.id);
      return;
    }
    return afterMotion(element, { animations: ['bento-bookmarks-toast-out'] }, () =>
      onRemove(toast.id),
    );
  }, [exiting, onRemove, toast.id]);

  return (
    <div
      ref={ref}
      className="bento-bookmarks__toast"
      role="group"
      aria-label={toast.title}
      data-exiting={exiting ? 'true' : undefined}
      inert={exiting}
      onPointerEnter={() => timer.current?.hold('pointer')}
      onPointerLeave={() => timer.current?.release('pointer')}
      onFocus={() => timer.current?.hold('focus')}
      onBlur={(event) => {
        // Focus moving between the toast's own buttons is not leaving it.
        if (!event.currentTarget.contains(event.relatedTarget)) timer.current?.release('focus');
      }}
    >
      <div className="bento-bookmarks__toast-text">
        <Text variant="label" size="sm">
          {toast.title}
        </Text>
        <Text variant="body" size="sm" color="muted" truncate>
          {toast.label}
        </Text>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onActivate={(event) => {
          toast.onUndo(event.pointerType === 'keyboard' || event.pointerType === 'virtual');
          setExiting(true);
        }}
      >
        Undo
      </Button>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Dismiss"
        onActivate={() => setExiting(true)}
      >
        <BentoIcon icon={X} size="sm" />
      </IconButton>
    </div>
  );
}

export function UndoToasts({
  toasts,
  onRemove,
}: {
  toasts: readonly UndoToast[];
  onRemove: (id: number) => void;
}) {
  return (
    <div className="bento-bookmarks__toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <UndoToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  );
}
