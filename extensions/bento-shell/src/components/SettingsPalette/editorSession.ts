// The unfinished edit behind an editor stage, kept free of React so its timing is tested with
// fake timers. A number applies live after a short pause, Enter keeps it, and anything that
// ends the edit any other way (Esc, a new show, the palette being hidden) puts back what the
// stage started with and stops the pending apply.

import { numberChange, replaceAt } from './editing';
import type { EditableSettings } from './model';
import { parseNumber, type EditorSpec, type NumberSettingKey } from './settingsCatalog';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

/** Delay between the last keystroke and the live apply, so typing 24 does not apply 2. */
export const LIVE_APPLY_DELAY_MS = 180;

/** What the open editor started with, and the last number it sent (null: nothing yet). */
type Session =
  | { kind: 'number'; key: NumberSettingKey; entry: number; applied: number | null }
  | { kind: 'size'; index: number; entry: number[]; applied: number | null };

export interface EditorSessionDeps {
  /** The latest model, read when a delayed apply fires. */
  model(): SettingsPaletteModel | null;
  update(changes: Partial<EditableSettings>): unknown;
}

export interface EditorSession {
  /** Starts the session of a stage; returns the text its field starts with. */
  begin(stage: Stage, model: SettingsPaletteModel): string;
  /** Applies the typed text after a pause when it is a valid number. */
  type(text: string, spec: EditorSpec): void;
  /** Applies a number now. */
  apply(next: number): void;
  /** Keeps the value. False when there is no session. */
  commit(value: number): boolean;
  /** Stops any pending apply and puts back what the session started with. */
  revert(): void;
  /** Stops any pending apply. */
  cancelPending(): void;
}

export function createEditorSession(deps: EditorSessionDeps): EditorSession {
  let session: Session | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelPending = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const send = (current: Session, next: number) => {
    if (current.applied === next) return;
    current.applied = next;
    if (current.kind === 'number') {
      void deps.update(numberChange(current.key, next));
    } else {
      const model = deps.model();
      if (model) {
        void deps.update({
          customPanelSizes: replaceAt(model.settings.customPanelSizes, current.index, next),
        });
      }
    }
  };

  return {
    begin(stage, model) {
      cancelPending();
      if (stage.kind === 'number') {
        const entry = model.settings[stage.key];
        session = { kind: 'number', key: stage.key, entry, applied: null };
        return String(entry);
      }
      if (stage.kind === 'sizeEdit') {
        const entry = [...model.settings.customPanelSizes];
        session = { kind: 'size', index: stage.index, entry, applied: null };
        return String(entry[stage.index] ?? '');
      }
      session = null;
      return '';
    },

    type(text, spec) {
      cancelPending();
      const current = session;
      if (!current) return;
      const result = parseNumber(text, spec);
      if (!result.ok) return;
      timer = setTimeout(() => send(current, result.value), LIVE_APPLY_DELAY_MS);
    },

    apply(next) {
      cancelPending();
      if (session) send(session, next);
    },

    commit(value) {
      const current = session;
      if (!current) return false;
      cancelPending();
      const started = current.kind === 'number' ? current.entry : current.entry[current.index];
      if (current.applied !== null || value !== started) send(current, value);
      session = null;
      return true;
    },

    revert() {
      const current = session;
      cancelPending();
      session = null;
      if (!current || current.applied === null) return;
      if (current.kind === 'number') {
        void deps.update(numberChange(current.key, current.entry));
      } else {
        void deps.update({ customPanelSizes: current.entry });
      }
    },

    cancelPending,
  };
}
