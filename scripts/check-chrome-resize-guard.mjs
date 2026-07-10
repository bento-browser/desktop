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
const chromeMount = readRepoFile(chromeMountPath);
const chromeTokens = readRepoFile(chromeTokensPath);

const normalPanelShadow =
  /--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\),\s*var\(--shadow-l\);/;
const globalLiveResizeShadowOverride =
  /:root\[(?:bento-window-resizing|bento-sidebar-resizing|bento-panel-resizing)='true'\][^{]*\{[^}]*--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\);/s;
const noPanelLiveResizeOutlineShadow =
  /:root\[bento-window-resizing='true'\]\s+#bento-strip-container\.bento-no-side-panels[^,{]*>\s*#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\s*,\s*:root\[bento-sidebar-resizing='true'\]\s+#bento-strip-container\.bento-no-side-panels[^,{]*>\s*#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\s*\{[^}]*box-shadow:\s*var\(--bento-panel-frame-outline-shadow\);/s;
const settingsAboutPanelResizeSpecGuard =
  /function isBentoSettingsAboutSpec\([^)]*\)\s*\{[\s\S]*about:preferences[\s\S]*about:settings[\s\S]*\}/;
const settingsAboutPanelResizeFreeze =
  /function freezePanelResizeSettingsAboutBrowsers\([^)]*\)\s*\{[\s\S]*preserveLayers\?\.\(true\)[\s\S]*docShellIsActive\s*=\s*false;/;
const settingsAboutPanelResizeRestore =
  /function restorePanelResizeSettingsAboutBrowsers\(\)\s*\{[\s\S]*docShellIsActive\s*=[\s\S]*true;/;
const scopedPanelResizeBegin =
  /beginBentoPanelResize\(leftPanel\)/;
const generatedShadowToken = /--shadow-l:\s*[^;]+;/;

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
  !settingsAboutPanelResizeSpecGuard.test(chromeMount) ||
  !settingsAboutPanelResizeFreeze.test(chromeMount) ||
  !settingsAboutPanelResizeRestore.test(chromeMount) ||
  !scopedPanelResizeBegin.test(chromeMount)
) {
  failures.push(
    `${chromeMountPath} must keep panel resize smooth for about:preferences/about:settings by freezing only the resized settings about-page browser during the panel drag and restoring it when resize settles.`,
  );
}

if (!generatedShadowToken.test(chromeTokens)) {
  failures.push(
    `${chromeTokensPath} is missing --shadow-l; run pnpm run import to regenerate chrome tokens.`,
  );
}

if (failures.length > 0) {
  console.error('Chrome resize guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Chrome resize guard passed.');
