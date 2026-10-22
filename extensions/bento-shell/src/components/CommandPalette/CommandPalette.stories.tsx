// CommandPalette visual stories. The palette takes an onClose prop —
// stories pass a noop so the dialog stays open for inspection.

import { useEffect } from 'react';
import CommandPalette from './CommandPalette';
import { seedTabs, seedEmpty as seedEmptyTabs } from '../../state/__fixtures__/tabs';
import { seedMany, seedEmpty as seedEmptyWorkspaces } from '../../state/__fixtures__/workspaces';

const noop = () => {};

export const Default = () => {
  useEffect(() => {
    seedMany();
    seedTabs(8, 0);
  }, []);
  return <CommandPalette onClose={noop} />;
};

Default.storyName = 'Default (3 workspaces, 8 tabs)';

export const ManyTabs = () => {
  useEffect(() => {
    seedMany();
    seedTabs(50, 0);
  }, []);
  return <CommandPalette onClose={noop} />;
};

ManyTabs.storyName = '50 tabs (filter stress)';

export const EmptyState = () => {
  useEffect(() => {
    seedEmptyWorkspaces();
    seedEmptyTabs();
  }, []);
  return <CommandPalette onClose={noop} />;
};

EmptyState.storyName = 'No tabs, no workspaces (only static commands)';

export const SettingsResults = () => {
  useEffect(() => {
    seedMany();
    seedTabs(8, 0);
  }, []);
  return <CommandPalette onClose={noop} initialQuery="radius" />;
};

SettingsResults.storyName = 'Searching settings (Settings group, labels only)';

/** The one highlight, in light mode. Arrow keys slide it and the pointer moves it too. */
export const LightMode = () => {
  useEffect(() => {
    seedMany();
    seedTabs(8, 0);
    const root = document.documentElement;
    const names = ['data-color-mode', 'data-theme', 'data-muxui-color-scheme'];
    const before = names.map((name) => root.getAttribute(name));
    for (const name of names) root.setAttribute(name, 'light');
    return () => {
      names.forEach((name, index) => {
        const value = before[index];
        if (value === null || value === undefined) root.removeAttribute(name);
        else root.setAttribute(name, value);
      });
    };
  }, []);
  return <CommandPalette onClose={noop} />;
};

LightMode.storyName = 'Light mode (row highlight)';
