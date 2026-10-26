import { afterMotion } from '../motion/afterMotion';
import { measureRailWidth, RAIL_ATTRIBUTE } from './railViewport';
import type { RailPhase, RailTransitionHost } from './railTransition';

// The DOM side of the rail transition (railTransition.ts): reads the moving elements'
// boxes in the expanded and rail layouts, writes the offsets the keyframes in
// railTransition.css read, and the per-row stagger delays.
//
// Rows share their geometry, so one tab row (and one folder row) is measured and its
// offsets go on the app root as inherited properties the row rules read; the few
// single elements get their own --bento-rail-x / --bento-rail-y. Each offset is
// relative to the nearest moving ancestor, and every position is rounded to device
// pixels first, as the settled layout is. Folder children are indented and the rail
// drops the indent, so an indented row has its own offsets: measured from an indented
// row when the list shows one, otherwise derived from a plain row and the indent (and
// the other way round when the window holds only folder children).

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PARTS = {
  main: '.bento-shell-app__main',
  pinned: '.bento-pinned-panels',
  avatar: '.bento-workspace-switcher__avatar-frame',
  region: '.bento-shell-app__list-region',
  newIcon: '.bento-tab-list__new-action-button svg',
  // The Search trigger, and the open search field's row: the field closes into the trigger's
  // box (its right end, as an Esc close does) and the folded square then travels with the
  // trigger, so both take the trigger's offset.
  search: '.bento-tab-list__search-trigger',
  field: '.bento-tab-list-search__field-row',
  scroller: '.bento-tab-list-pane__scroller',
  viewport: '.bento-tab-list__viewport',
  tab: '.bento-tab-list__row > .bento-tab-row:not(.bento-tab-row--indented)',
  indented: '.bento-tab-list__row > .bento-tab-row--indented',
  folder: '.bento-tab-list__row > .bento-folder-row',
  footer: '.bento-shell-app__footer',
} as const;

type Part = keyof typeof PARTS;

/** Single elements that carry their own offset (rows read theirs from the root). */
const SINGLES = [
  'main',
  'pinned',
  'avatar',
  'region',
  'newIcon',
  'search',
  'field',
  'scroller',
  'viewport',
] as const;
type Single = (typeof SINGLES)[number];
type Offset = [number, number];

interface StaggeredRow {
  row: HTMLElement;
  text: HTMLElement[];
  trailing: HTMLElement[];
  /** Visible position from the top of the list, 0 for rows scrolled above it. */
  index: number;
}

interface Layout {
  boxes: Partial<Record<Part, Box>>;
  /** A tab row's favicon and a folder row's icon, relative to their own row. */
  favicon?: Box;
  folderIcon?: Box;
  footerButtons: Box[];
  rows: StaggeredRow[];
}

/** A tab row's move to its rail place, and how far its active fill's tail retracts. */
export interface RowShift {
  x: number;
  y: number;
  tail: number;
}

/**
 * Plain and indented tab rows' shifts from whichever was measured. The rail drops a
 * folder child's indent, so an indented row moves `indent` further left and its tail
 * is `indent` shorter; with neither measured both are 0 (and the list has no tab rows).
 */
export function tabRowShifts(
  plain: RowShift | null,
  indented: RowShift | null,
  indent: number,
): { plain: RowShift; indented: RowShift } {
  const base = plain ??
    (indented && { ...indented, x: indented.x + indent, tail: indented.tail + indent }) ?? {
      x: 0,
      y: 0,
      tail: 0,
    };
  return {
    plain: base,
    indented: indented ?? { ...base, x: base.x - indent, tail: base.tail - indent },
  };
}

/**
 * Where the search square and the field row are while a phase animates them, read at a
 * reversal. The next phase's keyframes start from these (--bento-rail-seed-*) rather than
 * from their own start state, so a reversed square carries on from where it is.
 */
interface Seed {
  search: Offset | null;
  field: { offset: Offset; margin: number; padding: number; text: number } | null;
}

/**
 * Set on the Search trigger for a collapse that folds a field. The trigger is hidden then, but
 * it keeps the field row's timing for the whole phase (TabList.css), so a reversal into an
 * expand that parks nothing starts the trigger where the row was. A phase-long marker, not
 * `data-folding`, which TabList clears in the commit that reverses the phase.
 */
const FOLDING_TRIGGER_ATTRIBUTE = 'data-rail-folding';

const SEED_PROPERTIES = [
  '--bento-rail-seed-x',
  '--bento-rail-seed-y',
  '--bento-rail-seed-margin',
  '--bento-rail-seed-padding',
  '--bento-rail-seed-text',
] as const;

/** The motion-check-safe part of an Animation this module touches. */
interface PhaseAnimation {
  animationName?: string;
  finish(): void;
}

/**
 * Elements React mounts while a phase runs (a workspace switch swaps the tab list
 * pane, the virtualizer adds rows) start their animations late and would still be
 * moving when the phase ends. `prepare` gives a new pane's single elements their
 * offsets, then every phase animation in the added subtree is finished, so it holds
 * the phase's end state: the rail place in a collapse, the expanded one in an expand.
 */
export function finishAdded(nodes: Iterable<Node>, prepare: (el: Element) => void): void {
  for (const node of nodes) {
    if (!('getAnimations' in node)) continue;
    const el = node as Element;
    prepare(el);
    for (const animation of el.getAnimations({ subtree: true }) as PhaseAnimation[]) {
      if (isPhaseMove(animation.animationName)) animation.finish();
    }
  }
}

const HOLD_ANIMATION = 'bento-rail-hold';
// Only the rail keyframes (railTransition.css). An added row can also carry a loading
// spinner (infinite: finish() throws) or the workspace slide, which must keep running.
const isPhaseMove = (name: string | undefined) =>
  !!name && name.startsWith('bento-rail-') && name !== HOLD_ANIMATION;

const SPRING = 'var(--muxui-semantic-motion-reveal-transition-spring-duration)';
/** The stagger unit is 1/32 of the spring duration. Header items take units 0 to 2
 *  (fixed in railTransition.css), rows start at 3. */
const UNIT = 1 / 32;
const FIRST_ROW_UNIT = 3;
// Rows past this many units share the last delay, so a collapse's last row move
// (0.6 of the spring) ends by 0.95 of it: (3 + 8) / 32 + 0.6.
const LAST_ROW_UNIT = 11;
/** Fade-in offsets an expand adds before a row's text and trailing controls. */
const EXPAND_TEXT_DELAY = 0.15;
const EXPAND_TRAILING_DELAY = 0.3;

const delay = (fraction: number) => 'calc(' + SPRING + ' * ' + fraction.toFixed(4) + ')';

function box(el: Element | null | undefined): Box | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Width in px of the folder indent token (a probe, as measureRailWidth does). */
function measureIndent(doc: Document): number {
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--bento-tab-folder-indent)';
  doc.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

export function createRailTransitionDom(
  root: HTMLElement,
  doc: Document = root.ownerDocument,
): RailTransitionHost {
  const html = doc.documentElement;
  const view = doc.defaultView;
  const dpr = () => view?.devicePixelRatio || 1;
  const px = (value: number) => Math.round(value * dpr()) / dpr();
  const find = (part: Part) => root.querySelector<HTMLElement>(PARTS[part]);
  // A workspace slide holds two panes; the incoming one is last.
  const findLast = (part: Part) =>
    Array.from(root.querySelectorAll<HTMLElement>(PARTS[part])).pop();
  const footerChildren = () =>
    Array.from(find('footer')?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );

  let written: HTMLElement[] = [];
  let delayed: HTMLElement[] = [];
  let singles: Partial<Record<Single, Offset>> = {};
  let watcher: MutationObserver | null = null;

  const readRows = (): StaggeredRow[] => {
    const scroller = find('scroller');
    const viewport = find('viewport');
    const first = viewport?.querySelector(':scope > .bento-tab-list__row');
    if (!scroller || !viewport || !first) return [];
    const style = view?.getComputedStyle(scroller);
    const gap = parseFloat(style?.paddingTop ?? '') || 0;
    const pitch = first.getBoundingClientRect().height + gap;
    const top = scroller.getBoundingClientRect().top + gap;
    const rows: StaggeredRow[] = [];
    for (const row of Array.from(viewport.children)) {
      if (!(row instanceof HTMLElement) || !row.classList.contains('bento-tab-list__row')) continue;
      const index = Math.max(0, Math.round((row.getBoundingClientRect().top - top) / pitch));
      rows.push({
        row,
        index,
        text: Array.from(
          row.querySelectorAll<HTMLElement>(
            ':scope > .bento-tab-row > .muxui-text, :scope > .bento-folder-row > .muxui-text',
          ),
        ),
        trailing: Array.from(
          row.querySelectorAll<HTMLElement>(
            '.bento-tab-row__actions, .bento-tab-row__audio-control',
          ),
        ),
      });
    }
    return rows;
  };

  // `inner`'s box relative to its row, both rounded to device pixels.
  const within = (row: Element | null, inner: string): Box | undefined => {
    const a = box(row);
    const b = box(row?.querySelector(inner));
    return a && b && { x: px(b.x) - px(a.x), y: px(b.y) - px(a.y), w: b.w, h: b.h };
  };

  const read = (withRows: boolean): Layout | null => {
    const main = find('main');
    if (!main) return null;
    const boxes: Layout['boxes'] = {};
    for (const part of Object.keys(PARTS) as Part[]) boxes[part] = box(find(part));
    return {
      boxes,
      favicon: within(find('tab') ?? find('indented'), '.bento-tab-row__favicon'),
      folderIcon: within(find('folder'), '.bento-folder-row__icon'),
      footerButtons: footerChildren().map((el) => box(el)!),
      rows: withRows ? readRows() : [],
    };
  };

  const clear = () => {
    watcher?.disconnect();
    watcher = null;
    singles = {};
    for (const el of written) {
      el.style.removeProperty('--bento-rail-x');
      el.style.removeProperty('--bento-rail-y');
      el.removeAttribute(FOLDING_TRIGGER_ATTRIBUTE);
      for (const name of SEED_PROPERTIES) el.style.removeProperty(name);
    }
    for (const el of delayed) el.style.animationDelay = '';
    for (const name of ROOT_PROPERTIES) root.style.removeProperty(name);
    written = [];
    delayed = [];
  };

  return {
    html,
    read: () => read(true),

    readAsRail() {
      // Chrome pins the host at the token rounded to whole CSS pixels (52, from 51.8),
      // so the settled rail is laid out at that width, not at the token's.
      const width = Math.round(measureRailWidth(doc));
      if (width <= 0) return null;
      const scroller = find('scroller');
      const scrollTop = scroller?.scrollTop ?? 0;
      const inlineWidth = root.style.width;
      root.style.width = `${width}px`;
      html.setAttribute(RAIL_ATTRIBUTE, 'true');
      const layout = read(false);
      html.removeAttribute(RAIL_ATTRIBUTE);
      root.style.width = inlineWidth;
      // A shorter rail list may have clamped the scroll position; the expanded list keeps it.
      if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
      return layout;
    },

    capture() {
      // Across is the `translate` property, down is `transform` (matrix(a, b, c, d, tx, ty)).
      const translate = (el: HTMLElement | undefined): Offset | null => {
        if (!el || !view) return null;
        const style = view.getComputedStyle(el);
        const x = Number(style.translate.match(/-?\d*\.?\d+/)?.[0] ?? 0);
        const y = Number(style.transform.match(/matrix\(([^)]*)\)/)?.[1]?.split(',')[5] ?? 0);
        return [x, y];
      };
      const fieldRow = findLast('field');
      const input = fieldRow?.querySelector<HTMLElement>('.bento-tab-list-search__input');
      const fieldStyle = fieldRow && view?.getComputedStyle(fieldRow);
      const fieldOffset = translate(fieldRow);
      // While a field shows, its row is the visible square and the trigger (hidden) has its own
      // timing: the trigger carries on from the row's place.
      const fieldShows = !!fieldRow?.closest('[data-folding], [data-open]');
      const seed: Seed = {
        search: fieldShows ? fieldOffset : translate(findLast('search')),
        field:
          fieldStyle && fieldOffset
            ? {
                offset: fieldOffset,
                margin: parseFloat(fieldStyle.marginInlineStart) || 0,
                padding: parseFloat(fieldStyle.paddingInlineStart) || 0,
                text: input ? parseFloat(view!.getComputedStyle(input).opacity) : 1,
              }
            : null,
      };
      return seed;
    },

    apply(phase, expandedLayout, railLayout, seedLayout) {
      clear();
      const expanded = expandedLayout as Layout;
      const rail = railLayout as Layout;
      const zero: [number, number] = [0, 0];
      const shift = (a: Box | undefined, b: Box | undefined): [number, number] =>
        a && b && b.w + b.h > 0 ? [px(b.x) - px(a.x), px(b.y) - px(a.y)] : zero;
      const minus = (a: [number, number], b: [number, number]): [number, number] => [
        a[0] - b[0],
        a[1] - b[1],
      ];
      const d = (part: Part) => shift(expanded.boxes[part], rail.boxes[part]);
      const relative = (a: Box | undefined, b: Box | undefined): Offset =>
        a && b ? [b.x - a.x, b.y - a.y] : zero;

      const main = d('main');
      const region = d('region');
      const scroller = d('scroller');
      // The list's own content moves only by what the scroll position changed.
      const viewport: [number, number] = [0, d('viewport')[1] - scroller[1]];
      const list: [number, number] = [scroller[0], scroller[1] + viewport[1]];
      const tail = (part: Part) =>
        Math.max(0, px(expanded.boxes[part]?.w ?? 0) - px(rail.boxes[part]?.w ?? 0));
      const measured = (part: 'tab' | 'indented'): RowShift | null => {
        if (!expanded.boxes[part]?.w || !rail.boxes[part]?.w) return null;
        const [x, y] = minus(d(part), list);
        return { x, y, tail: tail(part) };
      };
      const plainRow = measured('tab');
      const indentedRow = measured('indented');
      const rows = tabRowShifts(
        plainRow,
        indentedRow,
        plainRow && indentedRow ? 0 : measureIndent(doc),
      );
      const tab: Offset = [rows.plain.x + list[0], rows.plain.y + list[1]];
      const folder = expanded.boxes.folder?.w ? d('folder') : tab;
      const pinnedWidth = expanded.boxes.pinned?.w ?? 0;
      const offsets: Record<Single, Offset> = {
        main,
        pinned: [-px(pinnedWidth), 0],
        avatar: minus(d('avatar'), main),
        region: minus(region, main),
        newIcon: minus(d('newIcon'), region),
        // The trigger moves to its rail slot. The open field shrinks onto the trigger's box
        // and rides the same offset, so it is the trigger for the rest of the move.
        search: minus(d('search'), region),
        field: minus(d('search'), region),
        scroller: minus(scroller, region),
        viewport,
      };
      const set = (el: HTMLElement | null, [x, y]: [number, number]) => {
        if (!el) return;
        el.style.setProperty('--bento-rail-x', `${x}px`);
        el.style.setProperty('--bento-rail-y', `${y}px`);
        written.push(el);
      };
      // Every match: a workspace slide can hold two panes.
      for (const part of SINGLES) {
        for (const el of root.querySelectorAll<HTMLElement>(PARTS[part])) set(el, offsets[part]);
      }
      if (phase === 'collapse') {
        for (const el of root.querySelectorAll<HTMLElement>(PARTS.search)) {
          const folds = el
            .closest('.bento-tab-list__new-actions')
            ?.querySelector('.bento-tab-list-search[data-folding]');
          if (folds) el.setAttribute(FOLDING_TRIGGER_ATTRIBUTE, '');
        }
      }
      // A reversed phase starts the square and the field row where they are now.
      const seeded = seedLayout as Seed | null | undefined;
      const seedPx = (el: HTMLElement, name: (typeof SEED_PROPERTIES)[number], value: number) =>
        el.style.setProperty(name, `${value}px`);
      for (const el of root.querySelectorAll<HTMLElement>(PARTS.search)) {
        if (!seeded?.search) break;
        seedPx(el, '--bento-rail-seed-x', seeded.search[0]);
        seedPx(el, '--bento-rail-seed-y', seeded.search[1]);
      }
      for (const el of root.querySelectorAll<HTMLElement>(PARTS.field)) {
        if (!seeded?.field) break;
        seedPx(el, '--bento-rail-seed-x', seeded.field.offset[0]);
        seedPx(el, '--bento-rail-seed-y', seeded.field.offset[1]);
        seedPx(el, '--bento-rail-seed-margin', seeded.field.margin);
        seedPx(el, '--bento-rail-seed-padding', seeded.field.padding);
        el.style.setProperty('--bento-rail-seed-text', String(seeded.field.text));
      }
      singles = offsets;
      // Footer buttons go one unit apart, the toggle (the first, bottom of the rail
      // stack) first in a collapse and last in an expand.
      const buttons = footerChildren();
      buttons.forEach((el, i) => {
        set(el, minus(shift(expanded.footerButtons[i], rail.footerButtons[i]), main));
        el.style.animationDelay = delay((phase === 'collapse' ? i : buttons.length - 1 - i) * UNIT);
        delayed.push(el);
      });

      const favicon = relative(expanded.favicon, rail.favicon);
      const folderIcon = relative(expanded.folderIcon, rail.folderIcon);
      const rowOffsets = {
        '--bento-rail-tab-x': rows.plain.x,
        '--bento-rail-tab-y': rows.plain.y,
        '--bento-rail-indented-x': rows.indented.x,
        '--bento-rail-indented-y': rows.indented.y,
        '--bento-rail-favicon-x': favicon[0],
        '--bento-rail-favicon-y': favicon[1],
        '--bento-rail-folder-x': minus(folder, list)[0],
        '--bento-rail-folder-y': minus(folder, list)[1],
        '--bento-rail-folder-icon-x': folderIcon[0],
        '--bento-rail-folder-icon-y': folderIcon[1],
        '--bento-rail-tail': rows.plain.tail,
        '--bento-rail-indented-tail': rows.indented.tail,
        '--bento-rail-footer-height': px(rail.boxes.footer?.h ?? 0),
        '--bento-rail-footer-rise':
          px(rail.boxes.footer?.h ?? 0) - px(expanded.boxes.footer?.h ?? 0),
      } satisfies Record<(typeof ROOT_PROPERTIES)[number], number>;
      for (const [name, value] of Object.entries(rowOffsets)) {
        root.style.setProperty(name, `${value}px`);
      }

      const textBase = phase === 'expand' ? EXPAND_TEXT_DELAY : 0;
      const trailingBase = phase === 'expand' ? EXPAND_TRAILING_DELAY : 0;
      for (const { row, text, trailing, index } of expanded.rows) {
        const stagger = Math.min(FIRST_ROW_UNIT + index, LAST_ROW_UNIT) * UNIT;
        row.style.animationDelay = delay(stagger);
        delayed.push(row);
        for (const el of text) {
          el.style.animationDelay = delay(textBase + stagger);
          delayed.push(el);
        }
        for (const el of trailing) {
          el.style.animationDelay = delay(trailingBase + stagger);
          delayed.push(el);
        }
      }

      // What React mounts in the list during the phase holds the end state at once.
      const listRegion = find('region');
      if (listRegion && typeof MutationObserver !== 'undefined') {
        watcher = new MutationObserver((records) => {
          const prepare = (el: Element) => {
            for (const part of ['newIcon', 'search', 'field', 'scroller', 'viewport'] as const) {
              const offset = singles[part];
              if (!offset) continue;
              const matches = [
                ...(el.matches(PARTS[part]) ? [el] : []),
                ...el.querySelectorAll(PARTS[part]),
              ];
              for (const match of matches) set(match as HTMLElement, offset);
            }
          };
          finishAdded(
            records.flatMap((record) => [...record.addedNodes]),
            prepare,
          );
        });
        watcher.observe(listRegion, { childList: true, subtree: true });
      }
    },

    clear,

    flush() {
      void view?.getComputedStyle(root).transitionProperty;
    },

    wait(_phase: RailPhase, done: () => void) {
      return afterMotion(root, { animations: [HOLD_ANIMATION] }, done);
    },

    reducedMotion: () => view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
}

const ROOT_PROPERTIES = [
  '--bento-rail-tab-x',
  '--bento-rail-tab-y',
  '--bento-rail-indented-x',
  '--bento-rail-indented-y',
  '--bento-rail-favicon-x',
  '--bento-rail-favicon-y',
  '--bento-rail-folder-x',
  '--bento-rail-folder-y',
  '--bento-rail-folder-icon-x',
  '--bento-rail-folder-icon-y',
  '--bento-rail-tail',
  '--bento-rail-indented-tail',
  '--bento-rail-footer-height',
  '--bento-rail-footer-rise',
] as const;
