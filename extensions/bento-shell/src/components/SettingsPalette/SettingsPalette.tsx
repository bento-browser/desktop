// Layer-2 component: SettingsPalette.
//
// Bento's settings as a staged quick pick on the Mux CommandPalette parts. The root lists
// categories; each category lists controls with their values. Choosing a control toggles it or opens a
// stage (a list of choices, a number typed in the search field, or a number moved on a slider
// when its range is small). A nav row above the field holds Back, the path to the current page
// (every ancestor a button) and Close, and Esc goes back one stage, closing from the root.
//
// Presentational: it takes the settings model and the write actions (`SettingsPaletteActions`)
// and keeps only navigation state, so stories and tests drive it without a connection. The
// entry (`settings-palette/main.tsx`) binds it to tools.
//
// Not the main palette's behaviour: Enter does not run the first result and the field is not
// selected on focus, because in an editor stage the field holds the value being typed.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, CommandPalette as Palette, IconButton, SwitchField } from '@muxui/react';
import ChevronLeftIcon from 'lucide-react/dist/esm/icons/chevron-left';
import ChevronRightIcon from 'lucide-react/dist/esm/icons/chevron-right';
import ExternalLinkIcon from 'lucide-react/dist/esm/icons/external-link';
import PlusIcon from 'lucide-react/dist/esm/icons/plus';
import TriangleAlertIcon from 'lucide-react/dist/esm/icons/triangle-alert';

import { BentoIcon } from '../primitives';
import { IN_TAB_ORDER } from '../primitives/inTabOrder';
import {
  FOCUS_ON_HOVER,
  ROW_HIGHLIGHT_CLASS,
  useRowHighlight,
} from '../primitives/useRowHighlight';
import { openerRows, settingPath } from './categories';
import { toggleChange } from './editing';
import {
  editorSpecFor,
  filterRows,
  footerFor,
  isFilterable,
  pageDescription,
  rootRows,
  rowAriaLabel,
  rowsForStage,
  searchableRows,
  showsFieldRow,
  sliderSpecFor,
  stageLabel,
  statusRows,
  type FooterCopy,
  type Intent,
  type PaletteRow,
} from './rows';
import RangeSlider from './RangeSlider';
import { formatNumber } from './settingsCatalog';
import { createSizeRunner, stackAfterSizeChange, waitsForSave } from './sizeIntents';
import {
  escapeOutcome,
  initialStack,
  isEditorStage,
  pathLabels,
  popStage,
  popToIndex,
  popToKind,
  pushStage,
  stageKey,
  topStage,
  type Stage,
} from './stageStack';
import { targetForModel } from './targets';
import type { SettingsPaletteActions, SettingsPaletteView } from './types';
import { useStageEditor } from './useStageEditor';
import './SettingsPalette.css';

export interface SettingsPaletteProps {
  view: SettingsPaletteView;
  actions: SettingsPaletteActions;
  /** Dismisses the palette (Esc from the root, the backdrop, the close button, a finished reset). */
  onClose: () => void;
  /** Given when the command palette opened Settings: the path starts with it, and Back at the
   * root returns there. Other openers leave it out and Back is disabled at the root. */
  onBackToPalette?: () => void;
  /** Stages to start on, root first. The root alone by default. */
  initialStages?: readonly Stage[];
  /** Search text to start with (a link to a setting that has no list of its own). */
  initialQuery?: string;
  /** Changes on every show; the palette returns to `initialStages` when it does. */
  openToken?: number;
  /** Changes whenever chrome hides the palette: an unfinished edit is put back at once. */
  hideToken?: number;
}

const TRAIL_ICONS = {
  '›': ChevronRightIcon,
  '↗': ExternalLinkIcon,
  '+': PlusIcon,
} as const;

/** The stages whose rows are headed by their group (the others are one plain list). */
function showsGroupHeaders(stage: Stage, searching: boolean): boolean {
  if (searching) return true;
  return stage.kind === 'backups' || stage.kind === 'confirm';
}

/** Links every option of the list to its own description line (and the protection detail), as
 * its `aria-describedby`. React Aria forwards no `aria-describedby` from an item and its
 * description slot is not registered by Mux's plain item parts, so the link is made on the
 * elements the list renders, now and whenever it renders again. Returns the stop function. */
function describeOptions(list: HTMLElement): () => void {
  const link = () => {
    for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
      const ids = Array.from(
        option.querySelectorAll('.bento-settings-palette__line, .bento-settings-palette__detail'),
        (part) => part.id,
      ).filter(Boolean);
      if (ids.length > 0) option.setAttribute('aria-describedby', ids.join(' '));
    }
  };
  const observer = new MutationObserver(link);
  observer.observe(list, { childList: true, subtree: true });
  link();
  return () => observer.disconnect();
}

interface RowGroup {
  group: string;
  rows: PaletteRow[];
}

/** Home and End in a single-line field, optionally extending the selection (Shift). */
function moveCaretToEdge(input: HTMLInputElement, edge: 'start' | 'end', extend: boolean): void {
  const { selectionStart, selectionEnd, value } = input;
  if (edge === 'start') {
    input.setSelectionRange(0, extend ? (selectionEnd ?? 0) : 0, extend ? 'backward' : 'none');
  } else {
    input.setSelectionRange(extend ? (selectionStart ?? 0) : value.length, value.length, 'forward');
  }
}

/** Rows under their group heading, in order of first appearance. A group that comes up
 * again later (a search result from the root and one from a sub-list) joins the first. */
function groupRows(rows: readonly PaletteRow[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const group = groups.get(row.group) ?? { group: row.group, rows: [] };
    group.rows.push(row);
    groups.set(row.group, group);
  }
  return [...groups.values()];
}

// Virtual focus starts on the first row of every stage. The Mux part forwards its props to the
// React Aria list box, whose `autoFocus` takes a strategy; the DOM attribute type only has a
// boolean, so it is passed as a plain props object.
const FOCUS_FIRST_ROW: Record<string, unknown> = { autoFocus: 'first' };

/**
 * The list of one stage. React Aria focuses the first selected row when a list mounts, so the
 * stage mounts with the row it should open on selected and drops the selection once that has
 * happened. Nothing stays selected: rows here are actions, and a selection would change how a
 * press is handled.
 */
function StageList({
  focusRow,
  editing,
  highlightRef,
  label,
  travel,
  children,
}: {
  focusRow: string | null;
  editing: boolean;
  highlightRef: (list: HTMLElement | null) => void;
  label: string;
  /** Which way the list arrived: it slides in from that side. */
  travel: 'forward' | 'back' | null;
  children: ReactNode;
}) {
  const [seeded, setSeeded] = useState(focusRow !== null);
  const stopDescribing = useRef<() => void>(undefined);
  const listRef = useCallback(
    (list: HTMLElement | null) => {
      highlightRef(list);
      stopDescribing.current?.();
      stopDescribing.current = list ? describeOptions(list) : undefined;
    },
    [highlightRef],
  );
  useEffect(() => {
    if (!seeded) return;
    // After the frame in which the list has its rows and has taken its focus.
    const frame = requestAnimationFrame(() => setSeeded(false));
    return () => cancelAnimationFrame(frame);
  }, [seeded]);
  const selection: Record<string, unknown> =
    seeded && focusRow !== null ? { selectionMode: 'single', selectedKeys: [focusRow] } : {};
  return (
    <Palette.ListBox
      ref={listRef}
      aria-label={label}
      className={`bento-settings-palette__listbox ${ROW_HIGHLIGHT_CLASS}`}
      data-travel={travel ?? undefined}
      {...FOCUS_ON_HOVER}
      {...(editing ? {} : FOCUS_FIRST_ROW)}
      {...selection}
    >
      {children}
    </Palette.ListBox>
  );
}

export default function SettingsPalette({
  view,
  actions,
  onClose,
  onBackToPalette,
  initialStages,
  initialQuery = '',
  openToken = 0,
  hideToken = 0,
}: SettingsPaletteProps) {
  const model = view.kind === 'ready' ? view.model : null;
  // Show messages can arrive before the first snapshot. Keep that request until the model
  // is ready, then validate its entire path against this window's visible controls.
  const target = useMemo(() => {
    const requested = { stages: initialStages ?? initialStack(), query: initialQuery };
    return model ? targetForModel(requested, model) : requested;
  }, [initialStages, initialQuery, model]);
  const start = useMemo(() => [...target.stages], [target.stages]);
  const [stack, setStack] = useState<Stage[]>(start);
  const [query, setQuery] = useState(target.query);
  // Which way the last move went (the list slides in from that side) and the row to open the
  // list on when going back: the one that opened the page being left. The row belongs to the
  // show it was set in (a new show's list mounts before the state is reset).
  const [travel, setTravel] = useState<'forward' | 'back' | null>(null);
  const [returnRow, setReturnRow] = useState<{ id: string; show: number } | null>(null);
  // The row that opened the stage above each depth: `openers[i]` is a row of `stack[i]`.
  const openers = useRef<(string | undefined)[]>(openerRows(start));
  const stage = topStage(stack);
  const editor = useStageEditor(stage, model, actions);
  const latest = useRef({ model, actions });
  latest.current = { model, actions };
  const [sizes] = useState(() =>
    createSizeRunner({
      model: () => latest.current.model,
      update: (changes) => latest.current.actions.update(changes),
    }),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const idBase = useId();
  const editing = isEditorStage(stage);
  const spec = editorSpecFor(stage);
  const sliderSpec = sliderSpecFor(stage);
  const sliderValue = editor.value ?? sliderSpec?.defaultValue ?? sliderSpec?.min ?? 0;
  // An editor stage keeps no focus of its own: its highlight marks the preset that matches the value.
  const highlightRef = useRowHighlight(editing ? '[role="option"][data-muxui-state-current]' : undefined);

  // The one control that holds the focus and the keys: the slider on a slider page (no search
  // field is rendered there), else the field.
  const focusPrimary = () => {
    (sliderRef.current ?? inputRef.current)?.focus();
  };

  // A slider page opens with its thumb focused.
  const sliderStageKey = sliderSpec ? stageKey(stage) : null;
  useEffect(() => {
    if (sliderStageKey !== null) focusPrimary();
    // Focus once per slider page; the helper only reads refs.
  }, [sliderStageKey]);

  // Validate the current path when a snapshot becomes ready. Search and Back remain usable
  // during loading, so readiness must not reapply the original show over those interactions.
  const began = useRef(false);
  useEffect(() => {
    if (!model) {
      began.current = false;
      return;
    }
    if (began.current) return;
    began.current = true;
    const current = targetForModel({ stages: stack, query }, model);
    if (current.stages !== stack) {
      setStack([...current.stages]);
      setQuery(current.query);
      openers.current = openerRows(current.stages);
      setReturnRow(null);
      setTravel(null);
    }
    const top = topStage(current.stages);
    if (isEditorStage(top)) editor.begin(top, model);
  });

  // A new show starts from the beginning: an unfinished edit is put back first.
  const firstShow = useRef(true);
  useEffect(() => {
    if (firstShow.current) {
      firstShow.current = false;
      return;
    }
    editor.revert();
    actions.cancelImport();
    // The notice is not cleared here: the store does that when it is told of the show, and then
    // reports what ended while the palette was hidden, which a clear after it would erase.
    setStack(start);
    setQuery(target.query);
    setTravel(null);
    setReturnRow(null);
    openers.current = openerRows(start);
    const top = topStage(start);
    if (model && isEditorStage(top)) editor.begin(top, model);
    focusPrimary();
    // Only a new show resets; the editor, model and actions are read as they are then.
  }, [openToken]);

  // Chrome hiding the palette (another overlay opened, Esc, a click outside) leaves the document
  // loaded: the live preview and its timer stop now, not at the next show, when putting the old
  // value back could overwrite one saved in the meantime from another window.
  const lastHide = useRef(hideToken);
  useEffect(() => {
    if (lastHide.current === hideToken) return;
    lastHide.current = hideToken;
    editor.revert();
    // Only a new hide acts; the editor is read as it is then.
  }, [hideToken]);

  // The palette stays mounted while chrome hides it, so the field (or slider) takes focus back on show.
  useEffect(() => {
    window.addEventListener('focus', focusPrimary);
    return () => window.removeEventListener('focus', focusPrimary);
  }, []);

  const close = useCallback(() => {
    editor.revert();
    onClose();
  }, [editor, onClose]);

  const go = (next: Stage, opener?: string) => {
    actions.clearNotice();
    setQuery('');
    if (model) editor.begin(next, model);
    const path =
      stage.kind === 'root' && opener && !opener.startsWith('category:')
        ? settingPath(opener, next)
        : pushStage(stack, next);
    openers.current = openerRows(path);
    // Keep the activated child row when the path came from a search result.
    if (path.at(-2)?.kind !== 'root') openers.current[path.length - 2] = opener;
    setReturnRow(null);
    setTravel('forward');
    setStack(path);
  };

  /** Settles the list on the stage at `depth` after going back to it. */
  const arriveAt = (depth: number) => {
    setQuery('');
    const id = openers.current[depth];
    setReturnRow(id === undefined ? null : { id, show: openToken });
    openers.current.length = depth + 1;
    setTravel('back');
  };

  const back = () => {
    if (stack.length < 2) return;
    actions.clearNotice();
    editor.revert();
    arriveAt(stack.length - 2);
    setStack((current) => popStage(current));
  };

  /** Leaves an editor stage after its value was kept. */
  const finishEdit = () => {
    if (stack.length < 2) return;
    arriveAt(stack.length - 2);
    setStack((current) => popStage(current));
  };

  /** Back button and Backspace: a stage back, or from the root to the command palette. */
  const navBack = () => {
    if (stack.length > 1) {
      back();
    } else if (onBackToPalette) {
      editor.revert();
      onBackToPalette();
    }
  };

  /** A path button: the page `depth` levels from the root. The field keeps the focus. */
  const goToDepth = (depth: number) => {
    actions.clearNotice();
    editor.revert();
    arriveAt(depth);
    setStack((current) => popToIndex(current, depth));
    inputRef.current?.focus();
  };

  const popToBackups = () => {
    setTravel(null);
    setReturnRow(null);
    setStack((current) => popToKind(current, 'backups'));
  };

  const rows = useMemo<PaletteRow[]>(() => {
    if (!model) return view.kind === 'ready' ? [] : statusRows(view);
    if (stage.kind === 'root') {
      return query ? filterRows(searchableRows(model), query) : rootRows(model);
    }
    const all = rowsForStage(stage, model);
    return isFilterable(stage) && query ? filterRows(all, query) : all;
  }, [model, view, stage, query]);

  const run = (intent: Intent, rowId?: string) => {
    if (intent.type === 'retry') {
      actions.refresh();
      return;
    }
    if (!model) return;
    // While the list is being saved its entries may be about to move: nothing that names one waits.
    if (waitsForSave(intent, sizes)) return;
    switch (intent.type) {
      case 'toggle':
        if (!model.pending.has(intent.key)) {
          void actions.update(toggleChange(intent.key, !model.settings[intent.key]));
        }
        break;
      case 'toggleAdvanced':
        if (!model.pending.has(`advanced:${intent.key}`)) {
          void actions.setAdvanced(intent.key, !intent.current);
        }
        break;
      case 'push':
        go(intent.stage, rowId);
        break;
      case 'change':
        void actions.update(intent.changes);
        back();
        break;
      case 'advanced':
        void actions.setAdvanced(intent.key, intent.value);
        back();
        break;
      case 'setProtection':
        void actions.setProtectionLevel(intent.level);
        back();
        break;
      case 'setSearch':
        void actions.setSearchEngine(intent.id);
        back();
        break;
      case 'applyNumber':
        // A click on a preset keeps it and leaves the stage, like Enter in the field. The arrows
        // only preview (they step through `editor.step`), and Esc puts the old value back.
        if (editor.keep(intent.value)) finishEdit();
        break;
      case 'link':
        if (intent.target === 'firefoxSearch') actions.openFirefoxSearchSettings();
        else actions.openMergePalette();
        close();
        break;
      case 'addSize':
      case 'moveSize':
      case 'removeSize':
        // The stage follows the entry only once the new order is saved: until then the actions
        // still belong to the entry they were opened on, and a second press is ignored.
        void sizes.run(intent).then((saved) => {
          if (saved) {
            setTravel(null);
            setReturnRow(null);
            setStack((current) => stackAfterSizeChange(current, intent));
          }
        });
        break;
      case 'export':
        if (!model.pending.has('backup')) void actions.exportBackup();
        break;
      case 'pickFile':
        fileRef.current?.click();
        break;
      case 'confirmImport':
        if (!model.pending.has('backup')) void actions.confirmImport();
        break;
      case 'cancelImport':
        actions.cancelImport();
        break;
      case 'confirm': {
        // A second Enter while the operation runs must not start it again.
        const { action } = intent;
        if (action.kind === 'reset') {
          if (model.pending.has('reset')) break;
          void actions.reset().then((done) => {
            if (done) close();
          });
        } else if (!model.pending.has('backup')) {
          const run =
            action.kind === 'restore'
              ? actions.restoreBackup(action.backupId)
              : actions.deleteBackup(action.backupId);
          void run.then(popToBackups);
        }
        break;
      }
      case 'back':
        back();
        break;
      case 'none':
        break;
    }
  };

  // One Esc is one step: clear a search, dismiss an import preview, go back a stage, or close
  // from the root. It is heard on the window, not on the field, so it works wherever the focus
  // is in the dialog (a path button, Close, Clear), and before React Aria's own Esc handling,
  // which would close the dialog from anywhere.
  const onEscape = () => {
    switch (escapeOutcome(stack, { query, importPreview: model?.importPreview != null })) {
      case 'clearQuery':
        setQuery('');
        break;
      case 'cancelImport':
        actions.cancelImport();
        break;
      case 'back':
        back();
        break;
      case 'close':
        close();
        break;
    }
  };
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /** Enter on the slider keeps the value, like Enter in the field. The arrows, Page keys, Home
   * and End are the range input's own. */
  const keepSliderValue = () => {
    if (editor.commit()) finishEdit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!editing) {
      // Backspace in an empty filter is Back.
      if (event.key === 'Backspace' && !event.repeat && query === '') {
        if (stack.length > 1 || onBackToPalette) {
          event.preventDefault();
          navBack();
        }
      }
      return;
    }
    // In an editor stage the arrows step through presets and Enter keeps the value; the
    // list's own navigation never sees them.
    if (event.key === 'Enter') {
      event.preventDefault();
      if (editor.commit()) finishEdit();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (spec) editor.step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      // The list would jump to its first or last row; here they move the caret.
      event.preventDefault();
      moveCaretToEdge(event.currentTarget, event.key === 'Home' ? 'start' : 'end', event.shiftKey);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
    }
  };

  const labelOf = (s: Stage) =>
    model ? stageLabel(s, model) : s.kind === 'root' ? 'Settings' : '';
  const path = pathLabels(stack, labelOf);
  const currentLabel = path[path.length - 1] ?? 'Settings';
  const canGoBack = stack.length > 1 || onBackToPalette !== undefined;
  const backLabel =
    stack.length > 1
      ? `Back to ${path[path.length - 2]}`
      : onBackToPalette
        ? 'Back to Command palette'
        : 'Back';
  const fieldValue = editing ? editor.draft : query;
  // A short list has no field row. The input stays, hidden and read-only, because it holds the
  // focus and carries the arrow keys, Enter, Esc and Backspace for the list.
  const listRowCount = useMemo(
    () => (model ? rowsForStage(stage, model).length : 0),
    [model, stage],
  );
  const fieldShown = showsFieldRow(stage, listRowCount, query);
  const onFieldChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.currentTarget.value;
    if (editing) editor.type(text);
    else if (fieldShown) setQuery(text);
  };

  const searching = stage.kind === 'root' && query !== '';
  const groups = groupRows(rows);
  const withHeaders = showsGroupHeaders(stage, searching);
  // The shortcuts are all static rows, and still the thing the footer counts there.
  const counted = stage.kind === 'shortcuts' ? rows.length : rows.filter((row) => !row.info).length;
  const footer: FooterCopy = model
    ? footerFor(stage, model, counted, editing ? '' : query)
    : { hints: view.kind === 'error' ? ['Enter try again', 'Esc close'] : ['Esc close'] };
  const notice = model?.notice ?? null;
  const placeholder = stage.kind === 'root' ? 'Search settings' : 'Filter';
  const fieldLabel = editing
    ? `${currentLabel} value`
    : stage.kind === 'root'
      ? 'Search settings'
      : fieldShown
        ? `Filter ${currentLabel}`
        : currentLabel;
  // The row a stage opens on: the one that opened the page when going back, else the current
  // choice of a list of choices. An editor stage focuses no row.
  const returnTo = returnRow?.show === openToken ? returnRow.id : null;
  const focusRow = editing
    ? null
    : (returnTo ?? rows.find((row) => row.radio === 'on' && !row.info)?.id ?? null);

  const description = pageDescription(stage);
  const descriptionId = `${idBase}-page`;
  const lineId = (row: PaletteRow) => `${idBase}-${row.id}-line`;
  const detailId = (row: PaletteRow) => `${idBase}-${row.id}-detail`;

  const renderRow = (row: PaletteRow) => (
    <Palette.Item
      key={row.id}
      id={row.id}
      textValue={[row.label, row.note, row.value].filter(Boolean).join(' ')}
      aria-label={rowAriaLabel(row)}
      disabled={row.info}
      onActivate={() => run(row.intent, row.id)}
      className="bento-settings-palette__item"
      data-tone={row.tone}
      data-info={row.info ? '' : undefined}
      data-pending={row.pending ? '' : undefined}
      data-switch={row.switchOn !== undefined ? '' : undefined}
      data-separated={row.separated ? '' : undefined}
      data-detail={row.detail ? '' : undefined}
      data-described={row.description ? '' : undefined}
      data-current={
        spec && row.intent.type === 'applyNumber' && row.intent.value === editor.value
          ? ''
          : undefined
      }
    >
      {row.radio ? (
        <Palette.ItemIcon>
          <span
            className="bento-settings-palette__radio"
            data-on={row.radio === 'on' ? '' : undefined}
          />
        </Palette.ItemIcon>
      ) : null}
      {row.engine ? (
        <Palette.ItemIcon>
          <span className="bento-settings-palette__engine" aria-hidden="true">
            {row.engine.name.charAt(0)}
          </span>
        </Palette.ItemIcon>
      ) : null}
      {row.tone === 'warning' ? (
        <Palette.ItemIcon>
          <BentoIcon icon={TriangleAlertIcon} size="sm" />
        </Palette.ItemIcon>
      ) : null}
      <Palette.ItemContent className="bento-settings-palette__item-content">
        <Palette.ItemTitle className="bento-settings-palette__label">{row.label}</Palette.ItemTitle>
      </Palette.ItemContent>
      {row.note ? <span className="bento-settings-palette__note">{row.note}</span> : null}
      <span className="bento-settings-palette__spacer" aria-hidden="true" />
      {row.switchOn !== undefined ? (
        // Presentational: the row is the control. Inert keeps the switch out of the tab order and
        // out of hit testing (a click lands on the row), and hidden from assistive technology,
        // which reads On or Off from the row's text value.
        <span className="bento-settings-palette__switch" aria-hidden="true" inert>
          <SwitchField.Root size="sm" aria-label={row.label} checked={row.switchOn}>
            <SwitchField.Button>
              <SwitchField.Thumb />
            </SwitchField.Button>
          </SwitchField.Root>
        </span>
      ) : row.value ? (
        <Palette.ItemMeta className="bento-settings-palette__value">{row.value}</Palette.ItemMeta>
      ) : null}
      {row.trail ? (
        <span className="bento-settings-palette__trail" aria-hidden="true">
          <BentoIcon icon={TRAIL_ICONS[row.trail]} size="xs" />
        </span>
      ) : null}
      {row.description ? (
        <Palette.ItemDescription id={lineId(row)} className="bento-settings-palette__line">
          {row.description}
        </Palette.ItemDescription>
      ) : null}
      {row.detail ? (
        <div id={detailId(row)} className="bento-settings-palette__detail">
          <div>
            <p className="bento-settings-palette__detail-heading">Benefits</p>
            <ul data-kind="benefits">
              {row.detail.benefits.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="bento-settings-palette__detail-heading">Caveats</p>
            <ul data-kind="caveats">
              {row.detail.caveats.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </Palette.Item>
  );

  return (
    <Palette.Root
      className="bento-settings-palette"
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Palette.Backdrop dismissable>
        <Palette.Popup aria-label="Settings" className="bento-settings-palette__dialog">
          <Palette.Content
            className="bento-settings-palette__content"
            data-editing={editing ? '' : undefined}
          >
            <div className="bento-settings-palette__nav">
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={backLabel}
                disabled={!canGoBack}
                onActivate={navBack}
              >
                <BentoIcon icon={ChevronLeftIcon} size="sm" />
              </IconButton>
              <nav className="bento-settings-palette__path" aria-label="Settings path">
                <ol>
                  {onBackToPalette ? (
                    <li>
                      <Button variant="ghost" size="sm" onActivate={onBackToPalette}>
                        Command palette
                      </Button>
                      <span className="bento-settings-palette__path-separator" aria-hidden="true">
                        /
                      </span>
                    </li>
                  ) : null}
                  {path.map((label, depth) => {
                    const isCurrent = depth === path.length - 1;
                    return (
                      <li key={`${depth}:${label}`}>
                        {isCurrent ? (
                          <span
                            className="bento-settings-palette__path-current"
                            aria-current="page"
                          >
                            {label}
                          </span>
                        ) : (
                          <>
                            <Button variant="ghost" size="sm" onActivate={() => goToDepth(depth)}>
                              {label}
                            </Button>
                            <span
                              className="bento-settings-palette__path-separator"
                              aria-hidden="true"
                            >
                              /
                            </span>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </nav>
              <Palette.Close
                aria-label="Close settings"
                className="bento-settings-palette__close"
              />
            </div>
            {description ? (
              // Static text, not focusable and not in the tab order; the field is described by it.
              <Palette.Description
                id={descriptionId}
                className="bento-settings-palette__page-description"
              >
                {description}
              </Palette.Description>
            ) : null}
            {sliderSpec ? (
              // The slider page: a native range input holds the focus and the keys, so there is no
              // search field or list here. Arrows, Page keys, Home and End are the input's own;
              // Enter keeps the value, and Esc is heard on the window like everywhere.
              <div className="bento-settings-palette__slider-stage">
                <div className="bento-settings-palette__slider-block">
                  <p className="bento-settings-palette__slider-readout" aria-hidden="true">
                    <span>{sliderValue}</span>
                    {sliderSpec.unit ? <span> {sliderSpec.unit}</span> : null}
                  </p>
                  <RangeSlider
                    key={stageKey(stage)}
                    inputRef={sliderRef}
                    label={currentLabel}
                    describedBy={description ? descriptionId : undefined}
                    min={sliderSpec.min}
                    max={sliderSpec.max}
                    value={sliderValue}
                    valueText={formatNumber(sliderSpec, sliderValue)}
                    onChange={editor.slide}
                    onEnter={keepSliderValue}
                  />
                  <p className="bento-settings-palette__slider-info">
                    {sliderSpec.defaultValue !== undefined ? (
                      <span>Default {formatNumber(sliderSpec, sliderSpec.defaultValue)}</span>
                    ) : null}
                    <span>
                      {sliderSpec.min} to {formatNumber(sliderSpec, sliderSpec.max)}
                    </span>
                  </p>
                </div>
              </div>
            ) : (
              <>
                <Palette.SearchField
                  className="bento-settings-palette__field"
                  data-hidden={fieldShown ? undefined : ''}
                  aria-label={fieldLabel}
                  aria-describedby={description ? descriptionId : undefined}
                >
                  <Palette.Input
                    ref={inputRef}
                    className="bento-settings-palette__input"
                    placeholder={editing ? undefined : placeholder}
                    value={fieldValue}
                    onChange={onFieldChange}
                    onKeyDown={handleKeyDown}
                    aria-label={fieldLabel}
                    aria-describedby={description ? descriptionId : undefined}
                    readOnly={fieldShown ? undefined : true}
                    aria-invalid={editing && editor.problem ? true : undefined}
                    inputMode={spec ? 'numeric' : undefined}
                    data-editing={editing ? '' : undefined}
                    // A number stage gives the input one fixed width (see the stylesheet).
                    data-number={spec ? '' : undefined}
                    autoFocus
                  />
                  {spec ? (
                    <>
                      {spec.unit ? (
                        <span className="bento-settings-palette__unit">{spec.unit}</span>
                      ) : null}
                      <span
                        className="bento-settings-palette__bounds"
                        data-invalid={editor.problem ? '' : undefined}
                        role="status"
                      >
                        {editor.problem ?? `${spec.min} to ${spec.max}`}
                      </span>
                    </>
                  ) : null}
                  {!editing && query.length > 0 ? (
                    <Palette.ClearButton
                      aria-label="Clear search"
                      onClick={() => setQuery('')}
                      {...IN_TAB_ORDER}
                    />
                  ) : null}
                </Palette.SearchField>
                <StageList
                  // A new show remounts the list too, so it opens on its first row, scrolled to the top.
                  key={`${openToken}:${view.kind}:${stageKey(stage)}:${model?.importPreview ? 'preview' : ''}`}
                  focusRow={focusRow}
                  editing={editing}
                  highlightRef={highlightRef}
                  label={labelOf(stage) || 'Settings'}
                  travel={travel}
                >
                  {withHeaders
                    ? groups.map((group) => (
                        <Palette.Section
                          key={group.group}
                          className="bento-settings-palette__section"
                        >
                          <Palette.SectionHeader className="bento-settings-palette__heading">
                            {group.group}
                          </Palette.SectionHeader>
                          {group.rows.map(renderRow)}
                        </Palette.Section>
                      ))
                    : rows.map(renderRow)}
                </StageList>
                {view.kind === 'ready' && rows.length === 0 && !editing ? (
                  <Palette.Empty>No matching settings.</Palette.Empty>
                ) : null}
              </>
            )}
            <Palette.Footer className="bento-settings-palette__footer">
              <span className="bento-settings-palette__hints">
                {notice ? (
                  <span className="bento-settings-palette__notice" data-kind="error" role="status">
                    {notice}
                  </span>
                ) : footer.note ? (
                  <span className="bento-settings-palette__notice">{footer.note}</span>
                ) : null}
                {footer.hints.map((hint) => (
                  <span key={hint}>{hint}</span>
                ))}
              </span>
              {footer.status ? (
                <span className="bento-settings-palette__status">{footer.status}</span>
              ) : null}
            </Palette.Footer>
          </Palette.Content>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Bento backup file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void actions.pickImportFile(file);
            }}
          />
        </Palette.Popup>
      </Palette.Backdrop>
    </Palette.Root>
  );
}
