// Committing the Name field of the edit popover. Enter, blur, Done and a close from outside can all
// commit the same text within a moment; only the first should reach bento-tools. "Sent" lasts only
// until the snapshot shows the title, or the text is edited again, so the same name can be
// committed again after it was changed elsewhere in between.

export type NameCommit =
  /** Nothing to do: no edit, the saved title, or a name already on its way. */
  | { kind: 'keep' }
  /** The field was emptied: show the saved title again. */
  | { kind: 'restore' }
  | { kind: 'send'; title: string };

export interface NameCommitter {
  /** What committing `draft` (the typed text, null when untouched) does while the saved title is
   * `title`. A `send` counts as outstanding until `acknowledge` or `edited`. */
  commit(draft: string | null, title: string): NameCommit;
  /** The snapshot now shows `title`: a send of that title has arrived. */
  acknowledge(title: string): void;
  /** The text changed: what was sent no longer decides what the next commit does. */
  edited(): void;
}

export function createNameCommitter(): NameCommitter {
  let sent: string | null = null;
  return {
    commit(draft, title) {
      if (draft === null) return { kind: 'keep' };
      const next = draft.trim();
      if (!next) return { kind: 'restore' };
      if (next === title || next === sent) return { kind: 'keep' };
      sent = next;
      return { kind: 'send', title: next };
    },
    acknowledge(title) {
      if (sent === title) sent = null;
    },
    edited() {
      sent = null;
    },
  };
}
