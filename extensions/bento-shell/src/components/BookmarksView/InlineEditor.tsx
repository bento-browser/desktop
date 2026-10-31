// A one-field inline editor: the rename of a space, group or to-do, a note's text, and the
// "+ Link, note or to-do" entry. Enter saves (Shift+Enter breaks a line in the multi-line form),
// Esc cancels, and leaving the field saves what was typed. The parent decides what an empty or
// unchanged text means, so one rule covers both the blur and the Enter, and where the focus goes
// afterwards (back to the row or trigger after a key, nowhere after a blur).

import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Input, TextArea } from '@muxui/react';

export interface InlineEditorProps {
  label: string;
  initial?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Select the whole initial text on focus (a rename), instead of putting the caret at the end. */
  selectAll?: boolean;
  /** The most characters the field takes (UTF-16 code units, as the stored field is capped). */
  maxLength?: number;
  /** Under the field: what Enter and Esc do. */
  hint?: ReactNode;
  className?: string;
  /** `reason` says how it was answered: Enter, or the field losing focus. */
  onCommit: (text: string, reason: 'enter' | 'blur') => void;
  onCancel: () => void;
}

export function InlineEditor({
  label,
  initial = '',
  placeholder,
  multiline = false,
  selectAll = false,
  maxLength,
  hint,
  className,
  onCommit,
  onCancel,
}: InlineEditorProps) {
  const [draft, setDraft] = useState(initial);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Set once the editor has been answered, so the blur that follows an unmount or a key is not a second answer.
  const doneRef = useRef(false);

  // A textarea grows with its text instead of scrolling inside a small box.
  useEffect(() => {
    const field = fieldRef.current;
    if (!multiline || !field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [draft, multiline]);

  const commit = (reason: 'enter' | 'blur') => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(draft, reason);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      commit('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const common = {
    'aria-label': label,
    className: 'bento-bookmarks__field',
    value: draft,
    placeholder,
    maxLength,
    autoFocus: true,
    onFocus: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (selectAll) event.currentTarget.select();
      else event.currentTarget.setSelectionRange(draft.length, draft.length);
    },
    onKeyDown,
    onBlur: () => commit('blur'),
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
  };

  return (
    <div className={`bento-bookmarks__editor ${className ?? ''}`} data-bm-no-drag>
      {multiline ? (
        <TextArea.TextArea
          {...common}
          ref={fieldRef}
          rows={1}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      ) : (
        <Input.Input
          {...common}
          ref={fieldRef}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      )}
      {hint ? <div className="bento-bookmarks__editor-hint">{hint}</div> : null}
    </div>
  );
}
