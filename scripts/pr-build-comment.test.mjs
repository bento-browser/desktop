import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PR_BUILD_COMMENT_MARKER,
  artifactName,
  commentUpsertAction,
  findMatchingPullRequest,
  isLatestRelevantRun,
  renderComment,
  selectPlatformArtifact,
  updatePrBuildComment,
} from './pr-build-comment.mjs';

const repository = { id: 1, full_name: 'Bento-Browser/desktop' };
const headRepository = { id: 99, full_name: 'contributor/desktop' };

function run(overrides = {}) {
  return {
    id: 100,
    run_number: 20,
    run_attempt: 1,
    workflow_id: 7,
    event: 'pull_request',
    head_sha: 'a'.repeat(40),
    head_repository: headRepository,
    repository,
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    head: { sha: 'a'.repeat(40), repo: headRepository },
    base: { repo: repository },
    ...overrides,
  };
}

test('PR matching requires open state, exact source repository, and exact source SHA', () => {
  const currentRun = run();
  assert.equal(findMatchingPullRequest([pullRequest()], currentRun).number, 42);
  assert.equal(findMatchingPullRequest([pullRequest({ state: 'closed' })], currentRun), undefined);
  assert.equal(
    findMatchingPullRequest([pullRequest({ head: { sha: 'b'.repeat(40), repo: headRepository } })], currentRun),
    undefined,
  );
  assert.equal(
    findMatchingPullRequest([
      pullRequest({ head: { sha: currentRun.head_sha, repo: { id: 100, full_name: 'other/repo' } } }),
    ], currentRun),
    undefined,
  );
});

test('older run or rerun cannot update the comment after a newer relevant run', () => {
  const currentRun = run();
  assert.equal(
    isLatestRelevantRun(currentRun, [currentRun, run({ id: 101, run_number: 21 })], 42),
    false,
  );
  assert.equal(
    isLatestRelevantRun(
      currentRun,
      [currentRun, run({ id: currentRun.id, run_attempt: 2 })],
      42,
    ),
    false,
  );
  assert.equal(isLatestRelevantRun(currentRun, [currentRun], 42), true);
});

test('rendering links only allowlisted platform artifact names and preserves partial failures', () => {
  const currentRun = run();
  const body = renderComment({
    repository: repository.full_name,
    run: currentRun,
    platformResults: {
      'linux-x64': { state: 'available', artifact: { id: 301, expires_at: '2026-09-26T00:00:00Z' } },
      'windows-x64': { state: 'failed' },
      'macos-arm64': { state: 'missing' },
    },
    now: new Date('2026-09-12T00:00:00Z'),
  });
  assert.match(body, new RegExp(`\\[${artifactName('linux-x64', 1)}\\]`));
  assert.match(body, /Windows x64 \| failed/);
  assert.match(body, /macOS Apple Silicon \| missing/);
  assert.match(body, /actions\/runs\/100\/artifacts\/301/);
  assert.doesNotMatch(body, /actions\/runs\/301\/artifacts/);
  assert.match(body, new RegExp(PR_BUILD_COMMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('comment upsert updates only the bot-owned marker comment and creates when absent', () => {
  const body = `${PR_BUILD_COMMENT_MARKER}\nnew body`;
  const existing = [{ id: 5, body: 'old text', user: { login: 'octocat' } }];
  assert.deepEqual(commentUpsertAction(existing, body), { action: 'create', body });
  assert.deepEqual(
    commentUpsertAction([{ id: 6, body: `${PR_BUILD_COMMENT_MARKER}\nold`, user: { login: 'github-actions[bot]' } }], body),
    { action: 'update', commentId: 6, body },
  );
});

test('a completed event cannot publish metadata from a newer in-progress retry', async () => {
  const currentRun = run({ status: 'in_progress', run_attempt: 2 });
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: currentRun }),
      },
    },
  };
  const result = await updatePrBuildComment({
    github,
    context: {
      repo: { owner: 'Bento-Browser', repo: 'desktop' },
      payload: {
        workflow_run: {
          id: currentRun.id,
          event: 'pull_request',
          run_attempt: 1,
          pull_requests: [{ number: 42 }],
        },
      },
    },
  });
  assert.deepEqual(result, { status: 'ignored', reason: 'workflow run metadata is not a completed PR run' });
});

test('empty fork association is skipped when more than one open PR matches the source', async () => {
  const currentRun = run({ status: 'completed' });
  const associated = [{ number: 42 }, { number: 43 }];
  const listAssociated = async () => associated;
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: currentRun }),
      },
      repos: { listPullRequestsAssociatedWithCommit: listAssociated },
      pulls: {
        get: async ({ pull_number: number }) => ({ data: pullRequest({ number }) }),
      },
    },
    paginate: async (method) => (method === listAssociated ? associated : []),
  };
  const result = await updatePrBuildComment({
    github,
    context: {
      repo: { owner: 'Bento-Browser', repo: 'desktop' },
      payload: { workflow_run: { id: currentRun.id, event: 'pull_request', pull_requests: [] } },
    },
  });
  assert.deepEqual(result, { status: 'ignored', reason: 'no matching open pull request' });
});

test('failed-job retries retain earlier successful downloads and their original attempt labels', async () => {
  const currentRun = run({ status: 'completed', run_attempt: 2, pull_requests: [{ number: 42 }] });
  const artifacts = [
    { id: 301, name: artifactName('linux-x64', 1) },
    { id: 302, name: artifactName('macos-arm64', 1) },
    { id: 303, name: artifactName('windows-x64', 2) },
    { id: 304, name: artifactName('linux-x64', 3) },
    { id: 305, name: 'bento-pr-linux-x64-attempt-2-bad' },
  ];
  assert.equal(selectPlatformArtifact(artifacts, 'linux-x64', 2).id, 301);
  assert.equal(selectPlatformArtifact(artifacts, 'windows-x64', 2).id, 303);
  const listWorkflowRuns = () => {};
  const listWorkflowRunArtifacts = () => {};
  const listJobsForWorkflowRun = () => {};
  const listComments = () => {};
  const writes = [];
  let comments = [];
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: currentRun }),
        listWorkflowRuns, listWorkflowRunArtifacts, listJobsForWorkflowRun,
      },
      pulls: { get: async () => ({ data: pullRequest() }) },
      issues: {
        listComments,
        createComment: async (args) => { writes.push({ action: 'create', ...args }); },
        updateComment: async (args) => { writes.push({ action: 'update', ...args }); },
      },
    },
    paginate: async (method) => {
      if (method === listWorkflowRuns) return [currentRun];
      if (method === listWorkflowRunArtifacts) return artifacts;
      if (method === listJobsForWorkflowRun) return [];
      if (method === listComments) return comments;
      throw new Error('Unexpected API call');
    },
  };
  const context = {
    repo: { owner: 'Bento-Browser', repo: 'desktop' },
    payload: { workflow_run: currentRun },
  };
  assert.equal((await updatePrBuildComment({ github, context })).status, 'create');
  assert.equal(writes[0].issue_number, 42);
  assert.match(writes[0].body, /bento-pr-linux-x64-attempt-1/);
  assert.match(writes[0].body, /bento-pr-windows-x64-attempt-2/);
  assert.match(writes[0].body, /actions\/runs\/100\/artifacts\/302/);
  assert.doesNotMatch(writes[0].body, /attempt-3|attempt-2-bad|missing/);
  comments = [{ id: 5, body: writes[0].body, user: { login: 'github-actions[bot]' } }];
  assert.equal((await updatePrBuildComment({ github, context })).status, 'update');
  assert.equal(writes[1].comment_id, 5);
});
