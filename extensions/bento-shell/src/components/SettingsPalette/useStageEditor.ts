// The editor stages: a number or a name typed in the search field. Numbers apply live (the
// panel corners move while you type), Enter keeps the value, Esc puts back what the stage
// started with, and a draft that is not valid is never sent. The session itself lives in
// `editorSession.ts`; this hook adds the field's text and what it parses to.

import { useEffect, useRef, useState } from 'react';
import { createEditorSession } from './editorSession';
import { parseName, stepPreset } from './editing';
import { editorSpecFor } from './rows';
import { parseNumber } from './settingsCatalog';
import type { Stage } from './stageStack';
import type { SettingsPaletteActions, SettingsPaletteModel } from './types';

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
  /** Keeps a preset a click took: sends it if it differs from what the stage started with, and
   * ends the edit so a later revert changes nothing. False when there is no edit. */
  keep(value: number): boolean;
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
  const latest = useRef({ model, actions });
  latest.current = { model, actions };
  const [session] = useState(() =>
    createEditorSession({
      model: () => latest.current.model,
      update: (changes) => latest.current.actions.update(changes),
    }),
  );

  const spec = editorSpecFor(stage);
  const parsed = spec ? parseNumber(draft, spec) : null;
  const name = stage.kind === 'text' ? parseName(draft) : null;
  const check = parsed ?? name;
  const problem = check && !check.ok ? check.reason : null;
  const value = parsed?.ok ? parsed.value : null;

  useEffect(() => session.cancelPending, [session]);

  const applyNow = (next: number) => {
    session.apply(next);
    setDraft(String(next));
  };

  return {
    draft,
    problem,
    value,

    begin(next, current) {
      setDraft(session.begin(next, current));
    },

    type(text) {
      setDraft(text);
      if (spec) session.type(text, spec);
      else session.cancelPending();
    },

    step(direction) {
      if (!spec) return;
      const next = stepPreset(spec, value, direction);
      if (next !== null) applyNow(next);
    },

    keep: (value) => session.commit(value),

    commit() {
      if (!check?.ok) return false;
      return session.commit(check.value);
    },

    revert: session.revert,
  };
}
