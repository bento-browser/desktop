// The Import step's view of the browsers chrome can import from (importSources.ts holds the pure
// parts and describes the exchange). Chrome sends its report when onboarding opens; this page keeps
// the latest one from `window` messages, so it is already here when the step is reached. A page
// that reaches the step without a report (reloaded, or chrome was still detecting) asks for it, and
// gives up after IMPORT_SOURCES_CEILING_MS so a lost reply cannot leave the step on placeholders.

import { useEffect, useState } from 'react';

import { sendChromeTitle } from '../bridge/chromeTitle';
import {
  IMPORT_SOURCES_CEILING_MS,
  importSourcesRequestTitle,
  importView,
  parseImportSourcesMessage,
  type ImportSourcesReport,
  type ImportView,
} from './importSources';

export function useImportSources(onImportStep: boolean): ImportView {
  const [report, setReport] = useState<ImportSourcesReport | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = parseImportSourcesMessage(event.data);
      if (next) setReport(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!onImportStep || report !== null) return;
    sendChromeTitle(importSourcesRequestTitle(String(Date.now())));
    const ceiling = setTimeout(() => setTimedOut(true), IMPORT_SOURCES_CEILING_MS);
    return () => clearTimeout(ceiling);
  }, [onImportStep, report]);

  return importView(report, timedOut);
}
