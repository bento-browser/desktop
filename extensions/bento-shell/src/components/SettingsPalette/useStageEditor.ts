// The editor stages: a number or a name typed in the search field. Numbers apply live (the
// panel corners move while you type), Enter keeps the value, Esc puts back what the stage
// started with, and a draft that is not valid is never sent.

import { useCallback, useEffect, useRef, useState } from 'react';
import { numberChange, parseName, replaceAt, stepPreset } from './editing';
import { editorSpecFor } from './rows';
import { parseNumber, type NumberSettingKey } from './settingsCatalog';
import type { Stage } from './stageStack';
import type { SettingsPaletteActions, SettingsPaletteModel } from './types';

/** Delay between the last keystroke and the live apply, so typing 24 does not apply 2. */
const LIVE_APPLY_DELAY_MS = 180;

/** What the open editor started with, and the last number it sent (null: nothing yet). */
type Session =
  | { kind: 'number'; key: NumberSettingKey; entry: number; applied: number | null }
  | { kind: 'size'; index: number; entry: number[]; applied: number | null }
  | { kind: 'name'; entry: string };

export interface StageEditor {
  draft: string;
  /** Why the draft cannot be saved, or null. */
  problem: string | null;
  /** The number the draft holds, when valid; marks the matching preset. */
  value: number | null;
  /** Starts an editor stage with the current value of its setting. */
  begin(stage: Stage, model: SettingsPaletteModel): void;
  type(text: string): void;
  /** Moves to the next or previous preset and applies it. */
  step(direction: 1 | -1): void;
  /** Takes a preset row. */
  choose(value: number): void;
  /** Keeps the draft. False (and nothing sent) when it is not valid. */
  commit(): boolean;
  /** Drops the draft and puts back the value the stage started with. */
  revert(): void;
}

export function useStageEditor(
  stage: Stage,
  model: SettingsPaletteModel | null,
  actions: SettingsPaletteActions,
): StageEditor {
  const [draft, setDraft] = useState('');
  const session = useRef<Session | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ model, actions });
  latest.current = { model, actions };

  const spec = editorSpecFor(stage);
  const parsed = spec ? parseNumber(draft, spec) : null;
  const name = stage.kind === 'text' ? parseName(draft) : null;
  const check = parsed ?? name;
  const problem = check && !check.ok ? check.reason : null;
  const value = parsed?.ok ? parsed.value : null;

  const cancelTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const send = useCallback((current: Session, next: number) => {
    if (current.kind === 'name' || current.applied === next) return;
    current.applied = next;
    const { model: now, actions: act } = latest.current;
    if (current.kind === 'number') {
      void act.update(numberChange(current.key, next));
    } else if (now) {
      void act.update({
        customPanelSizes: replaceAt(now.settings.customPanelSizes, current.index, next),
      });
    }
  }, []);

  useEffect(() => cancelTimer, [cancelTimer]);

  const applyNow = (next: number) => {
    cancelTimer();
    if (session.current) send(session.current, next);
    setDraft(String(next));
  };

  return {
    draft,
    problem,
    value,

    begin(next, current) {
      cancelTimer();
      if (next.kind === 'number') {
        const entry = current.settings[next.key];
        session.current = { kind: 'number', key: next.key, entry, applied: null };
        setDraft(String(entry));
      } else if (next.kind === 'sizeEdit') {
        const entry = [...current.settings.customPanelSizes];
        session.current = { kind: 'size', index: next.index, entry, applied: null };
        setDraft(String(entry[next.index] ?? ''));
      } else if (next.kind === 'text') {
        const entry = current.settings.defaultWorkspaceName;
        session.current = { kind: 'name', entry };
        setDraft(entry);
      } else {
        session.current = null;
        setDraft('');
      }
    },

    type(text) {
      setDraft(text);
      cancelTimer();
      const current = session.current;
      if (!current || current.kind === 'name' || !spec) return;
      const result = parseNumber(text, spec);
      if (!result.ok) return;
      timer.current = setTimeout(() => send(current, result.value), LIVE_APPLY_DELAY_MS);
    },

    step(direction) {
      if (!spec) return;
      const next = stepPreset(spec, value, direction);
      if (next !== null) applyNow(next);
    },

    choose: applyNow,

    commit() {
      const current = session.current;
      if (!current || !check?.ok) return false;
      cancelTimer();
      if (current.kind === 'name') {
        if (name?.ok && name.value !== current.entry) {
          void latest.current.actions.update({ defaultWorkspaceName: name.value });
        }
      } else if (parsed?.ok) {
        const started = current.kind === 'number' ? current.entry : current.entry[current.index];
        if (current.applied !== null || parsed.value !== started) send(current, parsed.value);
      }
      session.current = null;
      return true;
    },

    revert() {
      const current = session.current;
      cancelTimer();
      session.current = null;
      if (!current || current.kind === 'name' || current.applied === null) return;
      const { actions: act } = latest.current;
      if (current.kind === 'number') {
        void act.update(numberChange(current.key, current.entry));
      } else {
        void act.update({ customPanelSizes: current.entry });
      }
    },
  };
}
