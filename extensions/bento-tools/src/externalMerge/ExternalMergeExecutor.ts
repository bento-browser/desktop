import type { ExternalMergeSummary, Workspace } from '@shared/protocol';
import type { HandlerContext } from '../messaging/protocol-handler';
import type {
  NormalizedExternalSession,
  NormalizedExternalTab,
  NormalizedExternalTabGroup,
  NormalizedExternalWindow,
  NormalizedExternalWorkspace,
} from './sourceTypes';
import { ExternalMergeError } from './sourceTypes';
import { normalizeExternalUrl } from './urlNormalization';

interface ImportableTab {
  source: NormalizedExternalTab;
  normalizedUrl: string;
}

interface ImportPlan {
  workspaceName: string;
  window: NormalizedExternalWindow;
  tabs: ImportableTab[];
  groups: NormalizedExternalTabGroup[];
}

interface CreatedTab {
  source: NormalizedExternalTab;
  tabId: number;
}

const TAB_CREATE_TIMEOUT_MS = 8000;

function deduplicateName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const suffixed = `${name} (imported)`;
  if (!existing.has(suffixed)) return suffixed;
  let i = 2;
  while (existing.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function sourceWorkspaceName(
  session: NormalizedExternalSession,
  workspace: NormalizedExternalWorkspace,
): string {
  return `${session.browserName}: ${workspace.name}`;
}

function fallbackWindowName(
  session: NormalizedExternalSession,
  window: NormalizedExternalWindow,
  index: number,
): string {
  const title = window.title?.trim();
  if (title) return `${session.browserName}: ${title}`;
  return `${session.browserName}: ${session.profileName} Window ${index + 1}`;
}

async function existingNormalizedUrls(ctx: HandlerContext): Promise<Set<string>> {
  const ids = new Set<number>();
  for (const tab of ctx.tabs.snapshot()) ids.add(tab.id);
  for (const workspace of ctx.workspaces.snapshot().workspaces) {
    for (const panelId of ctx.panels.getPanels(workspace.id)) ids.add(panelId);
  }

  const urls = new Set<string>();
  const liveTabs = await browser.tabs.query({});
  for (const tab of liveTabs) {
    if (typeof tab.id !== 'number' || !ids.has(tab.id)) continue;
    const pendingUrl =
      typeof (tab as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
        ? ((tab as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl ?? '')
        : '';
    const rawUrl = tab.url && tab.url !== 'about:blank' ? tab.url : pendingUrl;
    if (!rawUrl) continue;
    const normalized = normalizeExternalUrl(rawUrl);
    if (normalized) urls.add(normalized);
  }
  return urls;
}

function makeFolderId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `external-merge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function workspacesById(
  session: NormalizedExternalSession,
): Map<string, NormalizedExternalWorkspace> {
  return new Map((session.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
}

function buildPlans(
  session: NormalizedExternalSession,
  takenNames: Set<string>,
  seenUrls: Set<string>,
  summary: ExternalMergeSummary,
): ImportPlan[] {
  const plans: ImportPlan[] = [];
  const nativeWorkspaces = workspacesById(session);
  const nativeWorkspaceWindows = new Map<string, NormalizedExternalWindow[]>();

  if (nativeWorkspaces.size > 0) {
    for (const window of session.windows) {
      if (!window.workspaceId || !nativeWorkspaces.has(window.workspaceId)) continue;
      const list = nativeWorkspaceWindows.get(window.workspaceId) ?? [];
      list.push(window);
      nativeWorkspaceWindows.set(window.workspaceId, list);
    }
  }

  if (nativeWorkspaceWindows.size > 0) {
    for (const [workspaceId, windows] of nativeWorkspaceWindows) {
      const workspace = nativeWorkspaces.get(workspaceId)!;
      const mergedWindow: NormalizedExternalWindow = {
        id: `workspace-${workspaceId}`,
        workspaceId,
        active: windows.some((window) => window.active),
        tabs: windows.flatMap((window) => window.tabs),
        groups: windows.flatMap((window) => window.groups),
      };
      const tabs = filterImportableTabs(session, mergedWindow.tabs, seenUrls, summary);
      if (tabs.length === 0) continue;
      const workspaceName = deduplicateName(sourceWorkspaceName(session, workspace), takenNames);
      takenNames.add(workspaceName);
      plans.push({
        workspaceName,
        window: mergedWindow,
        tabs,
        groups: groupsWithImportedMembers(mergedWindow.groups, tabs),
      });
    }
    return plans;
  }

  session.windows.forEach((window, index) => {
    const tabs = filterImportableTabs(session, window.tabs, seenUrls, summary);
    if (tabs.length === 0) return;
    const workspaceName = deduplicateName(fallbackWindowName(session, window, index), takenNames);
    takenNames.add(workspaceName);
    plans.push({
      workspaceName,
      window,
      tabs,
      groups: groupsWithImportedMembers(window.groups, tabs),
    });
  });

  return plans;
}

function filterImportableTabs(
  session: NormalizedExternalSession,
  tabs: NormalizedExternalTab[],
  seenUrls: Set<string>,
  summary: ExternalMergeSummary,
): ImportableTab[] {
  const out: ImportableTab[] = [];
  for (const tab of tabs) {
    const normalizedUrl = normalizeExternalUrl(tab.url, session.kind);
    if (!normalizedUrl) {
      summary.skippedUnsupportedUrls++;
      continue;
    }
    if (seenUrls.has(normalizedUrl)) {
      summary.skippedDuplicates++;
      continue;
    }
    seenUrls.add(normalizedUrl);
    out.push({ source: tab, normalizedUrl });
  }
  return out;
}

function groupsWithImportedMembers(
  groups: NormalizedExternalTabGroup[],
  tabs: ImportableTab[],
): NormalizedExternalTabGroup[] {
  const nonPinnedGroupIds = new Set(
    tabs
      .filter((tab) => !tab.source.pinned)
      .map((tab) => tab.source.groupId)
      .filter((id): id is string => !!id),
  );
  return groups.filter((group) => nonPinnedGroupIds.has(group.id));
}

function noImportableTabsMessage(
  session: NormalizedExternalSession,
  summary: ExternalMergeSummary,
): string {
  const label = session.browserName || 'Browser';
  if (summary.skippedDuplicates > 0 && summary.skippedUnsupportedUrls === 0) {
    return `All tabs from ${label} are already open in Bento.`;
  }
  if (summary.skippedDuplicates === 0 && summary.skippedUnsupportedUrls > 0) {
    return `${label} did not contain any supported tabs to import.`;
  }
  if (summary.skippedDuplicates > 0 || summary.skippedUnsupportedUrls > 0) {
    return `${label} did not contain any new supported tabs to import.`;
  }
  return `${label} did not contain any importable tabs.`;
}

function tabOpenFailureMessage(session: NormalizedExternalSession): string {
  const label = session.browserName || 'Browser';
  return `${label} tabs could not be opened in Bento.`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

async function createImportedTab(
  ctx: HandlerContext,
  workspace: Workspace,
  tab: ImportableTab,
): Promise<number | null> {
  const createOptions: browser.tabs._CreateCreateProperties = {
    active: false,
    ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
    ...(tab.normalizedUrl === 'about:newtab' ? {} : { url: tab.normalizedUrl }),
    ...(tab.source.pinned ? { pinned: true } : {}),
  };
  const created = await withTimeout(
    browser.tabs.create(createOptions),
    TAB_CREATE_TIMEOUT_MS,
    'Tab creation timed out.',
  );
  if (typeof created.id !== 'number') return null;
  const persisted = await ctx.tabs.assignWorkspaceEagerly(created.id, workspace.id);
  if (persisted === false) {
    await browser.tabs.remove(created.id).catch((err) => {
      console.warn('[bento-tools] externalMerge: cleanup unassigned tab failed:', err);
    });
    return null;
  }
  if (tab.source.pinned) {
    await browser.tabs.update(created.id, { pinned: true }).catch((err) => {
      console.warn('[bento-tools] externalMerge: pin update failed:', err);
    });
  }
  if (tab.source.title && tab.source.title !== tab.source.url) {
    void ctx.tabs.rename(created.id, tab.source.title);
  }
  return created.id;
}

export async function executeExternalMerge(
  session: NormalizedExternalSession,
  ctx: HandlerContext,
): Promise<ExternalMergeSummary> {
  const summary: ExternalMergeSummary = {
    sourceId: session.sourceId,
    workspacesCreated: 0,
    foldersCreated: 0,
    tabsOpened: 0,
    pinnedTabsOpened: 0,
    skippedDuplicates: 0,
    skippedUnsupportedUrls: 0,
    failedTabs: 0,
  };

  const seenUrls = await existingNormalizedUrls(ctx);
  const existingNames = new Set(
    ctx.workspaces.snapshot().workspaces.map((workspace) => workspace.name),
  );
  const plans = buildPlans(session, existingNames, seenUrls, summary);
  if (plans.length === 0) {
    throw new ExternalMergeError('no-importable-tabs', noImportableTabsMessage(session, summary));
  }
  const importedWorkspaceIds: string[] = [];
  let firstFocusableTabId: number | null = null;
  let firstCreatedTabId: number | null = null;

  for (const plan of plans) {
    const workspace = ctx.workspaces.create({ name: plan.workspaceName }, ctx.sourceWindowId, {
      activate: false,
    });

    const createdTabs: CreatedTab[] = [];
    for (const tab of plan.tabs) {
      try {
        const tabId = await createImportedTab(ctx, workspace, tab);
        if (tabId === null) {
          summary.failedTabs++;
          continue;
        }
        createdTabs.push({ source: tab.source, tabId });
        summary.tabsOpened++;
        if (tab.source.pinned) summary.pinnedTabsOpened++;
        if (firstCreatedTabId === null) firstCreatedTabId = tabId;
        if (!tab.source.pinned && firstFocusableTabId === null) firstFocusableTabId = tabId;
      } catch (err) {
        summary.failedTabs++;
        console.warn('[bento-tools] externalMerge: tabs.create failed:', err);
      }
    }

    if (createdTabs.length === 0) {
      ctx.workspaces.delete(workspace.id);
      continue;
    }

    importedWorkspaceIds.push(workspace.id);
    summary.workspacesCreated++;

    for (const group of plan.groups) {
      const members = createdTabs.filter(
        (created) => created.source.groupId === group.id && !created.source.pinned,
      );
      if (members.length === 0) continue;
      const folder = ctx.tabFolders.create({
        id: makeFolderId(),
        workspaceId: workspace.id,
        name: group.name,
      });
      summary.foldersCreated++;
      for (const member of members) {
        await ctx.tabs.setFolder(member.tabId, folder.id);
      }
    }
  }

  if (summary.tabsOpened === 0 && summary.failedTabs > 0) {
    throw new ExternalMergeError('no-importable-tabs', tabOpenFailureMessage(session));
  }

  const firstWorkspaceId = importedWorkspaceIds[0];
  if (firstWorkspaceId) {
    const result = ctx.workspaces.activate(firstWorkspaceId, ctx.sourceWindowId);
    if (result === 'conflict') {
      console.warn('[bento-tools] externalMerge: imported workspace activation conflict');
    }
  }

  const tabToFocus = firstFocusableTabId ?? firstCreatedTabId;
  if (tabToFocus !== null) {
    void browser.tabs.update(tabToFocus, { active: true }).catch((err) => {
      console.warn('[bento-tools] externalMerge: focus imported tab failed:', err);
    });
  }

  return summary;
}
