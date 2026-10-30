// Top-level App stories. Beyond proving Mux UI renders inside Ladle, the
// Collapsed and CollapseToggle stories are how we iterate on the narrow-rail
// behaviour without rebuilding the whole browser. CollapseToggle is the
// interactive demo: clicking the collapse/expand IconButton in the footer
// updates the settings store via the same BroadcastChannel the real shell
// uses. The App switches to the rail layout from the width of its own frame,
// the way the real shell does from the width chrome gives its host, so the
// frame width is what these stories set (chrome's slide animation is not
// reproduced here; the frame snaps).
import { useEffect, useRef, useState } from 'react';
import { App } from './App';
// The shell layout (sidebar column, footer stacking in the collapsed rail). Every
// selector in it is scoped to the shell's own classes, so loading it here does not
// touch other stories. Its bento.app layer ranks above bento.components through the
// order statement in theme/muxui.css, whatever order the imports run in.
import './app.css';
import { seedTabsAcrossWorkspaces } from './state/__fixtures__/tabs';
import {
  seedMany as seedManyWorkspaces,
  seedPrivate as seedPrivateWorkspace,
} from './state/__fixtures__/workspaces';
import { seedPanelsByWorkspace, seedPanelsHydrated } from './state/__fixtures__/panels';
import { seedTabFolders } from './state/__fixtures__/tabFolders';
import { seedEmptyPinnedPanels } from './state/__fixtures__/pinnedPanels';
import { DEFAULT_FIXTURE } from './state/__fixtures__/settings';
import { markToolsBootedForStory } from './state/__fixtures__/bus';
import { openSearchForStory } from './components/TabList/openSearchForStory';
import { useExternalMergeStore } from './state/externalMerge';
import { useSettingsStore } from './state/settings';
import { useWorkspacesStore } from './state/workspaces';
import { useSidebarAddressStore } from './state/sidebarAddress';
import type { Action } from '@shared/protocol';
import { afterMotion } from './motion/afterMotion';
import { measureRailWidth } from './sidebar/railViewport';
import { useTabsStore } from './state/tabs';
import { makeFolder } from './state/__fixtures__/tabFolders';
import { makePinnedEntry, seedPinnedPanels } from './state/__fixtures__/pinnedPanels';
import './sidebar/railTransition.stories.css';

const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

// Most windows have side panels, and the rail then takes the toolbar's colour (the rail
// look in app.css). A window with none keeps the rail on the brand background, which is
// the toolbar's colour there. One panel per workspace is enough to tell them apart.
function seedSidePanels(workspaceIds: string[], present: boolean) {
  if (present) {
    seedPanelsByWorkspace(Object.fromEntries(workspaceIds.map((id) => [id, [1]])));
  } else {
    seedPanelsHydrated(workspaceIds);
  }
}

function ShellFrame({
  children,
  width = 300,
}: {
  children: React.ReactNode;
  width?: number | string;
}) {
  // Match the real shell's host frame: fixed-width column on a brand-bg
  // canvas. Collapsed stories use the same token chrome applies to
  // #bento-shell-host, which is what turns the rail visuals on.
  return (
    <div
      style={{
        width,
        height: 600,
        backgroundColor: 'var(--bento-brand-bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

// Seed the full shell: 3 workspaces (Personal blue / Work emerald / Side
// project amber, Work active), tabs spread across all three so switching
// workspaces in the demo shows distinct lists, an empty folder list, and
// panels marked hydrated for every workspace. TabList shows its skeleton
// until tabs, folders and the active workspace's panels have all hydrated,
// so every one of those is seeded. Settings carry the requested
// sidebarCollapsed value. The sidebar address, pinned-panel and external-merge
// stores are reset: a fresh shell has no address snapshot, no pinned panels and
// no import running until the chrome bridge sends them, and these stores
// outlive a story switch, so another story's data would otherwise stay.
function seedShell(sidebarCollapsed: boolean, sidePanels = true) {
  const workspaces = seedManyWorkspaces();
  seedTabsAcrossWorkspaces(
    [
      { workspaceId: 'w-personal', count: 5 },
      { workspaceId: 'w-work', count: 8 },
      { workspaceId: 'w-side', count: 3 },
    ],
    'w-work',
  );
  seedTabFolders([]);
  seedSidePanels(
    workspaces.map((w) => w.id),
    sidePanels,
  );
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed });
  useSidebarAddressStore.getState().reset();
  seedEmptyPinnedPanels();
  useExternalMergeStore.setState(useExternalMergeStore.getInitialState());
  // Fake a tools/booted event AFTER seeding so the App's "connecting…"
  // indicator clears. Order matters: useToolsPort responds to booted by
  // re-requesting snapshots; nothing answers those in Ladle, but if we
  // primed the bus before seeding we'd have a brief window where the
  // store transitions through whatever-was-there before our snapshot.
  markToolsBootedForStory();
}

export const Default = () => {
  useEffect(() => {
    seedShell(false);
  }, []);
  return (
    <ShellFrame>
      <App />
    </ShellFrame>
  );
};

export const Collapsed = () => {
  useEffect(() => {
    seedShell(true);
  }, []);
  return (
    <ShellFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <App />
    </ShellFrame>
  );
};

Collapsed.storyName = 'Collapsed (narrow rail)';

export const CollapsedNoSidePanels = () => {
  useEffect(() => {
    seedShell(true, false);
  }, []);
  return (
    <ShellFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <App />
    </ShellFrame>
  );
};

CollapsedNoSidePanels.storyName = 'Collapsed, no side panels (rail stays brand background)';

// A private window: the Private band instead of the workspace switcher, one temporary
// workspace, no pinned panels. The workspace's `private` flag is what marks the window
// here; the real shell also reads the #bentoPrivate=1 hash its frames carry.
function seedPrivateWindow(sidebarCollapsed: boolean, tabCount: number) {
  const [workspace] = seedPrivateWorkspace();
  seedTabsAcrossWorkspaces([{ workspaceId: workspace!.id, count: tabCount }], workspace!.id);
  seedTabFolders([]);
  seedSidePanels([workspace!.id], true);
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed });
  useSidebarAddressStore.getState().reset();
  seedEmptyPinnedPanels();
  useExternalMergeStore.setState(useExternalMergeStore.getInitialState());
  markToolsBootedForStory();
}

export const PrivateWindow = () => {
  useEffect(() => {
    seedPrivateWindow(false, 4);
  }, []);
  return (
    <ShellFrame>
      <App />
    </ShellFrame>
  );
};

PrivateWindow.storyName = 'Private window';

export const PrivateWindowEmpty = () => {
  useEffect(() => {
    seedPrivateWindow(false, 1);
  }, []);
  return (
    <ShellFrame>
      <App />
    </ShellFrame>
  );
};

PrivateWindowEmpty.storyName = 'Private window, one new tab';

export const PrivateWindowCollapsed = () => {
  useEffect(() => {
    seedPrivateWindow(true, 4);
  }, []);
  return (
    <ShellFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <App />
    </ShellFrame>
  );
};

PrivateWindowCollapsed.storyName = 'Private window (narrow rail)';

export const CollapseToggle = () => {
  // Interactive demo. The App's collapse IconButton dispatches
  // { type: 'settings/update', changes: { sidebarCollapsed } } onto the
  // 'bento-shell-bus' BroadcastChannel; in real Bento the background page
  // forwards that to bento-tools which writes the setting and broadcasts
  // back. Here we short-circuit by listening on the same channel and
  // applying the change directly to useSettingsStore — the App re-reads
  // sidebarCollapsed from the store and the frame below resizes.
  useEffect(() => {
    seedShell(false);
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('bento-shell-bus');
    const onMessage = (msg: MessageEvent) => {
      const data = msg.data as { kind?: string; action?: Action } | null;
      if (!data || data.kind !== 'action' || !data.action) return;
      if (data.action.type !== 'settings/update') return;
      const cur = useSettingsStore.getState().current ?? DEFAULT_FIXTURE;
      useSettingsStore.getState().apply({ ...cur, ...data.action.changes });
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, []);
  // The frame is the shell's viewport here: it takes the setting's width at
  // once, and the App's own width observer flips the rail visuals with it.
  const collapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  return (
    <ShellFrame width={collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300}>
      <App />
    </ShellFrame>
  );
};

CollapseToggle.storyName = 'Collapse toggle (interactive)';

// ─── Collapse choreography ──────────────────────────────────────────────────
// The App inside a reproduction of chrome's push (railTransition.stories.css): the
// settings change reaches the shell first, chrome starts the slide after the shell's
// commit, widens the host at the start of an expand and snaps it to the rail at the end
// of a collapse (afterMotion on the slide, as bento-shell-mount.js does). A toggle
// mid-slide settles chrome at the end state and starts the new slide from there.
//
// The window around it is chrome's: the page area is the toolbar's main colour, the host
// edge line fades with the colour change, and the rail look (app.css) and its fade
// (railTransition.css) run on the App itself.
//
// URL hooks for screenshots (append to the story URL): state=rail starts collapsed,
// panels=none removes the side panels (the rail stays on the brand background),
// pinned=1 shows pinned panels, folder=long puts most tabs in the folder (its children
// active and indented), ws=personal starts in the Personal workspace, switch=1 switches
// to Personal while the frozen phase runs, scroll=<px> scrolls the list first,
// search=open|<query> opens the sidebar search field (typing <query>) on load, so a collapse
// starts with the field open, and
// dir=collapse|expand&t=<ms> runs that toggle and freezes every animation at t ms (motion
// tokens are scaled 100x first, so no end timer fires while frozen; dir=none only applies
// the other hooks).
const STORY_EXPANDED_WIDTH = 300;
const STORY_SCALED_TOKENS = [
  '--muxui-semantic-motion-reveal-transition-spring-duration',
  '--muxui-semantic-motion-reveal-duration',
  '--muxui-semantic-motion-state-duration',
  '--muxui-semantic-motion-exit-duration',
];
const FREEZE_SCALE = 100;

/** Slow motion: multiplies the motion tokens the push and the choreography read. */
function scaleMotionTokens(scale: number) {
  const html = document.documentElement;
  for (const name of STORY_SCALED_TOKENS) html.style.removeProperty(name);
  if (scale === 1) return;
  const style = getComputedStyle(html);
  for (const name of STORY_SCALED_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    const ms = value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000;
    if (ms > 0) html.style.setProperty(name, `${ms * scale}ms`);
  }
}

function seedChoreography(
  collapsed: boolean,
  pinned: boolean,
  longFolder: boolean,
  sidePanels: boolean,
) {
  const workspaces = seedManyWorkspaces();
  const tabs = seedTabsAcrossWorkspaces(
    [
      { workspaceId: 'w-personal', count: 3 },
      { workspaceId: 'w-work', count: longFolder ? 120 : 36 },
    ],
    'w-work',
  );
  // The second row is the active one, and tabs 7 and 8 sit in a folder (with
  // longFolder, every tab from 7 on, so a scrolled window holds only folder children).
  const inFolder = (id: number) => id === 7 || id === 8 || (longFolder && id > 8);
  useTabsStore.getState().applySnapshot(
    tabs.map((tab) => ({
      ...tab,
      active: tab.id === (longFolder ? 64 : 5),
      ...(inFolder(tab.id) ? { folderId: 'folder-reading' } : {}),
    })),
  );
  seedTabFolders([
    makeFolder({ id: 'folder-reading', workspaceId: 'w-work', name: 'Reading', order: 1 }),
  ]);
  seedSidePanels(
    workspaces.map((w) => w.id),
    sidePanels,
  );
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed: collapsed });
  useSidebarAddressStore.getState().reset();
  seedPinnedPanels(
    pinned ? [30, 31, 32].map((tabId) => makePinnedEntry({ workspaceId: 'w-work', tabId })) : [],
  );
  useExternalMergeStore.setState(useExternalMergeStore.getInitialState());
  markToolsBootedForStory();
}

function switchToPersonal() {
  const { byId, activeIdByWindow } = useWorkspacesStore.getState();
  const byWindow = Object.fromEntries(
    Object.keys(activeIdByWindow).map((id) => [id, 'w-personal']),
  );
  useWorkspacesStore.getState().applySnapshot(Object.values(byId), 'w-personal', byWindow);
}

type StoryPush = 'collapse' | 'expand' | null;

export const CollapseChoreography = () => {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const freezeDir = params.get('dir');
  const startCollapsed = params.get('state') === 'rail' || freezeDir === 'expand';
  const [pinned, setPinned] = useState(params.get('pinned') === '1');
  const [speed, setSpeed] = useState(1);
  const [push, setPush] = useState<StoryPush>(null);
  // Chrome's settled host: the rail width once a collapse has ended.
  const [hostRail, setHostRail] = useState(startCollapsed);
  const [railWidth, setRailWidth] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const appliedCollapsed = useRef(startCollapsed);

  useEffect(() => {
    seedChoreography(
      startCollapsed,
      pinned,
      params.get('folder') === 'long',
      params.get('panels') !== 'none',
    );
    if (params.get('ws') === 'personal') switchToPersonal();
    const search = params.get('search');
    const stopSearch =
      search === null || startCollapsed
        ? undefined
        : openSearchForStory(search === 'open' ? '' : search);
    setRailWidth(measureRailWidth());
    const channel = new BroadcastChannel('bento-shell-bus');
    channel.addEventListener('message', (message: MessageEvent) => {
      const data = message.data as { kind?: string; action?: Action } | null;
      if (data?.kind !== 'action' || data.action?.type !== 'settings/update') return;
      const current = useSettingsStore.getState().current ?? DEFAULT_FIXTURE;
      useSettingsStore.getState().apply({ ...current, ...data.action.changes });
    });
    return () => {
      stopSearch?.();
      channel.close();
      scaleMotionTokens(1);
    };
    // Seeds once; the pinned toggle reseeds below.
  }, []);

  useEffect(() => {
    seedPinnedPanels(
      pinned ? [30, 31, 32].map((tabId) => makePinnedEntry({ workspaceId: 'w-work', tabId })) : [],
    );
  }, [pinned]);

  const collapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? startCollapsed);
  // Chrome hears of the change after the shell's commit, settles a running slide at its
  // end state and starts the new one: an expand widens the host at once.
  useEffect(() => {
    if (appliedCollapsed.current === collapsed) return;
    appliedCollapsed.current = collapsed;
    if (!collapsed) setHostRail(false);
    setPush(collapsed ? 'collapse' : 'expand');
  }, [collapsed]);

  useEffect(() => {
    const host = hostRef.current;
    if (!push || !host) return;
    const name = push === 'collapse' ? 'bento-rail-story-out' : 'bento-rail-story-in';
    return afterMotion(host, { animations: [name] }, () => {
      setPush(null);
      if (push === 'collapse') setHostRail(true);
    });
  }, [push]);

  const toggle = () => {
    const current = useSettingsStore.getState().current ?? DEFAULT_FIXTURE;
    useSettingsStore
      .getState()
      .apply({ ...current, sidebarCollapsed: !current.sidebarCollapsed, sidebarHidden: false });
  };

  // Screenshot hooks: scroll the list, then run one toggle and freeze it at t.
  useEffect(() => {
    const scroll = Number(params.get('scroll') ?? 0);
    const scrollTimer = setTimeout(() => {
      document.querySelector('.bento-tab-list-pane__scroller')?.scrollTo(0, scroll);
    }, 300);
    if (freezeDir !== 'collapse' && freezeDir !== 'expand') return () => clearTimeout(scrollTimer);
    const at = Number(params.get('t') ?? 0) * FREEZE_SCALE;
    let frame = 0;
    const timer = setTimeout(() => {
      scaleMotionTokens(FREEZE_SCALE);
      toggle();
      // Chrome's slide starts after the shell's commit, and an expand's phase when the
      // host widens: wait for both.
      const freeze = () => {
        if (
          document.documentElement.getAttribute('data-bento-rail-transition') !== freezeDir ||
          !document.querySelector(`.bento-rail-story[data-push='${freezeDir}']`)
        ) {
          frame = requestAnimationFrame(freeze);
          return;
        }
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = at;
        }
        document.documentElement.dataset.bentoStoryFrozen = 'true';
        if (params.get('switch') === '1') switchToPersonal();
      };
      frame = requestAnimationFrame(freeze);
    }, 600);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, []);

  const delta = Math.max(0, STORY_EXPANDED_WIDTH - railWidth);
  const hostWidth = hostRail ? COLLAPSED_SIDEBAR_WIDTH : STORY_EXPANDED_WIDTH;
  // Chrome lays the page out at the narrow end for the whole slide.
  const pageLeft = hostRail || push ? railWidth : STORY_EXPANDED_WIDTH;
  return (
    <div>
      <div
        style={{
          display: freezeDir ? 'none' : 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <button type="button" onClick={toggle}>
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
        {[1, 0.25, 0.1].map((rate) => (
          <button
            key={rate}
            type="button"
            aria-pressed={speed === rate}
            onClick={() => {
              setSpeed(rate);
              scaleMotionTokens(1 / rate);
            }}
          >
            {rate}x
          </button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
          />{' '}
          Pinned panels
        </label>
        {/* Open the sidebar search field, empty or with a query, then collapse to see it fold
            into the rail's Search square (the footer toggle is the pointer path, this
            Collapse button the keyboard one). */}
        <button type="button" onClick={() => openSearchForStory('')}>
          Open search
        </button>
        <button type="button" onClick={() => openSearchForStory('bento')}>
          Search bento
        </button>
      </div>
      <div
        className="bento-rail-story"
        data-push={push ?? undefined}
        style={
          {
            width: 680,
            height: 560,
            '--bento-rail-story-delta': `${delta}px`,
          } as React.CSSProperties
        }
      >
        <div className="bento-rail-story__page" style={{ left: pageLeft + 6 }} />
        <div ref={hostRef} className="bento-rail-story__host" style={{ width: hostWidth }}>
          <div className="bento-rail-story__frame">
            <App />
          </div>
        </div>
      </div>
    </div>
  );
};

CollapseChoreography.storyName = 'Collapse choreography (chrome push)';
