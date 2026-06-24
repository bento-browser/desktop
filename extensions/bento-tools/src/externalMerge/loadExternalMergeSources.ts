import type { ExternalMergeSource } from '@shared/protocol';
import type { ExternalSessionCandidate, ExternalSessionSnapshot } from './sourceTypes';
import { ExternalMergeError } from './sourceTypes';
import {
  externalMergeSourceFromSession,
  normalizeExternalSession,
} from './normalizeExternalSession';

interface SourceLoadFailure {
  candidate: ExternalSessionCandidate;
  phase: 'read' | 'normalize' | 'empty';
  message: string;
}

function hasExternalSessionsApi(): boolean {
  return typeof browser.bentoExternalSessions?.listCandidates === 'function';
}

function safeFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!message || message.includes('/') || message.includes('\\'))
    return 'The session could not be read.';
  return message;
}

function allFailedMessage(failures: SourceLoadFailure[]): string {
  const first = failures[0];
  if (!first) return 'Browser sessions were found, but none could be read.';

  const unreadableCount = failures.filter((failure) => failure.phase === 'read').length;
  const emptyCount = failures.filter((failure) => failure.phase === 'empty').length;
  const sourceLabel = `${first.candidate.browserName} ${first.candidate.profileName}`.trim();
  const firstReason = `${sourceLabel}: ${first.message}`;

  if (unreadableCount === failures.length) {
    return `Browser sessions were found, but Bento could not read their session files. First failure: ${firstReason}`;
  }
  if (emptyCount === failures.length) {
    return `Browser sessions were found, but they contained no importable tabs. First failure: ${firstReason}`;
  }
  return `Browser sessions were found, but none could be imported. First failure: ${firstReason}`;
}

function unavailableSourceFromFailure(failure: SourceLoadFailure): ExternalMergeSource {
  const visibleButUnreadable = failure.message.match(
    /^Session files were found, but file reads failed(?: \(([^/\\)]+)\))?\.$/,
  );
  const readReason = visibleButUnreadable
    ? `Session files visible, but unreadable${visibleButUnreadable[1] ? ` (${visibleButUnreadable[1]})` : ''}`
    : 'Session file unreadable';

  return {
    id: failure.candidate.sourceId,
    kind: failure.candidate.kind,
    browserName: failure.candidate.browserName,
    profileName: failure.candidate.profileName,
    lastModified: failure.candidate.lastModified,
    windowCount: 0,
    tabCount: 0,
    groupCount: 0,
    unavailableReason:
      failure.phase === 'read'
        ? readReason
        : failure.phase === 'empty'
          ? 'No importable live tabs'
          : 'Unsupported session format',
  };
}

export async function loadExternalMergeSources(): Promise<ExternalMergeSource[]> {
  if (!hasExternalSessionsApi()) {
    throw new ExternalMergeError(
      'unreadable',
      'Browser session reader is not available. Restart Bento after rebuilding the tools addon.',
    );
  }

  let candidates: ExternalSessionCandidate[];
  try {
    candidates = await browser.bentoExternalSessions.listCandidates();
  } catch (err) {
    console.warn('[bento-tools] externalMerge/listCandidates failed:', err);
    throw new ExternalMergeError('unreadable', 'Browser session discovery failed.');
  }

  const sources: ExternalMergeSource[] = [];
  const failures: SourceLoadFailure[] = [];
  for (const candidate of candidates) {
    let snapshot: ExternalSessionSnapshot;
    try {
      snapshot = (await browser.bentoExternalSessions.readSnapshot(
        candidate.sourceId,
      )) as ExternalSessionSnapshot;
    } catch (err) {
      const message = safeFailureMessage(err);
      failures.push({ candidate, phase: 'read', message });
      console.warn(
        '[bento-tools] externalMerge: omitting unreadable source',
        candidate.kind,
        candidate.profileName,
        message,
      );
      continue;
    }

    try {
      const session = normalizeExternalSession(snapshot);
      const source = externalMergeSourceFromSession(session);
      if (source) {
        sources.push(source);
      } else {
        const message = 'No importable live tabs were found.';
        failures.push({ candidate, phase: 'empty', message });
        console.warn(
          '[bento-tools] externalMerge: omitting empty source',
          candidate.kind,
          candidate.profileName,
          message,
        );
      }
    } catch (err) {
      const message = safeFailureMessage(err);
      failures.push({ candidate, phase: 'normalize', message });
      console.warn(
        '[bento-tools] externalMerge: omitting unsupported source',
        candidate.kind,
        candidate.profileName,
        message,
      );
    }
  }

  const unavailableSources = failures.map(unavailableSourceFromFailure);

  if (candidates.length > 0 && sources.length === 0 && failures.length > 0) {
    console.warn('[bento-tools] externalMerge: no mergeable sources:', allFailedMessage(failures));
  }

  return [...sources, ...unavailableSources].sort((a, b) => b.lastModified - a.lastModified);
}
