// Layer-2 component: SettingsPalette.
//
// Bento's settings as a staged quick pick on the Mux CommandPalette parts. The root lists every
// setting grouped, with its value on the right; choosing a row toggles it in place or opens a
// stage (a list of choices, or a number or name typed in the search field). The search field
// shows the path and Esc goes back one stage, closing from the root.
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
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { CommandPalette as Palette } from '@muxui/react';
import ChevronRightIcon from 'lucide-react/dist/esm/icons/chevron-right';
import ExternalLinkIcon from 'lucide-react/dist/esm/icons/external-link';
import PlusIcon from 'lucide-react/dist/esm/icons/plus';
import SearchIcon from 'lucide-react/dist/esm/icons/search';
import TriangleAlertIcon from 'lucide-react/dist/esm/icons/triangle-alert';

import { BentoIcon } from '../primitives';
import { moveEntry, removeAt, toggleChange } from './editing';
import {
  editorSpecFor,
  filterRows,
  footerFor,
  isFilterable,
  rootRows,
  rowsForStage,
  searchableRows,
  stageLabel,
  statusRows,
  type FooterCopy,
  type Intent,
  type PaletteRow,
} from './rows';
import { PANEL_SIZE_LIMITS } from './settingsCatalog';
import {
  crumbPrefix,
  crumbsFor,
  initialStack,
  isEditorStage,
  popStage,
  popToKind,
  pushStage,
  replaceTop,
  stageKey,
  topStage,
  type Stage,
} from './stageStack';
import type { SettingsPaletteActions, SettingsPaletteView } from './types';
import { useStageEditor } from './useStageEditor';
import './SettingsPalette.css';

export interface SettingsPaletteProps {
  view: SettingsPaletteView;
  actions: SettingsPaletteActions;
  /** Dismisses the palette (Esc from the root, the backdrop, the close button, a finished reset). */
  onClose: () => void;
  /** Stages to start on, root first. The root alone by default. */
  initialStages?: readonly Stage[];
  /** Search text to start with (a link to a setting that has no list of its own). */
  initialQuery?: string;
  /** Changes on every show; the palette returns to `initialStages` when it does. */
  openToken?: number;
}

const TRAIL_ICONS = {
  '›': ChevronRightIcon,
  '↗': ExternalLinkIcon,
  '+': PlusIcon,
} as const;

/** The stages whose rows are headed by their group (the others are one plain list). */
function showsGroupHeaders(stage: Stage, searching: boolean): boolean {
  if (searching) return true;
  return (
    stage.kind === 'root' ||
    stage.kind === 'number' ||
    stage.kind === 'sizeEdit' ||
    stage.kind === 'backups' ||
    stage.kind === 'confirm'
  );
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

export default function SettingsPalette({
  view,
  actions,
  onClose,
  initialStages,
  initialQuery = '',
  openToken = 0,
}: SettingsPaletteProps) {
  const model = view.kind === 'ready' ? view.model : null;
  const start = useMemo(() => [...(initialStages ?? initialStack())], [initialStages]);
  const [stack, setStack] = useState<Stage[]>(start);
  const [query, setQuery] = useState(initialQuery);
  const stage = topStage(stack);
  const editor = useStageEditor(stage, model, actions);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editing = isEditorStage(stage);
  const spec = editorSpecFor(stage);

  // Begins the editor of a stage the palette opened on (a story, a deep link) once the model is there.
  const began = useRef(false);
  useEffect(() => {
    if (began.current || !model) return;
    began.current = true;
    if (isEditorStage(stage)) editor.begin(stage, model);
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
    actions.clearNotice();
    setStack(start);
    setQuery(initialQuery);
    const top = topStage(start);
    if (model && isEditorStage(top)) editor.begin(top, model);
    inputRef.current?.focus();
    // Only a new show resets; the editor, model and actions are read as they are then.
  }, [openToken]);

  // The palette stays mounted while chrome hides it, so the field takes focus back on show.
  useEffect(() => {
    const focusField = () => inputRef.current?.focus();
    window.addEventListener('focus', focusField);
    return () => window.removeEventListener('focus', focusField);
  }, []);

  const close = useCallback(() => {
    editor.revert();
    onClose();
  }, [editor, onClose]);

  const go = (next: Stage) => {
    actions.clearNotice();
    setQuery('');
    if (model) editor.begin(next, model);
    setStack((current) => pushStage(current, next));
  };

  const back = () => {
    actions.clearNotice();
    editor.revert();
    setQuery('');
    setStack((current) => popStage(current));
  };

  /** Leaves an editor stage after its value was kept. */
  const finishEdit = () => {
    setQuery('');
    setStack((current) => popStage(current));
  };

  const popToBackups = () => setStack((current) => popToKind(current, 'backups'));

  const rows = useMemo<PaletteRow[]>(() => {
    if (!model) return view.kind === 'ready' ? [] : statusRows(view);
    if (stage.kind === 'root') {
      return query ? filterRows(searchableRows(model), query) : rootRows(model);
    }
    const all = rowsForStage(stage, model);
    return isFilterable(stage) && query ? filterRows(all, query) : all;
  }, [model, view, stage, query]);

  const run = (intent: Intent) => {
    if (intent.type === 'retry') {
      actions.refresh();
      return;
    }
    if (!model) return;
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
        go(intent.stage);
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
        editor.choose(intent.value);
        break;
      case 'link':
        if (intent.target === 'firefoxSearch') actions.openFirefoxSearchSettings();
        else actions.openMergePalette();
        close();
        break;
      case 'addSize': {
        const sizes = model.settings.customPanelSizes;
        const size = Math.min(
          PANEL_SIZE_LIMITS.max,
          Math.max(PANEL_SIZE_LIMITS.min, model.settings.defaultPanelWidthPx),
        );
        void actions.update({ customPanelSizes: [...sizes, size] });
        break;
      }
      case 'moveSize':
        void actions.update({
          customPanelSizes: moveEntry(model.settings.customPanelSizes, intent.index, intent.delta),
        });
        // The actions follow the entry to its new place.
        setStack((current) =>
          replaceTop(current, { kind: 'sizeActions', index: intent.index + intent.delta }),
        );
        break;
      case 'removeSize':
        void actions.update({
          customPanelSizes: removeAt(model.settings.customPanelSizes, intent.index),
        });
        back();
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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // One Esc clears a search first, then goes back a stage, then closes from the root.
      if (!editing && query !== '') setQuery('');
      else if (stack.length > 1) back();
      else close();
      return;
    }
    if (!editing) return;
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

  const labelOf = (s: Stage) => (model ? stageLabel(s, model) : '');
  const crumbs = crumbsFor(stack, labelOf);
  const fieldValue = editing ? editor.draft : query;
  const onFieldChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.currentTarget.value;
    if (editing) editor.type(text);
    else setQuery(text);
  };

  const searching = stage.kind === 'root' && query !== '';
  const groups = groupRows(rows);
  const withHeaders = showsGroupHeaders(stage, searching || (isFilterable(stage) && query !== ''));
  // The shortcuts are all static rows, and still the thing the footer counts there.
  const counted = stage.kind === 'shortcuts' ? rows.length : rows.filter((row) => !row.info).length;
  const footer: FooterCopy = model
    ? footerFor(stage, model, counted)
    : { hints: view.kind === 'error' ? ['Enter try again', 'Esc close'] : ['Esc close'] };
  const notice = model?.notice ?? null;
  const placeholder = stage.kind === 'root' ? 'Search settings' : undefined;
  const fieldLabel = editing
    ? `${crumbs.current ?? 'Setting'} value`
    : stage.kind === 'root'
      ? 'Search settings'
      : `Filter ${crumbs.current ?? ''}`;

  const renderRow = (row: PaletteRow) => (
    <Palette.Item
      key={row.id}
      id={row.id}
      textValue={[row.label, row.value].filter(Boolean).join(' ')}
      disabled={row.info}
      onActivate={() => run(row.intent)}
      className="bento-settings-palette__item"
      data-tone={row.tone}
      data-info={row.info ? '' : undefined}
      data-pending={row.pending ? '' : undefined}
      data-separated={row.separated ? '' : undefined}
      data-detail={row.detail ? '' : undefined}
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
      <Palette.ItemContent>
        <Palette.ItemTitle className="bento-settings-palette__label">{row.label}</Palette.ItemTitle>
      </Palette.ItemContent>
      {row.value ? (
        <Palette.ItemMeta className="bento-settings-palette__value">{row.value}</Palette.ItemMeta>
      ) : null}
      {row.trail ? (
        <span className="bento-settings-palette__trail" aria-hidden="true">
          <BentoIcon icon={TRAIL_ICONS[row.trail]} size="xs" />
        </span>
      ) : null}
      {row.detail ? (
        <div className="bento-settings-palette__detail">
          <p>{row.detail.summary}</p>
          <p className="bento-settings-palette__detail-heading">Benefits</p>
          <ul data-kind="benefits">
            {row.detail.benefits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="bento-settings-palette__detail-heading">Caveats</p>
          <ul data-kind="caveats">
            {row.detail.caveats.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
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
            <Palette.SearchField className="bento-settings-palette__field" aria-label={fieldLabel}>
              <BentoIcon
                icon={SearchIcon}
                size="sm"
                className="bento-settings-palette__search-icon"
              />
              {stage.kind !== 'root' ? (
                <span className="bento-settings-palette__crumbs">
                  {crumbPrefix(editing ? [...crumbs.trail, crumbs.current ?? ''] : crumbs.trail)}
                  {editing ? null : (
                    <span className="bento-settings-palette__crumb-current">{crumbs.current}</span>
                  )}
                </span>
              ) : null}
              <Palette.Input
                ref={inputRef}
                className="bento-settings-palette__input"
                placeholder={placeholder}
                value={fieldValue}
                onChange={onFieldChange}
                onKeyDown={handleKeyDown}
                aria-label={fieldLabel}
                aria-invalid={editing && editor.problem ? true : undefined}
                inputMode={spec ? 'numeric' : undefined}
                // The number or name sizes the field to itself (the digits' width, plus one for the caret).
                style={
                  editing ? { inlineSize: `${Math.max(1, editor.draft.length) + 1}ch` } : undefined
                }
                data-editing={editing ? '' : undefined}
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
              {stage.kind === 'text' && editor.problem ? (
                <span className="bento-settings-palette__bounds" data-invalid="" role="status">
                  {editor.problem}
                </span>
              ) : null}
              {!editing && query.length > 0 ? (
                <Palette.ClearButton aria-label="Clear search" onClick={() => setQuery('')} />
              ) : null}
              <Palette.Close
                aria-label="Close settings"
                className="bento-settings-palette__close"
              />
            </Palette.SearchField>
            <Palette.ListBox
              key={`${view.kind}:${stageKey(stage)}:${model?.importPreview ? 'preview' : ''}`}
              aria-label={labelOf(stage) || 'Settings'}
              className="bento-settings-palette__listbox"
              {...(editing ? {} : FOCUS_FIRST_ROW)}
            >
              {withHeaders
                ? groups.map((group) => (
                    <Palette.Section key={group.group} className="bento-settings-palette__section">
                      <Palette.SectionHeader className="bento-settings-palette__heading">
                        {group.group}
                      </Palette.SectionHeader>
                      {group.rows.map(renderRow)}
                    </Palette.Section>
                  ))
                : rows.map(renderRow)}
            </Palette.ListBox>
            {view.kind === 'ready' && rows.length === 0 && !editing && stage.kind !== 'text' ? (
              <Palette.Empty>No matching settings.</Palette.Empty>
            ) : null}
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
