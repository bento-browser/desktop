#!/usr/bin/env node

/**
 * Shared policy and GitHub API driver for the trusted PR build comment.
 *
 * This module is loaded only by the workflow_run workflow, which checks out
 * the default branch. The build workflow is untrusted PR code, so all links
 * are derived from this allowlist and the current workflow run's API data.
 */

export const PR_BUILD_COMMENT_MARKER = '<!-- bento-pr-builds:v1 -->';
export const PR_BUILD_RETENTION_DAYS = 14;
export const PR_BUILD_WORKFLOW_EVENT = 'workflow_dispatch';

export const PR_BUILD_PLATFORMS = Object.freeze([
  Object.freeze({
    key: 'linux-x64',
    label: 'Linux x64',
    format: '.tar.xz or .tar.bz2',
    jobName: 'Build (linux-x64)',
  }),
  Object.freeze({
    key: 'windows-x64',
    label: 'Windows x64',
    format: '.exe installer and .zip',
    jobName: 'Build (windows-x64)',
  }),
  Object.freeze({
    key: 'macos-arm64',
    label: 'macOS Apple Silicon',
    format: '.dmg',
    jobName: 'Build (macos-arm64)',
  }),
]);

const platformByKey = new Map(PR_BUILD_PLATFORMS.map((platform) => [platform.key, platform]));

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function artifactName(platformKey, runAttempt) {
  if (!platformByKey.has(platformKey)) throw new Error(`Unknown PR build platform: ${platformKey}`);
  return `bento-pr-${platformKey}-attempt-${positiveInteger(runAttempt, 'run attempt')}`;
}

function sameRepository(left, right) {
  if (!left || !right) return false;
  if (left.id !== undefined && left.id !== null && right.id !== undefined && right.id !== null) {
    return left.id === right.id;
  }
  return Boolean(left.full_name && right.full_name && left.full_name === right.full_name);
}

function sameHeadRepository(left, right) {
  if (!sameRepository(left, right)) return false;
  return !left.full_name || !right.full_name || left.full_name === right.full_name;
}

export function isMatchingPullRequest(pullRequest, run) {
  if (!pullRequest || pullRequest.state !== 'open') return false;
  if (!Number.isSafeInteger(Number(pullRequest.number))) return false;
  if (!run?.head_sha || pullRequest.head?.sha !== run.head_sha) return false;
  if (!sameHeadRepository(pullRequest.head?.repo, run.head_repository)) return false;

  const baseRepository = run.repository;
  if (baseRepository && pullRequest.base?.repo && !sameRepository(pullRequest.base.repo, baseRepository)) {
    return false;
  }
  return true;
}

export function findMatchingPullRequest(pullRequests, run) {
  return pullRequests.find((pullRequest) => isMatchingPullRequest(pullRequest, run));
}

function sameRunIdentity(candidate, current) {
  return (
    candidate?.event === PR_BUILD_WORKFLOW_EVENT &&
    candidate.workflow_id === current.workflow_id &&
    candidate.head_sha === current.head_sha &&
    sameHeadRepository(candidate.head_repository, current.head_repository)
  );
}

function runOrder(run) {
  const runNumber = Number(run.run_number);
  if (Number.isSafeInteger(runNumber) && runNumber > 0) return [2, runNumber, Number(run.id) || 0];

  const createdAt = Date.parse(run.created_at || '');
  return [1, Number.isFinite(createdAt) ? createdAt : 0, Number(run.id) || 0];
}

function compareRuns(left, right) {
  const leftOrder = runOrder(left);
  const rightOrder = runOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] - rightOrder[index];
  }

  const leftAttempt = Number(left.run_attempt) || 1;
  const rightAttempt = Number(right.run_attempt) || 1;
  return leftAttempt - rightAttempt;
}

export function isLatestRelevantRun(current, runs, pullRequestNumber) {
  return !runs.some((candidate) => {
    if (candidate.id === current.id && Number(candidate.run_attempt) <= Number(current.run_attempt)) {
      return false;
    }
    if (!sameRunIdentity(candidate, current)) return false;

    const candidatePullRequests = candidate.pull_requests;
    if (
      Array.isArray(candidatePullRequests) &&
      candidatePullRequests.length > 0 &&
      !candidatePullRequests.some((pullRequest) => Number(pullRequest.number) === Number(pullRequestNumber))
    ) {
      return false;
    }
    return compareRuns(candidate, current) > 0;
  });
}

export function classifyPlatform({ artifact, job }) {
  if (artifact && !artifact.expired) return { state: 'available', artifact };

  if (!job) return { state: artifact?.expired ? 'expired' : 'not run' };

  const conclusion = job?.conclusion;
  if (conclusion === 'failure' || conclusion === 'timed_out') return { state: 'failed' };
  if (conclusion === 'cancelled') return { state: 'cancelled' };
  if (conclusion === 'skipped') return { state: 'not run' };
  if (artifact?.expired) return { state: 'expired' };
  return { state: 'missing' };
}

// Failed-job retries keep successful artifacts from earlier attempts of this
// same run. Never accept a different platform or a future attempt's artifact.
export function selectPlatformArtifact(artifacts, platformKey, runAttempt) {
  const currentAttempt = positiveInteger(runAttempt, 'run attempt');
  const prefix = `bento-pr-${platformKey}-attempt-`;
  const candidates = artifacts.flatMap((artifact) => {
    if (!artifact.name?.startsWith(prefix)) return [];
    const suffix = artifact.name.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(suffix)) return [];
    const attempt = Number(suffix);
    if (!Number.isSafeInteger(attempt) || attempt > currentAttempt) return [];
    if (artifact.name !== artifactName(platformKey, attempt)) return [];
    return [{ artifact, attempt }];
  }).sort((left, right) => right.attempt - left.attempt);
  return (candidates.find(({ artifact }) => !artifact.expired) || candidates[0])?.artifact;
}

function artifactUrl(repository, runId, artifactId) {
  return `https://github.com/${repository}/actions/runs/${positiveInteger(runId, 'run id')}/artifacts/${positiveInteger(artifactId, 'artifact id')}`;
}

function runUrl(repository, run) {
  return run.html_url || `https://github.com/${repository}/actions/runs/${positiveInteger(run.id, 'run id')}`;
}

function commitUrl(repository, sha) {
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Workflow run head SHA is not a full hexadecimal commit SHA');
  return `https://github.com/${repository}/commit/${sha}`;
}

function expirationText(artifact) {
  if (!artifact?.expires_at) return `expires after ${PR_BUILD_RETENTION_DAYS} days`;
  const expiresAt = new Date(artifact.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) return `expires after ${PR_BUILD_RETENTION_DAYS} days`;
  return `expires ${expiresAt.toISOString().slice(0, 10)}`;
}

export function renderComment({ repository, run, platformResults, now = new Date() }) {
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const rows = PR_BUILD_PLATFORMS.map((platform) => {
    const result = platformResults[platform.key] || { state: 'missing' };
    if (result.state === 'available') {
      const name = result.artifact.name || artifactName(platform.key, run.run_attempt);
      const url = artifactUrl(repository, run.id, result.artifact.id);
      return `| ${platform.label} | available | [${name}](${url}) (${expirationText(result.artifact)}) |`;
    }
    return `| ${platform.label} | ${result.state} | — |`;
  });

  return [
    PR_BUILD_COMMENT_MARKER,
    '### Bento PR builds',
    '',
    `Commit [${run.head_sha.slice(0, 7)}](${commitUrl(repository, run.head_sha)}) · [CI run #${run.run_number}](${runUrl(repository, run)}).`,
    '',
    '| Platform | Status | Download |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `Formats: Linux x64 ${PR_BUILD_PLATFORMS[0].format}; Windows x64 ${PR_BUILD_PLATFORMS[1].format}; macOS Apple Silicon ${PR_BUILD_PLATFORMS[2].format}.`,
    `These are unsigned, PR-scoped test builds. GitHub sign-in is required; artifacts are retained for ${PR_BUILD_RETENTION_DAYS} days. They are not stable releases.`,
    `Updated ${generatedAt}.`,
  ].join('\n');
}

function isBotOwned(comment, botLogin) {
  return (
    comment?.body?.includes(PR_BUILD_COMMENT_MARKER) &&
    (comment.user?.login === botLogin || comment.user?.login === 'github-actions[bot]')
  );
}

export function selectBotComment(comments, botLogin = 'github-actions[bot]') {
  return comments.find((comment) => isBotOwned(comment, botLogin));
}

export function commentUpsertAction(comments, body, botLogin = 'github-actions[bot]') {
  const existing = selectBotComment(comments, botLogin);
  return existing
    ? { action: 'update', commentId: existing.id, body }
    : { action: 'create', body };
}

function asPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} is invalid`);
  return number;
}

function candidatePullRequestNumbers(...sources) {
  return [
    ...new Set(
      sources
        .flatMap((source) => (Array.isArray(source) ? source : []))
        .map((pullRequest) => Number(pullRequest?.number))
        .filter((number) => Number.isSafeInteger(number) && number > 0),
    ),
  ];
}

async function getPullRequest(github, owner, repo, number) {
  return (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
}

async function findRunPullRequest({ github, owner, repo, eventRun, run }) {
  let numbers = candidatePullRequestNumbers(eventRun.pull_requests, run.pull_requests);
  const candidates = [];

  for (const number of numbers) {
    candidates.push(await getPullRequest(github, owner, repo, number));
  }
  const directMatches = candidates.filter((pullRequest) => isMatchingPullRequest(pullRequest, run));
  if (directMatches.length === 1) return directMatches[0];
  if (directMatches.length > 1) return undefined;

  // GitHub can send an empty workflow_run.pull_requests array for fork PRs.
  // The commit association endpoint is the safe API fallback; every result is
  // fetched again so state and head repository are current before matching.
  const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    owner,
    repo,
    commit_sha: run.head_sha,
    per_page: 100,
  });
  numbers = candidatePullRequestNumbers(associated);
  const fallbackCandidates = [];
  for (const number of numbers) {
    fallbackCandidates.push(await getPullRequest(github, owner, repo, number));
  }
  const fallbackMatches = fallbackCandidates.filter((pullRequest) => isMatchingPullRequest(pullRequest, run));
  return fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
}

async function listWorkflowRuns(github, owner, repo, workflowId, headSha) {
  return github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: workflowId,
    event: PR_BUILD_WORKFLOW_EVENT,
    head_sha: headSha,
    per_page: 100,
  });
}

export async function updatePrBuildComment({ github, context, core = console, now = new Date() }) {
  const eventRun = context.payload?.workflow_run;
  if (eventRun?.event !== PR_BUILD_WORKFLOW_EVENT) {
    return { status: 'ignored', reason: 'not a manual build run' };
  }

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runId = asPositiveInteger(eventRun.id, 'workflow run id');
  const run = (
    await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })
  ).data;
  const eventAttempt = Number(eventRun.run_attempt);
  const runAttemptMismatch =
    Number.isSafeInteger(eventAttempt) && eventAttempt > 0 && Number(run.run_attempt) !== eventAttempt;
  if (
    run.event !== PR_BUILD_WORKFLOW_EVENT ||
    run.status !== 'completed' ||
    runAttemptMismatch ||
    !run.head_sha ||
    !run.head_repository
  ) {
    return { status: 'ignored', reason: 'workflow run metadata is not a completed manual build run' };
  }

  const pullRequest = await findRunPullRequest({ github, owner, repo, eventRun, run });
  if (!pullRequest) return { status: 'ignored', reason: 'no matching open pull request' };

  const runs = await listWorkflowRuns(github, owner, repo, run.workflow_id, run.head_sha);
  if (!isLatestRelevantRun(run, runs, pullRequest.number)) {
    core.info(`Skipping stale PR build run ${run.id} attempt ${run.run_attempt || 1}`);
    return { status: 'stale', pullRequestNumber: pullRequest.number };
  }

  const [artifacts, jobs] = await Promise.all([
    github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: run.id, per_page: 100 }),
    github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: run.id,
      per_page: 100,
    }),
  ]);
  const platformResults = Object.fromEntries(
    PR_BUILD_PLATFORMS.map((platform) => {
      const artifact = selectPlatformArtifact(artifacts, platform.key, run.run_attempt || 1);
      const job = jobs.find((candidate) => candidate.name === platform.jobName);
      return [platform.key, classifyPlatform({ artifact, job })];
    }),
  );
  const body = renderComment({
    repository: `${owner}/${repo}`,
    run,
    platformResults,
    now,
  });

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullRequest.number,
    per_page: 100,
  });
  const action = commentUpsertAction(comments, body);
  if (action.action === 'update') {
    await github.rest.issues.updateComment({ owner, repo, comment_id: action.commentId, body: action.body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullRequest.number, body: action.body });
  }
  return { status: action.action, pullRequestNumber: pullRequest.number, platformResults };
}
