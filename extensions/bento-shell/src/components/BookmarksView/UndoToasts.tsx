// The "deleted" toasts with their Undo. A small Bento composite on Mux parts rather than Mux's
// Toast: the Mux ToastProvider pulls React Aria's toast machinery into the vendor chunk every shell
// document loads (about 7 KB gzipped on each of the 14 documents' cold starts), for a toast only this
// view shows. A toast enters on the reveal role and leaves on the dismiss role (BookmarksView.css),
// stays while the pointer or the keyboard is on it, and goes by itself after a few seconds.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Text } from '@muxui/react';
import X from 'lucide-react/dist/esm/icons/x';

import { afterMotion } from '../../motion/afterMotion';
import { BentoIcon } from '../primitives';

export interface UndoToast {
  id: number;
  title: string;
  /** What was deleted: the row's text. */
  label: string;
  onUndo: () => void;
}

/** How long a toast stays when nothing is on it. */
export const UNDO_TOAST_MS = 6000;

function UndoToastItem({ toast, onRemove }: { toast: UndoToast; onRemove: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (exiting || held) return;
    const timer = setTimeout(() => setExiting(true), UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [exiting, held]);

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
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
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
        onActivate={() => {
          toast.onUndo();
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
