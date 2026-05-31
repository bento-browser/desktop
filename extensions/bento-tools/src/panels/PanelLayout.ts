import type {
  PanelLayoutStatus,
  PanelLayoutSync,
  PanelLayoutSyncChooserNode,
  PanelLayoutSyncHorizontalGroupNode,
  PanelLayoutMoveTarget,
  PanelLayoutSyncPanelNode,
  PanelLayoutSyncRootNode,
} from '@shared/protocol';

export type RootNode = PanelLeafNode | VerticalGroupNode;
export type VerticalTopNode = PanelLeafNode | HorizontalGroupNode;
export type VerticalBottomNode = PanelLeafNode | ChooserNode | HorizontalGroupNode;

export interface PanelLeafNode {
  kind: 'panel';
  tabId: number;
}

export interface VerticalGroupNode {
  kind: 'group';
  axis: 'vertical';
  id: string;
  ratio: number;
  children: [VerticalTopNode, VerticalBottomNode];
}

export interface HorizontalGroupNode {
  kind: 'group';
  axis: 'horizontal';
  id: string;
  ratio: number;
  children: [PanelLeafNode, PanelLeafNode];
}

export interface ChooserNode {
  kind: 'chooser';
  id: string;
  ownerTabId: number;
}

export interface WorkspacePanelLayout {
  root: RootNode[];
}

export interface PanelRestoreLocation {
  workspaceId: string;
  rootIndex: number;
  containingRootNodeId?: string;
}

export type PanelPersistenceRootNode =
  | PanelPersistencePanelNode
  | PanelPersistenceVerticalGroupNode;

export type PanelPersistenceVerticalTopNode =
  | PanelPersistencePanelNode
  | PanelPersistenceHorizontalGroupNode;

export type PanelPersistenceVerticalBottomNode =
  | PanelPersistencePanelNode
  | PanelPersistenceChooserNode
  | PanelPersistenceHorizontalGroupNode;

export interface PanelPersistencePanelNode {
  kind: 'panel';
  panelKey: string;
}

export interface PanelPersistenceVerticalGroupNode {
  kind: 'group';
  axis: 'vertical';
  id: string;
  ratio: number;
  children: [PanelPersistenceVerticalTopNode, PanelPersistenceVerticalBottomNode];
}

export interface PanelPersistenceHorizontalGroupNode {
  kind: 'group';
  axis: 'horizontal';
  id: string;
  ratio: number;
  children: [PanelPersistencePanelNode, PanelPersistencePanelNode];
}

export interface PanelPersistenceChooserNode {
  kind: 'chooser';
  id: string;
  ownerPanelKey: string;
}

export interface PanelPersistenceWorkspaceLayout {
  root: PanelPersistenceRootNode[];
}

export interface PanelPersistenceSnapshot {
  entries: Array<{ panelKey: string; tabId: number; url: string; widthPx?: number }>;
  layout: PanelPersistenceWorkspaceLayout;
}

export interface LegacyPersistedPanelEntry {
  url: string;
  widthPx?: number;
  subdivision?: {
    mode: 'single' | 'dual';
    topHeightFraction: number;
    subPanelUrls: string[];
    splitRatio?: number;
  };
}

export interface LegacyMigrationResult {
  entries: Array<{ panelKey: string; url: string; widthPx?: number }>;
  layout: PanelPersistenceWorkspaceLayout;
}

export interface BreakOutResult {
  promotedTabId: number;
  containingRootNodeId: string;
}

export function emptyLayout(): WorkspacePanelLayout {
  return { root: [] };
}

export function cloneLayout(layout: WorkspacePanelLayout | undefined): WorkspacePanelLayout {
  return { root: (layout?.root ?? []).map((node) => cloneRootNode(node)) };
}

export function panelNode(tabId: number): PanelLeafNode {
  return { kind: 'panel', tabId };
}

export function rootNodeId(node: RootNode): string {
  return node.kind === 'panel' ? `panel:${node.tabId}` : node.id;
}

export function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.5;
}

export function getVisiblePanelIds(layout: WorkspacePanelLayout | undefined): number[] {
  const out: number[] = [];
  for (const node of layout?.root ?? []) {
    collectPanelIds(node, out);
  }
  return out;
}

export function getRootNodeIds(layout: WorkspacePanelLayout | undefined): string[] {
  return (layout?.root ?? []).map(rootNodeId);
}

export function containsPanel(layout: WorkspacePanelLayout | undefined, tabId: number): boolean {
  if (!Number.isFinite(tabId)) return false;
  return getVisiblePanelIds(layout).includes(tabId);
}

export function getPanelLayoutStatus(
  layout: WorkspacePanelLayout | undefined,
  tabId: number,
): PanelLayoutStatus {
  if (!Number.isFinite(tabId)) return 'unknown';
  for (const node of layout?.root ?? []) {
    if (node.kind === 'panel') {
      if (node.tabId === tabId) return 'root-panel';
      continue;
    }
    const [top, bottom] = node.children;
    if (top.kind === 'panel') {
      if (top.tabId === tabId) {
        return bottom.kind === 'chooser' ? 'chooser-owner' : 'subdivision-top';
      }
    } else if (top.children.some((child) => child.tabId === tabId)) {
      return 'split-child';
    }
    if (bottom.kind === 'panel') {
      if (bottom.tabId === tabId) return 'subdivision-bottom';
      continue;
    }
    if (bottom.kind === 'group') {
      if (bottom.children.some((child) => child.tabId === tabId)) return 'split-child';
    }
  }
  return 'unknown';
}

export function getPanelStatusMap(
  layout: WorkspacePanelLayout | undefined,
): Record<number, PanelLayoutStatus> {
  const out: Record<number, PanelLayoutStatus> = {};
  for (const tabId of getVisiblePanelIds(layout)) {
    out[tabId] = getPanelLayoutStatus(layout, tabId);
  }
  return out;
}

export function canSubdivide(layout: WorkspacePanelLayout | undefined, tabId: number): boolean {
  return getPanelLayoutStatus(layout, tabId) === 'root-panel';
}

export function canSplitTopPanel(layout: WorkspacePanelLayout | undefined, tabId: number): boolean {
  if (!Number.isFinite(tabId)) return false;
  for (const node of layout?.root ?? []) {
    if (node.kind !== 'group' || node.axis !== 'vertical') continue;
    const top = node.children[0];
    if (top.kind === 'panel' && top.tabId === tabId) return true;
  }
  return false;
}

export function canSplitBottomPanel(
  layout: WorkspacePanelLayout | undefined,
  tabId: number,
): boolean {
  if (!Number.isFinite(tabId)) return false;
  for (const node of layout?.root ?? []) {
    if (node.kind !== 'group' || node.axis !== 'vertical') continue;
    const bottom = node.children[1];
    if (bottom.kind === 'panel' && bottom.tabId === tabId) return true;
  }
  return false;
}

export function canBreakOut(layout: WorkspacePanelLayout | undefined, tabId: number): boolean {
  const status = getPanelLayoutStatus(layout, tabId);
  return status === 'subdivision-bottom' || status === 'split-child';
}

export function addPanel(layout: WorkspacePanelLayout, tabId: number): boolean {
  if (!Number.isFinite(tabId) || containsPanel(layout, tabId)) return false;
  layout.root.push(panelNode(tabId));
  return true;
}

export function insertPanelAt(
  layout: WorkspacePanelLayout,
  tabId: number,
  position: number,
): boolean {
  if (!Number.isFinite(tabId) || containsPanel(layout, tabId)) return false;
  const idx = clampIndex(position, layout.root.length);
  layout.root.splice(idx, 0, panelNode(tabId));
  return true;
}

export function insertPanelAtRestoreLocation(
  layout: WorkspacePanelLayout,
  tabId: number,
  location: Pick<PanelRestoreLocation, 'rootIndex' | 'containingRootNodeId'>,
): boolean {
  if (!Number.isFinite(tabId) || containsPanel(layout, tabId)) return false;
  const containingRootNodeId = location.containingRootNodeId;
  if (containingRootNodeId) {
    const containingIndex = layout.root.findIndex(
      (node) => rootNodeId(node) === containingRootNodeId,
    );
    if (containingIndex >= 0) {
      layout.root.splice(containingIndex + 1, 0, panelNode(tabId));
      return true;
    }
  }
  const idx = clampIndex(location.rootIndex, layout.root.length);
  layout.root.splice(idx, 0, panelNode(tabId));
  return true;
}

export function removePanel(layout: WorkspacePanelLayout, tabId: number): boolean {
  const nextRoot: RootNode[] = [];
  let changed = false;
  for (const node of layout.root) {
    const replacement = removePanelFromRoot(node, tabId);
    if (replacement.changed) changed = true;
    nextRoot.push(...replacement.nodes);
  }
  if (!changed) return false;
  layout.root = nextRoot;
  return true;
}

export function removePanelWithDescendants(layout: WorkspacePanelLayout, tabId: number): number[] {
  const rootIndex = findRootIndexContaining(layout, tabId);
  if (rootIndex < 0) return [];
  const root = layout.root[rootIndex];
  if (!root) return [];
  const victims: number[] = [];
  if (
    root.kind === 'group' &&
    root.children[0].kind === 'panel' &&
    root.children[0].tabId === tabId
  ) {
    collectPanelIds(root.children[1], victims);
    layout.root.splice(rootIndex, 1);
    return victims.filter((id) => id !== tabId);
  }
  const removed = removePanel(layout, tabId);
  return removed ? victims.filter((id) => id !== tabId) : [];
}

export function removeWorkspace(layout: WorkspacePanelLayout): number[] {
  const victims = getVisiblePanelIds(layout);
  layout.root = [];
  return victims;
}

export function reorderRootNodes(layout: WorkspacePanelLayout, rootNodeIds: string[]): boolean {
  if (rootNodeIds.length !== layout.root.length) return false;
  const current = new Map(layout.root.map((node) => [rootNodeId(node), node]));
  if (current.size !== layout.root.length) return false;
  const seen = new Set<string>();
  const next: RootNode[] = [];
  for (const id of rootNodeIds) {
    if (seen.has(id)) return false;
    const node = current.get(id);
    if (!node) return false;
    seen.add(id);
    next.push(node);
  }
  if (next.every((node, index) => node === layout.root[index])) return false;
  layout.root = next;
  return true;
}

export function movePanel(
  layout: WorkspacePanelLayout,
  tabId: number,
  target: PanelLayoutMoveTarget,
  ids: { horizontalGroupId?: string } = {},
): boolean {
  if (!Number.isFinite(tabId) || !containsPanel(layout, tabId)) return false;
  const before = JSON.stringify(layout.root);
  const next = cloneLayout(layout);
  if (!removePanel(next, tabId)) return false;

  if (target.type === 'root') {
    const idx = clampIndex(target.index, next.root.length);
    next.root.splice(idx, 0, panelNode(tabId));
  } else if (target.type === 'chooser') {
    if (!fillChooserWithExistingPanel(next, target.chooserId, tabId)) return false;
  } else {
    const horizontalGroupId = ids.horizontalGroupId;
    if (!horizontalGroupId) return false;
    const group = findVerticalGroupById(next, target.groupId);
    if (!group) return false;
    const childIndex = target.row === 'top' ? 0 : 1;
    const existing = group.children[childIndex];
    if (!existing || existing.kind !== 'panel') return false;
    const moved = panelNode(tabId);
    const current = panelNode(existing.tabId);
    group.children[childIndex] = {
      kind: 'group',
      axis: 'horizontal',
      id: horizontalGroupId,
      ratio: 0.5,
      children: target.position === 'before' ? [moved, current] : [current, moved],
    };
  }

  const after = JSON.stringify(next.root);
  if (before === after) return false;
  layout.root = next.root;
  return true;
}

function fillChooserWithExistingPanel(
  layout: WorkspacePanelLayout,
  chooserId: string,
  tabId: number,
): boolean {
  for (const root of layout.root) {
    if (root.kind !== 'group' || root.axis !== 'vertical') continue;
    const bottom = root.children[1];
    if (bottom.kind !== 'chooser' || bottom.id !== chooserId) continue;
    root.children[1] = panelNode(tabId);
    return true;
  }
  return false;
}

export function subdividePanel(
  layout: WorkspacePanelLayout,
  tabId: number,
  ids: { groupId: string; chooserId: string },
): boolean {
  if (!canSubdivide(layout, tabId)) return false;
  const idx = layout.root.findIndex((node) => node.kind === 'panel' && node.tabId === tabId);
  if (idx < 0) return false;
  layout.root[idx] = {
    kind: 'group',
    axis: 'vertical',
    id: ids.groupId,
    ratio: 0.5,
    children: [panelNode(tabId), { kind: 'chooser', id: ids.chooserId, ownerTabId: tabId }],
  };
  return true;
}

export function splitTopPanel(
  layout: WorkspacePanelLayout,
  tabId: number,
  newTabId: number,
  ids: { horizontalGroupId: string },
): boolean {
  if (!Number.isFinite(tabId) || !Number.isFinite(newTabId)) return false;
  if (containsPanel(layout, newTabId)) return false;
  for (const root of layout.root) {
    if (root.kind !== 'group' || root.axis !== 'vertical') continue;
    const top = root.children[0];
    if (top.kind !== 'panel' || top.tabId !== tabId) continue;
    root.children[0] = {
      kind: 'group',
      axis: 'horizontal',
      id: ids.horizontalGroupId,
      ratio: 0.5,
      children: [panelNode(tabId), panelNode(newTabId)],
    };
    return true;
  }
  return false;
}

export function splitBottomPanel(
  layout: WorkspacePanelLayout,
  tabId: number,
  newTabId: number,
  ids: { horizontalGroupId: string },
): boolean {
  if (!Number.isFinite(tabId) || !Number.isFinite(newTabId)) return false;
  if (containsPanel(layout, newTabId)) return false;
  for (const root of layout.root) {
    if (root.kind !== 'group' || root.axis !== 'vertical') continue;
    const bottom = root.children[1];
    if (bottom.kind !== 'panel' || bottom.tabId !== tabId) continue;
    root.children[1] = {
      kind: 'group',
      axis: 'horizontal',
      id: ids.horizontalGroupId,
      ratio: 0.5,
      children: [panelNode(tabId), panelNode(newTabId)],
    };
    return true;
  }
  return false;
}

export function fillChooser(
  layout: WorkspacePanelLayout,
  chooserId: string,
  mode: 'single' | 'dual',
  tabIds: number[],
  ids: { horizontalGroupId?: string },
): boolean {
  const expected = mode === 'dual' ? 2 : 1;
  if (tabIds.length !== expected || tabIds.some((id) => !Number.isFinite(id))) return false;
  if (tabIds.some((id) => containsPanel(layout, id))) return false;
  for (const root of layout.root) {
    if (root.kind !== 'group') continue;
    const bottom = root.children[1];
    if (bottom.kind !== 'chooser' || bottom.id !== chooserId) continue;
    if (mode === 'single') {
      root.children[1] = panelNode(tabIds[0]!);
      return true;
    }
    const horizontalGroupId = ids.horizontalGroupId;
    if (!horizontalGroupId) return false;
    root.children[1] = {
      kind: 'group',
      axis: 'horizontal',
      id: horizontalGroupId,
      ratio: 0.5,
      children: [panelNode(tabIds[0]!), panelNode(tabIds[1]!)],
    };
    return true;
  }
  return false;
}

export function removeVerticalGroup(layout: WorkspacePanelLayout, groupId: string): number[] {
  const idx = layout.root.findIndex(
    (node) => node.kind === 'group' && node.axis === 'vertical' && node.id === groupId,
  );
  if (idx < 0) return [];
  const group = layout.root[idx] as VerticalGroupNode;
  const victims: number[] = [];
  collectPanelIds(group.children[1], victims);
  layout.root.splice(idx, 1, ...topToRootNodes(group.children[0]));
  return victims;
}

export function breakOutPanel(
  layout: WorkspacePanelLayout,
  tabId: number,
): BreakOutResult | undefined {
  if (!canBreakOut(layout, tabId)) return undefined;
  const rootIndex = findRootIndexContaining(layout, tabId);
  if (rootIndex < 0) return undefined;
  const containingRoot = layout.root[rootIndex];
  if (!containingRoot) return undefined;
  const containingRootNodeId = rootNodeId(containingRoot);
  const promoted = panelNode(tabId);
  const oldRoot = layout.root.splice(rootIndex, 1)[0];
  if (!oldRoot) return undefined;
  const replacement = removePanelFromRoot(oldRoot, tabId).nodes;
  layout.root.splice(rootIndex, 0, ...replacement);
  const insertAfter = rootIndex + replacement.length;
  layout.root.splice(insertAfter, 0, promoted);
  return { promotedTabId: tabId, containingRootNodeId };
}

export function setGroupRatio(
  layout: WorkspacePanelLayout,
  groupId: string,
  ratio: number,
): boolean {
  const node = findGroupById(layout, groupId);
  if (!node) return false;
  const next = clampRatio(ratio);
  if (node.ratio === next) return false;
  node.ratio = next;
  return true;
}

export function getPanelRestoreLocation(
  layout: WorkspacePanelLayout | undefined,
  workspaceId: string,
  tabId: number,
): PanelRestoreLocation {
  const root = layout?.root ?? [];
  const rootIndex = Math.max(0, findRootIndexContaining({ root }, tabId));
  const node = root[rootIndex];
  return {
    workspaceId,
    rootIndex,
    ...(node ? { containingRootNodeId: rootNodeId(node) } : {}),
  };
}

export function toSyncLayout(layout: WorkspacePanelLayout | undefined): PanelLayoutSync {
  return { root: (layout?.root ?? []).map(toSyncRootNode) };
}

export function panelKeysForLayout(layout: WorkspacePanelLayout | undefined): Map<number, string> {
  const out = new Map<number, string>();
  let index = 0;
  for (const tabId of getVisiblePanelIds(layout)) {
    out.set(tabId, `panel-${index}`);
    index += 1;
  }
  return out;
}

export function toPersistenceLayout(
  layout: WorkspacePanelLayout | undefined,
  panelKeysByTabId: Map<number, string>,
): PanelPersistenceWorkspaceLayout {
  const root: PanelPersistenceRootNode[] = [];
  for (const node of layout?.root ?? []) {
    const converted = toPersistenceRootNode(node, panelKeysByTabId);
    if (converted) root.push(converted);
  }
  return { root };
}

export function fromPersistenceLayout(
  layout: PanelPersistenceWorkspaceLayout | undefined,
  tabIdByPanelKey: Map<string, number>,
): WorkspacePanelLayout {
  const root: RootNode[] = [];
  for (const node of layout?.root ?? []) {
    const converted = fromPersistenceRootNode(node, tabIdByPanelKey);
    root.push(...converted.flatMap((rootNode) => normalizeRootNode(rootNode)));
  }
  return { root };
}

export function migrateLegacyEntriesToPersistence(
  entries: LegacyPersistedPanelEntry[],
  idPrefix = 'legacy',
): LegacyMigrationResult {
  const outEntries: Array<{ panelKey: string; url: string; widthPx?: number }> = [];
  const root: PanelPersistenceRootNode[] = [];
  let nextKey = 0;
  let nextGroup = 0;
  const addEntry = (url: string, widthPx?: number): PanelPersistencePanelNode | null => {
    if (!url || url === 'about:blank') return null;
    const panelKey = `${idPrefix}-panel-${nextKey++}`;
    const entry: { panelKey: string; url: string; widthPx?: number } = { panelKey, url };
    if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
    outEntries.push(entry);
    return { kind: 'panel', panelKey };
  };
  const nextGroupId = (axis: 'vertical' | 'horizontal') => `${idPrefix}-${axis}-${nextGroup++}`;
  const nextChooserId = () => `${idPrefix}-chooser-${nextGroup++}`;

  for (const legacy of entries) {
    const sub = legacy.subdivision;
    const subPanelUrls = Array.isArray(sub?.subPanelUrls)
      ? sub.subPanelUrls.filter((url) => typeof url === 'string' && url && url !== 'about:blank')
      : [];
    const topClosed = !!sub && sub.topHeightFraction <= 0 && subPanelUrls.length > 0;
    if (topClosed) {
      const children = subPanelUrls
        .slice(0, sub.mode === 'dual' ? 2 : 1)
        .map((url, index) => addEntry(url, index === 0 ? legacy.widthPx : undefined))
        .filter((node): node is PanelPersistencePanelNode => !!node);
      root.push(...children);
      continue;
    }
    const parent = addEntry(legacy.url, legacy.widthPx);
    if (!parent) continue;
    if (!sub) {
      root.push(parent);
      continue;
    }
    if (subPanelUrls.length === 0) {
      root.push({
        kind: 'group',
        axis: 'vertical',
        id: nextGroupId('vertical'),
        ratio: clampRatio(sub.topHeightFraction),
        children: [
          parent,
          { kind: 'chooser', id: nextChooserId(), ownerPanelKey: parent.panelKey },
        ],
      });
      continue;
    }
    const left = addEntry(subPanelUrls[0]!);
    if (!left) {
      root.push(parent);
      continue;
    }
    if (sub.mode === 'dual' && subPanelUrls.length >= 2) {
      const right = addEntry(subPanelUrls[1]!);
      if (right) {
        root.push({
          kind: 'group',
          axis: 'vertical',
          id: nextGroupId('vertical'),
          ratio: clampRatio(sub.topHeightFraction),
          children: [
            parent,
            {
              kind: 'group',
              axis: 'horizontal',
              id: nextGroupId('horizontal'),
              ratio: clampRatio(sub.splitRatio ?? 0.5),
              children: [left, right],
            },
          ],
        });
        continue;
      }
    }
    root.push({
      kind: 'group',
      axis: 'vertical',
      id: nextGroupId('vertical'),
      ratio: clampRatio(sub.topHeightFraction),
      children: [parent, left],
    });
  }

  return { entries: outEntries, layout: { root } };
}

function collectPanelIds(
  node: RootNode | VerticalTopNode | VerticalBottomNode,
  out: number[],
): void {
  if (node.kind === 'panel') {
    out.push(node.tabId);
    return;
  }
  if (node.kind === 'chooser') return;
  if (node.axis === 'vertical') {
    collectPanelIds(node.children[0], out);
    collectPanelIds(node.children[1], out);
    return;
  }
  collectPanelIds(node.children[0], out);
  collectPanelIds(node.children[1], out);
}

function removePanelFromRoot(
  node: RootNode,
  tabId: number,
): { changed: boolean; nodes: RootNode[] } {
  if (node.kind === 'panel') {
    return node.tabId === tabId ? { changed: true, nodes: [] } : { changed: false, nodes: [node] };
  }
  const [top, bottom] = node.children;
  const topRemoval = removePanelFromHorizontalCapableNode(top, tabId);
  if (topRemoval.changed) {
    if (!topRemoval.node) return { changed: true, nodes: bottomToRootNodes(bottom) };
    node.children[0] = topRemoval.node;
    return { changed: true, nodes: [node] };
  }
  if (bottom.kind === 'panel') {
    if (bottom.tabId !== tabId) return { changed: false, nodes: [node] };
    return { changed: true, nodes: topToRootNodes(top) };
  }
  if (bottom.kind === 'chooser') return { changed: false, nodes: [node] };

  const [left, right] = bottom.children;
  if (left.tabId === tabId) {
    node.children[1] = right;
    return { changed: true, nodes: [node] };
  }
  if (right.tabId === tabId) {
    node.children[1] = left;
    return { changed: true, nodes: [node] };
  }
  return { changed: false, nodes: [node] };
}

function normalizeRootNode(node: RootNode): RootNode[] {
  if (node.kind === 'panel') return [node];
  const [top, bottom] = node.children;
  if (bottom.kind === 'chooser') return [node];
  if (bottom.kind === 'panel') return [node];
  if (bottom.children.length === 2) return [node];
  return topToRootNodes(top);
}

function removePanelFromHorizontalCapableNode(
  node: VerticalTopNode,
  tabId: number,
): { changed: boolean; node: VerticalTopNode | null } {
  if (node.kind === 'panel') {
    return node.tabId === tabId ? { changed: true, node: null } : { changed: false, node };
  }
  const [left, right] = node.children;
  if (left.tabId === tabId) return { changed: true, node: right };
  if (right.tabId === tabId) return { changed: true, node: left };
  return { changed: false, node };
}

function topToRootNodes(node: VerticalTopNode): RootNode[] {
  if (node.kind === 'panel') return [node];
  return [...node.children];
}

function findRootIndexContaining(layout: WorkspacePanelLayout, tabId: number): number {
  for (let i = 0; i < layout.root.length; i++) {
    const ids: number[] = [];
    const node = layout.root[i];
    if (!node) continue;
    collectPanelIds(node, ids);
    if (ids.includes(tabId)) return i;
  }
  return -1;
}

function findGroupById(
  layout: WorkspacePanelLayout,
  groupId: string,
): VerticalGroupNode | HorizontalGroupNode | null {
  for (const root of layout.root) {
    if (root.kind !== 'group') continue;
    if (root.id === groupId) return root;
    const top = root.children[0];
    if (top.kind === 'group' && top.id === groupId) return top;
    const bottom = root.children[1];
    if (bottom.kind === 'group' && bottom.id === groupId) return bottom;
  }
  return null;
}

function findVerticalGroupById(
  layout: WorkspacePanelLayout,
  groupId: string,
): VerticalGroupNode | null {
  const group = findGroupById(layout, groupId);
  return group?.axis === 'vertical' ? group : null;
}

function clampIndex(position: number, length: number): number {
  if (!Number.isFinite(position)) return length;
  return Math.max(0, Math.min(Math.round(position), length));
}

function cloneRootNode(node: RootNode): RootNode {
  if (node.kind === 'panel') return panelNode(node.tabId);
  return {
    kind: 'group',
    axis: 'vertical',
    id: node.id,
    ratio: node.ratio,
    children: [cloneVerticalTopNode(node.children[0]), cloneVerticalBottomNode(node.children[1])],
  };
}

function cloneVerticalTopNode(node: VerticalTopNode): VerticalTopNode {
  if (node.kind === 'panel') return panelNode(node.tabId);
  return cloneHorizontalGroupNode(node);
}

function cloneVerticalBottomNode(node: VerticalBottomNode): VerticalBottomNode {
  if (node.kind === 'panel') return panelNode(node.tabId);
  if (node.kind === 'chooser') return { kind: 'chooser', id: node.id, ownerTabId: node.ownerTabId };
  return cloneHorizontalGroupNode(node);
}

function cloneHorizontalGroupNode(node: HorizontalGroupNode): HorizontalGroupNode {
  return {
    kind: 'group',
    axis: 'horizontal',
    id: node.id,
    ratio: node.ratio,
    children: [panelNode(node.children[0].tabId), panelNode(node.children[1].tabId)],
  };
}

function toSyncRootNode(node: RootNode): PanelLayoutSyncRootNode {
  if (node.kind === 'panel') return toSyncPanel(node);
  return {
    kind: 'group',
    id: node.id,
    axis: 'vertical',
    ratio: node.ratio,
    children: [toSyncVerticalTopNode(node.children[0]), toSyncVerticalBottomNode(node.children[1])],
  };
}

function toSyncVerticalTopNode(
  node: VerticalTopNode,
): PanelLayoutSyncPanelNode | PanelLayoutSyncHorizontalGroupNode {
  if (node.kind === 'panel') return toSyncPanel(node);
  return toSyncHorizontalGroupNode(node);
}

function toSyncVerticalBottomNode(
  node: VerticalBottomNode,
): PanelLayoutSyncPanelNode | PanelLayoutSyncChooserNode | PanelLayoutSyncHorizontalGroupNode {
  if (node.kind === 'panel') return toSyncPanel(node);
  if (node.kind === 'chooser') {
    return { kind: 'chooser', id: node.id, ownerTabId: node.ownerTabId };
  }
  return toSyncHorizontalGroupNode(node);
}

function toSyncHorizontalGroupNode(node: HorizontalGroupNode): PanelLayoutSyncHorizontalGroupNode {
  return {
    kind: 'group',
    id: node.id,
    axis: 'horizontal',
    ratio: node.ratio,
    children: [toSyncPanel(node.children[0]), toSyncPanel(node.children[1])],
  };
}

function toSyncPanel(node: PanelLeafNode): PanelLayoutSyncPanelNode {
  return { kind: 'panel', tabId: node.tabId };
}

function toPersistenceRootNode(
  node: RootNode,
  panelKeysByTabId: Map<number, string>,
): PanelPersistenceRootNode | null {
  if (node.kind === 'panel') return toPersistencePanelNode(node, panelKeysByTabId);
  const top = toPersistenceVerticalTopNode(node.children[0], panelKeysByTabId);
  const bottom = toPersistenceVerticalBottomNode(node.children[1], panelKeysByTabId);
  if (!top || !bottom) return null;
  return {
    kind: 'group',
    axis: 'vertical',
    id: node.id,
    ratio: node.ratio,
    children: [top, bottom],
  };
}

function toPersistenceVerticalTopNode(
  node: VerticalTopNode,
  panelKeysByTabId: Map<number, string>,
): PanelPersistenceVerticalTopNode | null {
  if (node.kind === 'panel') return toPersistencePanelNode(node, panelKeysByTabId);
  return toPersistenceHorizontalGroupNode(node, panelKeysByTabId);
}

function toPersistenceVerticalBottomNode(
  node: VerticalBottomNode,
  panelKeysByTabId: Map<number, string>,
): PanelPersistenceVerticalBottomNode | null {
  if (node.kind === 'panel') return toPersistencePanelNode(node, panelKeysByTabId);
  if (node.kind === 'chooser') {
    const ownerPanelKey = panelKeysByTabId.get(node.ownerTabId);
    if (!ownerPanelKey) return null;
    return { kind: 'chooser', id: node.id, ownerPanelKey };
  }
  return toPersistenceHorizontalGroupNode(node, panelKeysByTabId);
}

function toPersistenceHorizontalGroupNode(
  node: HorizontalGroupNode,
  panelKeysByTabId: Map<number, string>,
): PanelPersistenceHorizontalGroupNode | null {
  const left = toPersistencePanelNode(node.children[0], panelKeysByTabId);
  const right = toPersistencePanelNode(node.children[1], panelKeysByTabId);
  if (!left || !right) return null;
  return {
    kind: 'group',
    axis: 'horizontal',
    id: node.id,
    ratio: node.ratio,
    children: [left, right],
  };
}

function toPersistencePanelNode(
  node: PanelLeafNode,
  panelKeysByTabId: Map<number, string>,
): PanelPersistencePanelNode | null {
  const panelKey = panelKeysByTabId.get(node.tabId);
  return panelKey ? { kind: 'panel', panelKey } : null;
}

function fromPersistenceRootNode(
  node: PanelPersistenceRootNode,
  tabIdByPanelKey: Map<string, number>,
): RootNode[] {
  if (node.kind === 'panel') {
    const panel = fromPersistencePanelNode(node, tabIdByPanelKey);
    return panel ? [panel] : [];
  }
  if (node.axis !== 'vertical') return [];
  const top = fromPersistenceVerticalTopNode(node.children[0], tabIdByPanelKey);
  const bottom = fromPersistenceVerticalBottomNode(node.children[1], tabIdByPanelKey);
  if (!top) return bottom ? bottomToRootNodes(bottom) : [];
  if (!bottom) return topToRootNodes(top);
  if (bottom.kind === 'chooser') {
    const ownerTabId = firstPanelIdInTopNode(top);
    if (!Number.isFinite(ownerTabId)) return topToRootNodes(top);
    return [
      {
        kind: 'group',
        axis: 'vertical',
        id: node.id,
        ratio: clampRatio(node.ratio),
        children: [top, { ...bottom, ownerTabId }],
      },
    ];
  }
  return [
    {
      kind: 'group',
      axis: 'vertical',
      id: node.id,
      ratio: clampRatio(node.ratio),
      children: [top, bottom],
    },
  ];
}

function fromPersistenceVerticalTopNode(
  node: PanelPersistenceVerticalTopNode,
  tabIdByPanelKey: Map<string, number>,
): VerticalTopNode | null {
  if (node.kind === 'panel') return fromPersistencePanelNode(node, tabIdByPanelKey);
  if (node.axis !== 'horizontal') return null;
  const left = fromPersistencePanelNode(node.children[0], tabIdByPanelKey);
  const right = fromPersistencePanelNode(node.children[1], tabIdByPanelKey);
  if (left && right) {
    return {
      kind: 'group',
      axis: 'horizontal',
      id: node.id,
      ratio: clampRatio(node.ratio),
      children: [left, right],
    };
  }
  return left ?? right ?? null;
}

function fromPersistenceVerticalBottomNode(
  node: PanelPersistenceVerticalBottomNode,
  tabIdByPanelKey: Map<string, number>,
): VerticalBottomNode | null {
  if (node.kind === 'panel') return fromPersistencePanelNode(node, tabIdByPanelKey);
  if (node.kind === 'chooser') return { kind: 'chooser', id: node.id, ownerTabId: -1 };
  if (node.axis !== 'horizontal') return null;
  const left = fromPersistencePanelNode(node.children[0], tabIdByPanelKey);
  const right = fromPersistencePanelNode(node.children[1], tabIdByPanelKey);
  if (left && right) {
    return {
      kind: 'group',
      axis: 'horizontal',
      id: node.id,
      ratio: clampRatio(node.ratio),
      children: [left, right],
    };
  }
  return left ?? right ?? null;
}

function fromPersistencePanelNode(
  node: PanelPersistencePanelNode,
  tabIdByPanelKey: Map<string, number>,
): PanelLeafNode | null {
  const tabId = tabIdByPanelKey.get(node.panelKey);
  return typeof tabId === 'number' ? panelNode(tabId) : null;
}

function bottomToRootNodes(node: VerticalBottomNode): RootNode[] {
  if (node.kind === 'panel') return [node];
  if (node.kind === 'chooser') return [];
  return [...node.children];
}

function firstPanelIdInTopNode(node: VerticalTopNode): number {
  if (node.kind === 'panel') return node.tabId;
  return node.children[0].tabId;
}
