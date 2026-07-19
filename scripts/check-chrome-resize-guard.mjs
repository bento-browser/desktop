#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${relativePath}: ${err.message}`);
  }
}

const chromeMountPath = 'src/browser/base/content/bento-shell-mount.js';
const chromeTokensPath = 'src/browser/base/content/bento-chrome-tokens.css';
const chromeThemePath = 'src/browser/base/content/bento-chrome-theme.css';
const chromeMount = readRepoFile(chromeMountPath);
const chromeTokens = readRepoFile(chromeTokensPath);
const chromeTheme = readRepoFile(chromeThemePath);

const normalPanelShadow =
  /--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\),\s*var\(--shadow-l\);/;
const globalLiveResizeShadowOverride =
  /:root\[(?:bento-window-resizing|bento-sidebar-resizing|bento-panel-resizing)='true'\][^{]*\{[^}]*--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\);/s;
const noPanelLiveResizeOutlineShadow =
  /:root\[bento-window-resizing='true'\]\s+#bento-strip-container\.bento-no-side-panels[^,{]*>\s*#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\s*,\s*:root\[bento-sidebar-resizing='true'\]\s+#bento-strip-container\.bento-no-side-panels[^,{]*>\s*#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\s*\{[^}]*box-shadow:\s*var\(--bento-panel-frame-outline-shadow\);/s;
const settingsAboutLiveResizeSpecGuard =
  /function isBentoSettingsAboutSpec\([^)]*\)\s*\{[\s\S]*about:preferences[\s\S]*about:settings[\s\S]*\}/;
const settingsAboutLiveResizeFreeze =
  /function freezeSettingsAboutBrowsersForLiveResize\(\)\s*\{[\s\S]*?for \(const browserEl of window\.gBrowser\?\.browsers \|\| \[\]\)[\s\S]*preserveLayers\?\.\(true\)[\s\S]*docShellIsActive\s*=\s*false;/;
const settingsAboutLiveResizeRestore =
  /function restoreSettingsAboutBrowsersAfterLiveResize\(\)\s*\{[\s\S]*docShellIsActive\s*=[\s\S]*true;/;
const settingsAboutAllTabsFreeze =
  /function beginBentoSettingsAboutLiveResize\(\)\s*\{\s*freezeSettingsAboutBrowsersForLiveResize\(\)/;
const settingsAboutPanelResizeLifecycle =
  /function beginBentoPanelResize\(\)\s*\{\s*beginBentoSettingsAboutLiveResize\(\)[\s\S]*function endBentoPanelResize\(\)[\s\S]*endBentoSettingsAboutLiveResize\(\)/;
const settingsAboutSidebarResizeLifecycle =
  /function attachSidebarSplitterFeedback\(\)[\s\S]*beginBentoSettingsAboutLiveResize\(\)[\s\S]*endBentoSettingsAboutLiveResize\(\)/;
const settingsAboutWindowResizeLifecycle =
  /function attachWindowResizePerfMode\(\)[\s\S]*beginBentoSettingsAboutLiveResize\(\)[\s\S]*endBentoSettingsAboutLiveResize\(\)/;
const generatedShadowToken = /--shadow-l:\s*[^;]+;/;
const nativeSidebarLauncherSuppression =
  /:root\[bento-sidebar-addressbar='true'\]\s+:is\(\s*#sidebar-main,\s*#sidebar-launcher-splitter,\s*#sidebar-button,\s*#wrapper-sidebar-button\s*\)\s*\{[^}]*display:\s*none\s*!important;[^}]*visibility:\s*collapse\s*!important;/s;

const failures = [];

if (!normalPanelShadow.test(chromeMount)) {
  failures.push(
    `${chromeMountPath} must define normal panel frames with ` +
      '`--bento-panel-frame-outline-shadow, var(--shadow-l)`.',
  );
}

if (globalLiveResizeShadowOverride.test(chromeMount)) {
  failures.push(
    `${chromeMountPath} must not globally override --bento-panel-frame-shadow for live resize; scope outline-only live resize to the no-side-panels frame.`,
  );
}

if (!noPanelLiveResizeOutlineShadow.test(chromeMount)) {
  failures.push(
    `${chromeMountPath} must directly keep the no-side-panels browserSidebarContainer frame outline-only during live window/sidebar resize.`,
  );
}

if (
  !settingsAboutLiveResizeSpecGuard.test(chromeMount) ||
  !settingsAboutLiveResizeFreeze.test(chromeMount) ||
  !settingsAboutLiveResizeRestore.test(chromeMount) ||
  !settingsAboutAllTabsFreeze.test(chromeMount) ||
  !settingsAboutPanelResizeLifecycle.test(chromeMount) ||
  !settingsAboutSidebarResizeLifecycle.test(chromeMount) ||
  !settingsAboutWindowResizeLifecycle.test(chromeMount)
) {
  failures.push(
    `${chromeMountPath} must keep panel, sidebar, and window resize smooth when about:preferences/about:settings is open in any tab by freezing every settings about-page browser during live resize and restoring it when all resize gestures settle.`,
  );
}

if (!generatedShadowToken.test(chromeTokens)) {
  failures.push(
    `${chromeTokensPath} is missing --shadow-l; run pnpm run import to regenerate chrome tokens.`,
  );
}

if (!nativeSidebarLauncherSuppression.test(chromeTheme)) {
  failures.push(
    `${chromeThemePath} must hide Firefox's native sidebar launcher, launcher splitter, and generic toolbar toggle while Bento owns the sidebar.`,
  );
}

if (failures.length > 0) {
  console.error('Chrome resize guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Chrome resize guard passed.');
